// Propriétaire : L1e.
// Surveillance des délégations lancées sans demande (spécification §3.14 « allow (Studio) », §3.8, §3.9 SSE, §3.6
// budget.delegation, §4.8.1 ; plan d'exécution, fiche L1e ; mesure MX1 §7). Une délégation lancée sans demande d'autorisation
// (agent `task: allow` du Studio, raccourci `subtask`, seul marqué DelegationView.sansConfirmation) n'est vue qu'après coup : ses
// plafonds par demande sont surveillés dans les deux modes, et leur dépassement arrête tout l'arbre (stopTree, cause
// « plafond-delegations »).
// - Dérivation synchrone, sans attente réseau (mémoire et lectures SQLite seules) :
//   · session.created avec parentID dans une conversation suivie (racine « chat » de l'instance principale, comme stoppableRoot) :
//     l'enfant est compté, sauf s'il n'est pas d'usage « chat » (contrôle de sécurité, étape d'équipe, classement, héritage ou
//     usage forcé par le serveur compris) ou s'il suit une demande « task » accordée de son parent : « once » inscrit au registre
//     emitted du portillon (avant l'envoi) ou vu dans permission.replied. Il est alors rattaché, par supposition, à la plus
//     ancienne demande accordée du parent restée sans enfant (capture p7 : sous-agent d'un « once » tardif, sans partie `task`) ;
//   · partie `task` portant son enfant (metadata.sessionId) : l'appel fait foi. Avec une demande (permission.asked de ce callID,
//     ou ligne delegations après un redémarrage du cockpit), jamais comptée ; sans demande, comptée une fois par appel (une reprise
//     par task_id est un nouvel appel). Une délégation déjà comptée par session.created change seulement de clé. Supposition
//     démentie (course entre deux appels du même parent) : l'enfant qui ne portait pas la demande la rend au frère qui
//     l'attendait, et celui qu'on avait supposé pour une demande dont la partie nomme un autre enfant est déplacé (autre demande
//     accordée, sinon compté) ; le registre ne distinguant pas « once » de « reject », un refus déplace aussi l'enfant supposé ;
//   · libération d'instance (server.instance.disposed, global.disposed ; mesure M14 : demande disparue sans permission.replied) :
//     demande « task » encore en attente et sans enfant → delegation.expiree {rootId, permissionId}, une fois ; demande accordée
//     restée sans enfant → close (son appel est arrêté avant la libération, mesure MX1) : elle ne couvre plus aucun enfant.
// - Demande : du dernier envoi du proxy (ligne chat_turns de la racine, écrite avant le relais) à l'envoi suivant ; seul un envoi
//   remet les compteurs à zéro, jamais un message produit par l'IA. Sans envoi connu : fenêtre ouverte à la première délégation vue.
// - Plafonds (budget.delegation, lus à chaque décision) : plus de maxPerRequest délégations comptées → « nombre » ; coût de la
//   demande (ledger.spentSinceSansEtapes : racine, enfants, contrôles ; sans les étapes d'une équipe, qui ont leur propre plafond
//   d'arrêt) non nul et au moins égal à maxUsdPerRequest → « cout ».
//   Le coût n'est surveillé que pour une demande qui compte au moins une délégation lancée sans demande : dès qu'elle est
//   comptée, puis à chaque usage.updated (une étape close = un message : mesure MX1 §7). Dépassement annoncé : l'appel en vol de
//   chaque session occupée ; l'appel du titre n'est porté par aucun message (MX1 §5).
// - Dépassement : delegation.plafond {rootId, kind} (une fois par demande et par nature), puis stopTree hors de l'appel
//   (microtâche) ; stopTree écrit le fait statut {cause: plafond, motif: plafond-delegations} et conversation.arretee. Un nouvel
//   arrêt dans la même demande exige une nouvelle délégation comptée : un appel en vol qui se termine n'en relance pas.
// P6 : aucune écriture de configuration, aucun redémarrage. Aucune écriture en base : delegations et permission_waits restent au
// seul écrivain de L4b (ports.facts.work) ; ce module ne fait que les lire.
// neutralDelegationWatch reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { DatabaseSync } from "node:sqlite";
import { emitCockpit } from "./cockpit-events.ts";
import type { Cockpit11Module, DelegationWatchPort, EventDerivation, PermissionGate, UsageUpdatedData } from "./contracts-11.ts";
import type { EventHub } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { purposeOf, type SessionTracker } from "./sessions.ts";
import type { SettingsStore } from "./settings.ts";
import { ID_RE } from "./shared/ids.ts";

