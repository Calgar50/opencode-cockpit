// Propriétaire : L37c.
// Incidents des équipes (spécification §3.11 l.363-372, §3.12 l.386-392, §3.13 l.423-425, §3.5 (purge), §6 l.1036 et l.1047 ;
// plan d'exécution it4, fiche L37c, §4.1.5, D-eq-04, D-eq-05, D-eq-16, D-eq-17, D-eq-22, D-eq-27) : verrous du proxy et des
// Archives, décorateur de stopTree, plafond (usage.updated), rechargement (global.disposed, server.instance.disposed), routes
// d'incident du groupe « team-runs » (stop, estimate, relancer, fermer, ajouter-resultats).
// Inscriptions de câblage POSÉES PAR T4 ET GARDÉES ICI (report du train de V0, §4.2 « T4, ports neutres ») :
//   - le verrou (proxy et Archives) délègue à eq.ports.guards.proxyGuard, lu au moment de l'appel ;
//   - le décorateur de stopTree (D-eq-05) prévient le runner AVANT l'arrêt interne (plus aucune étape lancée), puis APRÈS ; une
//     erreur du runner est journalisée et n'empêche jamais l'arrêt.
// Port neutre : proxyGuard → null ; stopForCap sans effet.
// neutralGuards reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
//
// D-eq-04 : UNE SEULE fonction de verrou, appelée à DEUX entrées (proxy et Archives) ; aucune nouvelle HookStep ; le verrou
// absent laisse le comportement 1.1 inchangé. Il ne lit QUE le port du runner (activeRunOf, stepOf), jamais la base : un harnais
// sans teamRunner (port neutre) ne verrouille donc rien, et les tests de T4 et des croisements restent valables (plan §2.3).
// D-eq-16 : « interrompue », « plafond », « echec » et « terminee » ne verrouillent pas (ACTIVE_RUN_STATES, magasin L37s).
// ME-6 (MX-EQ, report du train de V0) : arrêter la racine N'ARRÊTE PAS les étapes créées par le serveur — stopTree (L1c) est
// nécessaire et suffit ; l'arrêt d'une étape ne touche pas ses sœurs. Un `abort` sur une racine au repos publie quand même
// `idle` : on n'y lit jamais la fin d'un tour (ni classifier.onIdle, ni archive) — ce module ne dérive aucun repos.
// A4 / D-eq-17 : zéro requête à opencode pour TOUT refus de POST …/relancer ; les lectures sont faites par la route
// d'estimation dédiée (POST …/estimate), qui garde l'instantané de L37p.
// P6 : aucune écriture de configuration, aucun redémarrage ni libération d'instance.
// Écritures : team_runs et team_run_events par les méthodes du magasin seulement (D-eq-09) ; permission_waits est LU seulement
// (écrivain unique : fact-store.ts).
import type { Hono } from "hono";
import type { EventDerivation, StopTreePort, UsageUpdatedData } from "./contracts-11.ts";
import type { EqContext, EqModule, PreflightInput, RunRow, TeamGuardsPort, TeamProxyGuardRequest, TeamRow } from "./contracts-eq.ts";
import { errorMessage } from "./log.ts";
import { isAdvanced } from "./mode.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { CONFIRM_HEADER } from "./security.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { requestFromStepMessage } from "./shared/flow.ts";
import { ID } from "./shared/ids.ts";
import { planSteps } from "./shared/team-limits.ts";
import { phraseErreur, refusLancement, TEXTES } from "./shared/team-texts.ts";
import type { Flow, TeamEstimateResponse, TeamErrorCode, TeamRunBody, TeamRunState, TeamRunView } from "./shared/team-types.ts";
import { ACTIVE_RUN_STATES, createTeamStore, type TeamStore } from "./team-store.ts";

export function neutralGuards(): TeamGuardsPort {
  return {
    proxyGuard: async () => null,
    stopForCap: async () => undefined,
  };
}

