// Pilotage du conteneur opencode via le dossier partagé /control (aucun accès au socket Docker).
import fs from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "./env.ts";
import { readIfExists, writeFileAtomic } from "./fsutil.ts";
import type { Logger } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";

export interface RestartResult {
  ok: boolean;
  durationMs: number;
  message: string;
  /** Cause d'un échec : superviseur absent, opencode qui s'arrête à chaque démarrage (configuration refusée), délai dépassé. */
  failure?: "superviseur-absent" | "arrets-repetes" | "delai-depasse";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Relances successives sans réponse d'opencode au-delà desquelles il s'arrête à chaque démarrage (mesuré : configuration invalide). */
const REPEATED_LAUNCHES = 3;

export class ControlService {
  readonly #env: AppEnv;
  readonly #client: OpencodeClient;
  readonly #log: Logger;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  #restarting: Promise<RestartResult> | null = null;

  constructor(deps: { env: AppEnv; client: OpencodeClient; log: Logger; pollMs?: number; timeoutMs?: number }) {
    this.#env = deps.env;
    this.#client = deps.client;
    this.#log = deps.log;
    this.#pollMs = deps.pollMs ?? 1_000;
    this.#timeoutMs = deps.timeoutMs ?? 120_000;
  }

  get restarting(): boolean {
    return this.#restarting !== null;
  }

  async #startedMarker(): Promise<string | null> {
    return (await readIfExists(path.join(this.#env.controlDir, "opencode.started")))?.trim() ?? null;
  }

  async supervisorPresent(): Promise<boolean> {
    return (await this.#startedMarker()) !== null;
  }

  restartOpencode(reason: string): Promise<RestartResult> {
    if (this.#restarting) return this.#restarting;
    this.#restarting = this.#restart(reason).finally(() => {
      this.#restarting = null;
    });
    return this.#restarting;
  }

  async #restart(reason: string): Promise<RestartResult> {
    const begin = Date.now();
    const before = await this.#startedMarker();
    if (before === null) {
      return {
        ok: false,
        durationMs: 0,
        failure: "superviseur-absent",
        message: "Superviseur d'opencode introuvable : redémarrez les conteneurs (.\\cockpit.ps1 restart).",
      };
    }
    this.#log.info("redémarrage d'opencode demandé", { reason });
    await writeFileAtomic(
      path.join(this.#env.controlDir, "restart-request"),
      JSON.stringify({ at: new Date().toISOString(), reason: reason.slice(0, 200) }),
    );
    // Le superviseur réécrit le marqueur à chaque lancement : plusieurs lancements sans réponse, opencode s'arrête au démarrage.
    let marker = before;
    let launches = 0;
    while (Date.now() - begin < this.#timeoutMs) {
      await sleep(this.#pollMs);
      const current = await this.#startedMarker();
      if (current !== null && current !== marker) {
        marker = current;
        launches++;
      }
      if (launches > 0 && (await this.#client.health(2_000))?.healthy) {
        return { ok: true, durationMs: Date.now() - begin, message: "opencode a redémarré." };
      }
      if (launches >= REPEATED_LAUNCHES) {
        return {
          ok: false,
          durationMs: Date.now() - begin,
          failure: "arrets-repetes",
          message: "opencode s'arrête à chaque démarrage : consultez le journal (page Diagnostic).",
        };
      }
    }
    return {
      ok: false,
      durationMs: Date.now() - begin,
      failure: "delai-depasse",
      message: "opencode ne répond pas après 2 minutes : consultez le journal.",
    };
  }

  /** Dernières lignes du journal d'opencode, secrets masqués. */
  async logs(lines = 400): Promise<string> {
    const file = path.join(this.#env.controlDir, "opencode.log");
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, "r");
    } catch {
      return "";
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8").split(/\r?\n/).slice(-lines).join("\n");
      return redactSecrets(text);
    } finally {
      await handle.close();
    }
  }

  async caFilesCount(): Promise<number | null> {
    const raw = await readIfExists(path.join(this.#env.controlDir, "ca-files.count"));
    const n = raw === null ? Number.NaN : Number(raw.trim());
    return Number.isFinite(n) ? n : null;
  }
}