export function neutralDelegationWatch(): DelegationWatchPort {
  return {};
}

/** Nature du plafond atteint (delegation.plafond). */
export type DelegationCapKind = "nombre" | "cout";

/** Conversations suivies en mémoire (une demande en cours chacune) ; au-delà, la plus ancienne est oubliée. */
export const WATCH_ROOTS_MAX = 1_000;
/** Sessions (parenté) et enfants gardés en mémoire. */
export const WATCH_SESSIONS_MAX = 20_000;
/** Demandes d'autorisation « task » gardées en mémoire. */
export const WATCH_REQUESTS_MAX = 5_000;
/** Délégations comptées gardées par demande : bien au-delà de tout plafond permis (50), l'arrêt est déjà parti. */
export const WATCH_COUNTED_MAX = 1_000;
/** Demandes déclarées expirées au plus, par libération d'instance. */
export const EXPIRED_PER_EVENT_MAX = 1_000;
/** Longueur maximale d'un callID (même borne que le portillon). */
const CALL_ID_MAX_LENGTH = 512;

/** Usages dont une session enfant hérite (sessions.ts) : jamais du travail délégué par l'IA. */
const STICKY_PURPOSES = new Set(["classifier", "equipe", "controle"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const callIdOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= CALL_ID_MAX_LENGTH ? value : null);
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
    if (this.#map.size >= this.#limit) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }

  values(): IterableIterator<V> {
    return this.#map.values();
  }
}

/** Parenté d'une session : racine, parent et usage (sessions.purpose, héritage compris). */
interface Lineage {
  rootId: string;
  parentId: string | null;
  purpose: string;
}

/** Demande d'autorisation « task » d'une conversation suivie. */
interface AskedTask {
  requestId: string;
  sessionId: string;
  rootId: string;
  /** « parent|callID » de l'appel qui l'a posée ; null si inconnu. */
  callKey: string | null;
  /** Dossier de l'instance qui la porte (libération d'instance). */
  directory: string | null;
  /** « close » : accordée, mais son instance a été libérée avant tout enfant ; elle n'en lancera plus. */
  state: "attente" | "accordee" | "refusee" | "expiree" | "close";
  /** Enfant lancé après l'accord ; null tant qu'aucun. */
  child: string | null;
}

/** Enfant vu dans une conversation suivie. */
interface ChildEntry {
  id: string;
  rootId: string;
  parentId: string;
  /** Clé de comptage dans sa demande ; null : lancé après une demande accordée, jamais compté. */
  counted: { request: string; key: string } | null;
  /** Demande accordée à laquelle session.created l'a rattaché. */
  requestId: string | null;
  /** Appel `task` qui l'a lancé, connu par sa partie ; null tant qu'aucune partie ne l'a nommé. */
  callKey: string | null;
}

/** Demande en cours d'une conversation : délégations lancées sans demande comptées, arrêts déjà lancés. */
interface RequestWatch {
  rootId: string;
  /** « envoi:<chat_turns.id> », ou « sans-envoi ». */
  request: string;
  /** Début de la demande (ms) : borne de ledger.spentSinceSansEtapes. */
  since: number;
  counted: Set<string>;
  notified: Set<DelegationCapKind>;
  stopping: boolean;
  stops: number;
  /** Délégations comptées au dernier arrêt lancé. */
  countAtStop: number;
}

export interface DelegationWatchDeps {
  /** Lecture seule : chat_turns (début de la demande), delegations et permission_waits (après un redémarrage du cockpit). */
  db: DatabaseSync;
  sessions: Pick<SessionTracker, "get">;
  settings: Pick<SettingsStore, "get">;
  ledger: Pick<Ledger, "spentSinceSansEtapes">;
  gate: Pick<PermissionGate, "emitted">;
  hub: Pick<EventHub, "cockpit">;
  log: Logger;
  /** Arrêt de tout l'arbre (ports.stopTree.run(rootId, « plafond-delegations »), lu au moment de l'appel). */
  stop(rootId: string): Promise<unknown>;
}

export interface DelegationWatchOptions {
  now?: () => number;
  /** Lance l'arrêt hors de l'appel de la dérivation (défaut : microtâche). */
  defer?: (fn: () => void) => void;
}

/** État de la demande en cours d'une conversation (tests). */
export interface DelegationWatchSnapshot {
  request: string;
  since: number;
  delegations: number;
  stops: number;
  notified: DelegationCapKind[];
}

export interface DelegationWatch extends EventDerivation {
  /** Abonnement usage.updated : coût de la demande (sans rootId, après un rattrapage : toutes les demandes suivies). */
  onUsage(data: UsageUpdatedData): void;
  snapshot(rootId: string): DelegationWatchSnapshot | null;
}

export function createDelegationWatch(deps: DelegationWatchDeps, options: DelegationWatchOptions = {}): DelegationWatch {
  const { db, sessions, log } = deps;
  const now = options.now ?? Date.now;
  const defer = options.defer ?? queueMicrotask;
  const lineages = new Bounded<Lineage>(WATCH_SESSIONS_MAX);
  const children = new Bounded<ChildEntry>(WATCH_SESSIONS_MAX);
  const asked = new Bounded<AskedTask>(WATCH_REQUESTS_MAX);
  const askedByCall = new Bounded<string>(WATCH_REQUESTS_MAX);
  /** Appel `task` déjà vu avec son enfant (« parent|callID » → enfant) : mises à jour répétées d'une même partie. */
  const calls = new Bounded<string>(WATCH_SESSIONS_MAX);
  const watches = new Bounded<RequestWatch>(WATCH_ROOTS_MAX);

  // --- Conversations suivies ---------------------------------------------------------------------------------------------------

  const lineageOf = (id: string): Lineage | null => {
    const known = lineages.get(id);
    if (known) return known;
    const row = sessions.get(id);
    return row ? { rootId: row.root_id, parentId: row.parent_id, purpose: row.purpose } : null;
  };

  /** Racine surveillée : conversation « chat » sans parent, servie par l'instance principale. */
  const watchedRoot = (rootId: string): boolean => {
    const row = sessions.get(rootId);
    return row !== undefined && row.parent_id === null && row.root_id === row.id && row.purpose === "chat" && row.instance === "principale";
  };

  /** Session d'usage « chat » d'une conversation surveillée ; null sinon. */
  const chatSession = (id: string): Lineage | null => {
    const lineage = lineageOf(id);
    return lineage && lineage.purpose === "chat" && watchedRoot(lineage.rootId) ? lineage : null;
  };

  // --- Demande en cours et plafonds ----------------------------------------------------------------------------------------------

  const lastTurn = (rootId: string): { id: number; created_at: number } | undefined =>
    db.prepare("SELECT id, created_at FROM chat_turns WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(rootId) as
      | { id: number; created_at: number }
      | undefined;

  /** Demande en cours de la racine ; une nouvelle ligne chat_turns en ouvre une autre. `create` faux : null si aucune suivie. */
  const watchOf = (rootId: string, create: boolean): RequestWatch | null => {
    const turn = lastTurn(rootId);
    const request = turn ? `envoi:${turn.id}` : "sans-envoi";
    const current = watches.get(rootId);
    if (current && current.request === request) return current;
    if (!create) return null;
    const watch: RequestWatch = {
      rootId,
      request,
      since: turn ? turn.created_at : now(),
      counted: new Set(),
      notified: new Set(),
      stopping: false,
      stops: 0,
      countAtStop: 0,
    };
    watches.set(rootId, watch);
    return watch;
  };

  const spentOf = (watch: RequestWatch): number | null => {
    try {
      // <gf3:plafond-delegations> début : une demande qui a compté une délégation reste ouverte jusqu'à l'envoi suivant, et un
      // lancement d'équipe n'écrit aucune ligne chat_turns : le coût des étapes (sessions « equipe ») n'appartient pas à cette
      // demande. Il relève du plafond d'arrêt de l'équipe (team-run-guards.ts) ; le compter ici arrêtait l'équipe à tort, à l'état
      // « plafond ». Même règle que la dépense d'une demande autonome (<gf3:plafond-autonomie>). Relecture de F2, vague 0.
      return deps.ledger.spentSinceSansEtapes(watch.rootId, watch.since);
      // </gf3:plafond-delegations> fin
    } catch (err) {
      log.warn("délégations lancées sans demande : coût de la demande illisible", { rootId: watch.rootId, error: errorMessage(err) });
      return null;
    }
  };

  const trigger = (watch: RequestWatch, kind: DelegationCapKind, delegations: number): void => {
    watch.stopping = true;
    watch.stops++;
    watch.countAtStop = delegations;
    if (!watch.notified.has(kind)) {
      watch.notified.add(kind);
      emitCockpit(deps.hub, "delegation.plafond", { rootId: watch.rootId, kind });
    }
    log.warn("délégations lancées sans demande : plafond atteint, arrêt de la conversation", { rootId: watch.rootId, kind, delegations });
    // Hors de l'appel : aucune requête ne part pendant onEvent ni dans l'abonné du hub.
    defer(() => {
      let running: Promise<unknown>;
      try {
        running = deps.stop(watch.rootId);
      } catch (err) {
        running = Promise.reject(err);
      }
      running
        .catch((err: unknown) => log.warn("délégations lancées sans demande : arrêt en échec", { rootId: watch.rootId, kind, error: errorMessage(err) }))
        .finally(() => {
          watch.stopping = false;
        });
    });
  };

  const evaluate = (watch: RequestWatch): void => {
    const delegations = watch.counted.size;
    if (delegations === 0 || watch.stopping) return;
    // Déjà arrêtée pour ces délégations : un appel en vol qui se termine ne relance pas l'arrêt.
    if (watch.stops > 0 && delegations <= watch.countAtStop) return;
    const caps = deps.settings.get().budget.delegation;
    let kind: DelegationCapKind | null = null;
    if (delegations > caps.maxPerRequest) kind = "nombre";
    else {
      const spent = spentOf(watch);
      if (spent !== null && spent > 0 && spent >= caps.maxUsdPerRequest) kind = "cout";
    }
    if (kind !== null) trigger(watch, kind, delegations);
  };

  const count = (rootId: string, key: string): ChildEntry["counted"] => {
    const watch = watchOf(rootId, true) as RequestWatch;
    if (!watch.counted.has(key) && watch.counted.size < WATCH_COUNTED_MAX) {
      watch.counted.add(key);
      evaluate(watch);
    }
    return { request: watch.request, key };
  };

  const uncount = (rootId: string, counted: NonNullable<ChildEntry["counted"]>): void => {
    const watch = watches.get(rootId);
    if (watch?.request === counted.request) watch.counted.delete(counted.key);
  };

  /** Même délégation, nommée par son appel : aucun nouveau compte. */
  const rekey = (rootId: string, counted: NonNullable<ChildEntry["counted"]>, key: string): ChildEntry["counted"] => {
    const watch = watches.get(rootId);
    if (watch?.request === counted.request && watch.counted.delete(counted.key)) watch.counted.add(key);
    return { request: counted.request, key };
  };

  // --- Demandes « task » et enfants ---------------------------------------------------------------------------------------------

  /** Accordée : « once » vu dans le flux, ou inscrit au registre du portillon avant l'envoi (réponse pas encore publiée). */
  const granted = (entry: AskedTask): boolean => entry.state === "accordee" || (entry.state === "attente" && deps.gate.emitted.has(entry.requestId));

  /** Plus ancienne demande accordée du parent restée sans enfant. */
  const grantedRequestOf = (parentId: string): AskedTask | null => {
    for (const entry of asked.values()) if (entry.sessionId === parentId && entry.child === null && granted(entry)) return entry;
    return null;
  };

  const track = (entry: AskedTask): void => {
    asked.set(entry.requestId, entry);
    if (entry.callKey !== null) askedByCall.set(entry.callKey, entry.requestId);
  };

  /** Après un redémarrage du cockpit : demande « task » lue dans permission_waits (écrite par L4b à sa création). */
  const askedFromTables = (requestId: string): AskedTask | undefined => {
    try {
      const wait = db.prepare("SELECT session_id FROM permission_waits WHERE permission_id = ? AND permission = 'task'").get(requestId) as
        | { session_id: string }
        | undefined;
      const lineage = wait ? chatSession(wait.session_id) : null;
      if (!wait || !lineage) return undefined;
      const delegation = db.prepare("SELECT call_id FROM delegations WHERE permission_id = ? ORDER BY id LIMIT 1").get(requestId) as
        | { call_id: string }
        | undefined;
      const entry: AskedTask = {
        requestId,
        sessionId: wait.session_id,
        rootId: lineage.rootId,
        callKey: delegation ? `${wait.session_id}|${delegation.call_id}` : null,
        directory: sessions.get(wait.session_id)?.directory || null,
        state: "attente",
        child: null,
      };
      track(entry);
      return entry;
    } catch (err) {
      log.warn("délégations lancées sans demande : demande d'autorisation illisible", { requestId, error: errorMessage(err) });
      return undefined;
    }
  };

  /** Demande posée par un appel `task` : mémoire du flux, sinon ligne delegations (redémarrage du cockpit). */
  const requestOfCall = (sessionId: string, callId: string): string | null => {
    const known = askedByCall.get(`${sessionId}|${callId}`);
    if (known !== undefined) return known;
    try {
      const row = db
        .prepare("SELECT permission_id FROM delegations WHERE parent_session_id = ? AND call_id = ? AND permission_id IS NOT NULL LIMIT 1")
        .get(sessionId, callId) as { permission_id: string } | undefined;
      return row?.permission_id ?? null;
    } catch (err) {
      log.warn("délégations lancées sans demande : délégation illisible", { sessionId, error: errorMessage(err) });
      return null;
    }
  };

  /**
   * Enfant rattaché par supposition (session.created, appel encore inconnu) à une demande qui ne le porte pas : la partie de
   * l'appel accordé en nomme un autre, ou la demande a été refusée. Il prend une autre demande accordée du parent restée sans
   * enfant, sinon il est compté. Un enfant nommé par sa partie n'est jamais déplacé.
   */
  const displace = (childId: string, requestId: string): void => {
    const entry = children.get(childId);
    if (!entry || entry.callKey !== null || entry.requestId !== requestId) return;
    const other = grantedRequestOf(entry.parentId);
    if (other) {
      other.child = childId;
      children.set(childId, { ...entry, counted: null, requestId: other.requestId });
      return;
    }
    children.set(childId, { ...entry, requestId: null, counted: count(entry.rootId, `enfant:${childId}`) });
  };

  /**
   * Demande accordée rendue par un enfant qui ne la portait pas : un frère compté d'avance par session.created (appel encore
   * inconnu) la reçoit et sort du compte, avant que l'appel sans demande ne soit compté (aucun dépassement fictif).
   */
  const release = (requestId: string | null, child: string): void => {
    const request = requestId === null ? undefined : asked.get(requestId);
    if (!request || request.child !== child) return;
    request.child = null;
    // Parcours arrêté dès la première écriture : la map n'est jamais modifiée pendant qu'on la parcourt.
    for (const sibling of children.values()) {
      if (sibling.id === child || sibling.parentId !== request.sessionId || sibling.callKey !== null || sibling.counted === null) continue;
      uncount(sibling.rootId, sibling.counted);
      children.set(sibling.id, { ...sibling, counted: null, requestId: request.requestId });
      request.child = sibling.id;
      return;
    }
  };

  const onSessionCreated = (info: Record<string, unknown>): void => {
    const id = idOf(info.id);
    if (id === null) return;
    const rawParent = info.parentID;
    const parentId = idOf(rawParent);
    if (parentId === null && rawParent !== undefined && rawParent !== null && rawParent !== "") return;
    // Titre d'un enfant écrit par l'IA (description du task) : jamais lu comme l'usage d'une session du cockpit (purposeOf).
    const own = purposeOf({ title: typeof info.title === "string" ? info.title : "", metadata: isRecord(info.metadata) ? info.metadata : undefined }, parentId);
    if (parentId === null) {
      lineages.set(id, { rootId: id, parentId: null, purpose: own });
      return;
    }
    const parent = lineageOf(parentId);
    if (!parent) return;
    // Usage hérité du parent, ou déjà enregistré par le serveur (création forcée d'un contrôle de sécurité, L11b) : il l'emporte.
    const sticky = [parent.purpose, sessions.get(id)?.purpose].find((p) => p !== undefined && STICKY_PURPOSES.has(p));
    const purpose = sticky ?? own;
    lineages.set(id, { rootId: parent.rootId, parentId, purpose });
    // Contrôle de sécurité, étape d'équipe, classement : jamais une délégation de l'IA.
    if (purpose !== "chat" || parent.purpose !== "chat" || !watchedRoot(parent.rootId) || children.has(id)) return;
    const request = grantedRequestOf(parentId);
    if (request) {
      request.child = id;
      children.set(id, { id, rootId: parent.rootId, parentId, counted: null, requestId: request.requestId, callKey: null });
      return;
    }
    children.set(id, { id, rootId: parent.rootId, parentId, counted: count(parent.rootId, `enfant:${id}`), requestId: null, callKey: null });
  };

  const onTaskPart = (part: Record<string, unknown>, eventSessionId: string | null): void => {
    if (part.type !== "tool" || part.tool !== "task") return;
    const sessionId = idOf(part.sessionID) ?? eventSessionId;
    const callId = callIdOf(part.callID);
    const state = isRecord(part.state) ? part.state : null;
    const metadata = isRecord(state?.metadata) ? state.metadata : null;
    const child = idOf(metadata?.sessionId);
    // Aucun enfant nommé : rien n'est encore lancé (en préparation, en attente d'accord, refusé).
    if (sessionId === null || callId === null || child === null || child === sessionId) return;
    const callKey = `${sessionId}|${callId}`;
    if (calls.get(callKey) === child) return;
    const parent = chatSession(sessionId);
    if (!parent) return;
    calls.set(callKey, child);
    const requestId = requestOfCall(sessionId, callId);
    const entry = children.get(child);
    if (requestId !== null) {
      // Lancée après une demande : jamais comptée. Un compte d'avance (session.created) est retiré ; un rattachement à une autre
      // demande est rendu ; l'enfant que session.created avait supposé pour cette demande est déplacé, après le retrait (le compte
      // ne dépasse jamais le vrai nombre).
      const request = asked.get(requestId);
      const supposed = request && request.child !== child ? request.child : null;
      if (request) request.child = child;
      if (!entry) {
        children.set(child, { id: child, rootId: parent.rootId, parentId: sessionId, counted: null, requestId, callKey });
      } else if (entry.callKey === null) {
        if (entry.counted) uncount(entry.rootId, entry.counted);
        if (entry.requestId !== null && entry.requestId !== requestId) release(entry.requestId, child);
        children.set(child, { ...entry, counted: null, requestId, callKey });
      }
      if (supposed !== null) displace(supposed, requestId);
      return;
    }
    const key = `appel:${callKey}`;
    if (entry && entry.callKey === null) {
      if (entry.counted) {
        children.set(child, { ...entry, counted: rekey(entry.rootId, entry.counted, key), callKey });
        return;
      }
      // Rattachée à tort à une demande accordée du même parent : la demande revient à son enfant, l'appel est compté.
      release(entry.requestId, child);
      children.set(child, { ...entry, counted: count(entry.rootId, key), requestId: null, callKey });
      return;
    }
    // Enfant inconnu (session.created manqué) ou repris par task_id sous un nouvel appel : délégation comptée par son appel.
    const counted = count(parent.rootId, key);
    if (!entry) children.set(child, { id: child, rootId: parent.rootId, parentId: sessionId, counted, requestId: null, callKey });
  };

  const onAsked = (p: Record<string, unknown>, directory: string | null): void => {
    if (p.permission !== "task") return;
    const requestId = idOf(p.id);
    const sessionId = idOf(p.sessionID);
    if (requestId === null || sessionId === null || asked.has(requestId)) return;
    const lineage = chatSession(sessionId);
    if (!lineage) return;
    const tool = isRecord(p.tool) ? p.tool : null;
    const callId = callIdOf(tool?.callID);
    track({
      requestId,
      sessionId,
      rootId: lineage.rootId,
      callKey: callId === null ? null : `${sessionId}|${callId}`,
      directory: directory ?? (sessions.get(sessionId)?.directory || null),
      state: "attente",
      child: null,
    });
  };

  const onReplied = (p: Record<string, unknown>): void => {
    const requestId = idOf(p.requestID);
    const accepted = p.reply === "once" || p.reply === "always";
    if (requestId === null || (!accepted && p.reply !== "reject")) return;
    const entry = asked.get(requestId) ?? (accepted ? askedFromTables(requestId) : undefined);
    if (!entry || entry.state !== "attente") return;
    entry.state = accepted ? "accordee" : "refusee";
    // Le registre ne dit pas « once » ou « reject » : un enfant rattaché pendant que le refus était inscrit ne vient pas d'elle.
    if (!accepted && entry.child !== null) {
      const supposed = entry.child;
      entry.child = null;
      displace(supposed, entry.requestId);
    }
  };

  /**
   * Libération d'instance (M14) : ses demandes « task » encore en attente ont disparu sans réponse (delegation.expiree) ; ses
   * demandes accordées restées sans enfant ne lanceront plus rien (appel arrêté avant la libération, mesure MX1) et ne couvrent
   * plus aucun enfant. Une demande en attente qui a déjà lancé son enfant (réponse inscrite au registre) n'expire pas. `directory`
   * null : toutes.
   */
  const onDisposed = (directory: string | null): void => {
    let expired = 0;
    for (const entry of asked.values()) {
      if (directory !== null && entry.directory !== directory) continue;
      if (entry.state === "accordee" && entry.child === null) entry.state = "close";
      if (entry.state !== "attente") continue;
      if (entry.child !== null) {
        entry.state = "accordee";
        continue;
      }
      entry.state = "expiree";
      emitCockpit(deps.hub, "delegation.expiree", { rootId: entry.rootId, permissionId: entry.requestId });
      if (++expired >= EXPIRED_PER_EVENT_MAX) return;
    }
  };

  return {
    name: "delegationWatch",
    onEvent(global: OcGlobalEvent): void {
      const event = isRecord(global) ? global.payload : null;
      if (!isRecord(event) || typeof event.type !== "string") return;
      if (event.type === "global.disposed") return onDisposed(null);
      const p = isRecord(event.properties) ? event.properties : null;
      if (!p) return;
      switch (event.type) {
        case "session.created":
          if (isRecord(p.info)) onSessionCreated(p.info);
          return;
        case "message.part.updated":
          if (isRecord(p.part)) onTaskPart(p.part, idOf(p.sessionID));
          return;
        case "permission.asked":
          return onAsked(p, textOf(global.directory));
        case "permission.replied":
          return onReplied(p);
        case "server.instance.disposed": {
          const directory = textOf(p.directory);
          if (directory !== null) onDisposed(directory);
          return;
        }
        default:
          return;
      }
    },
    onUsage(data: UsageUpdatedData): void {
      const rootId = idOf(data.rootId);
      const targets = rootId === null ? [...watches.values()] : [watches.get(rootId)];
      for (const watch of targets) {
        if (!watch) continue;
        // Nouvel envoi depuis : les délégations comptées appartiennent à la demande précédente.
        const current = watchOf(watch.rootId, false);
        if (current) evaluate(current);
      }
    },
    snapshot(rootId: string): DelegationWatchSnapshot | null {
      const watch = watches.get(rootId);
      return watch
        ? { request: watch.request, since: watch.since, delegations: watch.counted.size, stops: watch.stops, notified: [...watch.notified] }
        : null;
    },
  };
}

export const delegationWatchModule: Cockpit11Module = {
  name: "delegationWatch",
  install(reg, c11) {
    const watch = createDelegationWatch({
      db: c11.db,
      sessions: c11.sessions,
      settings: c11.settings,
      ledger: c11.ledger,
      gate: c11.gate,
      hub: c11.hub,
      log: c11.log,
      // Port lu au moment de l'arrêt : une surcharge posée après l'installation reste prise en compte.
      stop: (rootId) => c11.ports.stopTree.run(rootId, "plafond-delegations"),
    });
    reg.derivation(watch);
    reg.hub("usage.updated", (data) => watch.onUsage(data));
  },
};
