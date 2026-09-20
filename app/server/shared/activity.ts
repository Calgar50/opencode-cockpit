// Réducteur d'activité « Qui travaille ? » (spécification §3.7, §3.10 point 4, §5.1, A9-5 ; plan d'exécution, fiche L4c) : un seul
// modèle, les faits `activity_facts` (L4a), appliqués par la même fonction en direct (`activite.fait`) et en différé (GET …/facts) :
// « différé = direct » (P12). Une conversation sans faits (avant la 1.1) est reconstruite en faits LOCAUX, jamais écrits ni envoyés,
// depuis ses messages (replayMessages, GET /session/:id/message) ou depuis le registre (fromLedger, GET …/activity).
// Fournit : emptyActivity, applyEvent, replayFacts, replayMessages, fromLedger, liveRows, timeline, announcements (au plus une toutes
// les 2 s), totals, activityStatus ; bornes : 3 niveaux sous la racine et 50 sessions, au-delà « Déroulé partiel » ; doublons de
// faits écartés par identité, messages par (id, time.completed) ; deltas jamais lus (le détail vient des faits).
// Rend des CODES (états, causes, genres de barre, annonces) : les phrases sont écrites par le module de textes de l'interface (L5b).
// Une session de rôle « controle » est la ligne « Contrôle de sécurité » : son coût compte dans la demande, jamais dans « dont x $ de
// travail délégué ». Faits lus : statut (dont {cause, debut} d'un arrêt, L1c : une session arrêtée par MessageAbortedError, ou dont
// le travail s'est fermé entre `debut` et le fait sans erreur, est « arrete »), consigne, resultat, attente, reponse, choix (L6a) et
// affichage « deroule-partiel » (L4b) ; decision et origine ne changent pas les lignes (Journal et transcription).
// Module pur (server/shared) : aucun module node, aucun accès à process, ni horloge ni aléa (l'heure est passée en paramètre).
import type {
  ActivityFact,
  ActivityFactKind,
  ActivityResponse,
  ActivityRow,
  ActorActivity,
  ActorState,
  DelegationSource,
  FactValue,
  SessionInstance,
  SessionRole,
  StatutCause,
} from "./activity-types.ts";
import { type FactEvent, factProblem, isDelegatedWork, mergeFacts, sessionRole, toolCategory } from "./activity-facts.ts";
import type { AutonomyChoice, ChoiceCause } from "./autonomy-types.ts";
import { ID_RE } from "./ids.ts";

export { eventTime } from "./activity-facts.ts";

/** Profondeur la plus grande suivie sous la racine (profondeur 0) ; au-delà, la session n'est pas suivie : « Déroulé partiel ». */
export const ACTIVITY_MAX_DEPTH = 3;
/** Sessions suivies par conversation, racine comprise ; au-delà : « Déroulé partiel ». */
export const ACTIVITY_MAX_SESSIONS = 50;
/** Au plus une annonce toutes les 2 s (§5.5). */
export const ANNOUNCE_MIN_INTERVAL_MS = 2_000;
/** Reconstruction (messages, registre) : deux appels d'IA séparés de moins que cet écart forment une même période de travail. */
export const REPLAY_BUSY_GAP_MS = 250;
/** Titre de session gardé (texte d'IA possible, échappé à l'affichage). */
export const ACTIVITY_TITLE_MAX = 256;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const nameOf = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null);
const timeOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const strOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const costOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const money = (value: number): number => Math.round(value * 1e9) / 1e9;
const endOf = (end: number | null): number => end ?? Number.POSITIVE_INFINITY;
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const STATUT_CAUSES: ReadonlySet<string> = new Set<StatutCause>(["arret", "plafond", "non-controle", "interrompue"]);
const CHOICES: ReadonlySet<string> = new Set<AutonomyChoice>(["demander", "modifications", "plan", "autonome"]);
const CHOICE_CAUSES: ReadonlySet<string> = new Set<ChoiceCause>([
  "clic",
  "redemarrage-cockpit",
  "interrompue",
  "agent-non-conforme",
  "plafond-cout",
  "plafond-actions",
  "plafond-duree",
  "plafond-fichiers",
]);
const ROLES: ReadonlySet<string> = new Set<SessionRole>(["conversation", "delegation", "controle", "etape"]);
/** Catégorie d'outil (activity-facts.ts, toolCategory) → détail de « travaille ». */
const ACTIVITY_OF: Readonly<Record<string, ActorActivity["kind"]>> = { lire: "lit", chercher: "cherche", modifier: "modifie", commande: "commande" };

// --- État -------------------------------------------------------------------------------------------------------------------------

/** D'où viennent les faits : persistés (1.1), reconstruits depuis les messages, ou depuis le registre des coûts. */
export type ActivitySource = "faits" | "messages" | "registre";

/** Ce que les informations de session et les messages utilisateur apprennent d'une session (jamais rangé dans un fait). */
export interface ActivitySessionInfo {
  parentId: string | null;
  /** Titre donné par opencode, ACTIVITY_TITLE_MAX caractères au plus ; "" si inconnu. */
  title: string;
  /**
   * Assistant de la session : celui de ses informations (opencode 1.18.30 : l'assistant de sa dernière demande ; la racine n'en a pas
   * dans session.created) ou de son dernier message utilisateur, le plus récent reçu.
   */
  agent: string | null;
  /** Dernier message utilisateur lu : clé (id, time.completed) et heure de création. */
  message: { key: string; created: number } | null;
}

/** État du réducteur : jamais modifié en place ; chaque changement rend un nouvel objet (un rendu), sinon le même. */
export interface ActivityState {
  readonly rootId: string;
  /** Faits appliqués, dans l'ordre du magasin puis de réception. */
  readonly facts: readonly ActivityFact[];
  readonly sessions: ReadonlyMap<string, ActivitySessionInfo>;
  readonly source: ActivitySource;
}

/** État vide d'une conversation ; lève RangeError si l'identifiant n'a pas la forme d'un identifiant opencode. */
export function emptyActivity(rootId: string): ActivityState {
  if (!ID_RE.test(rootId)) throw new RangeError("identifiant de conversation invalide");
  return { rootId, facts: [], sessions: new Map(), source: "faits" };
}

/** Élément du flux du navigateur (forme de BrowserEvent, server/hub.ts). */
export type ActivityStreamEvent = { kind: "opencode"; event: FactEvent } | { kind: "cockpit"; type: string; data: unknown };

/**
 * Applique un élément du flux : un fait `activite.fait` de la conversation ; une information de session (titre, parent) ; le
 * dernier message utilisateur d'une session (son assistant). Tout le reste (deltas, parties, statuts, décisions) rend le même état :
 * ce qui change l'affichage arrive en fait (§3.10 point 6).
 */
export function applyEvent(state: ActivityState, event: ActivityStreamEvent): ActivityState {
  if (event.kind === "cockpit") return event.type === "activite.fait" ? appendFact(state, event.data) : state;
  const p = event.event.properties;
  if (!isRecord(p) || !isRecord(p.info)) return state;
  if (event.event.type === "session.created" || event.event.type === "session.updated") return withSession(state, p.info);
  return event.event.type === "message.updated" ? withUserMessage(state, p.info) : state;
}

/**
 * Faits persistés (GET …/facts, ordre du magasin) fusionnés avec ceux déjà reçus en direct (mergeFacts) : à l'ouverture et à la
 * reconnexion. Remplace des faits reconstruits (messages, registre). Un fait refusé par la garde ou d'une autre racine est écarté.
 */
