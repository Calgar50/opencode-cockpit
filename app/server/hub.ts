// Diffusion des événements vers les navigateurs connectés (SSE).
import type { OcEvent } from "./opencode.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { OmoEventMap } from "./shared/omo-types.ts";

/**
 * Instance d'opencode d'où vient un événement, ou à qui il s'adresse (1.1, D-2b-41). Champ ABSENT : instance principale, comme
 * en 1.0.x — un lecteur qui ne connaît pas la salle lit exactement ce qu'il lisait.
 */
export interface HubInstanceTag {
  instance?: SessionInstance;
}

export type BrowserEvent =
  | ({ kind: "opencode"; directory?: string; event: OcEvent } & HubInstanceTag)
  | ({ kind: "cockpit"; type: string; data: unknown } & HubInstanceTag);

/**
 * Événements du hub propres à la Salle OMO : la donnée est celle du contrat de la salle (OmoEventMap, T3a), jamais redéfinie ici.
 * Le câblage (contracts-11.ts) reprend cette table dans HubEventMap ; le hub ne publie aucun de ces événements de lui-même.
 */
export interface HubOmoEventMap {
  "omo.connection": OmoEventMap["omo.connection"];
}

/** Événements opencode utiles à l'interface ; le reste (sync, plugins…) n'est pas relayé. */
export const FORWARDED_EVENTS = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "session.compacted",
  "session.diff",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "todo.updated",
  "file.edited",
  "command.executed",
  "server.instance.disposed",
  "global.disposed",
  "mcp.tools.changed",
  "installation.update-available",
]);

export class EventHub {
  readonly #clients = new Set<(event: BrowserEvent) => void>();

  get clientCount(): number {
    return this.#clients.size;
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.#clients.add(listener);
    return () => this.#clients.delete(listener);
  }

  publish(event: BrowserEvent): void {
    for (const listener of this.#clients) {
      try {
        listener(event);
      } catch {
        // Un client défaillant ne doit pas empêcher la diffusion aux autres.
      }
    }
  }

  /** Instance absente : l'événement publié est exactement celui de la 1.0.x, sans champ `instance` (P3). */
  cockpit(type: string, data: unknown, instance?: SessionInstance): void {
    this.publish({ kind: "cockpit", type, data, ...(instance ? { instance } : {}) });
  }
}
