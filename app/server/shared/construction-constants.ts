// Valeurs de la construction (itération 5, plan d'exécution it5 §4.2, T5a) : limites des méthodes, repères de la Seconde
// lecture, bornes de la chronologie, des coûts par équipe et des archives. Module pur (ni « node: » ni process), sans texte
// affichable : les phrases sont dans construction-texts.ts. Une limite affichée à l'utilisateur est toujours lue ici, jamais
// recopiée dans un composant.

/** Méthodes attachées à un assistant, à un message et à une étape d'équipe (C §5.4, RM §5.2, D-5-07, D-5-08). */
export const METHODS_PER_ASSISTANT = 2;
export const METHODS_PER_MESSAGE = 2;
export const METHODS_PER_STEP = 2;

/** Bornes du bloc inséré dans les consignes d'un assistant : au-delà, la méthode est refusée au catalogue. */
export const METHOD_BLOCK_MAX_CHARS = 900;
export const METHOD_BLOCK_MAX_WORDS = 120;

/** `chat_turns.kind` d'un tour de seconde lecture (D-5-06 : requalification de la ligne écrite par enforceTurn). */
export const SECOND_READING_TURN_KIND = "seconde-lecture";

/** Identifiant de catalogue de l'assistant « Relecteur critique » (L45a) : sans lui, aucune seconde lecture. */
export const SECOND_READING_CATALOG_ID = "relecteur-critique";

/** Rôle d'un assistant qui travaille surtout dans les équipes (onglet « Assistants des équipes », L45a). */
export const EQUIPIER_ROLE = "equipier";

/** Lignes `usage` lues au plus pour une chronologie ; au-delà, la réponse est marquée tronquée (D-5-09). */
export const CHRONO_MAX_ROWS = 2000;

/** Lancements d'équipe les plus coûteux affichés dans la page Coûts (D-5-10). */
export const TEAM_COSTS_TOP = 10;

/** Racines rendues au plus par le filtre « Avec une équipe » des Archives (D-5-11). */
export const TEAM_CONVERSATIONS_MAX = 2000;

/** Caractères gardés au plus d'un extrait de résultat d'étape, après `redactSecrets`. */
export const ARCHIVE_EXCERPT_MAX = 2000;
