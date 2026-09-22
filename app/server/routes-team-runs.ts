// Propriétaire : L37b.
// Routes du groupe « team-runs » montées par le runner (plan d'exécution it4 §4.1.5) : POST /api/teams/:id/run (tout refus : zéro
// requête à opencode, A4), GET /api/team-runs?rootId= et ?sessionId=, GET /api/team-runs/:runId, POST …/continue. Les routes
// d'incident (stop, estimate, relancer, fermer, ajouter-resultats) sont montées par le module teamGuards (L37c).
//
// A4 / D-eq-17 : le lancement ne lit RIEN d'opencode avant sa décision. Le corps, l'équipe, le mode et l'instantané de
// l'estimation suffisent (`preflight.check`) ; un refus est rendu tel quel, sans qu'aucune requête ne soit partie. Le contrôle de
// fraîcheur est fait par le runner APRÈS la réponse 202.
//
// 5b (L42b) : POST …/continue porte aussi VOTRE réponse à une pause de choix d'aiguillage (`choix` ou `aucun`, L42a). Aucun autre
// chemin n'y répond : ni l'autonomie, ni un crochet du navigateur (spéc. l.772). Un choix qui ne tient pas est refusé par le
// runner en 409, avant toute écriture et sans la moindre requête à opencode.
// La demande et les pièces jointes ne sont jamais journalisées ni recopiées dans une réponse d'erreur (U2, D-eq-26, D-eq-27).
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EqContext, RunnerRefusal } from "./contracts-eq.ts";
import { CONFIRM_HEADER } from "./security.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { FLOW_LIMITS, STEP_ID_RE, TEAM_ID_RE, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import { phraseErreur, refusLancement } from "./shared/team-texts.ts";
import type { TeamContinueBody, TeamErrorBody, TeamErrorCode, TeamRunBody, TeamRunsResponse, TeamRunStarted } from "./shared/team-types.ts";

/** Corps accepté par POST /api/teams/:id/run et POST …/continue (même borne que l'aperçu : 64 Kio). */
const BODY_MAX = TEAM_TEXT_LIMITS.apercuOctets;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (c: Context, message: string) => c.json<TeamErrorBody>({ error: "invalid", message }, 400);

/** Refus d'un lancement ou d'une relance : phrase du code, puis « Rien n'a été envoyé ni facturé. » (A4). */
function refuseLaunch(c: Context, refusal: { status: 400 | 403 | 404 | 409 | 422 | 428; code: TeamErrorCode; details?: Record<string, unknown> }) {
  const body: TeamErrorBody = {
    error: refusal.code,
    message: refusLancement(refusal.code),
    ...(refusal.details ? { details: refusal.details } : {}),
  };
  return c.json<TeamErrorBody>(body, refusal.status);
}

function refuse(c: Context, refusal: RunnerRefusal) {
  const body: TeamErrorBody = {
    error: refusal.code,
    message: phraseErreur(refusal.code),
    ...(refusal.details ? { details: refusal.details } : {}),
  };
  return c.json<TeamErrorBody>(body, refusal.status);
}

/** Corps de lancement : formes et bornes seulement ; les contrôles de fond sont au pré-lancement (L37p), sans requête. */
function readRunBody(raw: unknown): TeamRunBody | null {
  if (!isRecord(raw)) return null;
  const { directory, rootId, demande, fichiers, agentConversation, estimateSha256, confirmations } = raw;
  if (typeof directory !== "string" || directory.length === 0 || directory.length > 4096) return null;
  if (rootId !== null && (typeof rootId !== "string" || !SESSION_ID_RE.test(rootId))) return null;
  if (typeof demande !== "string" || demande.length > FLOW_LIMITS.demande) return null;
  if (!Array.isArray(fichiers) || fichiers.length > FLOW_LIMITS.fichiers) return null;
  if (!fichiers.every((file) => typeof file === "string" && file.length > 0 && file.length <= TEAM_TEXT_LIMITS.cheminFichier)) return null;
  if (typeof agentConversation !== "string" || agentConversation.length === 0 || agentConversation.length > 128) return null;
  if (typeof estimateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(estimateSha256)) return null;
  if (confirmations !== undefined && !isRecord(confirmations)) return null;
  const keys = ["workspace", "secret", "plafond", "budget"] as const;
  const retenues: TeamRunBody["confirmations"] = {};
  for (const key of keys) if (isRecord(confirmations) && confirmations[key] === true) retenues[key] = true;
  return {
    directory,
    rootId: rootId as string | null,
    demande,
    fichiers: fichiers as string[],
    agentConversation,
    estimateSha256,
    confirmations: retenues,
  };
}

/**
 * Corps de POST …/continue. 5b (L42a) : `choix` porte les identifiants de spécialistes que VOUS retenez, `aucun` dit qu'aucun ne
 * convient, et les deux ne s'envoient jamais ensemble. Ici, seules les FORMES sont contrôlées (identifiants d'étape, borne
 * générale FLOW_LIMITS.choixMax) : l'appartenance à la liste du bloc et son `choixMax` propre sont jugés par le runner, qui
 * refuse en 409 sans qu'aucune requête ne parte.
 */
