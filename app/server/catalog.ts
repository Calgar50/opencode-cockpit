// Catalogue des modèles réellement utilisables, rafraîchi périodiquement : IA vues par opencode, confrontées à la liste que
// GitHub Copilot propose à ce compte (lue directement par le cockpit, même quand opencode est injoignable). Les IA du compte
// qui ne sont pas utilisables (désactivées par l'organisation, incompatibles) sont listées à part avec leur raison.
import type { CopilotApi, CopilotEndpoint, CopilotModel } from "./copilot.ts";
import { errorMessage } from "./log.ts";
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

/** IA du compte GitHub Copilot qui n'est pas utilisable, avec la raison affichée. */
export interface UnavailableModel {
  key: string;
  name: string;
  reason: string;
}

/** Origine de la dernière lecture (page Diagnostic, Paramètres › Connexion, adresse imposée à opencode). */
export interface CatalogSources {
  /** Échec de lecture auprès d'opencode, null si la liste a été lue. */
  opencodeError: string | null;
  /** Liste de GitHub Copilot lue directement : la présence et la disponibilité de chaque IA Copilot sont vérifiées. */
  copilotVerified: boolean;
  /** Échec de lecture auprès de GitHub Copilot, null si lue ou non connecté. */
  copilotError: string | null;
  endpoint: CopilotEndpoint | null;
  /** IA du compte non utilisables (vide si la liste Copilot n'a pas été lue). */
  unavailable: UnavailableModel[];
}

export const UNAVAILABLE_REASONS = Object.freeze({
  disabled: "Désactivée par la politique GitHub Copilot de votre organisation.",
  incompatible: "Non joignable par opencode 1.18.30 avec l'adresse d'API de votre abonnement (IA appelée par /v1/messages).",
});

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

const EMPTY_SOURCES: CatalogSources = Object.freeze({
  opencodeError: null,
  copilotVerified: false,
  copilotError: null,
  endpoint: null,
  unavailable: [],
});

function fromOpencode(provider: RawProvider, modelID: string, raw: RawModel): CatalogModel {
  return {
    key: `${provider.id}/${modelID}`,
    providerID: provider.id,
    providerName: provider.name ?? provider.id,
    modelID,
    name: raw.name ?? modelID,
    price: raw.cost ? priceFromCatalog(raw.cost) : null,
    contextLimit: raw.limit?.context ?? null,
    outputLimit: raw.limit?.output ?? null,
    reasoning: Boolean(raw.capabilities?.reasoning),
    attachment: Boolean(raw.capabilities?.attachment),
    toolcall: raw.capabilities?.toolcall !== false,
    variants: Object.keys(raw.variants ?? {}),
    status: raw.status ?? "active",
  };
}

function fromCopilot(m: CopilotModel): CatalogModel {
  return {
    key: m.key,
    providerID: m.providerID,
    providerName: m.providerName,
    modelID: m.modelID,
    name: m.name,
    price: m.price,
    contextLimit: m.contextLimit,
    outputLimit: m.outputLimit,
    reasoning: m.reasoning,
    attachment: m.attachment,
    toolcall: m.toolcall,
    variants: [...m.variants],
    status: m.status,
  };
}

export interface ModelCatalogOptions {
  /** Lecture directe de la liste GitHub Copilot ; absent : liste d'opencode seule (comportement 1.0.0). */
  copilot?: Pick<CopilotApi, "listModels"> | null;
}

export class ModelCatalog {
  #models = new Map<string, CatalogModel>();
  #defaults: Record<string, string> = {};
  #prices = new Map<string, ModelPrice>();
  #sources: CatalogSources = EMPTY_SOURCES;
  #loadedAt = 0;
  #timer: NodeJS.Timeout | undefined;
  /** Nouvel essai rapide tant que la liste n'a jamais été lue. */
  #retry: NodeJS.Timeout | undefined;
  #stopped = false;
  /** Empreinte de ce qui change la résolution des niveaux (IA, statut, outils, réflexions, prix) et l'adresse de l'API. */
  #signature = "";
  readonly #listeners = new Set<() => void>();

  readonly #client: OpencodeClient;
  readonly #copilot: Pick<CopilotApi, "listModels"> | null;

