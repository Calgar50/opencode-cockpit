// Motifs d'identifiants (1.1) : mêmes valeurs que ID et SESSION_ID_RE de http.ts, qui y restent en copie locale jusqu'à L1a
// (L1a-1 fait importer ce module par http.ts). wiring-11.test.ts compare les motifs tant que la copie existe.
// Toute nouvelle route 1.1 valide ses identifiants de conversation, de session et de demande avec ces motifs.

/** Identifiant opencode (session, message, demande d'autorisation) : 1 à 128 caractères parmi A-Z a-z 0-9 _ -. */
export const ID = "[A-Za-z0-9_-]{1,128}";

/** Identifiant entier (proxy : routes de réponse et d'arrêt, demandes lues dans GET /permission). */
export const ID_RE = new RegExp(`^${ID}$`);

/** Identifiant de conversation dans les routes du cockpit (/api/conversations/:rootId/…). */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
