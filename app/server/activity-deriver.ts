// Propriétaire : L4b.
// Dérivation synchrone des faits d'activité (spécification §3.10, §5.7.3 ; plan d'exécution, fiche L4b) : chaque événement opencode
// passe par factsFromEvent (L4a), avec un contexte lu dans la base et dans la mémoire du flux, puis par FactDeduper ; les faits
// nouveaux vont au port facts (append), et les délégations et attentes d'accord qu'ils décrivent à work.markDelegation et
// work.markWait (lus sur c11.ports au moment de l'appel). Inscrite par le module facts (fact-store.ts).
// Aucune attente réseau dans onEvent : les événements d'une session inconnue du cockpit (ou de lignée incomplète) sont mis de côté
// et sessions.ensure part HORS de la file du processeur et hors de l'appel (microtâche), borné à 5 s ; au-delà, ou si opencode
// ne la connaît pas, ses événements sont abandonnés (trou « non enregistré ») et elle n'est plus recherchée pendant 30 s.
// Origine « demande » (§5.7.2, cas 1) : ledger.recordUser inscrit dans `prompts` TOUT message reçu, qui ne prouve donc rien. Un
// message utilisateur n'est dit envoyé par le cockpit que s'il suit une ligne chat_turns écrite par le proxy AVANT le relais
// (même session, message ou raccourci, 30 s au plus avant, 2 s au plus après) ; chaque ligne ne vaut que pour un seul message.
// Cas 2 (équipes) : itération 4.
// Délégations et attentes : seuls des faits observés font avancer un état. Une partie `task` interrompue n'expire pas la demande
// d'autorisation qu'elle avait posée (captures p6 puis p7 : la demande reste en attente et un « once » tardif lance encore un
// sous-agent) ; une demande n'expire que si son instance est libérée (server.instance.disposed, global.disposed : mesure M14,
// demande disparue sans permission.replied). « Lancée sans confirmation » n'est posé que pour un raccourci (subtask) : l'absence
// d'une demande vue dans le flux ne prouve rien (événements manqués pendant une coupure) ; pour un agent `task: allow`, c'est
// l'évaluation de ses règles (garde des délégations, L1d) qui peut le dire, par ce même port.
import type { Cockpit11, DelegationUpsert, EventDerivation, WaitUpsert } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { purposeOf, type SessionRow } from "./sessions.ts";
import {
  EventMemory,
  eventSessionId,
  eventTime,
  type FactContext,
  FactDeduper,
  type FactEvent,
  type FactSession,
  factsFromEvent,
} from "./shared/activity-facts.ts";
import type { ActivityFact, DelegationState } from "./shared/activity-types.ts";
import { ID_RE } from "./shared/ids.ts";

/** Recherche d'une session inconnue (sessions.ensure) : 5 s au plus (§3.10 point 2). */
export const ENSURE_TIMEOUT_MS = 5_000;
/** Session introuvable : pas de nouvelle recherche pendant 30 s (ses événements sont abandonnés). */
export const ENSURE_RETRY_MS = 30_000;
/** Message utilisateur envoyé par le cockpit : créé au plus 30 s après la ligne chat_turns du proxy… */
export const SENT_MESSAGE_WINDOW_MS = 30_000;
/** … ou au plus 2 s avant (écart d'horloge entre le cockpit et opencode). */
export const SENT_MESSAGE_SKEW_MS = 2_000;
/** Sessions dont les événements attendent sessions.ensure, et événements gardés par session ; au-delà : abandonnés. */
export const PENDING_SESSIONS_MAX = 64;
export const PENDING_EVENTS_MAX = 512;
/** Attentes d'accord expirées par une libération d'instance, au plus, par événement. */
export const DISPOSED_WAITS_MAX = 1_000;
/** Entrées des mémoires de la dérivation (sessions vues, messages vérifiés, demandes vues). */
const MEMORY_MAX = 20_000;

/** Événements dont factsFromEvent peut tirer un fait ; session.updated ne sert qu'à connaître une session. */
const FACT_EVENTS = new Set([
  "session.created",
  "session.status",
  "session.error",
  "session.compacted",
  "todo.updated",
  "message.updated",
  "message.part.updated",
  "permission.asked",
  "permission.replied",
]);

