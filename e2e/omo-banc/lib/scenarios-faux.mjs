// Bibliothèque de scénarios du faux fournisseur de la salle (L21b) : réponses scriptées prêtes à poster sur le pilotage du faux
// (`lib/faux-copilot.mjs` de L21a, route `POST /reponses`), communes au banc complet et aux portes de la vague 5 (L27a, L27b).
//
// Ce module ne fait que FABRIQUER des réponses : aucune entrée-sortie, aucun réseau, aucun état. Chaque réponse respecte le
// format que le faux valide (clés `texte`, `outils`, `fin`, `statut`, `retryAfter`, `delaiMs`, `usage`, `nanoAiu`) : un lot
// hors format serait refusé EN BLOC par le faux, et une porte jouerait alors sur la réponse par défaut sans le savoir. Le test
// `app/server/omo-banc-complet.test.ts` poste chaque scénario à un vrai faux (processus enfant) et exige un 200.
//
// Les noms et les arguments des outils sont ceux d'opencode 1.18.30 et de l'extension 4.19.4, relevés dans l'image (noms seuls,
// D-2b-31) : `read {filePath}`, `grep {pattern, path}`, `glob {pattern, path}`, `list {path}`, `bash {command, description}`,
// `write {filePath, content}`, `edit {filePath, oldString, newString}`, `todowrite {todos}`, `task {description, prompt,
// subagent_type | category, run_in_background}`, `call_omo_agent {description, prompt, subagent_type, run_in_background}`,
// `skill_mcp {mcp_name, tool_name}`, `skill {name}`. Aucun texte de l'extension n'est recopié : les consignes sont synthétiques.
//
// Aucune dépendance npm (P8).

/** Bornes du faux (L21a), recopiées pour refuser ici ce que le faux refuserait là-bas : une porte doit échouer tôt et en clair. */
export const BORNES_FAUX = Object.freeze({ file: 200, outils: 20, delaiMaxMs: 60_000 });

/** Usage d'une réponse : petit, pour que les plafonds de coût des portes se mesurent en appels, pas en jetons. */
const USAGE = Object.freeze({ entree: 20, sortie: 6 });

/**
 * Un appel d'outil, au format du faux. `arguments` est un objet (sérialisé par le faux). Aucun identifiant d'appel n'est posé :
 * le faux en fabrique un unique par requête, et le sien n'est pas soumis à sa propre règle d'identifiant (qui refuse « _ »).
 */
export function outil(nom, args = {}) {
  if (typeof nom !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(nom)) throw new Error(`nom d'outil refusé : ${String(nom).slice(0, 40)}`);
  return { nom, arguments: args };
}

/** Réponse qui appelle un ou plusieurs outils (fin « tool_calls »). */
export function appels(...outils) {
  if (outils.length === 0 || outils.length > BORNES_FAUX.outils) throw new Error(`de 1 à ${BORNES_FAUX.outils} outils par réponse`);
  return { outils, fin: "tool_calls", usage: { ...USAGE } };
}

/** Réponse de texte seul, qui clôt le tour (fin « stop »). */
export function texte(contenu = "Réponse du faux fournisseur de la salle.", options = {}) {
  const reponse = { texte: contenu, fin: "stop", usage: { ...USAGE } };
  if (options.delaiMs !== undefined) reponse.delaiMs = borneDelai(options.delaiMs);
  return reponse;
}

const borneDelai = (ms) => {
  if (!Number.isInteger(ms) || ms < 0 || ms > BORNES_FAUX.delaiMaxMs) throw new Error(`délai hors bornes : ${ms} (0 à ${BORNES_FAUX.delaiMaxMs} ms)`);
  return ms;
};

// --- Outils de lecture et de commande ------------------------------------------------------------------------------------------

export const lecture = (filePath) => outil("read", { filePath });
export const recherche = (pattern, chemin) => outil("grep", chemin === undefined ? { pattern } : { pattern, path: chemin });
export const motif = (pattern, chemin) => outil("glob", chemin === undefined ? { pattern } : { pattern, path: chemin });
export const liste = (chemin) => outil("list", chemin === undefined ? {} : { path: chemin });
export const commande = (command, description = "commande du banc") => outil("bash", { command, description });
export const ecriture = (filePath, content) => outil("write", { filePath, content });
export const edition = (filePath, oldString, newString) => outil("edit", { filePath, oldString, newString });

