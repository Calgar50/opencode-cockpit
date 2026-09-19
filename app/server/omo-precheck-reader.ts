// Lecteur du pré-contrôle de la Salle OMO (spécification §3.15.2 l.523-530, §7.5 l.1147, G8 l.1222, JS-4 ; plan d'exécution
// 2 bis-2 ter §6 L19a, D-2b-19, D-2b-34, D-2b-35, D-2b-37). Il relève des FAITS sur le disque ; la décision est prise par
// shared/omo-precheck-rules.ts, qui reste pur.
//
// Trois promesses tenues ici :
// 1. **Jamais de suivi de lien** : `lstat` partout, `realpath` seulement sur le dossier de travail et pour vérifier qu'un chemin
//    y reste. Un lien rencontré sur le chemin du projet, sur un nom contrôlé ou dans un fichier d'IDE ou de CI est un doute,
//    donc un refus : le cockpit ne peut pas savoir ce qu'il y a au bout sans le suivre.
// 2. **Tout est borné** : profondeur de la remontée, nombre de fichiers et taille d'un fichier pour les empreintes, nombre de
//    chemins listés. Une borne atteinte refuse le projet (`profondeur`, `empreinte-impossible`) au lieu de tronquer en silence.
//    Seule exception : la descente des fichiers signalés (package.json, Makefile, *.ps1 sous la racine), qui n'arrêtent rien ;
//    une borne y rend la liste à relire incomplète (`signalesIncomplet`), jamais un projet ordinaire refusé.
// 3. **Aucune suppression, aucun écrasement** : `renommerSansSuivreLiens` ne fait que renommer, et seulement vers un nom libre.
import crypto from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  analyserConfigGit,
  decidePrecheck,
  estDossierEtatOmo,
  nomDansListe,
  type PrecheckBornes,
  type PrecheckDecision,
  type PrecheckFaits,
  type PrecheckTrouve,
  PRECHECK_BORNES,
  raisonDansDossierOmo,
  raisonDuNom,
} from "./shared/omo-precheck-rules.ts";

// --- Fichiers dont l'empreinte est relevée (§3.15.2 : « relevé des empreintes des fichiers d'IDE et de CI ») -------------------
// Noms reconnus sans tenir compte de la casse, comme les noms refusés (memeNom) : l'éditeur de l'hôte Windows lit
// « .VSCode/tasks.json » quand il cherche « .vscode/tasks.json ».

/** Dossiers d'IDE et de CI parcourus récursivement, bornes comprises. */
export const DOSSIERS_IDE_CI: readonly string[] = Object.freeze([".devcontainer", ".github", ".husky", ".idea", ".vscode"]);

/** Fichiers de CI relevés à la racine du dossier contrôlé (`azure-pipelines*.yml` est un motif). */
const FICHIERS_CI_RACINE: readonly string[] = Object.freeze([".gitlab-ci.yml", ".pre-commit-config.yaml", "Jenkinsfile"]);
const MOTIFS_CI_RACINE: readonly RegExp[] = Object.freeze([/^azure-pipelines.*\.yml$/iu]);

/**
 * Fichiers signalés à relire (§4.14.5, D-2b-37) : relevés à TOUTE profondeur du dossier contrôlé, comme la détection les juge
 * (omo-detections.ts, `estProgramme`) : à la racine avec les fichiers d'IDE et de CI, puis par une descente à part (sans suivre
 * les liens, `node_modules` et `.git` exclus) qui ne refuse jamais un projet : une borne atteinte y rend seulement la liste à
 * relire incomplète (`signalesIncomplet`).
 */
const FICHIERS_SIGNALES: readonly string[] = Object.freeze(["Makefile", "package.json"]);
const MOTIFS_SIGNALES: readonly RegExp[] = Object.freeze([/\.ps1$/iu]);

/** Dossiers jamais descendus pour les fichiers signalés, casse ignorée (mêmes exclusions que la détection). */
const EXCLUS_DES_SIGNALES: readonly string[] = Object.freeze(["node_modules", ".git"]);

/** Forme du `.git` d'un dossier contrôlé (D-2b-28) : relevée sans suivre le lien. */
export type FormeGit = "dossier" | "fichier" | "lien" | "absent";

export interface EmpreinteFichier {
  /** Chemin relatif à la racine relevée, séparateurs « / ». */
  chemin: string;
  sha256: string;
}

/** Relevé d'un dossier contrôlé : base de la détection §4.14.5. */
export interface ReleveEmpreintes {
  /** Dossier relevé, relatif au dossier de travail (« . » pour le dossier de travail lui-même). */
  racine: string;
  git: FormeGit;
  /** Empreintes triées par chemin. */
  fichiers: EmpreinteFichier[];
  /** Liens rencontrés (non suivis), chemins relatifs. */
  liens: string[];
  /** Chemins illisibles rencontrés. */
  illisibles: string[];
  /** Bornes atteintes : la référence est incomplète → raison `empreinte-impossible`. */
  impossible: boolean;
  /**
   * La descente des fichiers signalés n'a pas tout vu (borne, dossier illisible, lien au nom d'un fichier signalé, fichier trop
   * gros) : la liste « à relire » de fin de demande doit dire qu'elle est incomplète. Jamais un refus, jamais un arrêt.
   */
  signalesIncomplet: boolean;
  /**
   * Cibles de la configuration git dans l'arbre de travail (core.hooksPath, core.fsmonitor, fichiers inclus), relatives à la
   * racine relevée, triées : traitées comme des fichiers d'IDE et de CI par la détection (`OmoDiskSnapshot.ideCiDynamiques`),
   * présentes ou non (git lirait une cible dès qu'elle apparaît). `.husky` et les autres dossiers de la liste fixe n'y sont pas.
   */
  ideCiDynamiques: string[];
}

