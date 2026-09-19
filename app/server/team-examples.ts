// Propriétaire : L37a.
// Exemples d'équipes (question Q3, réponse A11) : « Revue SQL sur réplica » (avis, relire-requete-sql) et « Chaîne de relecture de
// script » (à la suite avec une pause, relire-script), textes de T4t ; installation idempotente des assistants manquants par
// eq.assistants.install, TOUJOURS derrière la garde de rechargement de la route (install() n'en a aucune).
// Squelette T4 : aucun exemple.
import type { Flow } from "./shared/team-types.ts";

export interface TeamExample {
  id: string;
  version: number;
  titre: string;
  description: string;
  flow: Flow;
}

export const TEAM_EXAMPLES: readonly TeamExample[] = Object.freeze([]);
