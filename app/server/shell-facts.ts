// Propriétaire : L8b.
// Porte shell, faits du disque (spécification §4.5 S5 et S6, §6 l.1040 ; mesures M10, M11 ; plan d'exécution, fiche L8b).
// collectShellContext(command, conversationDir, projects) relève, avant la décision et sans rien exécuter, les faits que la porte
// pure (shared/shell-gate.ts, L8a) demande pour `metadata.command` :
// - chaque chemin cité : chemin réel `real`, toujours rempli, dans l'espace de noms d'opencode (/workspace…). Les liens sont
//   suivis composant par composant (lstat, readlink ; au plus 40 liens, 4 096 étapes), leur cible lue comme opencode la lit ; un
//   lien dont la cible sort du dossier de la conversation, même absente du conteneur du cockpit (`docs/x` →
//   /home/node/.local/share/opencode/auth.json), donne `symlinkOut`. Un chemin qui n'existe pas garde son plus long préfixe
//   existant, puis le reste tel qu'écrit. Chaque composant existant doit porter son nom exact sur le disque : un alias du système
//   de fichiers (nom court 8.3 `ENV~1` pour `.env`, flux NTFS `a:b`, point final) rend les faits inconnus, et une casse différente
//   est remplacée par la casse du disque ; ce nom est cherché parmi 10 000 entrées au plus du dossier parent (au-delà : inconnu) ;
// - l'existence d'un argument de git diff ou git grep (révision possible sinon) ;
// - le sous-arbre d'une recherche récursive (grep -r, rg, git grep) : chemins sensibles, fichiers cachés compris, sans descendre
//   dans un dossier sensible ni dans un lien ; au plus 10 000 entrées lues, au-delà : parcours impossible ;
// - `.git` : un DOSSIER (ni fichier `gitdir:`, ni lien, ni `commondir` qui ferait lire la configuration d'un autre dossier) et le
//   texte de `.git/config`, fichier ordinaire lu sans suivre de lien, borné à 64 Kio (au-delà, UTF-8 invalide ou octet nul :
//   illisible, donc attente) ;
// - ce qui lance un programme sans clé de configuration (relecture 2-vague-1) : hook actif (entrée de `.git/hooks` hors
//   `*.sample`, 256 entrées lues au plus), sous-module (`.gitmodules`, `.git/modules`, lien de sous-module de l'index) ;
// - les chemins suivis de l'index `.git/index` (versions 2 à 4, SHA-1 ou SHA-256, 16 Mio au plus), lus sans suivre de lien :
//   ceux que sensitivePath juge sensibles, et les liens de sous-module. Index absent : vide (git fait de même). Index scindé ou
//   clairsemé (extension obligatoire « link » ou « sdir »), forme inattendue ou trop grand : illisible, donc attente.
// Jamais d'exécution de git ni d'aucun programme : M10 a mesuré que certaines sous-commandes ne lancent pas un `core.fsmonitor`
// piégé, mais la porte n'en a pas besoin. M11 : la configuration git GLOBALE du conteneur opencode (~/.gitconfig) est hors de tout
// volume du cockpit, illisible ici ; G04 ne vaut que pour le dépôt (« G04 limité au dépôt », guide E-08 et Diagnostic).
// Quels faits relever ? Une première lecture de la commande par la porte elle-même, sur des faits favorables, énumère les questions
// qu'elle posera ; sur les faits réels, elle n'en pose jamais d'autre, puisque la première étape qui échoue arrête tout. Une question
// imprévue reçoit null : attente, jamais une consultation automatique.
// Dossier de la conversation absent, hors du workspace, lien ou nom inexact, ou racine du workspace absente : aucun fait (tout
// attend). Composant illisible (droits refusés au cockpit) : faits inconnus, jamais « absent ».
// TOCTOU : les faits valent au moment de la décision ; un fichier modifié entre la décision et l'exécution échappe à la porte
// (propre au mécanisme `once`, documenté).
// Limite du poste de développement : un lien créé côté Linux sur un dossier Windows monté n'est pas toujours vu comme un lien par
// un cockpit lancé sous Windows ; en production, cockpit et opencode voient le même montage /workspace sous Linux.
import { type Dirent, constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectsService } from "./projects.ts";
import { classifyCommand, type ShellContext, type ShellGitFacts, type ShellPathFacts, sensitivePath } from "./shared/shell-gate.ts";

