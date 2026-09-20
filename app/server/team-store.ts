// Propriétaire : L37s.
// Magasin des équipes (migration 4 : teams, team_runs, team_run_steps, team_run_events ; spécification §3.5 l.209-213 et l.246,
// §3.9 l.338, §3.10 l.359 ; plan d'exécution it4 fiche L37s, D-eq-09).
// - BIBLIOTHÈQUE, pas un port (D-eq-09) : le service (L37a) écrit `teams`, le runner (L37b) et les incidents (L37c) écrivent
//   `team_runs`, `team_run_steps` et `team_run_events`, TOUJOURS par ces méthodes. Aucune autre table n'est écrite ici.
// - Requêtes PARAMÉTRÉES seulement : les noms de colonnes viennent des tables figées RUN_COLUMNS et STEP_COLUMNS, jamais d'une
//   valeur reçue ; toute valeur passe par `params` (db.ts).
// - Transitions d'état lues à l'exécution dans canTransition (shared/team-limits.ts, T4) : un état final ne régresse jamais, et
//   une transition refusée n'écrit RIEN.
// - AUCUNE méthode ne journalise (le magasin n'a pas de journal) : `message_text`, `result_excerpt`, `precisions` et la demande
//   ne sortent jamais d'ici autrement que par une lecture explicite (U2, D-eq-26 : un journal ne peut citer que `message_sha256`).
//   `events.append` n'accepte que des valeurs courtes, sans retour à la ligne et sans secret : jamais un texte de message.
// - `message_text` garde le texte exact envoyé à l'étape ; il est vidé avec la conversation par purgeConversation
//   (conversation-purge.ts, existant et non modifié), comme `result_excerpt` et `precisions`.
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, RunRow, StepRow, TeamRow } from "./contracts-eq.ts";
import { params, type SqlValue, transaction } from "./db.ts";
import { redactSecrets } from "./redact.ts";
import type { RightLine, UiMode } from "./shared/assistant-rules.ts";
import { canTransition, TEAM_RUN_TRANSITIONS, TEAM_STEP_TRANSITIONS } from "./shared/team-limits.ts";
import type {
  Flow,
  StepRunView,
  TeamRunState,
  TeamRunSummary,
  TeamRunView,
  TeamStepState,
} from "./shared/team-types.ts";

/** Extrait d'un résultat d'étape : masqué puis coupé (couper d'abord laisserait passer le début d'un secret). */
export const RESULT_EXCERPT_MAX = 2_000;

/** Texte admis dans `team_run_events.data` : un code, une empreinte, un identifiant ; jamais un texte de message. */
export const EVENT_TEXT_MAX = 200;

/** Nature d'un événement d'audit (code technique, jamais une phrase). */
const EVENT_KIND_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * États d'un lancement qui travaille ou qui attend (D-eq-16, lus par P4, P5 et les verrous) : ceux d'où l'on peut encore passer
 * à « en-cours », plus « en-cours » lui-même. Dérivés de la table des transitions : ajouter un état d'attente suffit.
 */
export const ACTIVE_RUN_STATES: readonly TeamRunState[] = Object.freeze(
  (Object.keys(TEAM_RUN_TRANSITIONS) as TeamRunState[]).filter((state) => state === "en-cours" || (TEAM_RUN_TRANSITIONS[state] as readonly string[]).includes("en-cours")),
);

/** Un lancement qui ne peut plus repasser « en-cours » est fini : sa date de fin est posée (et effacée par une relance). */
const runEnded = (state: TeamRunState): boolean => !ACTIVE_RUN_STATES.includes(state);

/** Une étape dont l'état n'a aucune suite est finie (une relance crée une nouvelle tentative, jamais un retour en arrière). */
const stepEnded = (state: TeamStepState): boolean => TEAM_STEP_TRANSITIONS[state].length === 0;

const placeholders = (list: readonly TeamRunState[]): string => list.map((_, index) => `:etat${index}`).join(", ");
const stateParams = (list: readonly TeamRunState[]): Record<string, string> => Object.fromEntries(list.map((state, index) => [`etat${index}`, state]));

// --- Entrées ---------------------------------------------------------------------------------------------------------------------

/** Équipe installée. `avance` : le déroulé échoue la grammaire du mode Simple (calculée par L37a, enregistrée ici). */
export interface TeamInput {
  id: string;
  titre: string;
  description: string;
  flow: Flow;
  origine: TeamRow["origine"];
  exempleId?: string | null;
  exempleVersion?: number | null;
  avance: boolean;
}

