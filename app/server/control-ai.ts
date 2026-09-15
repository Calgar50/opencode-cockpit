// Propriétaire : L11b.
// IA de contrôle (spécification §4.6) : seulement « à juger », en Autonome, avec controleIa ; IA Rapide disponible, guardRuns,
// canBill, controlesIaMax ; session CONTROLE vérifiée, 30 s, usage « controle », abort puis DELETE ; parseControlOutput (L11a).
// Squelette T0 : aucune inscription ; port neutre = indisponible (la commande attend votre accord).
// neutralControlAi reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, ControlAiPort } from "./contracts-11.ts";

export function neutralControlAi(): ControlAiPort {
  return {
    judge: async () => ({ decision: "indisponible", raison: "a-venir" }),
  };
}

export const controlAiModule: Cockpit11Module = {
  name: "controlAi",
  install() {
    // Squelette : L11b pose c11.ports.controlAi.
  },
};