/**
 * Ce que le cockpit sait du workspace : racine d'opencode, correspondance avec le montage local, et la règle des dossiers transmis à
 * opencode (isAllowedDirectory : séquence %XX refusée, A22).
 */
export type ShellFactsProjects = Pick<ProjectsService, "opencodeRoot" | "toLocalPath" | "toOpencodePath" | "isAllowedDirectory">;

/**
 * Faits du disque d'une commande. L'appelant ajoute ce qu'il lit dans la demande et le choix de la conversation :
 * `classifyCommand(command, { ...faits, workdir, allowJudge })`.
 */
export type ShellDiskFacts = Pick<ShellContext, "conversationDir" | "paths" | "git">;

export interface ShellFactsLimits {
  /** Entrées examinées par parcours de sous-arbre (défaut SHELL_WALK_MAX_ENTRIES). Réglable pour les tests. */
  walkMaxEntries?: number;
  /** Entrées lues dans un dossier pour trouver le nom exact d'un composant (défaut SHELL_DIR_SCAN_MAX_ENTRIES). */
  dirScanMaxEntries?: number;
}

export const SHELL_GIT_CONFIG_MAX_BYTES = 64 * 1024;
export const SHELL_GIT_INDEX_MAX_BYTES = 16 * 1024 * 1024;
export const SHELL_GIT_HOOKS_MAX_ENTRIES = 256;
export const SHELL_SYMLINK_MAX_HOPS = 40;
export const SHELL_RESOLVE_MAX_STEPS = 4096;
export const SHELL_WALK_MAX_ENTRIES = 10_000;
export const SHELL_DIR_SCAN_MAX_ENTRIES = 10_000;
/** Un seul chemin sensible suffit à la porte : le parcours s'arrête après ce nombre. */
const WALK_MAX_REPORTED = 20;

const NO_GIT: ShellGitFacts = Object.freeze({ gitIsDirectory: false, configText: null, launcher: null, trackedSensitive: null });
const NUL = String.fromCharCode(0);
const posix = path.posix;

/** `target` est `dir` ou se trouve dessous (chemins POSIX absolus normalisés). */
function within(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir === "/" ? "/" : `${dir}/`);
}

function childOf(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** Dossier absolu POSIX normalisé, ou null. */
function normalizeAbsolute(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || value.includes(NUL)) return null;
  return posix.resolve(value);
}

type Kind = "dossier" | "fichier" | "autre" | "absent";

interface Resolution {
  facts: ShellPathFacts;
  /** Chemin local du chemin réel quand il existe entièrement sous le workspace ; null sinon. */
  local: string | null;
  kind: Kind;
}

/** Cible d'un lien lue comme opencode la lit : segments, depuis la racine (absolue) ou depuis le dossier du lien. */
interface LinkTarget {
  absolute: boolean;
  segments: string[];
}

class DiskReader {
  readonly #projects: ShellFactsProjects;
  /** Racine du workspace côté opencode, null si elle n'est pas un chemin POSIX absolu (aucun fait possible). */
  readonly #root: string | null;
  /** Dossier de la conversation côté opencode, normalisé ; null s'il est invalide. */
  readonly #dir: string | null;
  readonly #walkMax: number;
  readonly #scanMax: number;
  readonly #windowsLocal = path.sep === "\\";
  readonly #names = new Map<string, Promise<string | null>>();

  constructor(projects: ShellFactsProjects, conversationDir: string, limits: ShellFactsLimits) {
    this.#projects = projects;
    this.#root = normalizeAbsolute(projects.opencodeRoot);
    const dir = normalizeAbsolute(conversationDir);
    // Dossier qu'opencode ouvrirait ailleurs (séquence %XX, décodée une seconde fois : R106-a) : les faits lus ici décriraient un
    // autre dossier que celui où la commande s'exécute. Aucun fait, comme E6 pour les modifications.
    this.#dir = dir !== null && this.#root !== null && within(this.#root, dir) && projects.isAllowedDirectory(dir) ? dir : null;
    this.#walkMax = limits.walkMaxEntries ?? SHELL_WALK_MAX_ENTRIES;
    this.#scanMax = limits.dirScanMaxEntries ?? SHELL_DIR_SCAN_MAX_ENTRIES;
  }