export function replayFacts(state: ActivityState, persisted: readonly unknown[]): ActivityState {
  const clean = persisted.map(cleanFact).filter((fact): fact is ActivityFact => fact !== null && fact.rootId === state.rootId);
  return { ...state, facts: mergeFacts(clean, state.source === "faits" ? state.facts : []), source: "faits" };
}

/** Copie d'un fait permis par la garde de L4a (aucun texte dans data), null sinon. */
function cleanFact(value: unknown): ActivityFact | null {
  if (factProblem(value) !== null) return null;
  const fact = value as ActivityFact;
  return { rootId: fact.rootId, sessionId: fact.sessionId, kind: fact.kind, ref: fact.ref, data: { ...fact.data }, at: fact.at };
}

const identityOf = (fact: ActivityFact): string =>
  JSON.stringify([fact.sessionId, fact.kind, fact.ref, fact.at, Object.entries(fact.data).sort(([a], [b]) => compareKeys(a, b))]);

/** Identités des faits d'un tableau, partagées par les versions qui se suivent ; reconstruites si une version plus ancienne est prolongée. */
interface IdentityIndex {
  keys: Set<string>;
  head: readonly ActivityFact[];
}
const IDENTITIES = new WeakMap<readonly ActivityFact[], IdentityIndex>();

function appendFact(state: ActivityState, value: unknown): ActivityState {
  const fact = cleanFact(value);
  if (fact === null || fact.rootId !== state.rootId) return state;
  let index = IDENTITIES.get(state.facts);
  if (index?.head !== state.facts) {
    index = { keys: new Set(state.facts.map(identityOf)), head: state.facts };
    IDENTITIES.set(state.facts, index);
  }
  const key = identityOf(fact);
  if (index.keys.has(key)) return state;
  const facts = [...state.facts, fact];
  index.keys.add(key);
  index.head = facts;
  IDENTITIES.set(facts, index);
  return { ...state, facts };
}

/** Une session connue de l'arbre : la racine, une session d'un fait, ou une information de session déjà lue. */
function inTree(state: ActivityState, sessionId: string): boolean {
  return sessionId === state.rootId || state.sessions.has(sessionId) || derive(state).nodes.has(sessionId);
}

function withSession(state: ActivityState, info: Record<string, unknown>): ActivityState {
  const id = idOf(info.id);
  if (id === null) return state;
  const parentId = id === state.rootId ? null : idOf(info.parentID);
  if (id !== state.rootId && (parentId === null || !inTree(state, parentId))) return state;
  const known = state.sessions.get(id);
  if (!known && state.sessions.size >= ACTIVITY_MAX_SESSIONS * 2) return state;
  const title = typeof info.title === "string" ? info.title.slice(0, ACTIVITY_TITLE_MAX) : (known?.title ?? "");
  // Assistant de la session (opencode 1.18.30 : celui de sa dernière demande, absent de session.created pour la racine) : le même
  // qu'en direct pour un onglet rouvert, qui relit les informations de la conversation sans relire ses messages.
  const agent = nameOf(info.agent) ?? known?.agent ?? null;
  if (known && known.parentId === parentId && known.title === title && known.agent === agent) return state;
  const sessions = new Map(state.sessions);
  sessions.set(id, { parentId, title, agent, message: known?.message ?? null });
  return { ...state, sessions };
}

/** Dernier message utilisateur d'une session : son assistant ; doublon (id, time.completed) ou message plus ancien → même état. */
function withUserMessage(state: ActivityState, info: Record<string, unknown>): ActivityState {
  const id = idOf(info.id);
  const sessionId = idOf(info.sessionID);
  const agent = nameOf(info.agent);
  if (info.role !== "user" || id === null || sessionId === null || agent === null || !inTree(state, sessionId)) return state;
  const time = isRecord(info.time) ? info.time : {};
  const created = timeOf(time.created) ?? 0;
  const key = `${id}|${timeOf(time.completed) ?? ""}`;
  const known = state.sessions.get(sessionId);
  if (known?.message && (known.message.key === key || created < known.message.created)) return state;
  if (!known && state.sessions.size >= ACTIVITY_MAX_SESSIONS * 2) return state;
  const sessions = new Map(state.sessions);
  sessions.set(sessionId, { parentId: known?.parentId ?? null, title: known?.title ?? "", agent, message: { key, created } });
  return { ...state, sessions };
}

// --- Modèle dérivé des faits ------------------------------------------------------------------------------------------------------

type Interval = [number, number | null];

interface SpanModel {
  messageId: string;
  start: number;
  end: number | null;
  cost: number;
}

interface NodeModel {
  id: string;
  parentId: string | null;
  depth: number;
  role: SessionRole;
  instance: SessionInstance;
  agent: string | null;
  order: number;
  createdAt: number | null;
  busy: boolean;
  intervals: Interval[];
  erreur: string | null;
  abortedAt: number | null;
  attempt: number | null;
  tool: { callId: string; kind: ActorActivity["kind"] | null } | null;
  redige: boolean;
  spans: Map<string, SpanModel>;
  boundCall: string | null;
  /** La session parente travaillait quand celle-ci a été créée (sinon : détachée). Vrai faute de fait « creee ». */
  parentBusy: boolean;
  stopped: { cause: StatutCause; at: number } | null;
}

interface CallModel {
  key: string;
  sessionId: string;
  callId: string;
  messageId: string | null;
  order: number;
  preparedAt: number | null;
  writtenAt: number | null;
  sentAt: number | null;
  endedAt: number | null;
  child: string | null;
  agent: string | null;
  source: DelegationSource | null;
  commande: string | null;
  reprise: boolean;
  result: string | null;
  permissionId: string | null;
  stopCause: StatutCause | null;
}

interface WaitModel {
  id: string;
  sessionId: string;
  callId: string | null;
  askedAt: number;
  closedAt: number | null;
  reponse: string | null;
}

interface Model {
  nodes: Map<string, NodeModel>;
  calls: Map<string, CallModel>;
  waits: Map<string, WaitModel>;
  partial: boolean;
  choice: { choix: AutonomyChoice; cause: ChoiceCause; at: number } | null;
  stop: { cause: StatutCause; at: number; nonConfirmees: number } | null;
}

const MODELS = new WeakMap<ActivityState, Model>();

function derive(state: ActivityState): Model {
  let model = MODELS.get(state);
  if (!model) {
    model = build(state);
    MODELS.set(state, model);
  }
  return model;
}

const callKey = (sessionId: string, callId: string): string => `appel:${sessionId}:${callId}`;

/** Dernière période de travail de la session fermée dans [from, to]. */
function closedWithin(node: NodeModel, from: number, to: number): boolean {
  const end = node.intervals.at(-1)?.[1];
  return typeof end === "number" && end >= from && end <= to;
}

function closeBusy(node: NodeModel, at: number): void {
  const last = node.intervals.at(-1);
  if (last && last[1] === null) last[1] = Math.max(at, last[0]);
  node.busy = false;
  node.tool = null;
  node.redige = false;
  node.attempt = null;
}

