// Propriétaire : L10e.
// Délégation en « Autonome avec contrôle » (spécification §4.7) : collectDelegationFacts (L1d) + classifyDelegation (L9b) ;
// once automatique sous plafond ; au-delà, Simple → rejectWhenAlone, Avancé → attente avec la carte.
// Squelette T0 : aucune inscription ; port neutre = attente.
// neutralDelegationPolicy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, DelegationPolicyPort } from "./contracts-11.ts";

export function neutralDelegationPolicy(): DelegationPolicyPort {
  return {
    decide: async () => ({ verdict: "attente", regle: null }),
  };
}

export const delegationPolicyModule: Cockpit11Module = {
  name: "delegationPolicy",
  install() {
    // Squelette : L10e pose c11.ports.delegationPolicy.
  },
};