/** Décorateur de stopTree (D-eq-05) : runner.stopRequested avant l'arrêt interne, runner.stopped après, même en échec. */
export function teamStopTree(eq: EqContext, inner: StopTreePort): StopTreePort {
  const notify = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      eq.c11.log.warn(`équipes : ${what} en échec, l'arrêt continue`, { error: errorMessage(err) });
    }
  };
  return {
    async run(rootId, cause) {
      notify("stopRequested", () => eq.ports.runner.stopRequested(rootId, cause));
      let result: StopResult | null = null;
      try {
        result = await inner.run(rootId, cause);
        return result;
      } finally {
        notify("stopped", () => eq.ports.runner.stopped(rootId, cause, result));
      }
    },
  };
}

// --- Routes du proxy reconnues par le verrou (D-eq-04) -------------------------------------------------------------------------

/** Envoi facturé vers une session : les trois routes gardées du proxy (PROXY_RULES de http.ts). */
const SEND_ROUTE = new RegExp(`^/session/${ID}/(?:prompt_async|command|summarize)$`);
/** Session désignée seule : PATCH (renommage) et DELETE (suppression). */
const SESSION_ONLY_ROUTE = new RegExp(`^/session/${ID}$`);
const ABORT_ROUTE = new RegExp(`^/session/${ID}/abort$`);

/** Nature d'une requête du proxy pour le verrou ; « autre » : lecture ou route sans effet sur une équipe. */
type ProxyAction = "envoi" | "abort" | "modification" | "suppression" | "reponse" | "autre";

function proxyActionOf(req: TeamProxyGuardRequest): ProxyAction {
  const method = req.method.toUpperCase();
  if (method === "POST" && req.permissionId !== null) return "reponse";
  if (req.sessionId === null) return "autre";
  if (method === "POST" && SEND_ROUTE.test(req.sub)) return "envoi";
  if (method === "POST" && ABORT_ROUTE.test(req.sub)) return "abort";
  if (method === "PATCH" && SESSION_ONLY_ROUTE.test(req.sub)) return "modification";
  if (method === "DELETE" && SESSION_ONLY_ROUTE.test(req.sub)) return "suppression";
  return "autre";
}

/** Demande d'autorisation posée sous le plancher ETAPE et seule permise à une session d'étape (ME-2). */
const PERMISSION_ETAPE = "doom_loop";

// --- Corps des refus -------------------------------------------------------------------------------------------------------------

/** Refus rendu tel quel par le proxy ou par le middleware des Archives : rien n'est relayé, rien n'est supprimé. */
function locked(code: TeamErrorCode, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), { status: 409, headers: { "content-type": "application/json" } });
}

/** Refus d'une route d'incident : le code et sa phrase (team-texts.ts, T4t), avec les détails du port quand il y en a. */
interface RouteRefusal {
  status: 400 | 403 | 404 | 409 | 422 | 428 | 502;
  code: TeamErrorCode;
  details?: Record<string, unknown>;
  /** Phrase imposée (refus de relance : « … Rien n'a été envoyé ni facturé. ») ; absente : phraseErreur(code). */
  message?: string;
}

// --- Reconstitution locale d'un lancement (D-eq-27) --------------------------------------------------------------------------------

/** Lancements relançables : la suite repart en « preparation » (D-eq-16, transitions de T4). */
const RELAUNCHABLE: readonly TeamRunState[] = Object.freeze(["interrompue", "echec", "plafond"]);

/** Identifiant de lancement : UUID tiré au lancement (§4.1.5, « lancement UUID »). */
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * Demande reconstituée d'un lancement (D-eq-27) : dossier, racine et confirmations lus en base, demande et pièces jointes relues
 * dans le `message_text` d'une étape QUI A REÇU LA DEMANDE (marqueurs bornés par l'identifiant du lancement). Textes purgés avec
 * la conversation, format inconnu ou aucune étape porteuse → null : la relance est refusée « pas-relancable », sans aucune requête.
 * `agentConversation` n'est pas gardé en base : il est relu du dernier tour de la conversation (ledger), sinon de l'assistant par
 * défaut ; le pré-lancement (L37p) le valide comme pour un premier lancement.
 */
