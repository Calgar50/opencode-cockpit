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
//
// Rafraîchissement demandé (constat de la vérification de c630349, régression par rapport à la 1.0.5) : seuls les
// déclencheurs de reprise (minuterie, « online », onglet, flux) partagent la tentative en cours. Un load() explicite
// (rafraîchissement après une modification, « Réessayer », connexion) lancé pendant une tentative en programme UNE nouvelle,
// lancée à sa fin : la réponse en cours, calculée avant la demande, ne doit jamais remplacer l'affichage. Seule compte la
// réponse de la tentative la plus récemment lancée ou demandée (numéro de séquence) ; celle d'une tentative dépassée est
// ignorée, qu'elle soit un succès ou un échec.

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
   * Charge tout de suite (premier chargement, « Réessayer », connexion réussie, rafraîchissement demandé par l'interface).
   * Pendant une tentative, en programme une seule nouvelle, lancée à sa fin (rafraîchissement de queue) : la réponse en
   * cours, calculée avant la demande, est ignorée. Se résout une fois l'affichage réglé par une tentative lancée après
   * l'appel (ou arrêté par un 401, ou le démontage).
   */
  load(): Promise<void>;
  /** Relance aussitôt une reprise en attente ; sans reprise en attente, ou pendant une tentative (partagée), ne fait rien. */
  trigger(reason: RetryTrigger): void;
  /** Session perdue (401 vu par une autre requête) : écran de connexion, reprise arrêtée, réponse en cours ignorée. */
  unauthorized(): void;
  /** Démontage : minuterie nettoyée, réponse en cours ignorée, plus rien ne part. */
  dispose(): void;
}

export function createBootRecovery<T>(deps: BootRecoveryDeps<T>): BootRecovery<T> {
  let view: BootView<T> = INITIAL_BOOT_VIEW;
  let timer: unknown = null;
  /** Tentative en cours ; se résout quand elle est réglée, et le rafraîchissement de queue qu'elle a reçu aussi. */
  let inFlight: Promise<void> | null = null;
  /** Un load() explicite est arrivé pendant la tentative en cours : une seule nouvelle tentative partira à sa fin. */
  let tailRequested = false;
  /**
   * Numéro de la tentative la plus récemment lancée ou demandée. Avance aussi à chaque 401 et au démontage : la réponse d'une
   * tentative dépassée est ignorée.
   */
  let latest = 0;
  let disposed = false;

  const set = (next: BootView<T>) => {
    view = next;
    deps.onChange(view);
  };

  const cancelTimer = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const settle = (id: number, outcome: { ok: true; data: T } | { ok: false; failure: BootFailure }) => {
    if (disposed || id !== latest) return;
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
      if (deps.hidden?.() || inFlight !== null) return;
      void launch();
    }, delayMs);
  };

  /** Lance une tentative tout de suite (aucune en cours) ; à sa fin, lance le rafraîchissement de queue s'il a été demandé. */
  const launch = (): Promise<void> => {
    cancelTimer();
    const id = ++latest;
    const settled = deps.load().then(
      (data) => settle(id, { ok: true, data }),
      (err: unknown) => settle(id, { ok: false, failure: deps.classify(err) }),
    );
    const next = (): Promise<void> | undefined => {
      // 401 ou démontage entre-temps : ils ont déjà remis l'état à zéro, rien ne suit.
      if (inFlight !== tracked) return undefined;
      inFlight = null;
      if (!tailRequested) return undefined;
      tailRequested = false;
      return launch();
    };
    const tracked: Promise<void> = settled.then(next, (err: unknown) => {
      if (inFlight === tracked) {
        inFlight = null;
        tailRequested = false;
      }
      throw err;
    });
    inFlight = tracked;
    return tracked;
  };

  const toLogin = () => {
    cancelTimer();
    latest++;
    inFlight = null;
    tailRequested = false;
    set({ phase: "login", data: null, error: "", retry: null, recovered: false });
  };

  return {
    get view() {
      return view;
    },
    load() {
      if (disposed) return Promise.resolve();
      if (inFlight === null) return launch();
      if (!tailRequested) {
        // La tentative en cours est dépassée : sa réponse, calculée avant la demande, sera ignorée.
        tailRequested = true;
        latest++;
      }
      return inFlight;
    },
    trigger() {
      if (disposed || view.retry === null || inFlight !== null) return;
      void launch();
    },
    unauthorized() {
      if (disposed) return;
      toLogin();
    },
    dispose() {
      disposed = true;
      latest++;
      inFlight = null;
      tailRequested = false;
      cancelTimer();
    },
  };
}

/**
 * Focus à rattraper quand le bandeau de reprise disparaît avec son bouton « Réessayer » (constat de la vérification de
 * c630349) : seulement s'il était dans la zone d'annonce et qu'il est retombé sur le corps de la page, ou nulle part. Un focus
 * parti ailleurs n'est jamais repris.
 */
export function focusARattraper(dansLaZone: boolean, actif: unknown, corps: unknown): boolean {
  return dansLaZone && (actif === null || actif === undefined || actif === corps);
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
