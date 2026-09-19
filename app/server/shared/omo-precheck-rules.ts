// Pré-contrôle d'un projet de la Salle OMO : RÈGLES PURES (spécification §3.15.2 l.523-530, §3.7 l.309, F-t l.176, F-u l.177,
// F-z l.182, §9.3 n° 11 l.1409, §7.5 l.1147, G8 l.1222, JS-4 ; plan d'exécution 2 bis-2 ter §6 L19a, D-2b-19, D-2b-34, D-2b-35).
// Ce module ne touche à aucun disque : il dit quels NOMS sont refusés et, à partir des faits relevés par le lecteur
// (omo-precheck-reader.ts), rend la décision par projet. Module pur (server/shared) : aucun module node, aucun accès à process
// (test de pureté de core.test.ts, repris par T-L19-h).
//
// Portée (D-2b-19) : les noms sont cherchés à la racine du projet ET de chaque dossier parent jusqu'à /workspace inclus, SANS
// descente récursive. Plus bas, la lecture est refusée par la configuration d'instance et par les interdits absolus (§4.14.3).
// Seule exception à « sans descente » : le dossier .omo, ouvert d'un niveau, parce que l'extension le crée elle-même et que seuls
// omo.json et omo.jsonc y sont refusés (§9.3 n° 11) ; .omo/boulder*.json, .omo/plans/ et .omo/notepads/ sont acceptés.
//
// Fermé en cas de doute : lien symbolique, dossier illisible, profondeur au-delà de 256, projet hors de /workspace, projet non
// préparé, empreintes hors bornes. Aucun de ces cas ne laisse passer un projet.
import { KEY_FILE_READ_RULES } from "./assistant-rules.ts";

// --- Raisons (union propre à L19a ; égalité avec OmoPrecheckReason de T3a vérifiée au train de V0, plan §2.2) ------------------

/**
 * Raison d'un projet refusé au pré-contrôle :
 * - config-extension : .omo/omo.json[c], oh-my-openagent.json[c], oh-my-opencode.json[c], .sisyphus/, .agents/ (D-2b-34) ;
 * - config-opencode : .opencode/, opencode.json[c], .claude/, .mcp.json ;
 * - fichier-cle : fichier de clés à la racine du projet ou d'un parent jusqu'à /workspace (D-2b-19) ;
 * - lien-symbolique, illisible, profondeur, hors-workspace : doute, refus ;
 * - non-prepare : projet absent de omo-projets.json (« relancez install.ps1 », §9.4 n° 2) ;
 * - empreinte-impossible : empreintes des fichiers d'IDE et de CI hors bornes.
 */
export type OmoPrecheckReason =
  | "config-extension"
  | "config-opencode"
  | "fichier-cle"
  | "lien-symbolique"
  | "illisible"
  | "profondeur"
  | "hors-workspace"
  | "non-prepare"
  | "empreinte-impossible";

/** Liste fermée des raisons, comparée à celle de T3a au train de V0. */
export const OMO_PRECHECK_REASONS: readonly OmoPrecheckReason[] = Object.freeze([
  "config-extension",
  "config-opencode",
  "fichier-cle",
  "lien-symbolique",
  "illisible",
  "profondeur",
  "hors-workspace",
  "non-prepare",
  "empreinte-impossible",
]);

// --- Bornes (§3.15.2 : « profondeur supérieure à 256 » ; empreintes bornées) ---------------------------------------------------