function build(state: ActivityState): Model {
  const { rootId, facts } = state;
  const model: Model = { nodes: new Map(), calls: new Map(), waits: new Map(), partial: false, choice: null, stop: null };
  // Arbre : parent, rôle et assistant par session (fait « creee », sinon consigne ou résultat qui la lie, sinon information de session).
  const parents = new Map<string, string | null>();
  const created = new Map<string, { role: SessionRole | null; agent: string | null; instance: SessionInstance | null }>();
  const orders = new Map<string, number>([[rootId, -1]]);
  const seen = (id: string, order: number) => {
    if (!orders.has(id)) orders.set(id, order);
  };
  facts.forEach((fact, i) => {
    seen(fact.sessionId, i);
    if (fact.kind === "statut" && fact.data.etat === "creee" && !created.has(fact.sessionId)) {
      parents.set(fact.sessionId, strOf(fact.data.parent));
      const role = strOf(fact.data.role);
      const instance = fact.data.instance;
      created.set(fact.sessionId, {
        role: role !== null && ROLES.has(role) ? (role as SessionRole) : null,
        agent: strOf(fact.data.agent),
        instance: instance === "principale" || instance === "omo" ? instance : null,
      });
    }
    const child = fact.kind === "consigne" || fact.kind === "resultat" ? strOf(fact.data.enfant) : null;
    if (child !== null) {
      seen(child, i);
      if (!parents.has(child)) parents.set(child, fact.sessionId);
    }
  });
  let extra = facts.length;
  for (const [id, info] of state.sessions) {
    seen(id, extra++);
    if (!parents.has(id)) parents.set(id, info.parentId);
  }
  const rejected = new Set<string>();
  const admit = (id: string, visiting: Set<string>): NodeModel | null => {
    const known = model.nodes.get(id);
    if (known) return known;
    if (rejected.has(id) || visiting.has(id) || visiting.size > ACTIVITY_MAX_SESSIONS) return null;
    let parent: NodeModel | null = null;
    if (id !== rootId) {
      const parentId = parents.get(id);
      if (parentId === null || parentId === undefined) return null;
      visiting.add(id);
      parent = admit(parentId, visiting);
      visiting.delete(id);
      if (parent === null) return null;
      if (parent.depth >= ACTIVITY_MAX_DEPTH || model.nodes.size >= ACTIVITY_MAX_SESSIONS) {
        model.partial = true;
        rejected.add(id);
        return null;
      }
    }
    const traits = created.get(id);
    const node: NodeModel = {
      id,
      parentId: parent?.id ?? null,
      depth: parent === null ? 0 : parent.depth + 1,
      role: parent === null ? "conversation" : (traits?.role ?? "delegation"),
      instance: traits?.instance ?? parent?.instance ?? "principale",
      agent: traits?.agent ?? null,
      order: orders.get(id) ?? Number.MAX_SAFE_INTEGER,
      createdAt: null,
      busy: false,
      intervals: [],
      erreur: null,
      abortedAt: null,
      attempt: null,
      tool: null,
      redige: false,
      spans: new Map(),
      boundCall: null,
      parentBusy: true,
      stopped: null,
    };
    model.nodes.set(id, node);
    return node;
  };
  for (const [id] of [...orders].sort((a, b) => a[1] - b[1])) admit(id, new Set());

  const callOf = (node: NodeModel, callId: string, order: number): CallModel => {
    const key = callKey(node.id, callId);
    let call = model.calls.get(key);
    if (!call) {
      call = {
        key,
        sessionId: node.id,
        callId,
        messageId: null,
        order,
        preparedAt: null,
        writtenAt: null,
        sentAt: null,
        endedAt: null,
        child: null,
        agent: null,
        source: null,
        commande: null,
        reprise: false,
        result: null,
        permissionId: null,
        stopCause: null,
      };
      model.calls.set(key, call);
    }
    return call;
  };
  const bind = (call: CallModel, child: string | null) => {
    if (child === null || call.child !== null) return;
    call.child = child;
    const childNode = model.nodes.get(child);
    if (childNode) childNode.boundCall = call.key;
  };
  const closeWaits = (sessionId: string, callId: string, at: number) => {
    for (const wait of model.waits.values()) if (wait.sessionId === sessionId && wait.callId === callId && wait.closedAt === null) wait.closedAt = at;
  };
  let lastStop = Number.NEGATIVE_INFINITY;

  facts.forEach((fact, index) => {
    const { data, at } = fact;
    if (fact.kind === "affichage") {
      if (data.etat === "deroule-partiel") model.partial = true;
      return;
    }
    const node = model.nodes.get(fact.sessionId);
    if (!node) return;
    switch (fact.kind) {
      case "choix": {
        const choix = strOf(data.choix);
        const cause = strOf(data.cause);
        if (node.depth === 0 && choix !== null && CHOICES.has(choix) && cause !== null && CHOICE_CAUSES.has(cause)) {
          model.choice = { choix: choix as AutonomyChoice, cause: cause as ChoiceCause, at };
        }
        return;
      }
      case "statut": {
        if (data.etat === undefined && typeof data.cause === "string") {
          // Arrêt, plafond, « Passé sans contrôle » ou opencode relancé (L1c, L10) : écrit APRÈS les arrêts et leur confirmation.
          if (node.depth !== 0 || !STATUT_CAUSES.has(data.cause)) return;
          const cause = data.cause as StatutCause;
          model.stop = { cause, at, nonConfirmees: timeOf(data.nonConfirmees) ?? 0 };
          const debut = timeOf(data.debut);
          for (const other of model.nodes.values()) {
            if (other.busy) {
              // Une session encore occupée n'est dite arrêtée que si opencode a été relancé : un arrêt non confirmé reste visible.
              if (cause === "interrompue") {
                closeBusy(other, at);
                other.stopped = { cause, at };
              }
            } else if (other.abortedAt !== null && other.abortedAt >= lastStop) {
              other.stopped = { cause, at };
            } else if (debut !== null && other.erreur === null && closedWithin(other, debut, at)) {
              // Tour clos pendant l'arrêt sans MessageAbortedError (refus d'une demande en attente, étape 2) : arrêté, pas terminé.
              // Une vraie erreur pendant l'arrêt reste un échec.
              other.stopped = { cause, at };
            }
          }
          for (const call of model.calls.values()) {
            if (call.child === null && call.endedAt === null) {
              call.endedAt = at;
              call.stopCause = cause;
            }
          }
          for (const wait of model.waits.values()) if (wait.closedAt === null) wait.closedAt = at;
          lastStop = at;
          return;
        }
        applyStatut(node, fact, model);
        if (data.etat === "creee" && node.createdAt === null) {
          node.createdAt = at;
          const parent = node.parentId === null ? null : model.nodes.get(node.parentId);
          node.parentBusy = parent?.busy ?? true;
        }
        return;
      }
      case "consigne":
      case "resultat": {
        const callId = strOf(data.callId) ?? fact.ref;
        if (callId === null) return;
        const call = callOf(node, callId, index);
        call.messageId ??= strOf(data.messageId);
        if (fact.kind === "consigne" && data.etat === "prepare") {
          call.preparedAt ??= at;
          call.agent ??= strOf(data.agent);
        } else if (fact.kind === "consigne" && data.etat === "envoyee") {
          call.writtenAt ??= at;
          call.sentAt ??= at;
          call.agent = strOf(data.agent) ?? call.agent;
          call.source = data.source === "raccourci" ? "raccourci" : "ia";
          call.commande = strOf(data.commande);
          call.reprise = data.reprise === true;
          bind(call, strOf(data.enfant));
        } else if (fact.kind === "resultat") {
          call.writtenAt ??= at;
          call.endedAt ??= at;
          call.result = strOf(data.etat);
          bind(call, strOf(data.enfant));
          closeWaits(node.id, callId, at);
        }
        return;
      }
      case "attente": {
        if (fact.ref === null || model.waits.has(fact.ref)) return;
        const callId = strOf(data.callId);
        const wait: WaitModel = { id: fact.ref, sessionId: node.id, callId, askedAt: at, closedAt: null, reponse: null };
        model.waits.set(fact.ref, wait);
        if (callId !== null && data.permission === "task") {
          const call = callOf(node, callId, index);
          call.messageId ??= strOf(data.messageId);
          call.writtenAt ??= at;
          call.permissionId ??= fact.ref;
          call.agent ??= strOf(data.agent);
          if (call.endedAt !== null) wait.closedAt = at;
        }
        return;
      }
      case "reponse": {
        const wait = fact.ref === null ? undefined : model.waits.get(fact.ref);
        if (wait && wait.closedAt === null) {
          wait.closedAt = at;
          wait.reponse = strOf(data.reponse);
        }
        return;
      }
      default:
        return;
    }
  });
  return model;
}

