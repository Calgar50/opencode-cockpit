// Propriétaire : L6a puis L10d.
// GET /api/conversations/:rootId/autonomie → ConversationAutonomyView (400, 404) ; PUT → ConversationAutonomyView (400 ;
// 403 autonomie-coupee pour modifications et autonome ; 409 autonomie-indisponible {raison} ; 428 confirmation-requise)
// (plan d'exécution §4.5). Groupe « autonomy », monté par le module conversationAutonomy. Phrases : shared/*-texts.ts.
// Squelette T0 : aucune route.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";

export function registerAutonomyRoutes(_app: Hono, _c11: Cockpit11): void {
  // Squelette : L6a, puis L10d.
}
