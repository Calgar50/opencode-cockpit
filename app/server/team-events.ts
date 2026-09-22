// Événements SSE des équipes (plan d'exécution it4 §4.1.4, D-eq-15) : publication typée sur EquipeEventMap par hub.cockpit ;
// CockpitEventMap (shared/cockpit-event-types.ts) n'est pas modifiée.
import type { EventHub } from "./hub.ts";
import type { EquipeEventMap } from "./shared/team-types.ts";

/** Publie un événement d'équipe vers les navigateurs ; le type et la forme des données sont vérifiés à la compilation. */
export function emitEquipe<K extends keyof EquipeEventMap>(hub: Pick<EventHub, "cockpit">, type: K, data: EquipeEventMap[K]): void {
  hub.cockpit(type, data);
}