/** Bornes du pré-contrôle. Un test peut en passer de plus petites au lecteur ; la production garde ces valeurs. */
export interface PrecheckBornes {
  /** F-u : l'extension remonte 256 parents ; au-delà, l'inventaire serait tronqué → refus. */
  profondeurMax: number;
  /** Nombre de fichiers dont l'empreinte est relevée, par dossier contrôlé. */
  empreintesMaxFichiers: number;
  /** Taille d'un fichier dont l'empreinte est relevée. */
  empreinteTailleMaxOctets: number;
  /** Entrées lues d'un seul dossier : un dossier plus peuplé est un doute, pas une lecture sans fin (même ordre que D-2b-28). */
  entreesMaxParDossier: number;
  /** Niveaux descendus dans un dossier d'IDE ou de CI : un dépôt piégé ne fait pas déborder la pile. */
  profondeurRelevesMax: number;
  /** Chemins listés dans le refus. */
  trouvesMax: number;
  /** Entrées lues par le relevé des dépôts git du dossier de travail (activation) : même plafond que le balayage de la salle. */
  balayageGitEntreesMax: number;
  /**
   * Fichiers signalés (package.json, Makefile, *.ps1) relevés SOUS la racine d'un dossier contrôlé. Au-delà, la liste à relire est
   * dite incomplète (`signalesIncomplet`) : un fichier signalé n'arrête rien, il ne doit pas non plus refuser un projet ordinaire.
   */
  signalesMaxFichiers: number;
  /** Entrées lues par la descente des fichiers signalés, par dossier contrôlé ; au-delà, liste incomplète, jamais un refus. */
  signalesEntreesMax: number;
  /** Taille d'un fichier de configuration git lu (.git/config et fichiers inclus) ; au-delà, empreinte impossible (refus). */
  configGitTailleMaxOctets: number;
  /** Fichiers de configuration git lus par dossier contrôlé, inclusions comprises ; au-delà, empreinte impossible (refus). */
  configGitFichiersMax: number;
}

export const PRECHECK_BORNES: Readonly<PrecheckBornes> = Object.freeze({
  profondeurMax: 256,
  empreintesMaxFichiers: 2000,
  empreinteTailleMaxOctets: 1024 * 1024,
  entreesMaxParDossier: 200_000,
  profondeurRelevesMax: 64,
  trouvesMax: 20,
  balayageGitEntreesMax: 200_000,
  signalesMaxFichiers: 2000,
  signalesEntreesMax: 100_000,
  configGitTailleMaxOctets: 64 * 1024,
  configGitFichiersMax: 10,
});

// --- Noms refusés (F-t, F-u, F-z, JS-4, D-2b-34) -------------------------------------------------------------------------------

/** Noms refusés qui viennent de l'extension : raison config-extension. Un nom porté par un fichier OU par un dossier est refusé. */
export const NOMS_CONFIG_EXTENSION: readonly string[] = Object.freeze([
  ".agents",
  ".sisyphus",
  "oh-my-openagent.json",
  "oh-my-openagent.jsonc",
  "oh-my-opencode.json",
  "oh-my-opencode.jsonc",
]);

/** Noms refusés qui viennent d'opencode ou d'un autre assistant : raison config-opencode. */
export const NOMS_CONFIG_OPENCODE: readonly string[] = Object.freeze([
  ".claude",
  ".mcp.json",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
]);

/** Dossier d'état de l'extension : accepté, ouvert d'un seul niveau (§9.3 n° 11). */
export const DOSSIER_ETAT_OMO = ".omo";

/** Entrées refusées DANS .omo (F-u) : la configuration de l'extension. */
export const NOMS_DANS_OMO_REFUSES: readonly string[] = Object.freeze(["omo.json", "omo.jsonc"]);

/** Entrées d'état créées par l'extension elle-même, citées par la spécification comme acceptées (T-L19-c). */
export const NOMS_DANS_OMO_ACCEPTES: readonly string[] = Object.freeze(["boulder.json", "notepads", "plans"]);

// --- Fichiers de clés (motifs de KEY_FILE_READ_RULES, importé sans modification, et extensions P03 l.662) ----------------------

