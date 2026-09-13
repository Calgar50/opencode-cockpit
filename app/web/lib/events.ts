// Flux temps réel du cockpit (SSE /api/events) : un seul EventSource partagé par toute l'interface.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BrowserEvent } from "./types.ts";

export type StreamStatus = "connecting" | "open" | "error";

class EventBus {
  #source: EventSource | null = null;
  #listeners = new Set<(event: BrowserEvent) => void>();
  #statusListeners = new Set<() => void>();
  #status: StreamStatus = "connecting";
  #everOpened = false;

  get status(): StreamStatus {
    return this.#status;
  }

  connect(): void {
    if (this.#source) return;
    const source = new EventSource("/api/events");
    this.#source = source;
    this.#setStatus("connecting");
    source.addEventListener("hello", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#setStatus("open");
      if (reconnected) this.#emit({ kind: "cockpit", type: "stream.reconnected", data: null });
    });
    source.onmessage = (message) => {
      try {
        this.#emit(JSON.parse(message.data as string) as BrowserEvent);
      } catch {
        // Message illisible : ignoré.
      }
    };
    source.onerror = () => this.#setStatus("error");
  }

  disconnect(): void {
    this.#source?.close();
    this.#source = null;
    this.#setStatus("connecting");
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

  #setStatus(status: StreamStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener();
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