// --- Délégations de l'extension ------------------------------------------------------------------------------------------------

/** `task` de l'extension, vers un assistant nommé (sous-agent) ; en fond si `enFond`. */
export const tache = ({ description = "tache du banc", prompt = "Reponds en une ligne.", subagent = "explore", enFond = false } = {}) =>
  outil("task", { description, prompt, subagent_type: subagent, run_in_background: enFond });

/** `task` de l'extension, par catégorie (l'extension choisit l'assistant). */
export const tacheParCategorie = ({ description = "tache du banc", prompt = "Reponds en une ligne.", categorie = "quick", enFond = false } = {}) =>
  outil("task", { description, prompt, category: categorie, run_in_background: enFond });

/** `call_omo_agent` : seuls `explore` et `librarian` sont admis par l'extension. */
export const appelAgent = ({ description = "appel du banc", prompt = "Regarde le projet.", subagent = "explore", enFond = false } = {}) =>
  outil("call_omo_agent", { description, prompt, subagent_type: subagent, run_in_background: enFond });

/** `skill_mcp` : outil COUPÉ par le filet (OUTILS_COUPES) ; sert à prouver le refus. */
export const outilMcp = (mcp = "banc", nomOutil = "lire") => outil("skill_mcp", { mcp_name: mcp, tool_name: nomOutil });

/** `skill` : charge une compétence du projet par son nom (compétence piégée de G7). */
export const competence = (name) => outil("skill", { name });

// --- Séries toutes faites -------------------------------------------------------------------------------------------------------

/**
 * Un appel d'outil puis la fin du tour : la forme la plus simple d'une demande qui travaille (scénario de fumée). Deux réponses,
 * dans l'ordre d'arrivée des appels : l'outil, puis le texte qui clôt.
 */
export function unOutilPuisFin(appel, conclusion = "Fait : un outil appelé, rien d'autre.") {
  return [appels(appel), texte(conclusion)];
}

/** `n` réponses 429 d'affilée, avec `retry-after` (G6 : trois d'affilée arrêtent la salle). */
export function serie429(n = 3, retryAfter = 1) {
  if (!Number.isInteger(n) || n < 1 || n > BORNES_FAUX.file) throw new Error(`série de 429 hors bornes : ${n}`);
  return Array.from({ length: n }, () => ({ statut: 429, retryAfter }));
}

/** Réponse lente (délai avant le premier octet) : pour les arrêts en cours d'appel (G5, M29 hors facturation). */
export const lente = (delaiMs = 20_000, contenu = "Réponse lente du faux fournisseur.") => texte(contenu, { delaiMs });

/**
 * De quoi faire créer `n` sessions par l'extension : `n` délégations `task` en une réponse (20 au plus par réponse, contrainte
 * du faux), réparties sur autant de réponses que nécessaire, chaque sous-session répondant par un texte. G6 : au-delà de 30
 * sessions créées, la salle s'arrête ; `trenteSessions()` en demande 31.
 *
 * Limite, à connaître avant de s'en servir : la file « par ordre d'arrivée » du faux est UNE seule file. Des sous-sessions en
 * fond appellent le faux pendant que la racine attend sa réponse suivante ; qui prend quoi dépend alors de l'ordre d'arrivée.
 * Quand l'assistant délégué n'a pas la même IA que la racine, poster les textes des sous-sessions dans la file de SON IA
 * (`POST /reponses {ia, reponses}`) rend l'ordre sûr. Ce que G6 exige (plus de 30 sessions CRÉÉES) ne dépend pas de cet ordre.
 */
