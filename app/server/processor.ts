// Traitement du flux d'événements opencode : registre des coûts, sessions, archivage, relais navigateur.
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveService } from "./archive.ts";
import type { Classifier } from "./classifier.ts";
import { type EventHub, FORWARDED_EVENTS } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import type {
  OcEvent,
  OcGlobalEvent,
  OcMessage,
  OcMessageWithParts,
  OcPart,
  OcSession,
  OpencodeClient,
} from "./opencode.ts";
import type { SessionTracker } from "./sessions.ts";

const PROCESSED = new Set(["session.created", "session.updated", "session.deleted", "session.idle", "session.status", "message.updated", "message.part.updated"]);
const DAY_MS = 86_400_000;

export function sessionIdOf(event: OcEvent): string | undefined {
  const p = event.properties ?? {};
  if (typeof p.sessionID === "string") return p.sessionID;
  const info = p.info as { sessionID?: unknown; id?: unknown } | undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const part = p.part as { sessionID?: unknown } | undefined;
  if (typeof part?.sessionID === "string") return part.sessionID;
  if (event.type.startsWith("session.") && typeof info?.id === "string") return info.id;
  return undefined;
}

export interface ProcessorDeps {
  db: DatabaseSync;
  client: OpencodeClient;
  sessions: SessionTracker;
  ledger: Ledger;
  archive: ArchiveService;
  classifier: Classifier;
  hub: EventHub;
  log: Logger;
}

export class EventProcessor {
  readonly #d: ProcessorDeps;
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: (() => void) | null = null;
  #connected = false;
  #lastEventAt = 0;
  #lastError: string | null = null;
  #backfilling: Promise<void> | null = null;

  constructor(deps: ProcessorDeps) {
    this.#d = deps;
  }

  get status() {
    return { connected: this.#connected, lastEventAt: this.#lastEventAt, lastError: this.#lastError, backfilling: this.#backfilling !== null };
  }

  start(): void {
    this.#unsubscribe = this.#d.client.subscribeGlobal(
      (event) => this.#onEvent(event),
      (status, error) => {
        const wasConnected = this.#connected;
        this.#connected = status === "connected";
        this.#lastError = error ?? null;
        if (wasConnected !== this.#connected) {
          this.#d.log[this.#connected ? "info" : "warn"](`flux opencode ${this.#connected ? "connecté" : "déconnecté"}`, error ? { error } : {});
          this.#d.hub.cockpit("opencode.connection", { connected: this.#connected, error: this.#lastError });
        }
        // Des événements ont pu être manqués pendant la coupure : rattrapage.
        if (this.#connected && !wasConnected) void this.backfill().catch(() => undefined);
      },
    );
  }

  stop(): void {
    this.#unsubscribe?.();
  }

  #onEvent(global: OcGlobalEvent): void {
    this.#lastEventAt = Date.now();
    const event = global.payload;
    if (!event?.type) return;
    if (FORWARDED_EVENTS.has(event.type) && !this.#d.sessions.isHidden(sessionIdOf(event))) {
      this.#d.hub.publish({ kind: "opencode", ...(global.directory ? { directory: global.directory } : {}), event });
    }
    if (!PROCESSED.has(event.type)) return;
    this.#queue = this.#queue
      .then(() => this.#process(global))
      .catch((err) => this.#d.log.warn("traitement d'événement en échec", { type: event.type, error: errorMessage(err) }));
  }

  async #process(global: OcGlobalEvent): Promise<void> {
    const { type, properties: p } = global.payload;
    const { sessions, ledger, archive, classifier, hub } = this.#d;
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = p.info as OcSession;
        const row = sessions.upsert(info);
        // opencode génère le vrai titre après le premier échange : l'archive le reprend.
        if (type === "session.updated" && row.purpose === "chat" && !info.parentID && (await archive.syncTitle(info.id, info.title))) {
          hub.cockpit("conversation.updated", { sessionId: info.id });
        }
        return;
      }
      case "session.deleted": {
        const info = p.info as OcSession | undefined;
        const id = info?.id ?? (p.sessionID as string | undefined);
        if (id) {
          sessions.markDeleted(id);
          archive.markDeletedInOpencode(id);
        }
        return;
      }
      case "message.updated": {
        const info = p.info as OcMessage;
        const row = await sessions.ensure(info.sessionID, global.directory);
        if (!row) return;
        if (info.role === "user") {
          ledger.recordUser(info, row);
          return;
        }
        const changed = ledger.recordAssistant(info, row);
        if (changed && info.time.completed) {
          hub.cockpit("usage.updated", {
            sessionId: info.sessionID,
            rootId: row.root_id,
            monthSpentUsd: ledger.monthTotal(),
            percent: ledger.percentUsed(),
          });
          for (const alert of ledger.checkAlerts()) hub.cockpit("budget.alert", alert);
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part as OcPart;
        if (part.type === "text" && !part.synthetic && typeof part.text === "string") ledger.setPromptPreview(part.messageID, part.text);
        return;
      }
      case "session.idle": {
        const id = p.sessionID as string;
        const row = await sessions.ensure(id, global.directory);
        if (row && row.purpose === "chat" && row.parent_id === null) classifier.onIdle(row.id);
        return;
      }
      case "session.status": {
        const status = p.status as { type?: string } | undefined;
        const row = sessions.get(p.sessionID as string);
        if (status?.type === "busy" && row) classifier.onBusy(row.root_id);
        return;
      }
    }
  }

