// Propriétaire : L39b.
// Client des routes de la CARTE DES ASSISTANTS (plan d'exécution it4 §4.1.5, constat 16 : le client de la carte n'est pas dans
// api-teams.ts, dont le test de T4 exclut /api/agent-map). Une fonction par route de la carte, typée par shared/agent-map.ts
// (L39a). Mêmes en-têtes, erreurs (ApiError) et CSRF que web/lib/api.ts : l'aide `http` est réutilisée telle quelle.
// La carte ne fait que LIRE : aucune fonction d'écriture n'a sa place ici.
import type { AgentMapResult } from "../../server/shared/agent-map.ts";
import { phraseErreurCarte } from "../../server/shared/agent-map-texts.ts";
import { ApiError, http, query } from "./api.ts";
// <l39o:salle-omo>
import type { AgentMapSalleResult } from "../../server/shared/agent-map-omo.ts";

/**
 * SEUL appel de GET /api/agent-map (une route, un appel : contrôle d'agent-map-service.test.ts) : la carte de l'instance
 * principale et l'onglet « Salle OMO » (L39o, `instance` « omo ») le partagent. Un paramètre absent ou null n'est pas envoyé.
 */
function lireLaCarte<T>(params: { instance?: "omo" | null; directory?: string | null; element?: string | null }, signal?: AbortSignal) {
  return http.get<T>(`/api/agent-map${query({ instance: params.instance ?? null, directory: params.directory ?? null, element: params.element ?? null })}`, signal);
}
// </l39o:salle-omo>

export const agentMapApi = {
  /**
   * GET /api/agent-map?directory=&element= → nœuds, arêtes et notes de la carte (400 `invalid` ; 403 `forbidden-directory` ;
   * 502 `opencode-injoignable`). `element` est l'identifiant de nœud de l'adresse : le serveur le valide, les vues le résolvent.
   */
  // <l39o:salle-omo>
  // L39o : l'appel passe par lireLaCarte, partagé avec l'onglet « Salle OMO » ; aucun `instance` envoyé ici.
  get: (params: { directory?: string | null; element?: string | null } = {}, signal?: AbortSignal) =>
    lireLaCarte<AgentMapResult>({ directory: params.directory ?? null, element: params.element ?? null }, signal),
  /**
   * GET /api/agent-map?instance=omo&directory= → agents de la Salle OMO, rôles lus par clé (L39o). 403 `mode-avance` en mode
   * Simple ; 409 `salle-coupee` tant que la salle est coupée ; 403 `forbidden-directory` ; 502 `opencode-injoignable`.
   */
  salle: (params: { directory?: string | null } = {}, signal?: AbortSignal) =>
    lireLaCarte<AgentMapSalleResult>({ instance: "omo", directory: params.directory ?? null }, signal),
  // </l39o:salle-omo>
};

/** Phrase d'un refus de la carte : celle du code rendu par la route, sinon la phrase générale de T4t (jamais un message brut). */
export function agentMapError(err: unknown): string {
  return err instanceof ApiError ? phraseErreurCarte(err.code) : phraseErreurCarte("");
}

// <l39o:salle-omo>
/** Refus « salle coupée » de l'onglet « Salle OMO » : la vue montre alors l'état de la salle, avec la phrase de la salle. */
export function estSalleCoupee(err: unknown): boolean {
  return err instanceof ApiError && err.code === "salle-coupee";
}
// </l39o:salle-omo>
