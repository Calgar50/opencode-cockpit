// Interdits absolus de la Salle OMO, module PUR (spécification §4.14.3 l.827-832, §4.5 l.671, §4.1 l.583-588, §3.7 l.310,
// §9.4 n° 1 l.1417, G7 l.1221 ; plan d'exécution 2 bis et 2 ter §6 fiche L22b, D-2b-34, D-2b-09, relecture 2bis-vague-0 du
// 19/09, décision du 19/09 n° 7) : ni « node: », ni accès au système, ni horloge, ni aléa, ni disque.
//
// `classifyOmoPermission(demande, ctx)` lit UNE demande d'autorisation publiée par l'instance de la salle (`permission.asked`,
// propriétés brutes) et rend « once » ou un refus avec sa catégorie. Le répondeur (L22d) fait le reste : réponse « once »
// relayée, refus par `rejectWhenAlone` avec la phrase « Interdit absolu du cockpit : {categorie}… », journal `refus-interdit`.
//
// Ce que la salle applique, et rien d'autre (§4.5, décision n° 7, Q2) :
// - `bash` : les listes S4 « réseau » et « production », `git push`, `git remote`, les options globales de git, et les chemins
//   sensibles P03, dont la famille `.env*` (sauf `.env.example`). Les interpréteurs, les tests, les scripts et les programmes du
//   projet PASSENT : c'est la décision n° 7, tenue par le réseau fermé (G1), le `.git` en lecture seule et les détections ;
// - `edit`, `write`, `apply_patch` (opencode publie les trois sous la permission « edit », mesure MX1) : `.git/**`, les noms de
//   configuration de l'extension et d'opencode (liste du pré-contrôle de L19a, dont `.agents/`), les fichiers d'IDE et de CI,
//   tout chemin hors du projet ouvert — un autre projet préparé compris (D-2b-09) —, les fichiers de clés et `.env*` ;
// - `external_directory`, `webfetch`, `websearch` : toujours refusés (décision du 19/09 n° 7 : refus explicite dans la
//   configuration d'instance ET ici, le filet de L24 en troisième ligne).
//
// Fermé en cas de doute : une demande d'écriture dont aucun chemin n'est lisible, un projet ouvert qui n'est pas un chemin
// absolu, une demande `bash` sans commande lisible sont refusés (catégorie « hors-projet » : rien ne dit que la demande reste
// dans le projet ouvert). Une commande que la porte de L8a ne sait pas découper n'est pas refusée pour autant — un enchaînement
// et un tube sont permis par la décision n° 7 — mais elle est analysée par fragments, chaque début de fragment valant un
// programme : le contrôle y est plus large, jamais plus étroit.
//
// Aucune liste n'est recopiée : les programmes S4 et les chemins P03 viennent de `shell-gate.ts` (L8a), les noms de
// configuration et les fichiers de clés de `omo-precheck-rules.ts` (L19a), les fichiers d'IDE et de CI de `omo-detections.ts`
// (L23a), plus les cibles de la configuration git relevées dans l'arbre de travail (`ReleveEmpreintes.ideCiDynamiques` de L19a,
// relecture 2bis-vague-0 : `core.hooksPath`, `core.fsmonitor`, fichiers inclus), traitées comme des fichiers d'IDE et de CI.
import { OMO_IDE_CI_NOMS } from "./omo-detections.ts";
import { DOSSIER_ETAT_OMO, estFichierCle, memeNom, NOMS_CONFIG_EXTENSION, NOMS_CONFIG_OPENCODE, NOMS_DANS_OMO_REFUSES, nomDansListe } from "./omo-precheck-rules.ts";
import type { OmoForbiddenCategory } from "./omo-types.ts";
import { forbiddenCategory, GIT_GLOBAL_OPTIONS, sensitivePath, SHELL_FORBIDDEN, tokenizeCommand } from "./shell-gate.ts";

// --- Entrée et sortie ------------------------------------------------------------------------------------------------------------

/**
 * Demande d'autorisation telle qu'opencode la publie (`permission.asked`) : seuls le type de permission et les métadonnées
 * servent ici. `AskedPermission` (autonomy.ts) satisfait cette forme sans conversion.
 */