export function sessions(n) {
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error(`nombre de sessions hors bornes : ${n}`);
  const lots = [];
  for (let reste = n; reste > 0; reste -= BORNES_FAUX.outils) {
    const taille = Math.min(reste, BORNES_FAUX.outils);
    lots.push(appels(...Array.from({ length: taille }, (_, i) => tache({ description: `session du banc ${n - reste + i + 1}`, enFond: true }))));
  }
  const reponses = [...lots, ...Array.from({ length: n }, () => texte("Sous-tache du banc terminee.")), texte("Delegations lancees.")];
  if (reponses.length > BORNES_FAUX.file) throw new Error(`série trop longue pour la file du faux : ${reponses.length}`);
  return reponses;
}

export const trenteSessions = () => sessions(31);

// --- Provocation des hooks gardés (M28, reste R-7 de la clôture 2 bis) ----------------------------------------------------------
//
// Trois automatismes gardés par l'audit (docs/omo-audit-4.19.4.md, décision « garder ») injectent un message que le cockpit doit
// reconnaître comme venant de l'extension (détection 2, L23a) : ils ne se déclenchent qu'avec un vrai travail, que le faux ne
// faisait jamais au banc de L21. Chaque provocation est une suite de réponses ; l'assistant visé est donné à l'envoi.

/**
 * `todo-continuation-enforcer` : une liste de tâches laissée inachevée, puis la fin du tour. Au repos, l'extension relance la
 * session d'elle-même (compte à rebours de quelques secondes) : c'est exactement une activité SANS demande, que M28 relève.
 */
export function todoInachevee() {
  return [
    appels(outil("todowrite", { todos: [{ id: "1", content: "Tache du banc laissee ouverte", status: "pending", priority: "high" }] })),
    texte("Je m'arrete ici."),
    // Réponses aux relances éventuelles : un texte, sans outil, pour que la relance s'éteigne d'elle-même.
    texte("Relance recue."),
    texte("Relance recue."),
    texte("Relance recue."),
  ];
}

/** `prometheus-md-only` : l'assistant de plan écrit un fichier qui n'est pas un plan Markdown (refus attendu), puis un plan. */
export function prometheusEcrit(dossier) {
  return [appels(ecriture(`${dossier}/src/banc-plan.js`, "// fichier du banc\n")), appels(ecriture(`${dossier}/docs/banc-plan.md`, "# Plan du banc\n")), texte("Plan ecrit.")];
}

/** `atlas` : l'orchestrateur modifie un fichier lui-même au lieu de déléguer (rappel « délégation requise » attendu). */
export function atlasEcritDirect(dossier) {
  return [appels(ecriture(`${dossier}/docs/banc-atlas.md`, "Note du banc.\n")), texte("Ecrit directement.")];
}

/**
 * Types des directives marquées de la 4.19.4 (`SystemDirectiveTypes`, noms seuls), relevés dans le `dist` de l'image du banc le
 * 24/09 (sonde en lecture seule, execution/mesures/L21b.md) : exactement ces sept. Ce que M28 cherche.
 */
export const DIRECTIVES_MARQUEES = Object.freeze([
  "TODO CONTINUATION",
  "BOULDER CONTINUATION",
  "DELEGATION REQUIRED",
  "SINGLE TASK ONLY",
  "COMPACTION CONTEXT",
  "CONTEXT WINDOW MONITOR",
  "PROMETHEUS READ-ONLY",
]);

/**
 * Directive marquée : `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - <TYPE>]`. Même classe de caractères que la détection 2 du cockpit
 * (`SYSTEM_DIRECTIVE_RE` de app/server/shared/message-origin.ts, égalité tenue par omo-banc-complet.test.ts), sans l'ancre de
 * début : le banc cherche dans un flux ou un journal, pas au début d'un message.
 */
export const MOTIF_DIRECTIVE = /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ([A-Z0-9][A-Z0-9 _/-]{0,63})\]/g;

/** Types des directives marquées trouvées dans un texte, dans l'ordre d'apparition (jamais le texte lui-même). */
export function directivesDe(texte) {
  return [...String(texte ?? "").matchAll(MOTIF_DIRECTIVE)].map((m) => m[1]);
}

/** Marqueurs internes de l'extension (noms seuls) : un message qui les porte vient d'elle. */
export const MARQUEURS_INTERNES = Object.freeze(["OMO_INTERNAL_INITIATOR", "OMO_INTERNAL_NOREPLY"]);