// --- Options -------------------------------------------------------------------------------------------------------------------

export interface PrecheckOptions {
  /** Dossier de travail : `/workspace` dans la salle, un dossier temporaire dans les tests. */
  workspace: string;
  /**
   * Projets préparés par `install.ps1`, chemins relatifs au dossier de travail. `null` : liste non consultée, tout projet est
   * tenu pour préparé (unitaires qui ne visent que les noms). Une liste vide refuse donc tout projet (`non-prepare`).
   */
  prepares?: readonly string[] | null;
  /** Bornes de production par défaut ; un test peut en passer de plus petites. Jamais lues dans l'environnement. */
  bornes?: Partial<PrecheckBornes>;
}

function bornesDe(options: PrecheckOptions): Readonly<PrecheckBornes> {
  return { ...PRECHECK_BORNES, ...options.bornes };
}

/** Chemin relatif en séparateurs « / », « . » pour le dossier lui-même. */
function enPosix(relatif: string): string {
  return relatif === "" ? "." : relatif.split(path.sep).join("/");
}

/** Relatif normalisé d'un projet déclaré préparé, pour la comparaison (séparateurs, « ./ » et « / » de fin sans effet). */
function normaliserProjet(projet: string): string {
  const segments = projet.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

// --- Relevé d'un projet ---------------------------------------------------------------------------------------------------------

export interface PrecheckReleve {
  faits: PrecheckFaits;
  /** Empreintes du projet, `null` quand le projet n'a pas pu être atteint (hors dossier de travail, profondeur, lien). */
  empreintes: ReleveEmpreintes | null;
}

/**
 * Relève les faits d'un projet : remontée du projet jusqu'au dossier de travail inclus (D-2b-19, sans descente récursive),
 * puis empreintes du projet. Ne lève que sur un dossier de travail introuvable : tout le reste devient un fait.
 */
export async function releverProjet(projet: string, options: PrecheckOptions): Promise<PrecheckReleve> {
  const bornes = bornesDe(options);
  const racine = await fs.realpath(options.workspace);
  const cible = path.resolve(racine, projet);
  const relatif = path.relative(racine, cible);
  const nom = enPosix(relatif);
  const prepare = estPrepare(nom, options.prepares);
  if (relatif.startsWith("..") || path.isAbsolute(relatif)) {
    return { faits: { projet: nom, horsWorkspace: true, prepare, profondeurDepassee: false, empreinteImpossible: false, trouves: [] }, empreintes: null };
  }
  const segments = relatif === "" ? [] : relatif.split(path.sep);
  if (segments.length > bornes.profondeurMax) {
    return { faits: { projet: nom, horsWorkspace: false, prepare, profondeurDepassee: true, empreinteImpossible: false, trouves: [] }, empreintes: null };
  }
  const trouves: PrecheckTrouve[] = [];
  // Le fait porte la HAUTEUR du composant en cause (« . » le projet, « .. » son parent) et pas son nom : la liste rendue reste
  // la même qu'ailleurs, et aucun nom de dossier n'a besoin d'en sortir. La remontée ne va pas plus loin.
  const douteux = await composantDouteux(racine, segments);
  if (douteux !== null) {
    trouves.push({ remontee: segments.length - 1 - douteux.index, nom: "", raison: douteux.raison });
    return { faits: { projet: nom, horsWorkspace: false, prepare, profondeurDepassee: false, empreinteImpossible: false, trouves }, empreintes: null };
  }
  // Un dernier contrôle après coup : le chemin résolu doit rester dans le dossier de travail (un parent remplacé entre-temps).
  const reel = await fs.realpath(cible).catch(() => null);
  if (reel === null || !dansLaRacine(racine, reel)) {
    return { faits: { projet: nom, horsWorkspace: true, prepare, profondeurDepassee: false, empreinteImpossible: false, trouves }, empreintes: null };
  }
  for (let remontee = 0; remontee <= segments.length; remontee++) {
    const dossier = path.resolve(cible, ...Array.from({ length: remontee }, () => ".."));
    await scanDossier(dossier, remontee, trouves, bornes);
  }
  const empreintes = await releverEmpreintes(cible, nom, bornes);
  // Un lien ou un fichier illisible parmi les fichiers d'IDE et de CI est un angle mort de la détection §4.14.5 : un doute.
  for (const lien of empreintes.liens) trouves.push({ remontee: 0, nom: lien, raison: "lien-symbolique" });
  for (const illisible of empreintes.illisibles) trouves.push({ remontee: 0, nom: illisible === "." ? "" : illisible, raison: "illisible" });
  return {
    faits: { projet: nom, horsWorkspace: false, prepare, profondeurDepassee: false, empreinteImpossible: empreintes.impossible, trouves },
    empreintes,
  };
}

/** Pré-contrôle complet d'un projet : relevé puis décision (fermée en cas de doute). */
export async function precontrolerProjet(projet: string, options: PrecheckOptions): Promise<PrecheckDecision> {
  const { faits } = await releverProjet(projet, options);
  return decidePrecheck(faits, bornesDe(options));
}

function estPrepare(projet: string, prepares: readonly string[] | null | undefined): boolean {
  if (prepares === null || prepares === undefined) return true;
  return prepares.map(normaliserProjet).includes(normaliserProjet(projet));
}

function dansLaRacine(racine: string, cible: string): boolean {
  const relatif = path.relative(racine, cible);
  return relatif === "" || (!relatif.startsWith("..") && !path.isAbsolute(relatif));
}

/**
 * `lstat` de chaque composant d'un chemin sous `racine`, du dossier de travail vers le bas : rend le premier composant qui est
 * un lien, qui n'est pas un dossier ou qui ne se lit pas (rien n'est suivi), `null` si tous sont des dossiers ordinaires.
 */
async function composantDouteux(
  racine: string,
  segments: readonly string[],
): Promise<{ index: number; raison: "lien-symbolique" | "illisible" } | null> {
  let courant = racine;
  for (const [index, segment] of segments.entries()) {
    courant = path.join(courant, segment);
    try {
      const info = await fs.lstat(courant);
      if (info.isSymbolicLink()) return { index, raison: "lien-symbolique" };
      if (!info.isDirectory()) return { index, raison: "illisible" };
    } catch {
      return { index, raison: "illisible" };
    }
  }
  return null;
}

/**
 * Entrées d'un dossier, lues en flux et bornées : un dossier plus peuplé que la borne est `tronque`, donc un doute, jamais une
 * lecture sans fin ni un tableau sans limite en mémoire. `null` : dossier illisible.
 */
async function lireEntreesBornees(dossier: string, bornes: Readonly<PrecheckBornes>): Promise<{ entrees: Dirent[]; tronque: boolean } | null> {
  const entrees: Dirent[] = [];
  let tronque = false;
  try {
    const flux = await fs.opendir(dossier);
    for await (const entree of flux) {
      if (entrees.length >= bornes.entreesMaxParDossier) {
        tronque = true;
        break;
      }
      entrees.push(entree);
    }
  } catch {
    return null;
  }
  return { entrees, tronque };
}

/** Entrées directes d'un dossier contrôlé : aucune descente, sauf `.omo` ouvert d'un seul niveau (§9.3 n° 11). */
async function scanDossier(dossier: string, remontee: number, trouves: PrecheckTrouve[], bornes: Readonly<PrecheckBornes>): Promise<void> {
  const lecture = await lireEntreesBornees(dossier, bornes);
  if (lecture === null || lecture.tronque) {
    trouves.push({ remontee, nom: "", raison: "illisible" });
    if (lecture === null) return;
  }
  for (const entree of lecture.entrees) {
    if (estDossierEtatOmo(entree.name)) {
      if (entree.isSymbolicLink()) trouves.push({ remontee, nom: entree.name, raison: "lien-symbolique" });
      else if (entree.isDirectory()) await scanDossierOmo(dossier, entree.name, remontee, trouves, bornes);
      continue;
    }
    const raison = raisonDuNom(entree.name);
    if (raison !== null) trouves.push({ remontee, nom: entree.name, raison });
  }
}

/**
 * Entrées de `.omo` (nom du disque, casse comprise) : seule la configuration de l'extension y est refusée. Un lien, quel que soit
 * son nom, est un doute : l'extension écrit elle-même dans `boulder*.json`, `plans/` et `notepads/`, et ses écritures partiraient
 * au bout du lien, hors du projet.
 */
async function scanDossierOmo(
  parent: string,
  nomOmo: string,
  remontee: number,
  trouves: PrecheckTrouve[],
  bornes: Readonly<PrecheckBornes>,
): Promise<void> {
  const lecture = await lireEntreesBornees(path.join(parent, nomOmo), bornes);
  if (lecture === null || lecture.tronque) {
    trouves.push({ remontee, nom: nomOmo, raison: "illisible" });
    if (lecture === null) return;
  }
  for (const entree of lecture.entrees) {
    const nom = `${nomOmo}/${entree.name}`;
    if (entree.isSymbolicLink()) {
      trouves.push({ remontee, nom, raison: "lien-symbolique" });
      continue;
    }
    const raison = raisonDansDossierOmo(entree.name);
    if (raison !== null) trouves.push({ remontee, nom, raison });
  }
}

// --- Empreintes ------------------------------------------------------------------------------------------------------------------

/** Relevé vide d'un dossier : point de départ, et relevé d'un dossier qu'on n'a pas pu lire du tout. */
function releveVide(racine: string): ReleveEmpreintes {
  return { racine, git: "absent", fichiers: [], liens: [], illisibles: [], impossible: false, signalesIncomplet: false, ideCiDynamiques: [] };
}

export interface ReleverEmpreintesOptions {
  /**
   * Faux : fichiers signalés relevés à la racine seulement. Sert au relevé du dossier de travail lui-même, dont chaque dossier de
   * premier niveau est relevé à part, en profondeur : descendre deux fois ne verrait rien de plus.
   */
  signalesEnProfondeur?: boolean;
}

/**
 * Empreintes SHA-256 d'un dossier contrôlé : fichiers d'IDE et de CI (dossiers parcourus récursivement), fichiers de CI de la
 * racine, fichiers signalés à toute profondeur, cibles de la configuration git dans l'arbre de travail, et forme de `.git`.
 * Bornes : `empreintesMaxFichiers` fichiers et `empreinteTailleMaxOctets` par fichier pour tout ce qui arrête une demande ;
 * au-delà, `impossible` est vrai et le projet est refusé (`empreinte-impossible`). Les fichiers signalés SOUS la racine ont leurs
 * propres bornes, qui ne refusent rien (`signalesIncomplet`).
 */
export async function releverEmpreintes(
  dossier: string,
  racineAffichee: string,
  bornes: Readonly<PrecheckBornes> = PRECHECK_BORNES,
  options: ReleverEmpreintesOptions = {},
): Promise<ReleveEmpreintes> {
  const releve = releveVide(racineAffichee);
  releve.git = await formeGit(dossier);
  const candidats: string[] = [];
  const lecture = await lireEntreesBornees(dossier, bornes);
  if (lecture === null) {
    releve.illisibles.push(".");
    releve.impossible = true;
    return releve;
  }
  if (lecture.tronque) releve.impossible = true;
  for (const entree of lecture.entrees) await entreeRacine(dossier, entree, releve, candidats, bornes);
  const dynamiques = new Set<string>();
  if (releve.git === "dossier" && !releve.impossible) await releverConfigGit(dossier, releve, candidats, dynamiques, bornes);
  releve.ideCiDynamiques = [...dynamiques].sort(comparerChemins);
  const uniques = [...new Set(candidats)];
  if (uniques.length > bornes.empreintesMaxFichiers) releve.impossible = true;
  for (const chemin of uniques.slice(0, bornes.empreintesMaxFichiers).sort(comparerChemins)) {
    const empreinte = await empreinteDe(path.join(dossier, chemin), bornes);
    if (empreinte.etat === "trop-gros") releve.impossible = true;
    else if (empreinte.etat === "illisible") releve.illisibles.push(chemin);
    else releve.fichiers.push({ chemin, sha256: empreinte.sha256 });
  }
  if (options.signalesEnProfondeur !== false) {
    const signales: string[] = [];
    await collecterSignales(dossier, lecture.entrees, releve, signales, bornes);
    for (const chemin of signales.sort(comparerChemins)) {
      const empreinte = await empreinteDe(path.join(dossier, chemin), bornes);
      if (empreinte.etat === "ok") releve.fichiers.push({ chemin, sha256: empreinte.sha256 });
      else releve.signalesIncomplet = true;
    }
  }
  releve.fichiers.sort((a, b) => comparerChemins(a.chemin, b.chemin));
  return releve;
}

/** Fichier signalé à relire (package.json, Makefile, *.ps1), casse ignorée. */
function estFichierSignale(nom: string): boolean {
  return nomDansListe(nom, FICHIERS_SIGNALES) || MOTIFS_SIGNALES.some((re) => re.test(nom));
}

/**
 * Descente des fichiers signalés SOUS la racine (la racine elle-même est relevée par `entreeRacine`) : aucun lien suivi,
 * `node_modules` et `.git` exclus, dossiers d'IDE et de CI de la racine laissés à `collecter`. Rien de ce qu'elle rencontre ne
 * passe dans `liens`, `illisibles` ni `impossible` : un dépôt ordinaire (liens hors des dossiers d'IDE, dossier très peuplé) ne
 * doit pas être refusé au pré-contrôle pour un fichier qui n'arrête rien. Tout manque rend `signalesIncomplet`.
 */
async function collecterSignales(
  dossier: string,
  entreesRacine: readonly Dirent[],
  releve: ReleveEmpreintes,
  signales: string[],
  bornes: Readonly<PrecheckBornes>,
): Promise<void> {
  const pile: { relatif: string; profondeur: number }[] = [];
  for (const entree of entreesRacine) {
    if (!entree.isDirectory() || nomDansListe(entree.name, DOSSIERS_IDE_CI) || nomDansListe(entree.name, EXCLUS_DES_SIGNALES)) continue;
    pile.push({ relatif: entree.name, profondeur: 1 });
  }
  let entreesLues = 0;
  while (pile.length > 0) {
    const { relatif, profondeur } = pile.pop() ?? { relatif: "", profondeur: 0 };
    if (profondeur > bornes.profondeurRelevesMax) {
      releve.signalesIncomplet = true;
      continue;
    }
    const lecture = await lireEntreesBornees(path.join(dossier, relatif), bornes);
    if (lecture === null || lecture.tronque) releve.signalesIncomplet = true;
    for (const entree of lecture?.entrees ?? []) {
      entreesLues++;
      if (entreesLues > bornes.signalesEntreesMax) {
        releve.signalesIncomplet = true;
        return;
      }
      const chemin = `${relatif}/${entree.name}`;
      if (entree.isSymbolicLink()) {
        // Jamais suivi. Un lien au nom d'un fichier signalé est un fichier qu'on ne peut pas relever : la liste est incomplète.
        if (estFichierSignale(entree.name)) releve.signalesIncomplet = true;
        continue;
      }
      if (entree.isDirectory()) {
        if (!nomDansListe(entree.name, EXCLUS_DES_SIGNALES)) pile.push({ relatif: chemin, profondeur: profondeur + 1 });
        continue;
      }
      if (!entree.isFile() || !estFichierSignale(entree.name)) continue;
      if (signales.length >= bornes.signalesMaxFichiers) {
        releve.signalesIncomplet = true;
        return;
      }
      signales.push(chemin);
    }
  }
}

// --- Cibles de la configuration git dans l'arbre de travail (S6/G04, §4.5 ; hooks hors de .git) ---------------------------------

/** Où tombe un chemin désigné par la configuration git, vu depuis le dossier contrôlé. */
type SituationCible = { ou: "arbre"; relatif: string } | { ou: "git"; absolu: string; relatif: string } | { ou: "doute" };

/**
 * Situe une valeur de la configuration git : relative à `base`, elle doit rester dans le dossier contrôlé. Absolue (du conteneur ou
 * de l'hôte), dans le HOME (« ~ »), vide, ou hors du dossier : doute. Le cockpit ne sait pas où tombe un chemin de l'hôte.
 */
function situerCible(dossier: string, base: string, valeur: string): SituationCible {
  if (valeur === "" || valeur.startsWith("~") || valeur.startsWith("/") || valeur.startsWith("\\") || /^[A-Za-z]:/.test(valeur) || path.isAbsolute(valeur)) {
    return { ou: "doute" };
  }
  const absolu = path.resolve(base, valeur);
  const relatif = path.relative(dossier, absolu);
  if (relatif === "" || relatif.startsWith("..") || path.isAbsolute(relatif)) return { ou: "doute" };
  const posix = relatif.split(path.sep).join("/");
  if ((posix.split("/")[0] ?? "").toLowerCase() === ".git") return { ou: "git", absolu, relatif: posix };
  return { ou: "arbre", relatif: posix };
}

/** Nature d'un chemin de l'arbre, relevée composant par composant sans jamais suivre un lien. */
async function natureSansLien(dossier: string, relatif: string): Promise<"absent" | "lien" | "dossier" | "fichier" | "illisible"> {
  let courant = dossier;
  const segments = relatif.split("/");
  for (const [index, segment] of segments.entries()) {
    courant = path.join(courant, segment);
    let info;
    try {
      info = await fs.lstat(courant);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "illisible";
    }
    if (info.isSymbolicLink()) return "lien";
    if (index < segments.length - 1 && !info.isDirectory()) return "absent";
    if (index === segments.length - 1) return info.isDirectory() ? "dossier" : info.isFile() ? "fichier" : "illisible";
  }
  return "illisible";
}

type LectureConfig = { etat: "ok"; texte: string } | { etat: "absent" | "lien" | "illisible" | "trop-gros" };

/** Fichier de configuration git lu borné, sans suivre de lien (vérifié au `lstat`, puis refusé à l'ouverture par O_NOFOLLOW). */
async function lireConfigBornee(fichier: string, bornes: Readonly<PrecheckBornes>): Promise<LectureConfig> {
  let handle;
  try {
    const info = await fs.lstat(fichier);
    if (info.isSymbolicLink()) return { etat: "lien" };
    if (!info.isFile()) return { etat: "illisible" };
    handle = await fs.open(fichier, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return { etat: (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "illisible" };
  }
  try {
    const tampon = Buffer.alloc(bornes.configGitTailleMaxOctets + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(tampon, lus, tampon.length - lus, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > bornes.configGitTailleMaxOctets) return { etat: "trop-gros" };
    }
    return { etat: "ok", texte: tampon.subarray(0, lus).toString("utf8") };
  } catch {
    return { etat: "illisible" };
  } finally {
    await handle.close();
  }
}

/**
 * Cibles de la configuration git d'un dossier contrôlé dont `.git` est un dossier (lecture seule dans la salle). Le `.git:ro`
 * protège `.git/hooks` et `.git/config`, pas ce qu'ils désignent dans l'arbre de travail : un dossier de hooks (`core.hooksPath`,
 * par exemple `.githooks`), un programme `core.fsmonitor`, un fichier inclus (`[include]`, `[includeIf]`, par exemple
 * `../.gitconfig`). La salle peut les modifier, et le poste les exécuterait au prochain `git commit` ou `git status`. Ils sont
 * donc relevés comme des fichiers d'IDE et de CI (leur modification arrête la demande) et listés dans `ideCiDynamiques`, même
 * absents. Les fichiers inclus sont lus à leur tour, bornés. Fermé en cas de doute : configuration trop grosse ou trop de fichiers
 * inclus (`impossible`), non analysable ou illisible (`illisibles`), lien (`liens`), cible hors du dossier contrôlé, absolue ou
 * dans le HOME (`impossible`). Un `.git` fichier n'est pas lu : son dossier git est ailleurs, protégé ou refusé par le balayage.
 */
async function releverConfigGit(
  dossier: string,
  releve: ReleveEmpreintes,
  candidats: string[],
  dynamiques: Set<string>,
  bornes: Readonly<PrecheckBornes>,
): Promise<void> {
  const aLire: { absolu: string; relatif: string }[] = [{ absolu: path.join(dossier, ".git", "config"), relatif: ".git/config" }];
  const vus = new Set<string>();
  while (aLire.length > 0) {
    const { absolu, relatif } = aLire.shift() ?? { absolu: "", relatif: "" };
    if (vus.has(absolu)) continue;
    vus.add(absolu);
    if (vus.size > bornes.configGitFichiersMax) {
      releve.impossible = true;
      return;
    }
    const lecture = await lireConfigBornee(absolu, bornes);
    if (lecture.etat === "absent") continue;
    if (lecture.etat === "lien") {
      releve.liens.push(relatif);
      continue;
    }
    if (lecture.etat === "trop-gros") {
      releve.impossible = true;
      return;
    }
    const cibles = lecture.etat === "ok" ? analyserConfigGit(lecture.texte) : null;
    if (cibles === null) {
      releve.illisibles.push(relatif);
      continue;
    }
    const executables = [...cibles.hooksPath, ...cibles.fsmonitor].map((valeur) => situerCible(dossier, dossier, valeur));
    const inclus = cibles.includes.map((valeur) => situerCible(dossier, path.dirname(absolu), valeur));
    for (const situation of [...executables, ...inclus]) {
      if (situation.ou === "doute") {
        releve.impossible = true;
        return;
      }
    }
    for (const situation of executables) {
      // Dans .git : en lecture seule, rien à surveiller. Sous un dossier de la liste fixe (.husky/_) : déjà relevé en entier.
      if (situation.ou !== "arbre" || nomDansListe(situation.relatif.split("/")[0] ?? "", DOSSIERS_IDE_CI)) continue;
      dynamiques.add(situation.relatif);
      const nature = await natureSansLien(dossier, situation.relatif);
      if (nature === "lien") releve.liens.push(situation.relatif);
      else if (nature === "illisible") releve.illisibles.push(situation.relatif);
      else if (nature === "dossier") await collecter(dossier, situation.relatif, releve, candidats, bornes);
      else if (nature === "fichier") candidats.push(situation.relatif);
    }
    for (const situation of inclus) {
      if (situation.ou === "git") {
        aLire.push({ absolu: situation.absolu, relatif: situation.relatif });
        continue;
      }
      if (situation.ou !== "arbre") continue;
      dynamiques.add(situation.relatif);
      const nature = await natureSansLien(dossier, situation.relatif);
      if (nature === "lien") releve.liens.push(situation.relatif);
      else if (nature === "illisible" || nature === "dossier") releve.illisibles.push(situation.relatif);
      else if (nature === "fichier") {
        candidats.push(situation.relatif);
        aLire.push({ absolu: path.join(dossier, situation.relatif), relatif: situation.relatif });
      }
    }
  }
}

function comparerChemins(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Une entrée directe du dossier relevé : dossier d'IDE ou de CI (parcouru), fichier relevé, ou rien. */
async function entreeRacine(
  dossier: string,
  entree: { name: string; isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean },
  releve: ReleveEmpreintes,
  candidats: string[],
  bornes: Readonly<PrecheckBornes>,
): Promise<void> {
  const estIdeCi = nomDansListe(entree.name, DOSSIERS_IDE_CI);
  if (!estIdeCi && !estFichierRacineReleve(entree.name)) return;
  if (entree.isSymbolicLink()) {
    releve.liens.push(entree.name);
    return;
  }
  if (estIdeCi) {
    if (entree.isDirectory()) await collecter(dossier, entree.name, releve, candidats, bornes);
    return;
  }
  if (entree.isFile()) candidats.push(entree.name);
}

/**
 * Empreintes de TOUS les dossiers contrôlés avant un démarrage (D-2b-35) : le dossier de travail, ses dossiers de premier
 * niveau et chaque projet préparé. Un même dossier n'est relevé qu'une fois. Un projet préparé atteint par un lien (lui-même
 * ou l'un de ses parents), qui ne se lit pas ou qui sort du dossier de travail n'est pas relevé : son relevé porte
 * `impossible`, rien n'est lu au bout. Chaque dossier demandé a donc toujours son relevé.
 */
export async function releverEmpreintesSalle(options: PrecheckOptions): Promise<ReleveEmpreintes[]> {
  const bornes = bornesDe(options);
  const racine = await fs.realpath(options.workspace);
  const noms: string[] = ["."];
  // Lecture bornée : un dossier de travail illisible ou trop peuplé laisse son propre relevé porter `impossible`.
  const premierNiveau = await lireEntreesBornees(racine, bornes);
  for (const entree of premierNiveau?.entrees ?? []) {
    if (entree.isDirectory() && !entree.isSymbolicLink()) noms.push(entree.name);
  }
  for (const prepare of options.prepares ?? []) {
    const nom = normaliserProjet(prepare);
    if (!noms.includes(nom)) noms.push(nom);
  }
  const releves: ReleveEmpreintes[] = [];
  for (const nom of noms) releves.push(await releverDossierSalle(racine, nom, bornes));
  return releves;
}

/**
 * Relevé d'un dossier de la salle. Aucun lien n'est suivi pour l'atteindre. Un dossier qui sort du dossier de travail n'est pas
 * lu, mais il n'est pas oublié non plus : son relevé porte `impossible` (fermé en cas de doute), comme un projet absent.
 */
async function releverDossierSalle(racine: string, nom: string, bornes: Readonly<PrecheckBornes>): Promise<ReleveEmpreintes> {
  // Le dossier de travail à sa racine seulement pour les fichiers signalés : chacun de ses dossiers de premier niveau est relevé
  // en profondeur juste après, descendre deux fois ne verrait rien de plus.
  if (nom === ".") return releverEmpreintes(racine, nom, bornes, { signalesEnProfondeur: false });
  const dossier = path.resolve(racine, nom);
  if (!dansLaRacine(racine, dossier)) return { ...releveVide(nom), illisibles: ["."], impossible: true };
  const douteux = await composantDouteux(racine, nom.split("/"));
  if (douteux === null) return releverEmpreintes(dossier, nom, bornes);
  const lienTrouve = douteux.raison === "lien-symbolique";
  return { ...releveVide(nom), liens: lienTrouve ? ["."] : [], illisibles: lienTrouve ? [] : ["."], impossible: true };
}

// --- Dépôts git du dossier de travail, relevés par le cockpit (activation, D-2b-28, §4.14.2) ------------------------------------

/** Dépôts git du dossier de travail : chemins relatifs (« / »), triés ; `limiteAtteinte` quand le relevé n'a pas tout vu. */
export interface ReleveGitsWorkspace {
  depots: string[];
  limiteAtteinte: boolean;
}

/** Dépôt nu, comme git le reconnaît : un fichier HEAD, un dossier objects et un dossier refs (mêmes règles que la salle). */
function estDepotNu(entrees: readonly Dirent[]): boolean {
  const parNom = new Map(entrees.map((entree) => [entree.name, entree]));
  return Boolean(parNom.get("HEAD")?.isFile() && parNom.get("objects")?.isDirectory() && parNom.get("refs")?.isDirectory());
}

/**
 * Dépôts git du dossier de travail, relevés par le cockpit lui-même à chaque activation (fiche L22c) : le `workspaceGit` de
 * state.json date du démarrage de la salle, et opencode reste lancé au repos entre deux demandes ; un dépôt cloné entre-temps
 * n'y est pas, et son `.git`, hors de toute surcharge, est inscriptible par la salle. Mêmes règles que le balayage du
 * superviseur (`balayerGit`) : aucun lien suivi, `node_modules` exclu, intérieur des `.git` et des dépôts nus sauté, bornes ;
 * un `.git` de toute forme (dossier, fichier `gitdir:`, lien) et un dépôt nu sont des dépôts. Dossier illisible, dossier trop
 * peuplé, profondeur ou plafond atteint : `limiteAtteinte` (fermé en cas de doute). Le cockpit ne juge pas les droits de `node` :
 * il compare à `gitProteges` d'omo-projets.json (`gitsHorsProtection`), liste que la salle ne peut pas réécrire.
 */
export async function releverGitsWorkspace(options: PrecheckOptions): Promise<ReleveGitsWorkspace> {
  const bornes = bornesDe(options);
  const depots: string[] = [];
  let racine: string;
  try {
    racine = await fs.realpath(options.workspace);
  } catch {
    return { depots, limiteAtteinte: true };
  }
  let entreesLues = 0;
  const pile: { relatif: string; profondeur: number }[] = [{ relatif: "", profondeur: 0 }];
  while (pile.length > 0) {
    const { relatif, profondeur } = pile.pop() ?? { relatif: "", profondeur: 0 };
    if (profondeur > bornes.profondeurMax) return { depots: trier(depots), limiteAtteinte: true };
    const lecture = await lireEntreesBornees(relatif === "" ? racine : path.join(racine, relatif), bornes);
    if (lecture === null || lecture.tronque) return { depots: trier(depots), limiteAtteinte: true };
    if (estDepotNu(lecture.entrees)) {
      depots.push(relatif === "" ? "." : relatif);
      continue;
    }
    for (const entree of lecture.entrees) {
      entreesLues++;
      if (entreesLues > bornes.balayageGitEntreesMax) return { depots: trier(depots), limiteAtteinte: true };
      const chemin = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      if (entree.name === ".git") {
        depots.push(chemin);
        continue;
      }
      if (entree.isSymbolicLink() || !entree.isDirectory() || entree.name === "node_modules") continue;
      pile.push({ relatif: chemin, profondeur: profondeur + 1 });
    }
  }
  return { depots: trier(depots), limiteAtteinte: false };
}

function trier(chemins: string[]): string[] {
  return [...chemins].sort(comparerChemins);
}

function estFichierRacineReleve(nom: string): boolean {
  if (nomDansListe(nom, FICHIERS_CI_RACINE) || estFichierSignale(nom)) return true;
  return MOTIFS_CI_RACINE.some((re) => re.test(nom));
}

async function formeGit(dossier: string): Promise<FormeGit> {
  try {
    const info = await fs.lstat(path.join(dossier, ".git"));
    if (info.isSymbolicLink()) return "lien";
    return info.isDirectory() ? "dossier" : "fichier";
  } catch {
    return "absent";
  }
}

/** Parcours borné d'un dossier d'IDE ou de CI : aucun lien suivi, profondeur bornée, chemins relatifs à la racine relevée. */
async function collecter(
  racine: string,
  relatif: string,
  releve: ReleveEmpreintes,
  candidats: string[],
  bornes: Readonly<PrecheckBornes>,
  profondeur = 1,
): Promise<void> {
  if (releve.impossible) return;
  if (profondeur > bornes.profondeurRelevesMax) {
    releve.impossible = true;
    return;
  }
  const lecture = await lireEntreesBornees(path.join(racine, relatif), bornes);
  if (lecture === null) {
    releve.illisibles.push(relatif);
    releve.impossible = true;
    return;
  }
  if (lecture.tronque) releve.impossible = true;
  for (const entree of lecture.entrees) {
    const chemin = `${relatif}/${entree.name}`;
    if (entree.isSymbolicLink()) {
      releve.liens.push(chemin);
      continue;
    }
    if (entree.isDirectory()) {
      await collecter(racine, chemin, releve, candidats, bornes, profondeur + 1);
      if (releve.impossible) return;
      continue;
    }
    if (!entree.isFile()) continue;
    candidats.push(chemin);
    if (candidats.length > bornes.empreintesMaxFichiers) {
      releve.impossible = true;
      return;
    }
  }
}

type Empreinte = { etat: "ok"; sha256: string } | { etat: "trop-gros" } | { etat: "illisible" };

/** Taille d'un morceau lu à la fois : la mémoire tenue par une empreinte ne dépend pas de la taille du fichier. */
const MORCEAU_OCTETS = 64 * 1024;

/**
 * SHA-256 d'un fichier ordinaire, lu morceau par morceau et arrêté dès que la borne de taille est franchie : un fichier
 * énorme, ou gonflé entre le `lstat` et la lecture, rend « trop-gros » sans jamais entrer en mémoire. `O_NOFOLLOW` refuse le
 * lien au moment même de l'ouverture, et pas seulement au `lstat` d'avant.
 */
async function empreinteDe(fichier: string, bornes: Readonly<PrecheckBornes>): Promise<Empreinte> {
  let handle;
  try {
    const info = await fs.lstat(fichier);
    if (info.isSymbolicLink() || !info.isFile()) return { etat: "illisible" };
    handle = await fs.open(fichier, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { etat: "illisible" };
  }
  try {
    if (!(await handle.stat()).isFile()) return { etat: "illisible" };
    const empreinte = crypto.createHash("sha256");
    const morceau = Buffer.allocUnsafe(MORCEAU_OCTETS);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(morceau, 0, morceau.length, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > bornes.empreinteTailleMaxOctets) return { etat: "trop-gros" };
      empreinte.update(morceau.subarray(0, bytesRead));
    }
    return { etat: "ok", sha256: empreinte.digest("hex") };
  } catch {
    return { etat: "illisible" };
  } finally {
    await handle.close();
  }
}

// --- Renommage sans suivre les liens (D-2b-37) -----------------------------------------------------------------------------------

export type RenommageRefus = "nom-invalide" | "chemin-invalide" | "lien-symbolique" | "hors-base" | "absent" | "illisible" | "collision";

export type ResultatRenommage = { ok: true; nom: string } | { ok: false; raison: RenommageRefus };

/** Nombre de noms essayés en cas de collision avant d'abandonner (rien n'est jamais écrasé). */
const SUFFIXES_MAX = 50;

/**
 * Renomme `relatif` (sous `base`) en `nouveauNom`, sans jamais suivre un lien, sans jamais écraser et sans jamais supprimer
 * (D-2b-37, C2-16). Chaque composant est `lstat`é : un lien sur le chemin refuse tout. Le dossier d'accueil est vérifié par
 * `realpath` : il doit rester dans `base`. Si `nouveauNom` existe déjà, un suffixe est ajouté ; si aucun nom n'est libre, rien
 * n'est fait. Le renommage lui-même reste un `rename` : la salle est arrêtée quand le cockpit met un chemin en quarantaine.
 */
export async function renommerSansSuivreLiens(base: string, relatif: string, nouveauNom: string): Promise<ResultatRenommage> {
  if (nouveauNom === "" || nouveauNom.length > 255 || /[\\/]/.test(nouveauNom) || nouveauNom === "." || nouveauNom === "..") {
    return { ok: false, raison: "nom-invalide" };
  }
  const segments = relatif.replace(/[\\/]+/g, "/").split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.includes("..") || segments.includes(".") || path.isAbsolute(relatif)) {
    return { ok: false, raison: "chemin-invalide" };
  }
  let baseReelle: string;
  try {
    baseReelle = await fs.realpath(base);
  } catch {
    return { ok: false, raison: "illisible" };
  }
  let courant = baseReelle;
  for (const segment of segments) {
    courant = path.join(courant, segment);
    try {
      const info = await fs.lstat(courant);
      if (info.isSymbolicLink()) return { ok: false, raison: "lien-symbolique" };
    } catch (err) {
      return { ok: false, raison: (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "illisible" };
    }
  }
  const parent = path.dirname(courant);
  let parentReel: string;
  try {
    parentReel = await fs.realpath(parent);
  } catch {
    return { ok: false, raison: "illisible" };
  }
  if (parentReel !== parent || !dansLaRacine(baseReelle, parentReel)) return { ok: false, raison: "hors-base" };
  for (let essai = 1; essai <= SUFFIXES_MAX; essai++) {
    const candidat = essai === 1 ? nouveauNom : `${nouveauNom}-${essai}`;
    const destination = path.join(parentReel, candidat);
    try {
      await fs.lstat(destination);
      continue; // Occupé : on essaie le nom suivant, jamais d'écrasement.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, raison: "illisible" };
    }
    try {
      await fs.rename(courant, destination);
    } catch {
      return { ok: false, raison: "illisible" };
    }
    return { ok: true, nom: candidat };
  }
  return { ok: false, raison: "collision" };
}
