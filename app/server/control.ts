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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ControlService {
  readonly #env: AppEnv;
  readonly #client: OpencodeClient;
  readonly #log: Logger;
  #restarting: Promise<RestartResult> | null = null;

  constructor(deps: { env: AppEnv; client: OpencodeClient; log: Logger }) {
    this.#env = deps.env;
    this.#client = deps.client;
    this.#log = deps.log;
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
        message: "Superviseur d'opencode introuvable : redémarrez les conteneurs (.\\cockpit.ps1 restart).",
      };
    }
    this.#log.info("redémarrage d'opencode demandé", { reason });
    await writeFileAtomic(
      path.join(this.#env.controlDir, "restart-request"),
      JSON.stringify({ at: new Date().toISOString(), reason: reason.slice(0, 200) }),
    );
    let relaunched = false;
    while (Date.now() - begin < 120_000) {
      await sleep(1_000);
      if (!relaunched) relaunched = (await this.#startedMarker()) !== before;
      if (relaunched && (await this.#client.health(2_000))?.healthy) {
        return { ok: true, durationMs: Date.now() - begin, message: "opencode a redémarré." };
      }
    }
    return { ok: false, durationMs: Date.now() - begin, message: "opencode ne répond pas après 2 minutes : consultez le journal." };
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
