// Propriétaire : L5t puis L12c.
// Déroulé d'une conversation, dans le panneau de contexte et dans les Archives (spécification §5.1, §5.4, §5.5, §4.12, §2.2) :
// demande choisie ; barres génération, attente de délégation, attente de vous (hachure + « vous ») ; « Prévu / Réel » et écarts ;
// [Tableau] ; emplacement du Journal du contrôle (rempli par L12c) ; « Temps d'attente non enregistré avant la 1.1 ». La pause
// d'une équipe (hachure + « vérification ») viendra avec les équipes (itération 4) : aucun fait ne la porte encore.
// Un seul modèle (P12) : le réducteur server/shared/activity.ts (L4c) sur les faits de la conversation (GET …/facts, puis
// `activite.fait` en direct), avec les informations de session d'opencode (GET /session/:id et /children à la relecture,
// session.updated en direct : titres et assistant de la conversation) ; une conversation sans faits (avant la 1.1) est reconstruite
// depuis le registre (GET …/activity) et
// l'arbre d'opencode (GET /session/:id/children), ou les délégations du registre quand opencode ne l'a plus (Archives). Ce même
// état sert le pied de tour de la transcription (MessageView, useConversationValue) : au plus 4 avis par seconde.
// Propriétés figées dans ../slots.ts. Titres et noms venus d'opencode : texte échappé par React. Aucune animation
// (web-animations.test.ts) ; la hachure et le mot « vous » disent l'attente, jamais la couleur seule.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ACTIVITY_MAX_DEPTH,
  ACTIVITY_MAX_SESSIONS,
  type ActivityState,
  type ActivityTotals,
  activityStatus,
  applyEvent,
  emptyActivity,
  fromLedger,
  type LedgerSession,
  type LiveRow,
  liveRows,
  replayFacts,
  replayMessages,
  type TimelineBarKind,
  timeline,
  totals,
} from "../../../../server/shared/activity.ts";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { activityApi } from "../../../lib/api-activity.ts";
import { errorText, oc } from "../../../lib/api.ts";
import { eventBus } from "../../../lib/events.ts";
import { formatDuration, formatTime, formatUsd, plural } from "../../../lib/format.ts";
import type { ActivityResponse, ActorState, BrowserEvent, OcSession } from "../../../lib/types.ts";
import type { DerouleProps } from "../slots.ts";
import { builtinTitle, gapsText, type Planned, plannedOf } from "../turn.ts";
// <c5:chronologie>
// Itération 5 (L47b, D-5-09) : en mode Avancé, le Déroulé porte une bascule « Déroulé | Chronologie ». La chronologie est un
// réglage du mode Avancé (« jeton » est interdit en Simple) : en Simple, la bascule est ABSENTE et rien n'est lu.
import { BasculeChronologie, Chronologie, type VueDeroule } from "./Chronologie.tsx";
// </c5:chronologie>
import "./deroule.css";

// --- État partagé d'une conversation -------------------------------------------------------------------------------------------

/** Données d'une conversation : état du réducteur (null tant que rien n'est lu), « Déroulé partiel » du magasin, erreur de lecture. */
export interface ConversationActivity {
  state: ActivityState | null;
  partial: boolean;
  error: string | null;
}

const EMPTY_ACTIVITY: ConversationActivity = Object.freeze({ state: null, partial: false, error: null });
/** Au plus 4 avis aux abonnés par seconde (§3.10). */
const NOTIFY_MIN_MS = 250;
/** Relecture regroupée (reconnexion, faits d'une conversation reconstruite, coût mis à jour). */
const RELOAD_DELAY_MS = 500;
/** Conversation sans abonné gardée ce temps (double montage de React, panneau fermé puis rouvert). */
const DISPOSE_AFTER_MS = 5_000;
/** Événements gardés pendant une lecture, appliqués ensuite (au-delà : la lecture suivante les retrouve dans le magasin). */
const BUFFER_MAX = 5_000;
/** Usages de session du cockpit (metadata.cockpit) ; tout autre usage est une conversation ou une délégation. */
const COCKPIT_PURPOSES: ReadonlySet<string> = new Set(["controle", "equipe", "classifier"]);

function purposeOf(session: OcSession): string {
  const cockpit = (session as { metadata?: { cockpit?: unknown } }).metadata?.cockpit;
  return typeof cockpit === "string" && COCKPIT_PURPOSES.has(cockpit) ? cockpit : "chat";
}

