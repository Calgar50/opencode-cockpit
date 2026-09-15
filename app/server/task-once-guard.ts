// Propriétaire : L1d.
// Garde du `task once` (spécification §3.14) : crochet beforeOnceRelay (409), dérivation du refus Simple (mode Simple et choix
// de la racine différent de « autonome », par rejectWhenAlone), collectDelegationFacts (réutilisé par L10e), détails de délégation.
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (aucun refus, aucun détail).
// neutralTaskGuard reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { type Cockpit11Module, PortUnavailableError, type TaskGuardPort } from "./contracts-11.ts";

export function neutralTaskGuard(): TaskGuardPort {
  return {
    details: async () => null,
    collectDelegationFacts: async () => {
      throw new PortUnavailableError("taskGuard");
    },
  };
}

export const taskGuardModule: Cockpit11Module = {
  name: "taskGuard",
  install() {
    // Squelette : L1d pose c11.ports.taskGuard, le crochet « beforeOnceRelay », sa dérivation et le groupe « delegations ».
  },
};