  /** Le dossier de la conversation existe, c'est un dossier, et son chemin réel est lui-même (aucun lien, nom exact). */
  async conversationDirOk(): Promise<boolean> {
    if (this.#dir === null || this.#root === null) return false;
    // La racine du workspace n'est jamais lue par #resolve : si son montage manque, tout chemin passerait pour absent, donc dedans.
    const localRoot = this.#projects.toLocalPath(this.#root);
    const rootInfo = localRoot === null ? null : await fs.stat(localRoot).catch(() => null);
    if (rootInfo === null || !rootInfo.isDirectory()) return false;
    const resolved = await this.#resolve(this.#dir).catch(() => null);
    return resolved !== null && resolved.kind === "dossier" && resolved.facts.real === this.#dir && !resolved.facts.symlinkOut;
  }

  async pathFacts(arg: string): Promise<ShellPathFacts | null> {
    const resolved = await this.#resolve(arg).catch(() => null);
    return resolved === null ? null : resolved.facts;
  }

  /** `arg` existe sur le disque (liens suivis : un lien pendant compte comme absent, donc révision possible) ; null : inconnu. */
  async exists(arg: string): Promise<boolean | null> {
    const resolved = await this.#resolve(arg).catch(() => null);
    return resolved === null ? null : resolved.kind !== "absent";
  }

  /**
   * Nom exact de `name` dans le dossier local `parent` : lui-même s'il y figure tel quel ; sinon la seule entrée de même nom à la
   * casse près (système de fichiers insensible à la casse) ; sinon null (alias 8.3, flux, nom réécrit par le système). Au plus
   * `dirScanMaxEntries` entrées examinées : au-delà, null (faits inconnus).
   */
  #canonicalName(parent: string, name: string): Promise<string | null> {
    const key = `${parent}${NUL}${name}`;
    let pending = this.#names.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const folded = name.toLowerCase();
        const matches: string[] = [];
        let read = 0;
        for await (const entry of await fs.opendir(parent)) {
          read += 1;
          if (read > this.#scanMax) return null;
          if (entry.name === name) return name;
          if (entry.name.toLowerCase() === folded && matches.length < 2) matches.push(entry.name);
        }
        return matches.length === 1 ? (matches[0] as string) : null;
      })();
      this.#names.set(key, pending);
    }
    return pending;
  }

  /** Entrées du dossier local `dir`, triées par nom ; null si elles dépassent `budget` (lecture arrêtée là). */
  async #listDir(dir: string, budget: number): Promise<Dirent[] | null> {
    const entries: Dirent[] = [];
    for await (const entry of await fs.opendir(dir)) {
      if (entries.length >= budget) return null;
      entries.push(entry);
    }
    // Ordre stable (noms uniques dans un dossier) : le même sous-arbre donne toujours le même premier chemin sensible.
    return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** null : cible hors du workspace, ou impossible à placer dans l'espace de noms d'opencode. */
  #linkTarget(target: string): LinkTarget | null {
    if (this.#windowsLocal) {
      // Poste Windows : readlink rend une cible absolue en chemin Windows (lien créé sous Windows, jonction).
      if (path.win32.isAbsolute(target)) {
        let oc: string;
        try {
          oc = this.#projects.toOpencodePath(path.win32.resolve(target));
        } catch {
          return null;
        }
        return oc.startsWith("/") ? { absolute: true, segments: oc.split("/") } : null;
      }
      return { absolute: false, segments: target.split(/[\\/]/) };
    }
    // Cible absolue : lue dans l'espace de noms d'opencode, qui exécute la commande.
    return { absolute: target.startsWith("/"), segments: target.split("/") };
  }

  /**
   * Chemin réel de `written` (relatif au dossier de la conversation, ou absolu), dans l'espace de noms d'opencode. Au-dessus de la
   * racine du workspace, lecture lexicale ; dessous, lecture du disque composant par composant. null : faits impossibles.
   */
  async #resolve(written: string): Promise<Resolution | null> {
    const root = this.#root;
    const dir = this.#dir;
    if (root === null || dir === null || typeof written !== "string" || written.includes(NUL)) return null;
    const pending = (written.startsWith("/") ? written : `${dir}/${written}`).split("/");
    let current = "/";
    let kind: Kind = "dossier";
    let missing = false;
    let symlinkOut = false;
    let hops = 0;
    let steps = 0;
    /** Longueur de `pending` quand la cible d'un lien suivi aura été entièrement lue : son point d'arrivée est alors jugé. */
    const linkEnds: number[] = [];
    const settle = () => {
      while (linkEnds.length > 0 && pending.length <= (linkEnds[linkEnds.length - 1] as number)) {
        linkEnds.pop();
        if (!within(dir, current)) symlinkOut = true;
      }
    };
    const outside = (real: string): Resolution => ({ facts: { inside: false, symlinkOut: symlinkOut || linkEnds.length > 0, real }, local: null, kind: "absent" });

    for (;;) {
      settle();
      const segment = pending.shift();
      if (segment === undefined) break;
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        current = posix.dirname(current);
        if (!missing) kind = "dossier";
        continue;
      }
      const next = childOf(current, segment);
      if (!within(root, next)) {
        // Au-dessus de la racine du workspace : seul un ancêtre de la racine peut encore y mener (lecture lexicale).
        if (!within(next, root)) return outside(posix.resolve(next, pending.join("/") || "."));
        current = next;
        continue;
      }
      if (missing || next === root) {
        current = next;
        continue;
      }
      steps += 1;
      if (steps > SHELL_RESOLVE_MAX_STEPS) return null;
      const localParent = this.#projects.toLocalPath(current);
      const local = this.#projects.toLocalPath(next);
      if (localParent === null || local === null) return null;
      let info: Stats;
      try {
        info = await fs.lstat(local);
      } catch (err) {
        const code = errorCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") return null;
        // N'existe pas : le reste du chemin est pris tel qu'écrit.
        missing = true;
        kind = "absent";
        current = next;
        continue;
      }
      const name = await this.#canonicalName(localParent, segment);
      if (name === null) return null;
      if (info.isSymbolicLink()) {
        hops += 1;
        if (hops > SHELL_SYMLINK_MAX_HOPS) return null;
        const target = this.#linkTarget(await fs.readlink(local));
        if (target === null) {
          symlinkOut = true;
          return outside("/");
        }
        linkEnds.push(pending.length);
        pending.unshift(...target.segments);
        if (target.absolute) current = "/";
        continue;
      }
      current = childOf(current, name);
      // Un fichier suivi d'autres segments : lstat du suivant échoue (ENOTDIR), la suite est prise telle qu'écrite.
      kind = info.isDirectory() ? "dossier" : info.isFile() ? "fichier" : "autre";
    }
    return {
      facts: { inside: within(dir, current), symlinkOut, real: current },
      local: missing ? null : this.#projects.toLocalPath(current),
      kind,
    };
  }

  /**
   * Chemins sensibles que lirait une recherche récursive de `arg` : lui-même, puis son sous-arbre (fichiers cachés compris), jugés
   * par sensitivePath sur leur chemin relatif au dossier de la conversation ; ni descente dans un dossier sensible ni dans un lien.
   * null : départ hors du dossier, par un lien sortant, illisible, ou plus de `walkMax` entrées.
   */
  async sensitiveEntries(arg: string): Promise<readonly string[] | null> {
    const dir = this.#dir;
    if (dir === null) return null;
    let resolved: Resolution | null;
    try {
      resolved = await this.#resolve(arg);
    } catch {
      return null;
    }
    if (resolved === null || !resolved.facts.inside || resolved.facts.symlinkOut) return null;
    const rootRel = posix.relative(dir, resolved.facts.real);
    if (rootRel !== "" && sensitivePath(rootRel) !== null) return Object.freeze([rootRel]);
    if (resolved.kind !== "dossier" || resolved.local === null) return Object.freeze([]);
    const found: string[] = [];
    const queue: Array<{ local: string; rel: string }> = [{ local: resolved.local, rel: rootRel }];
    let seen = 0;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        // Lecture arrêtée dès que le plafond est dépassé, jamais un dossier entier en mémoire au-delà.
        const entries = await this.#listDir(next.local, this.#walkMax - seen);
        if (entries === null) return null;
        seen += entries.length;
        for (const entry of entries) {
          const rel = next.rel === "" ? entry.name : `${next.rel}/${entry.name}`;
          if (sensitivePath(rel) !== null) {
            found.push(rel);
            if (found.length >= WALK_MAX_REPORTED) return Object.freeze(found);
            continue;
          }
          // Type lu sans suivre les liens (un lien ou une jonction n'est pas un dossier) : grep -r et rg ne les suivent pas.
          if (entry.isDirectory()) queue.push({ local: path.join(next.local, entry.name), rel });
        }
      }
    } catch {
      return null;
    }
    return Object.freeze(found);
  }

  /** `.git` du dossier de la conversation (jamais d'exécution de git). */
  async gitFacts(): Promise<ShellGitFacts> {
    const localDir = this.#dir === null ? null : this.#projects.toLocalPath(this.#dir);
    if (localDir === null) return NO_GIT;
    const gitDir = path.join(localDir, ".git");
    try {
      const info = await fs.lstat(gitDir);
      if (info.isSymbolicLink() || !info.isDirectory()) return NO_GIT;
    } catch {
      return NO_GIT;
    }
    // `commondir` : git lirait la configuration du dossier qu'il désigne, et non `.git/config`.
    try {
      await fs.lstat(path.join(gitDir, "commondir"));
      return NO_GIT;
    } catch (err) {
      if (errorCode(err) !== "ENOENT") return NO_GIT;
    }
    const configText = await readBoundedText(path.join(gitDir, "config"));
    const index = await readGitIndex(path.join(gitDir, "index"));
    const launcher = (await hookLauncher(gitDir)) ?? (await submoduleLauncher(localDir, gitDir, index));
    const trackedSensitive = index === null ? null : Object.freeze(index.paths.filter((file) => sensitivePath(file) !== null).slice(0, WALK_MAX_REPORTED));
    return Object.freeze({ gitIsDirectory: true, configText, launcher, trackedSensitive });
  }
}

