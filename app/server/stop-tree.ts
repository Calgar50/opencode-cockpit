// Propriétaire : L1c.
// Arrêt unique de l'arbre d'une conversation (spécification §3.12) : port stopTree, crochet abort du proxy, routes
// « conversations » (routes-conversations.ts), fait statut {cause: "arret"}, événement conversation.arretee.
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (l'arrêt du navigateur est relayé tel quel par le proxy).
// neutralStopTree reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { type Cockpit11Module, PortUnavailableError, type StopTreePort } from "./contracts-11.ts";

export function neutralStopTree(): StopTreePort {
  return {
    run: async () => {
      throw new PortUnavailableError("stopTree");
    },
  };
}

export const stopTreeModule: Cockpit11Module = {
  name: "stopTree",
  install() {
    // Squelette : L1c pose c11.ports.stopTree, le crochet « abort » et le groupe de routes « conversations ».
  },
};
