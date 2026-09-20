// Flux temps réel du cockpit (SSE /api/events) : un seul EventSource partagé par toute l'interface.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { INITIAL_STREAM_STATE, nextStreamState, type StreamEvent, type StreamState, type StreamStatus } from "../../server/shared/stream-status.ts";
import type { BrowserEvent } from "./types.ts";

export type { StreamStatus } from "../../server/shared/stream-status.ts";

class EventBus {
  #source: EventSource | null = null;
  #listeners = new Set<(event: BrowserEvent) => void>();
  #statusListeners = new Set<() => void>();
  #state: StreamState = INITIAL_STREAM_STATE;
  #everOpened = false;

  get status(): StreamStatus {
    return this.#state.status;
  }

  connect(): void {
    if (this.#source) return;
    const source = new EventSource("/api/events");
    this.#source = source;
    this.#reset();
    source.addEventListener("hello", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#apply("hello");
      if (reconnected) this.#emit({ kind: "cockpit", type: "stream.reconnected", data: null });
    });
    source.onmessage = (message) => {
      try {
        this.#emit(JSON.parse(message.data as string) as BrowserEvent);
      } catch {
        // Message illisible : ignoré.
      }
    };
    // Transport rétabli : le compteur d'erreurs n'est remis à zéro que par la trame « hello » du serveur.
    source.onopen = () => this.#apply("open");
    source.onerror = () => this.#apply("error");
  }

  disconnect(): void {
    this.#source?.close();
    this.#source = null;
    this.#reset();
  }

  subscribe(listener: (event: BrowserEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  #emit(event: BrowserEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("écouteur d'événement en échec", err);
      }
    }
  }

  #apply(event: StreamEvent): void {
    this.#store(nextStreamState(this.#state, event));
  }

  #reset(): void {
    this.#store(INITIAL_STREAM_STATE);
  }

  #store(state: StreamState): void {
    const changed = this.#state.status !== state.status;
    this.#state = state;
    if (changed) for (const listener of this.#statusListeners) listener();
  }
}

export const eventBus = new EventBus();

/** Abonne un gestionnaire au flux ; la dernière version du gestionnaire est toujours utilisée. */
export function useEvents(handler: (event: BrowserEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => eventBus.subscribe((event) => ref.current(event)), []);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (cb) => eventBus.onStatus(cb),
    () => eventBus.status,
    () => eventBus.status,
  );
}

/** Événement opencode d'un type donné, ou null. */
export function opencodeEvent(event: BrowserEvent, ...types: string[]) {
  return event.kind === "opencode" && types.includes(event.event.type) ? event.event : null;
}

export function cockpitEvent(event: BrowserEvent, ...types: string[]) {
  return event.kind === "cockpit" && types.includes(event.type) ? event : null;
}
