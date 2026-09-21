// Propriétaire : L22d.
// Plafonds de la Salle OMO (spécification §4.14.2, §4.8.2 ; règles pures : shared/omo-cap.ts de L22a ; plan 2 bis, fiche L22d) :
// port `omoCaps`, garde-fou budgétaire du message de l'utilisateur (crochet `beforeBilledSend` de la salle, après l'activation),
// dérivation et abonnement `usage.updated` de la salle. SQUELETTE posé par T3b (plan 2 bis §4.2) : port vide, AUCUN
// comportement, aucune inscription. `neutralOmoCaps` reste exporté et inchangé quand L22d arrivera : c'est le port des tests qui
// ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoCapsPort } from "./omo-contracts.ts";

export function neutralOmoCaps(_deps: Cockpit11Deps): OmoCapsPort {
  return {};
}

/** Squelette : aucune inscription tant que L22d n'a pas posé les plafonds (crochet, dérivation et abonnement de la salle). */
export const omoCapsModule: Cockpit11Module = {
  name: "omoCaps",
  install: () => undefined,
};
