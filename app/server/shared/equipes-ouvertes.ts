// Propriétaire : GF5 (grande fusion ; plan it5 §8.6 GF5 point 3, §2.8 ligne DemoPlayer ; décision U1, D-5-24, D-eq-13, plan it3
// §8.4 (c)). Module PUR : ni réseau, ni horloge, ni réglage lu ici — l'appelant passe le mode et `ouvertesEnSimple` qu'il a lus.
// Repris par L51 (annonce-110.ts) SANS redéfinition.
//
// U1 : les équipes sont complètes en mode Avancé ; en Simple, elles restent fermées tant que le serveur ne dit pas
// `ouvertesEnSimple === true` (GET /api/teams, qui rend EQUIPES_SIMPLE_OUVERTES de wiring-eq.ts : l'ouverture tient en UNE ligne).
// Une lecture absente, en cours ou en échec (null) ferme : fermé en cas de doute.
import type { UiMode } from "./assistant-rules.ts";

/** Équipes proposées dans ce mode : toujours en Avancé ; en Simple, seulement si `ouvertesEnSimple` vaut exactement true. */
export function equipesOuvertes(mode: UiMode, ouvertesEnSimple: boolean | null): boolean {
  return mode === "avance" || ouvertesEnSimple === true;
}

/** Démonstrations du lecteur complet (L34, D-3d-26), dans l'ordre du choix, puis celle d'équipe (L49, D-5-15). */
export type CleDemonstration = "p1" | "attente-accord" | "arret-plafond" | "equipe";

const DEMONSTRATIONS_DU_LECTEUR: readonly CleDemonstration[] = ["p1", "attente-accord", "arret-plafond"];

/**
 * Démonstrations proposées dans le choix du lecteur complet : les trois de l'itération 3, puis « Comment se déroule une équipe »
 * SEULEMENT si l'appelant la rend visible (`equipesVisibles`, calculé par equipesOuvertes). En Simple avec les équipes fermées :
 * aucune démonstration d'équipe, ni proposée ni nommée (U1, plan it3 §8.4 (c)).
 */
export function demonstrationsProposees(equipesVisibles: boolean): CleDemonstration[] {
  return equipesVisibles ? [...DEMONSTRATIONS_DU_LECTEUR, "equipe"] : [...DEMONSTRATIONS_DU_LECTEUR];
}
