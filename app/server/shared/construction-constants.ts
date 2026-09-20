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

/**
 * Adresses des routes de la construction, **seule source** : le client d'API (`web/lib/api-construction.ts`) les lit ici, et
 * chaque module qui monte sa route les lit ici aussi (L44b, L44c, L46a, L47b). Tant qu'une adresse était recopiée des deux côtés,
 * le client et le serveur pouvaient s'écarter sans qu'aucun test ne tombe. Valeurs des fiches du plan it5 (§6) ; `:rootId` est
 * rempli par `constructionPath`. Le pluriel d'`/api/archives/:rootId/equipes` est voulu : le préfixe existant `/api/archive`
 * (singulier) est déjà capté par `app.get("/api/archive/:id")` de http.ts.
 */
export const CONSTRUCTION_ROUTE_PATHS = {
  /** L44b : catalogue des méthodes et limites. */
  methodes: "/api/methods",
  /** L44c : coût estimé d'une seconde lecture (le seul POST du client). */
  secondeLectureEstimation: "/api/chat/second-reading/estimate",
  /** L47b : lignes `usage` d'une conversation, mode Avancé seulement. */
  chronologie: "/api/conversations/:rootId/chronologie",
  /** L46a : coûts par équipe du mois, paramètre `month` (AAAA-MM), comme `/api/usage/summary`. */
  coutsEquipes: "/api/usage/equipes",
  /** L46a : lancements d'équipe archivés d'une conversation. */
  archivesEquipes: "/api/archives/:rootId/equipes",
  /** L46a : racines qui ont lancé une équipe (filtre « Avec une équipe » des Archives, D-5-11). */
  equipesConversations: "/api/equipes/conversations",
} as const;

/** Nom du paramètre de mois de `coutsEquipes` (validé par `MONTH_RE` côté serveur, comme `/api/usage/summary`). */
export const TEAM_COSTS_MONTH_PARAM = "month";

/**
 * Remplit le paramètre `:rootId` d'un chemin de `CONSTRUCTION_ROUTE_PATHS`, l'identifiant étant encodé pour l'URL.
 * Un chemin sans `:rootId` est une erreur de programmation, jamais un chemin rendu tel quel : la faute se voit tout de suite.
 */
export function constructionPath(chemin: string, rootId: string): string {
  if (!chemin.includes(":rootId")) throw new RangeError(`Chemin sans :rootId : ${chemin}`);
  return chemin.replace(":rootId", encodeURIComponent(rootId));
}
