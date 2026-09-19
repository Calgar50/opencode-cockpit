// Propriétaire : L31a.
// GET /api/salle-controle/territoires → TerritoiresResponse (zoom 1, D-3d-13). Lecture seule ; aucune autre méthode (404 de /api/*).
// Monté par wiring-3d.ts, hors du registre 1.1. Authentification : garde globale de http.ts, avant ces routes. Squelette T3d-a :
// réponse du port en vigueur (neutre : aucun projet).
import type { Hono } from "hono";
import type { Salle3dRouteContext } from "./contracts-3d.ts";

export function installTerritoiresRoutes(app: Hono, ctx: Salle3dRouteContext): void {
  app.get("/api/salle-controle/territoires", async (c) => c.json(await ctx.ports.territoires.lire(ctx.mode(), ctx.now())));
}
