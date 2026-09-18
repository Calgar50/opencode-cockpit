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
// 3. **Aucune suppression, aucun écrasement** : `renommerSansSuivreLiens` ne fait que renommer, et seulement vers un nom libre.
import crypto from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
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

/** Fichiers signalés après une détection (§4.14.5, D-2b-37) : relevés à la racine du dossier contrôlé. */
const FICHIERS_SIGNALES_RACINE: readonly string[] = Object.freeze(["Makefile", "package.json"]);
const MOTIFS_SIGNALES_RACINE: readonly RegExp[] = Object.freeze([/\.ps1$/iu]);

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

/** Entrées de `.omo` (nom du disque, casse comprise) : seule la configuration de l'extension y est refusée. */
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
    const raison = raisonDansDossierOmo(entree.name);
    if (raison === null) continue;
    const nom = `${nomOmo}/${entree.name}`;
    trouves.push({ remontee, nom, raison: entree.isSymbolicLink() ? "lien-symbolique" : raison });
  }
}

// --- Empreintes ------------------------------------------------------------------------------------------------------------------

/**
 * Empreintes SHA-256 d'un dossier contrôlé : fichiers d'IDE et de CI (dossiers parcourus récursivement), fichiers de CI et
 * fichiers signalés de la racine, et forme de `.git`. Bornes : `empreintesMaxFichiers` fichiers et `empreinteTailleMaxOctets`
 * par fichier ; au-delà, `impossible` est vrai et le projet est refusé (`empreinte-impossible`).
 */
export async function releverEmpreintes(
  dossier: string,
  racineAffichee: string,
  bornes: Readonly<PrecheckBornes> = PRECHECK_BORNES,
): Promise<ReleveEmpreintes> {
  const releve: ReleveEmpreintes = { racine: racineAffichee, git: "absent", fichiers: [], liens: [], illisibles: [], impossible: false };
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
  if (candidats.length > bornes.empreintesMaxFichiers) releve.impossible = true;
  for (const chemin of candidats.slice(0, bornes.empreintesMaxFichiers).sort(comparerChemins)) {
    const empreinte = await empreinteDe(path.join(dossier, chemin), bornes);
    if (empreinte.etat === "trop-gros") releve.impossible = true;
    else if (empreinte.etat === "illisible") releve.illisibles.push(chemin);
    else releve.fichiers.push({ chemin, sha256: empreinte.sha256 });
  }
  releve.fichiers.sort((a, b) => comparerChemins(a.chemin, b.chemin));
  return releve;
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
 * ou l'un de ses parents), ou qui ne se lit pas, n'est pas relevé : son relevé porte `impossible`, rien n'est lu au bout.
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
  for (const nom of noms) {
    const releve = await releverDossierSalle(racine, nom, bornes);
    if (releve !== null) releves.push(releve);
  }
  return releves;
}

/** Relevé d'un dossier de la salle, `null` s'il sort du dossier de travail. Aucun lien n'est suivi pour l'atteindre. */
async function releverDossierSalle(racine: string, nom: string, bornes: Readonly<PrecheckBornes>): Promise<ReleveEmpreintes | null> {
  if (nom === ".") return releverEmpreintes(racine, nom, bornes);
  const dossier = path.resolve(racine, nom);
  if (!dansLaRacine(racine, dossier)) return null;
  const douteux = await composantDouteux(racine, nom.split("/"));
  if (douteux === null) return releverEmpreintes(dossier, nom, bornes);
  const lienTrouve = douteux.raison === "lien-symbolique";
  return { racine: nom, git: "absent", fichiers: [], liens: lienTrouve ? ["."] : [], illisibles: lienTrouve ? [] : ["."], impossible: true };
}

function estFichierRacineReleve(nom: string): boolean {
  if (nomDansListe(nom, FICHIERS_CI_RACINE) || nomDansListe(nom, FICHIERS_SIGNALES_RACINE)) return true;
  return MOTIFS_CI_RACINE.some((re) => re.test(nom)) || MOTIFS_SIGNALES_RACINE.some((re) => re.test(nom));
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
