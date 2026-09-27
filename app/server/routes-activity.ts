// Propriétaire : L4b.
// Routes d'activité (spécification §3.9, §5.7.3, P12 ; plan d'exécution §4.5 et fiche L4b, question Q4 tranchée le 15/09), groupe
// « activity », monté par le module facts. Identifiants validés par shared/ids.ts ; lecture seule de la base, écriture par le port.
// - GET /api/conversations/:rootId/activity → ActivityResponse : délégations, attentes d'accord, décisions et demandes d'autonomie,
//   appels d'IA de la conversation (racine et sessions rattachées) ; résumé et raison des décisions passés par redactSecrets. 400.
// - GET /api/conversations/:rootId/facts?since= → FactsResponse (ports.facts.since). 400.
// - POST /api/conversations/:rootId/facts/affichage : « Affichage rattrapé » (file de la bande 2D vidée après 2 s, §5.7.4) enregistré
//   comme fait `affichage` {etat: rattrape}, sans aucun texte (corps vide ou {}), au plus un par 2 s par conversation ; CSRF par
//   createApp. 400 (identifiant, corps), 404 (conversation inconnue) ; 200 {enregistre} : false si la borne de 2 s ou « Déroulé
//   partiel » l'a écarté.
// Salle OMO (itération 2 bis, L18c) : en mode Simple, une racine de la salle reçoit 403 « mode-avance » sur `…/activity` et sur
// `…/facts`. Ce refus est DÉFINITIF : la question Q7 (a) du plan de l'itération 3, tranchée par la décision A11 du 19/09, dit que
// L28 ne modifie PAS ce fichier. « Revoir » en Simple ne passe donc jamais par ces deux routes, mais par les routes dédiées que
// l'itération 3 pose ailleurs : `GET /api/revoir/:rootId` et `GET /api/revoir/:rootId/consignes/:callId` (lecture seule, sans
// aucune requête à opencode ni aucune ligne `usage`, spécification §5.9 l.1019). Le 403 ci-dessous reste en place après elles.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Cockpit11 } from "./contracts-11.ts";
import { isAdvanced } from "./mode.ts";
import { redactSecrets } from "./redact.ts";
import { sessionRole } from "./shared/activity-facts.ts";
import type {
  ActivityResponse,
  AffichageEtat,
  AffichageResponse,
  DelegationSource,
  DelegationState,
  DelegationView,
  PermissionWaitView,
  UsageSpan,
  WaitState,
} from "./shared/activity-types.ts";
import type {
  AutonomyCaps,
  AutonomyChoice,
  AutonomyRequestView,
  DecisionBy,
  DecisionVerdict,
  DecisionView,
  RelayOutcome,
  RepliedBy,
  RequestEnd,
} from "./shared/autonomy-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
// --- équipes (it4) : début ---
import { createTeamStore } from "./team-store.ts";
// --- équipes (it4) : fin ---

/** `data.etat` du fait « affichage » posé par la bande 2D quand sa file est vidée (« Affichage rattrapé »). */
export const AFFICHAGE_RATTRAPE_ETAT: AffichageEtat = "rattrape";
/** Au plus un fait « Affichage rattrapé » par conversation toutes les 2 s. */
export const AFFICHAGE_INTERVAL_MS = 2_000;
/** Conversations dont la dernière écriture est gardée en mémoire (la plus ancienne est oubliée au-delà). */
export const AFFICHAGE_ROOTS_MAX = 1_000;
/** Corps accepté par POST …/facts/affichage : vide ou {}. */
const AFFICHAGE_BODY_MAX = 64;
/** Lignes rendues au plus par liste de GET …/activity. */
export const ACTIVITY_ROWS_MAX = 2_000;
/** Résumé d'une décision : 120 caractères au plus (Journal du contrôle). */
const RESUME_MAX = 120;
/** Instant de départ de GET …/facts : millisecondes, entier positif. */
const SINCE_RE = /^\d{1,16}$/;

/** Lignes d'une conversation : même arbre que purgeConversation et ports.facts.since. */
const TREE_SQL = "SELECT :root UNION SELECT id FROM sessions WHERE root_id = :root";

export interface ActivityRoutesOptions {
  /** Horloge de la borne de 2 s et du fait « Affichage rattrapé » (tests). */
  now?: () => number;
}