/** Fait « statut » d'état (hors arrêt) : périodes de travail, erreur, nouvelle tentative, appels d'IA, rédaction, outils. */
function applyStatut(node: NodeModel, fact: ActivityFact, model: Model): void {
  const { data, at } = fact;
  switch (data.etat) {
    case "occupee":
      if (!node.busy) {
        node.busy = true;
        node.intervals.push([at, null]);
        node.erreur = null;
        node.abortedAt = null;
        node.stopped = null;
        node.attempt = null;
        node.tool = null;
        node.redige = false;
      }
      return;
    case "repos":
      if (node.busy) closeBusy(node, at);
      return;
    case "nouvelle-tentative":
      node.attempt = timeOf(data.tentative) ?? 1;
      return;
    case "erreur":
      node.erreur = strOf(data.erreur) ?? "inconnue";
      if (data.erreur === "MessageAbortedError") node.abortedAt = at;
      return;
    case "appel": {
      const messageId = strOf(data.messageId) ?? fact.ref;
      if (messageId !== null && !node.spans.has(messageId)) node.spans.set(messageId, { messageId, start: at, end: null, cost: 0 });
      node.tool = null;
      node.redige = false;
      node.attempt = null;
      return;
    }
    case "appel-fini": {
      const messageId = strOf(data.messageId) ?? fact.ref;
      if (messageId === null) return;
      const span = node.spans.get(messageId) ?? { messageId, start: at, end: null, cost: 0 };
      span.end = Math.max(at, span.start);
      span.cost = costOf(data.cout);
      node.spans.set(messageId, span);
      node.tool = null;
      // Le message qui délègue ne se clôt qu'après ses délégations : un appel resté ouvert (résultat perdu) se ferme ici.
      for (const call of model.calls.values()) if (call.sessionId === node.id && call.messageId === messageId) call.endedAt ??= at;
      return;
    }
    case "redige":
      node.redige = true;
      node.tool = null;
      return;
    case "outil": {
      const callId = strOf(data.callId);
      if (callId === null) return;
      if (data.phase === "en-cours") {
        node.tool = { callId, kind: ACTIVITY_OF[String(data.outil)] ?? null };
      } else {
        if (node.tool?.callId === callId) node.tool = null;
        for (const wait of model.waits.values()) if (wait.sessionId === node.id && wait.callId === callId && wait.closedAt === null) wait.closedAt = at;
      }
      return;
    }
    default:
      return;
  }
}

// --- Lignes d'acteurs -------------------------------------------------------------------------------------------------------------

/** Ligne d'acteur de « Qui travaille ? » : ActivityRow et ce que l'interface lit en plus (codes et identifiants seulement). */
export interface LiveRow extends ActivityRow {
  /** Clé stable : identifiant de session, ou « appel:{session}:{callId} » pour une délégation sans session. */
  key: string;
  /** Délégation sans session (en attente de votre accord, jamais démarrée) : sessionId et parentId désignent la session qui délègue. */
  sansSession: boolean;
  /** Appel `task` qui a lancé la session (ou de la délégation sans session). */
  callId: string | null;
  /** Outil en cours : son détail (chemin, motif) est relu dans la partie d'outil, jamais dans un fait. */
  outilCallId: string | null;
  /** Demande d'autorisation ouverte à laquelle répondre ([Répondre]). */
  permissionId: string | null;
  source: DelegationSource | null;
  commande: string | null;
  /**
   * Lancée sans demande d'autorisation par un raccourci `subtask` (§6 l.1048) : appel `task` porteur d'une commande, et aucune
   * attente vue pour lui (règle de delegations.sans_confirmation, fact-store). La commande seule ne prouve rien : l'IA peut remplir
   * le paramètre `command` de l'outil `task` elle-même, et opencode pose alors la demande.
   */
  sansConfirmation: boolean;
  reprise: boolean;
  /** Enfant lancé alors que la session qui délègue ne travaillait plus (accord tardif) : son résultat ne revient nulle part. */
  detache: boolean;
  cause: StatutCause | null;
  /** Nom de l'erreur d'opencode (code), jamais son message. */
  erreur: string | null;
  until: number | null;
  durationMs: number | null;
}

/** Raccourci lancé sans demande : commande portée par l'appel `task`, et aucune attente d'accord vue pour cet appel. */
const lanceSansDemande = (call: CallModel | null): boolean => call !== null && call.commande !== null && call.permissionId === null;

const ownOpenWait = (model: Model, node: NodeModel): WaitModel | null => {
  for (const wait of model.waits.values()) {
    const delegation = wait.callId !== null && model.calls.has(callKey(node.id, wait.callId));
    if (wait.sessionId === node.id && wait.closedAt === null && !delegation) return wait;
  }
  return null;
};

function sessionState(model: Model, node: NodeModel): ActorState {
  const call = node.boundCall === null ? null : (model.calls.get(node.boundCall) ?? null);
  if (!node.busy) {
    if (node.stopped !== null || node.abortedAt !== null || call?.result === "interrompu") return "arrete";
    if (node.erreur !== null || call?.result === "echec") return "echec";
    return node.intervals.length > 0 || node.spans.size > 0 || call?.result === "rendu" ? "termine" : "pas-commence";
  }
  if (node.role === "controle") return "controle";
  if (ownOpenWait(model, node) !== null) return "attente-accord";
  if (node.attempt !== null) return "nouvelle-tentative";
  const open = [...model.calls.values()].filter((c) => c.sessionId === node.id && c.endedAt === null);
  if (open.some((c) => c.writtenAt === null)) return "prepare-delegation";
  if (open.some((c) => c.sentAt !== null)) return "attend-delegation";
  // Délégation écrite qui attend votre accord : l'attente et [Répondre] sont sur la ligne de la délégation, jamais en double.
  if (open.length > 0) return "prepare-delegation";
  if (node.tool !== null) return "travaille";
  return node.redige ? "redige" : "travaille";
}

