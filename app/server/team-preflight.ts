// Propriétaire : L37p.
// Pré-lancement P1 à P11 et ajouts (spécification §3.13 ; plan d'exécution it4, fiche L37p, D-eq-17, A4) : estimation (seul point
// qui lit opencode, instantané gardé), check sans AUCUNE requête, recheck (contrôle de fraîcheur appelé par le runner).
// Squelette T4 : aucune inscription ; port neutre : assistants → carte vide ; estimate, check → refus « a-venir » ; recheck →
// changement « a-venir ».
// neutralPreflight reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
import type { EqModule, TeamPreflightPort } from "./contracts-eq.ts";

export function neutralPreflight(): TeamPreflightPort {
  return {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
    check: async () => ({ ok: false, status: 409, code: "a-venir" }),
    recheck: async () => ({ ok: false, genre: "changement", code: "a-venir" }),
  };
}

export const teamPreflightModule: EqModule = {
  name: "teamPreflight",
  install() {
    // Squelette : L37p pose eq.ports.preflight.
  },
};
