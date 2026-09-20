// Faux opencode 1.18.30 scripté pour les tests (node:http seul). Formes et ordres d'événements repris des captures
// ocgraph et ocauto du 2026-09-14 et des sources (packages/opencode/src au tag v1.18.30).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { OcAssistantMessage, OcEvent, OcMessageWithParts, OcPart, OcSession, OcTokens, OcUserMessage } from "../opencode.ts";
import { lineDiff, listenFetchable } from "./helpers.ts";

// Liste des ports refusés par fetch, et son commentaire : ../fetch-ports.ts (module du serveur). Ré-exportée pour les tests.
export { FETCH_BLOCKED_PORTS } from "../fetch-ports.ts";

export type RuleAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: RuleAction;
}

export type PermissionReply = "once" | "always" | "reject";

/** Demande d'autorisation (permission.asked, GET /permission). `tool` absent pour doom_loop (processor.ts:372-379). */
export interface FakePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export type FakeSession = OcSession & { path?: string; permission?: PermissionRule[] };

/** Jumeau « sync » d'un événement durable (event-v2-bridge.ts:46-58). */
export interface SyncPayload {
  id: string;
  type: "sync";
  syncEvent: { id: string; type: string; seq: number; aggregateID: string; data: Record<string, unknown> };
}

/** Bloc diffusé sur /global/event. */
export interface FakeWireEvent {
  directory?: string;
  project?: string;
  payload: OcEvent | SyncPayload;
}

export interface FakeRequest {
  method: string;
  pathname: string;
  /** Paramètres de l'adresse, sans `auth_token`. Aucun en-tête n'est gardé. */
  query: Record<string, string>;
  body: unknown;
  authorized: boolean;
}

export interface FakeUsage {
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

/** Appel d'outil scripté. */
export interface FakeToolScript {
  tool: string;
  callID?: string;
  input: Record<string, unknown>;
  /**
   * Demande posée par l'outil ; absente : l'outil s'exécute sans rien évaluer. `scope` « session » (défaut) : règles de l'agent
   * puis de la session ; « agent » (défaut pour doom_loop, processor.ts:372-379, F-j) : règles de l'agent seules, demande sans `tool`.
   */
  ask?: { permission: string; patterns: string[]; metadata?: Record<string, unknown>; always?: string[]; scope?: "agent" | "session" };
  /**
   * Travail de l'outil avant sa demande : la partie passe « running », puis l'outil évalue ses règles et pose sa demande quand la
   * promesse est tenue (opencode 1.18.30 réel, répétition générale de l'itération 1 : edit lit le fichier et calcule le diff, 5 à
   * 7 ms ; bash analyse la commande, environ 100 ms au premier appel d'un opencode neuf). Absent : demande aussitôt.
   */
  beforeAsk?: () => Promise<void>;
  /**
   * Pause entre la partie « pending » de l'outil et son évaluation (sa demande), en ms ; absente : le pas du tour (`stepMs`).
   * opencode 1.18.30 réel pose permission.asked quelques millisecondes après la partie `task` (clôture de l'itération 1, rg-reel-7) :
   * un scénario qui regarde ce que la page dessine AVANT la demande la fixe à quelques ms, sinon le pas du tour lui en laisse le
   * temps. Valeur JSON : le banc e2e la transmet telle quelle (e2e/fake-opencode-server.ts).
   */
  askAfterMs?: number;
  /** Règles de l'agent, évaluées avant celles de la session (F-d). */
  agentRules?: PermissionRule[];
  output?: string;
  /**
   * Outil « task » : sous-agent lancé après l'accord (tool/task.ts:136-215). `input.task_id` d'une session existante : cette
   * session est reprise, sans création. `model` : IA fixée par l'agent cible (aucune variante transmise). `turn` : tour complet
   * joué par l'enfant (outils, demandes, coût à chaque étape) ; absent : un seul texte (`text`), coût à la fin, après `workMs`.
   */
  child?: FakeUsage & {
    agent: string;
    text?: string;
    agentRules?: PermissionRule[];
    workMs?: number;
    model?: { providerID: string; modelID: string };
    turn?: FakeTurnScript;
  };
}

/** Tour d'assistant scripté : outils en parallèle dans un même message, puis reprise. */
export interface FakeTurnScript extends FakeUsage {
  agent?: string;
  providerID?: string;
  modelID?: string;
  /** Réponse d'un tour sans outil. */
  text?: string;
  tools?: FakeToolScript[];
  /** Tour de reprise après les outils. */
  followUp?: FakeUsage & { text?: string };
  /** Tour qui échoue (erreur de fournisseur…). */
  error?: NonNullable<OcAssistantMessage["error"]>;
  /** Pause entre deux groupes d'événements, en ms (défaut 1). */
  stepMs?: number;
  /** Tour de résumé (POST /session/:id/summarize) : `summary: true` sur les messages d'assistant. */
  summary?: boolean;
}

export interface FakeOpencodeOptions {
  username?: string;
  /** Absent ou vide : aucune authentification. */
  password?: string;
  directory?: string;
  project?: string;
  version?: string;
  heartbeatMs?: number;
  syncTwins?: boolean;
  /** Configuration globale (GET /global/config) ; sa clé « permission » donne les règles des agents natifs. Défaut : profil Prudent. */
  config?: Record<string, unknown>;
}

type Outcome = { reply: PermissionReply; message?: string };
type ModelRef = { providerID: string; modelID: string; variant?: string };
type ChildResult = { sessionID: string; text: string; part: OcPart | null; failed?: string };

interface Run {
  sessionID: string;
  aborted: boolean;
  /** Arrêt sans événement (fermeture du faux). */
  quiet: boolean;
  /** Boucle terminée, repos publié (fin normale ou tour en erreur). */
  finished: boolean;
  queue: Array<{ user: OcMessageWithParts; turn: FakeTurnScript }>;
  assistant: OcMessageWithParts | null;
  last: OcMessageWithParts | null;
  children: Set<string>;
  stopped: Promise<void>;
  stop: () => void;
  done: Promise<void>;
}

interface PendingEntry {
  info: FakePermissionRequest;
  directory: string;
  settle: (outcome: Outcome) => void;
  run: Run;
  session: FakeSession;
  tool: FakeToolScript;
  model: ModelRef;
  stepMs: number;
}

interface Waiter {
  test: (wire: FakeWireEvent) => OcEvent | null;
  resolve: (event: OcEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Écriture d'un message ou d'une partie d'une session supprimée : refusée par la base (clé étrangère), rien n'est diffusé. */
class ForeignKeyError extends Error {
  constructor() {
    super("FOREIGN KEY constraint failed");
  }
}

const DURABLE_EVENTS = new Set(["session.created", "session.updated", "session.deleted", "message.updated", "message.removed", "message.part.updated", "message.part.removed"]);
const ABORTED = { name: "MessageAbortedError", data: { message: "Aborted" } };
const REJECTED = "The user rejected permission to use this specific tool call.";
const DEFAULT_MODEL: ModelRef = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const MAX_BODY_BYTES = 1_048_576;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ACTIONS = new Set<string>(["allow", "deny", "ask"]);
const REPLIES = new Set<string>(["once", "always", "reject"]);
const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*\.jsonl$/;
/** Configuration livrée (profil Prudent), comme le repli de GET /global/config dans integration.test.ts. */
const DEFAULT_CONFIG = {
  enabled_providers: ["github-copilot"],
  permission: { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" },
};
/** Tour de résumé (POST /session/:id/summarize) quand aucun script n'attend. */
const SUMMARY_TURN: FakeTurnScript = { text: "Résumé de la conversation par le faux opencode.", cost: 0.001, tokens: { input: 40, output: 12 } };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export const isSync = (payload: OcEvent | SyncPayload): payload is SyncPayload => payload.type === "sync" && "syncEvent" in payload;

let lastMs = 0;
let counter = 0;

/** Identifiant opencode (id/id.ts) : 48 bits de (ms × 4096 + compteur), inversés si « descending », puis 14 caractères base62. */
export function createId(prefix: string, direction: "ascending" | "descending" = "ascending", ms = Date.now()): string {
  if (ms !== lastMs) {
    lastMs = ms;
    counter = 0;
  }
  counter++;
  let value = BigInt(ms) * 4096n + BigInt(counter);
  if (direction === "descending") value = ~value;
  let tail = "";
  for (const byte of randomBytes(14)) tail += BASE62[byte % 62];
  return `${prefix}_${(value & 0xffff_ffff_ffffn).toString(16).padStart(12, "0")}${tail}`;
}

/** Heure (ms) d'un identifiant : ms modulo 2^36, recalée sur le multiple de 2^36 le plus proche de `reference`. */
export function idTime(id: string, direction: "ascending" | "descending" = "ascending", reference = Date.now()): number {
  const start = id.indexOf("_") + 1;
  let value = BigInt(`0x${id.slice(start, start + 12)}`);
  if (direction === "descending") value = 0xffff_ffff_ffffn - value;
  const low = Number(value / 4096n);
  const span = 2 ** 36;
  return low + Math.round((reference - low) / span) * span;
}

/** Wildcard.match d'opencode (core/util/wildcard.ts) : « * » traverse « / », un « ␠* » final rend les arguments facultatifs. */
export function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

/** F-a : la dernière règle correspondante l'emporte ; aucune = ask (permission/index.ts:28-38). */
export function evaluateRules(permission: string, pattern: string, ...rulesets: PermissionRule[][]): PermissionRule {
  return (
    rulesets.flat().findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  );
}

/** F-f : règles d'un enfant « task » = deny et external_directory de la session parente + todowrite/task refusés (subagent-permissions.ts:14-27). */
export function deriveChildRules(parent: PermissionRule[], agentRules: PermissionRule[]): PermissionRule[] {
  const defaults = ["todowrite", "task"]
    .filter((permission) => !agentRules.some((rule) => rule.permission === permission))
    .map((permission): PermissionRule => ({ permission, pattern: "*", action: "deny" }));
  return [...parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny"), ...defaults];
}

/** Agent de GET /agent (Agent.Info, agent/agent.ts:138-260), champs lus par le cockpit. */
export interface FakeAgent {
  name: string;
  mode: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
  description?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  options: Record<string, unknown>;
  permission: PermissionRule[];
}

/** Raccourci de GET /command (Command.Info) ; « $ARGUMENTS » de `template` remplacé à l'envoi. */
export interface FakeCommand {
  name: string;
  template: string;
  hints: string[];
  description?: string;
  agent?: string;
  /** « fournisseur/IA ». */
  model?: string;
  subtask?: boolean;
  source?: "command" | "mcp" | "skill";
}

/** IA d'un fournisseur de GET /config/providers (Provider.Model, provider/provider.ts:1078-1093). */
export interface FakeModel {
  id: string;
  name: string;
  capabilities?: { toolcall?: boolean; reasoning?: boolean; attachment?: boolean };
  cost?: { input: number; output: number; cache?: { read: number; write: number } };
  limit?: { context: number; output: number };
  status?: string;
  variants?: Record<string, Record<string, unknown>>;
  /** Propre au faux : false = IA désactivée par la politique de l'organisation, retirée de la réponse comme le fait opencode. */
  available?: boolean;
}

export interface FakeProvider {
  id: string;
  name: string;
  models: Record<string, FakeModel>;
  options?: Record<string, unknown>;
}

/** Tâche de GET /session/:id/todo (SessionTodo.Info). */
export interface FakeTodo {
  content: string;
  status: string;
  priority: string;
}

/** Fichier de GET /session/:id/diff (FileDiff.Info). */
export interface FakeFileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

/** Demande de GET /question et de question.asked (QuestionV1.Request) ; chaque question : question, header, options [{label, description}], multiple, custom. */
export interface FakeQuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<Record<string, unknown>>;
  tool?: { messageID: string; callID: string };
}

/** Changement de fichier d'un outil edit, write ou apply_patch (chemins absolus, contenus avant et après). */
export interface EditChange {
  type: "add" | "update" | "delete" | "move";
  filePath: string;
  movePath?: string;
  before: string;
  after: string;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Permission.fromConfig (permission/index.ts:184-199) : « permission: action » ou « permission: {motif: action} », dans l'ordre des clés ; ~ et $HOME non développés. */
export function rulesFromConfig(config: unknown): PermissionRule[] {
  if (!isRecord(config)) return [];
  const rules: PermissionRule[] = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      if (ACTIONS.has(value)) rules.push({ permission, pattern: "*", action: value as RuleAction });
      continue;
    }
    if (!isRecord(value)) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (typeof action === "string" && ACTIONS.has(action)) rules.push({ permission, pattern, action: action as RuleAction });
    }
  }
  return rules;
}

/**
 * Agents natifs d'opencode 1.18.30 (agent/agent.ts:117-260) pour la clé « permission » de la configuration : défauts, règles propres
 * à l'agent, puis configuration (F-d). Omis : dossiers autorisés d'office dans external_directory (troncatures, /tmp, skills) et
 * plans du dossier de données d'opencode ; descriptions abrégées.
 */
export function nativeAgents(permission: unknown = DEFAULT_CONFIG.permission): FakeAgent[] {
  const defaults = rulesFromConfig({
    "*": "allow",
    doom_loop: "ask",
    external_directory: { "*": "ask" },
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  });
  const user = rulesFromConfig(permission);
  const rules = (own: Record<string, unknown>): PermissionRule[] => [...defaults, ...rulesFromConfig(own), ...user];
  const hidden = (name: string): FakeAgent => ({ name, mode: "primary", native: true, hidden: true, options: {}, permission: rules({ "*": "deny" }) });
  return [
    {
      name: "build",
      description: "The default agent. Executes tools based on configured permissions.",
      mode: "primary",
      native: true,
      options: {},
      permission: rules({ question: "allow", plan_enter: "allow" }),
    },
    {
      name: "plan",
      description: "Plan mode. Disallows all edit tools.",
      mode: "primary",
      native: true,
      options: {},
      permission: rules({ question: "allow", plan_exit: "allow", task: { general: "deny" }, edit: { "*": "deny", ".opencode/plans/*.md": "allow" } }),
    },
    {
      name: "general",
      description: "General-purpose agent for researching complex questions and executing multi-step tasks.",
      mode: "subagent",
      native: true,
      options: {},
      permission: rules({ todowrite: "deny" }),
    },
    {
      name: "explore",
      description: "Fast agent specialized for exploring codebases.",
      mode: "subagent",
      native: true,
      options: {},
      permission: rules({ "*": "deny", grep: "allow", glob: "allow", list: "allow", bash: "allow", webfetch: "allow", websearch: "allow", read: "allow", external_directory: { "*": "ask" } }),
    },
    hidden("compaction"),
    hidden("title"),
    hidden("summary"),
  ];
}

/**
 * Outils intégrés envoyés au modèle (tool/registry.ts:230-250, 292-301), tels que mesurés par M2 : apply_patch remplace edit et write
 * pour une IA « gpt- » (hors gpt-4 et oss) ; websearch absent sans Exa ; question présent ; aucun outil MCP.
 */
export function builtinTools(modelID: string): string[] {
  const patch = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4");
  return ["question", "bash", "read", "glob", "grep", ...(patch ? ["apply_patch"] : ["edit", "write"]), "task", "webfetch", "todowrite", "skill"];
}

/** F-e, Permission.disabled (permission/index.ts:205-215) : outil retiré si la dernière règle de sa permission est « * deny » (edit, write, apply_patch : « edit »). */
export function disabledTools(tools: readonly string[], rules: readonly PermissionRule[]): Set<string> {
  const edits = new Set(["edit", "write", "apply_patch"]);
  const reads = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  return new Set(
    tools.filter((tool) => {
      const permission = edits.has(tool) ? "edit" : reads.has(tool) ? "read" : tool;
      const rule = rules.findLast((candidate) => wildcardMatch(permission, candidate.permission));
      return rule?.pattern === "*" && rule.action === "deny";
    }),
  );
}

/** mergeDeep de remeda (config/config.ts:666) : objets fusionnés récursivement, tableaux et autres valeurs remplacés ; clés de prototype ignorées. */
function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? mergeDeep(current, value) : jsonClone(value);
  }
  return out;
}

