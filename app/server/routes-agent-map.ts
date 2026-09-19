// Propriétaire : L39b.
// Route du groupe « agent-map » (plan d'exécution it4 §4.1.5) : GET /api/agent-map?directory= (400 ; 403 forbidden-directory),
// nœuds et détails du mode Avancé retirés en Simple ; l'onglet « Salle OMO » (?instance=omo) est livré par L39o à la grande fusion.
// Squelette T4 : aucune route (404, comme avant l'itération 4).
import type { Hono } from "hono";
import type { EqContext } from "./contracts-eq.ts";

export function registerAgentMapRoutes(_app: Hono, _eq: EqContext): void {
  // Squelette : L39b.
}
