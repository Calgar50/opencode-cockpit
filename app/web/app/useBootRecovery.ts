// Amorçage de l'interface et sa reprise automatique (1.1, décision U4) : branche la logique pure de
// server/shared/boot-recovery.ts sur l'API, les minuteries du navigateur, les événements « online » et « visibilitychange »,
// la reconnexion du flux d'événements et les 401 vus par n'importe quelle requête.
//
// Le branchement lui-même (startBootRecovery) ne dépend que de ce qu'on lui passe : le crochet lui donne window, document,
// le flux et l'API ; server/boot-recovery.test.ts lui donne des factices (onglet caché, reconnexion du flux, 401, arrêt).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BootFailure,
  type BootView,
  createBootRecovery,
  INITIAL_BOOT_VIEW,
  type TriggerSources,
  watchRetryTriggers,
} from "../../server/shared/boot-recovery.ts";
import { ApiError, api, errorText, onUnauthorized } from "../lib/api.ts";
import { cockpitEvent, eventBus } from "../lib/events.ts";
import type { Bootstrap, BrowserEvent } from "../lib/types.ts";

/** 401 : session perdue (écran de connexion, jamais de nouvelle tentative) ; tout autre échec est repris. */
export function classifyBootError(err: unknown): BootFailure {
  if (err instanceof ApiError && err.status === 401) return { unauthorized: true };
  return { unauthorized: false, message: errorText(err) };
}

/** Ce que le branchement utilise : réels dans le crochet, factices dans les tests. */
export interface BootRecoveryEnv<T> {
  /** Charge l'amorçage (/api/bootstrap). */
  load: () => Promise<T>;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Reçoit « online » (window). */
  network: TriggerSources["network"];
  /** Reçoit « visibilitychange » et donne l'état de l'onglet (document). */
  page: TriggerSources["page"];
  /** Flux d'événements : abonnement, connexion après un succès, coupure sur un 401. */
  stream: { subscribe: (listener: (event: BrowserEvent) => void) => () => void; connect: () => void; disconnect: () => void };
  /** 401 vu par n'importe quelle autre requête ; rend le désabonnement. */
  onUnauthorized: (listener: () => void) => () => void;
  onChange: (view: BootView<T>) => void;
}

/** Amorçage démarré : `load` (voir BootRecovery.load) et `stop`. */
export interface BootRecoveryHandle {
  load: () => Promise<void>;
  stop: () => void;
}

/**
 * Démarre l'amorçage et sa reprise : premier chargement tout de suite ; onglet caché, la tentative programmée attend son
 * retour ; « online », retour de l'onglet et reconnexion du flux relancent une reprise en attente ; un succès connecte le flux ;
 * un 401 d'une autre requête coupe le flux et ramène à la connexion. `stop` débranche tout et nettoie la minuterie.
 */
export function startBootRecovery<T>(env: BootRecoveryEnv<T>): BootRecoveryHandle {
  const recovery = createBootRecovery<T>({
    load: env.load,
    classify: classifyBootError,
    setTimer: env.setTimer,
    clearTimer: env.clearTimer,
    hidden: () => env.page.visibilityState === "hidden",
    onChange: env.onChange,
    onReady: () => env.stream.connect(),
  });
  void recovery.load();
  const stopTriggers = watchRetryTriggers(recovery, {
    network: env.network,
    page: env.page,
    onStreamReconnected: (listener) =>
      env.stream.subscribe((event) => {
        if (cockpitEvent(event, "stream.reconnected")) listener();
      }),
  });
  const stopUnauthorized = env.onUnauthorized(() => {
    env.stream.disconnect();
    recovery.unauthorized();
  });
  return {
    load: () => recovery.load(),
    stop: () => {
      stopUnauthorized();
      stopTriggers();
      recovery.dispose();
    },
  };
}

/**
 * Vue de l'amorçage (phase, données, reprise en attente) et `load`, qui recharge tout de suite : bouton « Réessayer »,
 * connexion réussie, rafraîchissement demandé par l'interface (pendant une tentative, une seule nouvelle part à sa fin).
 * `load` ne rejette jamais et garde la même identité.
 */
export function useBootRecovery(): { view: BootView<Bootstrap>; load: () => Promise<void> } {
  const [view, setView] = useState<BootView<Bootstrap>>(INITIAL_BOOT_VIEW);
  const started = useRef<BootRecoveryHandle | null>(null);

  useEffect(() => {
    const current = startBootRecovery<Bootstrap>({
      load: () => api.bootstrap(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      network: window,
      page: document,
      stream: eventBus,
      onUnauthorized,
      onChange: setView,
    });
    started.current = current;
    return () => {
      current.stop();
      if (started.current === current) started.current = null;
    };
  }, []);

  const load = useCallback(() => started.current?.load() ?? Promise.resolve(), []);
  return { view, load };
}
