// Propriétaire : L1c.
// POST /api/conversations/:rootId/stop → StopResult (plan d'exécution §4.5, spécification §3.9) : « Arrêter » arrête toute la
// conversation, son travail délégué, ses étapes et ses contrôles (ports.stopTree, lu au moment de l'appel). 400 identifiant invalide
// (shared/ids.ts), 401 et 403 CSRF (gardes globales de createApp), 404 racine inconnue (ni suivie, ni racine, ni instance
// principale : le navigateur se replie sur l'arrêt 1.0 par le proxy). Groupe « conversations », monté par le module stopTree.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

/** `isStoppableRoot` : même prédicat que le crochet d'arrêt du proxy (stoppableRoot de stop-tree.ts). */
export function registerConversationRoutes(app: Hono, c11: Cockpit11, isStoppableRoot: (rootId: string) => boolean): void {
  const notFound = { error: "not-found", message: "Conversation introuvable." } as const;
  app.post("/api/conversations/:rootId/stop", async (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return c.json({ error: "invalid", message: "Identifiant de conversation invalide." }, 400);
    if (!isStoppableRoot(rootId)) return c.json(notFound, 404);
    let result: StopResult;
    try {
      result = await c11.ports.stopTree.run(rootId, "vous");
    } catch (err) {
      // Racine disparue entre la vérification et l'arrêt (StopRootUnknownError) : 404 ; toute autre erreur remonte.
      if (!isStoppableRoot(rootId)) return c.json(notFound, 404);
      throw err;
    }
    return c.json(result);
  });
}
