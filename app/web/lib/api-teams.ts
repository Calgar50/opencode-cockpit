// Itération 4 (T4) : client mince des routes d'équipe, groupes « teams » et « team-runs » (plan d'exécution it4 §4.1.5). Mêmes
// en-têtes, erreurs (ApiError) et CSRF que web/lib/api.ts (aide `http` réutilisée : toute mutation porte x-cockpit-csrf) ;
// `confirm` envoie x-cockpit-confirm: 1. Pas de client ici pour GET /api/agent-map (api-agent-map.ts, L39b), ni pour l'entrée du
// proxy, l'entrée des Archives et /activity, servis par les clients existants. Identifiants encodés ; le serveur les valide
// (équipe ^[a-z0-9-]{1,40}$, lancement UUID, sessions par shared/ids.ts).
import { TEAM_ERROR_CODES, TEAM_GUARD_CODES } from "../../server/shared/team-limits.ts";
import { ApiError, http, query } from "./api.ts";
import type {
  FlowProblem,
  TeamAddResultsResponse,
  TeamContinueBody,
  TeamErrorBody,
  TeamEstimateBody,
  TeamEstimateResponse,
  TeamInstallResponse,
  TeamPreviewBody,
  TeamPreviewResponse,
  TeamPutBody,
  TeamRelaunchBody,
  TeamRunBody,
  TeamRunStarted,
  TeamRunsResponse,
  TeamRunView,
  TeamsListResponse,
  TeamView,
} from "./types.ts";

const enc = encodeURIComponent;

/** Groupe « teams » (L37a ; estimation calculée par L37p, lancement par L37b). */
export const teamsApi = {
  /** GET /api/teams → équipes installées, exemples, `ouvertesEnSimple`. */
  list: (signal?: AbortSignal) => http.get<TeamsListResponse>("/api/teams", signal),
  /** POST /api/teams/preview : problèmes, estimation, droits, disposition ; n'écrit rien (64 Kio au plus ; 400). */
  preview: (body: TeamPreviewBody) => http.post<TeamPreviewResponse>("/api/teams/preview", body),
  /** PUT /api/teams/:id (400 ; 403 mode-avance, equipes-simple-fermees ; 422 equipe-invalide avec `problems`). */
  put: (id: string, body: TeamPutBody) => http.put<TeamView>(`/api/teams/${enc(id)}`, body),
  /** DELETE /api/teams/:id → 204 (404 ; 409 equipe-en-cours). */
  remove: (id: string) => http.del<null>(`/api/teams/${enc(id)}`),
  /**
   * POST /api/teams/examples/:id/install (404 ; 403 equipes-simple-fermees ; 409 sessions-busy, redemarrage-en-cours,
   * reponses-non-verifiables, message de la garde rendu tel quel). `confirm` : dérogation du mode Avancé à la garde.
   */
  installExample: (id: string, options: { confirm?: boolean } = {}) =>
    http.post<TeamInstallResponse>(`/api/teams/examples/${enc(id)}/install`, {}, options),
  /**
   * POST /api/teams/:id/estimate : seule route du lancement qui lit opencode (instantané gardé 10 min, `expireA`) ; 400 ; 403
   * forbidden-directory, equipes-simple-fermees ; 404 ; 502 opencode-injoignable.
   */
  estimate: (id: string, body: TeamEstimateBody) => http.post<TeamEstimateResponse>(`/api/teams/${enc(id)}/estimate`, body),
  /**
   * POST /api/teams/:id/run → 202 { runId, rootId } ; tout refus : aucune requête à opencode (codes du pré-lancement ; 409
   * estimation-perimee : ré-estimer). `confirm` : garde-fou budgétaire P6 confirmé (les autres confirmations sont dans le corps).
   */
  run: (id: string, body: TeamRunBody, options: { confirm?: boolean } = {}) =>
    http.post<TeamRunStarted>(`/api/teams/${enc(id)}/run`, body, options),
};

