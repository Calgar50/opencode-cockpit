// Propriétaire : L19b.
// Pré-contrôle des projets de la Salle OMO côté cockpit (spécification §3.15.2 ; plan 2 bis, fiche L19b) : port `omoPrecheck`
// et surveillance de `state.json`. SQUELETTE posé par T3b (plan 2 bis §4.2) : port neutre, AUCUN comportement, aucune
// inscription. Neutre = salle coupée : `check` et `beforeStart` refusent « salle-coupee » et n'écrivent AUCUN `precheck-ok`.
// `neutralOmoPrecheck` reste exporté et inchangé quand L19b arrivera : c'est le port des tests qui ne déclarent pas ce module.
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { OmoPrecheckPort } from "./omo-contracts.ts";

export function neutralOmoPrecheck(_deps: Cockpit11Deps): OmoPrecheckPort {
  return {
    check: async () => ({ ok: false, code: "salle-coupee" }),
    // Aucun precheck-ok : le superviseur ne démarrera donc rien, même si un démarrage était en cours.
    beforeStart: async (startId) => ({ ok: false, startId, code: "salle-coupee", resultats: [] }),
  };
}

/** Squelette : aucune inscription tant que L19b n'a pas posé le pré-contrôle (le démarrage « omoPrecheck » est à lui). */
export const omoPrecheckModule: Cockpit11Module = {
  name: "omoPrecheck",
  install: () => undefined,
};