interface DelegationRow {
  id: number;
  root_id: string;
  parent_session_id: string;
  child_session_id: string | null;
  call_id: string;
  agent: string;
  command: string | null;
  source: DelegationSource;
  sans_confirmation: number;
  state: DelegationState;
  permission_id: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface WaitRow {
  permission_id: string;
  session_id: string;
  root_id: string;
  permission: string;
  target: string | null;
  asked_at: number;
  replied_at: number | null;
  reply: Exclude<WaitState, "attente"> | null;
  replied_by: RepliedBy | null;
}

interface DecisionRow {
  id: number;
  request_id: string | null;
  session_id: string;
  permission_id: string | null;
  permission: string;
  resume: string;
  choix: AutonomyChoice;
  regle: string;
  rules_version: number;
  verdict: DecisionVerdict;
  par: DecisionBy;
  raison: string;
  ia_model: string | null;
  ia_cost: number | null;
  ia_ms: number | null;
  relais: RelayOutcome | null;
  asked_at: number;
  decided_at: number | null;
}

interface RequestRow {
  id: string;
  root_id: string;
  choix: AutonomyChoice;
  plafonds: string;
  started_at: number;
  ended_at: number | null;
  spent: number;
  auto: number;
  attentes: number;
  refus: number;
  controles: number;
  fichiers: number;
  delegations: number;
  fin: RequestEnd | null;
}

interface UsageRow {
  session_id: string;
  message_id: string;
  created_at: number;
  completed_at: number | null;
  cost: number;
}

const CAP_KEYS = ["plafondUsd", "actionsMax", "delegationsMax", "dureeMinutes", "fichiersMax", "controlesIaMax"] as const satisfies ReadonlyArray<keyof AutonomyCaps>;

/** Plafonds enregistrés d'une demande (les six plafonds seulement) ; un champ absent ou illisible prend la valeur des réglages. */
function capsOf(raw: string, defaults: AutonomyCaps): AutonomyCaps {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const pick = (key: keyof AutonomyCaps): number => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : defaults[key];
  };
  return Object.fromEntries(CAP_KEYS.map((key) => [key, pick(key)])) as unknown as AutonomyCaps;
}

const invalidId = (c: Context) => c.json({ error: "invalid", message: "Identifiant de conversation invalide." }, 400);

/**
 * Salle OMO en mode Simple (L18c, spécification §3.9 l.343, §5.9 l.1019) : une racine ouverte dans la salle n'est ni lue ni
 * dérivée par ces deux routes, qui parlent le vocabulaire du mode Avancé. Refus DÉFINITIF (décision A11, question Q7 (a) de
 * l'itération 3) : « Revoir » a ses propres routes, `GET /api/revoir/:rootId` et `…/consignes/:callId`. Le port neutre rend
 * `isRoomRoot` faux : hors de la salle, rien ne change.
 */
function salleEnSimple(c: Context, c11: Cockpit11, rootId: string): Response | null {
  if (isAdvanced(c11.settings) || !c11.ports.omoRoom.isRoomRoot(rootId)) return null;
  return c.json({ error: "mode-avance", message: phraseRefusActivation("mode-avance") }, 403);
}

