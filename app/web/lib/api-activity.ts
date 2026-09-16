// 1.1 (T2) : client mince des routes d'activité (plan d'exécution §4.5, L4b) : relecture de l'activité d'une conversation et
// faits depuis un instant. Mêmes en-têtes, erreurs et CSRF que web/lib/api.ts (aide `http` réutilisée).
import { http, query } from "./api.ts";
import type { ActivityResponse, FactsResponse } from "./types.ts";

const enc = encodeURIComponent;

export const activityApi = {
  /** GET /api/conversations/:rootId/activity → délégations, attentes, décisions, demandes et appels d'IA (400). */
  activity: (rootId: string, signal?: AbortSignal) => http.get<ActivityResponse>(`/api/conversations/${enc(rootId)}/activity`, signal),
  /** GET /api/conversations/:rootId/facts?since= → faits persistés depuis `since` (ms), `partial` à la borne (400). */
  facts: (rootId: string, since: number, signal?: AbortSignal) =>
    http.get<FactsResponse>(`/api/conversations/${enc(rootId)}/facts${query({ since })}`, signal),
  /**
   * POST /api/conversations/:rootId/facts/affichage : « Affichage rattrapé » enregistré comme fait `affichage` (décision du
   * 15/09, n° 3 : route bornée écrite par L4b, sans texte). Réponse sans contenu utile.
   */
  affichage: (rootId: string) => http.post<unknown>(`/api/conversations/${enc(rootId)}/facts/affichage`),
};
