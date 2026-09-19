// Câblage de la salle de contrôle 3D et de « Revoir » (itération 3, T3d-a ; plan d'exécution it3 §4.1.2, §2.3). Appelé par la
// section [3d] d'app-factory.ts, toujours, HORS du registre 1.1 : aucune inscription dans wiring-11 (MODULE_ORDER, STEP_ORDER,
// RouteGroup), donc wiring.routes et wiring.derivations gardent leurs listes exactes. Aucun paquet n'édite ce fichier : l'intégrateur
// seul, au train de vague. Les paquets remplissent les services et les routes dont ils sont propriétaires (squelettes T3d-a).
import type { Hono } from "hono";
import { createConsignesDerivation } from "./consignes-capture.ts";
import { createConsignesPort } from "./consignes-store.ts";
import type { Salle3dPorts, Salle3dRouteContext } from "./contracts-3d.ts";
import type { Cockpit11, EventDerivation } from "./contracts-11.ts";
import { isAdvanced } from "./mode.ts";
import { createRevoirPort } from "./revoir-service.ts";
import { installConsignesRoutes } from "./routes-consignes.ts";
import { installRevoirRoutes } from "./routes-revoir.ts";
import { installTerritoiresRoutes } from "./routes-territoires.ts";
import { createTerritoiresPort } from "./territoires-service.ts";

export interface BuildSalle3dRoutesOptions {
  /** Surcharges de ports (tests), posées après les ports réels : elles l'emportent. */
  ports?: Partial<Salle3dPorts>;
  /** Horloge des routes (tests) ; absente : Date.now. */
  now?: () => number;
}

/** Routes 3d (territoires, « Revoir », consignes gardées), dans cet ordre ; montées juste avant le 404 de /api/*. */
export function buildSalle3dRoutes(c11: Cockpit11, options: BuildSalle3dRoutesOptions = {}): Array<(app: Hono) => void> {
  const ports: Salle3dPorts = {
    territoires: createTerritoiresPort(c11),
    revoir: createRevoirPort(c11),
    consignes: createConsignesPort(c11),
  };
  for (const [name, port] of Object.entries(options.ports ?? {})) {
    if (port !== undefined) (ports as unknown as Record<string, unknown>)[name] = port;
  }
  const ctx: Salle3dRouteContext = {
    ports,
    // Même lecture du mode que le reste du serveur (mode.ts), à chaque requête.
    mode: () => (isAdvanced(c11.settings) ? "avance" : "simple"),
    now: options.now ?? Date.now,
  };
  return [(app) => installTerritoiresRoutes(app, ctx), (app) => installRevoirRoutes(app, ctx), (app) => installConsignesRoutes(app, ctx)];
}

/** Dérivations 3d du processeur principal (synchrones, avant sa file) : capture des consignes (U2, D-3d-30). */
export function buildSalle3dDerivations(c11: Cockpit11): EventDerivation[] {
  return [createConsignesDerivation(c11)];
}
