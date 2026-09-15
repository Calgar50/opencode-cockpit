// Propriétaire : L10d.
// Activation des choix automatiques (spécification §4.10, §4.11) : règles effectives de l'agent, mcp ou plugin, profil « Sans
// confirmation », plancher vérifié ; ACTIVATION_OUVERTE fausse → refus « a-venir » ; crochet beforeBilledSend (agent non
// conforme → retour à « demander » et 409).
// Squelette T0 : aucune inscription ; port neutre = refus « a-venir » (code ; la phrase vient du module de textes).
// neutralActivation reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { ActivationPort, Cockpit11Module } from "./contracts-11.ts";

export function neutralActivation(): ActivationPort {
  return {
    check: async () => ({ ok: false, raison: "a-venir" }),
  };
}

export const activationModule: Cockpit11Module = {
  name: "activation",
  install() {
    // Squelette : L10d pose c11.ports.activation et le crochet « beforeBilledSend ».
  },
};
