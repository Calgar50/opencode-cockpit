// Propriétaire : L4b.
// GET /api/conversations/:rootId/activity → ActivityResponse ; GET /api/conversations/:rootId/facts?since= → FactsResponse
// (plan d'exécution §4.5) : 400. Groupe « activity », monté par le module facts. Identifiants validés par shared/ids.ts.
// Squelette T0 : aucune route.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";

export function registerActivityRoutes(_app: Hono, _c11: Cockpit11): void {
  // Squelette : L4b.
}
