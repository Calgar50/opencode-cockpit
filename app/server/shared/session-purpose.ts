// Sessions de classement du cockpit (P12) : titre exact posé par le serveur (classifier.ts) et préfixe de titre réservé.
// Partagé par le serveur (sessions.ts, processor.ts, http.ts) et l'interface (ChatPage.tsx) : aucun import.
//
// Un titre n'est jamais une preuve d'origine : opencode fait écrire le titre d'une conversation par son IA de titre, d'après le
// premier message (session/prompt.ts, ensureTitle), et celui d'un enfant reprend la description du task écrite par l'IA
// (tool/task.ts:160). Seul le titre exact d'une racine est lu, et seulement pour une session encore inconnue (sessions.ts).

/** Préfixe réservé aux sessions du cockpit : refusé par le proxy en tête du titre d'une conversation (http.ts). */
export const COCKPIT_TITLE_PREFIX = "[cockpit]";

/** Titre exact d'une session de classement (classifier.ts). */
export const CLASSIFIER_TITLE = `${COCKPIT_TITLE_PREFIX} classement`;

/** Racine de classement : `metadata.cockpit` posé par le serveur (le proxy le refuse), ou titre exact CLASSIFIER_TITLE. */
export function isClassifierRoot(info: { parentID?: unknown; title?: unknown; metadata?: unknown }): boolean {
  if (info.parentID) return false;
  const metadata = typeof info.metadata === "object" && info.metadata !== null ? (info.metadata as Record<string, unknown>) : {};
  return metadata.cockpit === "classifier" || info.title === CLASSIFIER_TITLE;
}

/** Titre qui commence par « [cockpit] » (espaces de tête et casse ignorés) : réservé au cockpit. */
export function isReservedTitle(title: string): boolean {
  return title.trimStart().toLowerCase().startsWith(COCKPIT_TITLE_PREFIX);
}
