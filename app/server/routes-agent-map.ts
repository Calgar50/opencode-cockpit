// Propriétaire : L39b.
// Route du groupe « agent-map » (plan d'exécution it4 §4.1.5) : GET /api/agent-map?directory=&element= → AgentMapResult de
// shared/agent-map.ts (L39a), nœuds et détails du mode Avancé retirés en Simple par le service ; 400 `invalid` (élément mal
// formé), 403 `forbidden-directory` (dossier hors du workspace monté), 502 `opencode-injoignable` (agents illisibles).
// L'onglet « Salle OMO » (?instance=omo) est livré par L39o à la grande fusion : rien ici ne le devance.
// Route MINCE et en LECTURE SEULE : toute la composition est dans le service (agent-map-service.ts) ; aucune écriture, aucun
// corps de requête, aucun en-tête de confirmation. Phrases : shared/agent-map-texts.ts (T4t), jamais écrites ici.
// Authentification et anti-CSRF : gardes globales de http.ts, avant cette route.
import type { Hono } from "hono";
import type { AgentMapService } from "./agent-map-service.ts";
import { phraseErreurCarte } from "./shared/agent-map-texts.ts";

export function registerAgentMapRoutes(app: Hono, service: AgentMapService): void {
  app.get("/api/agent-map", async (c) => {
    // Paramètre absent ou vide : instance par défaut d'opencode (directory) et élément par défaut de la vue (element).
    const directory = c.req.query("directory");
    const element = c.req.query("element");
    const outcome = await service.build({
      directory: directory === undefined || directory === "" ? null : directory,
      element: element === undefined || element === "" ? null : element,
    });
    if (outcome.ok) return c.json(outcome.result);
    return c.json({ error: outcome.code, message: phraseErreurCarte(outcome.code) }, outcome.status);
  });
}
