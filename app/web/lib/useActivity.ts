// Propriétaire : L5b.
// « Qui travaille ? » dans le navigateur (spécification §3.10 point 4, §5.1, §5.5) : état d'activité d'UNE conversation, réduit par
// server/shared/activity.ts (L4c), réducteur séparé de transcriptReducer et indexé par l'arbre de la racine.
// - au plus 4 rendus par seconde (RENDER_MIN_INTERVAL_MS) : les événements s'appliquent tout de suite, seul l'avis aux abonnés
//   est espacé ; les durées avancent d'une seconde à l'autre tant que l'arbre travaille ;
// - deltas jamais lus (`message.part.delta`), et rien d'une session hors de l'arbre : seuls les faits `activite.fait` de la racine,
//   les informations de session et les messages utilisateur de l'arbre (réducteur), et les parties d'outil de l'arbre (détail de
//   « travaille ») sont lus ;
// - relecture à l'ouverture et sur `stream.reconnected` : faits persistés (GET …/facts), informations de la conversation elle-même
//   (GET /session/:id : titre et assistant de sa dernière demande, comme session.updated en direct), titres (GET
//   /session/:id/children, 3 niveaux et 50 sessions au plus), et messages (GET /session/:id/message) seulement pour une conversation
//   sans faits (avant la 1.1) ; une relecture dépassée par une plus récente est ignorée ; ce que la relecture révèle n'est jamais
//   annoncé ;
// - annonces (≤ 1 / 2 s, codes de L4c) remises à `onAnnounce`, qui les met en phrases et les confie à l'annonceur de la page.
// `ActivityStore` n'importe aucun composant (.tsx) : il se teste sous Node avec une source et une horloge factices
// (server/activity-live.test.ts) ; `useActivity` le branche sur le flux du cockpit.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  ACTIVITY_MAX_DEPTH,
  ACTIVITY_MAX_SESSIONS,
  ANNOUNCE_MIN_INTERVAL_MS,
  type ActivityAnnouncement,
  type ActivityState,
  type ActivityStatus,
  type AnnouncementQueue,
  activityStatus,
  announcements,
  applyEvent,
  EMPTY_ANNOUNCEMENTS,
  emptyActivity,
  type LiveRow,
  liveRows,
  replayFacts,
  replayMessages,
} from "../../server/shared/activity.ts";
import { detailOutil } from "../../server/shared/activity-texts.ts";
import { activityApi } from "./api-activity.ts";
import { oc } from "./api.ts";
import { eventBus } from "./events.ts";
import type { ActorState, BrowserEvent, FactsResponse } from "./types.ts";

/** Au plus 4 rendus par seconde (§3.10). */
export const RENDER_MIN_INTERVAL_MS = 250;
/** Rafraîchissement des durées tant que l'arbre travaille. */
export const DURATION_TICK_MS = 1_000;
/** Détails d'outil gardés (chemin ou motif en cours, par appel d'outil). */
export const TOOL_DETAILS_MAX = 200;
/** Lectures simultanées pendant une relecture (enfants, messages). */
const READ_CONCURRENCY = 4;
/** Identifiant de `ui.seenOnboarding` du premier bandeau (§5.4). */
export const ONBOARDING_KEY = "qui-travaille";
/** Identifiants gardés dans `ui.seenOnboarding` (borne du schéma des réglages, server/settings.ts). */
export const SEEN_ONBOARDING_MAX = 20;

/** `ui.seenOnboarding` avec `key` ajouté en dernier (sans doublon), les plus anciens oubliés au-delà de la borne du schéma. */
export function seenOnboardingWith(seen: readonly string[], key: string): string[] {
  return [...seen.filter((k) => k !== key), key].slice(-SEEN_ONBOARDING_MAX);
}

/**
 * Premier bandeau (§5.4) : `ui.seenOnboarding` à enregistrer quand le bandeau se montre et que sa phrase d'accueil n'a jamais été
 * vue ; null sinon (rien à écrire).
 */
