// Propriétaire : L28b.
// Route dédiée de « Revoir » (D-3d-08, Q7 (a)) : /api/conversations/:rootId/facts n'est pas touchée. Montée par wiring-3d.ts, hors
// du registre 1.1 ; GET seulement (toute autre méthode : 404 de /api/*), aucune écriture, aucune requête à opencode.
// - GET /api/revoir/:rootId → 200 RevoirResponse ; 403 ou 404 {error, code, message} (code : RevoirRefus ; message : phrase de
//   revoir-texts.partout.refus, jamais une cause inventée) ; 400 identifiant invalide.
// - GET /api/revoir/:rootId?etat=1 → 200 RevoirEtatResponse (accès seulement, sans les faits).
// Mode lu à chaque requête (mode.ts). Le port fait la décision et la lecture (revoir-service.ts) : cette route ne lit pas la base.
import type { Hono } from "hono";
import type { Salle3dRouteContext } from "./contracts-3d.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { libelleRefus } from "./shared/revoir-texts.ts";

export function installRevoirRoutes(app: Hono, ctx: Salle3dRouteContext): void {
  app.get("/api/revoir/:rootId", (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return c.json({ error: "invalid", message: "Identifiant de conversation invalide." }, 400);
    if (c.req.query("etat") === "1") return c.json(ctx.ports.revoir.etat(rootId, ctx.mode()));
    const result = ctx.ports.revoir.lire(rootId, ctx.mode());
    return result.ok ? c.json(result.value) : c.json({ error: result.code, code: result.code, message: libelleRefus(result.code) }, result.status);
  });
}
