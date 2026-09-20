// Propriétaire : L28c.
// Texte annoncé par une légende de « Revoir » et de la salle de contrôle (spécification §5.5 l.920, §5.8 l.999-1002 ; plan
// d'exécution it3, fiche L28c, D-3d-29). Fonction PURE, sans React et sans DOM : elle se teste sous Node
// (server/revoir-annonces.test.ts), et l'écriture dans la région unique de la page reste l'affaire de useAnnouncer
// (web/lib/announcer.ts), coupée par le réglage `ui.activityAnnouncements`.
// Une seule région d'annonces par page (D-3d-29) : aucun composant de salle-controle/ n'ajoute de région à lui.
import { phrasesLegende } from "../../../../server/shared/legendes-texts.ts";
import type { NeonMode } from "../../../../server/shared/neon-scene.ts";
import type { LegendeKey } from "../../../../server/shared/salle3d-types.ts";

/**
 * Texte d'une légende pour le lecteur d'écran : ses 1 ou 2 phrases (phrasesLegende, T3d-b), réunies par une espace. Chaîne vide
 * quand aucune clé n'a de phrase : l'appelant n'annonce alors rien.
 */
export function annonceLegende(cles: readonly LegendeKey[], mode: NeonMode): string {
  return phrasesLegende(cles, mode).join(" ");
}
