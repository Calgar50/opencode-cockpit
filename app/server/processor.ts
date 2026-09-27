// Traitement du flux d'événements opencode : registre des coûts, sessions, archivage, relais navigateur.
// 1.1, Salle OMO (L18a) : un processeur par instance. Celui de la salle étiquette tout ce qu'il publie (`BrowserEvent.instance`),
// publie `omo.connection` au lieu d'`opencode.connection` (l'adresse Copilot de l'instance principale n'est donc jamais mise en
// « synchro due » par une coupure de la salle), garde sa propre clé de rattrapage (`sync.lastAt:omo`), écrit ses sessions avec
// son instance et n'appelle NI le classement NI la reprise du titre d'archive (D-2b-05 : aucun appel facturé pour la salle).
// Une session suivie par l'autre instance n'est jamais touchée, même à identifiant égal (P11).
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveService } from "./archive.ts";
import type { Classifier } from "./classifier.ts";
import type { EventDerivation } from "./contracts-11.ts";
import { type EventHub, FORWARDED_EVENTS } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import type {
  OcEvent,
  OcGlobalEvent,
  OcMessage,
  OcMessageWithParts,
  OcSession,
  OpencodeClient,
} from "./opencode.ts";
import type { SessionTracker } from "./sessions.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { isClassifierRoot } from "./shared/session-purpose.ts";

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
  /**
   * Instance d'opencode dont ce processeur traite le flux (1.1). Absente : « principale », c'est-à-dire le seul processeur de la
   * 1.0.x — rien n'est alors étiqueté et chaque écriture est exactement celle de la 1.0.x.
   */
  instance?: SessionInstance;
}

/** Clé de rattrapage : celle de la 1.0.x pour l'instance principale, une clé propre pour toute autre instance (P11). */
export function syncKeyOf(instance: SessionInstance): string {
  return instance === "principale" ? "sync.lastAt" : `sync.lastAt:${instance}`;
}

export class EventProcessor {
  readonly #d: ProcessorDeps;
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: (() => void) | null = null;
  #connected = false;
  #lastEventAt = 0;
  #lastError: string | null = null;
  #backfilling: Promise<void> | null = null;
  /** Dérivations 1.1 (app-factory), appelées dans l'ordre d'inscription. */
  #derivations: EventDerivation[] = [];

  constructor(deps: ProcessorDeps) {
    this.#d = deps;
  }

  /**
   * Dérivation 1.1 (spécification §3.10) : appelée de façon synchrone pour chaque événement typé, après la diffusion et avant la
   * file, y compris hors des événements traités ici et pour une session cachée. Une exception est journalisée sans arrêter la
   * diffusion, la file ni les autres dérivations. Rend la fonction qui la retire.
   */
  addDerivation(derivation: EventDerivation): () => void {
    this.#derivations = [...this.#derivations, derivation];
    return () => {
      this.#derivations = this.#derivations.filter((d) => d !== derivation);
    };
  }

  /** Instance servie par ce processeur ; « principale » quand l'option est absente (seul processeur de la 1.0.x). */
  get instance(): SessionInstance {
    return this.#d.instance ?? "principale";
  }

  get status() {
    return { connected: this.#connected, lastEventAt: this.#lastEventAt, lastError: this.#lastError, backfilling: this.#backfilling !== null };
  }

  /** File de traitement à jour : rend la main quand tout ce qui est DÉJÀ reçu est traité (harnais des tests, arrêt). */
  settled(): Promise<void> {
    return this.#queue;
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
          // Salle OMO : « omo.connection », jamais « opencode.connection » — une coupure du flux de la salle ne pose donc
          // aucune « synchro due » sur l'adresse Copilot de l'instance principale (resyncOnReconnect, oc-copilot-config.ts).
          if (this.instance === "principale") {
            this.#d.hub.cockpit("opencode.connection", { connected: this.#connected, error: this.#lastError });
          } else {
            this.#d.hub.cockpit("omo.connection", { connected: this.#connected, ...(this.#lastError === null ? {} : { error: this.#lastError }) }, this.instance);
          }
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
      // Étiquette de l'enveloppe (P3) : champ ABSENT pour l'instance principale, donc exactement l'objet de la 1.0.x.
      this.#d.hub.publish({ kind: "opencode", ...(global.directory ? { directory: global.directory } : {}), event, ...this.#tag() });
    }
    for (const derivation of this.#derivations) {
      try {
        derivation.onEvent(global, { instance: this.instance });
      } catch (err) {
        this.#d.log.warn("dérivation d'événement en échec", { derivation: derivation.name, type: event.type, error: errorMessage(err) });
      }
    }
    if (!PROCESSED.has(event.type)) return;
    this.#queue = this.#queue
      .then(() => this.#process(global))
      .catch((err) => this.#d.log.warn("traitement d'événement en échec", { type: event.type, error: errorMessage(err) }));
  }

  /** Étiquette d'instance à recopier dans une publication : rien pour l'instance principale (P3). */
  #tag(): { instance?: SessionInstance } {
    return this.instance === "principale" ? {} : { instance: this.instance };
  }

  /** Vrai quand la session est suivie par une AUTRE instance : cet événement ne doit rien toucher (P11). */
  #autreInstance(id: string | undefined): boolean {
    if (!id) return false;
    const instance = this.#d.sessions.instanceOf(id);
    return instance !== null && instance !== this.instance;
  }

