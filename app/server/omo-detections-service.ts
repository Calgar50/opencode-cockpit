// Propriétaire : L23c.
// Détections après coup de la Salle OMO (spécification §4.14.5 ; règles pures : shared/omo-detections.ts de L23a ; plan 2 bis,
// fiche L23c) : port `omoDetections`, dérivation de la salle et abonnement `usage.updated` hors demande. SQUELETTE posé par T3b
// (plan 2 bis §4.2) : port vide, AUCUN comportement, aucune inscription — les détections agissent par leurs inscriptions.
// `neutralOmoDetections` reste exporté et inchangé quand L23c arrivera : c'est le port des tests qui ne déclarent pas ce module.
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoDetectionsPort } from "./omo-contracts.ts";

export function neutralOmoDetections(_deps: Cockpit11Deps): OmoDetectionsPort {
  return {};
}

/** Squelette : aucune inscription tant que L23c n'a pas posé les détections (dérivation et abonnement de la salle). */
export const omoDetectionsModule: Cockpit11Module = {
  name: "omoDetections",
  install: () => undefined,
};