/** Lancement créé en « preparation » (aucun autre état de départ n'est permis). */
export interface RunInput {
  id: string;
  teamId: string | null;
  teamTitre: string;
  flow: Flow;
  flowSha256: string;
  estimateSha256: string | null;
  modeUi: UiMode | null;
  rootId: string;
  directory: string;
  estimate: { typique: number; maximum: number } | null;
  plafond: number | null;
  confirmations?: Record<string, boolean>;
}

/** Étape créée « prevue » (plan du lancement) ou « en-file » (mise en attente d'un essai). */
export interface StepInput {
  runId: string;
  stepId: string;
  tour: number;
  tentative: number;
  ordre: number;
  blocIndex: number;
  titre: string;
  agent: string;
  state: "prevue" | "en-file";
}

export interface StepKey {
  runId: string;
  stepId: string;
  tour: number;
  tentative: number;
}

/** Colonnes de `team_runs` modifiables hors état (l'état passe par setState : canTransition). Noms de colonnes figés. */
const RUN_COLUMNS = Object.freeze({
  estimateSha256: "estimate_sha256",
  requestMessageId: "request_message_id",
  resultMessageId: "result_message_id",
  cause: "cause",
  estimateTypique: "estimate_typique",
  estimateMax: "estimate_max",
  plafond: "plafond",
  cost: "cost",
  confirmations: "confirmations",
  precisions: "precisions",
  startedAt: "started_at",
  endedAt: "ended_at",
});

/** Colonnes de `team_run_steps` modifiables hors état. Noms de colonnes figés. */
const STEP_COLUMNS = Object.freeze({
  sessionId: "session_id",
  agentFileSha256: "agent_file_sha256",
  rulesSha256: "rules_sha256",
  floorSha256: "floor_sha256",
  rights: "rights",
  rightLines: "right_lines",
  model: "model",
  variant: "variant",
  steps: "steps",
  cause: "cause",
  tronquee: "tronquee",
  messageSha256: "message_sha256",
  messageText: "message_text",
  correctionSha256: "correction_sha256",
  resultExcerpt: "result_excerpt",
  verdict: "verdict",
  choix: "choix",
  queuedAt: "queued_at",
  startedAt: "started_at",
  endedAt: "ended_at",
  cost: "cost",
});

/** Changements d'un lancement ; une clé absente ne touche pas sa colonne. */
export interface RunPatch {
  estimateSha256?: string | null;
  /** Message injecté de la demande (ME-3 : `info.id` de la réponse d'opencode), rendu par TeamRunView.requestMessageId. */
  requestMessageId?: string | null;
  /** Message injecté du résultat, rendu par TeamRunView.resultMessageId. */
  resultMessageId?: string | null;
  cause?: string | null;
  estimateTypique?: number | null;
  estimateMax?: number | null;
  plafond?: number | null;
  cost?: number;
  confirmations?: Record<string, boolean>;
  /** Précisions données pendant les pauses : vidées avec la conversation, jamais journalisées. */
  precisions?: string[];
  startedAt?: number | null;
  endedAt?: number | null;
}

/** Changements d'une étape ; une clé absente ne touche pas sa colonne. */
export interface StepPatch {
  sessionId?: string | null;
  agentFileSha256?: string | null;
  rulesSha256?: string | null;
  floorSha256?: string | null;
  rights?: string | null;
  rightLines?: RightLine[];
  model?: string | null;
  variant?: string | null;
  steps?: number | null;
  cause?: string | null;
  tronquee?: boolean;
  messageSha256?: string | null;
  /** Texte exact envoyé à l'étape : gardé tel quel, vidé avec la conversation, JAMAIS journalisé (U2, D-eq-26). */
  messageText?: string | null;
  correctionSha256?: string | null;
  /** Extrait du résultat : masqué par redactSecrets puis coupé à RESULT_EXCERPT_MAX. */
  resultExcerpt?: string | null;
  verdict?: string | null;
  choix?: string | null;
  queuedAt?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  cost?: number;
}

export type EventValue = string | number | boolean | null;

/** Événement d'audit d'un lancement : identifiants, codes et empreintes seulement (jamais un texte de message). */
export interface TeamEventInput {
  runId: string;
  kind: string;
  par: "vous" | "cockpit";
  data?: Record<string, EventValue>;
}