class ConversationStore {
  readonly rootId: string;
  #data: ConversationActivity = EMPTY_ACTIVITY;
  readonly #listeners = new Set<() => void>();
  #stopEvents: (() => void) | null = null;
  /** Numéro de la lecture en cours : une lecture dépassée n'écrit rien. */
  #seq = 0;
  #loading = false;
  #buffer: BrowserEvent[] = [];
  #lastNotify = 0;
  #notifyTimer: ReturnType<typeof setTimeout> | null = null;
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #disposeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rootId: string) {
    this.rootId = rootId;
  }

  get data(): ConversationActivity {
    return this.#data;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#disposeTimer !== null) {
      clearTimeout(this.#disposeTimer);
      this.#disposeTimer = null;
    }
    if (this.#stopEvents === null) {
      this.#stopEvents = eventBus.subscribe((event) => this.#onEvent(event));
      void this.reload();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#disposeTimer === null) this.#disposeTimer = setTimeout(() => this.#dispose(), DISPOSE_AFTER_MS);
    };
  }

  /** Coût changé (usage.updated) : seule une conversation reconstruite depuis le registre se relit, les faits arrivent en direct. */
  refresh(): void {
    if (this.#data.state !== null && this.#data.state.source !== "faits") this.#scheduleReload();
  }

  async reload(): Promise<void> {
    const seq = ++this.#seq;
    this.#loading = true;
    try {
      const persisted = await activityApi.facts(this.rootId, 0);
      if (seq !== this.#seq) return;
      let next: ConversationActivity;
      if (persisted.facts.length > 0) {
        const base = this.#data.state?.source === "faits" ? this.#data.state : emptyActivity(this.rootId);
        // Titres (mode Avancé) et assistant de la conversation (« Conversation · … »), comme en direct (session.updated) : informations
        // de la conversation et de ses enfants, relues par le même réducteur, sans aucun message.
        const sessions = await this.#sessions();
        if (seq !== this.#seq) return;
        next = { state: replayMessages(replayFacts(base, persisted.facts), { sessions, messages: [] }), partial: persisted.partial, error: null };
      } else {
        // Avant la 1.1 : aucun fait. Registre des coûts et arbre des sessions ; les attentes n'ont pas été enregistrées.
        const [activity, sessions] = await Promise.all([activityApi.activity(this.rootId), this.#tree()]);
        if (seq !== this.#seq) return;
        next = { state: fromLedger(this.rootId, activity, withDelegations(sessions, activity)), partial: false, error: null };
      }
      let state = next.state as ActivityState;
      if (state.source === "faits") for (const event of this.#buffer) state = applyEvent(state, event);
      this.#set({ ...next, state });
    } catch (err) {
      if (seq === this.#seq) this.#set({ ...this.#data, error: errorText(err) });
    } finally {
      if (seq === this.#seq) {
        this.#loading = false;
        this.#buffer = [];
      }
    }
  }

  /** Arbre des sessions d'après opencode, borné comme le réducteur (3 niveaux, 50 sessions). */
  async #tree(): Promise<LedgerSession[]> {
    const children = await this.#children();
    return [
      { id: this.rootId, parentId: null, purpose: "chat" },
      ...children.map(({ session, parentId }) => ({ id: session.id, parentId, purpose: purposeOf(session), title: session.title })),
    ];
  }

  /**
   * Informations de session d'une conversation qui a des faits, telles qu'opencode les sert : la conversation elle-même (titre,
   * assistant de sa dernière demande), puis ses enfants (titres), bornés comme le réducteur.
   */
  async #sessions(): Promise<OcSession[]> {
    // Conversation qu'opencode n'a plus (supprimée, gardée aux Archives) : rien à relire, les faits suffisent au Déroulé.
    const [root, children] = await Promise.all([oc.session(this.rootId).then((info) => info, () => null), this.#children()]);
    return [...(root === null ? [] : [root]), ...children.map(({ session }) => session)];
  }

  /** Enfants d'après opencode, chacun avec la session qui l'a lancé : 3 niveaux et 50 sessions au plus, conversation comprise. */
  async #children(): Promise<Array<{ session: OcSession; parentId: string }>> {
    const out: Array<{ session: OcSession; parentId: string }> = [];
    let frontier = [this.rootId];
    for (let depth = 0; depth < ACTIVITY_MAX_DEPTH && frontier.length > 0 && out.length + 1 < ACTIVITY_MAX_SESSIONS; depth++) {
      // Une session qu'opencode n'a plus (conversation supprimée, gardée aux Archives) n'a pas d'enfants lisibles : l'arbre vient
      // alors des délégations du registre (withDelegations).
      const results = await Promise.allSettled(frontier.map((id) => oc.children(id)));
      const next: string[] = [];
      results.forEach((result, index) => {
        const parentId = frontier[index] as string;
        if (result.status !== "fulfilled") return;
        for (const child of result.value) {
          if (out.length + 1 >= ACTIVITY_MAX_SESSIONS) return;
          out.push({ session: child, parentId });
          next.push(child.id);
        }
      });
      frontier = next;
    }
    return out;
  }

  #onEvent(event: BrowserEvent): void {
    if (event.kind === "cockpit") {
      if (event.type === "stream.reconnected") {
        this.#scheduleReload();
        return;
      }
      if (event.type !== "activite.fait" || (event.data as { rootId?: unknown } | null)?.rootId !== this.rootId) return;
      // Premier fait d'une conversation reconstruite : les faits font désormais foi.
      if (this.#data.state !== null && this.#data.state.source !== "faits" && !this.#loading) {
        this.#scheduleReload();
        return;
      }
    } else if (!["session.created", "session.updated", "message.updated"].includes(event.event.type)) {
      return;
    }
    if (this.#loading) {
      if (this.#buffer.length < BUFFER_MAX) this.#buffer.push(event);
      return;
    }
    const state = this.#data.state;
    if (state === null) return;
    const next = applyEvent(state, event);
    if (next !== state) this.#set({ ...this.#data, state: next });
  }

  #scheduleReload(): void {
    if (this.#reloadTimer !== null) return;
    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      void this.reload();
    }, RELOAD_DELAY_MS);
  }

  #set(next: ConversationActivity): void {
    this.#data = next;
    if (this.#notifyTimer !== null) return;
    const wait = Math.max(0, this.#lastNotify + NOTIFY_MIN_MS - Date.now());
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      this.#lastNotify = Date.now();
      for (const listener of [...this.#listeners]) listener();
    }, wait);
  }

  #dispose(): void {
    this.#disposeTimer = null;
    if (this.#listeners.size > 0) return;
    this.#stopEvents?.();
    this.#stopEvents = null;
    this.#seq++;
    for (const timer of [this.#notifyTimer, this.#reloadTimer]) if (timer !== null) clearTimeout(timer);
    this.#notifyTimer = null;
    this.#reloadTimer = null;
    if (STORES.get(this.rootId) === this) STORES.delete(this.rootId);
  }
}

/** Sessions d'opencode complétées par les délégations du registre (enfant dont le parent est connu). */
function withDelegations(sessions: LedgerSession[], activity: ActivityResponse): LedgerSession[] {
  const out = [...sessions];
  const known = new Set(out.map((s) => s.id));
  for (let pass = 0; pass < ACTIVITY_MAX_DEPTH; pass++) {
    for (const d of activity.delegations) {
      if (out.length >= ACTIVITY_MAX_SESSIONS) return out;
      if (d.childSessionId === null || known.has(d.childSessionId) || !known.has(d.parentSessionId)) continue;
      out.push({ id: d.childSessionId, parentId: d.parentSessionId, purpose: "chat" });
      known.add(d.childSessionId);
    }
  }
  return out;
}

const STORES = new Map<string, ConversationStore>();

function storeOf(rootId: string): ConversationStore {
  let store = STORES.get(rootId);
  if (!store) {
    store = new ConversationStore(rootId);
    STORES.set(rootId, store);
  }
  return store;
}

function useStoreSubscription(rootId: string | null): (listener: () => void) => () => void {
  return useMemo(() => (listener: () => void) => (rootId === null ? () => undefined : storeOf(rootId).subscribe(listener)), [rootId]);
}

const dataOf = (rootId: string | null): ConversationActivity => (rootId === null ? EMPTY_ACTIVITY : (STORES.get(rootId)?.data ?? EMPTY_ACTIVITY));

/**
 * Activité d'une conversation (racine), partagée par le Déroulé et le pied de tour ; null : aucune lecture (tiroir d'un travail
 * délégué, par exemple). La première souscription lit les faits, les suivantes réutilisent l'état.
 */
export function useConversationActivity(rootId: string | null): ConversationActivity {
  const subscribe = useStoreSubscription(rootId);
  const snapshot = () => dataOf(rootId);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Valeur SIMPLE (texte, nombre, booléen) tirée de l'activité d'une conversation : le composant n'est redessiné que si elle change
 * (pied de tour : une demande terminée ne se redessine pas à chaque fait d'une autre).
 */
export function useConversationValue<T extends string | number | boolean | null>(rootId: string | null, select: (data: ConversationActivity) => T): T {
  const subscribe = useStoreSubscription(rootId);
  const snapshot = () => select(dataOf(rootId));
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// --- Vue du Déroulé -------------------------------------------------------------------------------------------------------------

/** Libellés des états (§2.3) : le mot sert de texte accessible, l'icône l'accompagne. */
const STATE_VIEW: Readonly<Record<ActorState, { label: string; icon: IconName }>> = {
  "pas-commence": { label: "pas encore commencé", icon: "circle" },
  "prepare-delegation": { label: "prépare une délégation", icon: "hourglass" },
  travaille: { label: "travaille", icon: "pulse" },
  redige: { label: "rédige sa réponse", icon: "edit" },
  "attend-delegation": { label: "attend le travail délégué", icon: "hourglass" },
  "attente-accord": { label: "en attente de votre accord", icon: "hourglass" },
  controle: { label: "contrôle de sécurité en cours", icon: "shield" },
  "attend-verification": { label: "attend votre vérification", icon: "pause" },
  "nouvelle-tentative": { label: "nouvelle tentative", icon: "refresh" },
  termine: { label: "terminé", icon: "check" },
  echec: { label: "échec", icon: "alert" },
  arrete: { label: "arrêté", icon: "stop" },
  "jamais-demarre": { label: "jamais démarré", icon: "minus" },
  "non-choisi": { label: "non choisi", icon: "minus" },
};

/** Barres (§5.1) : génération, attente de délégation, attente de vous (hachure + « vous »). */
const BAR_TEXT: Readonly<Record<TimelineBarKind, string>> = {
  generation: "génération",
  "attente-delegation": "attente de délégation",
  "attente-vous": "attente de vous",
};

const AVANT_11 = "Temps d'attente non enregistré avant la 1.1";
const TOUT = "tout";

interface Window {
  from: number;
  /** null : jusqu'au bout (dernière demande, ou toute la conversation). */
  to: number | null;
}

interface RequestChoice {
  value: string;
  label: string;
  window: Window | null;
}

interface BarView {
  kind: TimelineBarKind;
  left: number;
  width: number;
  durationMs: number;
}

interface RowView {
  key: string;
  depth: number;
  who: string;
  title: string | null;
  /** État réel ; null : inconnu pour cette demande (conversation, demande passée). */
  state: ActorState | null;
  attempt: number | null;
  /** Prévu : lancé par votre demande, décidé par l'IA, contrôle du cockpit, ou inconnu faute de fait (plannedOf). */
  prevu: Planned;
  start: number | null;
  durationMs: number | null;
  cost: number;
  bars: BarView[];
}

/** Demandes de la conversation : messages de l'utilisateur de la racine (fait « origine » de genre « demande »). */
function requestsOf(state: ActivityState): RequestChoice[] {
  const starts = [
    ...new Set(state.facts.filter((f) => f.kind === "origine" && f.sessionId === state.rootId && f.data.origine === "demande").map((f) => f.at)),
  ].sort((a, b) => a - b);
  return starts.map((from, i) => ({ value: String(i), label: `Demande ${i + 1} · ${formatTime(from)}`, window: { from, to: starts[i + 1] ?? null } }));
}

const assistantName = (agent: string | null): string | null => (agent ? (builtinTitle(agent) ?? agent) : null);

function whoOf(row: LiveRow): string {
  const name = assistantName(row.agent);
  if (row.depth === 0) return name ? `Conversation · ${name}` : "Conversation";
  if (row.role === "controle") return "Contrôle de sécurité";
  if (row.role === "etape") return name ? `Étape · ${name}` : "Étape";
  return name ?? "Travail délégué";
}

function stateLabel(row: RowView): string {
  if (row.state === null) return "—";
  const label = STATE_VIEW[row.state].label;
  return row.state === "nouvelle-tentative" && row.attempt !== null ? `${label} (${row.attempt})` : label;
}

/** Lignes du Déroulé dans une fenêtre : barres coupées à la fenêtre, positions en pourcentage de la durée montrée. */
function buildRows(state: ActivityState, window: Window | null, now: number, past: boolean): RowView[] {
  const live = new Map(liveRows(state, now).map((row) => [row.key, row]));
  const lines = timeline(state);
  const firstStart = Math.min(...lines.map((l) => l.start ?? l.bars[0]?.start ?? Number.POSITIVE_INFINITY));
  const from = window?.from ?? (Number.isFinite(firstStart) ? firstStart : now);
  const limit = window?.to ?? Number.POSITIVE_INFINITY;
  const clip = (start: number, end: number | null): [number, number] => [Math.max(start, from), Math.min(end ?? now, limit)];
  const kept = lines.filter((line) => {
    if (line.depth === 0) return true;
    const start = line.start ?? line.bars[0]?.start ?? null;
    if (start === null) return window === null;
    const [a, b] = clip(start, line.end);
    return a < b || (start >= from && start < limit);
  });
  let to = from + 1;
  for (const line of kept) {
    for (const bar of line.bars) {
      const [a, b] = clip(bar.start, bar.end);
      if (b > a) to = Math.max(to, b);
    }
  }
  const span = to - from;
  return kept.map((line) => {
    const row = live.get(line.key);
    const bars: BarView[] = [];
    for (const bar of line.bars) {
      const [a, b] = clip(bar.start, bar.end);
      if (b <= a) continue;
      bars.push({ kind: bar.kind, left: ((a - from) / span) * 100, width: Math.max(0.5, ((b - a) / span) * 100), durationMs: b - a });
    }
    const [a, b] = line.start === null ? [0, 0] : clip(line.start, line.end);
    return {
      key: line.key,
      depth: Math.min(line.depth, ACTIVITY_MAX_DEPTH),
      who: row ? whoOf(row) : "Travail délégué",
      title: row?.title ? row.title : null,
      // Demande passée : l'état courant de la conversation ne dit rien de cette demande-là.
      state: row && !(past && line.depth === 0) ? row.state : null,
      attempt: row?.attempt ?? null,
      prevu: plannedOf(row ?? null),
      start: line.start === null ? null : Math.max(line.start, from),
      durationMs: line.start === null ? null : Math.max(0, b - a),
      cost: line.calls.filter((c) => c.start >= from && c.start < limit).reduce((sum, c) => sum + c.cost, 0),
      bars,
    };
  });
}

/** Écarts avec le prévu (§5.1), comptés sur les lignes montrées ; phrase de gapsText (turn.ts). */
function ecartsOf(rows: readonly RowView[]): string {
  const count = (test: (row: RowView) => boolean) => rows.filter(test).length;
  return gapsText({
    nonPrevus: count((r) => r.prevu.kind === "non-prevu"),
    inconnus: count((r) => r.prevu.kind === "inconnu"),
    jamais: count((r) => r.state === "jamais-demarre"),
    echecs: count((r) => r.state === "echec"),
    arrets: count((r) => r.state === "arrete"),
  });
}

/** Libellé chiffré de la figure (§5.5) : intervenants, coût et appels d'IA de la demande choisie. */
function captionOf(rows: readonly RowView[], sum: ActivityTotals | null): string {
  const figures = [plural(rows.length, "intervenant", "intervenants")];
  if (sum) figures.push(formatUsd(sum.cost), plural(sum.calls, "appel d'IA", "appels d'IA"));
  return `Déroulé : ${figures.join(", ")}`;
}

/** Dernier [Journal] montré, par conversation : un panneau rouvert plus tard ne reprend pas le focus. */
const JOURNAL_SHOWN = new Map<string, number>();

export function Deroule(props: DerouleProps) {
  // Une conversation par instance : la demande choisie et l'affichage repartent de zéro à chaque changement de conversation.
  return <DerouleView key={props.rootId} {...props} />;
}

/** Lecture des données : magasin de la conversation, relu quand le coût change (usage.updated). */
function DerouleView({ usageTick, ...props }: DerouleProps) {
  const activity = useConversationActivity(props.rootId);
  useEffect(() => {
    if (usageTick) STORES.get(props.rootId)?.refresh();
  }, [props.rootId, usageTick]);
  return <DerouleContent {...props} activity={activity} />;
}

/** Propriétés de la vue du Déroulé : celles de l'emplacement, avec l'activité déjà lue. */
export type DerouleContentProps = Omit<DerouleProps, "usageTick"> & { activity: ConversationActivity };

/** Tableau du Déroulé (§5.5 : `<table>` pour la chronologie) : qui, prévu, réel, début, durée, coût. */
function DerouleTable({ rows }: { rows: readonly RowView[] }) {
  return (
    <div className="table-wrap">
      <table className="table deroule-table">
        <caption className="visually-hidden">Déroulé : prévu et réel de chaque intervenant</caption>
        <thead>
          <tr>
            <th scope="col">Qui</th>
            <th scope="col">Prévu</th>
            <th scope="col">Réel</th>
            <th scope="col">Début</th>
            <th scope="col" className="num">
              Durée
            </th>
            <th scope="col" className="num">
              Coût
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="deroule-cell-who" style={{ paddingLeft: `${4 + row.depth * 10}px` }}>
                {row.who}
              </th>
              <td>{row.prevu.text}</td>
              <td>{stateLabel(row)}</td>
              <td className="nowrap">{row.start === null ? "—" : formatTime(row.start)}</td>
              <td className="num nowrap">{row.durationMs === null ? "—" : formatDuration(row.durationMs)}</td>
              <td className="num nowrap">{formatUsd(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Barres du Déroulé (§5.1, §5.5) : `<figure>` à libellé chiffré ; barres décoratives, leur texte dit pour le lecteur d'écran. */
function DerouleBars({ rows, advanced, caption }: { rows: readonly RowView[]; advanced: boolean; caption: string }) {
  const captionId = useId();
  return (
    <figure className="deroule-figure" aria-labelledby={captionId}>
      <figcaption id={captionId} className="visually-hidden">
        {caption}
      </figcaption>
      <ol className="deroule-rows">
        {rows.map((row) => (
          <li key={row.key} className="deroule-row" style={{ paddingLeft: `${row.depth * 12}px` }}>
            <div className="deroule-who">
              <span className="deroule-name ellipsis">{row.who}</span>
              {row.state === null ? null : (
                <span className="deroule-state nowrap">
                  <Icon name={STATE_VIEW[row.state].icon} size={12} />
                  {stateLabel(row)}
                </span>
              )}
            </div>
            {advanced && row.title ? <div className="tiny muted ellipsis">{row.title}</div> : null}
            <div className="deroule-track" aria-hidden="true">
              {row.bars.map((bar, i) => (
                <span
                  key={`${bar.kind}-${i}`}
                  className={`deroule-bar deroule-bar--${bar.kind}`}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  title={`${BAR_TEXT[bar.kind]} · ${formatDuration(bar.durationMs)}`}
                >
                  {bar.kind === "attente-vous" ? "vous" : null}
                </span>
              ))}
            </div>
            <span className="visually-hidden">
              {row.bars.length > 0 ? row.bars.map((bar) => `${BAR_TEXT[bar.kind]} ${formatDuration(bar.durationMs)}`).join(", ") : "aucune période enregistrée"}
              {`, prévu : ${row.prevu.text}`}
            </span>
          </li>
        ))}
      </ol>
      <ul className="deroule-legend tiny muted" aria-hidden="true">
        {(Object.keys(BAR_TEXT) as TimelineBarKind[]).map((kind) => (
          <li key={kind}>
            <span className={`deroule-swatch deroule-bar--${kind}`} />
            {BAR_TEXT[kind]}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Vue du Déroulé pour une activité déjà lue (sans magasin ni réseau) : demande choisie, barres ou tableau, écarts, Journal. */
export function DerouleContent({ activity, rootId, placement, advanced, journalNonce }: DerouleContentProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  // <c5:chronologie>
  // Vue choisie par la bascule (L47b) : « Déroulé » par défaut. En mode Simple, la bascule est absente et `chrono` reste faux,
  // donc aucune ligne `usage` n'est lue et le mot « jeton » n'apparaît jamais.
  const [vueChrono, setVueChrono] = useState<VueDeroule>("deroule");
  const chrono = advanced && vueChrono === "chronologie";
  // </c5:chronologie>
  const journalRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const journalId = useId();

  useEffect(() => {
    if (!journalNonce || JOURNAL_SHOWN.get(rootId) === journalNonce) return;
    JOURNAL_SHOWN.set(rootId, journalNonce);
    // Demandé par un clic sur [Journal] : le Déroulé montre le Journal et y place le focus, rien d'autre.
    journalRef.current?.scrollIntoView({ block: "nearest" });
    journalRef.current?.focus({ preventScroll: true });
  }, [rootId, journalNonce]);

  const state = activity.state;
  const requests = useMemo(() => (state ? requestsOf(state) : []), [state]);
  const choices: RequestChoice[] = useMemo(() => [...requests, { value: TOUT, label: "Toute la conversation", window: null }], [requests]);
  const selected = choices.find((c) => c.value === picked) ?? requests.at(-1) ?? (choices.at(-1) as RequestChoice);
  const past = selected.window !== null && selected.window.to !== null;
  const scope = selected.window === null ? "cette conversation" : "cette demande";
  const rows = state ? buildRows(state, selected.window, Date.now(), past) : [];
  const sum = useMemo(() => (state ? totals(state, selected.window ?? undefined) : null), [state, selected]);
  const status = state ? activityStatus(state) : null;
  const decisions = useMemo(() => {
    if (!state) return 0;
    const w = selected.window;
    return state.facts.filter((f) => f.kind === "decision" && (!w || (f.at >= w.from && (w.to === null || f.at < w.to)))).length;
  }, [state, selected]);

  const archives = placement === "archives";
  const Heading = archives ? "h3" : "h4";
  const SubHeading = archives ? "h4" : "h5";
  const delegated = rows.some((r) => r.depth > 0);

  return (
    <section className={archives ? "card deroule deroule--archives" : "aside-section deroule"} aria-labelledby={titleId}>
      <div className={archives ? "card-header" : "deroule-head"}>
        <Heading id={titleId}>Déroulé</Heading>
        <span className="spacer" />
        {/* <c5:chronologie> */}
        {state && advanced ? <BasculeChronologie value={vueChrono} onChange={setVueChrono} label="Vue du déroulé" /> : null}
        {state && !chrono ? (
          <Button variant="ghost" size="sm" icon="list" aria-pressed={table} onClick={() => setTable((v) => !v)}>
            Tableau
          </Button>
        ) : null}
        {/* </c5:chronologie> */}
      </div>

      {activity.error ? <div className="callout critical small">Déroulé indisponible : {activity.error}</div> : null}
      {!state && !activity.error ? <p className="small muted">Lecture du déroulé…</p> : null}

      {state ? (
        <div className="stack tight">
          {choices.length > 1 ? (
            <label className="deroule-pick small">
              <span>Demande</span>
              <select className="select sm" value={selected.value} onChange={(e) => setPicked(e.target.value)}>
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {sum ? (
            <p className="small">
              {formatUsd(sum.cost)}
              {sum.delegatedCalls > 0 ? ` dont ${formatUsd(sum.delegatedCost)} de travail délégué` : ""} · {plural(sum.calls, "appel d'IA", "appels d'IA")}
              {sum.controlCalls > 0 ? ` · contrôles de sécurité : ${formatUsd(sum.controlCost)}` : ""}
              {sum.wallMs !== null ? ` · ${formatDuration(sum.wallMs)}` : ""}
            </p>
          ) : null}

          {status && !status.attentesEnregistrees ? <p className="tiny muted deroule-note">{AVANT_11}</p> : null}
          {activity.partial || status?.partial ? (
            <p className="tiny muted deroule-note">Déroulé partiel : une partie du travail délégué n'est pas montrée.</p>
          ) : null}
          {delegated ? null : <p className="small muted">Une seule IA a travaillé sur {scope}.</p>}

          {/* <c5:chronologie> */}
          {chrono ? (
            <Chronologie rootId={rootId} state={state} partial={activity.partial} />
          ) : table ? (
            <DerouleTable rows={rows} />
          ) : (
            <DerouleBars rows={rows} advanced={advanced} caption={captionOf(rows, sum)} />
          )}
          {/* </c5:chronologie> */}

          {delegated ? <p className="tiny muted">{ecartsOf(rows)}</p> : null}

          {/* Emplacement du Journal du contrôle : L12c y pose le tableau des décisions (§4.12). */}
          <section className="deroule-journal" aria-labelledby={journalId} tabIndex={-1} ref={journalRef}>
            <SubHeading id={journalId}>Journal du contrôle</SubHeading>
            <p className="small muted">
              {decisions === 0
                ? `Aucune décision automatique pour ${scope}.`
                : `${plural(decisions, "décision du contrôle de sécurité", "décisions du contrôle de sécurité")} pour ${scope}.`}
            </p>
          </section>
        </div>
      ) : null}
    </section>
  );
}