/** Extensions sensibles de la règle S5 P03 (spécification l.662), sans le point. */
export const EXTENSIONS_CLE_P03: readonly string[] = Object.freeze([
  "asc",
  "cer",
  "crt",
  "der",
  "gpg",
  "jks",
  "kdbx",
  "key",
  "keystore",
  "ovpn",
  "p12",
  "p8",
  "pem",
  "pfx",
  "tfstate",
  "tfvars",
]);

/** Motif glob (« * » = n'importe quoi sauf « / ») compilé en expression régulière ancrée, casse ignorée. */
function motifEnRegExp(motif: string): RegExp {
  const echappe = motif.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${echappe}$`, "iu");
}

/**
 * Motifs de KEY_FILE_READ_RULES à refuser (tout ce qui n'est pas `allow`) et à laisser passer (`allow`, c'est-à-dire
 * *.env.example). Les motifs qui portent un « / » (*.kube/config) sont laissés de côté : sans descente récursive, un nom
 * d'entrée n'en contient jamais. La casse est ignorée : la liste porte déjà *.key et *.KEY, et les disques de l'utilisateur
 * ne distinguent pas la casse (fermé en cas de doute).
 */
const MOTIFS_CLE_REFUSES: readonly RegExp[] = Object.freeze([
  ...Object.entries(KEY_FILE_READ_RULES)
    .filter(([motif, action]) => action !== "allow" && !motif.includes("/"))
    .map(([motif]) => motifEnRegExp(motif)),
  ...EXTENSIONS_CLE_P03.map((ext) => motifEnRegExp(`*.${ext}`)),
]);

const MOTIFS_CLE_ACCEPTES: readonly RegExp[] = Object.freeze(
  Object.entries(KEY_FILE_READ_RULES)
    .filter(([motif, action]) => action === "allow" && !motif.includes("/"))
    .map(([motif]) => motifEnRegExp(motif)),
);

/** Vrai si ce nom d'entrée est un fichier de clés (ou un .env, hors .env.example). */
export function estFichierCle(nom: string): boolean {
  if (MOTIFS_CLE_ACCEPTES.some((re) => re.test(nom))) return false;
  return MOTIFS_CLE_REFUSES.some((re) => re.test(nom));
}

// --- Classement d'un nom -------------------------------------------------------------------------------------------------------

/**
 * Deux noms d'entrée sont le même nom, sans tenir compte de la casse. Le dossier de travail est un dossier Windows monté dans
 * un conteneur Linux : `readdir` y rend « OpenCode.json » tel quel, mais une recherche de « opencode.json » par opencode ou par
 * l'extension le trouve (sonde L19a du 18/09, Docker Desktop : `.SISYPHUS` et `.OMO/Omo.JSON` aussi). Une comparaison exacte
 * laisserait passer ces pièges ; sur un disque qui distingue la casse, cette comparaison refuse seulement un peu plus (fermé en
 * cas de doute). Le repliement se limite aux minuscules : le même disque distingue `ſ` de `s` et `ı` de `i`.
 */
export function memeNom(nom: string, reference: string): boolean {
  return nom.toLowerCase() === reference.toLowerCase();
}

/** Vrai si `nom` est l'un des noms de la liste, sans tenir compte de la casse (voir `memeNom`). */
export function nomDansListe(nom: string, liste: readonly string[]): boolean {
  return liste.some((reference) => memeNom(nom, reference));
}

/** Vrai si cette entrée est le dossier d'état de l'extension (`.omo`, quelle que soit sa casse). */
export function estDossierEtatOmo(nom: string): boolean {
  return memeNom(nom, DOSSIER_ETAT_OMO);
}

/** Raisons qu'un NOM peut porter à lui seul. */
export type PrecheckNomRaison = Extract<OmoPrecheckReason, "config-extension" | "config-opencode" | "fichier-cle">;

/** Raison portée par le nom d'une entrée d'un dossier contrôlé (projet ou parent), null si le nom ne dit rien. */
export function raisonDuNom(nom: string): PrecheckNomRaison | null {
  if (nomDansListe(nom, NOMS_CONFIG_EXTENSION)) return "config-extension";
  if (nomDansListe(nom, NOMS_CONFIG_OPENCODE)) return "config-opencode";
  if (estFichierCle(nom)) return "fichier-cle";
  return null;
}

/** Raison portée par le nom d'une entrée DANS .omo : seule la configuration de l'extension est refusée (§9.3 n° 11). */
export function raisonDansDossierOmo(nom: string): Extract<OmoPrecheckReason, "config-extension"> | null {
  return nomDansListe(nom, NOMS_DANS_OMO_REFUSES) ? "config-extension" : null;
}

// --- Faits relevés par le lecteur ----------------------------------------------------------------------------------------------

/** Raisons qu'un fait trouvé sur le disque peut porter (les autres viennent de la forme du projet ou des bornes). */
export type PrecheckTrouveRaison = Extract<
  OmoPrecheckReason,
  "config-extension" | "config-opencode" | "fichier-cle" | "lien-symbolique" | "illisible"
>;

/** Un piège trouvé, sans chemin absolu : la remontée dit où, le nom dit quoi. */
export interface PrecheckTrouve {
  /** 0 = le projet lui-même, 1 = son parent, … jusqu'à /workspace. */
  remontee: number;
  /**
   * Nom de l'entrée tel qu'il est sur le disque (« opencode.json », « .omo/omo.json », « OpenCode.json »), vide si c'est le
   * dossier entier qui est en cause.
   */
  nom: string;
  raison: PrecheckTrouveRaison;
}

/** Faits d'un projet, relevés par omo-precheck-reader.ts. Aucun contenu de fichier n'y figure. */
export interface PrecheckFaits {
  /** Chemin du projet relatif à /workspace (« . » pour /workspace lui-même). */
  projet: string;
  /** Le chemin résolu sort de /workspace (ou le remonte par « .. »). */
  horsWorkspace: boolean;
  /** Le projet figure dans la liste des projets préparés (§9.4 n° 2). */
  prepare: boolean;
  /** La remontée vers /workspace dépasse la borne de profondeur. */
  profondeurDepassee: boolean;
  /** Les bornes des empreintes sont atteintes : la référence de la détection §4.14.5 ne peut pas être posée. */
  empreinteImpossible: boolean;
  trouves: readonly PrecheckTrouve[];
}

/** Décision par projet (forme de OmoPrecheckProjectResult, T3a). */
export interface PrecheckDecision {
  projet: string;
  verdict: "conforme" | "refuse";
  /** null si conforme. */
  raison: OmoPrecheckReason | null;
  /** Chemins masqués, relatifs au projet, `trouvesMax` au plus. */
  trouves: string[];
}

/**
 * Ordre de nomination des raisons. La forme du projet vient d'abord (sans elle, on ne sait pas quoi contrôler), puis les pièges
 * trouvés, nommés avant les doutes parce qu'ils sont actionnables, puis les doutes de la remontée, puis les bornes. Quelle que
 * soit la raison retenue, le verdict reste « refuse » : un seul fait suffit (fermé en cas de doute).
 */
const ORDRE_RAISONS: readonly OmoPrecheckReason[] = Object.freeze([
  "hors-workspace",
  "non-prepare",
  "profondeur",
  "config-extension",
  "config-opencode",
  "fichier-cle",
  "lien-symbolique",
  "illisible",
  "empreinte-impossible",
]);

/** Extension gardée en clair dans un chemin masqué : elle dit la nature du fichier sans rien dire de son nom. */
const EXTENSION_AFFICHABLE = /^\.[A-Za-z0-9]{1,12}$/;

/**
 * Chemin d'un piège, relatif au projet et masqué : « . » ou « ../… » dit à quelle hauteur, jamais un chemin absolu, jamais le
 * dossier de travail. Les noms montrés en clair sont ceux de la liste fermée (opencode.json, .sisyphus…, casse du disque
 * gardée pour que l'utilisateur retrouve l'entrée) : ils ne disent rien qu'il ne sache déjà. Le nom d'un FICHIER DE CLÉS, lui, est choisi par
 * l'utilisateur et peut nommer un client, un environnement ou un service : il est réduit à « **** » suivi de sa seule
 * extension.
 */
export function cheminMasque(trouve: PrecheckTrouve): string {
  const prefixe = trouve.remontee === 0 ? "." : Array.from({ length: trouve.remontee }, () => "..").join("/");
  if (trouve.nom === "") return prefixe;
  return `${prefixe}/${trouve.raison === "fichier-cle" ? nomMasque(trouve.nom) : trouve.nom}`;
}

function nomMasque(nom: string): string {
  const point = nom.lastIndexOf(".");
  const extension = point > 0 ? nom.slice(point) : "";
  return EXTENSION_AFFICHABLE.test(extension) ? `****${extension.toLowerCase()}` : "****";
}

/**
 * Décision du pré-contrôle. Fermée en cas de doute : tout fait relevé refuse le projet ; un projet sans aucun fait est conforme.
 * La liste rendue est masquée, relative et bornée (T-L19-g).
 */
export function decidePrecheck(faits: PrecheckFaits, bornes: Readonly<PrecheckBornes> = PRECHECK_BORNES): PrecheckDecision {
  const raisons = new Set<OmoPrecheckReason>();
  if (faits.horsWorkspace) raisons.add("hors-workspace");
  if (!faits.prepare) raisons.add("non-prepare");
  if (faits.profondeurDepassee) raisons.add("profondeur");
  if (faits.empreinteImpossible) raisons.add("empreinte-impossible");
  for (const trouve of faits.trouves) raisons.add(trouve.raison);
  const raison = ORDRE_RAISONS.find((candidate) => raisons.has(candidate)) ?? null;
  if (raison === null) return { projet: faits.projet, verdict: "conforme", raison: null, trouves: [] };
  const chemins: string[] = [];
  for (const trouve of [...faits.trouves].sort(comparerTrouves)) {
    const chemin = cheminMasque(trouve);
    if (!chemins.includes(chemin)) chemins.push(chemin);
    if (chemins.length >= bornes.trouvesMax) break;
  }
  return { projet: faits.projet, verdict: "refuse", raison, trouves: chemins };
}

// --- Configuration git : ce qui désigne des fichiers de l'arbre de travail (S6/G04, §4.5) ------------------------------------------

/**
 * Ce qu'une configuration git fait exécuter ou lire HORS de `.git` : le `.git` en lecture seule ne protège pas ces cibles, qui sont
 * des fichiers ordinaires du projet. Valeurs brutes, dans l'ordre du fichier (git retient la dernière ; toutes sont surveillées).
 */
export interface ConfigGitCibles {
  /** core.hooksPath : dossier des hooks, relatif à la racine de l'arbre de travail. */
  hooksPath: string[];
  /** core.fsmonitor quand c'est un programme (pas un booléen) : lancé à chaque `git status`. */
  fsmonitor: string[];
  /** include.path et includeIf.<condition>.path, quelle que soit la condition : relatifs au fichier qui les porte. */
  includes: string[];
}

const NOM_SECTION = /^[A-Za-z0-9.-]+$/;
const NOM_CLE = /^[A-Za-z][A-Za-z0-9-]*/;
const BOOLEENS_GIT = new Set(["", "true", "false", "yes", "no", "on", "off", "1", "0"]);
/** Marque d'ordre des octets qu'un éditeur Windows peut poser en tête du fichier ; git l'ignore. */
const MARQUE_ORDRE_OCTETS = String.fromCharCode(0xfeff);
const ECHAPPEMENTS_GIT: Readonly<Record<string, string>> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };

/** En-tête de section : « [nom] », « [nom "sous-section"] » ou « [nom.sous] » ; rend la section et la suite de la ligne. */
function lireEnTete(ligne: string): { section: string; sous: string | null; reste: string } | null {
  let i = ligne.indexOf("[") + 1;
  let nom = "";
  while (i < ligne.length && ligne[i] !== "]" && ligne[i] !== " " && ligne[i] !== "\t") nom += ligne[i++];
  if (!NOM_SECTION.test(nom)) return null;
  let sous: string | null = null;
  const point = nom.indexOf(".");
  if (point >= 0) {
    sous = nom.slice(point + 1);
    nom = nom.slice(0, point);
  }
  while (ligne[i] === " " || ligne[i] === "\t") i++;
  if (ligne[i] === '"') {
    if (sous !== null) return null;
    sous = "";
    i++;
    for (;;) {
      const c = ligne[i++];
      if (c === undefined) return null;
      if (c === '"') break;
      if (c === "\\") {
        const suivant = ligne[i++];
        if (suivant === undefined) return null;
        sous += suivant;
      } else sous += c;
    }
  }
  if (ligne[i] !== "]") return null;
  return { section: nom.toLowerCase(), sous, reste: ligne.slice(i + 1) };
}

/**
 * Valeur d'une clé, à partir de `debut` dans `lignes[indice]` : guillemets, échappements de git, commentaires « # » et « ; » hors
 * guillemets, blancs de fin retirés, suite sur la ligne suivante après une barre oblique inverse finale. `null` si mal formée.
 */
function lireValeur(lignes: readonly string[], indice: number, debut: number): { valeur: string; derniere: number } | null {
  let valeur = "";
  let blancs = "";
  let guillemets = false;
  let ligne = lignes[indice] ?? "";
  let i = debut;
  let courante = indice;
  for (;;) {
    if (i >= ligne.length) {
      if (guillemets) return null;
      return { valeur, derniere: courante };
    }
    const c = ligne[i++] ?? "";
    if (c === "\\") {
      if (i >= ligne.length) {
        // Suite sur la ligne suivante.
        courante++;
        if (courante >= lignes.length) return null;
        ligne = lignes[courante] ?? "";
        i = 0;
        continue;
      }
      const echappe = ECHAPPEMENTS_GIT[ligne[i++] ?? ""];
      if (echappe === undefined) return null;
      valeur += blancs + echappe;
      blancs = "";
      continue;
    }
    if (c === '"') {
      guillemets = !guillemets;
      valeur += blancs;
      blancs = "";
      continue;
    }
    if (!guillemets && (c === "#" || c === ";")) return { valeur, derniere: courante };
    if (!guillemets && (c === " " || c === "\t")) {
      if (valeur !== "") blancs += c;
      continue;
    }
    valeur += blancs + c;
    blancs = "";
  }
}

/**
 * Lecture PURE d'un fichier de configuration git (format de `git config`, noms de section et de clé sans casse, sous-sections
 * avec) : rend les cibles qui désignent des fichiers hors de `.git`. `null` si le texte n'est pas analysable (section ou clé mal
 * formée, guillemet non fermé, échappement inconnu, clé hors section) : le lecteur en fait un doute, donc un refus.
 */
export function analyserConfigGit(texte: string): ConfigGitCibles | null {
  const cibles: ConfigGitCibles = { hooksPath: [], fsmonitor: [], includes: [] };
  const lignes = (texte.startsWith(MARQUE_ORDRE_OCTETS) ? texte.slice(1) : texte).split(/\r?\n/);
  let section: { nom: string; sous: string | null } | null = null;
  for (let indice = 0; indice < lignes.length; indice++) {
    let ligne = (lignes[indice] ?? "").replace(/^[ \t]+/, "");
    if (ligne === "" || ligne.startsWith("#") || ligne.startsWith(";")) continue;
    if (ligne.startsWith("[")) {
      const entete = lireEnTete(ligne);
      if (entete === null) return null;
      section = { nom: entete.section, sous: entete.sous };
      ligne = entete.reste.replace(/^[ \t]+/, "");
      if (ligne === "" || ligne.startsWith("#") || ligne.startsWith(";")) continue;
    }
    const cle = NOM_CLE.exec(ligne)?.[0];
    if (cle === undefined || section === null) return null;
    let apres = ligne.slice(cle.length).replace(/^[ \t]+/, "");
    let valeur: string | null = null;
    if (apres.startsWith("=")) {
      apres = apres.slice(1);
      const debut = (lignes[indice] ?? "").length - apres.length;
      const lue = lireValeur(lignes, indice, debut);
      if (lue === null) return null;
      valeur = lue.valeur;
      indice = lue.derniere;
    } else if (apres !== "" && !apres.startsWith("#") && !apres.startsWith(";")) {
      return null;
    }
    const nomCle = cle.toLowerCase();
    if (valeur === null) continue; // Clé booléenne sans valeur : ne désigne aucun fichier.
    if (section.nom === "core" && section.sous === null && nomCle === "hookspath") cibles.hooksPath.push(valeur);
    else if (section.nom === "core" && section.sous === null && nomCle === "fsmonitor" && !BOOLEENS_GIT.has(valeur.toLowerCase())) cibles.fsmonitor.push(valeur);
    else if (section.nom === "include" && section.sous === null && nomCle === "path") cibles.includes.push(valeur);
    else if (section.nom === "includeif" && section.sous !== null && nomCle === "path") cibles.includes.push(valeur);
  }
  return cibles;
}

// --- Dépôts git hors de la protection d'install.ps1 (D-2b-28, §4.14.2, fiche L22c) ----------------------------------------------

/** Chemin relatif normalisé : séparateurs « / », sans « ./ » ni « / » en tête ou en fin. */
function normaliserRelatif(chemin: string): string {
  return chemin
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * Dépôts git trouvés dans le dossier de travail (`.git` de toute forme, dépôts nus) qu'aucune entrée de `gitProteges`
 * (omo-projets.json, écrit par install.ps1, que la salle ne peut pas réécrire) ne couvre. Une entrée nomme le dossier du dépôt
 * (« alpha ») ou son `.git` (« alpha/.git ») : les deux formes sont acceptées tant que L15c n'a pas fixé la sienne. Comparaison
 * exacte, casse comprise (fermé en cas de doute). Sert à l'activation (§4.14.2) : le `workspaceGit` de state.json date du
 * démarrage de la salle, et un dépôt cloné depuis n'y est pas. Rend les chemins triés, sans doublon.
 */
export function gitsHorsProtection(trouves: readonly string[], gitProteges: readonly { chemin: string; forme: "dossier" | "fichier" }[]): string[] {
  const couverts = new Set<string>();
  for (const entree of gitProteges) {
    const chemin = normaliserRelatif(entree.chemin);
    if (chemin === "") continue;
    couverts.add(chemin);
    couverts.add(`${chemin}/.git`);
  }
  const hors = new Set<string>();
  for (const trouve of trouves) {
    const chemin = normaliserRelatif(trouve);
    if (!couverts.has(chemin)) hors.add(chemin);
  }
  // Tri par unités UTF-16, comme `<` : l'ordre ne dépend d'aucune langue.
  return [...hors].sort();
}

/** Le plus près du projet d'abord, puis par raison (ordre de nomination), puis par nom : liste stable d'une fois sur l'autre. */
function comparerTrouves(a: PrecheckTrouve, b: PrecheckTrouve): number {
  if (a.remontee !== b.remontee) return a.remontee - b.remontee;
  const rangA = ORDRE_RAISONS.indexOf(a.raison);
  const rangB = ORDRE_RAISONS.indexOf(b.raison);
  if (rangA !== rangB) return rangA - rangB;
  return a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0;
}
