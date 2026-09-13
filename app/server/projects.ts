// Projets = sous-dossiers de premier niveau du workspace monté.
import fs from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "./env.ts";
import { exists, PathError } from "./fsutil.ts";

export interface ProjectInfo {
  name: string;
  /** Chemin tel que vu par opencode (à passer en paramètre `directory`). */
  directory: string;
  isRoot: boolean;
  git: boolean;
  opencodeConfig: boolean;
  agentsMd: boolean;
  updatedAt: number;
}

const IGNORED = new Set(["node_modules", "$recycle.bin", "system volume information", "__pycache__"]);
const PROJECT_NAME = /^[^\\/:*?"<>|\0]{1,255}$/;

export class ProjectsService {
  readonly #localRoot: string;
  readonly #ocRoot: string;
  readonly #ocPath: path.PlatformPath;

  constructor(env: Pick<AppEnv, "workspaceDir" | "opencodeWorkspaceDir">) {
    this.#localRoot = path.resolve(env.workspaceDir);
    this.#ocRoot = env.opencodeWorkspaceDir;
    this.#ocPath = env.opencodeWorkspaceDir.startsWith("/") ? path.posix : path.win32;
  }

  get opencodeRoot(): string {
    return this.#ocRoot;
  }

  #relativeInside(api: path.PlatformPath, root: string, target: string): string | null {
    const rel = api.relative(api.resolve(root), api.resolve(target));
    if (rel === "") return "";
    if (rel.startsWith("..") || api.isAbsolute(rel)) return null;
    return rel;
  }

  toOpencodePath(localPath: string): string {
    const rel = this.#relativeInside(path, this.#localRoot, localPath);
    if (rel === null) throw new PathError("Chemin hors du workspace.");
    return rel === "" ? this.#ocRoot : this.#ocPath.join(this.#ocRoot, ...rel.split(path.sep));
  }

  toLocalPath(opencodePath: string): string | null {
    const rel = this.#relativeInside(this.#ocPath, this.#ocRoot, opencodePath);
    if (rel === null) return null;
    return rel === "" ? this.#localRoot : path.join(this.#localRoot, ...rel.split(this.#ocPath.sep));
  }

  /** Un répertoire transmis à opencode doit rester dans le workspace. */
  isAllowedDirectory(opencodePath: string): boolean {
    return opencodePath.length < 4_096 && !opencodePath.includes("\0") && this.toLocalPath(opencodePath) !== null;
  }

  async #describe(name: string, localDir: string, isRoot: boolean): Promise<ProjectInfo> {
    const stat = await fs.stat(localDir);
    const [git, opencodeConfig, agentsMd] = await Promise.all([
      exists(path.join(localDir, ".git")),
      exists(path.join(localDir, ".opencode")),
      exists(path.join(localDir, "AGENTS.md")),
    ]);
    return { name, directory: this.toOpencodePath(localDir), isRoot, git, opencodeConfig, agentsMd, updatedAt: stat.mtimeMs };
  }

  async list(): Promise<ProjectInfo[]> {
    const entries = await fs.readdir(this.#localRoot, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED.has(e.name.toLowerCase()))
      .slice(0, 300);
    const projects = await Promise.all(
      dirs.map((d) => this.#describe(d.name, path.join(this.#localRoot, d.name), false).catch(() => null)),
    );
    const root = await this.#describe("(racine)", this.#localRoot, true).catch(() => null);
    const sorted = projects.filter((p): p is ProjectInfo => p !== null).sort((a, b) => a.name.localeCompare(b.name, "fr"));
    return root ? [root, ...sorted] : sorted;
  }

  /** Dossier local d'un projet, après validation stricte du nom. */
  async resolve(name: string): Promise<string> {
    if (!PROJECT_NAME.test(name) || name === "." || name === ".." || name.trim() !== name) {
      throw new PathError("Nom de projet invalide.");
    }
    const dir = path.join(this.#localRoot, name);
    if (path.dirname(dir) !== this.#localRoot) throw new PathError("Nom de projet invalide.");
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw new PathError(`Projet introuvable : ${name}`);
    return dir;
  }
}
