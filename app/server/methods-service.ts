// Propriétaire : L44b.
// Squelette inerte posé par T5a (itération 5, plan d'exécution it5 §4.1, D-5-07) : service des méthodes et route GET /api/methods.
// `install` n'inscrit RIEN tant que L44b n'a pas livré son comportement : le module peut donc être déclaré par le câblage sans
// rien changer (aucune route, aucun crochet, aucune dérivation ; route absente → 404, comme avant la construction).
// L44b apportera : lecture du catalogue (methods-catalogue.ts), blocs balisés de shared/methods.ts, attachement à un assistant
// (assistantBody), limites de construction-constants.ts et phrases de shared/construction-texts.ts.
import type { ConstructionModule } from "./construction-contracts.ts";

export const methodsModule: ConstructionModule = {
  name: "methods",
  install() {
    // Squelette : aucune inscription.
  },
};
