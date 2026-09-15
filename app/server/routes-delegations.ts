// Propriétaire : L1d.
// GET /api/conversations/:rootId/delegations/:permissionId → DelegationDetailsView (plan d'exécution §4.5) : 400, 404.
// Groupe « delegations », monté par le module taskGuard. Identifiants validés par shared/ids.ts.
// Squelette T0 : aucune route.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";

export function registerDelegationRoutes(_app: Hono, _c11: Cockpit11): void {
  // Squelette : L1d.
}
