// Propriétaire : L4b.
// Dérivation synchrone des faits d'activité (spécification §3.10, §5.7.3) : événement opencode → factsFromEvent (L4a) →
// ports.facts.append ; racine inconnue : sessions.ensure hors file, 5 s. Inscrite par le module facts.
// Squelette T0 : aucune dérivation.
import type { Cockpit11, EventDerivation } from "./contracts-11.ts";

/** Squelette : null (aucune dérivation) ; L4b rend la dérivation « facts ». */
export function activityDerivation(_c11: Cockpit11): EventDerivation | null {
  return null;
}
