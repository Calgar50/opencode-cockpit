// Catalogue des modèles réellement utilisables (fournisseurs connectés), rafraîchi périodiquement.
import type { OpencodeClient } from "./opencode.ts";
import { type CatalogCost, type ModelPrice, priceFromCatalog } from "./pricing.ts";

export interface CatalogModel {
  key: string;
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  price: ModelPrice | null;
  contextLimit: number | null;
  outputLimit: number | null;
  reasoning: boolean;
  attachment: boolean;
  toolcall: boolean;
  variants: string[];
  status: string;
}

interface RawModel {
  id: string;
  name?: string;
  cost?: CatalogCost;
  limit?: { context?: number; output?: number };
  capabilities?: { reasoning?: boolean; attachment?: boolean; toolcall?: boolean };
  variants?: Record<string, unknown>;
  status?: string;
}

interface RawProvider {
  id: string;
  name?: string;
  models?: Record<string, RawModel>;
}

export class ModelCatalog {
  #models = new Map<string, CatalogModel>();
  #defaults: Record<string, string> = {};
  #prices = new Map<string, ModelPrice>();
  #loadedAt = 0;
  #timer: NodeJS.Timeout | undefined;

  readonly #client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.#client = client;
  }

  get loadedAt(): number {
    return this.#loadedAt;
  }

  get defaults(): Readonly<Record<string, string>> {
    return this.#defaults;
  }

  get prices(): ReadonlyMap<string, ModelPrice> {
    return this.#prices;
  }

  list(): CatalogModel[] {
    return [...this.#models.values()];
  }

  get(providerID: string, modelID: string): CatalogModel | undefined {
    return this.#models.get(`${providerID}/${modelID}`);
  }

  providers(): string[] {
    return [...new Set(this.list().map((m) => m.providerID))];
  }

  async refresh(): Promise<void> {
    const data = await this.#client.request<{ providers: RawProvider[]; default: Record<string, string> }>(
      "GET",
      "/config/providers",
      { timeoutMs: 20_000 },
    );
    const models = new Map<string, CatalogModel>();
    const prices = new Map<string, ModelPrice>();
    for (const provider of data.providers ?? []) {
      for (const [modelID, raw] of Object.entries(provider.models ?? {})) {
        const key = `${provider.id}/${modelID}`;
        const price = raw.cost ? priceFromCatalog(raw.cost) : null;
        if (price) prices.set(key, price);
        models.set(key, {
          key,
          providerID: provider.id,
          providerName: provider.name ?? provider.id,
          modelID,
          name: raw.name ?? modelID,
          price,
          contextLimit: raw.limit?.context ?? null,
          outputLimit: raw.limit?.output ?? null,
          reasoning: Boolean(raw.capabilities?.reasoning),
          attachment: Boolean(raw.capabilities?.attachment),
          toolcall: raw.capabilities?.toolcall !== false,
          variants: Object.keys(raw.variants ?? {}),
          status: raw.status ?? "active",
        });
      }
    }
    this.#models = models;
    this.#prices = prices;
    this.#defaults = data.default ?? {};
    this.#loadedAt = Date.now();
  }

  /** Rafraîchit maintenant puis toutes les `intervalMs` ; les échecs sont signalés sans arrêter la boucle. */
  startAutoRefresh(intervalMs: number, onError: (err: Error) => void): void {
    const tick = () => this.refresh().catch(onError);
    void tick();
    this.#timer = setInterval(tick, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }
}
