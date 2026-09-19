// Faits d'une demande de modification (`edit`, `write`, `apply_patch`) pour la politique E1 à E6 (spécification §4.4, F-o ; plan
// d'exécution, fiche L10b et report des mesures §3.5 ; mesure MX1 §3). Relève sur le disque ce que classifyEdit
// (shared/autonomy-edit-rules.ts, pur) ne peut pas voir : dossier permis (E6), chemins réels et liens symboliques (E1, E2),
// fichiers déjà comptés (E5). Ne lit aucun contenu de fichier, n'écrit rien, n'exécute rien : realpath, lstat et stat seulement.
//
// Champs lus (formes mesurées sur opencode 1.18.30, MX1 §3, fixtures/mx1-mesures.json), par les lecteurs purs de L9a pour qu'il
// n'en existe qu'une définition :
// - chemins touchés (editTargetPaths) : metadata.filepath (edit, write ; absolu) ; files[].filePath ET files[].movePath
//   (apply_patch). La destination d'un déplacement n'est ni dans `patterns` ni dans `filepath` : sans movePath, un déplacement
//   vers `.github/` ou hors du dossier échapperait à E1 et E2. Le metadata.filepath d'apply_patch (relatif au worktree, joint par
//   « , », ambigu si un nom contient « , ») n'est jamais résolu ;
// - `patterns` : relatifs au WORKTREE d'opencode (dossier du dépôt git, « / » hors git ; GET /path), jamais au dossier de la
//   conversation. Chacun est résolu depuis ce worktree et examiné comme un chemin touché : un motif qui désignerait un autre
//   fichier que les métadonnées ne passe pas sans contrôle ;
// - diffs, suppression ou déplacement : editDiffs, applyPatchDeletesOrMoves (E3, E4).
//
// Deux vues d'un même disque (F-o) : opencode et le cockpit montent le projet en /workspace (docker-compose.yml). Un chemin
// d'opencode est traduit par projects.toLocalPath, résolu par realpath côté cockpit, puis rendu dans la vue d'opencode
// (`resolved`) relativement au chemin RÉEL de la racine du workspace. Un chemin réel hors du workspace n'a pas de vue d'opencode
// connue : resolved = null.
//
// Prudence : ce qui n'est pas prouvé intérieur est « hors du dossier » (E1, attente), jamais l'inverse.
// - « .. » dans un chemin : refusé sans résolution. Le noyau résout « lien/.. » APRÈS avoir suivi le lien, alors qu'une
//   normalisation lexicale l'efface : les deux lectures divergent dès qu'un lien est en jeu.
// - « \ » : séparateur pour un cockpit sous Windows (développement), caractère ordinaire pour opencode sous Linux : refusé.
// - Chemin qui n'est pas absolu (worktree illisible, par exemple) : refusé, jamais résolu depuis le dossier courant du processus.
// - Fichier à créer : le plus proche parent existant est résolu, puis le reste du chemin lui est ajouté. Chaque élément sauté doit
//   être réellement absent (realpath ET lstat en ENOENT) : un lien pendant (cible absente) serait suivi à l'écriture, il compte
//   comme lien sortant ; le parent trouvé doit être un dossier ; toute autre erreur (ELOOP, EACCES, ENOTDIR…) laisse le chemin
//   non résolu.
// - Fichier qui existe : fichier ordinaire à un seul nom (nlink ≤ 1), sinon non résolu. opencode le réécrit sur place : à travers
//   un lien physique, l'écriture changerait aussi un autre nom du fichier (`.git/config`, par exemple), invisible pour realpath.
// - Dossier de la conversation : son chemin réel doit rester sous le chemin réel du workspace (un dossier-lien vers l'extérieur
//   rendrait « intérieur » tout ce qu'il contient).
// - Métadonnées illisibles, ou aucun chemin touché : un chemin non résolu est ajouté, pour que E1 décide même quand les motifs et
//   le diff sont lisibles.
// - Dossier refusé (E6), permission autre que `edit` ou demande trop grande : aucun accès au disque.
//
// TOCTOU (écart entre le contrôle et l'usage) : ces faits valent au moment de la décision ; opencode écrit APRÈS le « once », en
// suivant les liens qu'il trouve alors. Entre les deux, un dossier du chemin peut être remplacé par un lien symbolique (ou le
// fichier par un lien physique) et l'écriture sortir du dossier : par l'utilisateur, par une autre conversation, ou par une commande de la même réponse de l'IA (opencode exécute en
// même temps les appels d'outil d'une étape) accordée par l'utilisateur ou par l'IA de contrôle. C'est inhérent au mécanisme
// « once » (opencode ne rapporte pas le chemin qu'il ouvre) et rien ne le ferme ici. Ce qui le borne : un lien qui existe AVANT
// la demande est vu ; la porte shell n'accorde d'elle-même aucune commande qui crée un lien (`ln` est en S4, une commande non
// listée ne passe qu'après l'IA de contrôle, en Autonome) ; la réponse est relayée aussitôt. La limite est à écrire dans le README
// et dans la grille de R1 (découpage, risque n° 10).
import fs from "node:fs/promises";
import path from "node:path";
import { isInside } from "./fsutil.ts";
import type { ProjectsService } from "./projects.ts";
import { applyPatchDeletesOrMoves, editDiffs, type EditFacts, type EditPathFacts, editTargetPaths } from "./shared/autonomy-edit-rules.ts";