function readContinueBody(raw: unknown): TeamContinueBody | null {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return null;
  const { precision, correction, choix, aucun } = raw;
  if (precision !== undefined && (typeof precision !== "string" || precision.length > FLOW_LIMITS.precision)) return null;
  if (correction !== undefined && (typeof correction !== "string" || correction.length > FLOW_LIMITS.relaisCaracteres)) return null;
  if (aucun !== undefined && aucun !== true) return null;
  if (choix !== undefined && aucun !== undefined) return null;
  if (choix !== undefined) {
    if (!Array.isArray(choix) || choix.length === 0 || choix.length > FLOW_LIMITS.choixMax) return null;
    if (!choix.every((id) => typeof id === "string" && STEP_ID_RE.test(id))) return null;
  }
  return {
    ...(typeof precision === "string" ? { precision } : {}),
    ...(typeof correction === "string" ? { correction } : {}),
    ...(Array.isArray(choix) ? { choix: choix as string[] } : {}),
    ...(aucun === true ? { aucun: true as const } : {}),
  };
}

export function registerTeamRunRoutes(app: Hono, eq: EqContext): void {
  const limit = bodyLimit({
    maxSize: BODY_MAX,
    onError: (c) => invalid(c, "Demande trop longue."),
  });

  /** Lecture du corps JSON : un corps illisible est un 400, jamais une requête à opencode. */
  const readJson = async (c: Context): Promise<unknown | undefined> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  app.post("/api/teams/:id/run", limit, async (c) => {
    const teamId = c.req.param("id");
    if (!TEAM_ID_RE.test(teamId)) return invalid(c, "Identifiant d'équipe invalide.");
    const raw = await readJson(c);
    const body = raw === undefined ? null : readRunBody(raw);
    if (body === null) return invalid(c, "Demande de lancement invalide.");
    const mode = eq.c11.settings.get().ui.mode;
    // §2.6 (U1, D-eq-13) : en Simple, le lancement est fermé tant que EQUIPES_SIMPLE_OUVERTES est faux. Aucune requête émise.
    if (mode === "simple" && !eq.simpleOuvertes) return refuseLaunch(c, { status: 403, code: "equipes-simple-fermees" });
    const team = eq.ports.teams.get(teamId);
    if (!team) return refuseLaunch(c, { status: 404, code: "not-found" });
    const confirmed = c.req.header(CONFIRM_HEADER) === "1";
    // Le garde-fou budgétaire confirmé au lancement (P6) vaut aussi pour les étapes suivantes : gardé dans `confirmations`.
    const corps: TeamRunBody = confirmed ? { ...body, confirmations: { ...body.confirmations, budget: true } } : body;
    const outcome = await eq.ports.preflight.check({ team, body: corps, mode, confirmed });
    if (!outcome.ok) return refuseLaunch(c, outcome);
    const started = await eq.ports.runner.launch(outcome.plan, corps);
    return c.json<TeamRunStarted>(started, 202);
  });

  app.get("/api/team-runs", (c) => {
    const rootId = c.req.query("rootId");
    const sessionId = c.req.query("sessionId");
    if (typeof rootId === "string") {
      if (!SESSION_ID_RE.test(rootId)) return invalid(c, "Identifiant de conversation invalide.");
      return c.json<TeamRunsResponse>({ runs: eq.ports.runner.runsOf(rootId) });
    }
    if (typeof sessionId === "string") {
      if (!SESSION_ID_RE.test(sessionId)) return invalid(c, "Identifiant de session invalide.");
      // Tiroir de lecture (L38c) : le lancement dont cette session est une session d'étape, sinon rien.
      const run = eq.ports.runner.runOfStepSession(sessionId);
      return c.json<TeamRunsResponse>({ runs: run === null ? [] : [run] });
    }
    return invalid(c, "Conversation ou session à lire non précisée.");
  });

  app.get("/api/team-runs/:runId", (c) => {
    const runId = c.req.param("runId");
    if (!SESSION_ID_RE.test(runId)) return invalid(c, "Identifiant de lancement invalide.");
    const run = eq.ports.runner.view(runId);
    if (run === null) return c.json<TeamErrorBody>({ error: "not-found", message: phraseErreur("not-found") }, 404);
    return c.json(run);
  });

  app.post("/api/team-runs/:runId/continue", limit, async (c) => {
    const runId = c.req.param("runId");
    if (!SESSION_ID_RE.test(runId)) return invalid(c, "Identifiant de lancement invalide.");
    const raw = await readJson(c);
    const body = raw === undefined ? null : readContinueBody(raw);
    if (body === null) return invalid(c, "Demande de reprise invalide.");
    const outcome = await eq.ports.runner.continue(runId, body, c.req.header(CONFIRM_HEADER) === "1");
    if ("ok" in outcome && outcome.ok === false) return refuse(c, outcome);
    return c.json(outcome);
  });
}
