// Catalogue des modèles réellement utilisables (fournisseurs connectés), rafraîchi périodiquement.
import type { OpencodeClient } from "./opencode.ts";
import { type CatalogCost, type ModelPrice, priceFromCatalog } from "./pricing.ts";
import { type CatalogLite, toCatalogLite } from "./shared/assistant-rules.ts";

/** Modèles du catalogue réduits pour le résolveur partagé (statut, outils et réflexions compris). */
export function catalogLite(models: readonly CatalogModel[]): CatalogLite[] {
  return toCatalogLite(models);
}

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
  /** Empreinte de ce qui change la résolution des niveaux (IA, statut, outils, réflexions, prix). */
  #signature = "";
  readonly #listeners = new Set<() => void>();

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

  /** true dès que le catalogue a été lu au moins une fois. */
  get loaded(): boolean {
    return this.#loadedAt > 0;
  }

  list(): CatalogModel[] {
    return [...this.#models.values()];
  }

  /** Catalogue pour le résolveur partagé ; vide tant qu'il n'est pas chargé (= « non vérifié »). */
  lite(): CatalogLite[] {
    return catalogLite(this.list());
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
    const signature = JSON.stringify(
      [...models.values()].sort((a, b) => a.key.localeCompare(b.key)).map((m) => [m.key, m.status, m.toolcall, m.variants, m.price]),
    );
    if (signature !== this.#signature) {
      this.#signature = signature;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch {
          // Un abonné en échec ne doit pas empêcher la mise à jour du catalogue.
        }
      }
    }
  }

  /** Appelé après une lecture du catalogue qui change la liste des IA (première lecture comprise). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