/** Fournisseurs servis par défaut par GET /config/providers (forme d'opencode 1.18.30, IA de la fixture d'intégration). */
const defaultProviders = (): FakeProvider[] => [
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    models: {
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        capabilities: { toolcall: true, reasoning: true },
        variants: { low: {}, medium: {}, high: {} },
        limit: { context: 264_000, output: 64_000 },
        status: "active",
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        capabilities: { toolcall: true, reasoning: true },
        variants: { low: {}, medium: {}, high: {} },
        limit: { context: 1_000_000, output: 64_000 },
        status: "active",
      },
    },
  },
];

const joinLines = (lines: readonly string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

/** Diff unifié d'un fichier, en-têtes de createTwoFilesPatch (bibliothèque diff) ; un seul bloc qui garde tout le contexte (opencode : 4 lignes, puis trimDiff). */
export function unifiedDiff(file: string, before: string, after: string): string {
  const header = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n`;
  const ops = lineDiff(before, after);
  if (ops.every((op) => op.op === " ")) return header;
  const oldCount = ops.filter((op) => op.op !== "+").length;
  const newCount = ops.filter((op) => op.op !== "-").length;
  return `${header}@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@\n${ops.map((op) => `${op.op}${op.line}`).join("\n")}\n`;
}

export type PatchHunk =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; from: string; to: string };

/** Texte d'apply_patch (patch/index.ts:70-240) ; null si illisible. Mise à jour : lignes « » et « - » avant, « » et « + » après. */
export function parseApplyPatch(text: string): PatchHunk[] | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (begin === -1 || end <= begin) return null;
  const header = (line: string | undefined, prefix: string) => (line?.startsWith(prefix) ? line.slice(prefix.length).trim() : "");
  const hunks: PatchHunk[] = [];
  let i = begin + 1;
  while (i < end) {
    const line = lines[i] ?? "";
    const added = header(line, "*** Add File:");
    const deleted = header(line, "*** Delete File:");
    const updated = header(line, "*** Update File:");
    i++;
    if (added) {
      const content: string[] = [];
      while (i < end && lines[i]?.startsWith("+")) content.push((lines[i++] ?? "").slice(1));
      hunks.push({ type: "add", path: added, content: joinLines(content) });
    } else if (deleted) {
      hunks.push({ type: "delete", path: deleted });
    } else if (updated) {
      const movePath = header(lines[i], "*** Move to:");
      if (movePath) i++;
      const from: string[] = [];
      const to: string[] = [];
      for (; i < end && (!lines[i]?.startsWith("***") || lines[i] === "*** End of File"); i++) {
        const change = lines[i] ?? "";
        if (change.startsWith("@@") || change === "*** End of File") continue;
        const op = change[0] ?? " ";
        if (op !== " " && op !== "-" && op !== "+") return null;
        if (op !== "+") from.push(change.slice(1));
        if (op !== "-") to.push(change.slice(1));
      }
      hunks.push({ type: "update", path: updated, ...(movePath ? { movePath } : {}), from: joinLines(from), to: joinLines(to) });
    } else if (line.trim() !== "") {
      return null;
    }
  }
  return hunks.length > 0 ? hunks : null;
}

/**
 * Métadonnées d'une demande de modification quand le script n'en donne pas, conformes à la mesure MX1 §3 (vérifiées par
 * croisements-it1-v0.test.ts sur fixtures/mx1-mesures.json). edit et write (tool/edit.ts:102-110, tool/write.ts:54-62) :
 * {filepath absolu, diff}. apply_patch (tool/apply_patch.ts:195-215) : {filepath (chemins sources relatifs au worktree, joints par
 * « , »), diff (patch de chaque fichier suivi d'un saut de ligne), files[] {filePath, relativePath (destination d'un déplacement),
 * type add|update|delete|move, patch (sur le chemin source), additions, deletions, movePath}} ; suppression : deletions = lignes + 1
 * pour un contenu qui finit par un saut de ligne. `worktree` : dossier du dépôt git, « / » hors git.
 */
export function editMetadata(tool: string, worktree: string, changes: readonly EditChange[]): Record<string, unknown> {
  if (tool !== "apply_patch") {
    const [change] = changes;
    return change ? { filepath: change.filePath, diff: unifiedDiff(change.filePath, change.before, change.after) } : {};
  }
  const files = changes.map((change) => {
    const ops = lineDiff(change.before, change.after);
    return {
      filePath: change.filePath,
      relativePath: path.posix.relative(worktree, change.movePath ?? change.filePath),
      type: change.type,
      patch: unifiedDiff(change.filePath, change.before, change.after),
      additions: change.type === "delete" ? 0 : ops.filter((op) => op.op === "+").length,
      deletions: change.type === "delete" ? change.before.split("\n").length : ops.filter((op) => op.op === "-").length,
      ...(change.movePath ? { movePath: change.movePath } : {}),
    };
  });
  return {
    filepath: changes.map((change) => path.posix.relative(worktree, change.filePath)).join(", "),
    diff: files.map((file) => `${file.patch}\n`).join(""),
    files,
  };
}

function parseRules(value: unknown): PermissionRule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: PermissionRule[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.permission !== "string" || typeof item.pattern !== "string" || typeof item.action !== "string") return null;
    if (!ACTIONS.has(item.action)) return null;
    rules.push({ permission: item.permission, pattern: item.pattern, action: item.action as RuleAction });
  }
  return rules;
}

function fullTokens(usage: FakeUsage["tokens"] = {}): OcTokens {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const cache = { read: usage.cache?.read ?? 0, write: usage.cache?.write ?? 0 };
  return { total: input + output + reasoning + cache.read + cache.write, input, output, reasoning, cache };
}

const sendJson = (res: http.ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
};

/** Lit une capture de fixtures/ ; un événement du flux /event est remis dans l'enveloppe de /global/event. */
export function readCapture(name: string, directory = "/workspace", project = "global"): Array<{ recv: number; wire: FakeWireEvent }> {
  if (!FIXTURE_NAME.test(name)) throw new Error(`nom de capture refusé : ${name}`);
  const text = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const row = JSON.parse(line) as { recv: number; event: Record<string, unknown> };
      if ("payload" in row.event) return { recv: row.recv, wire: row.event as unknown as FakeWireEvent };
      const payload = row.event as unknown as OcEvent;
      return { recv: row.recv, wire: payload.type.startsWith("server.") ? { payload } : { directory, project, payload } };
    });
}

export class FakeOpencode {
  readonly directory: string;
  readonly project: string;
  readonly version: string;
  /** Requêtes reçues, dans l'ordre. */
  readonly requests: FakeRequest[] = [];
  /** Blocs diffusés (hors server.connected et battements, propres à chaque connexion). */
  readonly emitted: FakeWireEvent[] = [];
  /** Échecs internes inattendus du faux (un test peut exiger une liste vide). */
  readonly failures: unknown[] = [];
  syncTwins: boolean;
  /** Tour joué quand aucun script n'attend pour la session. */
  defaultTurn: FakeTurnScript = { text: "Réponse du faux opencode.", cost: 0.001, tokens: { input: 12, output: 4 } };
  readonly #username: string;
  readonly #password: string | undefined;
  readonly #heartbeatMs: number;
  #server: http.Server | null = null;
  #url = "";
  #closed = false;
  readonly #clients = new Map<http.ServerResponse, NodeJS.Timeout>();
  readonly #sessions = new Map<string, FakeSession>();
  /** Dossier de chaque session, gardé après sa suppression (événements d'un tour qui continue). */
  readonly #directories = new Map<string, string>();
  readonly #messages = new Map<string, OcMessageWithParts[]>();
  readonly #statuses = new Map<string, { type: string }>();
  readonly #pending = new Map<string, PendingEntry>();
  /** Accords « always », propres à chaque instance (permission/index.ts:46-51). */
  readonly #approved = new Map<string, PermissionRule[]>();
  readonly #runs = new Map<string, Run>();
  readonly #scripts = new Map<string, FakeTurnScript[]>();
  readonly #seq = new Map<string, number>();
  readonly #waiters = new Set<Waiter>();
  /** Instances chargées (instance-store.ts) : dossiers des requêtes d'instance et des sessions, retirés à leur libération. */
  readonly #instances = new Set<string>();
  /** Configuration globale (GET /global/config), fusionnée par PATCH. */
  globalConfig: Record<string, unknown>;
  /** PATCH /global/config reçus, dans l'ordre : corps, et changement effectif (qui libère toutes les instances en tâche de fond). */
  readonly globalConfigPatches: Array<{ body: Record<string, unknown>; changed: boolean }> = [];
  /**
   * Configuration propre à un dossier (opencode.json du projet, extensions découvertes dans ses plugin(s)/), fusionnée à la
   * configuration globale par GET /config.
   */
  readonly projectConfigs = new Map<string, Record<string, unknown>>();
  /** GET /config/providers : une IA `available: false` n'y figure pas. */
  providers: FakeProvider[] = defaultProviders();
  /** Champ « default » de GET /config/providers : IA par défaut de chaque fournisseur. */
  defaultModels: Record<string, string> = { "github-copilot": "gpt-5-mini" };
  /**
   * GET /experimental/capabilities → { backgroundSubagents } (handlers/experimental.ts:39-41) : drapeau du processus
   * (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ou OPENCODE_EXPERIMENTAL), faux par défaut comme opencode sans ces variables.
   * Demande de L1f (Diagnostic du travail délégué), ajoutée au train it1 V4.
   */
  backgroundSubagents = false;
  /** Contenus connus (chemins absolus) : état « avant » des métadonnées edit, write et apply_patch, mis à jour par chaque outil terminé. */
  readonly files = new Map<string, string>();
  /**
   * Worktree de chaque dossier (GET /path, métadonnées des demandes de modification) ; dossier absent : lui-même, comme un dépôt
   * git. Hors git, opencode 1.18.30 prend « / » (mesure MX1 §3).
   */
  readonly worktrees = new Map<string, string>();
  #defaultAgents: FakeAgent[] | null = null;
  readonly #agents = new Map<string, FakeAgent[]>();
  #defaultCommands: FakeCommand[] = [];
  readonly #commands = new Map<string, FakeCommand[]>();
  readonly #todos = new Map<string, FakeTodo[]>();
  /** Diffs par « session » ou « session/message ». */
  readonly #diffs = new Map<string, FakeFileDiff[]>();
  readonly #questions = new Map<string, { info: FakeQuestionRequest; directory: string }>();

  constructor(options: FakeOpencodeOptions = {}) {
    this.#username = options.username ?? "opencode";
    this.#password = options.password || undefined;
    this.directory = options.directory ?? "/workspace";
    this.project = options.project ?? "global";
    this.version = options.version ?? "1.18.30";
    this.#heartbeatMs = options.heartbeatMs ?? 10_000;
    this.syncTwins = options.syncTwins ?? true;
    this.globalConfig = jsonClone(options.config ?? DEFAULT_CONFIG);
  }

  get url(): string {
    return this.#url;
  }

  async start(): Promise<string> {
    // Port rendu par le système, jamais un port que fetch refuse (listenFetchable).
    const server = http.createServer((req, res) => this.#receive(req, res));
    const port = await listenFetchable(server, "127.0.0.1");
    this.#server = server;
    this.#url = `http://127.0.0.1:${port}`;
    return this.#url;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetInstances(undefined, { quiet: true });
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("faux opencode fermé"));
    }
    this.#waiters.clear();
    this.disconnectStreams();
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** File de tours pour les prochains envois de la session. */
  script(sessionID: string, ...turns: FakeTurnScript[]): void {
    this.#scripts.set(sessionID, [...(this.#scripts.get(sessionID) ?? []), ...turns]);
  }

  session(id: string): FakeSession | undefined {
    return this.#sessions.get(id);
  }

  messages(sessionID: string): OcMessageWithParts[] {
    return this.#messages.get(sessionID) ?? [];
  }

  pendingPermissions(): FakePermissionRequest[] {
    return [...this.#pending.values()].map((entry) => entry.info);
  }

  statusOf(sessionID: string): { type: string } {
    return this.#statuses.get(sessionID) ?? { type: "idle" };
  }

  /**
   * Fin du travail en cours de la session, repos compris : boucle de tours d'un envoi, ou sous-agent « task » (lié, repris par
   * task_id ou détaché p7) quelle que soit sa sortie (fin, arrêt, clé étrangère, erreur). Résolue aussitôt sans travail en cours,
   * donc aussi après un arrêt, dont le repos est publié avant la réponse.
   */
  settled(sessionID: string): Promise<void> {
    return this.#runs.get(sessionID)?.done ?? Promise.resolve();
  }

  /** Agents de GET /agent dans ce dossier : liste propre au dossier, sinon liste par défaut, sinon agents natifs de la configuration globale. */
  agents(directory: string = this.directory): FakeAgent[] {
    return this.#agents.get(directory) ?? this.#defaultAgents ?? nativeAgents(this.globalConfig.permission);
  }

  /** Worktree du dossier : `worktrees`, sinon le dossier lui-même (dépôt git). */
  worktreeOf(directory: string = this.directory): string {
    return this.worktrees.get(directory) ?? directory;
  }

  /** Agents servis dans `directory` ; sans dossier : dans tous les dossiers qui n'ont pas de liste propre. */
  setAgents(agents: FakeAgent[], directory?: string): void {
    if (directory === undefined) this.#defaultAgents = jsonClone(agents);
    else this.#agents.set(directory, jsonClone(agents));
  }

  /**
   * Configuration effective d'un dossier (GET /config, mesuré sur opencode 1.18.30) : globale puis projet ; `plugin` toujours présent
   * (liste vide par défaut, fichiers de plugin(s)/ en « file:// ») ; `mcp` absent tant qu'aucun serveur n'est déclaré.
   */
  effectiveConfig(directory: string = this.directory): Record<string, unknown> {
    const merged = mergeDeep(this.globalConfig, this.projectConfigs.get(directory) ?? {});
    return { ...merged, plugin: Array.isArray(merged.plugin) ? merged.plugin : [] };
  }

  /** Raccourcis de GET /command dans ce dossier : liste propre au dossier, sinon liste par défaut (vide). */
  commands(directory: string = this.directory): FakeCommand[] {
    return this.#commands.get(directory) ?? this.#defaultCommands;
  }

  /** Raccourcis servis dans `directory` ; sans dossier : dans tous les dossiers qui n'ont pas de liste propre. */
  setCommands(commands: FakeCommand[], directory?: string): void {
    if (directory === undefined) this.#defaultCommands = jsonClone(commands);
    else this.#commands.set(directory, jsonClone(commands));
  }

  todos(sessionID: string): FakeTodo[] {
    return this.#todos.get(sessionID) ?? [];
  }

  /** Liste de tâches de la session (outil todowrite) : servie par GET /session/:id/todo, annoncée par todo.updated. */
  setTodos(sessionID: string, todos: FakeTodo[]): void {
    this.#todos.set(sessionID, jsonClone(todos));
    this.#emitFor(sessionID, "todo.updated", { sessionID, todos });
  }

  /** Diff servi par GET /session/:id/diff, pour toute la session ou pour l'un de ses messages (`messageID`). */
  setDiff(sessionID: string, diffs: FakeFileDiff[], messageID?: string): void {
    this.#diffs.set(messageID ? `${sessionID}/${messageID}` : sessionID, jsonClone(diffs));
  }

  /** Question posée à l'utilisateur (outil question) : question.asked, listée par GET /question dans son dossier jusqu'à la réponse ou au refus. */
  askQuestion(sessionID: string, questions: Array<Record<string, unknown>>, tool?: { messageID: string; callID: string }): FakeQuestionRequest {
    const info: FakeQuestionRequest = { id: createId("que"), sessionID, questions: jsonClone(questions), ...(tool ? { tool } : {}) };
    this.#questions.set(info.id, { info, directory: this.#directoryOf(sessionID) });
    this.#emitFor(sessionID, "question.asked", { ...info });
    return info;
  }

  pendingQuestions(): FakeQuestionRequest[] {
    return [...this.#questions.values()].map((entry) => entry.info);
  }

  /**
   * F-e, F-f : outils envoyés au modèle à la prochaine étape de la session (session/llm/request.ts:208-214) : outils intégrés de l'IA,
   * moins ceux dont la dernière règle (agent puis session) est « * deny ». Agent : `agent`, sinon celui de la session, sinon build ;
   * IA : `modelID`, sinon celle de la session, sinon l'IA par défaut du faux. Liste triée, comme la mesure M2.
   */
  toolsFor(sessionID: string, options: { modelID?: string; agent?: string } = {}): string[] {
    const session = this.#sessions.get(sessionID);
    if (!session) throw new Error(`session inconnue du faux opencode : ${sessionID}`);
    const agentName = options.agent ?? session.agent ?? "build";
    const agent = this.agents(session.directory).find((candidate) => candidate.name === agentName);
    const tools = builtinTools(options.modelID ?? session.model?.id ?? DEFAULT_MODEL.modelID);
    const disabled = disabledTools(tools, [...(agent?.permission ?? []), ...(session.permission ?? [])]);
    return tools.filter((tool) => !disabled.has(tool)).sort();
  }

  /** Diffuse un événement ; identifiant horodaté si absent ; jumeau « sync » pour un événement durable. */
  emit(event: { type: string; properties: Record<string, unknown>; id?: string }, directory: string = this.directory): OcEvent {
    const id = event.id ?? createId("evt");
    const payload: OcEvent = { id, type: event.type, properties: jsonClone(event.properties) };
    this.emitRaw({ directory, project: this.project, payload });
    const aggregateID = payload.properties.sessionID;
    if (DURABLE_EVENTS.has(payload.type) && typeof aggregateID === "string") {
      const seq = this.#seq.get(aggregateID) ?? 0;
      this.#seq.set(aggregateID, seq + 1);
      // Même id, type versionné, seq par session ; GlobalBus recopie l'id dans le bloc (bus/global.ts:14-18).
      if (this.syncTwins) {
        const syncEvent = { id, type: `${payload.type}.1`, seq, aggregateID, data: payload.properties };
        this.emitRaw({ directory, project: this.project, payload: { type: "sync", syncEvent, id } });
      }
    }
    return payload;
  }

  /** Diffuse un bloc tel quel (rejeu d'une capture). */
  emitRaw(wire: FakeWireEvent): void {
    this.emitted.push(wire);
    const line = `data: ${JSON.stringify(wire)}\n\n`;
    for (const res of this.#clients.keys()) res.write(line);
    for (const waiter of [...this.#waiters]) {
      let hit: OcEvent | null;
      try {
        hit = waiter.test(wire);
      } catch (err) {
        // Prédicat du test qui lève : cette attente échoue avec l'erreur, jamais le faux (#route, #turn, #reply).
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(asError(err));
        continue;
      }
      if (!hit) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(hit);
    }
  }

  /** server.instance.disposed (instance-store.ts:79-98), sans jumeau sync. */
  emitInstanceDisposed(directory: string): void {
    this.emitRaw({ directory, project: this.project, payload: { id: createId("evt"), type: "server.instance.disposed", properties: { directory } } });
  }

  /**
   * disposeAll puis global.disposed (global-lifecycle.ts:16-25) : pour chaque instance chargée, dans l'ordre de chargement, remise à
   * zéro facultative puis server.instance.disposed ; global.disposed en dernier. `resetInstances` : tours coupés avec la suite
   * d'arrêt publiée (mesure M14), demandes rejetées sans événement, états vidés.
   */
  emitGlobalDisposed(options: { resetInstances?: boolean } = {}): void {
    const reset = options.resetInstances === true;
    for (const directory of [...this.#instances]) this.#disposeInstance(directory, reset);
    if (reset) this.#resetInstances();
    this.emitRaw({ directory: "global", payload: { id: createId("evt"), type: "global.disposed", properties: {} } });
  }

  /** Coupe les flux SSE ouverts (test de reconnexion). */
  disconnectStreams(): void {
    for (const [res, timer] of this.#clients) {
      clearInterval(timer);
      res.end();
    }
    this.#clients.clear();
  }

  /** Premier événement `type` diffusé depuis l'indice `since` de `emitted` qui satisfait `match`. */
  waitForEvent(
    type: string,
    match: (properties: Record<string, unknown>) => boolean = () => true,
    options: { since?: number; timeoutMs?: number } = {},
  ): Promise<OcEvent> {
    const test = (wire: FakeWireEvent): OcEvent | null =>
      isSync(wire.payload) || wire.payload.type !== type || !match(wire.payload.properties) ? null : wire.payload;
    try {
      for (const wire of this.emitted.slice(options.since ?? 0)) {
        const hit = test(wire);
        if (hit) return Promise.resolve(hit);
      }
    } catch (err) {
      return Promise.reject(asError(err));
    }
    const timeoutMs = options.timeoutMs ?? 3000;
    return new Promise<OcEvent>((resolve, reject) => {
      const waiter: Waiter = {
        test,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`événement ${type} non diffusé en ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #receive(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        this.#route(req, res, size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        this.failures.push(err);
        if (!res.headersSent) sendJson(res, 500, { name: "UnknownError", data: { message: err instanceof Error ? err.message : String(err) } });
      }
    });
  }

  /** Basic ou `auth_token` (middleware/authorization.ts:73-83), comparaison à temps constant. */
  #authorized(req: http.IncomingMessage, url: URL): boolean {
    if (this.#password === undefined) return true;
    const encoded = url.searchParams.get("auth_token") ?? /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!encoded) return false;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    const userOk = sameSecret(decoded.slice(0, separator), this.#username);
    const passwordOk = sameSecret(decoded.slice(separator + 1), this.#password);
    return userOk && passwordOk;
  }

  #route(req: http.IncomingMessage, res: http.ServerResponse, raw: string | null): void {
    const url = new URL(req.url ?? "/", "http://opencode.test");
    const method = req.method ?? "GET";
    let body: unknown;
    let readable = true;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        readable = false;
        body = raw;
      }
    }
    const authorized = this.#authorized(req, url);
    const query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "auth_token"));
    this.requests.push({ method, pathname: url.pathname, query, body, authorized });
    if (!authorized) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' }).end();
      return;
    }
    const json = (status: number, data: unknown) => sendJson(res, status, data);
    const bad = () => json(400, { _tag: "BadRequest" });
    const notFound = (message: string) => json(404, { name: "NotFoundError", data: { message } });
    if (raw === null) return json(413, { _tag: "PayloadTooLarge" });
    if (!readable || (raw && !isRecord(body))) return bad();
    const header = req.headers["x-opencode-directory"];
    const directory = url.searchParams.get("directory") || (typeof header === "string" ? header : "") || this.directory;
    let seg: string[];
    try {
      seg = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      return bad();
    }
    const is = (m: string, ...shape: string[]) => method === m && seg.length === shape.length && shape.every((p, i) => p === "*" || p === seg[i]);
    const id = seg[1] ?? "";
    const input = isRecord(body) ? body : {};
    // Toute route hors /global/* charge l'instance du dossier demandé.
    if (seg[0] !== "global") this.#instances.add(directory);

    if (is("GET", "global", "health")) return json(200, { healthy: true, version: this.version });
    if (is("GET", "global", "event")) return this.#openStream(res);
    if (is("GET", "global", "config")) return json(200, this.globalConfig);
    // Fusion puis réponse ; configuration changée : toutes les instances libérées puis global.disposed, en tâche de fond (handlers/global.ts:78-82).
    if (is("PATCH", "global", "config")) {
      if (!isRecord(body)) return bad();
      const next = mergeDeep(this.globalConfig, body);
      const changed = JSON.stringify(next) !== JSON.stringify(this.globalConfig);
      this.globalConfigPatches.push({ body: jsonClone(body), changed });
      this.globalConfig = next;
      json(200, next);
      if (changed) {
        setImmediate(() => {
          if (!this.#closed) this.emitGlobalDisposed({ resetInstances: true });
        });
      }
      return;
    }
    // Libération de toutes les instances avant la réponse (handlers/global.ts:84-87).
    if (is("POST", "global", "dispose")) {
      this.emitGlobalDisposed({ resetInstances: true });
      return json(200, true);
    }
    // Réponse d'abord, libération de l'instance ensuite (handlers/instance.ts:24-27, lifecycle.ts:43-55).
    if (is("POST", "instance", "dispose")) {
      json(200, true);
      this.#disposeInstance(directory, true);
      return;
    }
    if (is("GET", "agent")) return json(200, this.agents(directory));
    if (is("GET", "command")) return json(200, this.commands(directory));
    if (is("GET", "config")) return json(200, this.effectiveConfig(directory));
    // Chemins de l'instance, forme relevée par MX1 (utilisateur node de l'image) ; worktree « / » hors git.
    if (is("GET", "path")) {
      return json(200, { home: "/home/node", state: "/home/node/.local/state/opencode", config: "/home/node/.config/opencode", worktree: this.worktreeOf(directory), directory });
    }
    // IA refusée par la politique de l'organisation : absente de la réponse, comme le fait le plugin github-copilot d'opencode.
    if (is("GET", "config", "providers")) {
      const providers = this.providers.map((provider) => ({
        ...provider,
        models: Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => model.available !== false)
            .map(([modelID, model]) => [modelID, Object.fromEntries(Object.entries(model).filter(([key]) => key !== "available"))]),
        ),
      }));
      return json(200, { providers, default: this.defaultModels });
    }
    if (is("GET", "experimental", "session")) return this.#listSessions(res, url, directory);
    if (is("GET", "experimental", "capabilities")) return json(200, { backgroundSubagents: this.backgroundSubagents });
    if (is("GET", "question")) return json(200, [...this.#questions.values()].filter((entry) => entry.directory === directory).map((entry) => entry.info));
    if (is("POST", "question", "*", "reply") || is("POST", "question", "*", "reject")) {
      const replying = seg[2] === "reply";
      const answers = input.answers;
      if (replying && !(Array.isArray(answers) && answers.every((answer) => Array.isArray(answer) && answer.every((label) => typeof label === "string")))) return bad();
      const entry = this.#questions.get(id);
      // Forme supposée sur le modèle de PermissionNotFoundError (errors.ts:125-141), non capturée.
      if (!entry || entry.directory !== directory) return json(404, { _tag: "QuestionNotFoundError", requestID: id, message: `Question request not found: ${id}` });
      this.#questions.delete(id);
      const { sessionID } = entry.info;
      this.#emitFor(sessionID, replying ? "question.replied" : "question.rejected", replying ? { sessionID, requestID: id, answers } : { sessionID, requestID: id });
      return json(200, true);
    }
    // Demandes et états sont propres à l'instance du répertoire demandé (InstanceState).
    if (is("GET", "permission")) return json(200, [...this.#pending.values()].filter((e) => e.directory === directory).map((e) => e.info));
    if (is("POST", "permission", "*", "reply")) {
      if (typeof input.reply !== "string" || !REPLIES.has(input.reply)) return bad();
      if (input.message !== undefined && typeof input.message !== "string") return bad();
      if (this.#reply(id, directory, input.reply as PermissionReply, input.message)) return json(200, true);
      // Forme mesurée d'une seconde réponse (autonomy-capture/raw/approvals.jsonl).
      return json(404, { _tag: "PermissionNotFoundError", requestID: id, message: `Permission request not found: ${id}` });
    }
    // GET /session (Session.list de l'instance du dossier demandé) : c'est la route que l'interface appelle par le proxy
    // (web/lib/api.ts, PROXY_RULES), alors que processor.ts appelle GET /experimental/session. Même page, mais toujours
    // bornée au dossier de l'instance, que le paramètre « directory » soit écrit ou non. Écart relevé par le banc e2e de
    // L7a (le faux répondait 404 et l'interface affichait « Conversations indisponibles »), corrigé au train 1-vague-1.
    if (is("GET", "session")) return this.#listSessions(res, url, directory, true);
    if (is("GET", "session", "status")) {
      const inInstance = ([sid]: [string, unknown]) => this.#directoryOf(sid) === directory;
      return json(200, Object.fromEntries([...this.#statuses].filter(inInstance)));
    }
    if (is("POST", "session")) {
      const permission = input.permission === undefined ? undefined : parseRules(input.permission);
      if (permission === null || [input.parentID, input.title, input.agent].some((v) => v !== undefined && typeof v !== "string")) return bad();
      if (input.metadata !== undefined && !isRecord(input.metadata)) return bad();
      return json(
        200,
        this.#createSession({
          directory,
          parentID: input.parentID as string | undefined,
          title: input.title as string | undefined,
          agent: input.agent as string | undefined,
          metadata: input.metadata as Record<string, unknown> | undefined,
          permission,
        }),
      );
    }
    // Arrêt sans vérification de la session (handlers/session.ts:232-235).
    if (is("POST", "session", "*", "abort")) {
      this.#abort(id);
      return json(200, true);
    }
    if (seg[0] !== "session" || seg.length < 2) return notFound(`Route inconnue du faux opencode : ${method} ${url.pathname}`);
    const session = this.#sessions.get(id);
    if (!session) return notFound(`Session not found: ${id}`);
    if (is("GET", "session", "*")) return json(200, session);
    if (is("PATCH", "session", "*")) return this.#patch(session, input) ? json(200, session) : bad();
    if (is("DELETE", "session", "*")) {
      this.#remove(session);
      return json(200, true);
    }
    if (is("GET", "session", "*", "children")) return json(200, [...this.#sessions.values()].filter((s) => s.parentID === id));
    if (is("GET", "session", "*", "todo")) return json(200, this.todos(id));
    if (is("GET", "session", "*", "diff")) {
      const messageID = url.searchParams.get("messageID");
      return json(200, this.#diffs.get(messageID ? `${id}/${messageID}` : id) ?? []);
    }
    if (is("POST", "session", "*", "command")) return this.#command(res, session, input);
    if (is("POST", "session", "*", "summarize")) return this.#summarize(res, session, input);
    if (is("GET", "session", "*", "message")) return json(200, this.messages(id));
    if (is("GET", "session", "*", "message", "*")) {
      const message = this.messages(id).find((m) => m.info.id === seg[3]);
      return message ? json(200, message) : notFound(`Message not found: ${seg[3]}`);
    }
    if (is("POST", "session", "*", "message") || is("POST", "session", "*", "prompt_async")) {
      if (!Array.isArray(input.parts) || (input.tools !== undefined && !isRecord(input.tools))) return bad();
      const { user, run } = this.#prompt(session, input);
      if (seg[2] === "prompt_async") {
        res.writeHead(204).end();
        return;
      }
      if (!run) return json(200, user);
      void run.done.then(() => json(200, run.last ?? user));
      return;
    }
    return notFound(`Route inconnue du faux opencode : ${method} ${url.pathname}`);
  }

  /** SSE /global/event : server.connected, puis blocs diffusés et battement de cœur (handlers/global.ts:25-57). */
  #openStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    const send = (wire: FakeWireEvent) => res.write(`data: ${JSON.stringify(wire)}\n\n`);
    send({ payload: { id: createId("evt"), type: "server.connected", properties: {} } });
    const timer = setInterval(() => send({ payload: { id: createId("evt"), type: "server.heartbeat", properties: {} } }), this.#heartbeatMs);
    timer.unref();
    this.#clients.set(res, timer);
    res.on("close", () => {
      clearInterval(timer);
      this.#clients.delete(res);
    });
  }

  #directoryOf(sessionID: string): string {
    return this.#directories.get(sessionID) ?? this.directory;
  }

  #approvedIn(directory: string): PermissionRule[] {
    let rules = this.#approved.get(directory);
    if (!rules) {
      rules = [];
      this.#approved.set(directory, rules);
    }
    return rules;
  }

  #emitFor(sessionID: string, type: string, properties: Record<string, unknown>): void {
    this.emit({ type, properties }, this.#directoryOf(sessionID));
  }

  #emitSessionInfo(type: string, session: FakeSession): void {
    this.emit({ type, properties: { sessionID: session.id, info: session } }, session.directory);
  }

  #setStatus(sessionID: string, status: { type: string }): void {
    this.#emitFor(sessionID, "session.status", { sessionID, status });
    if (status.type !== "idle") {
      this.#statuses.set(sessionID, status);
      return;
    }
    // Le repos est aussi publié en session.idle, déprécié (session/status.ts:39-48).
    this.#emitFor(sessionID, "session.idle", { sessionID });
    this.#statuses.delete(sessionID);
  }

  #createSession(input: {
    directory: string;
    parentID?: string | undefined;
    title?: string | undefined;
    agent?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    permission?: PermissionRule[] | undefined;
  }): FakeSession {
    const now = Date.now();
    const session: FakeSession = {
      id: createId("ses", "descending", now),
      slug: `fake-${randomBytes(3).toString("hex")}`,
      version: this.version,
      projectID: this.project,
      directory: input.directory,
      path: input.directory.replace(/^\/+/, ""),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      title: input.title ?? `${input.parentID ? "Child session - " : "New session - "}${new Date(now).toISOString()}`,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.metadata ? { metadata: jsonClone(input.metadata) } : {}),
      ...(input.permission ? { permission: [...input.permission] } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    };
    this.#sessions.set(session.id, session);
    this.#directories.set(session.id, session.directory);
    this.#instances.add(session.directory);
    this.#messages.set(session.id, []);
    this.#emitSessionInfo("session.created", session);
    return session;
  }

  #patch(session: FakeSession, input: Record<string, unknown>): boolean {
    const permission = input.permission === undefined ? undefined : parseRules(input.permission);
    const archived = isRecord(input.time) ? input.time.archived : undefined;
    if (permission === null || (input.title !== undefined && typeof input.title !== "string")) return false;
    if ((input.metadata !== undefined && !isRecord(input.metadata)) || (archived !== undefined && typeof archived !== "number")) return false;
    if (typeof input.title === "string") session.title = input.title;
    if (isRecord(input.metadata)) session.metadata = jsonClone(input.metadata);
    // F-g : les règles reçues sont AJOUTÉES (Permission.merge), jamais retirées (handlers/session.ts:194-199).
    if (permission) session.permission = [...(session.permission ?? []), ...permission];
    if (typeof archived === "number") session.time.archived = archived;
    session.time.updated = Date.now();
    this.#emitSessionInfo("session.updated", session);
    return true;
  }

  /**
   * DELETE (session.ts:606-627) : travail délégué par « task » annulé d'abord (arrêt visible, « Task cancelled » chez le parent
   * qui reprend), enfants supprimés, puis session.deleted. Le tour de la session supprimée n'est JAMAIS arrêté : il continue et
   * échoue à sa prochaine écriture (clé étrangère). Pour arrêter le travail : POST /session/:id/abort, attendre le repos, puis DELETE.
   */
  #remove(session: FakeSession): void {
    this.#cancelTaskJobs(session.id);
    for (const child of [...this.#sessions.values()].filter((s) => s.parentID === session.id)) this.#remove(child);
    this.#emitSessionInfo("session.deleted", session);
    this.#sessions.delete(session.id);
    this.#messages.delete(session.id);
  }

  /**
   * cancelBackgroundJobs (run-state.ts:111-143) : le tour de la session si c'est un sous-agent « task » en cours, sinon ceux de
   * ses propres sous-agents « task », arrêtés avec leurs événements ; jamais le tour d'une session qui n'est pas un sous-agent.
   */
  #cancelTaskJobs(sessionID: string): void {
    const own = this.#runs.get(sessionID);
    const delegated = own !== undefined && [...this.#runs.values()].some((run) => run !== own && !run.aborted && run.children.has(sessionID));
    if (own && delegated) {
      // #interrupt arrête aussi ses propres sous-agents.
      this.#interrupt(own);
      return;
    }
    for (const id of own?.children ?? []) {
      const child = this.#runs.get(id);
      if (child) this.#interrupt(child);
    }
  }

  #putMessage(message: OcMessageWithParts): void {
    const list = this.#messages.get(message.info.sessionID);
    if (!list) throw new ForeignKeyError();
    if (!list.includes(message)) list.push(message);
    this.#emitFor(message.info.sessionID, "message.updated", { sessionID: message.info.sessionID, info: message.info });
  }

  #putPart(message: OcMessageWithParts, fields: Record<string, unknown>): OcPart {
    if (!this.#sessions.has(message.info.sessionID)) throw new ForeignKeyError();
    const id = typeof fields.id === "string" ? fields.id : createId("prt");
    const part = { ...fields, id, sessionID: message.info.sessionID, messageID: message.info.id } as OcPart;
    const index = message.parts.findIndex((p) => p.id === id);
    if (index === -1) message.parts.push(part);
    else message.parts[index] = part;
    this.#emitFor(part.sessionID, "message.part.updated", { sessionID: part.sessionID, part, time: Date.now() });
    return part;
  }

  /** setAgentModel (prompt.ts:672-690) : assistant ou IA différents de ceux de la session → session.updated ; « default » vaut sans variante. */
  #setAgentModel(session: FakeSession, agent: string, model: ModelRef, time: number): void {
    const current = session.model;
    const variant = current?.variant === "default" ? undefined : current?.variant;
    if (session.agent === agent && current?.providerID === model.providerID && current?.id === model.modelID && variant === model.variant) return;
    session.agent = agent;
    session.model = { id: model.modelID, providerID: model.providerID, variant: model.variant ?? "default" };
    session.time.updated = time;
    this.#emitSessionInfo("session.updated", session);
  }

  #prompt(session: FakeSession, input: Record<string, unknown>): { user: OcMessageWithParts; run: Run | null } {
    const now = Date.now();
    const chosen =
      isRecord(input.model) && typeof input.model.providerID === "string" && typeof input.model.modelID === "string"
        ? { providerID: input.model.providerID, modelID: input.model.modelID }
        : DEFAULT_MODEL;
    // Variante demandée (prompt.ts:654) ; sans catalogue d'agents, le faux n'applique pas de variante propre à l'agent.
    const variant = typeof input.variant === "string" && input.variant ? input.variant : undefined;
    const model: ModelRef = { providerID: chosen.providerID, modelID: chosen.modelID, ...(variant ? { variant } : {}) };
    const agent = typeof input.agent === "string" ? input.agent : "build";
    const info: OcUserMessage = { id: createId("msg"), sessionID: session.id, role: "user", time: { created: now }, agent, model };
    // Assistant et IA reportés sur la session avant le message (prompt.ts:672-690, capture p1).
    this.#setAgentModel(session, agent, model, now);
    const user: OcMessageWithParts = { info, parts: [] };
    this.#putMessage(user);
    for (const part of input.parts as unknown[]) {
      if (!isRecord(part) || typeof part.type !== "string") continue;
      this.#putPart(user, Object.fromEntries(Object.entries(part).filter(([key]) => !["id", "sessionID", "messageID"].includes(key))));
    }
    session.time.updated = now;
    this.#emitSessionInfo("session.updated", session);
    if (isRecord(input.tools)) {
      // F-h : « tools » REMPLACE toutes les règles de session (prompt.ts:1060-1067).
      const rules = Object.entries(input.tools).map(([permission, enabled]): PermissionRule => ({ permission, pattern: "*", action: enabled ? "allow" : "deny" }));
      if (rules.length > 0) {
        session.permission = rules;
        this.#emitSessionInfo("session.updated", session);
      }
    }
    // F-h : noReply enregistre le message sans lancer de tour (prompt.ts:1069).
    if (input.noReply === true) return { user, run: null };
    return { user, run: this.#enqueue(session, user, this.#scripts.get(session.id)?.shift() ?? this.defaultTurn) };
  }

  /**
   * POST /session/:id/command (handlers/session.ts:331-339) : consigne du raccourci (« $ARGUMENTS » remplacé) envoyée comme un
   * message, agent et IA du raccourci d'abord ; command.executed après le tour, puis réponse d'assistant comme /message. Raccourci
   * inconnu ou corps invalide : 400.
   */
  #command(res: http.ServerResponse, session: FakeSession, input: Record<string, unknown>): void {
    const command = typeof input.command === "string" ? this.commands(session.directory).find((candidate) => candidate.name === input.command) : undefined;
    if (!command || typeof input.arguments !== "string") return sendJson(res, 400, { _tag: "BadRequest" });
    const args = input.arguments;
    const modelKey = command.model ?? (typeof input.model === "string" ? input.model : undefined);
    const slash = modelKey?.indexOf("/") ?? -1;
    const { user, run } = this.#prompt(session, {
      agent: command.agent ?? (typeof input.agent === "string" ? input.agent : "build"),
      ...(modelKey && slash > 0 ? { model: { providerID: modelKey.slice(0, slash), modelID: modelKey.slice(slash + 1) } } : {}),
      ...(typeof input.variant === "string" ? { variant: input.variant } : {}),
      parts: [{ type: "text", text: command.template.replaceAll("$ARGUMENTS", args) }],
    });
    const answer = () => {
      this.#emitFor(session.id, "command.executed", { name: command.name, sessionID: session.id, arguments: args, messageID: user.info.id });
      sendJson(res, 200, run?.last ?? user);
    };
    if (!run) return answer();
    void run.done.then(answer);
  }

  /**
   * POST /session/:id/summarize (handlers/session.ts:273-293) : message de compaction (partie « compaction », agent du dernier message
   * de l'utilisateur), tour de résumé de l'agent « compaction » (summary: true ; script de la session s'il y en a un),
   * session.compacted, puis true.
   */
  #summarize(res: http.ServerResponse, session: FakeSession, input: Record<string, unknown>): void {
    if (typeof input.providerID !== "string" || typeof input.modelID !== "string" || (input.auto !== undefined && typeof input.auto !== "boolean")) {
      return sendJson(res, 400, { _tag: "BadRequest" });
    }
    const model: ModelRef = { providerID: input.providerID, modelID: input.modelID };
    const last = this.messages(session.id).findLast((message) => message.info.role === "user")?.info as OcUserMessage | undefined;
    const user: OcMessageWithParts = {
      info: { id: createId("msg"), sessionID: session.id, role: "user", time: { created: Date.now() }, agent: last?.agent ?? "build", model },
      parts: [],
    };
    this.#putMessage(user);
    this.#putPart(user, { type: "compaction", auto: input.auto === true });
    const run = this.#enqueue(session, user, { ...(this.#scripts.get(session.id)?.shift() ?? SUMMARY_TURN), agent: "compaction", summary: true });
    void run.done.then(() => {
      if (this.#sessions.has(session.id)) this.#emitFor(session.id, "session.compacted", { sessionID: session.id });
      sendJson(res, 200, true);
    });
  }

  /**
   * GET /experimental/session (handlers/experimental.ts:138-157, Session.listGlobal) : sessions de tous les dossiers (ou du dossier
   * demandé), les plus récemment modifiées d'abord ; racines seules, bornes de temps, recherche dans le titre, archivées ; x-next-cursor
   * quand la page est pleine. Projet non modélisé (null, permis par le schéma).
   */
  #listSessions(res: http.ServerResponse, url: URL, directory: string, scoped = false): void {
    const query = url.searchParams;
    const numberOf = (key: string): number | undefined | null => {
      const raw = query.get(key);
      if (raw === null) return undefined;
      const value = Number(raw);
      return raw.trim() !== "" && Number.isFinite(value) ? value : null;
    };
    const rawLimit = numberOf("limit");
    const start = numberOf("start");
    const cursor = numberOf("cursor");
    if (rawLimit === null || start === null || cursor === null || (rawLimit !== undefined && rawLimit < 0)) return sendJson(res, 400, { _tag: "BadRequest" });
    const limit = rawLimit ?? 100;
    const search = query.get("search")?.toLowerCase();
    const list = [...this.#sessions.values()]
      .filter((s) => (!scoped && !query.has("directory")) || s.directory === directory)
      .filter((s) => query.get("roots") !== "true" || !s.parentID)
      .filter((s) => start === undefined || s.time.updated >= start)
      .filter((s) => cursor === undefined || s.time.updated < cursor)
      .filter((s) => !search || s.title.toLowerCase().includes(search))
      .filter((s) => query.get("archived") === "true" || s.time.archived === undefined)
      .sort((a, b) => b.time.updated - a.time.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const page = list.slice(0, limit);
    const last = page.at(-1);
    if (list.length > limit && last) res.setHeader("x-next-cursor", String(last.time.updated));
    sendJson(res, 200, page.map((session) => ({ ...session, project: null })));
  }

  #newRun(sessionID: string): Run {
    const { promise, resolve } = Promise.withResolvers<void>();
    const run: Run = {
      sessionID,
      aborted: false,
      quiet: false,
      finished: false,
      queue: [],
      assistant: null,
      last: null,
      children: new Set(),
      stopped: promise,
      stop: () => resolve(),
      done: Promise.resolve(),
    };
    this.#runs.set(sessionID, run);
    return run;
  }

  /** Un envoi pendant un tour rejoint la boucle en cours, comme ensureRunning (run-state.ts). */
  #enqueue(session: FakeSession, user: OcMessageWithParts, turn: FakeTurnScript): Run {
    const current = this.#runs.get(session.id);
    if (current) {
      current.queue.push({ user, turn });
      return current;
    }
    const run = this.#newRun(session.id);
    run.queue.push({ user, turn });
    run.done = this.#drive(run, session).catch((err: unknown) => this.#runFailed(run, err));
    return run;
  }

  async #drive(run: Run, session: FakeSession): Promise<void> {
    for (let next = run.queue.shift(); next && !run.aborted; next = run.queue.shift()) {
      await this.#turn(run, session, next.user, next.turn);
    }
    if (!run.aborted) this.#settle(run);
  }

  /** Fin de boucle (run-state.ts:60-63) : run retiré, repos publié une seule fois. */
  #settle(run: Run): void {
    if (run.finished) return;
    run.finished = true;
    if (this.#runs.get(run.sessionID) === run) this.#runs.delete(run.sessionID);
    this.#setStatus(run.sessionID, { type: "idle" });
  }

  /**
   * Tour en échec, publié en session.error UnknownError puis repos (handlers/session.ts:316-325) ; le tour est arrêté. Clé
   * étrangère (session supprimée pendant le tour) : comportement attendu, pas un échec du faux.
   */
  #runFailed(run: Run, err: unknown): void {
    if (run.aborted || run.finished) return;
    if (!(err instanceof ForeignKeyError)) this.failures.push(err);
    run.aborted = true;
    run.queue.length = 0;
    run.stop();
    this.#emitFor(run.sessionID, "session.error", { sessionID: run.sessionID, error: { name: "UnknownError", data: { message: asError(err).message } } });
    if (this.#runs.get(run.sessionID) === run) this.#runs.delete(run.sessionID);
    this.#setStatus(run.sessionID, { type: "idle" });
  }

  /** Pause interrompue par un arrêt ; false si le tour ne doit plus rien émettre. */
  async #live(run: Run, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), run.stopped]);
    clearTimeout(timer);
    return !run.aborted && !this.#closed;
  }

  #newAssistant(session: FakeSession, user: OcMessageWithParts, turn: FakeTurnScript): OcMessageWithParts {
    const userInfo = user.info as OcUserMessage;
    const agent = turn.agent ?? userInfo.agent;
    const info: OcAssistantMessage & { path: { cwd: string; root: string }; summary?: boolean } = {
      id: createId("msg"),
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: userInfo.id,
      modelID: turn.modelID ?? userInfo.model.modelID,
      providerID: turn.providerID ?? userInfo.model.providerID,
      mode: agent,
      agent,
      path: { cwd: session.directory, root: "/" },
      cost: 0,
      tokens: fullTokens(),
      // Variante du message utilisateur (prompt.ts:1192), absente sans variante.
      ...(userInfo.model.variant ? { variant: userInfo.model.variant } : {}),
      ...(turn.summary ? { summary: true } : {}),
    };
    const message: OcMessageWithParts = { info, parts: [] };
    this.#putMessage(message);
    return message;
  }

  /** step-finish (coût, jetons), message clos, puis sommes propres de la session (enfants exclus, projector.ts:89-109). */
  #finishStep(session: FakeSession, message: OcMessageWithParts, usage: FakeUsage, reason: string, text?: string): void {
    const now = Date.now();
    if (text !== undefined) this.#putPart(message, { type: "text", text, time: { start: now, end: now } });
    const tokens = fullTokens(usage.tokens);
    const cost = usage.cost ?? 0;
    this.#putPart(message, { type: "step-finish", reason, cost, tokens });
    const info = message.info as OcAssistantMessage;
    Object.assign(info, { cost, tokens, finish: reason });
    info.time.completed = now;
    this.#putMessage(message);
    const own = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    session.tokens = {
      input: own.input + tokens.input,
      output: own.output + tokens.output,
      reasoning: own.reasoning + tokens.reasoning,
      cache: { read: own.cache.read + tokens.cache.read, write: own.cache.write + tokens.cache.write },
    };
    session.cost = (session.cost ?? 0) + cost;
    session.time.updated = now;
    this.#emitSessionInfo("session.updated", session);
  }

  async #turn(run: Run, session: FakeSession, user: OcMessageWithParts, turn: FakeTurnScript): Promise<void> {
    const stepMs = turn.stepMs ?? 1;
    if (!(await this.#live(run, stepMs))) return;
    this.#setStatus(session.id, { type: "busy" });
    const first = this.#newAssistant(session, user, turn);
    run.assistant = first;
    if (!(await this.#live(run, stepMs))) return;
    if (turn.error) {
      // halt : erreur publiée, repos, puis message clos avec l'erreur (processor.ts:636-642). Fin de boucle et second repos
      // (run-state.ts:60-63) dans le même bloc synchrone : une attente « since » relevée ensuite ne voit jamais ce repos.
      this.#emitFor(session.id, "session.error", { sessionID: session.id, error: turn.error });
      this.#setStatus(session.id, { type: "idle" });
      const info = first.info as OcAssistantMessage;
      info.error = jsonClone(turn.error);
      info.time.completed = Date.now();
      this.#putMessage(first);
      run.assistant = null;
      run.last = first;
      run.queue.length = 0;
      this.#settle(run);
      return;
    }
    this.#putPart(first, { type: "step-start" });
    const tools = turn.tools ?? [];
    if (tools.length === 0) {
      this.#finishStep(session, first, turn, "stop", turn.text ?? "");
      run.assistant = null;
      run.last = first;
      return;
    }
    const outcomes = await Promise.all(tools.map((tool) => this.#tool(run, session, first, tool, stepMs)));
    if (run.aborted || this.#closed) return;
    // Un message qui délègue ne se clôt qu'à la fin de ses outils (research-events §0.3).
    this.#finishStep(session, first, turn, "tool-calls");
    run.assistant = null;
    run.last = first;
    // RejectedError arrête la boucle (processor.ts:200-202, 694).
    if (outcomes.includes("blocked")) {
      run.queue.length = 0;
      return;
    }
    if (!(await this.#live(run, stepMs))) return;
    // Reprise : nouveau message d'assistant, même parentID (prompt.ts:1186-1201).
    this.#setStatus(session.id, { type: "busy" });
    const reprise = this.#newAssistant(session, user, turn);
    run.assistant = reprise;
    if (!(await this.#live(run, stepMs))) return;
    this.#putPart(reprise, { type: "step-start" });
    const followUp = turn.followUp ?? {};
    this.#finishStep(session, reprise, followUp, "stop", followUp.text ?? "Synthèse du faux opencode.");
    run.assistant = null;
    run.last = reprise;
  }

  async #tool(run: Run, session: FakeSession, message: OcMessageWithParts, tool: FakeToolScript, stepMs: number): Promise<"ok" | "blocked" | "continue"> {
    const callID = tool.callID ?? `call_${randomBytes(12).toString("hex")}`;
    let part = this.#putPart(message, { type: "tool", tool: tool.tool, callID, state: { status: "pending", input: {}, raw: "" } });
    if (!(await this.#live(run, tool.askAfterMs ?? stepMs))) return "blocked";
    const start = Date.now();
    if (tool.beforeAsk) {
      part = this.#putPart(message, { ...part, state: { status: "running", input: tool.input, time: { start } } });
      await Promise.race([tool.beforeAsk(), run.stopped]);
      if (run.aborted || this.#closed) return "blocked";
    }
    const ask = tool.ask;
    // doom_loop : règles de l'agent seules, demande sans appel d'outil (processor.ts:372-379, F-j).
    const agentScope = (ask?.scope ?? (ask?.permission === "doom_loop" ? "agent" : "session")) === "agent";
    const rules = agentScope ? [...(tool.agentRules ?? [])] : [...(tool.agentRules ?? []), ...(session.permission ?? [])];
    const approved = this.#approvedIn(session.directory);
    const verdicts = ask ? ask.patterns.map((pattern) => evaluateRules(ask.permission, pattern, rules, approved).action) : [];
    const decision = verdicts.includes("deny") ? "deny" : verdicts.includes("ask") ? "ask" : "allow";
    // edit, write, apply_patch : fichiers touchés, pour les métadonnées par défaut et les contenus connus après l'outil.
    const changes = this.#editChanges(session, tool);
    let answer: Promise<Outcome | null> = Promise.resolve({ reply: "once" });
    if (ask && decision === "ask") {
      const { promise, resolve } = Promise.withResolvers<Outcome>();
      const info: FakePermissionRequest = {
        id: createId("per"),
        sessionID: session.id,
        permission: ask.permission,
        patterns: [...ask.patterns],
        metadata: ask.metadata ?? (changes ? editMetadata(tool.tool, this.worktreeOf(session.directory), changes) : {}),
        always: ask.always ?? ["*"],
        ...(agentScope ? {} : { tool: { messageID: message.info.id, callID } }),
      };
      const { providerID, modelID, variant } = message.info as OcAssistantMessage;
      const model: ModelRef = { providerID, modelID, ...(variant ? { variant } : {}) };
      // Enregistrée avant l'événement : une réponse immédiate est valable (permission/index.ts:98-100).
      this.#pending.set(info.id, { info, directory: session.directory, settle: resolve, run, session, tool, model, stepMs });
      this.#emitFor(session.id, "permission.asked", { ...info });
      answer = Promise.race([promise, run.stopped.then(() => null)]);
    }
    // Délégation autorisée d'office : aucun « running » sans metadata, l'enfant est créé d'abord (captures p1, p6).
    if (!(tool.child && decision === "allow")) part = this.#putPart(message, { ...part, state: { status: "running", input: tool.input, time: { start } } });
    const fail = (error: string, metadata?: Record<string, unknown>) =>
      this.#putPart(message, { ...part, state: { status: "error", input: tool.input, error, ...(metadata ? { metadata } : {}), time: { start, end: Date.now() } } });
    if (ask && decision === "deny") {
      // F-b : un deny lève DeniedError sans demande (permission/index.ts:72-80) ; la boucle continue.
      const relevant = rules.filter((rule) => wildcardMatch(ask.permission, rule.permission));
      fail(`The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(relevant)}`);
      return "continue";
    }
    const outcome = await answer;
    if (outcome === null || run.aborted || this.#closed) return "blocked";
    if (outcome.reply === "reject") {
      // Sans message : RejectedError (arrête la boucle) ; avec message : CorrectedError (la boucle continue).
      if (!outcome.message) {
        fail(REJECTED);
        return "blocked";
      }
      fail(`The user rejected permission to use this specific tool call with the following feedback: ${outcome.message}`);
      return "continue";
    }
    let output = tool.output ?? "";
    let metadata: Record<string, unknown> = {};
    if (tool.child) {
      const { providerID, modelID, variant } = message.info as OcAssistantMessage;
      const result = await this.#child(session, tool, stepMs, { providerID, modelID, ...(variant ? { variant } : {}) }, { run, message, part, start });
      if (!result || run.aborted || this.#closed) return "blocked";
      part = result.part ?? part;
      const state = part.state as Record<string, unknown>;
      const kept = isRecord(state.metadata) ? state.metadata : undefined;
      if (result.failed !== undefined) {
        // Enfant arrêté seul ou en échec : outil en erreur, metadata gardée (processor.ts:186-199). Ce n'est pas une
        // RejectedError : la boucle reprend, nouvel appel facturé compris (task.ts:337-340, prompt.ts:1318-1334).
        fail(result.failed, kept);
        return "continue";
      }
      metadata = { ...kept, truncated: false };
      output = `<task id="${result.sessionID}" state="completed">\n<task_result>\n${result.text}\n</task_result>\n</task>`;
    } else if (!(await this.#live(run, stepMs))) return "blocked";
    const title = typeof tool.input.description === "string" ? tool.input.description : tool.tool;
    this.#putPart(message, { ...part, state: { status: "completed", input: tool.input, output, title, metadata, time: { start, end: Date.now() } } });
    if (changes) this.#applyEdit(changes);
    return "ok";
  }

  /**
   * Sous-agent d'un « task ». `link` absent : sous-agent détaché d'un « once » tardif (p7), le parent n'est pas touché.
   * `failed` : enfant arrêté seul (« Task cancelled », task.ts:340) ou en échec (task.ts:222-235) ; null : parent arrêté.
   */
  async #child(
    parent: FakeSession,
    tool: FakeToolScript,
    stepMs: number,
    model: ModelRef,
    link: { run: Run; message: OcMessageWithParts; part: OcPart; start: number } | null,
  ): Promise<ChildResult | null> {
    const spec = tool.child;
    if (!spec) return null;
    const description = typeof tool.input.description === "string" ? tool.input.description : tool.tool;
    // task_id d'une session existante : reprise sans création (tool/task.ts:136-172) ; inconnu : nouvel enfant.
    const resumed = typeof tool.input.task_id === "string" ? this.#sessions.get(tool.input.task_id) : undefined;
    const child =
      resumed ??
      this.#createSession({
        directory: parent.directory,
        parentID: parent.id,
        title: `${description} (@${spec.agent} subagent)`,
        agent: spec.agent,
        // Règles de l'agent : scriptées, sinon celles de l'agent du dossier (GET /agent), sinon aucune.
        permission: deriveChildRules(parent.permission ?? [], spec.agentRules ?? this.agents(parent.directory).find((agent) => agent.name === spec.agent)?.permission ?? []),
      });
    // IA fixée par l'agent cible : sans variante ; sinon IA et variante du message qui délègue (task.ts:196-215).
    const childModel: ModelRef = spec.model ? { providerID: spec.model.providerID, modelID: spec.model.modelID } : model;
    let part: OcPart | null = null;
    if (link) {
      const metadata = { parentSessionId: parent.id, sessionId: child.id, model: { providerID: childModel.providerID, modelID: childModel.modelID } };
      part = this.#putPart(link.message, { ...link.part, state: { status: "running", input: tool.input, time: { start: link.start }, title: description, metadata } });
      link.run.children.add(child.id);
    }
    const run = this.#newRun(child.id);
    // settled(enfant) : #newRun pose une promesse déjà résolue, remplacée ici par la fin du sous-agent. Le finally la résout sur
    // toutes les sorties (fin normale, arrêt, clé étrangère d'un détaché, erreur relancée), toujours après le repos publié.
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
    run.done = finished;
    const stopped = (): ChildResult | null =>
      link && !link.run.aborted && !this.#closed ? { sessionID: child.id, text: "", part, failed: "Task cancelled" } : null;
    try {
      try {
        const now = Date.now();
        this.#setAgentModel(child, spec.agent, childModel, now);
        const user: OcMessageWithParts = {
          info: { id: createId("msg"), sessionID: child.id, role: "user", time: { created: now }, agent: spec.agent, model: childModel },
          parts: [],
        };
        this.#putMessage(user);
        this.#putPart(user, { type: "text", text: typeof tool.input.prompt === "string" ? tool.input.prompt : "" });
        if (spec.turn) {
          await this.#turn(run, child, user, { ...spec.turn, agent: spec.turn.agent ?? spec.agent });
          if (run.aborted || this.#closed) return stopped();
        } else {
          this.#setStatus(child.id, { type: "busy" });
          const assistant = this.#newAssistant(child, user, { agent: spec.agent });
          run.assistant = assistant;
          if (!(await this.#live(run, spec.workMs ?? stepMs))) return stopped();
          this.#putPart(assistant, { type: "step-start" });
          this.#finishStep(child, assistant, spec, "stop", spec.text ?? "Résultat du sous-agent.");
          run.assistant = null;
          run.last = assistant;
        }
      } catch (err) {
        // Sous-agent détaché dont la session a été supprimée : il échoue à sa prochaine écriture, comme un tour.
        if (link || !(err instanceof ForeignKeyError)) throw err;
        this.#runFailed(run, err);
        return null;
      }
      this.#settle(run);
      const last = run.last;
      const info = last?.info as OcAssistantMessage | undefined;
      const errored = last?.parts.findLast((p) => p.type === "tool" && isRecord(p.state) && p.state.status === "error");
      let reason: string | undefined;
      if (info?.error) reason = typeof info.error.data?.message === "string" ? info.error.data.message : info.error.name;
      else if (errored && isRecord(errored.state)) reason = String(errored.state.error);
      const lastText = last?.parts.findLast((p) => p.type === "text")?.text;
      const text = spec.turn ? (typeof lastText === "string" ? lastText : "") : (spec.text ?? "Résultat du sous-agent.");
      return { sessionID: child.id, text, part, ...(reason === undefined ? {} : { failed: `Subagent failed (task_id: ${child.id}): ${reason}` }) };
    } finally {
      finish();
    }
  }

  /** Sans tour : repos seulement (run-state.ts:77-86). Les sessions créées par POST /session ne sont pas arrêtées avec leur parent. */
  #abort(sessionID: string): void {
    const run = this.#runs.get(sessionID);
    if (!run) return this.#setStatus(sessionID, { type: "idle" });
    this.#interrupt(run);
  }

  /**
   * Ordre mesuré (p6) : sous-agents du tour d'abord ; pour chaque session session.error MessageAbortedError, repos, parties
   * d'outil ouvertes en « error » avec metadata.interrupted, message clos avec l'erreur, repos à nouveau. Arrêt avant le message
   * d'assistant (juste après le 204, entre deux tours) : un seul repos, sans session.error (run-state.ts:77-86,
   * runner.ts:171-183). La demande d'autorisation en attente n'est PAS retirée (research-events §8, G9).
   */
  #interrupt(run: Run): void {
    if (run.aborted) return;
    run.aborted = true;
    run.queue.length = 0;
    run.stop();
    if (this.#runs.get(run.sessionID) === run) this.#runs.delete(run.sessionID);
    for (const id of run.children) {
      const child = this.#runs.get(id);
      if (!child) continue;
      child.quiet = run.quiet;
      this.#interrupt(child);
    }
    const message = run.assistant;
    run.assistant = null;
    run.last = message ?? run.last;
    const { sessionID } = run;
    if (run.quiet) {
      this.#statuses.delete(sessionID);
      return;
    }
    if (message) {
      this.#emitFor(sessionID, "session.error", { sessionID, error: ABORTED });
      this.#setStatus(sessionID, { type: "idle" });
      // Session supprimée : plus aucune écriture possible (clé étrangère).
      if (this.#sessions.has(sessionID)) {
        const end = Date.now();
        for (const part of message.parts) {
          const state = isRecord(part.state) ? part.state : null;
          if (part.type !== "tool" || !state || (state.status !== "pending" && state.status !== "running")) continue;
          const metadata = { ...(isRecord(state.metadata) ? state.metadata : {}), interrupted: true };
          const startedAt = isRecord(state.time) && typeof state.time.start === "number" ? state.time.start : end;
          this.#putPart(message, { ...part, state: { ...state, status: "error", error: "Tool execution aborted", metadata, time: { start: startedAt, end } } });
        }
        const info = message.info as OcAssistantMessage;
        info.time.completed = end;
        info.error = jsonClone(ABORTED);
        this.#putMessage(message);
      }
    }
    this.#setStatus(sessionID, { type: "idle" });
  }

  #reply(requestID: string, directory: string, reply: PermissionReply, message: string | undefined): boolean {
    const entry = this.#pending.get(requestID);
    if (!entry || entry.directory !== directory) return false;
    this.#pending.delete(requestID);
    const { sessionID } = entry.info;
    this.#emitFor(sessionID, "permission.replied", { sessionID, requestID, reply });
    if (reply === "reject") {
      entry.settle(message ? { reply, message } : { reply });
      // F-c : un refus refuse aussi toutes les autres demandes en attente de la session (permission/index.ts:121-139).
      for (const [id, other] of this.#pending) {
        if (other.info.sessionID !== sessionID) continue;
        this.#pending.delete(id);
        this.#emitFor(sessionID, "permission.replied", { sessionID, requestID: id, reply: "reject" });
        other.settle({ reply: "reject" });
      }
      return true;
    }
    this.#accept(entry, reply);
    // F-c : « once » n'ajoute rien à `approved`.
    if (reply === "once") return true;
    const approved = this.#approvedIn(entry.directory);
    for (const pattern of entry.info.always) approved.push({ permission: entry.info.permission, pattern, action: "allow" });
    for (const [id, other] of this.#pending) {
      if (other.info.sessionID !== sessionID) continue;
      if (!other.info.patterns.every((pattern) => evaluateRules(other.info.permission, pattern, approved).action === "allow")) continue;
      this.#pending.delete(id);
      this.#emitFor(sessionID, "permission.replied", { sessionID, requestID: id, reply: "always" });
      this.#accept(other, "always");
    }
    return true;
  }

  #accept(entry: PendingEntry, reply: "once" | "always"): void {
    entry.settle({ reply });
    // p7 : le tour arrêté n'attend plus, mais l'accord lance quand même le sous-agent, détaché et facturé.
    if (!entry.run.aborted || !entry.tool.child) return;
    this.#child(entry.session, entry.tool, entry.stepMs, entry.model, null).catch((err: unknown) => this.failures.push(err));
  }

  /**
   * Fichiers touchés par un outil edit, write ou apply_patch, chemins résolus depuis le dossier de la session ; null pour un autre outil
   * ou une entrée illisible. Fichier inconnu du faux (`files`) : son contenu est supposé égal au texte remplacé (oldString, lignes « »
   * et « - » du bloc), ou vide pour write et une suppression.
   */
  #editChanges(session: FakeSession, tool: FakeToolScript): EditChange[] | null {
    const input = tool.input;
    const absolute = (file: string) => path.posix.resolve(session.directory, file);
    if (tool.tool === "write" || tool.tool === "edit") {
      if (typeof input.filePath !== "string" || input.filePath === "") return null;
      const filePath = absolute(input.filePath);
      const known = this.files.get(filePath);
      if (tool.tool === "write") {
        return typeof input.content === "string" ? [{ type: known === undefined ? "add" : "update", filePath, before: known ?? "", after: input.content }] : null;
      }
      const { oldString, newString } = input;
      if (typeof oldString !== "string" || typeof newString !== "string") return null;
      const before = known ?? oldString;
      // Remplacement par fonction : « $& » ou « $1 » d'un texte de test restent littéraux.
      const after = input.replaceAll === true ? before.replaceAll(oldString, () => newString) : before.replace(oldString, () => newString);
      return [{ type: "update", filePath, before, after }];
    }
    if (tool.tool !== "apply_patch" || typeof input.patchText !== "string") return null;
    const hunks = parseApplyPatch(input.patchText);
    if (!hunks) return null;
    return hunks.map((hunk): EditChange => {
      const filePath = absolute(hunk.path);
      const known = this.files.get(filePath);
      if (hunk.type === "add") return { type: "add", filePath, before: "", after: hunk.content };
      if (hunk.type === "delete") return { type: "delete", filePath, before: known ?? "", after: "" };
      const base = known?.includes(hunk.from) ? known : undefined;
      return {
        type: hunk.movePath ? "move" : "update",
        filePath,
        ...(hunk.movePath ? { movePath: absolute(hunk.movePath) } : {}),
        before: base ?? hunk.from,
        after: base?.replace(hunk.from, () => hunk.to) ?? hunk.to,
      };
    });
  }

  /** Contenus connus après un outil terminé : fichier écrit, déplacé (ancien chemin retiré) ou supprimé. */
  #applyEdit(changes: readonly EditChange[]): void {
    for (const change of changes) {
      if (change.type === "move" || change.type === "delete") this.files.delete(change.filePath);
      if (change.type !== "delete") this.files.set(change.movePath ?? change.filePath, change.after);
    }
  }

  /** Libération d'une instance : remise à zéro facultative (suite d'arrêt publiée, mesure M14), puis server.instance.disposed. */
  #disposeInstance(directory: string, reset: boolean): void {
    if (reset) this.#resetInstances(directory);
    this.#instances.delete(directory);
    this.emitInstanceDisposed(directory);
  }

  /**
   * Remise à zéro d'une instance (de toutes sans `directory`) : tours coupés, demandes et questions rejetées sans événement, états et
   * accords vidés. Chaque tour coupé publie la suite d'un arrêt (#interrupt) : mesure M14 (MX1 §2) sur POST /global/dispose ; même
   * finaliseur d'instance pour POST /instance/dispose et un PATCH /global/config qui change la configuration (source, non mesuré à
   * part). `quiet` : fermeture du faux, sans aucun événement.
   */
  #resetInstances(directory?: string, options: { quiet?: boolean } = {}): void {
    const inside = (sessionID: string) => directory === undefined || this.#directoryOf(sessionID) === directory;
    for (const run of [...this.#runs.values()]) {
      if (!inside(run.sessionID)) continue;
      run.quiet = options.quiet === true;
      this.#interrupt(run);
    }
    for (const [id, entry] of [...this.#pending]) {
      if (directory !== undefined && entry.directory !== directory) continue;
      this.#pending.delete(id);
      entry.settle({ reply: "reject" });
    }
    for (const [id, entry] of [...this.#questions]) if (directory === undefined || entry.directory === directory) this.#questions.delete(id);
    for (const sessionID of [...this.#statuses.keys()]) if (inside(sessionID)) this.#statuses.delete(sessionID);
    if (directory === undefined) this.#approved.clear();
    else this.#approved.delete(directory);
  }
}