/** Ce que collectEditFacts lit du service des projets (ProjectsService convient tel quel). */
export type EditFactsProjects = Pick<ProjectsService, "opencodeRoot" | "isAllowedDirectory" | "toLocalPath" | "opencodeWorktree">;

/**
 * Fichiers déjà modifiés automatiquement par la demande autonome en cours (E5) : leurs clés (touchedFiles des décisions
 * précédentes), pour ne compter qu'une fois un fichier touché deux fois ; ou leur seul nombre, et alors chaque fichier de cette
 * demande compte comme nouveau (prudent).
 */
export type EditFilesSoFar = ReadonlySet<string> | number;

export interface EditFactsOptions {
  /**
   * Worktree d'opencode pour le dossier de la conversation, lu par GET /path (`worktree`) : c'est lui qui a servi à écrire les
   * `patterns`. Absent : projects.opencodeWorktree (dossier parent qui contient `.git`, sinon « / »), même règle vue du cockpit.
   */
  worktree?: string;
}

/** Faits d'une demande, plus les fichiers qu'elle touche. */
export interface CollectedEditFacts extends EditFacts {
  /**
   * Fichiers distincts touchés par les métadonnées (chemin réel dans la vue d'opencode ; chemin présenté s'il n'est pas résolu),
   * destination d'un déplacement comprise. À ajouter aux fichiers comptés quand la décision est automatique.
   */
  touchedFiles: readonly string[];
}

