// Propriétaire : L1e.
// Surveillance des délégations lancées sans demande (spécification §3.14) : dérivation sur les parties `task` et session.created
// avec parentID, abonnement usage.updated, plafonds budget.delegation → stopTree(plafond-delegations).
// Squelette T0 : aucune inscription ; port neutre = sans effet (1.0.4).
// neutralDelegationWatch reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, DelegationWatchPort } from "./contracts-11.ts";

export function neutralDelegationWatch(): DelegationWatchPort {
  return {};
}

export const delegationWatchModule: Cockpit11Module = {
  name: "delegationWatch",
  install() {
    // Squelette : L1e pose sa dérivation et son abonnement « usage.updated ».
  },
};
