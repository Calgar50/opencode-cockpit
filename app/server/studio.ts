// Studio : agents, commandes, skills et instructions (AGENTS.md) sous forme de fichiers opencode.
// Chaque écriture est vérifiée par opencode ; en cas de refus, retour arrière puis redémarrage si besoin.
import fs from "node:fs/promises";
import path from "node:path";
import { CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE } from "./classifier.ts";
import type { ControlService } from "./control.ts";
import type { AppEnv } from "./env.ts";
import { FrontmatterError, parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { assertInside, readIfExists, writeFileAtomic } from "./fsutil.ts";
import { errorMessage, type Logger } from "./log.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import type { ProjectsService } from "./projects.ts";
import {
  agentFrontmatterSchema,
  commandFrontmatterSchema,
  issuesFrom,
  MAX_DOC_BYTES,
  nameSchema,
  SKILL_FILE_RE,
  skillFrontmatterSchema,
  type StudioKind,
  type ValidationIssue,
} from "./studio-schema.ts";

export type StudioScope = { type: "global" } | { type: "project"; project: string };

export interface StudioItem {
  kind: StudioKind;
  name: string;
  scope: "global" | "project";
  project: string | null;
  /** Chemin relatif au dossier de configuration, pour affichage. */
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
  error: string | null;
  files: string[];
  updatedAt: number;
}

export class StudioValidationError extends Error {
  override name = "StudioValidationError";
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("Contenu invalide.");
    this.issues = issues;
  }
}

export class StudioApplyError extends Error {
  override name = "StudioApplyError";
  readonly issues: ValidationIssue[];
  readonly restarted: boolean;

  constructor(issues: ValidationIssue[], restarted: boolean) {
    super("opencode a refusé cette configuration : modification annulée.");
    this.issues = issues;
    this.restarted = restarted;
  }
}

const DIRS: Record<StudioKind, readonly [string, string]> = {
  agents: ["agents", "agent"],
  commands: ["commands", "command"],
  skills: ["skills", "skill"],
};
const VERIFY_ROUTE: Record<StudioKind, string> = { agents: "/agent", commands: "/command", skills: "/skill" };
const RESERVED = new Set([CLASSIFIER_AGENT]);

export interface StudioDeps {
  env: AppEnv;
  client: OpencodeClient;
  projects: ProjectsService;
  control: ControlService;
  log: Logger;
}

