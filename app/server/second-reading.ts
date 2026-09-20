// Propriétaire : L44c.
// Squelette inerte posé par T5a (itération 5, plan d'exécution it5 §4.1, D-5-06) : Seconde lecture. `install` n'inscrit RIEN tant
// que L44c n'a pas livré son comportement ; en particulier, le crochet `beforeBilledSend` reste vide, donc aucun envoi n'est
// requalifié et le proxy se comporte comme avant la construction.
// L44c apportera : reconnaissance de l'assistant « Relecteur critique » et du début fixe du message (secondReadingPrefix),
// requalification en `SECOND_READING_TURN_KIND` de la ligne qu'`enforceTurn` vient d'écrire, et l'estimation SecondReadingEstimate.
// Elle dépend de la mesure MC5-1 (D-5-27) : si l'hypothèse est contredite, L44c suit la branche « repli » de sa fiche.
import type { ConstructionModule } from "./construction-contracts.ts";

export const secondReadingModule: ConstructionModule = {
  name: "secondReading",
  install() {
    // Squelette : aucune inscription.
  },
};
