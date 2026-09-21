// Propriétaire : L22c.
// Activation « Comme Oh My OpenAgent » (spécification §4.14.2, §4.8.2 ; plan 2 bis, fiche L22c) : port `omoActivation`, jeton à
// usage unique et crochet `beforeBilledSend` de la salle. SQUELETTE posé par T3b (plan 2 bis §4.2) : port neutre, AUCUN
// comportement, aucune inscription. Neutre = salle coupée : `put` refuse 409 « salle-coupee », `consume` refuse « salle-coupee »,
// `activeRequest` rend null et `view` rend null — sans salle, aucune racine n'appartient à la salle (le port dit « racine inconnue
// ou hors salle » ; l'écran, lui, lit `salleOuverte` faux dans Bootstrap.omo, L26a). `neutralOmoActivation` reste exporté et
// inchangé quand L22c arrivera : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoActivationPort } from "./omo-contracts.ts";

export function neutralOmoActivation(_deps: Cockpit11Deps): OmoActivationPort {
  return {
    view: async () => null,
    put: async () => ({ ok: false, status: 409, code: "salle-coupee" }),
    consume: async () => ({ ok: false, code: "salle-coupee" }),
    activeRequest: () => null,
    endRequest: () => undefined,
  };
}

/** Squelette : aucune inscription tant que L22c n'a pas posé l'activation (le crochet d'envoi de la salle est à lui). */
export const omoActivationModule: Cockpit11Module = {
  name: "omoActivation",
  install: () => undefined,
};
