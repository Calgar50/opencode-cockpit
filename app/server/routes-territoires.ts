// Propriétaire : L31a.
// GET /api/salle-controle/territoires → TerritoiresResponse (zoom 1, D-3d-13). Lecture seule : aucune écriture en base, aucun
// appel à opencode depuis la route (le port lit l'état réel, et n'interroge l'instance principale que pour ses propres dossiers,
// P11). Aucune autre méthode : le 404 de /api/* les prend. Aucun paramètre : la vue est entière (web/lib/api-salle3d.ts).
// Monté par wiring-3d.ts, hors du registre 1.1. Authentification : garde globale de http.ts, avant ces routes. Mode relu à chaque
// requête comme le reste du serveur (mode.ts, par ctx.mode()).
import type { Hono } from "hono";
import type { Salle3dRouteContext } from "./contracts-3d.ts";

export function installTerritoiresRoutes(app: Hono, ctx: Salle3dRouteContext): void {
  app.get("/api/salle-controle/territoires", async (c) => c.json(await ctx.ports.territoires.lire(ctx.mode(), ctx.now())));
}