/** Groupe « team-runs » (L37b : lectures et continue ; L37c : stop, estimate, relancer, fermer, ajouter-resultats). */
export const teamRunsApi = {
  /** GET /api/team-runs?rootId= → lancements de la conversation (400). */
  ofRoot: (rootId: string, signal?: AbortSignal) => http.get<TeamRunsResponse>(`/api/team-runs${query({ rootId })}`, signal),
  /** GET /api/team-runs?sessionId= → le lancement dont cette session est une session d'étape, sinon une liste vide (400). */
  ofStepSession: (sessionId: string, signal?: AbortSignal) =>
    http.get<TeamRunsResponse>(`/api/team-runs${query({ sessionId })}`, signal),
  /** GET /api/team-runs/:runId (400 ; 404). */
  get: (runId: string, signal?: AbortSignal) => http.get<TeamRunView>(`/api/team-runs/${enc(runId)}`, signal),
  /** POST /api/team-runs/:runId/continue (404 ; 409 etat-incompatible, budget-guard). `confirm` : pause de budget. */
  continue: (runId: string, body: TeamContinueBody, options: { confirm?: boolean } = {}) =>
    http.post<TeamRunView>(`/api/team-runs/${enc(runId)}/continue`, body, options),
  /** POST /api/team-runs/:runId/stop (404 ; 409 etat-incompatible). */
  stop: (runId: string) => http.post<TeamRunView>(`/api/team-runs/${enc(runId)}/stop`, {}),
  /**
   * POST /api/team-runs/:runId/estimate : estimation du chemin restant, avec `deja` (404 ; 409 pas-relancable ; 403
   * equipes-simple-fermees ; 502 opencode-injoignable).
   */
  estimate: (runId: string) => http.post<TeamEstimateResponse>(`/api/team-runs/${enc(runId)}/estimate`, {}),
  /**
   * POST /api/team-runs/:runId/relancer, toujours avec x-cockpit-confirm: 1 et l'empreinte de l'estimation ; tout refus : aucune
   * requête à opencode (404 ; 428 confirmation-requise ; 409 pas-relancable, estimation-perimee, budget-guard,
   * conversation-occupee ; 403 equipes-simple-fermees).
   */
  relaunch: (runId: string, body: TeamRelaunchBody) => http.post<TeamRunView>(`/api/team-runs/${enc(runId)}/relancer`, body, { confirm: true }),
  /** POST /api/team-runs/:runId/fermer (interrompue, plafond ou échec → arrêtée ; 404 ; 409 etat-incompatible). */
  close: (runId: string) => http.post<TeamRunView>(`/api/team-runs/${enc(runId)}/fermer`, {}),
  /** POST /api/team-runs/:runId/ajouter-resultats → { messageId } (404 ; 409 etat-incompatible, deja-ajoute). */
  addResults: (runId: string) => http.post<TeamAddResultsResponse>(`/api/team-runs/${enc(runId)}/ajouter-resultats`, {}),
};

const TEAM_CODES: ReadonlySet<string> = new Set<string>([...TEAM_ERROR_CODES, ...TEAM_GUARD_CODES]);

/**
 * Refus d'une route d'équipe lu dans un ApiError (code connu de TeamErrorCode ou de la garde de rechargement, message du
 * serveur, détails, problèmes du déroulé), sinon null.
 */
export function teamError(err: unknown): (TeamErrorBody & { status: number }) | null {
  if (!(err instanceof ApiError) || !TEAM_CODES.has(err.code)) return null;
  const data = err.data && typeof err.data === "object" ? (err.data as Partial<TeamErrorBody>) : {};
  return {
    status: err.status,
    error: err.code as TeamErrorBody["error"],
    message: err.message,
    ...(data.details && typeof data.details === "object" ? { details: data.details } : {}),
    ...(Array.isArray(data.problems) ? { problems: data.problems as FlowProblem[] } : {}),
  };
}
