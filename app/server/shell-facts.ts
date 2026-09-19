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
// - le sous-arbre d'une recherche récursive (grep -r, rg, git grep) : chemins sensibles, fichiers cachés compris, sans descendre
//   dans un dossier sensible ni dans un lien ; au plus 10 000 entrées lues, au-delà : parcours impossible ;
// - `.git` : un DOSSIER (ni fichier `gitdir:`, ni lien, ni `commondir` qui ferait lire la configuration d'un autre dossier) et le
//   texte de `.git/config`, fichier ordinaire lu sans suivre de lien, borné à 64 Kio (au-delà, UTF-8 invalide ou octet nul :
//   illisible, donc attente).
// Jamais d'exécution de git ni d'aucun programme : M10 a mesuré que certaines sous-commandes ne lancent pas un `core.fsmonitor`
// piégé, mais la porte n'en a pas besoin. M11 : la configuration git GLOBALE du conteneur opencode (~/.gitconfig) est hors de tout
// volume du cockpit, illisible ici ; G04 ne vaut que pour le dépôt (« G04 limité au dépôt », README et Diagnostic).
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

/** Ce que le cockpit sait du workspace : racine d'opencode et correspondance avec le montage local. */
export type ShellFactsProjects = Pick<ProjectsService, "opencodeRoot" | "toLocalPath" | "toOpencodePath">;

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
export const SHELL_SYMLINK_MAX_HOPS = 40;
export const SHELL_RESOLVE_MAX_STEPS = 4096;
export const SHELL_WALK_MAX_ENTRIES = 10_000;
export const SHELL_DIR_SCAN_MAX_ENTRIES = 10_000;
/** Un seul chemin sensible suffit à la porte : le parcours s'arrête après ce nombre. */
const WALK_MAX_REPORTED = 20;

const NO_GIT: ShellGitFacts = Object.freeze({ gitIsDirectory: false, configText: null });
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
    this.#dir = dir !== null && this.#root !== null && within(this.#root, dir) ? dir : null;
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
    return Object.freeze({ gitIsDirectory: true, configText: await readBoundedText(path.join(gitDir, "config")) });
  }
}

/** Texte d'un fichier ordinaire (jamais un lien), UTF-8 valide, sans octet nul, de 64 Kio au plus ; null sinon. */
async function readBoundedText(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    // O_NOFOLLOW (Linux) : un lien posé après le contrôle est refusé à l'ouverture.
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(SHELL_GIT_CONFIG_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > SHELL_GIT_CONFIG_MAX_BYTES) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    return text.includes(NUL) ? null : text;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface Questions {
  paths: string[];
  walks: string[];
  git: boolean;
}

/** Questions que la porte posera pour `command` : première lecture sur des faits favorables (tout dedans, rien de sensible). */
function questionsOf(command: string, conversationDir: string): Questions {
  const paths = new Set<string>();
  const walks = new Set<string>();
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
    },
    get git(): ShellGitFacts {
      git = true;
      return { gitIsDirectory: true, configText: "" };
    },
  };
  classifyCommand(command, favourable);
  return { paths: [...paths], walks: [...walks], git };
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
  for (const arg of questions.paths) resolved.set(arg, dirOk ? await reader.pathFacts(arg) : null);
  for (const arg of questions.walks) walks.set(arg, dirOk ? await reader.sensitiveEntries(arg) : null);
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
    }),
  };
}