function rebuildRunBody(eq: EqContext, store: TeamStore, run: RunRow, estimateSha256: string): TeamRunBody | null {
  let demande: { demande: string; fichiers: string[] } | null = null;
  for (const step of store.steps.ofRun(run.id)) {
    demande = step.message_text === null ? null : requestFromStepMessage(step.message_text, run.id);
    if (demande !== null) break;
  }
  if (demande === null) return null;
  const confirmations = parseJson<Record<string, unknown>>(run.confirmations, {});
  const gardees: TeamRunBody["confirmations"] = {};
  for (const nom of ["workspace", "secret", "plafond", "budget"] as const) if (confirmations[nom] === true) gardees[nom] = true;
  const choix = eq.c11.ledger.lastChatChoice(run.root_session_id);
  return {
    directory: run.directory,
    rootId: run.root_session_id,
    demande: demande.demande,
    fichiers: demande.fichiers,
    agentConversation: choix?.agent ?? eq.c11.settings.get().chat.defaultAgent ?? "build",
    estimateSha256,
    confirmations: gardees,
  };
}

/**
 * Équipe telle qu'elle a été lancée : le déroulé figé du lancement fait foi (l'équipe installée a pu changer ou disparaître).
 * `avance` est repris de l'équipe installée quand elle existe encore, sinon 0 ; le pré-lancement revalide la grammaire.
 */
function teamRowOfRun(eq: EqContext, run: RunRow): TeamRow {
  const installee = run.team_id === null ? null : eq.ports.teams.get(run.team_id);
  return {
    id: run.team_id ?? run.id,
    titre: run.team_titre,
    description: installee?.description ?? "",
    flow: run.flow,
    origine: installee?.origine ?? "creee",
    exemple_id: installee?.exemple_id ?? null,
    exemple_version: installee?.exemple_version ?? null,
    avance: installee?.avance ?? 0,
    created_at: run.created_at,
    updated_at: installee?.updated_at ?? run.created_at,
  };
}

/** Étapes non terminées, dans l'ordre de planSteps (chemin restant d'une relance, §4.1.2). */
function remainingSteps(store: TeamStore, run: RunRow): string[] {
  const flow = parseJson<Flow | null>(run.flow, null);
  const ordre = flow === null ? [] : planSteps(flow).map((step) => step.stepId);
  const finies = new Set(store.steps.ofRun(run.id).filter((step) => step.state === "terminee").map((step) => step.step_id));
  return ordre.filter((stepId) => !finies.has(stepId));
}

// <c5:reprise-redemarrage>
/**
 * Clôture 5b (D-5b-1) : chemin restant d'une PAUSE reprise après un redémarrage du cockpit, compté PAR PASSAGE, exactement comme
 * POST …/estimate le compte pour une relance (team-preflight.ts, `estimate`) : une ligne par (étape, tour), sa dernière tentative
 * faisant foi, et chaque passage terminé retiré une fois du chemin maximal de `planSteps`. La reprise ne refait rien de déjà
 * fait, donc ce chemin est bien celui qui reste, et l'empreinte recalculée par `check` tombe sur celle de l'estimation montrée.
 * `remainingSteps`, lui, retire toute étape terminée une fois : pour une relecture dont le premier jet est fait, il perd les
 * révisions à venir, et la confirmation était refusée « estimation-perimee » à chaque fois (mesuré sur le vrai pré-lancement).
 */