function sessionRow(state: ActivityState, model: Model, node: NodeModel, now: number): LiveRow {
  const info = state.sessions.get(node.id);
  const call = node.boundCall === null ? null : (model.calls.get(node.boundCall) ?? null);
  const last = node.intervals.at(-1) ?? null;
  const since = last?.[0] ?? node.createdAt;
  const until = node.busy ? null : (last?.[1] ?? node.stopped?.at ?? null);
  let cost = 0;
  for (const span of node.spans.values()) cost += span.cost;
  return {
    key: node.id,
    sessionId: node.id,
    parentId: node.parentId,
    rootId: state.rootId,
    role: node.role,
    instance: node.instance,
    title: info?.title ?? "",
    agent: node.agent ?? call?.agent ?? info?.agent ?? null,
    depth: node.depth,
    state: sessionState(model, node),
    activity: node.busy && node.tool?.kind ? { kind: node.tool.kind, detail: null } : null,
    since,
    cost: money(cost),
    calls: node.spans.size,
    attempt: node.busy ? node.attempt : null,
    sansSession: false,
    callId: call?.callId ?? null,
    outilCallId: node.busy ? (node.tool?.callId ?? null) : null,
    permissionId: node.busy ? (ownOpenWait(model, node)?.id ?? null) : null,
    source: call?.source ?? null,
    commande: call?.commande ?? null,
    sansConfirmation: lanceSansDemande(call),
    reprise: call?.reprise ?? false,
    detache: node.role === "delegation" && call === null && !node.parentBusy,
    cause: node.stopped?.cause ?? null,
    erreur: node.busy ? null : node.erreur,
    until,
    durationMs: since === null ? null : Math.max(0, (until ?? now) - since),
  };
}

/** Délégation sans session à montrer : en attente de votre accord, ou jamais démarrée ; null sinon (portée par la session qui délègue). */
function callRow(state: ActivityState, model: Model, call: CallModel, now: number): LiveRow | null {
  const parent = model.nodes.get(call.sessionId);
  if (call.child !== null || !parent) return null;
  const wait = call.permissionId === null ? undefined : model.waits.get(call.permissionId);
  let rowState: ActorState;
  if (call.endedAt !== null || wait?.reponse === "reject") rowState = "jamais-demarre";
  else if (wait && wait.closedAt === null) rowState = "attente-accord";
  else if (wait) rowState = "prepare-delegation";
  else return null;
  const since = call.preparedAt ?? call.writtenAt;
  const until = rowState === "jamais-demarre" ? (call.endedAt ?? wait?.closedAt ?? null) : null;
  return {
    key: call.key,
    sessionId: parent.id,
    parentId: parent.id,
    rootId: state.rootId,
    role: "delegation",
    instance: parent.instance,
    title: "",
    agent: call.agent,
    depth: parent.depth + 1,
    state: rowState,
    activity: null,
    since,
    cost: 0,
    calls: 0,
    attempt: null,
    sansSession: true,
    callId: call.callId,
    outilCallId: null,
    permissionId: rowState === "attente-accord" ? (wait?.id ?? null) : null,
    source: call.source,
    commande: call.commande,
    sansConfirmation: lanceSansDemande(call),
    reprise: false,
    detache: false,
    cause: call.stopCause,
    erreur: null,
    until,
    durationMs: since === null ? null : Math.max(0, (until ?? now) - since),
  };
}

/**
 * Lignes d'acteurs dans l'ordre de première apparition (positions jamais réorganisées : une session liée à sa délégation prend la
 * place de celle-ci) ; `now` sert seulement aux durées.
 */
export function liveRows(state: ActivityState, now: number): LiveRow[] {
  const model = derive(state);
  const rows: Array<{ order: number; row: LiveRow }> = [];
  for (const node of model.nodes.values()) {
    const call = node.boundCall === null ? undefined : model.calls.get(node.boundCall);
    rows.push({ order: Math.min(node.order, call?.order ?? node.order), row: sessionRow(state, model, node, now) });
  }
  for (const call of model.calls.values()) {
    const row = callRow(state, model, call, now);
    if (row) rows.push({ order: call.order, row });
  }
  return rows.sort((a, b) => a.order - b.order || compareKeys(a.row.key, b.row.key)).map(({ row }) => row);
}

// --- Déroulé ----------------------------------------------------------------------------------------------------------------------

/** Barres du Déroulé (§5.1) : génération (pleine), attente de délégation (claire), attente de vous (hachure + « vous »). */
export type TimelineBarKind = "generation" | "attente-delegation" | "attente-vous";

export interface TimelineBar {
  kind: TimelineBarKind;
  start: number;
  /** null : en cours. */
  end: number | null;
}

/** Appel d'IA (Chronologie) : de son premier signe à sa fin, coût à l'arrivée. */
export interface TimelineCall {
  messageId: string;
  start: number;
  end: number | null;
  cost: number;
}

export interface TimelineRow {
  key: string;
  sessionId: string;
  sansSession: boolean;
  depth: number;
  role: SessionRole;
  state: ActorState;
  start: number | null;
  end: number | null;
  bars: TimelineBar[];
  calls: TimelineCall[];
  cost: number;
}

const BAR_ORDER: Readonly<Record<TimelineBarKind, number>> = { generation: 0, "attente-delegation": 1, "attente-vous": 2 };

/** Retire `cut` d'un intervalle (bornes ouvertes : null = en cours). */
function subtract([start, end]: Interval, [cutStart, cutEnd]: Interval): Interval[] {
  if (endOf(end) <= cutStart || endOf(cutEnd) <= start) return [[start, end]];
  const out: Interval[] = [];
  if (start < cutStart) out.push([start, cutStart]);
  if (cutEnd !== null && cutEnd < endOf(end)) out.push([cutEnd, end]);
  return out;
}

function nodeBars(model: Model, node: NodeModel): TimelineBar[] {
  const closeAt = node.busy ? null : (node.intervals.at(-1)?.[1] ?? node.stopped?.at ?? null);
  const bars: TimelineBar[] = [];
  const cuts: Interval[] = [];
  for (const wait of model.waits.values()) {
    if (wait.sessionId !== node.id) continue;
    bars.push({ kind: "attente-vous", start: wait.askedAt, end: wait.closedAt });
    cuts.push([wait.askedAt, wait.closedAt]);
  }
  // Délégations d'un même message : attente du premier appel écrit et envoyé à la fin du dernier (G1) ; la génération s'arrête
  // quand tous les appels du message sont écrits et reprend à la fin du dernier (G3).
  const groups = new Map<string, CallModel[]>();
  for (const call of model.calls.values()) {
    if (call.sessionId !== node.id) continue;
    const group = call.messageId ?? call.callId;
    groups.set(group, [...(groups.get(group) ?? []), call]);
  }
  for (const calls of groups.values()) {
    const written = calls.map((c) => c.writtenAt ?? c.endedAt);
    const ends = calls.map((c) => c.endedAt);
    const allEnded = ends.every((end) => end !== null) ? Math.max(...(ends as number[])) : null;
    if (written.every((w) => w !== null)) cuts.push([Math.max(...(written as number[])), allEnded]);
    const sent = calls.filter((c) => c.sentAt !== null).map((c) => c.writtenAt ?? (c.sentAt as number));
    if (sent.length > 0) bars.push({ kind: "attente-delegation", start: Math.min(...sent), end: allEnded ?? closeAt });
  }
  let pieces: Interval[] = node.intervals.map(([start, end]) => [start, end]);
  for (const cut of cuts) pieces = pieces.flatMap((piece) => subtract(piece, cut));
  const spans = [...node.spans.values()];
  for (const [start, end] of pieces) {
    // Une période sans appel d'IA n'est pas de la génération (repère d'un raccourci, attente pure) : aucune barre.
    const billed = spans.some((span) => start < endOf(span.end) && span.start < endOf(end));
    if (billed && endOf(end) > start) bars.push({ kind: "generation", start, end });
  }
  return bars.sort((a, b) => a.start - b.start || BAR_ORDER[a.kind] - BAR_ORDER[b.kind]);
}

