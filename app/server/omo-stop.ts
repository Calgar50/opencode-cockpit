// Propriétaire : L23b.
// Arrêt de la Salle OMO (stopTreeOmo, spécification §3.12.1 ; plan 2 bis, fiche L23b) : port `omoStop` et crochet `abort` de
// l'instance de la salle. SQUELETTE posé par T3b (plan 2 bis §4.2) : port neutre, AUCUN comportement, aucune inscription.
// Neutre = salle coupée : `run` lève PortUnavailableError (aucun arrêt n'est possible sans salle) et `relaunchAfterRequest` est
// sans effet. `neutralOmoStop` reste exporté et inchangé quand L23b arrivera : c'est le port des tests qui ne déclarent pas ce
// module (plan §2.2).
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import { PortUnavailableError } from "./contracts-11.ts";
import type { OmoStopPort } from "./omo-contracts.ts";

export function neutralOmoStop(_deps: Cockpit11Deps): OmoStopPort {
  return {
    run: () => Promise.reject(new PortUnavailableError("omoStop")),
    // Fin de demande : sans salle, il n'y a rien à relancer (aucun stop-request écrit, D-2b-29).
    relaunchAfterRequest: async () => undefined,
  };
}

/** Squelette : aucune inscription tant que L23b n'a pas posé l'arrêt de la salle (le crochet `abort` de la salle est à lui). */
export const omoStopModule: Cockpit11Module = {
  name: "omoStop",
  install: () => undefined,
};