// --- Gardes -----------------------------------------------------------------------------------------------------------------------

/** Valeur admise dans `data` : nombre fini, booléen, null, ou texte court d'une seule ligne sans secret. */
function eventValueOk(value: EventValue): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return value.length <= EVENT_TEXT_MAX && !/[\n\r]/.test(value) && redactSecrets(value) === value;
}

/** Le message ne recopie jamais la valeur refusée (elle pourrait être le texte que la garde écarte). */
function checkEvent(event: TeamEventInput): void {
  const data = event.data ?? {};
  const ok =
    typeof event.runId === "string" &&
    event.runId !== "" &&
    EVENT_KIND_RE.test(event.kind) &&
    (event.par === "vous" || event.par === "cockpit") &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    Object.values(data).every(eventValueOk);
  if (!ok) throw new RangeError("événement d'équipe refusé : nature, auteur ou donnée invalide (aucun texte de message)");
}

// --- Vues ------------------------------------------------------------------------------------------------------------------------

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** Étapes dont l'IA a été choisie par l'équipe (`niveau` non nul dans le déroulé enregistré au lancement). */
function teamChosenModels(flow: string): Set<string> {
  const out = new Set<string>();
  const blocs = parseJson<Flow | null>(flow, null)?.blocs ?? [];
  for (const bloc of blocs) {
    const steps = bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : [];
    for (const step of steps) if (step.niveau !== null) out.add(step.id);
  }
  return out;
}

function stepView(row: StepRow, chosen: Set<string>, assistantTitre: string): StepRunView {
  return {
    stepId: row.step_id,
    blocIndex: row.bloc_index,
    ordre: row.ordre,
    tour: row.tour,
    tentative: row.tentative,
    titre: row.titre,
    assistant: row.agent,
    assistantTitre,
    // `label` vient du catalogue des IA, que le magasin ne lit pas : le runner (L37b) le complète dans la vue de ses routes.
    ia: { model: row.model, label: null, variant: row.variant, choisieParEquipe: chosen.has(row.step_id) },
    state: row.state,
    cause: row.cause,
    sessionId: row.session_id,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cost: row.cost,
    tronquee: row.tronquee === 1,
    extrait: row.result_excerpt,
    droits: parseJson<RightLine[]>(row.right_lines, []),
  };
}

// --- Magasin ---------------------------------------------------------------------------------------------------------------------

export interface TeamStoreDeps {
  db: DatabaseSync;
  /** Horloge des écritures (tests). */
  now?: () => number;
}

export interface TeamStore {
  teams: {
    list(): TeamRow[];
    get(id: string): TeamRow | null;
    /** Insère ou met à jour ; `created_at` est gardé. */
    put(team: TeamInput): TeamRow;
    remove(id: string): boolean;
  };
  runs: {
    /** Toujours créé en « preparation ». */
    create(run: RunInput): RunRow;
    get(id: string): RunRow | null;
    ofRoot(rootId: string): RunRow[];
    /** Lancements de la conversation qui travaillent ou attendent (ACTIVE_RUN_STATES). */
    activeOfRoot(rootId: string): RunRow[];
    /** Nombre d'équipes actives, toutes conversations confondues (P5). */
    activeCount(): number;
    /** Faux, sans rien écrire, si la transition est refusée (canTransition) ou si le lancement est inconnu. */
    setState(id: string, to: TeamRunState, change?: { cause?: string | null; at?: number }): boolean;
    patch(id: string, patch: RunPatch): boolean;
    /** Vue de la base : `pause`, `suite` et le libellé d'IA sont ajoutés par le runner (L37b). */
    view(id: string): TeamRunView | null;
  };
  steps: {
    create(step: StepInput): StepRow;
    get(key: StepKey): StepRow | null;
    ofRun(runId: string): StepRow[];
    setState(key: StepKey, to: TeamStepState, change?: { cause?: string | null; at?: number }): boolean;
    patch(key: StepKey, patch: StepPatch): boolean;
  };
  events: {
    append(event: TeamEventInput): EventRow;
    ofRun(runId: string): EventRow[];
  };
  /** Moyenne observée des étapes « terminee » d'un assistant et d'une IA depuis `since` (30 jours), avec le nombre d'échantillons. */
  observedStepCost(assistant: string, model: string, since: number): { avgUsd: number | null; samples: number };
  /** Somme des `usage.cost` des sessions d'étape du lancement depuis son départ : ni la racine, ni une autre équipe. */
  spentOfRun(runId: string): number;
  summaries(rootId: string): TeamRunSummary[];
}