  /** Rattrape les sessions modifiées depuis la dernière synchronisation (démarrage, reconnexion). */
  backfill(): Promise<void> {
    if (this.#backfilling) return this.#backfilling;
    this.#backfilling = this.#backfill().finally(() => {
      this.#backfilling = null;
    });
    return this.#backfilling;
  }

  async #backfill(): Promise<void> {
    const { db, client, sessions, ledger, archive, log } = this.#d;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sync.lastAt'").get() as { value: string } | undefined;
    const since = row ? Number(row.value) - 60_000 : Date.now() - 45 * DAY_MS;
    const startedAt = Date.now();
    let list: OcSession[];
    try {
      list = await client.request<OcSession[]>("GET", "/experimental/session", { query: { limit: 1000 }, timeoutMs: 30_000 });
    } catch (err) {
      log.warn("rattrapage : liste des sessions indisponible", { error: errorMessage(err) });
      return;
    }
    const recent = list
      .filter((s) => (s.time?.updated ?? 0) >= since && !(s.title ?? "").startsWith("[cockpit]"))
      .sort((a, b) => (a.parentID ? 1 : 0) - (b.parentID ? 1 : 0) || a.time.created - b.time.created);
    for (const info of recent) sessions.upsert(info);
    const roots = new Set<string>();
    for (const info of recent) {
      try {
        const messages = await client.request<OcMessageWithParts[]>("GET", `/session/${encodeURIComponent(info.id)}/message`, {
          directory: info.directory,
          timeoutMs: 60_000,
        });
        const session = sessions.get(info.id);
        if (!session) continue;
        for (const { info: message, parts } of messages) {
          if (message.role === "user") {
            ledger.recordUser(message, session);
            const text = parts.find((part) => part.type === "text" && !part.synthetic)?.text;
            if (typeof text === "string") ledger.setPromptPreview(message.id, text);
          } else {
            ledger.recordAssistant(message, session);
          }
        }
        roots.add(session.root_id);
      } catch (err) {
        log.warn("rattrapage : session ignorée", { sessionId: info.id, error: errorMessage(err) });
      }
    }
    for (const rootId of roots) {
      const conv = archive.get(rootId);
      const session = sessions.get(rootId);
      if (session && session.purpose === "chat" && (!conv || conv.updatedAt < session.updated_at)) {
        await archive.refresh(rootId).catch((err) => log.warn("rattrapage : archivage impossible", { rootId, error: errorMessage(err) }));
      }
    }
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('sync.lastAt', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(String(startedAt), Date.now());
    if (recent.length > 0) {
      log.info("rattrapage terminé", { sessions: recent.length, conversations: roots.size });
      this.#d.hub.cockpit("usage.updated", { monthSpentUsd: ledger.monthTotal(), percent: ledger.percentUsed() });
    }
  }
}
