// Propriétaire : GF5 (grande fusion, croisement salle × construction ; plan it5 §8.6 GF5 point 1, D-5-17). Module PUR.
// Dans une racine de la Salle OMO, les outils de la construction n'existent pas : ni la puce « + Méthode » ni les méthodes retenues
// du composeur, ni « Méthode appliquée / non détectée », ni la Seconde lecture (bouton et pied). La salle a ses propres réglages
// (extension, interdits absolus, plafonds de la salle) ; une méthode ou une seconde lecture y partirait sans aucun des contrôles
// de la construction. Côté serveur, les mêmes règles : le crochet de la Seconde lecture ne requalifie rien sur l'instance « omo »
// (second-reading.ts) et la chronologie d'une racine de la salle en Simple répond 403 comme /facts (routes-chronologie.ts).
// La page du chat ne sert que l'instance principale (une racine de la salle y reçoit 404, cloison P11) : la propriété `salle` du
// composeur et de la vue d'un tour y vaut faux ; elle garde les deux composants fermés pour tout autre appelant.

/** Outils de la construction proposés dans une conversation. */
export interface OutilsDeConstruction {
  /** Puce « + Méthode » et méthodes retenues du composeur. */
  puceMethode: boolean;
  /** « Méthode appliquée » ou « Méthode non détectée dans la réponse », sous une réponse. */
  presenceMethode: boolean;
  /** Bouton « Seconde lecture (≈ x $) » et pied de la réponse du Relecteur. */
  secondeLecture: boolean;
}

/** Tout, hors d'une racine de la salle ; rien dans une racine de la salle. */
export function outilsDeConstruction(racineDeLaSalle: boolean): OutilsDeConstruction {
  const permis = !racineDeLaSalle;
  return { puceMethode: permis, presenceMethode: permis, secondeLecture: permis };
}
