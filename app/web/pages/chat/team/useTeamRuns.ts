// Propriétaire : L38b.
// Lancements d'équipe d'une conversation, partagés par TOUS les composants qui les demandent : un seul chargement
// (GET /api/team-runs?rootId=) et un seul abonnement au flux par racine (cache du module), quel que soit le nombre d'appelants —
// L38c appellera ce crochet depuis chaque tour de la transcription. Mises à jour sur `equipe.lancement` et `equipe.etape`
// (événements resserrés par EquipeEventMap ; ils arrivent en BrowserEvent, `type: string`), relecture à la reconnexion du flux,
// au plus 4 relectures et 4 rendus par seconde. Plan it4 §6 fiche L38b, §4.1.1.
// Le cache est une classe à dépendances injectées : il se teste sous Node, sans navigateur et sans React
// (server/web-team-cards.test.ts). Le crochet n'est qu'une liaison useSyncExternalStore.
import { useCallback, useSyncExternalStore } from "react";
import type { EquipeEventMap, EquipeEventType, TeamRunsResponse, TeamRunView } from "../../../../server/shared/team-types.ts";
import { teamRunsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import { eventBus } from "../../../lib/events.ts";
import type { BrowserEvent } from "../../../lib/types.ts";

/** Au plus 4 relectures et 4 rendus par seconde (fiche L38b). */
export const TEAM_RUNS_MIN_INTERVAL_MS = 250;

export interface TeamRunsState {
  runs: readonly TeamRunView[];
  /** Premier chargement de cette racine en cours. */
  chargement: boolean;
  erreur: string | null;
}

const VIDE: TeamRunsState = { runs: [], chargement: false, erreur: null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Événement d'équipe de cette racine, resserré par EquipeEventMap : le flux du navigateur ne porte qu'un `type: string` et une
 * donnée inconnue. Une trame qui ne ressemble pas au contrat est ignorée (entrée non fiable).
 */
export function equipeEvent<K extends EquipeEventType>(event: BrowserEvent, type: K, rootId: string): EquipeEventMap[K] | null {
  if (event.kind !== "cockpit" || event.type !== type || !isRecord(event.data)) return null;
  const data = event.data;
  if (typeof data.runId !== "string" || data.rootId !== rootId) return null;
  return data as unknown as EquipeEventMap[K];
}

export interface TeamRunsDeps {
  charger(rootId: string, signal: AbortSignal): Promise<TeamRunsResponse>;
  /** Abonnement au flux temps réel ; rend le désabonnement. */
  abonner(handler: (event: BrowserEvent) => void): () => void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  /** Phrase d'une erreur de lecture, jamais un secret. */
  phraseErreur(err: unknown): string;
}

interface Entree {
  etat: TeamRunsState;
  auditeurs: Set<() => void>;
  desabonner: (() => void) | null;
  abort: AbortController | null;
  /** Dernier chargement terminé (horodatage) et relecture déjà programmée. */
  dernier: number;
  minuteur: unknown;
  /** Une relecture est attendue dès que le débit le permet. */
  sale: boolean;
  sequence: number;
}

/** Cache partagé : une entrée par racine, un chargement et un abonnement chacune. */
export class TeamRunsCache {
  readonly #deps: TeamRunsDeps;
  readonly #entrees = new Map<string, Entree>();

  constructor(deps: TeamRunsDeps) {
    this.#deps = deps;
  }

  /** État courant d'une racine ; la même valeur tant que rien ne change (useSyncExternalStore). */
  snapshot(rootId: string): TeamRunsState {
    return this.#entrees.get(rootId)?.etat ?? VIDE;
  }

  /** Abonne un composant ; le premier charge et s'abonne au flux, le dernier qui part libère tout. */
  subscribe(rootId: string, auditeur: () => void): () => void {
    if (rootId === "") return () => undefined;
    let entree = this.#entrees.get(rootId);
    if (entree === undefined) {
      entree = { etat: { runs: [], chargement: true, erreur: null }, auditeurs: new Set(), desabonner: null, abort: null, dernier: 0, minuteur: null, sale: false, sequence: 0 };
      this.#entrees.set(rootId, entree);
      entree.desabonner = this.#deps.abonner((event) => this.#surEvenement(rootId, event));
      this.#charger(rootId, true);
    }
    entree.auditeurs.add(auditeur);
    return () => {
      const courante = this.#entrees.get(rootId);
      if (courante === undefined) return;
      courante.auditeurs.delete(auditeur);
      if (courante.auditeurs.size === 0) this.#liberer(rootId);
    };
  }

  /** Relecture demandée de l'extérieur (reconnexion, lancement accepté). */
  invalider(rootId: string): void {
    if (this.#entrees.has(rootId)) this.#planifier(rootId);
  }

  #surEvenement(rootId: string, event: BrowserEvent): void {
    const equipe = equipeEvent(event, "equipe.lancement", rootId) ?? equipeEvent(event, "equipe.etape", rootId);
    // Reconnexion du flux : l'état a pu changer sans qu'aucun événement n'arrive.
    const reconnecte = event.kind === "cockpit" && event.type === "stream.reconnected";
    if (equipe === null && !reconnecte) return;
    this.#planifier(rootId);
  }

  /** Relecture au plus 4 fois par seconde ; les demandes arrivées entre-temps sont réunies en une seule. */
  #planifier(rootId: string): void {
    const entree = this.#entrees.get(rootId);
    if (entree === undefined) return;
    entree.sale = true;
    if (entree.minuteur !== null) return;
    const attente = Math.max(0, entree.dernier + TEAM_RUNS_MIN_INTERVAL_MS - this.#deps.now());
    entree.minuteur = this.#deps.setTimer(() => {
      const courante = this.#entrees.get(rootId);
      if (courante === undefined) return;
      courante.minuteur = null;
      if (courante.sale) this.#charger(rootId, false);
    }, attente);
  }

  #charger(rootId: string, premier: boolean): void {
    const entree = this.#entrees.get(rootId);
    if (entree === undefined) return;
    entree.sale = false;
    entree.dernier = this.#deps.now();
    entree.abort?.abort();
    const abort = new AbortController();
    entree.abort = abort;
    const sequence = ++entree.sequence;
    this.#deps.charger(rootId, abort.signal).then(
      (reponse) => {
        const courante = this.#entrees.get(rootId);
        if (courante === undefined || sequence !== courante.sequence) return;
        this.#poser(rootId, { runs: Array.isArray(reponse.runs) ? reponse.runs : [], chargement: false, erreur: null });
      },
      (err: unknown) => {
        const courante = this.#entrees.get(rootId);
        if (courante === undefined || sequence !== courante.sequence || abort.signal.aborted) return;
        // Lecture en échec : les lancements déjà connus restent affichés, jamais remplacés par une liste inventée.
        this.#poser(rootId, { runs: premier ? [] : courante.etat.runs, chargement: false, erreur: this.#deps.phraseErreur(err) });
      },
    );
  }

  #poser(rootId: string, etat: TeamRunsState): void {
    const entree = this.#entrees.get(rootId);
    if (entree === undefined) return;
    entree.etat = etat;
    for (const auditeur of entree.auditeurs) auditeur();
  }

  #liberer(rootId: string): void {
    const entree = this.#entrees.get(rootId);
    if (entree === undefined) return;
    entree.abort?.abort();
    entree.desabonner?.();
    if (entree.minuteur !== null) this.#deps.clearTimer(entree.minuteur);
    this.#entrees.delete(rootId);
  }
}

