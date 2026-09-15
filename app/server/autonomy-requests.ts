// Propriétaire : L10a.
// Demandes autonomes (autonomy_requests) : création à l'envoi (crochet beforeBilledSend), compteurs, dépense via
// ledger.spentSince, événement autonomie.demande, interrupt ; refus des raccourcis ``!` `` en choix automatique (409).
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (aucune demande suivie).
// neutralRequests reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, RequestsPort } from "./contracts-11.ts";

export function neutralRequests(): RequestsPort {
  return {
    current: () => null,
    spent: () => 0,
    interrupt: () => undefined,
  };
}

export const requestsModule: Cockpit11Module = {
  name: "requests",
  install() {
    // Squelette : L10a pose c11.ports.requests et le crochet « beforeBilledSend ».
  },
};
