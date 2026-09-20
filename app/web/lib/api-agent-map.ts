// Propriétaire : L39b.
// Client des routes de la CARTE DES ASSISTANTS (plan d'exécution it4 §4.1.5, constat 16 : le client de la carte n'est pas dans
// api-teams.ts, dont le test de T4 exclut /api/agent-map). Une fonction par route de la carte, typée par shared/agent-map.ts
// (L39a). Mêmes en-têtes, erreurs (ApiError) et CSRF que web/lib/api.ts : l'aide `http` est réutilisée telle quelle.
// La carte ne fait que LIRE : aucune fonction d'écriture n'a sa place ici.
import type { AgentMapResult } from "../../server/shared/agent-map.ts";
import { phraseErreurCarte } from "../../server/shared/agent-map-texts.ts";
import { ApiError, http, query } from "./api.ts";

export const agentMapApi = {
  /**
   * GET /api/agent-map?directory=&element= → nœuds, arêtes et notes de la carte (400 `invalid` ; 403 `forbidden-directory` ;
   * 502 `opencode-injoignable`). `element` est l'identifiant de nœud de l'adresse : le serveur le valide, les vues le résolvent.
   */
  get: (params: { directory?: string | null; element?: string | null } = {}, signal?: AbortSignal) =>
    http.get<AgentMapResult>(`/api/agent-map${query({ directory: params.directory ?? null, element: params.element ?? null })}`, signal),
};

/** Phrase d'un refus de la carte : celle du code rendu par la route, sinon la phrase générale de T4t (jamais un message brut). */
export function agentMapError(err: unknown): string {
  return err instanceof ApiError ? phraseErreurCarte(err.code) : phraseErreurCarte("");
}
