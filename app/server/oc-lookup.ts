// Agents et raccourcis tels qu'opencode les voit (GET /agent, GET /command), par dossier, avec un cache court.
// Sert au proxy (IA réellement facturée) et à POST /api/chat/resolve : une seule source pour les deux.
import path from "node:path";
import type { AppEnv } from "./env.ts";
import { FrontmatterError, parseFrontmatter } from "./frontmatter.ts";
import { readIfExists } from "./fsutil.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";
import { type Action, type AgentLite, type CommandLite, NAME_RE, type Rule } from "./shared/assistant-rules.ts";

export interface OcAgentInfo extends AgentLite {
  description?: string;
  native?: boolean;
  prompt?: string;
  steps?: number;
  /** Règles effectives (défauts, configuration globale, agent), toujours présentes. */
  permission: Rule[];
}

export interface OcCommandInfo extends CommandLite {
  description?: string;
  hints: string[];
}

export interface OcLookupSnapshot {
  /** Chemin vu par opencode ; null = instance par défaut. */
  directory: string | null;
  agents: OcAgentInfo[];
  /** `fileVariant` lu dans le fichier global commands/<nom>.md (ou command/). */
  commands: OcCommandInfo[];
  loadedAt: number;
}

export const LOOKUP_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Dossiers gardés en cache au plus (les dossiers viennent de requêtes : la mémoire reste bornée). */
const MAX_DIRECTORIES = 50;
const MAX_ITEMS = 1_000;
const COMMAND_DIRS = ["commands", "command"] as const;

/** Événements du cockpit après lesquels agents, raccourcis ou niveaux ont pu changer. */
const COCKPIT_EVENTS = new Set(["studio.changed", "opencode.config.changed", "ai.changed"]);
/** Rechargement de la configuration par opencode lui-même. */
const OPENCODE_EVENTS = new Set(["global.disposed", "server.instance.disposed"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

function isAction(v: unknown): v is Action {
  return v === "allow" || v === "ask" || v === "deny";
}

function toRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const rules: Rule[] = [];
  for (const item of raw.slice(0, 5_000)) {
    if (!isRecord(item)) continue;
    const permission = text(item.permission, 200);
    const pattern = typeof item.pattern === "string" && item.pattern.length <= 1_000 ? item.pattern : undefined;
    if (permission === undefined || pattern === undefined || !isAction(item.action)) continue;
    rules.push({ permission, pattern, action: item.action });
  }
  return rules;
}

/** Réponse de GET /agent (Agent.Info d'opencode 1.18.30) réduite et vérifiée : c'est une entrée externe. */
export function toAgentInfo(raw: unknown): OcAgentInfo | null {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, 200);
  if (name === undefined) return null;
  const mode = raw.mode === "primary" || raw.mode === "subagent" || raw.mode === "all" ? raw.mode : "all";
  const agent: OcAgentInfo = { name, mode, permission: toRules(raw.permission) };
  if (isRecord(raw.model)) {
    const providerID = text(raw.model.providerID, 100);
    const modelID = text(raw.model.modelID, 200);
    if (providerID !== undefined && modelID !== undefined) agent.model = { providerID, modelID };
  }
  const variant = text(raw.variant, 40);
  if (variant !== undefined) agent.variant = variant;
  if (typeof raw.hidden === "boolean") agent.hidden = raw.hidden;
  if (typeof raw.native === "boolean") agent.native = raw.native;
  const description = text(raw.description, 4_000);
  if (description !== undefined) agent.description = description;
  const prompt = text(raw.prompt, 512 * 1024);
  if (prompt !== undefined) agent.prompt = prompt;
  if (typeof raw.steps === "number" && Number.isInteger(raw.steps) && raw.steps > 0) agent.steps = raw.steps;
  return agent;
}

/** Réponse de GET /command (Command.Info d'opencode 1.18.30) réduite et vérifiée. */
export function toCommandInfo(raw: unknown): OcCommandInfo | null {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, 200);
  if (name === undefined) return null;
  const hints = Array.isArray(raw.hints) ? raw.hints.filter((h): h is string => typeof h === "string" && h.length <= 200).slice(0, 50) : [];
  const command: OcCommandInfo = { name, hints };
  const agent = text(raw.agent, 200);
  if (agent !== undefined) command.agent = agent;
  const model = text(raw.model, 300);
  if (model !== undefined && model.includes("/")) command.model = model;
  if (typeof raw.subtask === "boolean") command.subtask = raw.subtask;
  if (raw.source === "command" || raw.source === "mcp" || raw.source === "skill") command.source = raw.source;
  const description = text(raw.description, 4_000);
  if (description !== undefined) command.description = description;
  return command;
}

