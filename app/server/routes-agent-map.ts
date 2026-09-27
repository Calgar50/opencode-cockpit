// Propriétaire : L39b.
// Route du groupe « agent-map » (plan d'exécution it4 §4.1.5) : GET /api/agent-map?directory=&element= → AgentMapResult de
// shared/agent-map.ts (L39a), nœuds et détails du mode Avancé retirés en Simple par le service ; 400 `invalid` (élément mal
// formé), 403 `forbidden-directory` (dossier hors du workspace monté), 502 `opencode-injoignable` (agents illisibles).
// <l39o:salle-omo>
// Onglet « Salle OMO » (?instance=omo) : livré par L39o à la grande fusion (F2 · V2), dans le bloc balisé de la route ci-dessous.
// </l39o:salle-omo>
// Route MINCE et en LECTURE SEULE : toute la composition est dans le service (agent-map-service.ts) ; aucune écriture, aucun
// corps de requête, aucun en-tête de confirmation. Phrases : shared/agent-map-texts.ts (T4t), jamais écrites ici.
// Authentification et anti-CSRF : gardes globales de http.ts, avant cette route.
import type { Hono } from "hono";
import type { AgentMapService } from "./agent-map-service.ts";
import { phraseErreurCarte } from "./shared/agent-map-texts.ts";
// <l39o:salle-omo>
import { TEXTES as TEXTES_SALLE } from "./shared/omo-room-texts.ts";
// </l39o:salle-omo>

export function registerAgentMapRoutes(app: Hono, service: AgentMapService): void {
  app.get("/api/agent-map", async (c) => {
    // Paramètre absent ou vide : instance par défaut d'opencode (directory) et élément par défaut de la vue (element).
    const directory = c.req.query("directory");
    const element = c.req.query("element");
    // <l39o:salle-omo>
    // ?instance=omo (L39o ; spéc. §5.2 l.892) : agents de la Salle OMO → AgentMapSalleResult (shared/agent-map-omo.ts) ; 403
    // `mode-avance` en mode Simple, 409 `salle-coupee` tant que la salle est coupée, 403 `forbidden-directory`, 502. Absent, vide
    // ou « principale » : la carte de l'instance principale, inchangée. Toute autre valeur : 400 `invalid`, jamais lue comme la
    // principale. `element` n'a pas de sens pour la salle : il n'y est pas lu.
    const instance = c.req.query("instance");
    if (instance === "omo") {
      const salle = await service.buildSalle({ directory: directory === undefined || directory === "" ? null : directory });
      if (salle.ok) return c.json(salle.result);
      // « Salle coupée » : phrase de la salle (etats.coupee d'omo-room-texts.ts), jamais écrite dans les textes de la carte.
      const message = salle.code === "salle-coupee" ? TEXTES_SALLE.avance.etats.coupee : phraseErreurCarte(salle.code);
      return c.json({ error: salle.code, message }, salle.status);
    }
    if (instance !== undefined && instance !== "" && instance !== "principale") {
      return c.json({ error: "invalid", message: phraseErreurCarte("invalid") }, 400);
    }
    // </l39o:salle-omo>
    const outcome = await service.build({
      directory: directory === undefined || directory === "" ? null : directory,
      element: element === undefined || element === "" ? null : element,
    });
    if (outcome.ok) return c.json(outcome.result);
    return c.json({ error: outcome.code, message: phraseErreurCarte(outcome.code) }, outcome.status);
  });
}
