// Propriétaire : L1c.
// POST /api/conversations/:rootId/stop → StopResult (plan d'exécution §4.5) : 400 identifiant invalide (shared/ids.ts),
// 403 CSRF (garde globale), 404 racine inconnue. Groupe « conversations », monté par le module stopTree.
// Squelette T0 : aucune route.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";

export function registerConversationRoutes(_app: Hono, _c11: Cockpit11): void {
  // Squelette : L1c.
}
