// Propriétaire : L28d.
// Consignes gardées localement, lues par « Revoir » (U2, D-3d-30). Monté par wiring-3d.ts, hors du registre 1.1 ; GET seulement
// (toute autre méthode : 404 de /api/*), aucune écriture, aucune requête à opencode.
// - GET /api/revoir/:rootId/consignes/:callId → 200 RevoirConsigneResponse ; 404 {error, code: "consigne-absente"} ; 400 si rootId
//   échoue à SESSION_ID_RE ou callId à ID_RE.
// - GET /api/revoir/:rootId/consignes?enfant=<id> → 200 RevoirConsignesEnfantResponse (liste vide possible) ; 400 si rootId ou
//   enfant échoue à SESSION_ID_RE.
// L28d y ajoute la règle d'accès de « Revoir » (ctx.ports.revoir.etat) avant toute lecture. Squelette T3d-a : réponses du port
// en vigueur (neutre : aucune consigne gardée).
import type { Hono } from "hono";
import type { Salle3dRouteContext } from "./contracts-3d.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import type { ConsigneRefus, RevoirConsignesEnfantResponse } from "./shared/salle3d-types.ts";

const ABSENTE: ConsigneRefus = "consigne-absente";

export function installConsignesRoutes(app: Hono, ctx: Salle3dRouteContext): void {
  app.get("/api/revoir/:rootId/consignes/:callId", (c) => {
    const rootId = c.req.param("rootId");
    const callId = c.req.param("callId");
    if (!SESSION_ID_RE.test(rootId) || !ID_RE.test(callId)) return c.json({ error: "invalid", message: "Identifiant invalide." }, 400);
    const consigne = ctx.ports.consignes.lire(rootId, callId);
    return consigne ? c.json(consigne) : c.json({ error: ABSENTE, code: ABSENTE }, 404);
  });

  app.get("/api/revoir/:rootId/consignes", (c) => {
    const rootId = c.req.param("rootId");
    const enfant = c.req.query("enfant") ?? "";
    if (!SESSION_ID_RE.test(rootId) || !SESSION_ID_RE.test(enfant)) return c.json({ error: "invalid", message: "Identifiant invalide." }, 400);
    return c.json<RevoirConsignesEnfantResponse>({ rootId, enfant, consignes: ctx.ports.consignes.parEnfant(rootId, enfant) });
  });
}