/** Déroulé de la conversation, dans l'ordre des lignes d'acteurs. */
export function timeline(state: ActivityState): TimelineRow[] {
  const model = derive(state);
  return liveRows(state, 0).map((row) => {
    const node = row.sansSession ? undefined : model.nodes.get(row.sessionId);
    if (!node) {
      const { key, sessionId, depth, role, state: rowState } = row;
      return { key, sessionId, sansSession: true, depth, role, state: rowState, start: row.since, end: row.until, bars: [], calls: [], cost: 0 };
    }
    const closeAt = node.busy ? null : (node.intervals.at(-1)?.[1] ?? node.stopped?.at ?? null);
    const calls = [...node.spans.values()]
      .map((span) => ({ messageId: span.messageId, start: span.start, end: span.end ?? closeAt, cost: money(span.cost) }))
      .sort((a, b) => a.start - b.start);
    const starts = [node.createdAt, node.intervals[0]?.[0] ?? null, calls[0]?.start ?? null].filter((t): t is number => t !== null);
    const ends = [closeAt, ...calls.map((c) => c.end)];
    return {
      key: row.key,
      sessionId: row.sessionId,
      sansSession: false,
      depth: row.depth,
      role: row.role,
      state: row.state,
      start: starts.length > 0 ? Math.min(...starts) : null,
      end: node.busy || ends.some((e) => e === null) ? null : Math.max(...(ends as number[])),
      bars: nodeBars(model, node),
      calls,
      cost: row.cost,
    };
  });
}

// --- Totaux ---------------------------------------------------------------------------------------------------------------------

/** Pied de tour « {coût} dont {x} $ de travail délégué · {n} appels d'IA » : les contrôles de sécurité à part, jamais délégués. */
export interface ActivityTotals {
  cost: number;
  delegatedCost: number;
  controlCost: number;
  calls: number;
  delegatedCalls: number;
  controlCalls: number;
  /** Durée murale des périodes de travail de la fenêtre ; null si l'une est en cours ou s'il n'y en a aucune. */
  wallMs: number | null;
}

/** Totaux de l'arbre, ou d'une demande : appels d'IA commencés dans [from, to) (to null : jusqu'au bout). */
export function totals(state: ActivityState, window?: { from: number; to: number | null }): ActivityTotals {
  const inside = (t: number) => !window || (t >= window.from && (window.to === null || t < window.to));
  const out: ActivityTotals = { cost: 0, delegatedCost: 0, controlCost: 0, calls: 0, delegatedCalls: 0, controlCalls: 0, wallMs: null };
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let open = false;
  for (const node of derive(state).nodes.values()) {
    for (const span of node.spans.values()) {
      if (!inside(span.start)) continue;
      out.cost += span.cost;
      out.calls++;
      if (isDelegatedWork(node.role)) {
        out.delegatedCost += span.cost;
        out.delegatedCalls++;
      } else if (node.role === "controle") {
        out.controlCost += span.cost;
        out.controlCalls++;
      }
    }
    for (const [start, end] of node.intervals) {
      if (window && (endOf(end) <= window.from || (window.to !== null && start >= window.to))) continue;
      first = Math.min(first, window ? Math.max(start, window.from) : start);
      if (end === null && (!window || window.to === null)) open = true;
      last = Math.max(last, window && window.to !== null ? Math.min(endOf(end), window.to) : endOf(end));
    }
  }
  out.cost = money(out.cost);
  out.delegatedCost = money(out.delegatedCost);
  out.controlCost = money(out.controlCost);
  out.wallMs = open || first === Number.POSITIVE_INFINITY ? null : Math.max(0, last - first);
  return out;
}

/** État général : source des faits, Déroulé partiel, choix d'autonomie et dernier arrêt lus dans les faits. */
export interface ActivityStatus {
  source: ActivitySource;
  partial: boolean;
  /** Attentes et statuts enregistrés (faits de la 1.1) ; faux : « Temps d'attente non enregistré avant la 1.1 ». */
  attentesEnregistrees: boolean;
  choix: { choix: AutonomyChoice; cause: ChoiceCause; at: number } | null;
  arret: { cause: StatutCause; at: number; nonConfirmees: number } | null;
}

export function activityStatus(state: ActivityState): ActivityStatus {
  const model = derive(state);
  return { source: state.source, partial: model.partial, attentesEnregistrees: state.source === "faits", choix: model.choice, arret: model.stop };
}

// --- Annonces -------------------------------------------------------------------------------------------------------------------

/** Transition annoncée (§5.5) ; « retour-demander » : le choix d'autonomie est revenu à « Demander » sans clic. */
export type AnnouncementCode = "commence" | "attente-accord" | "termine" | "echec" | "arrete" | "jamais-demarre" | "retour-demander";

export interface ActivityAnnouncement {
  code: AnnouncementCode;
  key: string;
  role: SessionRole;
  agent: string | null;
  title: string;
  durationMs: number | null;
  cause: StatutCause | ChoiceCause | null;
}

/** Annonces en attente et heure de la dernière annonce faite ; à garder par l'appelant entre deux appels. */
export interface AnnouncementQueue {
  readonly pending: readonly ActivityAnnouncement[];
  readonly lastAt: number | null;
}

export const EMPTY_ANNOUNCEMENTS: AnnouncementQueue = Object.freeze({ pending: Object.freeze([]) as readonly ActivityAnnouncement[], lastAt: null });

const ANNOUNCED: Partial<Readonly<Record<ActorState, AnnouncementCode>>> = {
  "attente-accord": "attente-accord",
  termine: "termine",
  echec: "echec",
  arrete: "arrete",
  "jamais-demarre": "jamais-demarre",
};
const WORKING: ReadonlySet<ActorState> = new Set<ActorState>([
  "prepare-delegation",
  "travaille",
  "redige",
  "attend-delegation",
  "controle",
  "nouvelle-tentative",
]);
const IDLE: ReadonlySet<ActorState> = new Set<ActorState>(["pas-commence", "termine", "echec", "arrete", "jamais-demarre"]);

/**
 * Transitions de `prev` à `next` (jamais les états traversés en silence ni un état final déjà atteint à l'ouverture), fusionnées
 * par ligne dans la file ; `say` n'est rendu qu'au plus une fois toutes les ANNOUNCE_MIN_INTERVAL_MS. Appeler aussi sans changement
 * (prev === next) pour vider la file quand le délai est passé. Une autre conversation vide la file.
 */
