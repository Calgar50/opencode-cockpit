// Diffusion des événements vers les navigateurs connectés (SSE).
import type { OcEvent } from "./opencode.ts";

export type BrowserEvent =
  | { kind: "opencode"; directory?: string; event: OcEvent }
  | { kind: "cockpit"; type: string; data: unknown };

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

  cockpit(type: string, data: unknown): void {
    this.publish({ kind: "cockpit", type, data });
  }
}
