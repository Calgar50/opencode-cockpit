// Propriétaire : L28d.
// Consignes gardées localement, lues par « Revoir » (U2, D-3d-30). Monté par wiring-3d.ts, hors du registre 1.1 ; GET seulement
// (toute autre méthode : 404 de /api/*), aucune écriture, aucune requête à opencode.
// - GET /api/revoir/:rootId/consignes/:callId → 200 RevoirConsigneResponse ; 404 {error, code: "consigne-absente"} ; 400 si rootId
//   échoue à SESSION_ID_RE ou callId à ID_RE.
// - GET /api/revoir/:rootId/consignes?enfant=<id> → 200 RevoirConsignesEnfantResponse (liste vide possible) ; 400 si rootId ou
//   enfant échoue à SESSION_ID_RE.
// Règle d'accès : la MÊME que « Revoir » (Q6, D-3d-09), lue par le port revoir.etat avant toute lecture de consigne — une racine
// de la Salle OMO dont la demande n'est pas terminée reste fermée en mode Simple, ici comme sur /api/revoir/:rootId. Le mode est
// relu à chaque requête (ctx.mode).
import type { Hono } from "hono";
import type { Salle3dRouteContext } from "./contracts-3d.ts";
import { CONSIGNES } from "./shared/consignes.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import { libelleConsigneAbsente, libelleRefus } from "./shared/revoir-texts.ts";
import type { ConsigneRefus, RevoirConsignesEnfantResponse } from "./shared/salle3d-types.ts";

const ABSENTE: ConsigneRefus = "consigne-absente";

const INVALIDE = { error: "invalid", message: "Identifiant invalide." } as const;

/** Refus d'accès à « Revoir » (403 ou 404), avec le code et la phrase de « Revoir » ; null quand l'accès est donné. */
function refusAcces(ctx: Salle3dRouteContext, rootId: string): { status: 403 | 404; body: { error: string; code: string; message: string } } | null {
  const etat = ctx.ports.revoir.etat(rootId, ctx.mode());
  if (etat.acces) return null;
  const code = etat.raison ?? "racine-inconnue";
  return { status: code === "racine-inconnue" ? 404 : 403, body: { error: code, code, message: libelleRefus(code) } };
}

export function installConsignesRoutes(app: Hono, ctx: Salle3dRouteContext): void {
  app.get("/api/revoir/:rootId/consignes/:callId", (c) => {
    const rootId = c.req.param("rootId");
    const callId = c.req.param("callId");
    if (!SESSION_ID_RE.test(rootId) || !ID_RE.test(callId)) return c.json(INVALIDE, 400);
    const refus = refusAcces(ctx, rootId);
    if (refus) return c.json(refus.body, refus.status);
    const consigne = ctx.ports.consignes.lire(rootId, callId);
    // Aucune copie gardée : la phrase dit pourquoi (version antérieure, cockpit arrêté, borne par conversation atteinte).
    return consigne ? c.json(consigne) : c.json({ error: ABSENTE, code: ABSENTE, message: libelleConsigneAbsente(CONSIGNES.parRacine) }, 404);
  });

  app.get("/api/revoir/:rootId/consignes", (c) => {
    const rootId = c.req.param("rootId");
    const enfant = c.req.query("enfant") ?? "";
    if (!SESSION_ID_RE.test(rootId) || !SESSION_ID_RE.test(enfant)) return c.json(INVALIDE, 400);
    const refus = refusAcces(ctx, rootId);
    if (refus) return c.json(refus.body, refus.status);
    return c.json<RevoirConsignesEnfantResponse>({ rootId, enfant, consignes: ctx.ports.consignes.parEnfant(rootId, enfant) });
  });
}
