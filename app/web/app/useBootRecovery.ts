// Amorçage de l'interface et sa reprise automatique (1.1, décision U4) : branche la logique pure de
// server/shared/boot-recovery.ts sur l'API, les minuteries du navigateur, les événements « online » et « visibilitychange »,
// la reconnexion du flux d'événements et les 401 vus par n'importe quelle requête.
import { useCallback, useEffect, useRef, useState } from "react";
import { type BootFailure, type BootRecovery, type BootView, createBootRecovery, INITIAL_BOOT_VIEW, watchRetryTriggers } from "../../server/shared/boot-recovery.ts";
import { ApiError, api, errorText, onUnauthorized } from "../lib/api.ts";
import { cockpitEvent, eventBus } from "../lib/events.ts";
import type { Bootstrap } from "../lib/types.ts";

/** 401 : session perdue (écran de connexion, jamais de nouvelle tentative) ; tout autre échec est repris. */
export function classifyBootError(err: unknown): BootFailure {
  if (err instanceof ApiError && err.status === 401) return { unauthorized: true };
  return { unauthorized: false, message: errorText(err) };
}

/**
 * Vue de l'amorçage (phase, données, reprise en attente) et `load`, qui recharge tout de suite : bouton « Réessayer »,
 * connexion réussie, rafraîchissement demandé par l'interface. `load` ne rejette jamais et garde la même identité.
 */
export function useBootRecovery(): { view: BootView<Bootstrap>; load: () => Promise<void> } {
  const [view, setView] = useState<BootView<Bootstrap>>(INITIAL_BOOT_VIEW);
  const recovery = useRef<BootRecovery<Bootstrap> | null>(null);

  useEffect(() => {
    const current = createBootRecovery<Bootstrap>({
      load: () => api.bootstrap(),
      classify: classifyBootError,
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      hidden: () => document.visibilityState === "hidden",
      onChange: setView,
      onReady: () => eventBus.connect(),
    });
    recovery.current = current;
    void current.load();
    const stopTriggers = watchRetryTriggers(current, {
      network: window,
      page: document,
      onStreamReconnected: (listener) =>
        eventBus.subscribe((event) => {
          if (cockpitEvent(event, "stream.reconnected")) listener();
        }),
    });
    const stopUnauthorized = onUnauthorized(() => {
      eventBus.disconnect();
      current.unauthorized();
    });
    return () => {
      stopUnauthorized();
      stopTriggers();
      current.dispose();
      if (recovery.current === current) recovery.current = null;
    };
  }, []);

  const load = useCallback(() => recovery.current?.load() ?? Promise.resolve(), []);
  return { view, load };
}
