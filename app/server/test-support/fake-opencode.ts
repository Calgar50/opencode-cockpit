// Faux opencode 1.18.30 scripté pour les tests (node:http seul). Formes et ordres d'événements repris des captures
// ocgraph et ocauto du 2026-09-14 et des sources (packages/opencode/src au tag v1.18.30).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OcAssistantMessage, OcEvent, OcMessageWithParts, OcPart, OcSession, OcTokens, OcUserMessage } from "../opencode.ts";

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
}

type Outcome = { reply: PermissionReply; message?: string };
type ModelRef = { providerID: string; modelID: string; variant?: string };
type ChildResult = { sessionID: string; text: string; part: OcPart | null; failed?: string };

interface Run {
  sessionID: string;
  aborted: boolean;
  /** Arrêt sans événement (fermeture, remise à zéro d'une instance). */
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

  constructor(options: FakeOpencodeOptions = {}) {
    this.#username = options.username ?? "opencode";
    this.#password = options.password || undefined;
    this.directory = options.directory ?? "/workspace";
    this.project = options.project ?? "global";
    this.version = options.version ?? "1.18.30";
    this.#heartbeatMs = options.heartbeatMs ?? 10_000;
    this.syncTwins = options.syncTwins ?? true;
  }

  get url(): string {
    return this.#url;
  }

  async start(): Promise<string> {
    const server = http.createServer((req, res) => this.#receive(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.#server = server;
    this.#url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.#url;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#resetInstances();
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

  /** Fin de la boucle de tours en cours de la session, repos compris (résolue aussitôt sans tour en cours). */
  settled(sessionID: string): Promise<void> {
    return this.#runs.get(sessionID)?.done ?? Promise.resolve();
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
   * disposeAll puis global.disposed (global-lifecycle.ts:16-25) : server.instance.disposed pour chaque instance chargée, puis
   * global.disposed. `resetInstances` : demandes rejetées sans événement, tours coupés, états vidés.
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
    // Demandes et états sont propres à l'instance du répertoire demandé (InstanceState).
    if (is("GET", "permission")) return json(200, [...this.#pending.values()].filter((e) => e.directory === directory).map((e) => e.info));
    if (is("POST", "permission", "*", "reply")) {
      if (typeof input.reply !== "string" || !REPLIES.has(input.reply)) return bad();
      if (input.message !== undefined && typeof input.message !== "string") return bad();
      if (this.#reply(id, directory, input.reply as PermissionReply, input.message)) return json(200, true);
      // Forme mesurée d'une seconde réponse (autonomy-capture/raw/approvals.jsonl).
      return json(404, { _tag: "PermissionNotFoundError", requestID: id, message: `Permission request not found: ${id}` });
    }
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
    const info: OcAssistantMessage & { path: { cwd: string; root: string } } = {
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
    if (!(await this.#live(run, stepMs))) return "blocked";
    const start = Date.now();
    const ask = tool.ask;
    // doom_loop : règles de l'agent seules, demande sans appel d'outil (processor.ts:372-379, F-j).
    const agentScope = (ask?.scope ?? (ask?.permission === "doom_loop" ? "agent" : "session")) === "agent";
    const rules = agentScope ? [...(tool.agentRules ?? [])] : [...(tool.agentRules ?? []), ...(session.permission ?? [])];
    const approved = this.#approvedIn(session.directory);
    const verdicts = ask ? ask.patterns.map((pattern) => evaluateRules(ask.permission, pattern, rules, approved).action) : [];
    const decision = verdicts.includes("deny") ? "deny" : verdicts.includes("ask") ? "ask" : "allow";
    let answer: Promise<Outcome | null> = Promise.resolve({ reply: "once" });
    if (ask && decision === "ask") {
      const { promise, resolve } = Promise.withResolvers<Outcome>();
      const info: FakePermissionRequest = {
        id: createId("per"),
        sessionID: session.id,
        permission: ask.permission,
        patterns: [...ask.patterns],
        metadata: ask.metadata ?? {},
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
        permission: deriveChildRules(parent.permission ?? [], spec.agentRules ?? []),
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
    const stopped = (): ChildResult | null =>
      link && !link.run.aborted && !this.#closed ? { sessionID: child.id, text: "", part, failed: "Task cancelled" } : null;
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

  /** Libération d'une instance : remise à zéro facultative, puis server.instance.disposed. */
  #disposeInstance(directory: string, reset: boolean): void {
    if (reset) this.#resetInstances(directory);
    this.#instances.delete(directory);
    this.emitInstanceDisposed(directory);
  }

  /** Remise à zéro silencieuse d'une instance (de toutes sans `directory`) : tours coupés, demandes rejetées sans événement, états et accords vidés. */
  #resetInstances(directory?: string): void {
    const inside = (sessionID: string) => directory === undefined || this.#directoryOf(sessionID) === directory;
    for (const run of [...this.#runs.values()]) {
      if (!inside(run.sessionID)) continue;
      run.quiet = true;
      this.#interrupt(run);
    }
    for (const [id, entry] of [...this.#pending]) {
      if (directory !== undefined && entry.directory !== directory) continue;
      this.#pending.delete(id);
      entry.settle({ reply: "reject" });
    }
    for (const sessionID of [...this.#statuses.keys()]) if (inside(sessionID)) this.#statuses.delete(sessionID);
    if (directory === undefined) this.#approved.clear();
    else this.#approved.delete(directory);
  }
}
