// Propriétaire : L37a.
// Routes du groupe « teams » (plan d'exécution it4 §4.1.5) : GET /api/teams, POST /api/teams/preview, PUT et DELETE
// /api/teams/:id, POST /api/teams/examples/:id/install (garde de rechargement posée sur la route, avant le gestionnaire), POST
// /api/teams/:id/estimate. Identifiants validés par TEAM_ID_RE ; 403 equipes-simple-fermees tant qu'eq.simpleOuvertes est faux.
//
// Routes MINCES : toute la logique est dans team-service.ts ; ici, la lecture du corps, les bornes et la mise en phrase des codes
// (team-texts.ts). Authentification et anti-CSRF : gardes globales de http.ts, avant ces routes.
//
// GARDE DE RECHARGEMENT (§3.11, plan §1.1) : AssistantService.install() n'a AUCUNE garde propre — celle des assistants est un
// middleware de http.ts posé sur leur seule route. L'installation d'un exemple installe des assistants : elle recharge opencode et
// couperait une réponse en cours. La garde est donc posée ICI, avant le gestionnaire, avec les mêmes dépendances et la même
// décision que la route des assistants (409 sessions-busy pendant une réponse, une étape d'équipe ou une demande facturée en vol ;
// dérogation du mode Avancé par x-cockpit-confirm: 1 ; vérification refaite après l'attente dans la file, `applying` posé jusqu'à
// la fin). Sa réponse (codes TeamGuardCode, message de la 1.1) est rendue TELLE QUELLE : T4t n'écrit aucune phrase pour eux.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AssistantServiceError } from "./assistants.ts";
import type { EqContext } from "./contracts-eq.ts";
import { forMethods, reloadGuard, type ReloadGuardDeps } from "./reload-guard.ts";
import { TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import { phraseErreur, TEXTES } from "./shared/team-texts.ts";
import type { TeamErrorBody } from "./shared/team-types.ts";
import type { TeamRefusal, TeamService } from "./team-service.ts";

/** Corps de PUT (titre, description, déroulé) et des routes d'action ; l'aperçu a sa propre borne (64 Kio). */
const CORPS_MAX = 64 * 1024;

/** Corps JSON de la requête ; vide = {} ; illisible = null (400 invalid). */
async function corps(c: Context): Promise<unknown> {
  const brut = await c.req.text();
  if (!brut.trim()) return {};
  try {
    return JSON.parse(brut);
  } catch {
    return null;
  }
}

function refus(c: Context, refusal: TeamRefusal): Response {
  const body: TeamErrorBody = {
    error: refusal.code,
    message: phraseErreur(refusal.code),
    ...(refusal.details === undefined ? {} : { details: refusal.details }),
    ...(refusal.problems === undefined ? {} : { problems: refusal.problems }),
  };
  return c.json(body, refusal.status);
}

export function registerTeamRoutes(app: Hono, eq: EqContext, service: TeamService): void {
  const { c11 } = eq;
  const guardDeps: ReloadGuardDeps = {
    settings: c11.settings,
    control: c11.control,
    occupancy: c11.occupancy,
    reachable: async () => (await c11.client.health()) !== null,
    log: c11.log,
  };
  // Posée AVANT le gestionnaire : une réponse en cours, une étape d'équipe ou une demande facturée en vol refusent l'installation.
  app.use("/api/teams/examples/:id/install", forMethods(["POST"], reloadGuard(guardDeps, { hold: c11.configQueue })));

  const tropLong = (c: Context) => c.json({ error: "invalid", message: TEXTES.partout.erreurs.invalid }, 413);
  const invalide = (c: Context) => refus(c, { ok: false, status: 400, code: "invalid" });

  app.get("/api/teams", async (c) => c.json(await service.list()));

  // Aperçu de l'éditeur : n'écrit rien, 64 Kio au plus (TEAM_TEXT_LIMITS.apercuOctets).
  app.post("/api/teams/preview", bodyLimit({ maxSize: TEAM_TEXT_LIMITS.apercuOctets, onError: tropLong }), async (c) => {
    const body = await corps(c);
    if (body === null) return invalide(c);
    const result = await service.preview(body);
    return result.ok ? c.json(result.response) : refus(c, result);
  });

  // Installation d'un exemple : la garde de rechargement ci-dessus a déjà répondu si opencode ne doit pas être rechargé.
  // Le refus métier de l'installation des assistants (AssistantService.install : catalogue d'IA non chargé, IA refusée par le
  // fournisseur, fiche refusée…) est rendu TEL QUEL, comme la route des assistants le rend (routes-assistants.ts) et comme la
  // garde de rechargement rend le sien : c'est la réponse de la 1.1, avec son code et sa phrase. Sans cela, l'erreur remontait
  // jusqu'au gestionnaire général et l'installation répondait 500 « Erreur interne du cockpit » au lieu du 409
  // catalogue-indisponible (défaut D3 du banc de la vague 4, arbitrage A13 ; systématique tant que le catalogue n'est pas lu).
  app.post("/api/teams/examples/:id/install", bodyLimit({ maxSize: CORPS_MAX, onError: tropLong }), async (c) => {
    try {
      const result = await service.installExample(c.req.param("id"));
      return result.ok ? c.json(result.response) : refus(c, result);
    } catch (err) {
      if (!(err instanceof AssistantServiceError)) throw err;
      return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
    }
  });

  app.post("/api/teams/:id/estimate", bodyLimit({ maxSize: CORPS_MAX, onError: tropLong }), async (c) => {
    const body = await corps(c);
    if (body === null) return invalide(c);
    const result = await service.estimate(c.req.param("id"), body);
    return result.ok ? c.json(result.response) : refus(c, result);
  });

  app.put("/api/teams/:id", bodyLimit({ maxSize: CORPS_MAX, onError: tropLong }), async (c) => {
    const body = await corps(c);
    if (body === null) return invalide(c);
    const result = await service.put(c.req.param("id"), body);
    return result.ok ? c.json(result.view) : refus(c, result);
  });

  app.delete("/api/teams/:id", (c) => {
    const result = service.remove(c.req.param("id"));
    return result.ok ? c.body(null, 204) : refus(c, result);
  });
}