/** Cache de la page (navigateur) : un chargement et un abonnement par racine, partagés par toute l'interface. */
export const teamRunsCache = new TeamRunsCache({
  charger: (rootId, signal) => teamRunsApi.ofRoot(rootId, signal),
  abonner: (handler) => eventBus.subscribe(handler),
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  phraseErreur: (err) => errorText(err),
});

/**
 * Lancements d'équipe de `rootId`, partagés : trois composants qui appellent ce crochet ne font qu'une seule requête.
 *
 * Les DEUX fonctions passées à useSyncExternalStore sont mémorisées sur `rootId` (défaut D1 du banc de la vague 4, arbitrage A13).
 * Recréées à chaque rendu, elles faisaient boucler la page : React se réabonne dès que `subscribe` change d'identité, le dernier
 * désabonnement vide l'entrée du cache (`#liberer` à `auditeurs.size === 0`) et le réabonnement la recrée avec un NOUVEL objet
 * d'état, donc un instantané différent, donc un nouveau rendu — sans fin (« Minified React error #185 », écran vide dans toute
 * conversation et dans les deux modes). Toute évolution de ce crochet garde ces deux `useCallback`.
 */
export function useTeamRuns(rootId: string): TeamRunsState {
  const abonner = useCallback((auditeur: () => void) => teamRunsCache.subscribe(rootId, auditeur), [rootId]);
  const lire = useCallback(() => teamRunsCache.snapshot(rootId), [rootId]);
  return useSyncExternalStore(abonner, lire, lire);
}
