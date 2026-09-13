// Client HTTP minimal du serveur opencode (API 1.18) : requêtes JSON et flux SSE global.
import type { AppEnv } from "./env.ts";

export interface OcTokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcFileDiff {
  file: string;
  additions: number;
  deletions: number;
}

export interface OcSession {
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: Omit<OcTokens, "total">;
  summary?: { additions: number; deletions: number; files: number; diffs?: OcFileDiff[] };
  metadata?: Record<string, unknown>;
  time: { created: number; updated: number; archived?: number; compacting?: number };
}

export interface OcUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
}

export interface OcAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: { name: string; data?: { message?: string } & Record<string, unknown> };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  cost: number;
  tokens: OcTokens;
  finish?: string;
  structured?: unknown;
  variant?: string;
}

export type OcMessage = OcUserMessage | OcAssistantMessage;

export interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
}

export interface OcMessageWithParts {
  info: OcMessage;
  parts: OcPart[];
}

export interface OcEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface OcGlobalEvent {
  directory?: string;
  project?: string;
  workspace?: string;
  payload: OcEvent;
}

export class OpencodeError extends Error {
  override name = "OpencodeError";
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? describeOpencodeError(status, body));
    this.status = status;
    this.body = body;
  }
}

function describeOpencodeError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { name?: string; data?: { message?: string }; message?: string };
    const detail = b.data?.message ?? b.message;
    if (b.name || detail) return `opencode ${status} ${b.name ?? ""}${detail ? ` : ${detail}` : ""}`.trim();
  }
  return `opencode a répondu ${status}`;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  directory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export class OpencodeClient {
  readonly baseUrl: string;
  readonly #authorization: string;

  constructor(env: Pick<AppEnv, "opencodeUrl" | "opencodeUsername" | "opencodePassword">) {
    this.baseUrl = env.opencodeUrl;
    this.#authorization = `Basic ${Buffer.from(`${env.opencodeUsername}:${env.opencodePassword}`).toString("base64")}`;
  }

  url(pathname: string, query?: Query, directory?: string): URL {
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    if (directory) url.searchParams.set("directory", directory);
    return url;
  }

  /** Requête brute (utilisée par le proxy) : ajoute l'authentification, ne lit pas la réponse. */
  raw(method: string, url: URL, init: { headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal } = {}) {
    return fetch(url, {
      method,
      headers: { ...init.headers, authorization: this.#authorization },
      body: init.body ?? null,
      signal: init.signal ?? null,
      redirect: "manual",
      // Nécessaire pour transmettre un corps en flux avec fetch de Node.
      ...(init.body ? { duplex: "half" } : {}),
    } as RequestInit);
  }

  async request<T>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
    const signals = [options.signal, options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => Boolean(s),
    );
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.raw(method, this.url(pathname, options.query, options.directory), {
      headers,
      body: options.body === undefined ? null : JSON.stringify(options.body),
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw new OpencodeError(res.status, parsed);
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      throw new OpencodeError(res.status, null, `Route non gérée par cette version d'opencode : ${pathname}`);
    }
    return parsed as T;
  }

  async health(timeoutMs = 3000): Promise<{ healthy: boolean; version: string } | null> {
    try {
      return await this.request("GET", "/global/health", { timeoutMs });
    } catch {
      return null;
    }
  }

  /**
   * S'abonne à /global/event avec reconnexion automatique (backoff exponentiel)
   * et chien de garde : sans données ni battement de cœur pendant 35 s, on reconnecte.
   */
  subscribeGlobal(
    onEvent: (event: OcGlobalEvent) => void,
    onStatus: (status: "connected" | "disconnected", error?: string) => void,
  ): () => void {
    const stop = new AbortController();
    const loop = async () => {
      let backoff = 500;
      while (!stop.signal.aborted) {
        const attempt = new AbortController();
        const abortAttempt = () => attempt.abort();
        stop.signal.addEventListener("abort", abortAttempt);
        let watchdog: NodeJS.Timeout | undefined;
        const arm = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => attempt.abort(new Error("flux d'événements muet depuis 35 s")), 35_000);
        };
        try {
          const res = await this.raw("GET", this.url("/global/event"), {
            headers: { accept: "text/event-stream" },
            signal: attempt.signal,
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          onStatus("connected");
          backoff = 500;
          arm();
          let buffer = "";
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            arm();
            buffer += value;
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary !== -1) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(buffer.slice(boundary).startsWith("\r\n\r\n") ? boundary + 4 : boundary + 2);
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""))
                .join("\n");
              if (data) {
                try {
                  onEvent(JSON.parse(data) as OcGlobalEvent);
                } catch {
                  // Bloc illisible : on l'ignore plutôt que de couper le flux.
                }
              }
              boundary = buffer.search(/\r?\n\r?\n/);
            }
          }
          onStatus("disconnected", "flux terminé par opencode");
        } catch (err) {
          if (!stop.signal.aborted) onStatus("disconnected", (err as Error).message);
        } finally {
          clearTimeout(watchdog);
          stop.signal.removeEventListener("abort", abortAttempt);
        }
        if (stop.signal.aborted) break;
        await sleep(backoff, stop.signal);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    void loop();
    return () => stop.abort();
  }
}

export const isAssistant = (m: OcMessage): m is OcAssistantMessage => m.role === "assistant";