export interface OcLookupDeps {
  client: OpencodeClient;
  env: Pick<AppEnv, "opencodeConfigDir">;
  hub: EventHub;
  log: Logger;
  ttlMs?: number;
}

export class OcLookup {
  readonly #d: OcLookupDeps;
  readonly #ttl: number;
  readonly #cache = new Map<string, OcLookupSnapshot>();
  readonly #pending = new Map<string, Promise<OcLookupSnapshot>>();
  readonly #unsubscribe: () => void;
  /** Incrémenté à chaque invalidation : un chargement lancé avant n'alimente pas le cache. */
  #generation = 0;

  constructor(deps: OcLookupDeps) {
    this.#d = deps;
    this.#ttl = deps.ttlMs ?? LOOKUP_TTL_MS;
    this.#unsubscribe = deps.hub.subscribe((event) => {
      if (event.kind === "cockpit" ? COCKPIT_EVENTS.has(event.type) : OPENCODE_EVENTS.has(event.event.type)) this.invalidate();
    });
  }

  /** Instantané des agents et raccourcis d'un dossier (cache TTL). Lève une erreur si opencode ne répond pas. */
  get(directory?: string | null): Promise<OcLookupSnapshot> {
    const key = directory ?? "";
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.loadedAt < this.#ttl) return Promise.resolve(cached);
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const generation = this.#generation;
    const load: Promise<OcLookupSnapshot> = this.#load(directory ?? null)
      .then((snapshot) => {
        if (generation === this.#generation) this.#remember(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.#pending.get(key) === load) this.#pending.delete(key);
      });
    this.#pending.set(key, load);
    return load;
  }

  /** Sans argument : tout le cache. `null` : instance par défaut. */
  invalidate(directory?: string | null): void {
    this.#generation++;
    if (directory === undefined) {
      this.#cache.clear();
      this.#pending.clear();
      return;
    }
    const key = directory ?? "";
    this.#cache.delete(key);
    this.#pending.delete(key);
  }

  /** Se désabonne des événements (tests, arrêt). */
  close(): void {
    this.#unsubscribe();
  }

  #remember(key: string, snapshot: OcLookupSnapshot): void {
    this.#cache.delete(key);
    this.#cache.set(key, snapshot);
    while (this.#cache.size > MAX_DIRECTORIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  async #load(directory: string | null): Promise<OcLookupSnapshot> {
    const options = { ...(directory !== null ? { directory } : {}), timeoutMs: REQUEST_TIMEOUT_MS };
    const [rawAgents, rawCommands] = await Promise.all([
      this.#d.client.request<unknown>("GET", "/agent", options),
      this.#d.client.request<unknown>("GET", "/command", options),
    ]);
    if (!Array.isArray(rawAgents) || !Array.isArray(rawCommands)) {
      throw new Error("Réponse inattendue d'opencode pour la liste des agents ou des commandes.");
    }
    const agents = rawAgents.slice(0, MAX_ITEMS).map(toAgentInfo).filter((a): a is OcAgentInfo => a !== null);
    const commands = rawCommands.slice(0, MAX_ITEMS).map(toCommandInfo).filter((c): c is OcCommandInfo => c !== null);
    await Promise.all(
      commands.map(async (command) => {
        const variant = await this.#fileVariant(command);
        if (variant !== undefined) command.fileVariant = variant;
      }),
    );
    return { directory, agents, commands, loadedAt: Date.now() };
  }

  /**
   * « variant: » du fichier global de la commande : opencode l'accepte mais ne l'utilise jamais
   * (command/index.ts:22-32, 90-103) ; le cockpit l'injecte dans le corps (conception §5.2).
   */
  async #fileVariant(command: OcCommandInfo): Promise<string | undefined> {
    if (command.source !== undefined && command.source !== "command") return undefined;
    // Nom validé avant de construire un chemin : ni « .. », ni séparateur.
    if (command.name.length > 64 || !NAME_RE.test(command.name)) return undefined;
    for (const dir of COMMAND_DIRS) {
      const file = path.join(this.#d.env.opencodeConfigDir, dir, `${command.name}.md`);
      try {
        const content = await readIfExists(file);
        if (content === null) continue;
        const variant = parseFrontmatter(content).data.variant;
        return typeof variant === "string" && variant.length > 0 && variant.length <= 40 ? variant : undefined;
      } catch (err) {
        if (!(err instanceof FrontmatterError)) {
          this.#d.log.warn("fichier de commande illisible", { command: command.name, error: errorMessage(err) });
        }
        return undefined;
      }
    }
    return undefined;
  }
}
