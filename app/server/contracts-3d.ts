// Contrats serveur de la salle de contrôle 3D et de « Revoir » (itération 3, T3d-a ; plan d'exécution it3 §4.1.2, D-3d-08,
// D-3d-30). TYPES UNIQUEMENT. Les routes et la dérivation 3d sont montées par app-factory.ts (section [3d]) HORS du registre 1.1
// (wiring-11 : ni MODULE_ORDER, ni STEP_ORDER, ni RouteGroup) : les listes exactes de wiring-11.test.ts ne changent pas.
// Un changement de contrat est une demande écrite à l'intégrateur, traitée au train de vague avec la liste des consommateurs
// prévenus. Les ports rendent des CODES, jamais des phrases.
import type { Cockpit11 } from "./contracts-11.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import type {
  RevoirConsigneResponse,
  RevoirEtatResponse,
  RevoirRefus,
  RevoirResponse,
  TerritoiresResponse,
} from "./shared/salle3d-types.ts";

/** Dépendances des services 3d : sous-ensemble en lecture du cockpit 1.1 (moindre privilège). */
export type Salle3dDeps = Pick<Cockpit11, "db" | "sessions" | "ledger" | "projects" | "settings" | "client" | "log" | "ports">;

/** L31a. Zoom 1 : territoires par projet, compteurs, enceinte de la salle. Neutre : aucun projet, statut non vérifié. */
export interface TerritoiresPort {
  lire(mode: NeonMode, now: number): Promise<TerritoiresResponse>;
}

export type RevoirResult = { ok: true; value: RevoirResponse } | { ok: false; status: 403 | 404; code: RevoirRefus };

/**
 * L28b. « Revoir » (Q6, D-3d-09) : lecture seule en base, aucune requête à opencode, aucune écriture. Neutre : racine inconnue.
 * `etat` applique la même règle d'accès sans lire les faits ; la route des consignes (L28d) s'en sert aussi.
 */
export interface RevoirPort {
  lire(rootId: string, mode: NeonMode): RevoirResult;
  etat(rootId: string, mode: NeonMode): RevoirEtatResponse;
}

/**
 * L28d (U2, D-3d-30). Consignes gardées localement : synchrone, lecture en base seulement. `lire` : null si aucune copie pour ce
 * `callId` dans cette conversation ; `parEnfant` : consignes reçues par la session `enfant`, 20 au plus, par `at` croissant.
 * Neutre : null et [].
 */
export interface ConsignesPort {
  lire(rootId: string, callId: string): RevoirConsigneResponse | null;
  parEnfant(rootId: string, enfant: string): RevoirConsigneResponse[];
}

export interface Salle3dPorts {
  territoires: TerritoiresPort;
  revoir: RevoirPort;
  consignes: ConsignesPort;
}

/**
 * Contexte remis aux installateurs de routes 3d (routes-territoires.ts, routes-revoir.ts, routes-consignes.ts). Les ports sont lus
 * au moment de la requête ; `mode` relit le réglage à chaque appel (mode.ts, isAdvanced) ; `now` : horloge injectable (tests).
 */
export interface Salle3dRouteContext {
  ports: Salle3dPorts;
  mode(): NeonMode;
  now(): number;
}