/** Chemins examinés au plus par demande (chemins touchés et motifs) ; au-delà, aucune résolution : E1. */
export const EDIT_PATHS_MAX = 256;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** Propriété propre seulement : une clé héritée du prototype n'est jamais lue. */
const own = (record: JsonRecord, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/** Chemin non résolu : jamais intérieur (E1). */
const unresolved = (presented: string, symlinkOut = false): EditPathFacts => ({ path: presented, resolved: null, inside: false, symlinkOut });

/** Ce qui ne dépend que de la racine et du dossier de la conversation, relevé une fois par demande. */
interface Scope {
  projects: EditFactsProjects;
  /** Chemin réel de la racine du workspace, vue du cockpit ; null : racine illisible. */
  realRoot: string | null;
  /** Dossier de la conversation, vue du cockpit (lexical) ; null : absent ou qui n'est pas un dossier (aucun lien à signaler). */
  localConversation: string | null;
  /** Chemin réel du dossier de la conversation ; null : absent, pas un dossier, ou hors du chemin réel du workspace. */
  realConversation: string | null;
}

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/** Lecture d'un élément : chemin réel, absent, lien qu'on ne peut pas suivre jusqu'au bout (pendant ou en boucle), illisible. */
type Probe = { kind: "reel"; real: string } | { kind: "absent" } | { kind: "lien" } | { kind: "illisible" };
type TargetReal = Exclude<Probe, { kind: "absent" }>;

/** Élément présent pour lstat alors que realpath le dit absent : lien pendant, ou lecture incohérente. */
async function lstatKind(file: string): Promise<"absent" | "lien" | "illisible"> {
  try {
    return (await fs.lstat(file)).isSymbolicLink() ? "lien" : "illisible";
  } catch (err) {
    return errorCode(err) === "ENOENT" ? "absent" : "illisible";
  }
}

async function probeOf(file: string): Promise<Probe> {
  try {
    return { kind: "reel", real: await fs.realpath(file) };
  } catch (err) {
    const code = errorCode(err);
    if (code === "ELOOP") return { kind: "lien" };
    // ENOENT : l'élément manque, ou c'est un lien dont la cible manque (pendant), que l'écriture suivrait : lstat les distingue.
    // Toute autre erreur (EACCES, ENOTDIR, ENAMETOOLONG…) : illisible, jamais sautée.
    return code === "ENOENT" ? { kind: await lstatKind(file) } : { kind: "illisible" };
  }
}

/** Reste d'un chemin ajouté à son plus proche parent existant, qui doit être un dossier (Windows rend ENOENT pour « a.txt/x »). */
async function underDirectory(real: string, rest: readonly string[]): Promise<TargetReal> {
  const info = await fs.stat(real).catch(() => null);
  return info?.isDirectory() ? { kind: "reel", real: path.join(real, ...rest) } : { kind: "illisible" };
}

/**
 * Cible qui existe déjà : fichier ordinaire à un seul nom. opencode réécrit un fichier existant sur place (writeWithDirs, un
 * writeFile : packages/core/src/fs-util.ts de la 1.18.30) : à travers un lien physique (nlink > 1), l'écriture changerait aussi
 * un autre nom du même fichier, que realpath ne montre pas (`.git/config`, `opencode.json` ou un fichier d'un autre projet).
 * Dossier, tube nommé ou autre type : illisible. nlink 0 (rapporté par certains systèmes de fichiers) n'arrête rien.
 */
async function singleNameFile(real: string): Promise<TargetReal> {
  const info = await fs.stat(real).catch(() => null);
  return info?.isFile() && info.nlink <= 1 ? { kind: "reel", real } : { kind: "illisible" };
}

/**
 * Chemin réel d'un chemin local qui peut ne pas exister encore : plus proche parent existant résolu, puis le reste ajouté. Seul un
 * élément réellement absent est sauté ; un lien présent (pendant, en boucle) arrête la lecture. Une cible qui existe déjà doit
 * être un fichier ordinaire à un seul nom.
 */
async function realpathOfTarget(local: string): Promise<TargetReal> {
  const rest: string[] = [];
  for (let probe = local; ; ) {
    const found = await probeOf(probe);
    if (found.kind === "reel") return rest.length > 0 ? underDirectory(found.real, rest) : singleNameFile(found.real);
    if (found.kind !== "absent") return found;
    const parent = path.dirname(probe);
    if (parent === probe) return { kind: "illisible" };
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}

/** Chemin réel local rendu dans la vue d'opencode ; null s'il sort du chemin réel du workspace. */
function opencodeView(scope: Scope, real: string): string | null {
  if (scope.realRoot === null || !isInside(scope.realRoot, real)) return null;
  const rel = path.relative(scope.realRoot, real);
  return rel === "" ? scope.projects.opencodeRoot : path.posix.join(scope.projects.opencodeRoot, ...rel.split(path.sep));
}

/** Faits d'un chemin d'opencode (absolu, « / » en tête). */
async function resolvePath(scope: Scope, presented: string): Promise<EditPathFacts> {
  if (!presented.startsWith("/") || presented.includes("\\") || presented.split("/").includes("..")) return unresolved(presented);
  const local = scope.projects.toLocalPath(path.posix.normalize(presented));
  if (local === null) return unresolved(presented);
  const found = await realpathOfTarget(local);
  if (found.kind !== "reel") return unresolved(presented, found.kind === "lien");
  const lexicallyInside = scope.localConversation !== null && isInside(scope.localConversation, local);
  const inside = scope.realConversation !== null && isInside(scope.realConversation, found.real);
  return { path: presented, resolved: opencodeView(scope, found.real), inside, symlinkOut: lexicallyInside && !inside };
}

async function realpathOrNull(file: string | null): Promise<string | null> {
  return file === null ? null : fs.realpath(file).catch(() => null);
}

async function scopeOf(projects: EditFactsProjects, conversationDir: string): Promise<Scope> {
  const realRoot = await realpathOrNull(projects.toLocalPath(projects.opencodeRoot));
  const localConversation = projects.toLocalPath(conversationDir);
  const realConversation = await realpathOrNull(localConversation);
  const isDirectory = realConversation !== null && (await fs.stat(realConversation).catch(() => null))?.isDirectory() === true;
  // Dossier-lien qui sort du workspace : tout ce qu'il contient est « lien sortant » (lexicalement intérieur, réellement dehors).
  const contained = isDirectory && realRoot !== null && realConversation !== null && isInside(realRoot, realConversation);
  return { projects, realRoot, localConversation: isDirectory ? localConversation : null, realConversation: contained ? realConversation : null };
}

/** E6 : dossier absolu du workspace, sans « .. » ni « \ » (même lecture que pour les chemins touchés). */
function isConversationDirectory(projects: EditFactsProjects, conversationDir: unknown): conversationDir is string {
  if (typeof conversationDir !== "string" || !conversationDir.startsWith("/") || conversationDir.includes("\\")) return false;
  return !conversationDir.split("/").includes("..") && projects.isAllowedDirectory(conversationDir);
}

/** Motifs de la demande, tels quels ; une entrée qui n'est pas une chaîne devient "" (jamais un motif relatif valide : E1). */
function patternsOf(request: JsonRecord): string[] {
  const patterns = own(request, "patterns");
  return Array.isArray(patterns) ? patterns.map((pattern) => (typeof pattern === "string" ? pattern : "")) : [];
}

/**
 * Chemin d'un motif : worktree + « / » + motif, sans normalisation (« .. » et « \ » restent visibles pour resolvePath). null :
 * worktree inconnu, ou motif vide, absolu, `~` ou `$` en tête (refusé aussi par E1).
 */
function patternPath(worktree: string | null, pattern: string): string | null {
  if (worktree === null || pattern === "" || /^[/\\~$]/.test(pattern)) return null;
  return worktree.endsWith("/") ? `${worktree}${pattern}` : `${worktree}/${pattern}`;
}

/**
 * Faits d'une demande de modification (§4.4) pour classifyEdit. `request` : propriétés de `permission.asked` (permission `edit`,
 * `patterns`, `metadata`) ; `conversationDir` : dossier de la conversation, vue d'opencode ; `filesSoFar` : fichiers déjà
 * modifiés automatiquement par la demande autonome en cours. Ne rejette pas : toute erreur du disque donne un chemin non résolu.
 */
export async function collectEditFacts(
  request: unknown,
  conversationDir: string,
  projects: EditFactsProjects,
  filesSoFar: EditFilesSoFar,
  options: EditFactsOptions = {},
): Promise<CollectedEditFacts> {
  const record = isRecord(request) ? request : {};
  const metadata = own(record, "metadata");
  const patterns = patternsOf(record);
  const targets = own(record, "permission") === "edit" ? editTargetPaths(metadata) : null;
  const directoryAllowed = isConversationDirectory(projects, conversationDir);
  const soFar = typeof filesSoFar === "number" ? filesSoFar : filesSoFar.size;
  const base = { directoryAllowed, patterns, deletesOrMoves: applyPatchDeletesOrMoves(metadata), diffs: editDiffs(metadata), filesSoFar: soFar };

  // Aucun accès au disque : E6 décide d'abord ; métadonnées illisibles, sans chemin touché, ou demande trop grande : E1.
  if (!directoryAllowed) return { ...base, paths: [], newFiles: 0, touchedFiles: [] };
  if (targets === null || targets.length === 0 || targets.length + patterns.length > EDIT_PATHS_MAX) {
    return { ...base, paths: [unresolved("")], newFiles: 0, touchedFiles: [] };
  }

  const scope = await scopeOf(projects, conversationDir);
  const facts = new Map<string, EditPathFacts>();
  const factsOf = async (presented: string): Promise<EditPathFacts> => {
    const known = facts.get(presented);
    if (known) return known;
    const found = await resolvePath(scope, presented);
    facts.set(presented, found);
    return found;
  };

  const touched = new Set<string>();
  for (const target of targets) {
    const found = await factsOf(target);
    touched.add(found.resolved ?? found.path);
  }
  const given = options.worktree ?? (await projects.opencodeWorktree(conversationDir).catch(() => null));
  const worktree = typeof given === "string" ? given : null;
  for (const pattern of patterns) {
    const presented = patternPath(worktree, pattern);
    if (presented === null) facts.set(`motif:${pattern}`, unresolved(pattern));
    else await factsOf(presented);
  }

  const touchedFiles = [...touched];
  const newFiles = typeof filesSoFar === "number" ? touchedFiles.length : touchedFiles.filter((file) => !filesSoFar.has(file)).length;
  return { ...base, paths: [...facts.values()], newFiles, touchedFiles };
}
