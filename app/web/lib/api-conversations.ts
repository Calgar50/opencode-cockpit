// 1.1 (T2) : client mince des routes de conversation (plan d'exécution §4.5) : arrêt de l'arbre (L1c) et détails d'une
// délégation (L1d). Mêmes en-têtes, erreurs et CSRF que web/lib/api.ts (aide `http` réutilisée).
import { ApiError, http, oc } from "./api.ts";
import type { DelegationDetailsView, StopResult } from "./types.ts";

const enc = encodeURIComponent;

export const conversationApi = {
  /** POST /api/conversations/:rootId/stop → StopResult ; 400 identifiant invalide, 403 CSRF, 404 racine inconnue. */
  stop: (rootId: string) => http.post<StopResult>(`/api/conversations/${enc(rootId)}/stop`),
  /** GET /api/conversations/:rootId/delegations/:permissionId → carte détaillée du mode Avancé (400, 404, 503 opencode injoignable). */
  delegationDetails: (rootId: string, permissionId: string, signal?: AbortSignal) =>
    http.get<DelegationDetailsView>(`/api/conversations/${enc(rootId)}/delegations/${enc(permissionId)}`, signal),
};

/**
 * « Arrêter » : arrêt de toute la conversation (son travail délégué compris) ; sur 404 (racine non suivie, ou cockpit sans
 * la route), repli sur l'arrêt de la seule conversation par le proxy, comme en 1.0.4. Rend null après un repli.
 */
export async function stopConversation(rootId: string, directory: string): Promise<StopResult | null> {
  try {
    return await conversationApi.stop(rootId);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
  }
  await oc.abort(rootId, directory);
  return null;
}
