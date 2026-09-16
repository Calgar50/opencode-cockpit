// 1.1 (T2) : client mince du choix d'autonomie d'une conversation (plan d'exécution §4.5, L6a puis L10d). Mêmes en-têtes,
// erreurs et CSRF que web/lib/api.ts (aide `http` réutilisée) ; `confirm` envoie x-cockpit-confirm: 1.
import { ApiError, http } from "./api.ts";
import type { AutonomyErrorBody, AutonomyErrorCode, AutonomyPutBody, ConversationAutonomyView } from "./types.ts";

const enc = encodeURIComponent;

export const autonomyApi = {
  /** GET /api/conversations/:rootId/autonomie → choix en vigueur, choix disponibles et demande en cours (400, 404). */
  get: (rootId: string, signal?: AbortSignal) => http.get<ConversationAutonomyView>(`/api/conversations/${enc(rootId)}/autonomie`, signal),
  /**
   * PUT /api/conversations/:rootId/autonomie : resserrer est immédiat ; relâcher vers un choix automatique demande `confirm`
   * (428 confirmation-requise sinon). 403 autonomie-coupee, 409 autonomie-indisponible (voir autonomyError).
   */
  put: (rootId: string, body: AutonomyPutBody, options: { confirm?: boolean } = {}) =>
    http.put<ConversationAutonomyView>(`/api/conversations/${enc(rootId)}/autonomie`, body, options),
};

const AUTONOMY_ERROR_CODES: ReadonlySet<string> = new Set<AutonomyErrorCode>([
  "autonomie-coupee",
  "autonomie-indisponible",
  "confirmation-requise",
  "raccourci-refuse-autonomie",
]);

/** Corps d'erreur d'autonomie d'un ApiError (routes d'autonomie, de plans et proxy d'envoi), sinon null. */
export function autonomyError(err: unknown): (AutonomyErrorBody & { status: number }) | null {
  if (!(err instanceof ApiError) || !AUTONOMY_ERROR_CODES.has(err.code)) return null;
  const data = err.data && typeof err.data === "object" ? (err.data as Partial<AutonomyErrorBody>) : {};
  return {
    status: err.status,
    error: err.code as AutonomyErrorCode,
    message: err.message,
    ...(typeof data.raison === "string" ? { raison: data.raison } : {}),
  };
}
