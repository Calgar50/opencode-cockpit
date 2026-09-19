// Propriétaire : L37b.
// Routes du groupe « team-runs » montées par le runner (plan d'exécution it4 §4.1.5) : POST /api/teams/:id/run (tout refus : zéro
// requête à opencode, A4), GET /api/team-runs?rootId= et ?sessionId=, GET /api/team-runs/:runId, POST …/continue. Les routes
// d'incident (stop, estimate, relancer, fermer, ajouter-resultats) sont montées par le module teamGuards (L37c).
// Squelette T4 : aucune route (404, comme avant l'itération 4).
import type { Hono } from "hono";
import type { EqContext } from "./contracts-eq.ts";

export function registerTeamRunRoutes(_app: Hono, _eq: EqContext): void {
  // Squelette : L37b.
}
