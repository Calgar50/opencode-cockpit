// Propriétaire : L37a.
// TeamService (spécification §3.13, §5.3 ; plan d'exécution it4, fiche L37a) : équipes, aperçu, estimation (calcul : L37p),
// exemples et groupe de routes « teams » (routes-teams.ts, team-examples.ts).
// Squelette T4 : aucune inscription ; port neutre : get → null, estimate → refus « a-venir ».
// neutralTeams reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
import type { EqModule, TeamsPort } from "./contracts-eq.ts";

export function neutralTeams(): TeamsPort {
  return {
    get: () => null,
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
  };
}

export const teamsModule: EqModule = {
  name: "teams",
  install() {
    // Squelette : L37a pose eq.ports.teams et le groupe de routes « teams ».
  },
};
