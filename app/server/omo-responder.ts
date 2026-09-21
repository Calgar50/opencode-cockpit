// Propriétaire : L22d.
// Répondeur de la Salle OMO (spécification §4.14.4 ; plan 2 bis, fiche L22d) : port `omoResponder` et dérivation de la salle qui
// répond aux demandes d'autorisation de l'extension, par le portillon de la salle. SQUELETTE posé par T3b (plan 2 bis §4.2) :
// port vide, AUCUN comportement, aucune inscription — le répondeur agit par sa dérivation.
// `neutralOmoResponder` reste exporté et inchangé quand L22d arrivera : c'est le port des tests qui ne déclarent pas ce module.
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoResponderPort } from "./omo-contracts.ts";

export function neutralOmoResponder(_deps: Cockpit11Deps): OmoResponderPort {
  return {};
}

/** Squelette : aucune inscription tant que L22d n'a pas posé le répondeur (dérivation de la salle, après les détections). */
export const omoResponderModule: Cockpit11Module = {
  name: "omoResponder",
  install: () => undefined,
};
