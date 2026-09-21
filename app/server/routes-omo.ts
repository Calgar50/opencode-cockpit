// Propriétaire : L18c.
// Routes de la Salle OMO (/api/omo/*, spécification §7.1 l.1084, §3.9, §3.10 ; plan 2 bis, fiche L18c) : ouverture d'une salle,
// arrêt, statut. Groupe « omo », monté en DERNIER par le module `omoRoom` (STEP_ORDER.routes).
// SQUELETTE posé par T3b (plan 2 bis §4.2, §2.7) : ce fichier ne porte QUE la garde « salle coupée », tenue par le code.
// - Tant que `SALLE_OUVERTE` est faux (le dépôt), TOUTE requête /api/omo/*, quelle que soit sa méthode et même inconnue, reçoit
//   403 « salle-coupee » : aucun port n'est appelé, aucun fichier n'est lu ni écrit, aucune salle n'existe.
// - L'authentification et la garde anti-CSRF de http.ts passent AVANT (une requête sans en-tête anti-CSRF est refusée avant
//   d'arriver ici) : la garde ci-dessous ne relâche donc rien.
// - Les routes elles-mêmes (POST /api/omo/rooms, POST /api/omo/rooms/:rootId/stop, GET /api/omo/status) sont posées par L18c
//   SOUS cette garde, qui reste la première inscrite ; routes minces, toute la logique dans les ports (c11.ports.omoRoom,
//   c11.ports.omoStop), phrases dans shared/omo-room-texts.ts.
import type { Context, Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";

/** Corps d'un refus de la salle : le CODE du contrat et sa phrase, jamais un détail d'infrastructure. */
function refusSalleCoupee(c: Context): Response {
  return c.json({ error: "salle-coupee", message: phraseRefusActivation("salle-coupee") }, 403);
}

export function registerOmoRoutes(app: Hono, c11: Cockpit11): void {
  app.use("/api/omo/*", async (c, next) => {
    if (!c11.salleOuverte) return refusSalleCoupee(c);
    await next();
  });
}