/** Libération d'instance : les demandes en attente disparaissent sans permission.replied (M14). */
const DISPOSAL_EVENTS = new Set(["global.disposed", "server.instance.disposed"]);

const STICKY_PURPOSES = new Set(["classifier", "equipe", "controle"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Map bornée : au-delà de la borne, l'entrée la plus ancienne est oubliée. */
class Bounded<V> {
  readonly #limit: number;
  readonly #map = new Map<string, V>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    if (this.#map.size >= this.#limit) this.#map.delete(this.#map.keys().next().value as string);
    this.#map.set(key, value);
  }
}

export interface ActivityDerivationOptions {
  now?: () => number;
  /** Tests : délai de sessions.ensure (5 s par défaut). */
  ensureTimeoutMs?: number;
}

interface Pending {
  global: OcGlobalEvent;
  receivedAt: number;
}

type DelegationKey = Pick<DelegationUpsert, "rootId" | "parentSessionId" | "callId">;

interface DelegationRow {
  root_id: string;
  parent_session_id: string;
  call_id: string;
  state: DelegationState;
  permission_id: string | null;
}

interface WaitRow {
  permission_id: string;
  session_id: string;
  root_id: string;
  permission: string;
  target: string | null;
}

const waitOf = (row: WaitRow): WaitUpsert => ({
  permissionId: row.permission_id,
  sessionId: row.session_id,
  rootId: row.root_id,
  permission: row.permission,
  target: row.target,
});

/** Dérivation « facts » : synchrone, sans attente réseau ; ses écritures passent par c11.ports.facts. */
export function activityDerivation(c11: Cockpit11, options: ActivityDerivationOptions = {}): EventDerivation {
  const now = options.now ?? Date.now;
  const ensureTimeoutMs = options.ensureTimeoutMs ?? ENSURE_TIMEOUT_MS;
  const memory = new EventMemory(MEMORY_MAX);
  const deduper = new FactDeduper();
  /** Sessions connues par leur événement session.created ou session.updated, avant que la file du processeur les enregistre. */
  const seen = new Bounded<FactSession>(MEMORY_MAX);
  /** Messages utilisateur déjà rapprochés des envois du proxy, et messages reconnus comme envoyés par le cockpit. */
  const checkedMessages = new Bounded<true>(MEMORY_MAX);
  const sentMessages = new Bounded<"message">(MEMORY_MAX);
  const usedTurns = new Bounded<true>(MEMORY_MAX);
  const pending = new Map<string, Pending[]>();
  const failed = new Bounded<number>(1_000);

  // Port lu au moment de l'appel : une surcharge (espion) posée après l'installation reste prise en compte.
  const work = () => c11.ports.facts.work;

  // --- Sessions ----------------------------------------------------------------------------------------------------------------

  const fromRow = (row: SessionRow): FactSession => ({ rootId: row.root_id, parentId: row.parent_id, purpose: row.purpose, instance: row.instance ?? "principale" });

  const session = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const row = c11.sessions.get(id);
    if (row && (row.parent_id === null || c11.sessions.get(row.parent_id) !== undefined)) return fromRow(row);
    const known = seen.get(id);
    if (known) return known;
    if (info?.id !== id) return null;
    const parentId = idOf(info.parentID);
    if (info.parentID !== undefined && info.parentID !== null && info.parentID !== "" && parentId === null) return null;
    const parent = parentId === null ? null : session(parentId);
    if (parentId !== null && parent === null) return null;
    const sticky = parent && STICKY_PURPOSES.has(parent.purpose) ? parent.purpose : null;
    const purpose = sticky ?? purposeOf({ title: typeof info.title === "string" ? info.title : "", metadata: isRecord(info.metadata) ? info.metadata : undefined });
    return { rootId: parent?.rootId ?? id, parentId, purpose, instance: parent?.instance ?? "principale" };
  };

  const rememberSession = (event: FactEvent): void => {
    if (event.type !== "session.created" && event.type !== "session.updated") return;
    const info = isRecord(event.properties?.info) ? event.properties.info : null;
    const id = idOf(info?.id);
    if (!info || id === null) return;
    const found = session(id, info);
    if (found) seen.set(id, found);
  };

  // --- Messages envoyés par le cockpit (cas 1) ----------------------------------------------------------------------------------

  const noteSentMessage = (event: FactEvent): void => {
    if (event.type !== "message.updated") return;
    const info = isRecord(event.properties?.info) ? event.properties.info : null;
    if (info?.role !== "user") return;
    const id = idOf(info.id);
    const sessionId = idOf(info.sessionID);
    const created = isRecord(info.time) ? info.time.created : undefined;
    if (id === null || sessionId === null || typeof created !== "number" || !Number.isSafeInteger(created) || checkedMessages.has(id)) return;
    checkedMessages.set(id, true);
    const turns = c11.db
      .prepare(
        `SELECT id FROM chat_turns WHERE session_id = ? AND kind IN ('message', 'raccourci') AND created_at BETWEEN ? AND ?
         ORDER BY created_at, id LIMIT 16`,
      )
      .all(sessionId, created - SENT_MESSAGE_WINDOW_MS, created + SENT_MESSAGE_SKEW_MS) as Array<{ id: number }>;
    const turn = turns.find((row) => !usedTurns.has(String(row.id)));
    if (!turn) return;
    usedTurns.set(String(turn.id), true);
    sentMessages.set(id, "message");
  };

  const context = (receivedAt: number): FactContext => ({
    receivedAt,
    session,
    messageRole: (id) => memory.messageRole(id),
    promptKind: (id) => sentMessages.get(id) ?? null,
    firstUserMessage: (id) => memory.firstUserMessage(id),
    userMessageParts: (id) => memory.userMessageParts(id),
    unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
  });

  // --- Délégations et attentes d'accord (écrivain unique : ports.facts.work) -----------------------------------------------------
  // Les lignes existantes sont relues dans la base (lecture seule) : un redémarrage du cockpit ne perd pas le lien entre une
  // demande, son appel `task` et sa réponse.

  const delegationByCall = (parentSessionId: string, callId: string): DelegationRow | undefined =>
    c11.db
      .prepare("SELECT root_id, parent_session_id, call_id, state, permission_id FROM delegations WHERE parent_session_id = ? AND call_id = ?")
      .get(parentSessionId, callId) as DelegationRow | undefined;

  const delegationByPermission = (permissionId: string): DelegationRow | undefined =>
    c11.db
      .prepare("SELECT root_id, parent_session_id, call_id, state, permission_id FROM delegations WHERE permission_id = ? ORDER BY id LIMIT 1")
      .get(permissionId) as DelegationRow | undefined;

  const waitById = (permissionId: string): WaitRow | undefined =>
    c11.db.prepare("SELECT permission_id, session_id, root_id, permission, target FROM permission_waits WHERE permission_id = ?").get(permissionId) as
      | WaitRow
      | undefined;

  /** Une écriture refusée (validation, base) n'arrête ni les faits suivants, ni la diffusion, ni la file du processeur. */
  const safely = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      c11.log.warn(`faits d'activité : ${what} non enregistrée`, { error: errorMessage(err) });
    }
  };

  const keyOf = (row: DelegationRow): DelegationKey => ({ rootId: row.root_id, parentSessionId: row.parent_session_id, callId: row.call_id });

  /** permission.asked : attente « attente » ; pour une délégation (`task` avec appel), délégation « attente-accord ». */
  const markAsked = ({ rootId, sessionId, ref, data }: ActivityFact): void => {
    const permission = textOf(data.permission);
    if (ref === null || permission === null) return;
    const agent = permission === "task" ? textOf(data.agent) : null;
    work().markWait({ permissionId: ref, sessionId, rootId, permission, target: agent }, "attente", null);
    const callId = idOf(data.callId);
    if (permission !== "task" || callId === null) return;
    work().markDelegation({ rootId, parentSessionId: sessionId, callId, agent: agent ?? "", permissionId: ref }, "attente-accord", null);
  };

  /** permission.replied : « once » ou « reject » (auteur inconnu du flux : le service qui a répondu le complète) ; « always » : rien. */
  const markReplied = ({ ref, data }: ActivityFact): void => {
    const reply = data.reponse;
    if (ref === null || (reply !== "once" && reply !== "reject")) return;
    const wait = waitById(ref);
    if (wait) work().markWait(waitOf(wait), reply, null);
    const delegation = delegationByPermission(ref);
    if (delegation) work().markDelegation({ ...keyOf(delegation), agent: "", permissionId: ref }, reply === "once" ? "autorisee" : "refusee", null);
  };

  /** Partie `task` : en préparation, puis envoyée à son enfant (« travaille »). */
  const markInstruction = ({ rootId, sessionId, ref, data }: ActivityFact): void => {
    if (ref === null) return;
    const key: DelegationKey = { rootId, parentSessionId: sessionId, callId: ref };
    if (data.etat === "prepare") {
      work().markDelegation({ ...key, agent: "" }, "prepare", null);
      return;
    }
    if (data.etat !== "envoyee") return;
    const source = data.source === "raccourci" ? "raccourci" : "ia";
    const upsert: DelegationUpsert = {
      ...key,
      agent: textOf(data.agent) ?? "",
      childSessionId: idOf(data.enfant),
      command: textOf(data.commande),
      source,
      ...(source === "raccourci" ? { sansConfirmation: true } : {}),
    };
    // Un enfant lancé prouve l'accord : une demande restée « attente-accord » (réponse manquée) passe par « autorisee ».
    if (delegationByCall(sessionId, ref)?.state === "attente-accord") work().markDelegation(upsert, "autorisee", null);
    work().markDelegation(upsert, "travaille", null);
  };

  /** Partie `task` close : rendue, en échec ou interrompue ; sans enfant (hors rendu), jamais démarrée. */
  const markResult = ({ rootId, sessionId, ref, data }: ActivityFact): void => {
    if (ref === null) return;
    const enfant = idOf(data.enfant);
    // « echec » n'est pas un état de délégation : l'appel est fini (terminee) ; le détail reste dans le fait resultat.
    let next: DelegationState = "terminee";
    if (data.etat !== "rendu" && enfant === null) next = "jamais-demarree";
    else if (data.etat === "interrompu") next = "arretee";
    const upsert: DelegationUpsert = { rootId, parentSessionId: sessionId, callId: ref, agent: "", childSessionId: enfant };
    const row = delegationByCall(sessionId, ref);
    if (row && enfant !== null && next !== "jamais-demarree") {
      // Consigne envoyée manquée (coupure du flux) : l'enfant a travaillé, les étapes observables sont posées dans l'ordre.
      if (row.state === "attente-accord") work().markDelegation(upsert, "autorisee", null);
      if (row.state === "prepare" || row.state === "attente-accord" || row.state === "autorisee") work().markDelegation(upsert, "travaille", null);
    }
    work().markDelegation(upsert, next, null);
  };

  /** Instance libérée : ses demandes en attente ont disparu (M14) ; attente « expiree », délégation qui l'attendait « expiree ». */
  const expireDisposed = (directory: string | null, at: number): void => {
    const rows = (
      directory === null
        ? c11.db
            .prepare("SELECT permission_id, session_id, root_id, permission, target FROM permission_waits WHERE reply IS NULL ORDER BY asked_at LIMIT ?")
            .all(DISPOSED_WAITS_MAX)
        : c11.db
            .prepare(
              `SELECT w.permission_id, w.session_id, w.root_id, w.permission, w.target FROM permission_waits w
               JOIN sessions s ON s.id = w.session_id WHERE w.reply IS NULL AND s.directory = ? ORDER BY w.asked_at LIMIT ?`,
            )
            .all(directory, DISPOSED_WAITS_MAX)
    ) as unknown as WaitRow[];
    const facts: ActivityFact[] = [];
    for (const row of rows) {
      safely("attente expirée", () => {
        if (!work().markWait(waitOf(row), "expiree", null)) return;
        // Fait « reponse » : l'attente dessinée prend fin (P12), pour le direct comme pour « Revoir ».
        facts.push({ rootId: row.root_id, sessionId: row.session_id, kind: "reponse", ref: row.permission_id, data: { reponse: "expiree" }, at });
        const delegation = delegationByPermission(row.permission_id);
        if (delegation?.state === "attente-accord") {
          work().markDelegation({ ...keyOf(delegation), agent: "", permissionId: row.permission_id }, "expiree", null);
        }
      });
    }
    if (facts.length > 0) safely("expiration", () => c11.ports.facts.append(facts));
  };

  const markWork = (fact: ActivityFact): void => {
    switch (fact.kind) {
      case "attente":
        return safely("attente d'accord", () => markAsked(fact));
      case "reponse":
        return safely("réponse", () => markReplied(fact));
      case "consigne":
        return safely("délégation", () => markInstruction(fact));
      case "resultat":
        return safely("fin de délégation", () => markResult(fact));
      default:
        return;
    }
  };

  // --- Dérivation ----------------------------------------------------------------------------------------------------------------

  const derive = (global: OcGlobalEvent, receivedAt: number): void => {
    const event = global.payload as FactEvent;
    if (DISPOSAL_EVENTS.has(event.type)) {
      const directory = event.type === "server.instance.disposed" ? textOf(event.properties?.directory) : null;
      if (event.type === "global.disposed" || directory !== null) expireDisposed(directory, eventTime(event.id, receivedAt));
      return;
    }
    memory.observe(event);
    rememberSession(event);
    noteSentMessage(event);
    const fresh = factsFromEvent(event, context(receivedAt)).filter((fact) => deduper.accept(fact));
    if (fresh.length === 0) return;
    c11.ports.facts.append(fresh);
    for (const fact of fresh) markWork(fact);
  };

  const deriveSafely = (entry: Pending): void => {
    try {
      derive(entry.global, entry.receivedAt);
    } catch (err) {
      c11.log.warn("faits d'activité : événement non dérivé", { type: entry.global.payload.type, error: errorMessage(err) });
    }
  };

  const ensureThenDrain = async (sessionId: string, directory: string | undefined): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ensureTimeoutMs);
      timer.unref();
    });
    let found = false;
    try {
      found = await Promise.race([
        c11.sessions.ensure(sessionId, directory).then(
          (row) => row !== undefined,
          () => false,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const events = pending.get(sessionId) ?? [];
    pending.delete(sessionId);
    if (!found || session(sessionId) === null) {
      failed.set(sessionId, now() + ENSURE_RETRY_MS);
      c11.log.warn("faits d'activité : session inconnue, événements non enregistrés", { sessionId, events: events.length });
      return;
    }
    for (const entry of events) deriveSafely(entry);
  };

  const defer = (sessionId: string, entry: Pending): void => {
    const retryAt = failed.get(sessionId);
    if (retryAt !== undefined && retryAt > entry.receivedAt) return;
    if (pending.size >= PENDING_SESSIONS_MAX) {
      failed.set(sessionId, entry.receivedAt + ENSURE_RETRY_MS);
      c11.log.warn("faits d'activité : trop de sessions inconnues, événements non enregistrés", { sessionId });
      return;
    }
    pending.set(sessionId, [entry]);
    // Hors de l'appel : aucune requête ne part pendant onEvent, ni dans la file du processeur.
    queueMicrotask(() => {
      ensureThenDrain(sessionId, entry.global.directory).catch((err: unknown) =>
        c11.log.warn("faits d'activité : recherche de session en échec", { sessionId, error: errorMessage(err) }),
      );
    });
  };

  return {
    name: "facts",
    onEvent(global: OcGlobalEvent): void {
      const event = global.payload as FactEvent | undefined;
      if (!event || typeof event.type !== "string") return;
      if (event.type === "session.updated") {
        rememberSession(event);
        return;
      }
      if (!FACT_EVENTS.has(event.type) && !DISPOSAL_EVENTS.has(event.type)) return;
      const entry = { global, receivedAt: now() };
      const sessionId = eventSessionId(event);
      const waiting = sessionId === null ? undefined : pending.get(sessionId);
      if (waiting) {
        if (waiting.length < PENDING_EVENTS_MAX) waiting.push(entry);
        return;
      }
      const info = event.type === "session.created" && isRecord(event.properties?.info) ? event.properties.info : undefined;
      if (sessionId !== null && session(sessionId, info) === null) {
        defer(sessionId, entry);
        return;
      }
      derive(global, entry.receivedAt);
    },
  };
}