export function cheminParPassages(store: TeamStore, run: RunRow): string[] {
  const flow = parseJson<Flow | null>(run.flow, null);
  if (flow === null) return [];
  const derniere = new Map<string, { tentative: number; state: string; stepId: string }>();
  for (const step of store.steps.ofRun(run.id)) {
    const cle = `${step.step_id}\u0000${step.tour}`;
    const kept = derniere.get(cle);
    if (!kept || step.tentative >= kept.tentative) derniere.set(cle, { tentative: step.tentative, state: step.state, stepId: step.step_id });
  }
  const faits = new Map<string, number>();
  for (const ligne of derniere.values()) if (ligne.state === "terminee") faits.set(ligne.stepId, (faits.get(ligne.stepId) ?? 0) + 1);
  return planSteps(flow)
    .map((planned) => planned.stepId)
    .filter((stepId) => {
      const restant = faits.get(stepId) ?? 0;
      if (restant <= 0) return true;
      faits.set(stepId, restant - 1);
      return false;
    });
}

/**
 * Clôture 5b (D-5b-1, tour 3) : accords du corps de POST …/relancer pour une pause reprise (`TeamRelaunchBody.confirmations`).
 * Seuls `budget` (P7) et `plafond` (P8) peuvent être accordés ici, et seulement à `true` : les confirmations « workspace » et
 * « secret » viennent du lancement (rebuildRunBody), jamais d'une reprise. Absent → aucun accord ; toute autre forme → null
 * (400 invalid, sans aucune requête, A4).
 */
export function accordsDeReprise(parsed: unknown): { budget?: true; plafond?: true } | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const brut = (parsed as Record<string, unknown>).confirmations;
  if (brut === undefined) return {};
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) return null;
  const accords: { budget?: true; plafond?: true } = {};
  for (const [cle, valeur] of Object.entries(brut)) {
    if ((cle !== "budget" && cle !== "plafond") || valeur !== true) return null;
    accords[cle] = true;
  }
  return accords;
}
// </c5:reprise-redemarrage>

// --- Module -----------------------------------------------------------------------------------------------------------------------

export interface TeamGuards {
  port: TeamGuardsPort;
  /** Rechargement d'opencode (dérivation, synchrone) : global.disposed et server.instance.disposed. */
  derivation: EventDerivation;
  /** Abonnement usage.updated : plafond d'arrêt (§6 l.1036). */
  onUsage(data: UsageUpdatedData): void;
  /** Routes d'incident du groupe « team-runs ». */
  routes(app: Hono): void;
}

