// Propriétaire : L28d (extrait de web/pages/chat/turn.ts au train V1, corrections de la relecture 3-vague-1).
// Nettoyage d'un texte écrit par une IA, avant de le MONTRER : séquences de terminal et caractères cachés retirés, pour ne pas faire
// lire un texte d'IA autrement qu'il n'est écrit (attaque « Trojan Source » : U+202E et ses voisins retournent la lecture).
// Module PUR de server/shared : aucune horloge, aucun accès à la base, aucun import, AUCUNE chaîne affichable (contrôle « sans
// texte », D-3d-21 : seuls des motifs de comparaison, construits par String.fromCharCode pour ne dépendre d'aucun encodage).
// Le nettoyage se fait TOUJOURS à l'affichage, jamais avant l'écriture : la copie gardée d'une consigne (revoir_consignes, U2) doit
// rester fidèle à ce qui a été envoyé, et l'ordre de D-3d-30 (lecture bornée → masquage → coupe) ne bouge pas.
// Seule définition du dépôt : web/pages/chat/turn.ts (boundedAiText) et web/pages/salle-controle/revoir/ConsigneRevoir.tsx s'en
// servent tous les deux.

const char = (code: number): string => String.fromCharCode(code);

/** Séquences de terminal (couleurs) d'une sortie d'outil. */
const ANSI_SEQUENCES = new RegExp(`${char(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * Caractères de commande (tabulation et fin de ligne gardées, retour chariot retiré) et contrôles de sens d'écriture, qui
 * pourraient faire lire un texte d'IA autrement qu'il n'est écrit.
 */
const HIDDEN_CHARACTERS = new RegExp(`[${char(0)}-${char(8)}${char(11)}-${char(31)}${char(127)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`, "g");

/**
 * Texte d'IA prêt à être montré : séquences de terminal et caractères cachés retirés. Ne borne pas la longueur (boundedAiText le
 * fait pour la transcription ; la copie d'une consigne est déjà bornée en base par bornerConsigne).
 */
export function nettoyerTexteIa(value: unknown): string {
  return (typeof value === "string" ? value : "").replace(ANSI_SEQUENCES, "").replace(HIDDEN_CHARACTERS, "");
}