/**
 * Hook actif : toute entrée de `.git/hooks` qui ne finit pas par `.sample` (git ne lance que les fichiers exécutables d'un nom
 * de hook, mais sur un montage Windows tout fichier paraît exécutable, et la liste des hooks grandit avec git). Premier nom par
 * ordre alphabétique, « hooks-illisibles » (lien, fichier, droits, plus de SHELL_GIT_HOOKS_MAX_ENTRIES entrées) ; null : aucun.
 */
async function hookLauncher(gitDir: string): Promise<string | null> {
  const hooks = path.join(gitDir, "hooks");
  const names: string[] = [];
  try {
    if (!(await fs.lstat(hooks)).isDirectory()) return "hooks-illisibles";
    for await (const entry of await fs.opendir(hooks)) {
      if (names.length >= SHELL_GIT_HOOKS_MAX_ENTRIES) return "hooks-illisibles";
      names.push(entry.name);
    }
  } catch (err) {
    return errorCode(err) === "ENOENT" && names.length === 0 ? null : "hooks-illisibles";
  }
  const active = names.filter((name) => !name.endsWith(".sample")).sort((a, b) => (a < b ? -1 : 1));
  return active.length > 0 ? `hook:${active[0]}` : null;
}

/**
 * Sous-module : git status et git diff visitent chaque lien de sous-module peuplé de l'index et y lancent git, qui lit ALORS la
 * configuration et les hooks du sous-module. `.gitmodules` ou `.git/modules` présents (ou illisibles), lien de sous-module dans
 * l'index, index illisible : un détail ; null : aucun.
 */