export function announcements(
  prev: ActivityState,
  next: ActivityState,
  now: number,
  queue: AnnouncementQueue = EMPTY_ANNOUNCEMENTS,
): { say: readonly ActivityAnnouncement[] | null; queue: AnnouncementQueue } {
  const same = prev.rootId === next.rootId;
  const pending = same ? [...queue.pending] : [];
  const push = (item: ActivityAnnouncement) => {
    const index = pending.findIndex((p) => p.key === item.key);
    if (index >= 0) pending.splice(index, 1);
    pending.push(item);
  };
  if (same && prev !== next) {
    const before = new Map(liveRows(prev, now).map((row) => [row.key, row.state]));
    for (const row of liveRows(next, now)) {
      const was = before.get(row.key);
      if (was === row.state) continue;
      let code = ANNOUNCED[row.state] ?? null;
      if (code === null && WORKING.has(row.state) && (was === undefined || IDLE.has(was))) code = "commence";
      if (code === null || (was === undefined && code !== "commence" && code !== "attente-accord")) continue;
      const durationMs = code === "termine" ? row.durationMs : null;
      push({ code, key: row.key, role: row.role, agent: row.agent, title: row.title, durationMs, cause: row.cause });
    }
    const a = derive(prev).choice;
    const b = derive(next).choice;
    if (b !== null && (a === null || a.at !== b.at || a.choix !== b.choix) && b.choix === "demander" && b.cause !== "clic") {
      push({ code: "retour-demander", key: "choix", role: "conversation", agent: null, title: "", durationMs: null, cause: b.cause });
    }
  }
  const lastAt = same ? queue.lastAt : null;
  if (pending.length > 0 && (lastAt === null || now - lastAt >= ANNOUNCE_MIN_INTERVAL_MS)) return { say: pending, queue: { pending: [], lastAt: now } };
  return { say: null, queue: { pending, lastAt } };
}

// --- Reconstruction (messages, registre) ----------------------------------------------------------------------------------------

/** Rang d'un fait reconstruit à heure égale : création, travail, appel, détail, résultat, fin d'appel, erreur, repos. */
const RANK = { creee: 0, occupee: 1, appel: 2, detail: 3, resultat: 4, fin: 5, erreur: 6, repos: 7 } as const;

function synthesizer(rootId: string) {
  const out: Array<{ fact: ActivityFact; rank: number; seq: number }> = [];
  return {
    add(sessionId: string, kind: ActivityFactKind, ref: string | null, data: Record<string, FactValue>, at: number, rank: number): void {
      out.push({ fact: { rootId, sessionId, kind, ref, data, at }, rank, seq: out.length });
    },
    facts: (): ActivityFact[] => out.sort((a, b) => a.fact.at - b.fact.at || a.rank - b.rank || a.seq - b.seq).map((entry) => entry.fact),
  };
}

/** Périodes de travail d'une session à partir de ses appels [début, fin] : fusion des appels séparés d'au plus REPLAY_BUSY_GAP_MS. */
function busyPeriods(calls: readonly Interval[]): Interval[] {
  const periods: Interval[] = [];
  for (const [start, end] of [...calls].sort((a, b) => a[0] - b[0])) {
    const last = periods.at(-1);
    if (last && (last[1] === null || start - last[1] <= REPLAY_BUSY_GAP_MS)) {
      last[1] = last[1] === null || end === null ? null : Math.max(last[1], end);
    } else {
      periods.push([start, end]);
    }
  }
  return periods;
}

type Synth = ReturnType<typeof synthesizer>;

function replayTool(synth: Synth, sessionId: string, messageId: string, part: Record<string, unknown>, fallback: number): void {
  const tool = nameOf(part.tool);
  const callId = idOf(part.callID);
  const st = isRecord(part.state) ? part.state : null;
  if (tool === null || callId === null || st === null) return;
  const times = isRecord(st.time) ? st.time : {};
  const start = timeOf(times.start) ?? fallback;
  const end = timeOf(times.end) ?? start;
  const input = isRecord(st.input) ? st.input : {};
  const metadata = isRecord(st.metadata) ? st.metadata : {};
  const finished = st.status === "completed" || st.status === "error";
  const interrupted = metadata.interrupted === true;
  if (tool === "task") {
    const enfant = idOf(metadata.sessionId);
    const commande = nameOf(input.command);
    const agent = nameOf(input.subagent_type);
    if (enfant !== null) {
      const reprise = typeof input.task_id === "string" && input.task_id !== "";
      const data = { etat: "envoyee", callId, messageId, enfant, agent, source: commande === null ? "ia" : "raccourci", commande, reprise };
      synth.add(sessionId, "consigne", callId, data, start, RANK.detail);
    } else {
      synth.add(sessionId, "consigne", callId, { etat: "prepare", callId, messageId, agent }, start, RANK.detail);
    }
    let etat = "rendu";
    if (st.status === "error") etat = interrupted ? "interrompu" : "echec";
    if (finished) synth.add(sessionId, "resultat", callId, { etat, callId, messageId, enfant }, end, RANK.resultat);
    return;
  }
  if (st.status !== "running" && !finished) return;
  const base = { etat: "outil", outil: toolCategory(tool), nom: tool, callId, messageId, fichier: null, dossier: null };
  synth.add(sessionId, "statut", callId, { ...base, phase: "en-cours" }, start, RANK.detail);
  let phase = "termine";
  if (st.status === "error") phase = interrupted ? "interrompu" : "erreur";
  if (finished) synth.add(sessionId, "statut", callId, { ...base, phase }, end, RANK.resultat);
}

/** Usage d'une session d'après `metadata.cockpit` (sessions.ts, purposeOf) : controle, equipe, classifier, sinon chat. */
function purposeOf(info: Record<string, unknown>): string {
  const cockpit = isRecord(info.metadata) ? info.metadata.cockpit : undefined;
  return cockpit === "controle" || cockpit === "equipe" || cockpit === "classifier" ? cockpit : "chat";
}

/**
 * Relecture à l'ouverture et à la reconnexion (§3.10 point 4) : informations de session (GET /session/:id/children, récursif) et
 * messages (GET /session/:id/message, `{info, parts}`). Titres et assistants s'ajoutent toujours ; si la conversation n'a aucun fait
 * (avant la 1.1), les faits sont reconstruits depuis les messages : périodes de travail, appels d'IA (un message sans partie
 * step-start n'est pas facturé : repère d'un raccourci), délégations et outils ; attentes « non enregistrées ».
 */