export interface OmoForbiddenDemande {
  /** `bash`, `edit`, `webfetch`, `websearch`, `external_directory`, `task`… */
  permission: string;
  /** Métadonnées brutes : rien n'y est tenu pour présent ni pour bien typé. */
  metadata: Record<string, unknown>;
}

/** Ce que le cockpit sait de la racine qui demande. */
export interface OmoForbiddenContext {
  /**
   * Projet ouvert de la racine, chemin ABSOLU dans le conteneur (« /workspace/mon-projet »). Tout chemin d'écriture résolu hors
   * de ce dossier est refusé, qu'il soit dans un autre projet préparé ou ailleurs (D-2b-09).
   */
  projetOuvert: string;
  /**
   * Cibles de la configuration git dans l'arbre de travail, relatives au projet ouvert (`ReleveEmpreintes.ideCiDynamiques` de
   * L19a) : traitées comme des fichiers d'IDE et de CI, qu'elles existent déjà ou non.
   */
  ideCiDynamiques?: readonly string[];
}

/** Verdict du portillon de la salle : aucun choix intermédiaire, aucune attente possible (décision n° 6). */
export type OmoPermissionVerdict = { verdict: "once" } | { verdict: "interdit"; categorie: OmoForbiddenCategory };

const ONCE: OmoPermissionVerdict = Object.freeze({ verdict: "once" as const });

const interdit = (categorie: OmoForbiddenCategory): OmoPermissionVerdict => ({ verdict: "interdit", categorie });

// --- Famille « .env* » (reste L24 n° 3, tranché ici pour le train) ----------------------------------------------------------------

/**
 * Motifs `.env*` refusés (« * » = n'importe quoi sauf « / ») :
 * - `.env*` sur CHAQUE segment du chemin (`.env`, `.env.local`, `.envrc`, `.env-prod`, et le dossier `.env.d/`) ;
 * - `*.env` et `*.env.*` sur le dernier segment (`prod.env`, `prod.env.local`), motifs de `KEY_FILE_READ_RULES`.
 * Exceptions : `.env.example` et `*.env.example`, lisibles et modifiables (§4.5, `KEY_FILE_READ_RULES` « allow »).
 * Cette famille est l'UNION de `sensitivePath` (L8a, qui ne connaît pas `*.env.*`) et des motifs du filet de L24 ; elle est plus
 * large que le filet, qui n'applique les siens qu'au dernier segment.
 */
export const MOTIFS_ENV_REFUSES: readonly string[] = Object.freeze([".env*", "*.env", "*.env.*"]);

/** Motifs `.env*` permis, plus forts que les refus. */
export const MOTIFS_ENV_PERMIS: readonly string[] = Object.freeze([".env.example", "*.env.example"]);

const FIN_ENV = /[.]env$/iu;
const MILIEU_ENV = /[.]env[.]/iu;
const EXEMPLE_ENV = /[.]env[.]example$/iu;

/** Vrai si ce chemin (séparateur « / ») porte un `.env*` refusé, sur n'importe quel segment. */
export function estCheminEnv(chemin: string): boolean {
  const segments = segmentsDe(chemin);
  const base = segments.at(-1) ?? "";
  if (memeNom(base, ".env.example") || EXEMPLE_ENV.test(base)) return false;
  if (segments.some((segment) => segment.toLowerCase().startsWith(".env"))) return true;
  return FIN_ENV.test(base) || MILIEU_ENV.test(base);
}

// --- Chemins ---------------------------------------------------------------------------------------------------------------------

/** Segments utiles d'un chemin, « . » et les séparateurs vides retirés ; « \ » vaut « / » (chemin écrit à la mode Windows). */
function segmentsDe(chemin: string): string[] {
  return chemin.replace(/\\/gu, "/").split("/").filter((segment) => segment !== "" && segment !== ".");
}