async function submoduleLauncher(localDir: string, gitDir: string, index: GitIndex | null): Promise<string | null> {
  const markers: ReadonlyArray<readonly [string, string]> = [
    [".gitmodules", path.join(localDir, ".gitmodules")],
    [".git/modules", path.join(gitDir, "modules")],
  ];
  for (const [name, file] of markers) {
    try {
      await fs.lstat(file);
      return `sous-module:${name}`;
    } catch (err) {
      if (errorCode(err) !== "ENOENT") return `illisible:${name}`;
    }
  }
  if (index === null) return "index-illisible";
  const gitlink = index.gitlinks[0];
  return gitlink === undefined ? null : `sous-module:${gitlink}`;
}

/**
 * Octets d'un fichier ordinaire (jamais un lien), `max` au plus ; « absent » s'il n'existe pas (ENOENT), pour le distinguer d'un
 * fichier illisible ; null sinon, ou si sa taille change pendant la lecture.
 */
async function readBoundedBytes(file: string, max: number): Promise<Buffer | "absent" | null> {
  let handle: fs.FileHandle;
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    // O_NOFOLLOW (Linux) : un lien posé après le contrôle est refusé à l'ouverture.
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    return errorCode(err) === "ENOENT" ? "absent" : null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    // Un octet de plus que la taille annoncée : un fichier qui a grandi entre-temps est vu, jamais lu à moitié.
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total === info.size ? buffer.subarray(0, total) : null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Texte d'un fichier ordinaire (jamais un lien), UTF-8 valide, sans octet nul, de 64 Kio au plus ; null sinon. */
async function readBoundedText(file: string): Promise<string | null> {
  const bytes = await readBoundedBytes(file, SHELL_GIT_CONFIG_MAX_BYTES);
  if (bytes === null || bytes === "absent") return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes(NUL) ? null : text;
  } catch {
    return null;
  }
}