export function onboardingToSave(bannerShown: boolean, seen: readonly string[]): string[] | null {
  return bannerShown && !seen.includes(ONBOARDING_KEY) ? seenOnboardingWith(seen, ONBOARDING_KEY) : null;
}

/**
 * [Voir le travail] : seulement une conversation déléguée qui existe (ni la conversation elle-même, ni une délégation sans session,
 * ni le « Contrôle de sécurité », session interne du cockpit).
 */
export function opensWork(row: Pick<LiveRow, "sansSession" | "depth" | "role">): boolean {
  return !row.sansSession && row.depth > 0 && row.role !== "controle";
}

/** États où l'arbre travaille encore : « Arrêter » reste visible (onTreeWorking), le bandeau reste déplié. */
const ACTIVE_STATES: ReadonlySet<ActorState> = new Set<ActorState>([
  "prepare-delegation",
  "travaille",
  "redige",
  "attend-delegation",
  "attente-accord",
  "controle",
  "attend-verification",
  "nouvelle-tentative",
]);

/** Un acteur de l'arbre travaille ou attend votre accord. */
export function treeWorking(rows: readonly LiveRow[]): boolean {
  return rows.some((row) => ACTIVE_STATES.has(row.state));
}

/**
 * §5.1 : le bandeau apparaît dès qu'un second acteur, une attente de votre accord ou une demande automatique (choix
 * « Modifications automatiques » ou « Autonome avec contrôle », ou décision du cockpit) existe ; il reste ensuite, replié en fin de
 * demande.
 */
export function bannerVisible(state: ActivityState, rows: readonly LiveRow[], status: ActivityStatus): boolean {
  if (rows.length >= 2 || rows.some((row) => row.permissionId !== null)) return true;
  if (status.choix !== null && (status.choix.choix === "modifications" || status.choix.choix === "autonome")) return true;
  return state.facts.some((fact) => fact.kind === "attente" || fact.kind === "decision");
}

/**
 * Repli d'office de la bande néon et de « Qui travaille ? » tant qu'une demande attend votre réponse (ligne avec [Répondre] :
 * modification, commande ou délégation) : en mode Simple seulement, où la bande est repliée par défaut et où la place va à la carte
 * de la demande. En mode Avancé, jamais (clôture de l'itération 1, §5.1 : bande dépliée par défaut, une ligne par acteur ; §5.7.1 et
 * §5.7.3 : attente de votre accord et préparation en pointillé fixe visibles sans clic) : si la hauteur de la fenêtre manque, les
 * bornes de activity.css, neon.css et chat.css gardent la carte de la demande, ses boutons et « Arrêter » dans la fenêtre.
 */
export function replierPendantLaDemande(advanced: boolean, rows: readonly LiveRow[]): boolean {
  return !advanced && demandeEnAttente(rows);
}

/** Une demande de l'arbre attend votre réponse (une ligne porte [Répondre]). */
export function demandeEnAttente(rows: readonly LiveRow[]): boolean {
  return rows.some((row) => row.permissionId !== null);
}

/** Ligne résumée du bandeau replié ou à 400 px : une attente de votre accord, sinon un acteur au travail, sinon la racine. */
export function mainRow(rows: readonly LiveRow[]): LiveRow | null {
  return rows.find((row) => row.state === "attente-accord") ?? rows.find((row) => row.depth > 0 && ACTIVE_STATES.has(row.state)) ?? rows[0] ?? null;
}

/** Lectures d'une relecture (navigateur : API du cockpit et proxy opencode). */
export interface ActivitySource {
  facts(rootId: string): Promise<FactsResponse>;
  /** Informations d'une session (GET /session/:id) ; null ou autre chose qu'un objet : rien à relire. */
  session(sessionId: string, directory: string): Promise<unknown>;
  children(sessionId: string, directory: string): Promise<readonly unknown[]>;
  messages(sessionId: string, directory: string): Promise<readonly unknown[]>;
}

