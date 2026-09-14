// Adresse de l'API Copilot imposée à opencode (options.baseURL du fournisseur github-copilot) quand le cockpit en retient une
// autre que l'adresse d'office : imposée par .env, ou adresse de l'abonnement quand le réseau bloque l'adresse générale.
// Écrite par PATCH /global/config : opencode 1.18.30 ne relit pas une écriture directe de son fichier global, même après
// /global/dispose (mesuré). Jamais pendant qu'une conversation travaille.
import type { ModelCatalog } from "./catalog.ts";
import type { CopilotApi, CopilotEndpoint } from "./copilot.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";

export type CopilotSyncState = "inactif" | "a-jour" | "applique" | "en-attente" | "echec";

export interface CopilotSyncStatus {
  state: CopilotSyncState;
  message: string | null;
  at: number;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Adresse à écrire : undefined tant que l'adresse retenue est inconnue ; "" = adresse d'office d'opencode. */
export function copilotBaseUrlTarget(endpoint: CopilotEndpoint | null): string | undefined {
  if (!endpoint) return undefined;
  return endpoint.url === endpoint.opencodeDefault ? "" : endpoint.url;
}

/** Adresse lue dans la configuration effective d'opencode ("" si aucune). */
export function currentCopilotBaseUrl(effective: unknown): string {
  const raw = rec(rec(rec(rec(effective)?.provider)?.["github-copilot"])?.options)?.baseURL;
  return typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
}

export interface CopilotConfigSyncDeps {
  client: Pick<OpencodeClient, "request">;
  catalog: Pick<ModelCatalog, "sources" | "refresh">;
  /** Adresse imposée par .env, appliquée même quand la dernière lecture de la liste des IA a échoué. */
  copilot: Pick<CopilotApi, "status">;
  hub: Pick<EventHub, "cockpit">;
  log: Logger;
  /** true si une conversation travaille : l'écriture attend la vérification suivante. */
  busy: () => Promise<boolean>;
  /** Délai avant une nouvelle tentative après « en-attente » (conversation en cours, opencode qui redémarre). */
  retryMs?: number;
}

export class CopilotConfigSync {
  readonly #d: CopilotConfigSyncDeps;
  #running: Promise<CopilotSyncStatus> | null = null;
  #retry: NodeJS.Timeout | undefined;
  #stopped = false;
  #status: CopilotSyncStatus = { state: "inactif", message: null, at: 0 };

  constructor(deps: CopilotConfigSyncDeps) {
    this.#d = deps;
  }

  get status(): CopilotSyncStatus {
    return this.#status;
  }

  /** Une seule synchronisation à la fois ; un appel pendant qu'elle tourne reçoit son résultat. */
  sync(): Promise<CopilotSyncStatus> {
    if (this.#running) return this.#running;
    this.#running = this.#sync()
      .catch((err: unknown) => this.#set("echec", errorMessage(err)))
      .then((status) => {
        if (status.state === "en-attente") this.#scheduleRetry();
        return status;
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  /** Une seule nouvelle tentative en attente : sans elle, l'état resterait « en-attente » jusqu'au prochain changement. */
  #scheduleRetry(): void {
    if (this.#retry !== undefined || this.#stopped) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.sync();
    }, this.#d.retryMs ?? 30_000);
    this.#retry.unref();
  }

  #set(state: CopilotSyncState, message: string | null): CopilotSyncStatus {
    this.#status = { state, message, at: Date.now() };
    return this.#status;
  }

  async #sync(): Promise<CopilotSyncStatus> {
    const { client, catalog, log } = this.#d;
    // Seule une adresse confirmée par une lecture réussie est écrite, ou celle imposée par .env : une lecture en échec
    // (coupure réseau, jeton refusé) ne déplace jamais opencode.
    const last = this.#d.copilot.status.endpoint;
    const target = copilotBaseUrlTarget(catalog.sources.endpoint ?? (last?.source === "env" ? last : null));
    if (target === undefined) return this.#set("inactif", null);

    let effective: unknown;
    try {
      effective = await client.request<unknown>("GET", "/global/config", { timeoutMs: 10_000 });
    } catch (err) {
      return this.#set("en-attente", `opencode injoignable : ${errorMessage(err)}`);
    }
    if (currentCopilotBaseUrl(effective) === target) return this.#set("a-jour", null);
    if (await this.#d.busy().catch(() => true)) {
      return this.#set("en-attente", "Une conversation travaille : adresse appliquée à la prochaine vérification.");
    }

    try {
      await client.request("PATCH", "/global/config", { body: { provider: { "github-copilot": { options: { baseURL: target } } } }, timeoutMs: 30_000 });
      await client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
      const after = await client.request<unknown>("GET", "/global/config", { timeoutMs: 20_000 });
      if (currentCopilotBaseUrl(after) !== target) throw new Error("adresse écrite mais non appliquée par opencode");
    } catch (err) {
      log.warn("adresse de l'API Copilot non appliquée à opencode", { error: errorMessage(err) });
      return this.#set("echec", errorMessage(err));
    }
    log.info("adresse de l'API Copilot appliquée à opencode", { baseURL: target || "(adresse d'office)" });
    this.#d.hub.cockpit("opencode.config.changed", {});
    await catalog.refresh().catch(() => undefined);
    return this.#set("applique", null);
  }
}