/** Chemins de l'index git (dans l'ordre de l'index, étapes de conflit comprises) et liens de sous-module (mode 160000). */
interface GitIndex {
  paths: readonly string[];
  gitlinks: readonly string[];
}

const EMPTY_INDEX: GitIndex = Object.freeze({ paths: Object.freeze([]), gitlinks: Object.freeze([]) });

/** Index `.git/index` : absent → vide (git fait de même) ; lien, trop grand, forme inattendue ou illisible → null. */
async function readGitIndex(file: string): Promise<GitIndex | null> {
  const bytes = await readBoundedBytes(file, SHELL_GIT_INDEX_MAX_BYTES);
  if (bytes === "absent") return EMPTY_INDEX;
  return bytes === null ? null : parseGitIndex(bytes);
}

/**
 * Lecture stricte de l'index (gitformat-index) sans connaître la taille de l'empreinte : SHA-1 (20 octets) et SHA-256 (32) sont
 * essayés. Une seule lecture tient en général ; si les deux tiennent (index fabriqué), les chemins des deux comptent.
 */
export function parseGitIndex(buffer: Buffer): GitIndex | null {
  const sha1 = parseGitIndexWith(buffer, 20);
  const sha256 = parseGitIndexWith(buffer, 32);
  if (sha1 === null || sha256 === null) return sha1 ?? sha256;
  return { paths: [...new Set([...sha1.paths, ...sha256.paths])], gitlinks: [...new Set([...sha1.gitlinks, ...sha256.gitlinks])] };
}

/** Types d'objet permis dans une entrée (mode >> 12) : fichier, lien symbolique, lien de sous-module. Un dossier clairsemé : non. */
const INDEX_FILE = 0o10;
const INDEX_SYMLINK = 0o12;
const INDEX_GITLINK = 0o16;

/** Entier de longueur variable d'un index v4 (préfixe à retirer du nom précédent) ; null si tronqué ou démesuré. */
function readIndexVarint(buffer: Buffer, at: number): { value: number; next: number } | null {
  let byte = buffer[at];
  if (byte === undefined) return null;
  let value = byte & 127;
  let next = at + 1;
  while ((byte & 128) !== 0) {
    byte = buffer[next];
    if (byte === undefined || value > 0xffff) return null;
    value = (value + 1) * 128 + (byte & 127);
    next += 1;
  }
  return { value, next };
}

