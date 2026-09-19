// Propriétaire : L37a.
// Routes du groupe « teams » (plan d'exécution it4 §4.1.5) : GET /api/teams, POST /api/teams/preview, PUT et DELETE
// /api/teams/:id, POST /api/teams/examples/:id/install (garde de rechargement posée sur la route, avant le gestionnaire), POST
// /api/teams/:id/estimate. Identifiants validés par TEAM_ID_RE ; 403 equipes-simple-fermees tant qu'eq.simpleOuvertes est faux.
// Squelette T4 : aucune route (404, comme avant l'itération 4).
import type { Hono } from "hono";
import type { EqContext } from "./contracts-eq.ts";

export function registerTeamRoutes(_app: Hono, _eq: EqContext): void {
  // Squelette : L37a.
}
