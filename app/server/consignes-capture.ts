// Propriétaire : L28d.
// Capture des consignes pour « Revoir » (U2, D-3d-30) : dérivation synchrone du processeur principal (aucune attente réseau, règle
// de L4b), inscrite par la section [3d] d'app-factory.ts hors du registre 1.1 et retirée par close(). Source : partie `task` à
// l'état `running` (metadata.sessionId, state.input.prompt) ; racine par sessions.rootOf ; jamais journalisée ni publiée sur le hub.
// Squelette T3d-a : dérivation neutre, rien n'est lu ni écrit.
import type { Salle3dDeps } from "./contracts-3d.ts";
import type { EventDerivation } from "./contracts-11.ts";

/** Nom de la dérivation, hors de STEP_ORDER (wiring-11). */
export const CONSIGNES_DERIVATION = "consignes-3d";

export function createConsignesDerivation(_deps: Salle3dDeps): EventDerivation {
  return { name: CONSIGNES_DERIVATION, onEvent() {} };
}
