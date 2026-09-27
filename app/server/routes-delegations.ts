// Propriétaire : L1d.
// GET /api/conversations/:rootId/delegations/:permissionId → DelegationDetailsView (plan d'exécution §4.5) : carte détaillée d'une
// délégation en attente, pour le mode Avancé (cible, IA, estimation, droits comparés, compteurs, refus que la garde appliquerait).
// 400 identifiant invalide (shared/ids.ts) ; 404 racine inconnue, racine de la Salle OMO (P11 : rien n'est demandé à l'opencode
// de l'instance principale pour elle), demande absente, autre permission ou autre conversation ; 503
// opencode injoignable (rien n'est deviné). Groupe « delegations », monté par le module taskGuard. Route mince : la logique est dans
// le port (c11.ports.taskGuard, lu à chaque requête) ; phrases : shared/delegation-texts.ts. Lecture seule : aucune réponse n'est
// envoyée à opencode. Authentification : garde globale de http.ts, avant ces routes.
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { DelegationDetailsView } from "./shared/activity-types.ts";
import { erreurDetails, verificationImpossible } from "./shared/delegation-texts.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
// <gf5:d11>
import { ListeBloqueeError } from "./pending-table.ts";
import { phraseListeBloquee } from "./shared/attentes-texts.ts";
// </gf5:d11>

export function registerDelegationRoutes(app: Hono, c11: Cockpit11): void {
  app.get("/api/conversations/:rootId/delegations/:permissionId", async (c) => {
    const rootId = c.req.param("rootId");
    const permissionId = c.req.param("permissionId");
    if (!SESSION_ID_RE.test(rootId) || !ID_RE.test(permissionId)) return c.json({ error: "invalid", message: erreurDetails("identifiant") }, 400);
    let view: DelegationDetailsView | null;
    try {
      view = await c11.ports.taskGuard.details(rootId, permissionId);
    } catch (err) {
      // <gf5:d11>
      // Liste bloquée par une demande en attente (D11) : opencode répond, la phrase le dit (jamais « opencode ne répond pas »).
      if (err instanceof ListeBloqueeError) return c.json({ error: "liste-bloquee", message: phraseListeBloquee(err.outil), outil: err.outil }, 503);
      // </gf5:d11>
      c11.log.warn("détails d'une délégation illisibles : opencode ne répond pas", { rootId, permissionId, error: errorMessage(err) });
      return c.json({ error: "verification-impossible", message: verificationImpossible() }, 503);
    }
    return view ? c.json(view) : c.json({ error: "not-found", message: erreurDetails("inconnue") }, 404);
  });
}