export function createTeamStore(deps: TeamStoreDeps): TeamStore {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  /** Atomique : dans la transaction de l'appelant s'il y en a une, sinon dans la sienne. */
  const atomic = <T>(fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));

  const getTeam = (id: string): TeamRow | null => (db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamRow | undefined) ?? null;
  const getRun = (id: string): RunRow | null => (db.prepare("SELECT * FROM team_runs WHERE id = ?").get(id) as RunRow | undefined) ?? null;
  const stepKey = (key: StepKey) => ({ run: key.runId, step: key.stepId, tour: key.tour, tentative: key.tentative });
  const STEP_WHERE = "run_id = :run AND step_id = :step AND tour = :tour AND tentative = :tentative";
  const getStep = (key: StepKey): StepRow | null => (db.prepare(`SELECT * FROM team_run_steps WHERE ${STEP_WHERE}`).get(stepKey(key)) as StepRow | undefined) ?? null;
  const stepsOfRun = (runId: string): StepRow[] =>
    db.prepare("SELECT * FROM team_run_steps WHERE run_id = ? ORDER BY ordre, tour, tentative").all(runId) as unknown as StepRow[];

  /** Titre d'assistant lu dans item_meta (lecture seule d'une table d'une autre itération) ; à défaut, le nom technique. */
  const assistantTitre = (agent: string): string => {
    const row = db.prepare("SELECT title FROM item_meta WHERE kind = 'agents' AND name = ?").get(agent) as { title: string | null } | undefined;
    return row?.title ?? agent;
  };

  /** Valeur d'une colonne selon sa clé : JSON des listes, masquage et coupe de l'extrait, reste tel quel. */
  const encode = (name: string, value: unknown): SqlValue | boolean | undefined => {
    if (name === "confirmations" || name === "precisions" || name === "rightLines") return JSON.stringify(value);
    if (name === "resultExcerpt") return typeof value === "string" ? redactSecrets(value).slice(0, RESULT_EXCERPT_MAX) : (value as SqlValue);
    return value as SqlValue | boolean | undefined;
  };

  /** UPDATE bâti sur une table de colonnes FIGÉE (jamais un nom reçu) ; chaque valeur est un paramètre nommé. */
  const update = (
    table: "team_runs" | "team_run_steps",
    columns: Readonly<Record<string, string>>,
    patch: Record<string, unknown>,
    where: string,
    keyValues: Record<string, SqlValue>,
  ): boolean => {
    const sets: string[] = [];
    const values: Record<string, SqlValue | boolean | undefined> = { ...keyValues };
    for (const [name, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, name) || patch[name] === undefined) continue;
      sets.push(`${column} = :${name}`);
      values[name] = encode(name, patch[name]);
    }
    if (sets.length === 0) return false;
    return Number(db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${where}`).run(params(values)).changes) > 0;
  };

  return {
    teams: {
      list: () => db.prepare("SELECT * FROM teams ORDER BY updated_at DESC, id").all() as unknown as TeamRow[],
      get: getTeam,
      put(team) {
        const at = now();
        db.prepare(
          `INSERT INTO teams (id, titre, description, flow, origine, exemple_id, exemple_version, avance, created_at, updated_at)
           VALUES (:id, :titre, :description, :flow, :origine, :exemple_id, :exemple_version, :avance, :at, :at)
           ON CONFLICT(id) DO UPDATE SET titre = :titre, description = :description, flow = :flow, origine = :origine,
             exemple_id = :exemple_id, exemple_version = :exemple_version, avance = :avance, updated_at = :at`,
        ).run(
          params({
            id: team.id,
            titre: team.titre,
            description: team.description,
            flow: JSON.stringify(team.flow),
            origine: team.origine,
            exemple_id: team.exempleId ?? null,
            exemple_version: team.exempleVersion ?? null,
            avance: team.avance,
            at,
          }),
        );
        return getTeam(team.id) as TeamRow;
      },
      remove: (id) => Number(db.prepare("DELETE FROM teams WHERE id = ?").run(id).changes) > 0,
    },

    runs: {
      create(run) {
        const at = now();
        db.prepare(
          `INSERT INTO team_runs (id, team_id, team_titre, flow, flow_sha256, estimate_sha256, mode_ui, root_session_id, directory,
             state, facultatifs, estimate_typique, estimate_max, plafond, cost, confirmations, precisions, created_at)
           VALUES (:id, :team_id, :team_titre, :flow, :flow_sha256, :estimate_sha256, :mode_ui, :root, :directory,
             'preparation', '[]', :typique, :maximum, :plafond, 0, :confirmations, '[]', :at)`,
        ).run(
          params({
            id: run.id,
            team_id: run.teamId,
            team_titre: run.teamTitre,
            flow: JSON.stringify(run.flow),
            flow_sha256: run.flowSha256,
            estimate_sha256: run.estimateSha256,
            mode_ui: run.modeUi,
            root: run.rootId,
            directory: run.directory,
            typique: run.estimate?.typique ?? null,
            maximum: run.estimate?.maximum ?? null,
            plafond: run.plafond,
            confirmations: JSON.stringify(run.confirmations ?? {}),
            at,
          }),
        );
        return getRun(run.id) as RunRow;
      },
      get: getRun,
      ofRoot: (rootId) => db.prepare("SELECT * FROM team_runs WHERE root_session_id = ? ORDER BY created_at, id").all(rootId) as unknown as RunRow[],
      activeOfRoot: (rootId) =>
        db
          .prepare(`SELECT * FROM team_runs WHERE root_session_id = :root AND state IN (${placeholders(ACTIVE_RUN_STATES)}) ORDER BY created_at, id`)
          .all({ root: rootId, ...stateParams(ACTIVE_RUN_STATES) }) as unknown as RunRow[],
      activeCount: () =>
        (db.prepare(`SELECT COUNT(*) AS n FROM team_runs WHERE state IN (${placeholders(ACTIVE_RUN_STATES)})`).get(stateParams(ACTIVE_RUN_STATES)) as { n: number }).n,
      // L'état n'est jamais écrit par `patch` : il ne change que par ici, sous condition de son état de départ. Une transition
      // sans cause efface la cause précédente (elle décrit l'état courant) ; la date de fin s'efface quand une relance repart.
      setState(id, to, change = {}) {
        return atomic(() => {
          const row = getRun(id);
          if (!row || !canTransition("run", row.state, to)) return false;
          const at = change.at ?? now();
          const result = db.prepare("UPDATE team_runs SET state = :to, cause = :cause, started_at = :started, ended_at = :ended WHERE id = :id AND state = :from").run(
            params({
              to,
              cause: change.cause ?? null,
              started: to === "en-cours" ? (row.started_at ?? at) : row.started_at,
              ended: runEnded(to) ? at : null,
              id,
              from: row.state,
            }),
          );
          return Number(result.changes) > 0;
        });
      },
      patch: (id, patch) => update("team_runs", RUN_COLUMNS, patch as Record<string, unknown>, "id = :id", { id }),
      view(id) {
        const row = getRun(id);
        if (!row) return null;
        const chosen = teamChosenModels(row.flow);
        const titres = new Map<string, string>();
        const steps = stepsOfRun(id).map((step) => {
          if (!titres.has(step.agent)) titres.set(step.agent, assistantTitre(step.agent));
          return stepView(step, chosen, titres.get(step.agent) as string);
        });
        return {
          id: row.id,
          teamId: row.team_id,
          titre: row.team_titre,
          rootId: row.root_session_id,
          directory: row.directory,
          state: row.state,
          cause: row.cause,
          modeUi: row.mode_ui,
          estimate: row.estimate_typique === null || row.estimate_max === null ? null : { typique: row.estimate_typique, maximum: row.estimate_max },
          plafond: row.plafond,
          cost: row.cost,
          steps,
          // Pause, chemin restant et libellés d'IA : hors base, posés par le runner (L37b).
          pause: null,
          relancable: canTransition("run", row.state, "preparation"),
          suite: null,
          resultatsAjoutes: row.result_message_id !== null,
          requestMessageId: row.request_message_id,
          resultMessageId: row.result_message_id,
          createdAt: row.created_at,
          startedAt: row.started_at,
          endedAt: row.ended_at,
        };
      },
    },

    steps: {
      create(step) {
        const at = now();
        db.prepare(
          `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, state, queued_at, cost)
           VALUES (:run, :step, :tour, :tentative, :ordre, :bloc, :titre, :agent, :state, :queued, 0)`,
        ).run(
          params({
            run: step.runId,
            step: step.stepId,
            tour: step.tour,
            tentative: step.tentative,
            ordre: step.ordre,
            bloc: step.blocIndex,
            titre: step.titre,
            agent: step.agent,
            state: step.state,
            queued: step.state === "en-file" ? at : null,
          }),
        );
        return getStep(step) as StepRow;
      },
      get: getStep,
      ofRun: stepsOfRun,
      // Même règle que pour un lancement : l'état ne change que par ici. La cause donnée remplace la précédente, une cause
      // absente la garde (l'échec d'une étape en dit la raison, que la suite ne réécrit pas).
      setState(key, to, change = {}) {
        return atomic(() => {
          const row = getStep(key);
          if (!row || !canTransition("step", row.state, to)) return false;
          const at = change.at ?? now();
          const result = db
            .prepare(`UPDATE team_run_steps SET state = :to, cause = :cause, queued_at = :queued, started_at = :started, ended_at = :ended WHERE ${STEP_WHERE} AND state = :from`)
            .run(
              params({
                ...stepKey(key),
                to,
                cause: change.cause ?? row.cause,
                queued: to === "en-file" ? (row.queued_at ?? at) : row.queued_at,
                started: to === "en-cours" ? (row.started_at ?? at) : row.started_at,
                ended: stepEnded(to) ? at : row.ended_at,
                from: row.state,
              }),
            );
          return Number(result.changes) > 0;
        });
      },
      patch: (key, patch) => update("team_run_steps", STEP_COLUMNS, patch as Record<string, unknown>, STEP_WHERE, stepKey(key)),
    },

    events: {
      append(event) {
        checkEvent(event);
        const at = now();
        const result = db
          .prepare("INSERT INTO team_run_events (run_id, kind, par, data, at) VALUES (?, ?, ?, ?, ?)")
          .run(event.runId, event.kind, event.par, JSON.stringify(event.data ?? {}), at);
        return { id: Number(result.lastInsertRowid), run_id: event.runId, kind: event.kind, par: event.par, data: JSON.stringify(event.data ?? {}), at };
      },
      ofRun: (runId) => db.prepare("SELECT * FROM team_run_events WHERE run_id = ? ORDER BY at, id").all(runId) as unknown as EventRow[],
    },

    observedStepCost(assistant, model, since) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM team_run_steps
           WHERE agent = :agent AND model = :model AND state = 'terminee' AND ended_at IS NOT NULL AND ended_at >= :since`,
        )
        .get({ agent: assistant, model, since }) as { n: number; cost: number };
      return { avgUsd: row.n > 0 ? row.cost / row.n : null, samples: row.n };
    },

    spentOfRun(runId) {
      const run = getRun(runId);
      if (!run) return 0;
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(cost), 0) AS cost FROM usage
           WHERE created_at >= :since AND session_id IN (SELECT session_id FROM team_run_steps WHERE run_id = :run AND session_id IS NOT NULL)`,
        )
        .get({ run: runId, since: run.started_at ?? run.created_at }) as { cost: number };
      return row.cost;
    },

    summaries(rootId) {
      // Étapes prévues et terminées : comptées par identifiant d'étape (une relance ajoute des tentatives, jamais des étapes).
      const rows = db
        .prepare(
          `SELECT r.id, r.team_titre, r.state, r.cause, r.cost, r.plafond, r.created_at, r.ended_at,
             (SELECT COUNT(DISTINCT s.step_id) FROM team_run_steps s WHERE s.run_id = r.id) AS prevues,
             (SELECT COUNT(DISTINCT s.step_id) FROM team_run_steps s WHERE s.run_id = r.id AND s.state = 'terminee') AS terminees
           FROM team_runs r WHERE r.root_session_id = :root ORDER BY r.created_at, r.id`,
        )
        .all({ root: rootId }) as unknown as Array<
        Pick<RunRow, "id" | "team_titre" | "state" | "cause" | "cost" | "plafond" | "created_at" | "ended_at"> & { prevues: number; terminees: number }
      >;
      return rows.map(
        (row): TeamRunSummary => ({
          id: row.id,
          titre: row.team_titre,
          state: row.state,
          cause: row.cause,
          cost: row.cost,
          plafond: row.plafond,
          createdAt: row.created_at,
          endedAt: row.ended_at,
          etapesPrevues: row.prevues,
          etapesTerminees: row.terminees,
        }),
      );
    },
  };
}
