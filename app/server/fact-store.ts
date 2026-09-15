// Propriétaire : L4b.
// Magasin de faits (activity_facts, migration 5) : append borné à 20 000 par racine, since, et work.markDelegation /
// work.markWait, seuls points d'écriture des tables delegations et permission_waits (transitions de activity-types.ts).
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (rien n'est écrit, aucun fait).
// neutralFacts reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, FactsPort } from "./contracts-11.ts";

export function neutralFacts(): FactsPort {
  return {
    append: () => undefined,
    since: () => ({ facts: [], partial: false }),
    work: {
      markDelegation: () => false,
      markWait: () => false,
    },
  };
}

export const factsModule: Cockpit11Module = {
  name: "facts",
  install() {
    // Squelette : L4b pose c11.ports.facts, la dérivation (activity-deriver.ts) et le groupe de routes « activity ».
  },
};
