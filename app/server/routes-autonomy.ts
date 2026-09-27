// Propriétaire : L6a puis L10d.
// GET /api/conversations/:rootId/autonomie → ConversationAutonomyView (400, 404) ; PUT → ConversationAutonomyView (400 ;
// 403 autonomie-coupee pour modifications et autonome ; 409 autonomie-indisponible {raison} ; 428 confirmation-requise)
// (plan d'exécution §4.5). Groupe « autonomy », monté par le module conversationAutonomy. Routes minces : toute la logique est
// dans le port (c11.ports.conversationAutonomy, lu à chaque requête) ; phrases : shared/autonomy-choice-texts.ts.
// Salle OMO (L22c) : l'aiguillage `salle` (conversation-autonomy.ts) passe AVANT le port de l'instance principale. Une racine de la
// salle reçoit sa vue (OmoAutonomyView) ou un refus de la salle (409 « autonomie-indisponible » et phrase de omo-room-texts.ts,
// 403 « mode-avance » en Simple) ; `{choix: "omo"}` hors de la salle reçoit 409 « racine-hors-salle », jamais 400.
// Authentification et anti-CSRF (PUT) : gardes globales de http.ts, avant ces routes.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AutonomyPutResult, Cockpit11 } from "./contracts-11.ts";
import type { SalleAutonomy, SalleAutonomyResult } from "./conversation-autonomy.ts";
import { CONFIRM_HEADER } from "./security.ts";
import { raisonIndisponible, TEXTES } from "./shared/autonomy-choice-texts.ts";
import type { AutonomyErrorBody, AutonomyPutBody } from "./shared/autonomy-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

/** Corps de PUT : un choix et six plafonds au plus. */
const PUT_BODY_MAX = 4 * 1024;

type Refusal = Extract<AutonomyPutResult, { ok: false }>;

/** Corps d'erreur : `message` est la phrase du module de textes, `raison` le code quand il y en a un. */
function errorBody(result: Refusal): AutonomyErrorBody | { error: "invalid" | "not-found"; message: string } {
  const { erreurs } = TEXTES.partout;
  switch (result.error) {
    case "invalid":
      return { error: "invalid", message: erreurs.requete };
    case "not-found":
      return { error: "not-found", message: erreurs.inconnue };
    case "confirmation-requise":
      return { error: result.error, message: erreurs.confirmation };
    default: {
      // 403 autonomie-coupee, 409 autonomie-indisponible : raison null = un autre choix est arrivé pendant la vérification.
      const message = result.raison === null ? erreurs.remplace : raisonIndisponible(result.raison);
      return { error: result.error, message, ...(result.raison === null ? {} : { raison: result.raison }) };
    }
  }
}

function invalidId(c: Context): Response {
  return c.json({ error: "invalid", message: TEXTES.partout.erreurs.identifiant }, 400);
}

/** Réponse de l'aiguillage de la salle : sa vue, ou son refus tel qu'il l'a formé. */
function salleResponse(c: Context, result: SalleAutonomyResult): Response {
  return result.ok ? c.json(result.view) : c.json(result.body, result.status);
}

/** `salle` absent (montages de test d'avant la Salle OMO) : aucune racine n'est aiguillée, comportement de L6a. */
export function registerAutonomyRoutes(app: Hono, c11: Cockpit11, salle?: SalleAutonomy): void {
  app.get("/api/conversations/:rootId/autonomie", async (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return invalidId(c);
    const deLaSalle = salle ? await salle.get(rootId) : null;
    if (deLaSalle !== null) return salleResponse(c, deLaSalle);
    const view = await c11.ports.conversationAutonomy.get(rootId);
    return view ? c.json(view) : c.json(errorBody({ ok: false, status: 404, error: "not-found", raison: null }), 404);
  });

  // onError : sans lui, l'exception 413 de bodyLimit remonterait au onError global de http.ts (500).
  const tooLong = (c: Context) => c.json({ error: "invalid", message: TEXTES.partout.erreurs.tropLong }, 413);
  app.put("/api/conversations/:rootId/autonomie", bodyLimit({ maxSize: PUT_BODY_MAX, onError: tooLong }), async (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return invalidId(c);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json(errorBody({ ok: false, status: 400, error: "invalid", raison: null }), 400);
    }
    const confirmed = c.req.header(CONFIRM_HEADER) === "1";
    // Salle OMO d'abord : « omo » sur toute racine, et tout choix sur une racine de la salle (confirmation à chaque demande).
    const deLaSalle = salle ? await salle.put(rootId, body, { confirmed }) : null;
    if (deLaSalle !== null) return salleResponse(c, deLaSalle);
    // Corps passé tel quel : le port le valide (choix, clés et bornes des plafonds) avant toute lecture.
    const result = await c11.ports.conversationAutonomy.put(rootId, body as AutonomyPutBody, { confirmed });
    return result.ok ? c.json(result.view) : c.json(errorBody(result), result.status);
  });
}