export interface ActivityClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Ce que l'interface lit ; un nouvel objet à chaque rendu (au plus 4 par seconde). */
export interface ActivityView {
  state: ActivityState;
  rows: readonly LiveRow[];
  status: ActivityStatus;
  /** « Déroulé partiel » : bornes du réducteur (3 niveaux, 50 sessions) ou des faits (20 000). */
  partial: boolean;
  working: boolean;
  /** Première relecture terminée (réussie ou non). */
  loaded: boolean;
  /** Dernière relecture en échec : l'état reste alimenté en direct. */
  failed: boolean;
  /** Détail en cours (chemin, motif) par appel d'outil, déjà masqué et raccourci. */
  details: ReadonlyMap<string, string>;
  now: number;
}

const RELEVANT_OPENCODE = new Set(["session.created", "session.updated", "message.updated", "message.part.updated"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Exécute `task` sur chaque élément, au plus `limit` à la fois ; rend les résultats dans l'ordre. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(task))));
  return out;
}

/** État d'activité d'une conversation, alimenté par le flux et les relectures ; lève RangeError si l'identifiant est invalide. */
export class ActivityStore {
  readonly rootId: string;
  readonly #directory: string;
  readonly #source: ActivitySource;
  readonly #clock: ActivityClock;
  readonly #onAnnounce: (items: readonly ActivityAnnouncement[]) => void;
  #state: ActivityState;
  #announced: ActivityState;
  #queue: AnnouncementQueue = EMPTY_ANNOUNCEMENTS;
  readonly #details = new Map<string, string>();
  #factsPartial = false;
  #loaded = false;
  #failed = false;
  #generation = 0;
  #running = false;
  #view: ActivityView;
  readonly #listeners = new Set<() => void>();
  #lastRender: number | null = null;
  #renderTimer: unknown = null;
  #announceTimer: unknown = null;
  #tickTimer: unknown = null;

  constructor(rootId: string, directory: string, source: ActivitySource, clock: ActivityClock, onAnnounce?: (items: readonly ActivityAnnouncement[]) => void) {
    this.rootId = rootId;
    this.#directory = directory;
    this.#source = source;
    this.#clock = clock;
    this.#onAnnounce = onAnnounce ?? (() => undefined);
    this.#state = emptyActivity(rootId);
    this.#announced = this.#state;
    this.#view = this.#compute(clock.now());
  }

  readonly getSnapshot = (): ActivityView => this.#view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Branche le magasin (montage) : première relecture. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.reload();
  }

  /** Débranche le magasin (démontage) : minuteries arrêtées, relecture en cours ignorée ; `start` le rebranche. */
  stop(): void {
    this.#running = false;
    this.#generation++;
    for (const timer of [this.#renderTimer, this.#announceTimer, this.#tickTimer]) if (timer !== null) this.#clock.clearTimer(timer);
    this.#renderTimer = null;
    this.#announceTimer = null;
    this.#tickTimer = null;
  }

  /** Un élément du flux du cockpit (SSE). */
  push(event: BrowserEvent): void {
    if (!this.#running) return;
    if (event.kind === "cockpit") {
      if (event.type === "stream.reconnected") void this.reload();
      else if (event.type === "activite.fait") this.#set(applyEvent(this.#state, event));
      return;
    }
    const { type, properties } = event.event;
    if (!RELEVANT_OPENCODE.has(type)) return;
    if (type === "message.part.updated") this.#toolPart(properties);
    else this.#set(applyEvent(this.#state, { kind: "opencode", event: event.event }));
  }

  /** Relecture complète (ouverture, reconnexion, [Réessayer]) ; une relecture plus récente l'emporte. */
  async reload(): Promise<void> {
    if (!this.#running) return;
    const generation = ++this.#generation;
    const stale = () => !this.#running || generation !== this.#generation;
    try {
      const persisted = await this.#source.facts(this.rootId);
      if (stale()) return;
      this.#state = replayFacts(this.#state, Array.isArray(persisted.facts) ? persisted.facts : []);
      this.#factsPartial = persisted.partial === true;
      const reconstruct = this.#state.facts.length === 0;
      this.#settle(false);
      const [root, sessions] = await Promise.all([this.#root(), this.#tree(stale)]);
      if (stale()) return;
      const ids = [this.rootId, ...sessions.map((info) => (isRecord(info) && typeof info.id === "string" ? info.id : null)).filter((id) => id !== null)];
      const messages = reconstruct ? (await mapLimited(ids, READ_CONCURRENCY, (id) => this.#source.messages(id, this.#directory))).flat() : [];
      if (stale()) return;
      // Conversation neuve (ni faits, ni sessions, ni messages) : rien à reconstruire, les faits arriveront en direct.
      if (!reconstruct || sessions.length > 0 || messages.length > 0) {
        this.#state = replayMessages(this.#state, { sessions: root === null ? sessions : [root, ...sessions], messages });
      }
      this.#settle(false);
    } catch (err) {
      if (stale()) return;
      // Faits illisibles, ou conversation d'avant la 1.1 impossible à reconstruire : dit par l'interface ([Réessayer]) ; l'état reste
      // alimenté en direct. Les titres illisibles, eux, sont seulement sautés (#tree).
      this.#settle(true);
      console.warn("« Qui travaille ? » : relecture impossible", err);
    }
  }

  /** Fin d'une étape de relecture : ce qu'elle révèle n'est pas annoncé ; rendu dans la limite de 4 par seconde. */
  #settle(failed: boolean): void {
    this.#loaded = true;
    this.#failed = failed;
    this.#announced = this.#state;
    this.#queue = EMPTY_ANNOUNCEMENTS;
    this.#schedule();
  }

  /**
   * Informations de la conversation elle-même (titre, assistant de sa dernière demande) : ce que session.updated donne en direct à un
   * onglet ouvert avant. Une lecture en échec est seulement sautée, comme les titres de l'arbre.
   */
  async #root(): Promise<Record<string, unknown> | null> {
    try {
      const info = await this.#source.session(this.rootId, this.#directory);
      return isRecord(info) && info.id === this.rootId ? info : null;
    } catch (err) {
      console.warn("« Qui travaille ? » : informations de la conversation illisibles", err);
      return null;
    }
  }

  /** Sessions de l'arbre, niveau par niveau (3 niveaux et 50 sessions au plus) ; une lecture en échec est seulement sautée. */
  async #tree(stale: () => boolean): Promise<unknown[]> {
    const found: unknown[] = [];
    let level = [this.rootId];
    for (let depth = 1; depth <= ACTIVITY_MAX_DEPTH && level.length > 0; depth++) {
      const lists = await mapLimited(level, READ_CONCURRENCY, async (id) => {
        try {
          return await this.#source.children(id, this.#directory);
        } catch (err) {
          console.warn("« Qui travaille ? » : sessions déléguées illisibles", err);
          return [];
        }
      });
      if (stale()) return found;
      const next: string[] = [];
      for (const info of lists.flat()) {
        if (!isRecord(info) || typeof info.id !== "string" || found.length >= ACTIVITY_MAX_SESSIONS) continue;
        found.push(info);
        next.push(info.id);
      }
      level = next;
    }
    return found;
  }

  #inTree(sessionId: string): boolean {
    return sessionId === this.rootId || this.#state.sessions.has(sessionId) || this.#view.rows.some((row) => row.sessionId === sessionId);
  }

  /** Partie d'outil d'une session de l'arbre : détail en cours (chemin, motif), oublié à la fin de l'outil. */
  #toolPart(properties: Record<string, unknown>): void {
    const part = properties.part;
    if (!isRecord(part) || part.type !== "tool" || typeof part.callID !== "string" || typeof part.tool !== "string") return;
    if (typeof part.sessionID !== "string" || !this.#inTree(part.sessionID)) return;
    const state = isRecord(part.state) ? part.state : {};
    const running = state.status === "pending" || state.status === "running";
    const detail = running ? detailOutil(part.tool, state.input, this.#directory) : null;
    const before = this.#details.get(part.callID) ?? null;
    if (detail === before) return;
    this.#details.delete(part.callID);
    if (detail !== null) {
      this.#details.set(part.callID, detail);
      if (this.#details.size > TOOL_DETAILS_MAX) this.#details.delete(this.#details.keys().next().value as string);
    }
    this.#schedule();
  }

  #set(next: ActivityState): void {
    if (next === this.#state) return;
    this.#state = next;
    this.#schedule();
  }

  /** Rendu au plus tous les RENDER_MIN_INTERVAL_MS : tout de suite si le dernier est assez ancien, sinon à l'échéance. */
  #schedule(): void {
    if (!this.#running || this.#renderTimer !== null) return;
    const wait = this.#lastRender === null ? 0 : this.#lastRender + RENDER_MIN_INTERVAL_MS - this.#clock.now();
    if (wait <= 0) {
      this.#render();
      return;
    }
    this.#renderTimer = this.#clock.setTimer(() => {
      this.#renderTimer = null;
      this.#render();
    }, wait);
  }

  #compute(now: number): ActivityView {
    const rows = liveRows(this.#state, now);
    const status = activityStatus(this.#state);
    return {
      state: this.#state,
      rows,
      status,
      partial: this.#factsPartial || status.partial,
      working: treeWorking(rows),
      loaded: this.#loaded,
      failed: this.#failed,
      details: new Map(this.#details),
      now,
    };
  }

  #render(): void {
    if (!this.#running) return;
    if (this.#renderTimer !== null) this.#clock.clearTimer(this.#renderTimer);
    this.#renderTimer = null;
    const now = this.#clock.now();
    this.#lastRender = now;
    this.#view = this.#compute(now);
    this.#announce();
    if (this.#view.working && this.#tickTimer === null) {
      this.#tickTimer = this.#clock.setTimer(() => {
        this.#tickTimer = null;
        this.#schedule();
      }, DURATION_TICK_MS);
    }
    for (const listener of this.#listeners) listener();
  }

  /** Transitions depuis la dernière annonce (L4c : au plus une toutes les 2 s) ; la file restante est vidée à l'échéance. */
  #announce(): void {
    if (!this.#running) return;
    if (!this.#loaded) {
      this.#announced = this.#state;
      return;
    }
    const now = this.#clock.now();
    const { say, queue } = announcements(this.#announced, this.#state, now, this.#queue);
    this.#announced = this.#state;
    this.#queue = queue;
    if (say !== null) this.#onAnnounce(say);
    if (queue.pending.length > 0 && this.#announceTimer === null) {
      const wait = queue.lastAt === null ? 0 : Math.max(0, queue.lastAt + ANNOUNCE_MIN_INTERVAL_MS - now);
      this.#announceTimer = this.#clock.setTimer(() => {
        this.#announceTimer = null;
        this.#announce();
      }, wait);
    }
  }
}

const browserSource: ActivitySource = {
  facts: (rootId) => activityApi.facts(rootId, 0),
  session: (sessionId, directory) => oc.session(sessionId, directory),
  children: (sessionId, directory) => oc.children(sessionId, directory),
  messages: (sessionId, directory) => oc.messages(sessionId, directory),
};

const browserClock: ActivityClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Activité de la conversation `rootId` (identifiant valide, vérifié par l'appelant) : vue rendue au plus 4 fois par seconde,
 * relecture à l'ouverture et à la reconnexion du flux ; `onAnnounce` reçoit les transitions à annoncer (au plus une fois toutes
 * les 2 s). `reload` : [Réessayer].
 */
export function useActivity(
  rootId: string,
  directory: string,
  onAnnounce?: (items: readonly ActivityAnnouncement[]) => void,
): ActivityView & { reload: () => void } {
  const announceRef = useRef(onAnnounce);
  announceRef.current = onAnnounce;
  const store = useMemo(
    () => new ActivityStore(rootId, directory, browserSource, browserClock, (items) => announceRef.current?.(items)),
    [rootId, directory],
  );
  useEffect(() => {
    store.start();
    const off = eventBus.subscribe((event) => store.push(event));
    return () => {
      off();
      store.stop();
    };
  }, [store]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({ ...view, reload: () => void store.reload() }), [view, store]);
}