export class StudioService {
  readonly #d: StudioDeps;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(deps: StudioDeps) {
    this.#d = deps;
  }

  /** Les écritures de configuration sont sérialisées : un seul rechargement d'opencode à la fois. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  /**
   * La configuration par projet (.opencode/ des dépôts) est ignorée par opencode tant qu'elle n'est pas
   * explicitement autorisée : un dépôt pourrait y livrer des plugins exécutés sans confirmation.
   */
  #assertWritableScope(scope: StudioScope): void {
    if (scope.type === "project" && !this.#d.env.projectConfig) {
      throw new StudioValidationError([
        {
          path: "scope",
          message:
            "La configuration par projet (.opencode/) est désactivée pour la sécurité : un dépôt pourrait y exécuter du code sans confirmation. Utilisez la portée globale, ou ajoutez COCKPIT_PROJECT_CONFIG=1 dans .env si tous vos dépôts sont de confiance.",
        },
      ]);
    }
  }

  async #base(scope: StudioScope): Promise<string> {
    if (scope.type === "global") return this.#d.env.opencodeConfigDir;
    return path.join(await this.#d.projects.resolve(scope.project), ".opencode");
  }

  async #opencodeDirectory(scope: StudioScope): Promise<string | undefined> {
    if (scope.type === "global") return undefined;
    return this.#d.projects.toOpencodePath(await this.#d.projects.resolve(scope.project));
  }

  #fileFor(kind: StudioKind, base: string, dir: string, name: string): string {
    return kind === "skills" ? path.join(base, dir, name, "SKILL.md") : path.join(base, dir, `${name}.md`);
  }

  async #locate(kind: StudioKind, name: string, base: string): Promise<string | null> {
    // Point de passage unique : tout nom (y compris « ancien nom » et nom de skill des fichiers annexes)
    // est validé ici, ce qui interdit « ../ » et les séparateurs de chemin.
    if (!nameSchema.safeParse(name).success) throw new StudioValidationError([{ path: "name", message: "Nom invalide." }]);
    for (const dir of DIRS[kind]) {
      const file = this.#fileFor(kind, base, dir, name);
      if ((await readIfExists(file)) !== null) return file;
    }
    return null;
  }

  async #skillFiles(skillDir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || out.length >= 200) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile()) {
          const rel = path.relative(skillDir, full).split(path.sep).join("/");
          if (rel !== "SKILL.md") out.push(rel);
        }
      }
    };
    await walk(skillDir, 0);
    return out.sort();
  }

  async #read(kind: StudioKind, name: string, file: string, scope: StudioScope, base: string): Promise<StudioItem> {
    const [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    let frontmatter: Record<string, unknown> = {};
    let body = raw;
    let error: string | null = null;
    try {
      ({ data: frontmatter, body } = parseFrontmatter(raw));
    } catch (err) {
      error = err instanceof FrontmatterError ? err.message : errorMessage(err);
    }
    return {
      kind,
      name,
      scope: scope.type,
      project: scope.type === "project" ? scope.project : null,
      file: path.relative(base, file).split(path.sep).join("/"),
      frontmatter,
      body: body.replace(/^\n+/, ""),
      error,
      files: kind === "skills" ? await this.#skillFiles(path.dirname(file)) : [],
      updatedAt: stat.mtimeMs,
    };
  }

  async list(kind: StudioKind, scope: StudioScope): Promise<StudioItem[]> {
    const base = await this.#base(scope);
    const found = new Map<string, string>();
    for (const dir of DIRS[kind]) {
      const entries = await fs.readdir(path.join(base, dir), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        let name: string | null = null;
        if (kind === "skills" && entry.isDirectory()) {
          if ((await readIfExists(path.join(base, dir, entry.name, "SKILL.md"))) !== null) name = entry.name;
        } else if (kind !== "skills" && entry.isFile() && entry.name.endsWith(".md")) {
          name = entry.name.slice(0, -3);
        }
        if (name && !found.has(name) && !RESERVED.has(name)) found.set(name, this.#fileFor(kind, base, dir, name));
      }
    }
    const items = await Promise.all(
      [...found.entries()].map(([name, file]) => this.#read(kind, name, file, scope, base).catch(() => null)),
    );
    return items.filter((i): i is StudioItem => i !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(kind: StudioKind, name: string, scope: StudioScope): Promise<StudioItem | null> {
    if (!nameSchema.safeParse(name).success) return null;
    const base = await this.#base(scope);
    const file = await this.#locate(kind, name, base);
    return file ? this.#read(kind, name, file, scope, base) : null;
  }

  validate(
    kind: StudioKind,
    name: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): { frontmatter: Record<string, unknown>; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const nameCheck = nameSchema.safeParse(name);
    if (!nameCheck.success) issues.push(...issuesFrom(nameCheck.error).map((i) => ({ path: "name", message: i.message })));
    if (RESERVED.has(name)) issues.push({ path: "name", message: "Ce nom est réservé au cockpit." });
    const candidate = kind === "skills" ? { ...frontmatter, name } : frontmatter;
    const schema = kind === "agents" ? agentFrontmatterSchema : kind === "commands" ? commandFrontmatterSchema : skillFrontmatterSchema;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) issues.push(...issuesFrom(parsed.error).map((i) => ({ path: `frontmatter.${i.path}`, message: i.message })));
    if (kind === "commands" && !body.trim()) issues.push({ path: "body", message: "Le modèle de la commande (corps) est obligatoire." });
    if (kind === "skills" && !body.trim()) issues.push({ path: "body", message: "Les instructions du skill (corps) sont obligatoires." });
    if (Buffer.byteLength(body, "utf8") > MAX_DOC_BYTES) issues.push({ path: "body", message: "Contenu trop volumineux (256 Ko max)." });
    return { frontmatter: parsed.success ? (parsed.data as Record<string, unknown>) : candidate, issues };
  }

  async save(
    kind: StudioKind,
    scope: StudioScope,
    input: { name: string; previousName?: string | null; frontmatter: Record<string, unknown>; body: string },
  ): Promise<StudioItem> {
    return this.#serialize(async () => {
      this.#assertWritableScope(scope);
      const { frontmatter, issues } = this.validate(kind, input.name, input.frontmatter, input.body);
      if (issues.length > 0) throw new StudioValidationError(issues);
      const base = await this.#base(scope);
      const content = stringifyFrontmatter(frontmatter, input.body);
      const existing = await this.#locate(kind, input.name, base);
      const renaming = Boolean(input.previousName && input.previousName !== input.name);
      const previous = renaming ? await this.#locate(kind, input.previousName as string, base) : null;
      if (renaming && existing) throw new StudioValidationError([{ path: "name", message: "Un élément porte déjà ce nom." }]);
      if (renaming && !previous) throw new StudioValidationError([{ path: "previousName", message: "Élément d'origine introuvable." }]);

      if (!renaming) {
        const target = existing ?? this.#fileFor(kind, base, DIRS[kind][0], input.name);
        await assertInside(base, target);
        const backup = existing ? await readIfExists(existing) : null;
        await writeFileAtomic(target, content);
        await this.#verifyOrRollback(kind, scope, async () => {
          if (backup !== null) await writeFileAtomic(target, backup);
          else await fs.rm(kind === "skills" ? path.dirname(target) : target, { recursive: true, force: true });
        });
      } else {
        const previousPath = await assertInside(base, previous as string);
        const dir = path.basename(kind === "skills" ? path.dirname(path.dirname(previousPath)) : path.dirname(previousPath));
        const target = this.#fileFor(kind, base, dir, input.name);
        await assertInside(base, target);
        if (kind === "skills") await fs.cp(path.dirname(previousPath), path.dirname(target), { recursive: true, errorOnExist: true });
        await writeFileAtomic(target, content);
        const created = kind === "skills" ? path.dirname(target) : target;
        await this.#verifyOrRollback(kind, scope, () => fs.rm(created, { recursive: true, force: true }));
        await fs.rm(kind === "skills" ? path.dirname(previousPath) : previousPath, { recursive: true, force: true });
        await this.#reload(scope);
      }
      return (await this.get(kind, input.name, scope)) as StudioItem;
    });
  }

  async remove(kind: StudioKind, name: string, scope: StudioScope): Promise<boolean> {
    return this.#serialize(async () => {
      this.#assertWritableScope(scope);
      if (!nameSchema.safeParse(name).success || RESERVED.has(name)) return false;
      const base = await this.#base(scope);
      const file = await this.#locate(kind, name, base);
      if (!file) return false;
      const target = kind === "skills" ? path.dirname(file) : file;
      await assertInside(base, target);
      await fs.rm(target, { recursive: true, force: true });
      await this.#reload(scope);
      return true;
    });
  }

  async #reload(scope: StudioScope): Promise<void> {
    await this.#d.client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
    const directory = await this.#opencodeDirectory(scope);
    if (directory) await this.#d.client.request("POST", "/instance/dispose", { directory, timeoutMs: 20_000 }).catch(() => undefined);
  }

  async #verify(kind: StudioKind, scope: StudioScope): Promise<ValidationIssue[] | null> {
    await this.#reload(scope);
    const directory = await this.#opencodeDirectory(scope);
    try {
      await this.#d.client.request("GET", VERIFY_ROUTE[kind], { ...(directory ? { directory } : {}), timeoutMs: 30_000 });
      return null;
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 400) {
        const body = err.body as { name?: string; data?: { path?: string; issues?: Array<{ path?: unknown[]; message?: string }> } };
        const where = body?.data?.path ? path.basename(body.data.path) : "configuration";
        const issues = (body?.data?.issues ?? []).map((i) => ({
          path: `${where} → ${(i.path ?? []).map(String).join(".") || "(racine)"}`,
          message: i.message ?? "valeur refusée",
        }));
        return issues.length > 0 ? issues : [{ path: where, message: err.message }];
      }
      throw err;
    }
  }

  async #verifyOrRollback(kind: StudioKind, scope: StudioScope, rollback: () => Promise<unknown>): Promise<void> {
    const issues = await this.#verify(kind, scope);
    if (!issues) return;
    this.#d.log.warn("configuration refusée par opencode, retour arrière", { kind, issues });
    await rollback();
    // opencode peut rester bloqué sur une configuration invalide même corrigée : redémarrage si nécessaire.
    let restarted = false;
    if ((await this.#verify(kind, scope).catch(() => [{ path: "", message: "injoignable" }])) !== null) {
      const result = await this.#d.control.restartOpencode("configuration invalide annulée");
      restarted = result.ok;
    }
    throw new StudioApplyError(issues, restarted);
  }

  // --- Fichiers annexes des skills -------------------------------------------------

  async #skillDir(name: string, scope: StudioScope): Promise<string> {
    const base = await this.#base(scope);
    const file = await this.#locate("skills", name, base);
    if (!file) throw new StudioValidationError([{ path: "name", message: "Skill introuvable." }]);
    return path.dirname(file);
  }

  async #skillFile(name: string, relative: string, scope: StudioScope): Promise<string> {
    if (!SKILL_FILE_RE.test(relative) || relative.split("/").includes("..") || relative === "SKILL.md") {
      throw new StudioValidationError([{ path: "file", message: "Nom de fichier invalide." }]);
    }
    const dir = await this.#skillDir(name, scope);
    return assertInside(dir, path.join(dir, ...relative.split("/")));
  }

  async readSkillFile(name: string, relative: string, scope: StudioScope): Promise<string | null> {
    return readIfExists(await this.#skillFile(name, relative, scope));
  }

  async writeSkillFile(name: string, relative: string, content: string, scope: StudioScope): Promise<void> {
    this.#assertWritableScope(scope);
    if (Buffer.byteLength(content, "utf8") > MAX_DOC_BYTES || content.includes(String.fromCharCode(0))) {
      throw new StudioValidationError([{ path: "content", message: "Fichier texte de 256 Ko maximum uniquement." }]);
    }
    await writeFileAtomic(await this.#skillFile(name, relative, scope), content);
  }

  async deleteSkillFile(name: string, relative: string, scope: StudioScope): Promise<void> {
    this.#assertWritableScope(scope);
    await fs.rm(await this.#skillFile(name, relative, scope), { force: true });
  }

  // --- Instructions (AGENTS.md) ------------------------------------------------------

  async #instructionsFile(scope: StudioScope): Promise<string> {
    if (scope.type === "global") return path.join(this.#d.env.opencodeConfigDir, "AGENTS.md");
    return path.join(await this.#d.projects.resolve(scope.project), "AGENTS.md");
  }

  async getInstructions(scope: StudioScope): Promise<{ content: string; exists: boolean }> {
    const content = await readIfExists(await this.#instructionsFile(scope));
    return { content: content ?? "", exists: content !== null };
  }

  async saveInstructions(scope: StudioScope, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_DOC_BYTES) {
      throw new StudioValidationError([{ path: "content", message: "Contenu trop volumineux (256 Ko max)." }]);
    }
    await this.#serialize(async () => {
      await writeFileAtomic(await this.#instructionsFile(scope), content);
      await this.#reload(scope);
    });
  }

  /** Agent interne du classificateur, recréé s'il manque ou a été modifié. */
  async ensureClassifierAgent(): Promise<void> {
    await this.#serialize(async () => {
      const file = path.join(this.#d.env.opencodeConfigDir, "agents", `${CLASSIFIER_AGENT}.md`);
      if ((await readIfExists(file)) === CLASSIFIER_AGENT_FILE) return;
      await writeFileAtomic(file, CLASSIFIER_AGENT_FILE);
      await this.#verifyOrRollback("agents", { type: "global" }, () => fs.rm(file, { force: true }));
      this.#d.log.info("agent de classement installé");
    });
  }
}