export function replayMessages(state: ActivityState, input: { sessions: readonly unknown[]; messages: readonly unknown[] }): ActivityState {
  let next = state;
  // Parents avant enfants : une passe par niveau suivi ; une session cachée (classifier) n'entre jamais dans l'arbre.
  for (let pass = 0; pass <= ACTIVITY_MAX_DEPTH; pass++) {
    for (const info of input.sessions) {
      if (isRecord(info) && sessionRole(purposeOf(info), idOf(info.parentID)) !== null) next = withSession(next, info);
    }
  }
  const messages: Array<{ sessionId: string; info: Record<string, unknown>; parts: Record<string, unknown>[] }> = [];
  for (const message of input.messages) {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue;
    next = withUserMessage(next, message.info);
    const sessionId = idOf(message.info.sessionID);
    if (sessionId !== null) messages.push({ sessionId, info: message.info, parts: message.parts.filter(isRecord) });
  }
  if (state.source === "faits" && state.facts.length > 0) return next;
  const synth = synthesizer(state.rootId);
  const known = (id: string) => id === state.rootId || next.sessions.has(id);
  const firstSeen = new Map<string, number>();
  const bySession = new Map<string, Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[]; created: number; completed: number | null }>>();
  for (const { sessionId, info, parts } of messages) {
    const time = isRecord(info.time) ? info.time : {};
    const created = timeOf(time.created);
    if (!known(sessionId) || created === null) continue;
    firstSeen.set(sessionId, Math.min(firstSeen.get(sessionId) ?? created, created));
    if (info.role !== "assistant") continue;
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), { info, parts, created, completed: timeOf(time.completed) }]);
  }
  for (const raw of input.sessions) {
    const id = isRecord(raw) ? idOf(raw.id) : null;
    const session = id === null ? undefined : next.sessions.get(id);
    if (!isRecord(raw) || id === null || id === state.rootId || !session) continue;
    const role = sessionRole(purposeOf(raw), session.parentId);
    const time = isRecord(raw.time) ? raw.time : {};
    const at = timeOf(time.created) ?? firstSeen.get(id) ?? 0;
    if (role === null) continue;
    synth.add(id, "statut", null, { etat: "creee", role, parent: session.parentId, agent: null, instance: "principale" }, at, RANK.creee);
  }
  for (const [sessionId, assistants] of bySession) {
    for (const [start, end] of busyPeriods(assistants.map((a) => [a.created, a.completed]))) {
      synth.add(sessionId, "statut", null, { etat: "occupee" }, start, RANK.occupee);
      if (end !== null) synth.add(sessionId, "statut", null, { etat: "repos" }, end, RANK.repos);
    }
    for (const { info, parts, created, completed } of assistants) {
      const messageId = idOf(info.id);
      if (messageId === null) continue;
      const done = completed ?? created;
      if (parts.some((part) => part.type === "step-start")) synth.add(sessionId, "statut", messageId, { etat: "appel", messageId }, created, RANK.appel);
      const finishes = parts.filter((part) => part.type === "step-finish");
      if (finishes.length > 0) {
        const cout = money(finishes.reduce((sum, part) => sum + costOf(part.cost), 0));
        synth.add(sessionId, "statut", messageId, { etat: "appel-fini", messageId, cout, raison: nameOf(finishes.at(-1)?.reason) }, done, RANK.fin);
      }
      const error = isRecord(info.error) ? nameOf(info.error.name) : null;
      if (error !== null) synth.add(sessionId, "statut", null, { etat: "erreur", erreur: error }, done, RANK.erreur);
      const text = parts.find((part) => part.type === "text");
      const textAt = text && isRecord(text.time) ? timeOf(text.time.start) : null;
      if (text) synth.add(sessionId, "statut", messageId, { etat: "redige", messageId }, textAt ?? created, RANK.detail);
      for (const part of parts) if (part.type === "tool") replayTool(synth, sessionId, messageId, part, created);
    }
  }
  return { ...next, facts: synth.facts(), source: "messages" };
}

/** Session du registre du cockpit (table sessions) : parent et usage (chat, controle, equipe, classifier). */
export interface LedgerSession {
  id: string;
  parentId: string | null;
  purpose: string;
  title?: string | undefined;
}

const LEDGER_RESULT: Readonly<Record<string, string>> = {
  terminee: "rendu",
  arretee: "interrompu",
  "jamais-demarree": "interrompu",
  refusee: "echec",
  expiree: "echec",
};

/**
 * Conversation dont opencode n'a plus les sessions (Archives) : faits reconstruits depuis le registre (GET …/activity : appels d'IA,
 * délégations, attentes) et les sessions du cockpit, qui donnent l'arbre et les rôles. Une session absente de cette liste, ou
 * cachée (classifier), n'entre jamais dans l'arbre : ses appels ne sont ni montrés ni comptés.
 */
export function fromLedger(rootId: string, activity: ActivityResponse, sessions: readonly LedgerSession[]): ActivityState {
  const roles = new Map<string, SessionRole>();
  for (const s of sessions) {
    const role = sessionRole(s.purpose, s.parentId);
    if (role !== null) roles.set(s.id, role);
  }
  let state = emptyActivity(rootId);
  for (let pass = 0; pass <= ACTIVITY_MAX_DEPTH; pass++) {
    for (const s of sessions) if (roles.has(s.id)) state = withSession(state, { id: s.id, parentID: s.parentId, title: s.title });
  }
  const synth = synthesizer(rootId);
  const firstSeen = new Map<string, number>();
  const note = (id: string | null, at: number) => {
    if (id !== null) firstSeen.set(id, Math.min(firstSeen.get(id) ?? at, at));
  };
  const spans = new Map<string, Interval[]>();
  for (const span of activity.usageSpans) {
    const { sessionId, messageId, start } = span;
    if (idOf(messageId) === null || timeOf(start) === null) continue;
    const end = timeOf(span.end);
    note(sessionId, start);
    spans.set(sessionId, [...(spans.get(sessionId) ?? []), [start, end]]);
    synth.add(sessionId, "statut", messageId, { etat: "appel", messageId }, start, RANK.appel);
    if (end !== null) synth.add(sessionId, "statut", messageId, { etat: "appel-fini", messageId, cout: money(costOf(span.cost)), raison: null }, end, RANK.fin);
  }
  for (const [sessionId, calls] of spans) {
    for (const [start, end] of busyPeriods(calls)) {
      synth.add(sessionId, "statut", null, { etat: "occupee" }, start, RANK.occupee);
      if (end !== null) synth.add(sessionId, "statut", null, { etat: "repos" }, end, RANK.repos);
    }
  }
  for (const d of activity.delegations) {
    const callId = idOf(d.callId);
    if (d.rootId !== rootId || callId === null || timeOf(d.createdAt) === null) continue;
    const enfant = idOf(d.childSessionId);
    const start = timeOf(d.startedAt) ?? d.createdAt;
    const agent = nameOf(d.agent);
    note(enfant, start);
    if (enfant !== null) {
      const source = d.source === "raccourci" ? "raccourci" : "ia";
      const data = { etat: "envoyee", callId, messageId: null, enfant, agent, source, commande: nameOf(d.command), reprise: false };
      synth.add(d.parentSessionId, "consigne", callId, data, start, RANK.detail);
    } else {
      synth.add(d.parentSessionId, "consigne", callId, { etat: "prepare", callId, messageId: null, agent }, d.createdAt, RANK.detail);
    }
    const etat = LEDGER_RESULT[d.state];
    if (etat) synth.add(d.parentSessionId, "resultat", callId, { etat, callId, messageId: null, enfant }, timeOf(d.endedAt) ?? start, RANK.resultat);
  }
  for (const s of sessions) {
    const role = roles.get(s.id);
    if (s.id === rootId || role === undefined || !state.sessions.has(s.id)) continue;
    const data = { etat: "creee", role, parent: s.parentId, agent: null, instance: "principale" };
    synth.add(s.id, "statut", null, data, firstSeen.get(s.id) ?? 0, RANK.creee);
  }
  for (const w of activity.waits) {
    if (w.rootId !== rootId || idOf(w.permissionId) === null || timeOf(w.askedAt) === null) continue;
    const delegation = activity.delegations.find((d) => d.permissionId === w.permissionId);
    const permission = /^[a-z_]{1,32}$/.test(w.permission) ? w.permission : null;
    const data = { permission, messageId: null, callId: idOf(delegation?.callId), agent: nameOf(delegation?.agent) };
    synth.add(w.sessionId, "attente", w.permissionId, data, w.askedAt, RANK.detail);
    const repliedAt = timeOf(w.repliedAt);
    if (repliedAt !== null) synth.add(w.sessionId, "reponse", w.permissionId, { reponse: w.reply ?? "expiree" }, repliedAt, RANK.resultat);
  }
  return { ...state, facts: synth.facts(), source: "registre" };
}