/** Résolution lexicale POSIX de `chemin` depuis `base` (absolu) : « . » et « .. » appliqués, sans jamais lire un disque. */
function resoudre(base: string, chemin: string): string {
  const brut = chemin.replace(/\\/gu, "/");
  const out: string[] = [];
  for (const segment of (brut.startsWith("/") ? brut : `${base}/${brut}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** Chemin relatif à `dossier` si `absolu` est dedans (« » pour le dossier lui-même), null sinon. */
function dedans(dossier: string, absolu: string): string | null {
  if (absolu === dossier) return "";
  if (dossier === "/") return absolu.slice(1);
  return absolu.startsWith(`${dossier}/`) ? absolu.slice(dossier.length + 1) : null;
}

/** Vrai si `relatif` est ce nom ou est dedans : « .vscode » couvre « .vscode/tasks.json ». Casse ignorée ; les deux sont déjà
 * réduits à leurs segments utiles (ni barre finale, ni « . »). */
function couvre(relatif: string, nom: string): boolean {
  const a = relatif.toLowerCase();
  const b = nom.toLowerCase();
  return b !== "" && (a === b || a.startsWith(`${b}/`));
}

// --- Catégorie portée par un chemin --------------------------------------------------------------------------------------------

/** Dossiers sensibles P03 (S5) qui sont de la configuration d'assistant, pas des clés. */
const DOSSIERS_CONFIG: readonly string[] = Object.freeze([".opencode", ".agents", ".claude"]);

/** `azure-pipelines*.yml` (§4.14.5 n° 7), le seul motif de la liste fixe des fichiers d'IDE et de CI. */
const AZURE_PIPELINES = /^azure-pipelines[^/]*\.yml$/iu;

/**
 * Catégorie d'un chemin sensible tel qu'il est écrit (P03 de L8a, §4.5), ou null.
 *
 * `nomsQuiRessemblent` : P03 refuse aussi les DERNIERS segments qui contiennent « credential », « secret », « passw » ou
 * « token ». C'est la règle de la commande (`bash`, où tout mot est un chemin possible) ; une demande d'écriture ne la suit pas,
 * sans quoi `src/token-parser.ts` ou `docs/secrets.md` seraient refusés à l'IA alors qu'ils ne portent aucune clé. Les vrais
 * fichiers de clés (`id_ed25519`, `*privkey*`, `*kubeconfig*`, extensions de clés) restent refusés dans les deux cas.
 */
export function categorieCheminSensible(chemin: string, nomsQuiRessemblent: boolean): OmoForbiddenCategory | null {
  if (typeof chemin !== "string" || chemin === "") return null;
  if (estCheminEnv(chemin)) return "env";
  const segments = segmentsDe(chemin);
  if (segments.some((segment) => memeNom(segment, ".git"))) return "git-interne";
  if (segments.some((segment) => nomDansListe(segment, DOSSIERS_CONFIG))) return "config-extension";
  if (estFichierCle(segments.at(-1) ?? "")) return "fichier-cle";
  const nature = sensitivePath(chemin);
  if (nature === null) return null;
  // « dossier » (.ssh, .kube, .gnupg, .aws, secrets…), « identifiants » (.netrc, auth.json…) et « cle » (extensions) : toujours.
  return nature === "nom" && !nomsQuiRessemblent ? null : "fichier-cle";
}

/**
 * Catégorie d'un chemin d'ÉCRITURE déjà ramené au projet ouvert (relatif, séparateur « / ») : clés et `.env*`, `.git/**`, noms de
 * configuration de L19a, fichiers d'IDE et de CI (liste fixe de L23a et cibles relevées de la configuration git). Null si rien ne
 * s'y oppose.
 */
export function categorieEcritureDansProjet(relatif: string, ideCiDynamiques: readonly string[] = []): OmoForbiddenCategory | null {
  const segments = segmentsDe(relatif);
  // Écriture sur la racine du projet elle-même : jamais un fichier, donc jamais une demande légitime.
  if (segments.length === 0) return "hors-projet";
  const sensible = categorieCheminSensible(relatif, false);
  if (sensible !== null) return sensible;
  const chemin = segments.join("/");
  // Noms de configuration de L19a (dont `.agents/`), sur chaque segment, et `.omo/omo.json[c]` sous le dossier d'état.
  for (const [index, segment] of segments.entries()) {
    if (nomDansListe(segment, NOMS_CONFIG_EXTENSION) || nomDansListe(segment, NOMS_CONFIG_OPENCODE)) return "config-extension";
    const suivant = segments[index + 1];
    if (memeNom(segment, DOSSIER_ETAT_OMO) && suivant !== undefined && nomDansListe(suivant, NOMS_DANS_OMO_REFUSES)) return "config-extension";
  }
  if (OMO_IDE_CI_NOMS.some((nom) => couvre(chemin, nom))) return "ide-ci";
  if (AZURE_PIPELINES.test(segments[0] ?? "")) return "ide-ci";
  for (const cible of ideCiDynamiques) {
    if (typeof cible !== "string") continue;
    const cibleRelative = segmentsDe(cible).join("/");
    if (cibleRelative !== "" && (couvre(chemin, cibleRelative) || couvre(cibleRelative, chemin))) return "ide-ci";
  }
  return null;
}

// --- Commandes (outil `bash`) -----------------------------------------------------------------------------------------------------

/** Mots d'un texte libre : ce que séparent une espace ou un métacaractère de shell. */
const SEPARATEURS = /[\s;|&()<>{}$`"']+/u;

/** Caractères qui séparent deux commandes dans un texte que la porte de L8a n'a pas découpé (ou dans un mot cité). */
const ENCHAINEMENTS = /[;|&()<>{}`\n\r]+/u;

/** Enveloppes de S4 : le programme qu'elles lancent est un mot qui suit (`env … curl`, `sudo docker`, `timeout 5 kubectl`). */
const ENVELOPPES: ReadonlySet<string> = new Set(SHELL_FORBIDDEN.enveloppes.map((nom) => nom.toLowerCase()));

/** Nom du programme d'un mot : dernier segment, sans le dossier (`/usr/bin/curl` → `curl`). */
function nomProgramme(mot: string): string {
  return segmentsDe(mot).at(-1) ?? "";
}

/** Vrai si ce mot est une affectation de variable placée avant le programme (`FOO=1 curl …`). */
const estAffectation = (mot: string) => /^[A-Za-z_]\w*=/u.test(mot);

/** Programme candidat : sa position dans une suite de mots. */
interface CommandeCandidate {
  mots: readonly string[];
  depart: number;
}

/**
 * Programmes candidats d'une suite de mots : le premier mot qui n'est pas une affectation, puis, dès qu'une enveloppe est vue,
 * TOUS les mots qui suivent (plus strict : ni `timeout 5 curl`, ni `xargs -I {} kubectl`, ni `env FOO=1 docker` ne passent).
 */
function candidates(mots: readonly string[]): CommandeCandidate[] {
  const out: CommandeCandidate[] = [];
  let premierVu = false;
  let enveloppeVue = false;
  for (const [index, mot] of mots.entries()) {
    if (estAffectation(mot)) continue;
    if (!premierVu || enveloppeVue) {
      out.push({ mots, depart: index });
      premierVu = true;
    }
    if (ENVELOPPES.has(nomProgramme(mot).toLowerCase())) enveloppeVue = true;
  }
  return out;
}

/** Catégorie S4 du programme d'une commande candidate : « réseau » et « production » seulement (§4.5, Q2), ou null. */
function categorieProgramme(commande: CommandeCandidate): OmoForbiddenCategory | null {
  const categorie = forbiddenCategory(nomProgramme(commande.mots[commande.depart] ?? ""));
  if (categorie === "reseau") return "reseau";
  return categorie === "production" ? "production" : null;
}

/** Sous-commandes git refusées dans la salle (§4.1, §4.5 : envoi git). */
const GIT_SOUS_COMMANDES_REFUSEES: readonly string[] = Object.freeze(["push", "remote"]);

/** Options globales de git qui prennent une valeur séparée (`git -c x=y`, `git -C /ailleurs`). */
const GIT_OPTIONS_A_VALEUR: readonly string[] = Object.freeze(["-c", "-C"]);

/**
 * Catégorie d'une commande git : d'abord toute option globale placée avant la sous-commande (`-c`, `-C`, `--git-dir`,
 * `--exec-path`, `--work-tree`, `--config-env`, collées ou non à leur valeur), puis `push` et `remote`. Les autres
 * sous-commandes passent (décision n° 7).
 */
function categorieGit(commande: CommandeCandidate): OmoForbiddenCategory | null {
  if (!memeNom(nomProgramme(commande.mots[commande.depart] ?? ""), "git")) return null;
  for (let index = commande.depart + 1; index < commande.mots.length; index++) {
    const mot = commande.mots[index] ?? "";
    if (!mot.startsWith("-")) return nomDansListe(mot, GIT_SOUS_COMMANDES_REFUSEES) ? "git-envoi" : null;
    const nom = mot.includes("=") ? mot.slice(0, mot.indexOf("=")) : mot;
    if (GIT_GLOBAL_OPTIONS.includes(nom)) return "git-options-globales";
    // Option courte collée à sa valeur (`-C/ailleurs`, `-cuser.name=x`).
    if (GIT_OPTIONS_A_VALEUR.some((option) => mot.startsWith(option) && mot.length > option.length)) return "git-options-globales";
    if (GIT_OPTIONS_A_VALEUR.includes(nom)) index++;
  }
  return null;
}

/** Fragments de commande d'un texte libre : une suite de mots par morceau séparé par un enchaînement. */
function fragmentsDe(texte: string): string[][] {
  return texte
    .split(ENCHAINEMENTS)
    .map((morceau) => morceau.split(SEPARATEURS).filter((mot) => mot !== ""))
    .filter((mots) => mots.length > 0);
}

/** Suite de mots à analyser, et ce que ses mots valent comme chemins. */
interface Suite {
  mots: readonly string[];
  /** Mots du découpage de L8a : P03 s'y applique entièrement, comme dans l'instance principale. */
  premierNiveau: boolean;
}

/**
 * Suites de mots d'une commande : le découpage de L8a, puis le contenu de chaque mot cité, découpé à son tour (`sh -c 'git
 * push'`). Texte refusé par L8a (métacaractère, caractère hors ASCII, longueur) : fragments du texte entier.
 */
function suitesDeMots(texte: string): Suite[] {
  const decoupe = tokenizeCommand(texte);
  if (!decoupe.ok) return fragmentsDe(texte).map((mots) => ({ mots, premierNiveau: false }));
  const suites: Suite[] = [{ mots: decoupe.words.map((mot) => mot.value), premierNiveau: true }];
  for (const mot of decoupe.words) {
    if (!mot.quoted) continue;
    for (const mots of fragmentsDe(mot.value)) suites.push({ mots, premierNiveau: false });
  }
  return suites;
}

/** Interdits d'une commande `bash` : S4 « réseau » et « production », git, puis les chemins sensibles de chaque mot. */
export function categorieCommande(texte: string): OmoForbiddenCategory | null {
  const suites = suitesDeMots(texte);
  for (const suite of suites) {
    for (const commande of candidates(suite.mots)) {
      const programme = categorieProgramme(commande);
      if (programme !== null) return programme;
      const git = categorieGit(commande);
      if (git !== null) return git;
    }
  }
  for (const suite of suites) {
    for (const mot of suite.mots) {
      const chemin = categorieCheminSensible(mot, suite.premierNiveau);
      if (chemin !== null) return chemin;
    }
  }
  return null;
}

// --- Chemins d'une demande d'écriture ---------------------------------------------------------------------------------------------

/** Longueur maximale d'un chemin lu dans des métadonnées : au-delà, il n'est pas exploitable (fermé en cas de doute). */
const CHEMIN_MAX = 4_096;

/** Nombre maximal de fichiers lus dans un correctif : un correctif plus gros est refusé par le premier chemin qui pèche. */
const FICHIERS_MAX = 256;

const estChaineUtile = (valeur: unknown): valeur is string => typeof valeur === "string" && valeur !== "" && valeur.length <= CHEMIN_MAX;

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/**
 * Chemins d'écriture d'une demande (formes relevées par la mesure MX1) : `metadata.files[]` quand il est là (`filePath`,
 * `movePath`, à défaut `relativePath`), sinon `metadata.filepath`. Le `filepath` d'un correctif multiple est la liste des
 * fichiers jointe par « , » : chaque morceau est contrôlé (plus strict, jamais plus permissif).
 */
export function cheminsEcriture(metadata: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ajouter = (valeur: unknown) => {
    if (estChaineUtile(valeur)) out.push(valeur);
  };
  const fichiers = metadata.files;
  if (Array.isArray(fichiers)) {
    for (const fichier of fichiers.slice(0, FICHIERS_MAX)) {
      if (!estObjet(fichier)) continue;
      if (estChaineUtile(fichier.filePath)) ajouter(fichier.filePath);
      else ajouter(fichier.relativePath);
      ajouter(fichier.movePath);
    }
  }
  if (out.length > 0) return out;
  const unique = estChaineUtile(metadata.filepath) ? metadata.filepath : estChaineUtile(metadata.filePath) ? metadata.filePath : null;
  if (unique === null) return out;
  for (const morceau of unique.split(", ")) ajouter(morceau.trim());
  return out;
}

/** Permissions publiées pour une écriture : opencode range `edit`, `write` et `apply_patch` sous « edit » (MX1). */
const PERMISSIONS_ECRITURE: readonly string[] = Object.freeze(["edit", "write", "apply_patch", "patch", "multiedit", "hashline_edit"]);

/** Permissions du web, refusées sans condition (décision du 19/09 n° 7). */
const PERMISSIONS_WEB: readonly string[] = Object.freeze(["webfetch", "websearch"]);

// --- Portillon ---------------------------------------------------------------------------------------------------------------------

/**
 * Verdict du portillon P9 pour UNE demande de la salle : « once », ou le refus et sa catégorie. Aucune attente, aucun accord
 * possible (décision n° 6). Une demande qu'aucun interdit ne vise passe : la lecture des clés, elle, est refusée en amont par la
 * configuration d'instance (§4.1) et par le filet de L24.
 */
export function classifyOmoPermission(demande: OmoForbiddenDemande, ctx: OmoForbiddenContext): OmoPermissionVerdict {
  const permission = typeof demande?.permission === "string" ? demande.permission.toLowerCase() : "";
  const metadata = estObjet(demande?.metadata) ? demande.metadata : {};
  if (permission === "external_directory") return interdit("hors-projet");
  if (PERMISSIONS_WEB.includes(permission)) return interdit("web");
  if (permission === "bash") {
    const texte = typeof metadata.command === "string" ? metadata.command : "";
    // Commande illisible : rien ne dit qu'elle reste dans le projet ouvert (fermé en cas de doute).
    if (texte === "") return interdit("hors-projet");
    const categorie = categorieCommande(texte);
    return categorie === null ? ONCE : interdit(categorie);
  }
  if (PERMISSIONS_ECRITURE.includes(permission)) return verdictEcriture(metadata, ctx);
  return ONCE;
}

/** Verdict d'une demande d'écriture : hors du projet ouvert d'abord, puis ce que le chemin porte dans le projet. */
function verdictEcriture(metadata: Record<string, unknown>, ctx: OmoForbiddenContext): OmoPermissionVerdict {
  const projet = typeof ctx?.projetOuvert === "string" && ctx.projetOuvert.startsWith("/") ? resoudre("/", ctx.projetOuvert) : null;
  // Projet ouvert inconnu : aucun chemin ne peut être dit « dans le projet ».
  if (projet === null) return interdit("hors-projet");
  const chemins = cheminsEcriture(metadata);
  // Aucun chemin lisible : la demande n'est pas contrôlable (fermé en cas de doute).
  if (chemins.length === 0) return interdit("hors-projet");
  const dynamiques = Array.isArray(ctx?.ideCiDynamiques) ? ctx.ideCiDynamiques : [];
  for (const chemin of chemins) {
    const relatif = dedans(projet, resoudre(projet, chemin));
    if (relatif === null) return interdit("hors-projet");
    const categorie = categorieEcritureDansProjet(relatif, dynamiques);
    if (categorie !== null) return interdit(categorie);
  }
  return ONCE;
}
