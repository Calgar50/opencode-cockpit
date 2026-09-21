// Propriétaire : L18c.
// Routes de la Salle OMO (/api/omo/*, spécification §7.1 l.1084, §3.9 l.340-343, §4.14.1 l.806-811 ; plan 2 bis, fiche L18c,
// D-2b-29, D-2b-30). Groupe « omo », monté en DERNIER par le module `omoRoom` (STEP_ORDER.routes).
//
// Routes minces : elles ne décident rien. Chacune valide son identifiant (shared/ids.ts), lit le port au moment de l'appel
// (`c11.ports.omoRoom`) et traduit le CODE rendu en phrase (shared/omo-room-texts.ts). Toutes les gardes — mode Avancé,
// confirmation, interrupteurs, chemin du projet, projet préparé, pré-contrôle — sont dans le service (omo-room.ts).
//
// Ordre des gardes, de la plus extérieure à la plus intérieure :
// 1. authentification et garde anti-CSRF de http.ts (une requête mutante sans en-tête anti-CSRF est refusée AVANT d'arriver ici) ;
// 2. garde « salle coupée » de ce fichier (posée par T3b, inchangée) : tant que `SALLE_OUVERTE` est faux, TOUTE requête
//    /api/omo/*, quelle que soit sa méthode et même inconnue, reçoit 403 « salle-coupee » — aucun port n'est appelé, aucun
//    fichier n'est lu ni écrit, aucune salle n'existe ;
// 3. gardes du service : Avancé, `x-cockpit-confirm: 1`, `COCKPIT_OMO`/`COCKPIT_AUTONOMY`, chemin (400), projet préparé (409),
//    pré-contrôle (409, liste masquée).
//
// Aucune de ces routes ne touche l'instance principale : l'ouverture crée la racine sur le client de la salle, l'arrêt passe par
// le port `omoStop` (L23b), et une racine qui n'est pas une salle reçoit 404 sans le moindre appel (D-2b-30).
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Cockpit11 } from "./contracts-11.ts";
import { isAdvanced } from "./mode.ts";
import { OMO_ACTIVATION_REFUSAL_CODES } from "./omo-contracts.ts";
import type { OmoRoomService } from "./omo-room.ts";
import { CONFIRM_HEADER } from "./security.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { phrasePrecontrole, phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { OmoActivationRefusalCode, OmoPrecheckProjectResult, OmoPrecheckReason, OmoRoomCreateBody } from "./shared/omo-types.ts";

/** Corps de POST /api/omo/rooms : un seul champ, un chemin de projet. */
const ROOMS_BODY_MAX = 4 * 1024;

/** Codes de l'union de l'activation (T3a), distingués de ceux du pré-contrôle : chacun a sa phrase, dans son propre module. */
const CODES_ACTIVATION: ReadonlySet<string> = new Set<string>(OMO_ACTIVATION_REFUSAL_CODES);

/** Phrase d'un code rendu par le port : refus d'activation, ou raison de pré-contrôle. */
function phraseDuCode(code: OmoActivationRefusalCode | OmoPrecheckReason): string {
  return CODES_ACTIVATION.has(code) ? phraseRefusActivation(code as OmoActivationRefusalCode) : phrasePrecontrole(code as OmoPrecheckReason);
}

/** Corps d'un refus de la salle : le CODE du contrat et sa phrase, jamais un détail d'infrastructure. */
function refusSalleCoupee(c: Context): Response {
  return c.json({ error: "salle-coupee", message: phraseRefusActivation("salle-coupee") }, 403);
}

/** Refus rendu par le service : le code, sa phrase, et — pour un pré-contrôle refusé — la liste MASQUÉE des chemins trouvés. */
function refus(c: Context, status: 400 | 403 | 404 | 409, code: OmoActivationRefusalCode | OmoPrecheckReason, precheck: OmoPrecheckProjectResult | null = null): Response {
  return c.json({ error: code, message: phraseDuCode(code), ...(precheck === null ? {} : { precheck }) }, status);
}

/**
 * Service réel de la salle, ou `null` quand le port est resté NEUTRE (salle non configurée : aucun dossier de contrôle). Dans ce
 * cas les routes répondent « salle-coupee », comme la garde du groupe : le cockpit ne devine aucune salle.
 */
function serviceDeLaSalle(c11: Cockpit11): OmoRoomService | null {
  const port = c11.ports.omoRoom as Partial<OmoRoomService>;
  return typeof port.stop === "function" && typeof port.precheck === "function" ? (port as OmoRoomService) : null;
}

export function registerOmoRoutes(app: Hono, c11: Cockpit11): void {
  app.use("/api/omo/*", async (c, next) => {
    if (!c11.salleOuverte) return refusSalleCoupee(c);
    await next();
  });

  // onError : sans lui, l'exception 413 de bodyLimit remonterait au onError global de http.ts (500).
  const tropLong = (c: Context) => c.json({ error: "invalid", message: "Cette demande est trop longue." }, 413);

  // Ouverture d'une salle par projet (§4.14.1). L'ordre des refus est celui du service ; le corps est passé tel quel, c'est lui
  // qui le valide (jamais de lecture de disque avant le mode, la confirmation et les interrupteurs).
  app.post("/api/omo/rooms", bodyLimit({ maxSize: ROOMS_BODY_MAX, onError: tropLong }), async (c) => {
    const salle = serviceDeLaSalle(c11);
    if (salle === null) return refusSalleCoupee(c);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "invalid", message: "Corps de la demande invalide." }, 400);
    }
    const mode = isAdvanced(c11.settings) ? "avance" : "simple";
    const result = await salle.open(body as OmoRoomCreateBody, { mode, confirmed: c.req.header(CONFIRM_HEADER) === "1" });
    return result.ok ? c.json(result.room) : refus(c, result.status, result.code, result.precheck);
  });

  // Arrêt d'une salle (D-2b-30) : les DEUX modes, un arrêt ne fait que restreindre. Une racine qui n'est pas une salle reçoit
  // 404, sans aucun appel — l'instance principale garde son propre POST /api/conversations/:rootId/stop.
  app.post("/api/omo/rooms/:rootId/stop", async (c) => {
    const salle = serviceDeLaSalle(c11);
    if (salle === null) return refusSalleCoupee(c);
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return c.json({ error: "invalid", message: "Identifiant de conversation invalide." }, 400);
    const result = await salle.stop(rootId);
    if (result.ok) return c.json({ arretee: true });
    return refus(c, result.status, result.code);
  });

  // Statut de la salle (§4.12 l.784) : aucun secret, l'authentification de la salle n'est décrite que par sa présence. Lisible
  // dans les deux modes : c'est le Diagnostic, une lecture, et il n'ouvre rien.
  app.get("/api/omo/status", async (c) => {
    const salle = serviceDeLaSalle(c11);
    if (salle === null) return refusSalleCoupee(c);
    return c.json(await salle.status());
  });

  // Pré-contrôle d'un projet avant d'ouvrir une salle : même validation de chemin que l'ouverture, liste masquée des chemins
  // trouvés. Réservé au mode Avancé, comme l'entrée « Salle OMO » elle-même (§4.14.1 l.806).
  app.get("/api/omo/precheck", async (c) => {
    const salle = serviceDeLaSalle(c11);
    if (salle === null) return refusSalleCoupee(c);
    if (!isAdvanced(c11.settings)) return refus(c, 403, "mode-avance");
    const result = await salle.precheck(c.req.query("projet"));
    return result.ok ? c.json(result.resultat) : refus(c, result.status, result.code);
  });
}
