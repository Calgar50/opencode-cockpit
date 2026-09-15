// Propriétaire : L6b.
// POST /api/plans {directory} → PlanCreateResponse (403 forbidden-directory, 409 budget-guard, 502 plancher-non-verifie ; permis
// avec COCKPIT_AUTONOMY=off) ; POST /api/plans/:id/execution {choix, plafonds?} → PlanExecutionResponse (404 ; 403
// autonomie-coupee ; 409 ; 428 sans x-cockpit-confirm pour un choix automatique, avant toute création de racine ; 502)
// (plan d'exécution §4.5). Groupe « plans », monté par le module plans.
// Squelette T0 : aucune route.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";

export function registerPlanRoutes(_app: Hono, _c11: Cockpit11): void {
  // Squelette : L6b.
}
