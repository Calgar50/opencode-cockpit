// Propriétaire : L46a.
// Squelette inerte posé par T5a (itération 5, plan d'exécution it5 §4.1, D-5-10, D-5-11) : coûts par équipe, archives d'équipe et
// filtre « Avec une équipe ». `install` n'inscrit RIEN tant que L46a n'a pas livré son comportement (aucune route ; l'export CSV
// et l'export Markdown restent ceux de l'itération 1).
// L46a apportera : calcul depuis team_runs, team_run_steps et usage (purpose « equipe »), colonnes `lancement_equipe` et `etape`
// en fin de ligne du CSV, résumé des lancements dans l'export Markdown (sans extrait) et les réponses TeamCostsResponse,
// ArchiveTeamsResponse et TeamConversationsResponse.
import type { ConstructionModule } from "./construction-contracts.ts";

export const teamCostsModule: ConstructionModule = {
  name: "teamCosts",
  install() {
    // Squelette : aucune inscription.
  },
};