function parseGitIndexWith(buffer: Buffer, hashSize: number): GitIndex | null {
  if (buffer.length < 12 + hashSize || buffer.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = buffer.readUInt32BE(4);
  const count = buffer.readUInt32BE(8);
  if (version < 2 || version > 4) return null;
  const end = buffer.length - hashSize;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  const gitlinks: string[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let at = 12;
  for (let k = 0; k < count; k++) {
    const start = at;
    // 40 octets de métadonnées, l'empreinte, 2 octets d'indicateurs (plus 2 en version 3 et 4 quand le bit « étendu » est mis).
    at += 40 + hashSize + 2;
    if (at > end) return null;
    const mode = buffer.readUInt32BE(start + 24);
    const flags = buffer.readUInt16BE(at - 2);
    if ((flags & 0x4000) !== 0) {
      if (version < 3) return null;
      at += 2;
    }
    let name: Buffer;
    if (version === 4) {
      const strip = readIndexVarint(buffer, at);
      const nul = strip === null ? -1 : buffer.indexOf(0, strip.next);
      if (strip === null || nul < 0 || nul >= end || strip.value > previous.length) return null;
      name = Buffer.concat([previous.subarray(0, previous.length - strip.value), buffer.subarray(strip.next, nul)]);
      at = nul + 1;
    } else {
      const nul = buffer.indexOf(0, at);
      if (nul < 0 || nul >= end) return null;
      name = buffer.subarray(at, nul);
      // 1 à 8 octets nuls : l'entrée finit sur un multiple de 8 octets.
      const next = start + ((at - start + name.length + 8) & ~7);
      if (next > end || buffer.subarray(nul, next).some((byte) => byte !== 0)) return null;
      at = next;
    }
    const type = mode >>> 12;
    if (mode >>> 16 !== 0 || (type !== INDEX_FILE && type !== INDEX_SYMLINK && type !== INDEX_GITLINK)) return null;
    if (name.length === 0 || (flags & 0x0fff) !== Math.min(name.length, 0x0fff)) return null;
    let text: string;
    try {
      text = decoder.decode(name);
    } catch {
      return null;
    }
    paths.push(text);
    if (type === INDEX_GITLINK) gitlinks.push(text);
    previous = name;
  }
  // Extensions : signature, taille, données. Une extension obligatoire (première lettre hors A-Z : « link » de l'index scindé,
  // « sdir » de l'index clairsemé) cache des chemins que cette lecture ne voit pas.
  while (at < end) {
    const first = buffer[at] ?? 0;
    if (at + 8 > end || first < 0x41 || first > 0x5a) return null;
    at += 8 + buffer.readUInt32BE(at + 4);
  }
  return at === end ? { paths, gitlinks } : null;
}

interface Questions {
  paths: string[];
  walks: string[];
  exists: string[];
  git: boolean;
}

/** Questions que la porte posera pour `command` : première lecture sur des faits favorables (tout dedans, rien de sensible). */
function questionsOf(command: string, conversationDir: string): Questions {
  const paths = new Set<string>();
  const walks = new Set<string>();
  const exists = new Set<string>();
  let git = false;
  const dir = normalizeAbsolute(conversationDir) ?? "/";
  const favourable: ShellContext = {
    conversationDir,
    workdir: null,
    allowJudge: false,
    paths: {
      resolve(arg: string): ShellPathFacts {
        paths.add(arg);
        return { inside: true, symlinkOut: false, real: posix.resolve(dir, arg) };
      },
      sensitiveEntries(arg: string): readonly string[] {
        walks.add(arg);
        return [];
      },
      exists(arg: string): boolean {
        exists.add(arg);
        return true;
      },
    },
    get git(): ShellGitFacts {
      git = true;
      return { gitIsDirectory: true, configText: "", launcher: null, trackedSensitive: [] };
    },
  };
  classifyCommand(command, favourable);
  return { paths: [...paths], walks: [...walks], exists: [...exists], git };
}

/**
 * Faits du disque dont la porte a besoin pour `command` (texte complet de `metadata.command`), dans `conversationDir` (chemin
 * d'opencode, /workspace/…). Aucun programme lancé ; lectures bornées. Une question que la porte n'avait pas annoncée reçoit null.
 */
export async function collectShellContext(
  command: string,
  conversationDir: string,
  projects: ShellFactsProjects,
  limits: ShellFactsLimits = {},
): Promise<ShellDiskFacts> {
  const questions = questionsOf(command, conversationDir);
  const reader = new DiskReader(projects, conversationDir, limits);
  const dirOk = await reader.conversationDirOk();
  const resolved = new Map<string, ShellPathFacts | null>();
  const walks = new Map<string, readonly string[] | null>();
  const existing = new Map<string, boolean | null>();
  for (const arg of questions.paths) resolved.set(arg, dirOk ? await reader.pathFacts(arg) : null);
  for (const arg of questions.walks) walks.set(arg, dirOk ? await reader.sensitiveEntries(arg) : null);
  for (const arg of questions.exists) existing.set(arg, dirOk ? await reader.exists(arg) : null);
  const git = dirOk && questions.git ? await reader.gitFacts() : NO_GIT;
  return {
    conversationDir,
    git,
    paths: Object.freeze({
      resolve(arg: string): ShellPathFacts | null {
        const facts = resolved.get(arg);
        return facts === undefined || facts === null ? null : { ...facts };
      },
      sensitiveEntries(arg: string): readonly string[] | null {
        return walks.get(arg) ?? null;
      },
      exists(arg: string): boolean | null {
        return existing.get(arg) ?? null;
      },
    }),
  };
}
