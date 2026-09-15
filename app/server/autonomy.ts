// Propriétaire : L10a.
// Service d'autonomie (spécification §4.3) : dérivation permission.asked → file par conversation (45 s), classement, relayOnce,
// autonomy_decisions, faits « decision », abonnement opencode.connection (relecture de GET /permission), examining().
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (aucun examen, tout attend l'utilisateur).
// neutralAutonomy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { AutonomyPort, Cockpit11Module } from "./contracts-11.ts";

export function neutralAutonomy(): AutonomyPort {
  return {
    examining: () => false,
  };
}

export const autonomyModule: Cockpit11Module = {
  name: "autonomy",
  install() {
    // Squelette : L10a pose c11.ports.autonomy, sa dérivation et son abonnement « opencode.connection ».
  },
};
