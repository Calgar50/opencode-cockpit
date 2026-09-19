// Reprise de l'amorçage de l'interface (1.1, décision U4) : module PUR (aucun import « node: », aucun accès direct au DOM ;
// minuteries, requête et événements passent par des dépendances injectées, factices dans les tests).
//
// Défaut corrigé (constaté pendant la mesure M25 de R105b, présent dans la 1.0.5) : un rechargement de /api/bootstrap qui
// échouait pendant une coupure (redémarrage du conteneur, réseau coupé) passait l'application en phase « error ». L'écran
// « Le cockpit ne répond pas » remplaçait toute l'interface et n'en sortait jamais seul, même une fois le flux d'événements
// reconnecté : seul le bouton « Réessayer » le faisait partir.
//
// Désormais :
// - un échec autre que 401 programme une nouvelle tentative, avec une attente croissante et bornée (RETRY_DELAYS_MS) ;
// - une reprise en attente part aussitôt au retour du réseau (« online »), au retour de l'onglet (« visibilitychange ») et à
//   la reconnexion du flux d'événements ; onglet caché, la tentative programmée attend le retour de l'onglet ;
// - une interface déjà chargée reste en place (phase « ready », dernières données gardées) : la reprise est signalée par un
//   bandeau d'état, jamais par l'écran d'erreur, qui ne sert plus qu'avant le premier chargement ;
// - un 401 arrête tout (écran de connexion), jamais de boucle ; un succès arrête tout ; dispose() nettoie la minuterie et fait
//   ignorer les réponses en retard.

export type BootPhase = "loading" | "login" | "ready" | "error";

/** Échec d'une tentative : 401 (session perdue), ou autre échec (réseau, 5xx) avec son message. */
export type BootFailure = { unauthorized: true } | { unauthorized: false; message: string };

/** Reprise en attente : échecs consécutifs depuis le dernier succès et attente de la tentative programmée. */
export interface BootRetry {
  failures: number;
  delayMs: number;
}

export interface BootView<T> {
  phase: BootPhase;
  /** Dernières données reçues, gardées pendant une reprise ; null avant le premier succès et après un 401. */
  data: T | null;
  /** Message du dernier échec (écran d'erreur), "" sinon. */
  error: string;
  /** Reprise en attente, ou null. */
  retry: BootRetry | null;
  /** true : le dernier succès a mis fin à la reprise d'une interface déjà chargée (« Le cockpit répond de nouveau »). */
  recovered: boolean;
}

export const INITIAL_BOOT_VIEW: BootView<never> = Object.freeze({ phase: "loading", data: null, error: "", retry: null, recovered: false });

/** Attentes avant la tentative suivante, selon le nombre d'échecs consécutifs : 2, 5, 10 puis 30 s, jamais plus. */
export const RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000, 5_000, 10_000, 30_000]);

export function retryDelay(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 30_000;
}

/** Signaux qui relancent aussitôt une reprise en attente. */
export type RetryTrigger = "online" | "visible" | "stream";

export interface BootRecoveryDeps<T> {
  /** Charge l'amorçage : rend les données ou lève. */
  load: () => Promise<T>;
  /** Classe une erreur de `load`. */
  classify: (err: unknown) => BootFailure;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** true : onglet caché ; la tentative programmée attend alors un signal (retour de l'onglet, du réseau ou du flux). */
  hidden?: () => boolean;
  /** Chaque nouvelle vue (objet neuf). */
  onChange: (view: BootView<T>) => void;
  /** Après chaque succès (connexion du flux d'événements). */
  onReady?: (data: T) => void;
}

export interface BootRecovery<T> {
  readonly view: BootView<T>;
  /**
   * Charge tout de suite (premier chargement, « Réessayer », connexion réussie, rafraîchissement demandé par l'interface) ;
   * une tentative en cours est partagée, jamais doublée. Ne rejette jamais.
   */
  load(): Promise<void>;
  /** Relance aussitôt une reprise en attente ; sans reprise en attente (ou tentative en cours), ne fait rien. */
  trigger(reason: RetryTrigger): void;
  /** Session perdue (401 vu par une autre requête) : écran de connexion, reprise arrêtée, réponse en cours ignorée. */
  unauthorized(): void;
  /** Démontage : minuterie nettoyée, réponse en cours ignorée, plus rien ne part. */
  dispose(): void;
}

export function createBootRecovery<T>(deps: BootRecoveryDeps<T>): BootRecovery<T> {
  let view: BootView<T> = INITIAL_BOOT_VIEW;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  /** Change à chaque 401 et au démontage : une réponse d'une génération passée est ignorée. */
  let generation = 0;
  let disposed = false;

  const set = (next: BootView<T>) => {
    view = next;
    deps.onChange(view);
  };

  const cancelTimer = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const settle = (gen: number, outcome: { ok: true; data: T } | { ok: false; failure: BootFailure }) => {
    if (disposed || gen !== generation) return;
    cancelTimer();
    if (outcome.ok) {
      set({ phase: "ready", data: outcome.data, error: "", retry: null, recovered: view.retry !== null && view.data !== null });
      deps.onReady?.(outcome.data);
      return;
    }
    if (outcome.failure.unauthorized) {
      toLogin();
      return;
    }
    const failures = (view.retry?.failures ?? 0) + 1;
    const delayMs = retryDelay(failures);
    set({ phase: view.data === null ? "error" : "ready", data: view.data, error: outcome.failure.message, retry: { failures, delayMs }, recovered: false });
    timer = deps.setTimer(() => {
      timer = null;
      if (deps.hidden?.()) return;
      void attempt();
    }, delayMs);
  };

  const attempt = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    cancelTimer();
    const gen = generation;
    const current = deps.load().then(
      (data) => settle(gen, { ok: true, data }),
      (err: unknown) => settle(gen, { ok: false, failure: deps.classify(err) }),
    );
    const tracked = current.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  const toLogin = () => {
    cancelTimer();
    generation++;
    inFlight = null;
    set({ phase: "login", data: null, error: "", retry: null, recovered: false });
  };

  return {
    get view() {
      return view;
    },
    load: attempt,
    trigger() {
      if (disposed || view.retry === null || inFlight) return;
      void attempt();
    },
    unauthorized() {
      if (disposed) return;
      toLogin();
    },
    dispose() {
      disposed = true;
      generation++;
      inFlight = null;
      cancelTimer();
    },
  };
}

/** Sources des signaux de reprise (window, document et flux d'événements dans l'interface ; EventTarget dans les tests). */
export interface TriggerSources {
  /** Reçoit « online ». */
  network: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Reçoit « visibilitychange » et donne l'état de l'onglet. */
  page: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { readonly visibilityState: string };
  /** Abonnement à la reconnexion du flux d'événements ; rend le désabonnement. */
  onStreamReconnected: (listener: () => void) => () => void;
}

/** Branche les signaux de reprise ; rend la fonction qui les débranche tous. */
export function watchRetryTriggers(recovery: Pick<BootRecovery<unknown>, "trigger">, sources: TriggerSources): () => void {
  const online = () => recovery.trigger("online");
  const visible = () => {
    if (sources.page.visibilityState === "visible") recovery.trigger("visible");
  };
  sources.network.addEventListener("online", online);
  sources.page.addEventListener("visibilitychange", visible);
  const stopStream = sources.onStreamReconnected(() => recovery.trigger("stream"));
  return () => {
    sources.network.removeEventListener("online", online);
    sources.page.removeEventListener("visibilitychange", visible);
    stopStream();
  };
}
