// Événements SSE du cockpit ajoutés par la 1.1 : publication typée sur CockpitEventMap (plan d'exécution §4.1, T0).
import type { EventHub } from "./hub.ts";
import type { CockpitEventMap } from "./shared/cockpit-event-types.ts";

/** Publie un événement 1.1 vers les navigateurs ; le type et la forme des données sont vérifiés à la compilation. */
export function emitCockpit<K extends keyof CockpitEventMap>(hub: Pick<EventHub, "cockpit">, type: K, data: CockpitEventMap[K]): void {
  hub.cockpit(type, data);
}
