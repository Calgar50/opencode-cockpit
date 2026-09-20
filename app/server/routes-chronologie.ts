// Propriétaire : L47b.
// Squelette inerte posé par T5a (itération 5, plan d'exécution it5 §4.1, D-5-09) : route dédiée de la chronologie. `install`
// n'inscrit RIEN tant que L47b n'a pas livré son comportement : la route reste absente (404), et aucune route n'est ajoutée dans
// http.ts, ni maintenant ni plus tard (§2.2).
// L47b apportera : GET /api/conversations/:rootId/chronologie (mode Avancé seulement), servie depuis les faits de l'itération 1 et
// les lignes `usage` par message, bornée par CHRONO_MAX_ROWS, rendue par le module pur shared/chronologie.ts (L47a).
import type { ConstructionModule } from "./construction-contracts.ts";

export const chronologieModule: ConstructionModule = {
  name: "chronologie",
  install() {
    // Squelette : aucune inscription.
  },
};
