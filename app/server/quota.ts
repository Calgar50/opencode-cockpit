// Solde réel Copilot (optionnel) : endpoint GitHub NON documenté `copilot_internal/user`,
// celui qu'utilisent les éditeurs pour afficher la consommation. Désactivé par défaut.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { SettingsStore } from "./settings.ts";

export interface QuotaSnapshot {
  takenAt: number;
  plan: string | null;
  entitlement: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  unlimited: boolean;
  overageCount: number | null;
}

interface CopilotAuth {
  type?: string;
  refresh?: string;
  access?: string;
  enterpriseUrl?: string;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Hôte d'API vers lequel envoyer le jeton. auth.json est modifiable depuis le conteneur opencode :
 * un domaine Enterprise n'est accepté que s'il correspond exactement à celui déclaré dans .env.
 */
export function apiHostFor(enterpriseUrl: string | undefined, allowedDomain: string | null): string {
  if (!enterpriseUrl) return "api.github.com";
  const domain = enterpriseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!DOMAIN.test(domain)) throw new Error("URL GitHub Enterprise invalide dans auth.json.");
  if (domain !== allowedDomain) {
    throw new Error(`Domaine GitHub Enterprise non autorisé : ajoutez COCKPIT_GITHUB_ENTERPRISE_DOMAIN=${domain} dans .env pour activer la synchronisation.`);
  }
  return `api.${domain}`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class QuotaSync {
  readonly #db: DatabaseSync;
  readonly #settings: SettingsStore;
  readonly #hub: EventHub;
  readonly #log: Logger;
  readonly #authFile: string;
  #timer: NodeJS.Timeout | undefined;
  #lastError: string | null = null;

  readonly #enterpriseDomain: string | null;

  constructor(deps: {
    db: DatabaseSync;
    settings: SettingsStore;
    hub: EventHub;
    log: Logger;
    opencodeDataDir: string;
    githubEnterpriseDomain: string | null;
  }) {
    this.#enterpriseDomain = deps.githubEnterpriseDomain;
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#hub = deps.hub;
    this.#log = deps.log;
    this.#authFile = path.join(deps.opencodeDataDir, "auth.json");
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  start(): void {
    const tick = () => {
      const { enabled, intervalMinutes } = this.#settings.get().quotaSync;
      const latest = this.latest();
      if (!enabled) return;
      if (latest && Date.now() - latest.takenAt < intervalMinutes * 60_000 - 5_000) return;
      void this.syncNow().catch(() => undefined);
    };
    tick();
    this.#timer = setInterval(tick, 60_000);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  async copilotConnected(): Promise<boolean> {
    try {
      const auth = JSON.parse(await fs.readFile(this.#authFile, "utf8")) as Record<string, CopilotAuth>;
      return Boolean(auth["github-copilot"]?.refresh || auth["github-copilot"]?.access);
    } catch {
      return false;
    }
  }

  async syncNow(): Promise<QuotaSnapshot> {
    try {
      const auth = (JSON.parse(await fs.readFile(this.#authFile, "utf8")) as Record<string, CopilotAuth>)["github-copilot"];
      const token = auth?.refresh || auth?.access;
      if (!token) throw new Error("GitHub Copilot n'est pas connecté.");
      const res = await fetch(`https://${apiHostFor(auth?.enterpriseUrl, this.#enterpriseDomain)}/copilot_internal/user`, {
        headers: { authorization: `token ${token}`, accept: "application/json", "user-agent": "opencode-cockpit" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
      const data = (await res.json()) as {
        copilot_plan?: string;
        quota_snapshots?: Record<string, Record<string, unknown>>;
      };
      const premium = data.quota_snapshots?.premium_interactions ?? {};
      const snapshot: QuotaSnapshot = {
        takenAt: Date.now(),
        plan: typeof data.copilot_plan === "string" ? data.copilot_plan : null,
        entitlement: num(premium.entitlement),
        remaining: num(premium.remaining),
        percentRemaining: num(premium.percent_remaining),
        unlimited: premium.unlimited === true,
        overageCount: num(premium.overage_count),
      };
      this.#db
        .prepare(
          `INSERT INTO quota_snapshots (taken_at, plan, entitlement, remaining, percent_remaining, unlimited, overage_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.takenAt,
          snapshot.plan,
          snapshot.entitlement,
          snapshot.remaining,
          snapshot.percentRemaining,
          snapshot.unlimited ? 1 : 0,
          snapshot.overageCount,
        );
      this.#db.prepare("DELETE FROM quota_snapshots WHERE taken_at < ?").run(Date.now() - 400 * 86_400_000);
      this.#lastError = null;
      this.#hub.cockpit("quota.updated", snapshot);
      return snapshot;
    } catch (err) {
      this.#lastError = errorMessage(err);
      this.#log.warn("synchronisation du solde Copilot impossible", { error: this.#lastError });
      throw err;
    }
  }

  latest(): QuotaSnapshot | null {
    const row = this.#db.prepare("SELECT * FROM quota_snapshots ORDER BY taken_at DESC LIMIT 1").get() as
      | { taken_at: number; plan: string | null; entitlement: number | null; remaining: number | null; percent_remaining: number | null; unlimited: number; overage_count: number | null }
      | undefined;
    if (!row) return null;
    return {
      takenAt: row.taken_at,
      plan: row.plan,
      entitlement: row.entitlement,
      remaining: row.remaining,
      percentRemaining: row.percent_remaining,
      unlimited: row.unlimited === 1,
      overageCount: row.overage_count,
    };
  }
}