export function createTeamGuards(eq: EqContext): TeamGuards {
  const store = createTeamStore({ db: eq.c11.db });
  const { verrous } = TEXTES.partout;
  /** Lancements dont l'arrêt au plafond est en cours : jamais deux arrêts pour le même (usage.updated est répété). */
  const capping = new Set<string>();

  // --- Verrou du proxy et des Archives (D-eq-04) ------------------------------------------------------------------------------

  /**
   * Demande d'autorisation : session et nature lues dans permission_waits (écrites par L4b à la question), sinon session lue
   * dans les demandes en attente d'opencode (gate.pending). Nature inconnue d'une session d'étape : refus prudent, le travail
   * d'une étape se consulte seulement. Lecture impossible : null (comportement inchangé).
   */
  const permissionTarget = async (permissionId: string, directory: string | null): Promise<{ sessionId: string; permission: string | null } | null> => {
    const row = eq.c11.db.prepare("SELECT session_id, permission FROM permission_waits WHERE permission_id = ?").get(permissionId) as
      | { session_id: string; permission: string }
      | undefined;
    if (row) return { sessionId: row.session_id, permission: row.permission };
    try {
      const pending = await eq.c11.gate.pending(directory);
      const found = pending.find((request) => request.id === permissionId);
      return found ? { sessionId: found.sessionID, permission: null } : null;
    } catch (err) {
      eq.c11.log.warn("équipes : demande d'autorisation illisible, verrou non appliqué", { error: errorMessage(err) });
      return null;
    }
  };

  const proxyGuard = async (req: TeamProxyGuardRequest): Promise<Response | null> => {
    const runner = eq.ports.runner;
    // Entrée des Archives : la route n'est pas appelée, donc AUCUNE purge (spéc. §3.13 l.425, §3.5).
    if (req.entree === "archive") {
      if (req.method.toUpperCase() !== "DELETE" || req.sessionId === null) return null;
      return runner.activeRunOf(req.sessionId) === null ? null : locked("equipe-en-cours", verrous.suppression);
    }
    const action = proxyActionOf(req);
    if (action === "autre") return null;
    if (action === "reponse") {
      const cible = req.permissionId === null ? null : await permissionTarget(req.permissionId, req.directory);
      if (cible === null || runner.stepOf(cible.sessionId) === null) return null;
      // « always » reste refusé par le proxy existant ; ici seule la demande posée sous le plancher ETAPE peut recevoir une réponse.
      return cible.permission === PERMISSION_ETAPE ? null : locked("etape-consultable", verrous.consultable);
    }
    const sessionId = req.sessionId;
    if (sessionId === null) return null;
    // Session d'étape : tout envoi, PATCH, DELETE ou abort est refusé (elle se consulte seulement).
    if (runner.stepOf(sessionId) !== null) return locked("etape-consultable", verrous.consultable);
    if (runner.activeRunOf(sessionId) === null) return null;
    if (action === "envoi") return locked("equipe-en-cours", verrous.envoi);
    if (action === "suppression") return locked("equipe-en-cours", verrous.suppression);
    // « Arrêter » (abort) et le renommage d'une conversation restent permis pendant une équipe.
    return null;
  };

  // --- Plafond d'arrêt (§6 l.1036) ---------------------------------------------------------------------------------------------

  /**
   * Arrêt au plafond : la cause est MÉMORISÉE EN BASE (team_runs.cause = « plafond », plus un événement d'audit « plafond »)
   * AVANT l'arrêt, puis stopTree arrête toute la conversation. Le runner, prévenu par le décorateur (stopRequested puis stopped),
   * lit cette cause pour enregistrer l'état « plafond » plutôt que « arretee ». Le coût déjà engagé reste facturé, et un appel
   * en cours par étape peut dépasser le plafond : c'est ce que dit la carte (TEXTES.partout.cartes.plafond).
   */
  const stopForCap = async (runId: string): Promise<void> => {
    if (capping.has(runId)) return;
    const run = store.runs.get(runId);
    if (run === null || !ACTIVE_RUN_STATES.includes(run.state)) return;
    capping.add(runId);
    try {
      store.runs.patch(runId, { cause: "plafond" });
      store.events.append({
        runId,
        kind: "plafond",
        par: "cockpit",
        data: { depense: store.spentOfRun(runId), plafond: run.plafond },
      });
      await eq.c11.ports.stopTree.run(run.root_session_id, "equipe");
    } catch (err) {
      eq.c11.log.warn("équipes : arrêt au plafond en échec", { runId, error: errorMessage(err) });
    } finally {
      capping.delete(runId);
    }
  };

  /**
   * usage.updated d'un message terminé : équipe active de la racine (port du runner), dépense du lancement (sessions d'étape
   * seulement) comparée à son plafond. Sans `rootId` (après un rattrapage), rien n'est décidé ici : le prochain message terminé
   * porte la racine, et le runner contrôle aussi le budget à chaque fin d'étape.
   */
  const onUsage = (data: UsageUpdatedData): void => {
    const rootId = data.rootId;
    if (rootId === undefined) return;
    const active = eq.ports.runner.activeRunOf(rootId);
    if (active === null) return;
    const run = store.runs.get(active.runId);
    if (run === null || run.plafond === null) return;
    if (store.spentOfRun(run.id) < run.plafond) return;
    void stopForCap(run.id);
  };

  // --- Rechargement d'opencode (§3.11) -------------------------------------------------------------------------------------------

  /** Lancements actifs dont une étape TRAVAILLE (« en-cours » ou « attente-accord ») ; une équipe en pause n'en a aucune. */
  const runsWithWorkingStep = (directory: string | null): string[] => {
    const etats = ACTIVE_RUN_STATES.map((_, index) => `:etat${index}`).join(", ");
    const valeurs: Record<string, string> = Object.fromEntries(ACTIVE_RUN_STATES.map((state, index) => [`etat${index}`, state]));
    const rows = eq.c11.db
      .prepare(
        `SELECT DISTINCT r.id AS id FROM team_runs r JOIN team_run_steps s ON s.run_id = r.id
         WHERE r.state IN (${etats}) AND s.state IN ('en-cours', 'attente-accord')
           AND (:directory IS NULL OR r.directory = :directory)
         ORDER BY r.created_at, r.id`,
      )
      .all({ ...valeurs, directory }) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  };

  const derivation: EventDerivation = {
    name: "teamGuards",
    onEvent(global: OcGlobalEvent) {
      const type = global.payload?.type;
      if (type !== "global.disposed" && type !== "server.instance.disposed") return;
      // Une instance libérée n'emporte que les équipes de son dossier ; global.disposed les emporte toutes.
      let directory: string | null = null;
      if (type === "server.instance.disposed") {
        const asked = global.payload?.properties?.directory;
        if (typeof asked !== "string" || asked === "") return;
        directory = asked;
      }
      try {
        for (const runId of runsWithWorkingStep(directory)) eq.ports.runner.interrupt(runId, "rechargement");
      } catch (err) {
        eq.c11.log.warn("équipes : rechargement d'opencode non répercuté", { error: errorMessage(err) });
      }
    },
  };

  // --- Routes d'incident (§4.1.5) ---------------------------------------------------------------------------------------------

  /** Vue rendue par les routes : celle du runner (pause, chemin restant, libellés d'IA), sinon celle de la base. */
  const viewOf = (runId: string): TeamRunView | null => eq.ports.runner.view(runId) ?? store.runs.view(runId);

  /** Équipes fermées en mode Simple tant qu'EQUIPES_SIMPLE_OUVERTES est faux (U1, §2.6) : estimation et relance seulement. */
  const simpleFermees = (): boolean => !eq.simpleOuvertes && !isAdvanced(eq.c11.settings);

  const modeOf = () => eq.c11.settings.get().ui.mode;

  /** Corps d'un refus : le code et sa phrase (T4t), avec les détails du port. */
  const body = (refusal: RouteRefusal) => ({
    error: refusal.code,
    message: refusal.message ?? phraseErreur(refusal.code),
    ...(refusal.details === undefined ? {} : { details: refusal.details }),
  });

  /** Refus d'une relance : la phrase du code suivie de « Rien n'a été envoyé ni facturé. » (A4, honnêteté §6 l.1037). */
  const relaunchRefusal = (refusal: RouteRefusal) => body({ ...refusal, message: refusLancement(refusal.code) });

  const routes = (app: Hono): void => {
    /** Lancement demandé : 400 identifiant invalide, 404 inconnu. */
    const runOf = (raw: string | undefined): RunRow | RouteRefusal => {
      if (raw === undefined || !RUN_ID_RE.test(raw)) return { status: 400, code: "invalid" };
      const run = store.runs.get(raw);
      return run ?? { status: 404, code: "not-found" };
    };
    const isRefusal = (value: RunRow | RouteRefusal): value is RouteRefusal => "code" in value;
    // <c5:reprise-redemarrage>
    /**
     * Clôture 5b (D-5b-1) : une pause qui a survécu à un redémarrage du cockpit sans l'instantané de son estimation passe aussi par
     * ces deux routes — estimation MONTRÉE, puis confirmation. C'est la vue du runner qui le dit (`pause.reestimation`), calculée
     * sur la base seule : aucune requête à opencode avant la décision (A4). Une pause dont l'instantané est là (lancée par ce
     * processus) reste hors de ces routes : seule VOTRE réponse (POST …/continue) la fait repartir.
     */
    const repriseAttendue = (run: RunRow): boolean => run.state.startsWith("attente-") && eq.ports.runner.view(run.id)?.pause?.reestimation !== undefined;
    // </c5:reprise-redemarrage>

    app.post("/api/team-runs/:runId/stop", async (c) => {
      const run = runOf(c.req.param("runId"));
      if (isRefusal(run)) return c.json(body(run), run.status);
      if (!ACTIVE_RUN_STATES.includes(run.state)) return c.json(body({ status: 409, code: "etat-incompatible" }), 409);
      // Arrêt unique (§3.12) : la même séquence que « Arrêter », décorée (D-eq-05) — le runner n'ouvre plus aucune étape.
      await eq.c11.ports.stopTree.run(run.root_session_id, "equipe");
      const view = viewOf(run.id);
      return view === null ? c.json(body({ status: 404, code: "not-found" }), 404) : c.json(view);
    });

    app.post("/api/team-runs/:runId/estimate", async (c) => {
      const run = runOf(c.req.param("runId"));
      if (isRefusal(run)) return c.json(body(run), run.status);
      if (simpleFermees()) return c.json(body({ status: 403, code: "equipes-simple-fermees" }), 403);
      // <c5:reprise-redemarrage>
      if (!RELAUNCHABLE.includes(run.state) && !repriseAttendue(run)) return c.json(body({ status: 409, code: "pas-relancable" }), 409);
      // </c5:reprise-redemarrage>
      // Seule route de la relance qui lit opencode (D-eq-17) : elle garde l'instantané que POST …/relancer réutilise.
      const outcome = await eq.ports.preflight.estimate(teamRowOfRun(eq, run), { directory: run.directory, rootId: run.root_session_id }, modeOf(), {
        runId: run.id,
      });
      if (!outcome.ok) return c.json(body(outcome), outcome.status);
      const response: TeamEstimateResponse = { ...outcome.response, deja: outcome.response.deja ?? store.spentOfRun(run.id) };
      return c.json(response);
    });

    app.post("/api/team-runs/:runId/relancer", async (c) => {
      // A4 : AUCUNE requête à opencode avant la décision — tous les contrôles ci-dessous sont locaux (base et corps).
      const run = runOf(c.req.param("runId"));
      if (isRefusal(run)) return c.json(body(run), run.status);
      if (simpleFermees()) return c.json(body({ status: 403, code: "equipes-simple-fermees" }), 403);
      if (c.req.header(CONFIRM_HEADER) !== "1") return c.json(body({ status: 428, code: "confirmation-requise" }), 428);
      const corps: unknown = await c.req.json().catch(() => null);
      const empreinte = relaunchEmpreinte(corps);
      if (empreinte === null) return c.json(body({ status: 400, code: "invalid" }), 400);
      // <c5:reprise-redemarrage>
      const reprise = !RELAUNCHABLE.includes(run.state) && repriseAttendue(run);
      if (!RELAUNCHABLE.includes(run.state) && !reprise) return c.json(relaunchRefusal({ status: 409, code: "pas-relancable" }), 409);
      // Tour 3 : les accords (budget P7, plafond P8) que la boîte de la reprise vous a montrés. Une relance de l'itération 4 ne les
      // lit pas : son comportement ne change pas.
      const accords = reprise ? accordsDeReprise(corps) : {};
      if (accords === null) return c.json(body({ status: 400, code: "invalid" }), 400);
      // </c5:reprise-redemarrage>
      const rebuilt = rebuildRunBody(eq, store, run, empreinte);
      // D-eq-27 : textes purgés avec la conversation → la demande n'est plus reconstituable, la suite ne repart pas.
      if (rebuilt === null) return c.json(relaunchRefusal({ status: 409, code: "pas-relancable" }), 409);
      // <c5:reprise-redemarrage>
      // Clôture 5b (D-5b-1, tour 3) : ce que la boîte a montré et que vous avez confirmé vaut accord, comme sur la feuille de
      // lancement. Sans cela, une pause « garde-fou budgétaire » reprise avec un budget du mois épuisé était refusée
      // « budget-insuffisant » à chaque confirmation, et seul [Arrêter l'équipe] en sortait. Toutes les autres gardes du
      // pré-lancement restent (P6 par l'en-tête, empreinte, grammaire, configuration, trop d'équipes).
      if (reprise) rebuilt.confirmations = { ...rebuilt.confirmations, ...accords };
      // </c5:reprise-redemarrage>
      const input: PreflightInput = {
        team: teamRowOfRun(eq, run),
        body: rebuilt,
        mode: modeOf(),
        confirmed: true,
        // <c5:reprise-redemarrage>
        // Une pause reprise ne refait rien : son reste est compté par passage, comme l'estimation qui vous a été montrée.
        relance: { runId: run.id, restantes: reprise ? cheminParPassages(store, run) : remainingSteps(store, run), depense: store.spentOfRun(run.id) },
        // </c5:reprise-redemarrage>
      };
      const checked = await eq.ports.preflight.check(input);
      if (!checked.ok) return c.json(relaunchRefusal(checked), checked.status);
      // <c5:reprise-redemarrage>
      // L'état a pu changer pendant le pré-lancement (deux confirmations presque simultanées, arrêt) : il est relu avant la
      // relance, pour qu'une pause déjà reprise ne passe jamais par la relance complète et que rien ne soit relu pour rien.
      const actuel = store.runs.get(run.id);
      if (actuel === null || (!RELAUNCHABLE.includes(actuel.state) && !repriseAttendue(actuel))) {
        return c.json(relaunchRefusal({ status: 409, code: "pas-relancable" }), 409);
      }
      // </c5:reprise-redemarrage>
      const relaunched = await eq.ports.runner.relaunch(run.id, checked.plan);
      if ("ok" in relaunched && relaunched.ok === false) return c.json(relaunchRefusal(relaunched), relaunched.status);
      return c.json(relaunched);
    });

    app.post("/api/team-runs/:runId/fermer", (c) => {
      const run = runOf(c.req.param("runId"));
      if (isRefusal(run)) return c.json(body(run), run.status);
      // « Fermer » range un lancement arrêté en chemin (interrompue, plafond, echec) : cause « vous » (§4.1.5).
      if (!RELAUNCHABLE.includes(run.state)) return c.json(body({ status: 409, code: "etat-incompatible" }), 409);
      const closed = eq.ports.runner.close(run.id);
      if ("ok" in closed && closed.ok === false) return c.json(body(closed), closed.status);
      return c.json(closed);
    });

    app.post("/api/team-runs/:runId/ajouter-resultats", async (c) => {
      const run = runOf(c.req.param("runId"));
      if (isRefusal(run)) return c.json(body(run), run.status);
      if (run.result_message_id !== null) return c.json(body({ status: 409, code: "deja-ajoute" }), 409);
      // Les résultats obtenus s'ajoutent une fois l'équipe finie ou arrêtée, jamais pendant qu'elle travaille (§3.12).
      if (ACTIVE_RUN_STATES.includes(run.state)) return c.json(body({ status: 409, code: "etat-incompatible" }), 409);
      const added = await eq.ports.runner.addResults(run.id);
      if ("ok" in added && added.ok === false) return c.json(body(added), added.status);
      return c.json(added);
    });
  };

  return { port: { proxyGuard, stopForCap }, derivation, onUsage, routes };
}

/** Corps de POST …/relancer : { estimateSha256 } ; toute autre forme est refusée sans aucune requête (400 invalid). */
function relaunchEmpreinte(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const empreinte = (parsed as Record<string, unknown>).estimateSha256;
  return typeof empreinte === "string" && /^[0-9a-f]{64}$/i.test(empreinte) ? empreinte : null;
}

export const teamGuardsModule: EqModule = {
  name: "teamGuards",
  install(reg, eq) {
    const guards = createTeamGuards(eq);
    eq.ports.guards = guards.port;
    reg.proxyGuard((req) => eq.ports.guards.proxyGuard(req));
    reg.stopTreeDecorator((inner) => teamStopTree(eq, inner));
    reg.derivation(guards.derivation);
    reg.hub("usage.updated", (data) => guards.onUsage(data));
    reg.routes("team-runs", (app) => guards.routes(app));
  },
};