  constructor(client: OpencodeClient, options: ModelCatalogOptions = {}) {
    this.#client = client;
    this.#copilot = options.copilot ?? null;
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

  get sources(): CatalogSources {
    return this.#sources;
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

  /**
   * Lit opencode et GitHub Copilot en parallèle. opencode fait foi pour ce qu'il sait appeler (réflexions, prix de son
   * catalogue) ; la liste Copilot fait foi pour la présence et la disponibilité des IA Copilot : sans elle, opencode affiche
   * tout son catalogue embarqué dès que sa propre lecture de l'API Copilot échoue (pare-feu). Échec des deux : erreur,
   * liste précédente gardée.
   */
  async refresh(): Promise<void> {
    const [oc, cp] = await Promise.allSettled([
      this.#client.request<{ providers: RawProvider[]; default: Record<string, string> }>("GET", "/config/providers", { timeoutMs: 20_000 }),
      this.#copilot ? this.#copilot.listModels() : Promise.resolve(null),
    ]);
    const copilot = cp.status === "fulfilled" ? cp.value : null;
    if (oc.status === "rejected" && !copilot) {
      throw oc.reason instanceof Error ? oc.reason : new Error(errorMessage(oc.reason));
    }

    const fromOc = new Map<string, CatalogModel>();
    const data = oc.status === "fulfilled" ? oc.value : null;
    for (const provider of data?.providers ?? []) {
      for (const [modelID, raw] of Object.entries(provider.models ?? {})) {
        const model = fromOpencode(provider, modelID, raw);
        fromOc.set(model.key, model);
      }
    }

    const models = new Map<string, CatalogModel>();
    const unavailable: UnavailableModel[] = [];
    if (copilot) {
      const replaced = copilot.endpoint.url !== copilot.endpoint.opencodeDefault;
      for (const remote of copilot.models) {
        if (!remote.available) unavailable.push({ key: remote.key, name: remote.name, reason: UNAVAILABLE_REASONS.disabled });
        else if (replaced && remote.messagesApi) unavailable.push({ key: remote.key, name: remote.name, reason: UNAVAILABLE_REASONS.incompatible });
        else models.set(remote.key, fromOc.get(remote.key) ?? fromCopilot(remote));
      }
      for (const model of fromOc.values()) if (model.providerID !== "github-copilot") models.set(model.key, model);
    } else {
      for (const model of fromOc.values()) models.set(model.key, model);
    }
    const prices = new Map<string, ModelPrice>();
    for (const model of models.values()) if (model.price) prices.set(model.key, model.price);

    this.#models = models;
    this.#prices = prices;
    if (data) this.#defaults = data.default ?? {};
    this.#sources = {
      opencodeError: oc.status === "rejected" ? errorMessage(oc.reason) : null,
      copilotVerified: copilot !== null,
      copilotError: cp.status === "rejected" ? errorMessage(cp.reason) : null,
      endpoint: copilot?.endpoint ?? null,
      unavailable: unavailable.sort((a, b) => a.name.localeCompare(b.name)),
    };
    this.#loadedAt = Date.now();
    const signature = JSON.stringify([
      [...models.values()].sort((a, b) => a.key.localeCompare(b.key)).map((m) => [m.key, m.status, m.toolcall, m.variants, m.price]),
      this.#sources.endpoint?.url ?? null,
    ]);
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

  /**
   * Rafraîchit maintenant puis toutes les `intervalMs` ; les échecs sont signalés sans arrêter la boucle. Tant que la
   * liste n'a jamais été lue, un échec est retenté après `retryMs` (un seul essai en attente) : sans elle, les
   * enregistrements, installations et réalignements qui l'exigent resteraient refusés jusqu'au tour suivant.
   */
  startAutoRefresh(intervalMs: number, onError: (err: Error) => void, retryMs = 20_000): void {
    const tick = (): Promise<void> =>
      this.refresh().catch((err: Error) => {
        onError(err);
        if (this.loaded || this.#retry !== undefined || this.#stopped) return;
        this.#retry = setTimeout(() => {
          this.#retry = undefined;
          void tick();
        }, retryMs);
        this.#retry.unref();
      });
    this.#stopped = false;
    void tick();
    this.#timer = setInterval(tick, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }
}