  async #process(global: OcGlobalEvent): Promise<void> {
    const { type, properties: p } = global.payload;
    const { sessions, ledger, archive, classifier, hub } = this.#d;
    const instance = this.instance;
    const tag = this.#tag();
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = p.info as OcSession;
        const row = sessions.upsert(info, undefined, { instance });
        // Identifiant déjà suivi par l'autre instance : upsert a refusé et annoncé le conflit, rien n'est repris ici.
        if (row.instance !== instance) return;
        // opencode génère le vrai titre après le premier échange : l'archive le reprend. JAMAIS pour la salle (D-2b-05) : le
        // titre facturé d'une conversation de la salle n'entre pas dans l'archive de l'instance principale.
        if (
          instance === "principale" &&
          type === "session.updated" &&
          row.purpose === "chat" &&
          !info.parentID &&
          (await archive.syncTitle(info.id, info.title))
        ) {
          hub.cockpit("conversation.updated", { sessionId: info.id });
        }
        return;
      }
      case "session.deleted": {
        const info = p.info as OcSession | undefined;
        const id = info?.id ?? (p.sessionID as string | undefined);
        if (id && !this.#autreInstance(id)) {
          sessions.markDeleted(id);
          archive.markDeletedInOpencode(id);
        }
        return;
      }
      case "message.updated": {
        const info = p.info as OcMessage;
        const row = await sessions.ensure(info.sessionID, global.directory, 0, instance);
        if (!row || row.instance !== instance) return;
        if (info.role === "user") {
          ledger.recordUser(info, row);
          return;
        }
        const changed = ledger.recordAssistant(info, row);
        if (changed && info.time.completed) {
          hub.cockpit(
            "usage.updated",
            { sessionId: info.sessionID, rootId: row.root_id, monthSpentUsd: ledger.monthTotal(), percent: ledger.percentUsed(), ...tag },
            tag.instance,
          );
          // Le budget mensuel est celui du compte, commun aux deux instances : l'alerte n'est jamais étiquetée, elle part à tous.
          for (const alert of ledger.checkAlerts()) hub.cockpit("budget.alert", alert);
        }
        return;
      }
      case "session.idle": {
        const id = p.sessionID as string;
        const row = await sessions.ensure(id, global.directory, 0, instance);
        if (!row || row.instance !== instance) return;
        // D-2b-05 : ni archivage différé, ni classement facturé pour la salle. Son archive est écrite par les routes de la salle.
        if (instance === "principale" && row.purpose === "chat" && row.parent_id === null) classifier.onIdle(row.id);
        return;
      }
      case "session.status": {
        const status = p.status as { type?: string } | undefined;
        const row = sessions.get(p.sessionID as string);
        if (status?.type === "busy" && row && row.instance === instance && instance === "principale") classifier.onBusy(row.root_id);
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
    const instance = this.instance;
    // Clé propre à l'instance : la salle ne fait jamais avancer (ni reculer) la synchronisation de l'instance principale.
    const syncKey = syncKeyOf(instance);
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(syncKey) as { value: string } | undefined;
    const since = row ? Number(row.value) - 60_000 : Date.now() - 45 * DAY_MS;
    const startedAt = Date.now();
    let list: OcSession[];
    try {
      list = await client.request<OcSession[]>("GET", "/experimental/session", { query: { limit: 1000 }, timeoutMs: 30_000 });
    } catch (err) {
      log.warn("rattrapage : liste des sessions indisponible", { error: errorMessage(err) });
      return;
    }
    // Racines de classement écartées (métadonnée ou titre exact) ; toute autre session titrée « [cockpit] … » est relue : le titre
    // d'une conversation ou d'un enfant est écrit par l'IA (shared/session-purpose.ts).
    const recent = list
      .filter((s) => (s.time?.updated ?? 0) >= since && !isClassifierRoot(s))
      .sort((a, b) => (a.parentID ? 1 : 0) - (b.parentID ? 1 : 0) || a.time.created - b.time.created);
    for (const info of recent) sessions.upsert(info, undefined, { instance });
    const roots = new Set<string>();
    for (const info of recent) {
      if (this.#autreInstance(info.id)) continue;
      try {
        const messages = await client.request<OcMessageWithParts[]>("GET", `/session/${encodeURIComponent(info.id)}/message`, {
          directory: info.directory,
          timeoutMs: 60_000,
        });
        const session = sessions.get(info.id);
        if (!session) continue;
        for (const { info: message } of messages) {
          if (message.role === "user") {
            ledger.recordUser(message, session);
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
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(syncKey, String(startedAt), Date.now());
    if (recent.length > 0) {
      log.info("rattrapage terminé", { sessions: recent.length, conversations: roots.size });
      const tag = this.#tag();
      this.#d.hub.cockpit("usage.updated", { monthSpentUsd: ledger.monthTotal(), percent: ledger.percentUsed(), ...tag }, tag.instance);
    }
  }
}