/** Vide, ou un objet JSON sans aucun champ. */
function emptyBody(raw: string): boolean {
  const text = raw.trim();
  if (text === "") return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

/** Lecture de la conversation, bornée par liste (ORDER BY de chaque table, puis ACTIVITY_ROWS_MAX lignes). */
export function readActivity(c11: Pick<Cockpit11, "db" | "settings">, rootId: string): ActivityResponse {
  const { db } = c11;
  const root = { root: rootId, max: ACTIVITY_ROWS_MAX };
  const delegations = db
    .prepare(
      `SELECT id, root_id, parent_session_id, child_session_id, call_id, agent, command, source, sans_confirmation, state, permission_id,
         created_at, started_at, ended_at
       FROM delegations WHERE root_id IN (${TREE_SQL}) ORDER BY created_at, id LIMIT :max`,
    )
    .all(root) as unknown as DelegationRow[];
  const waits = db
    .prepare(
      `SELECT permission_id, session_id, root_id, permission, target, asked_at, replied_at, reply, replied_by
       FROM permission_waits WHERE root_id IN (${TREE_SQL}) ORDER BY asked_at, permission_id LIMIT :max`,
    )
    .all(root) as unknown as WaitRow[];
  const decisions = db
    .prepare(
      `SELECT id, request_id, session_id, permission_id, permission, resume, choix, regle, rules_version, verdict, par, raison, ia_model,
         ia_cost, ia_ms, relais, asked_at, decided_at
       FROM autonomy_decisions WHERE root_id IN (${TREE_SQL}) ORDER BY asked_at, id LIMIT :max`,
    )
    .all(root) as unknown as DecisionRow[];
  const requests = db
    .prepare(
      `SELECT id, root_id, choix, plafonds, started_at, ended_at, spent, auto, attentes, refus, controles, fichiers, delegations, fin
       FROM autonomy_requests WHERE root_id IN (${TREE_SQL}) ORDER BY started_at, id LIMIT :max`,
    )
    .all(root) as unknown as RequestRow[];
  const usage = db
    .prepare(
      `SELECT session_id, message_id, created_at, completed_at, cost
       FROM usage WHERE root_id IN (${TREE_SQL}) ORDER BY created_at, message_id LIMIT :max`,
    )
    .all(root) as unknown as UsageRow[];
  const defaults = c11.settings.get().budget.autonomie;

  return {
    // --- équipes (it4) : début ---
    // Résumés des lancements d'équipe de la conversation (L37s) ; lecture seule, comme le reste de cette route.
    runs: createTeamStore({ db }).summaries(rootId),
    // --- équipes (it4) : fin ---
    delegations: delegations.map(
      (row): DelegationView => ({
        id: row.id,
        rootId: row.root_id,
        parentSessionId: row.parent_session_id,
        childSessionId: row.child_session_id,
        callId: row.call_id,
        agent: row.agent,
        command: row.command,
        source: row.source,
        sansConfirmation: row.sans_confirmation === 1,
        state: row.state,
        permissionId: row.permission_id,
        createdAt: row.created_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      }),
    ),
    waits: waits.map(
      (row): PermissionWaitView => ({
        permissionId: row.permission_id,
        sessionId: row.session_id,
        rootId: row.root_id,
        permission: row.permission,
        target: row.target,
        askedAt: row.asked_at,
        repliedAt: row.replied_at,
        reply: row.reply,
        repliedBy: row.replied_by,
      }),
    ),
    decisions: decisions.map(
      (row): DecisionView => ({
        id: row.id,
        requestId: row.request_id,
        sessionId: row.session_id,
        permissionId: row.permission_id,
        permission: row.permission,
        // Masqué puis coupé : une coupe avant le masquage laisserait passer le début d'un secret.
        resume: redactSecrets(row.resume).slice(0, RESUME_MAX),
        choix: row.choix,
        regle: row.regle,
        rulesVersion: row.rules_version,
        verdict: row.verdict,
        par: row.par,
        raison: redactSecrets(row.raison),
        iaModel: row.ia_model,
        iaCost: row.ia_cost,
        iaMs: row.ia_ms,
        relais: row.relais,
        askedAt: row.asked_at,
        decidedAt: row.decided_at,
      }),
    ),
    requests: requests.map(
      (row): AutonomyRequestView => ({
        id: row.id,
        rootId: row.root_id,
        choix: row.choix,
        plafonds: capsOf(row.plafonds, defaults),
        startedAt: row.started_at,
        endedAt: row.ended_at,
        spent: row.spent,
        auto: row.auto,
        attentes: row.attentes,
        refus: row.refus,
        controles: row.controles,
        fichiers: row.fichiers,
        delegations: row.delegations,
        fin: row.fin,
      }),
    ),
    usageSpans: usage.map((row): UsageSpan => ({ sessionId: row.session_id, messageId: row.message_id, start: row.created_at, end: row.completed_at, cost: row.cost })),
  };
}

export function registerActivityRoutes(app: Hono, c11: Cockpit11, options: ActivityRoutesOptions = {}): void {
  const now = options.now ?? Date.now;
  /** Dernier fait « Affichage rattrapé » écrit, par conversation (borne de 2 s). */
  const lastAffichage = new Map<string, number>();

  app.get("/api/conversations/:rootId/activity", (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return invalidId(c);
    return salleEnSimple(c, c11, rootId) ?? c.json(readActivity(c11, rootId));
  });

  app.get("/api/conversations/:rootId/facts", (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return invalidId(c);
    const refusSalle = salleEnSimple(c, c11, rootId);
    if (refusSalle !== null) return refusSalle;
    const raw = c.req.query("since");
    const since = raw !== undefined && SINCE_RE.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(since)) return c.json({ error: "invalid", message: "Instant de départ invalide." }, 400);
    return c.json(c11.ports.facts.since(rootId, since));
  });

  app.post(
    "/api/conversations/:rootId/facts/affichage",
    bodyLimit({ maxSize: AFFICHAGE_BODY_MAX, onError: (c) => c.json({ error: "invalid", message: "Cette demande n'accepte aucun contenu." }, 400) }),
    async (c) => {
      const rootId = c.req.param("rootId");
      if (!SESSION_ID_RE.test(rootId)) return invalidId(c);
      if (!emptyBody(await c.req.text())) return c.json({ error: "invalid", message: "Cette demande n'accepte aucun contenu." }, 400);
      const row = c11.sessions.get(rootId);
      if (!row || row.parent_id !== null || sessionRole(row.purpose, null) !== "conversation") {
        return c.json({ error: "not-found", message: "Conversation inconnue." }, 404);
      }
      const at = now();
      const last = lastAffichage.get(rootId);
      if (last !== undefined && at - last < AFFICHAGE_INTERVAL_MS && at >= last) return c.json<AffichageResponse>({ enregistre: false });
      // Conversation close par « Déroulé partiel » : plus rien n'est enregistré (le magasin l'écarterait sans le dire).
      if (c11.ports.facts.since(rootId, Number.MAX_SAFE_INTEGER, 1).partial) return c.json<AffichageResponse>({ enregistre: false });
      lastAffichage.delete(rootId);
      if (lastAffichage.size >= AFFICHAGE_ROOTS_MAX) lastAffichage.delete(lastAffichage.keys().next().value as string);
      lastAffichage.set(rootId, at);
      c11.ports.facts.append([{ rootId, sessionId: rootId, kind: "affichage", ref: null, data: { etat: AFFICHAGE_RATTRAPE_ETAT }, at }]);
      return c.json<AffichageResponse>({ enregistre: true });
    },
  );
}
