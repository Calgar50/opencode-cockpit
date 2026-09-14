// Accès direct à l'API GitHub Copilot depuis le cockpit, sans passer par opencode : adresse de l'API propre à
// l'abonnement (pare-feu d'entreprise à routage par abonnement) et liste des IA réellement proposées à ce compte.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CatalogModel } from "./catalog.ts";
import { errorMessage } from "./log.ts";
import { priceFromCatalog } from "./pricing.ts";
import { apiHostFor } from "./quota.ts";
import { redactSecrets } from "./redact.ts";
import { COPILOT_API_HOSTS, DEFAULT_COPILOT_API_URL, normalizeCopilotApiUrl } from "./shared/assistant-rules.ts";

/** Version d'API envoyée par opencode 1.18.30 (plugin/github-copilot/copilot.ts) : même contrat de réponse. */
export const COPILOT_API_VERSION = "2026-06-01";

/** Adresse annoncée par GitHub, et choix de cette adresse quand l'adresse d'office est bloquée, gardés une heure. */
const DISCOVERY_TTL_MS = 60 * 60_000;
/** Échec de lecture de l'adresse annoncée : nouvel essai possible après 30 s (jamais gardé une heure). */
const DISCOVERY_FAILURE_TTL_MS = 30_000;

export interface CopilotAuth {
  type?: string;
  refresh?: string;
  access?: string;
  enterpriseUrl?: string;
}

/**
 * env : COCKPIT_COPILOT_API_URL ; github : adresse de l'abonnement annoncée par GitHub, retenue parce que l'adresse d'office
 * est bloquée par le réseau ; defaut : adresse qu'opencode utilise d'office.
 */
export type CopilotEndpointSource = "env" | "github" | "defaut";

export interface CopilotEndpoint {
  url: string;
  source: CopilotEndpointSource;
  /** Abonnement annoncé par GitHub (copilot_plan), null s'il n'a pas été lu. */
  plan: string | null;
  /** Adresse qu'opencode utilise d'office (copilot.ts base()) : une adresse différente doit lui être imposée. */
  opencodeDefault: string;
}

/**
 * IA Copilot lue sur l'API. available : utilisable (politique de l'organisation autre que « disabled ») ; messagesApi :
 * jointe par /v1/messages (IA Anthropic), adresse suffixée par opencode.
 */
export interface CopilotModel extends CatalogModel {
  available: boolean;
  policyState: string | null;
  messagesApi: boolean;
}

export interface CopilotStatus {
  connected: boolean;
  /** Adresse de la dernière lecture réussie, ou adresse imposée par .env ; jamais une adresse restée en échec. */
  endpoint: CopilotEndpoint | null;
  /** Adresse de la dernière tentative, réussie ou non (Diagnostic). */
  lastTried: CopilotEndpoint | null;
  /** Dernière lecture réussie de la liste des IA (ms), 0 si jamais. */
  modelsAt: number;
  models: number;
  error: string | null;
  /** Échec de lecture de l'adresse annoncée par GitHub. */
  discoveryError: string | null;
}

export interface Reachability {
  host: string;
  reachable: boolean;
  detail: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * IA proposées dans le sélecteur de Copilot (model_picker_enabled). Utilisables selon les règles d'opencode 1.18.30
 * (plugin/github-copilot/models.ts : entrée décodable, limites et outils renseignés, politique autre que « disabled ») ;
 * une IA désactivée par l'organisation est gardée avec available: false pour l'afficher « pas disponible ». Réflexions
 * calculées comme opencode (efforts, réflexion adaptative, budget), prix convertis en USD par million de jetons.
 */
export function copilotModelsFromApi(data: unknown): CopilotModel[] {
  const items = rec(data)?.data;
  if (!Array.isArray(items)) throw new Error("Réponse inattendue de l'API Copilot : liste des IA absente.");
  const out: CopilotModel[] = [];
  for (const raw of items) {
    const item = rec(raw);
    const id = str(item?.id);
    const name = str(item?.name);
    if (!item || !id || !name || item.model_picker_enabled !== true) continue;
    const policyState = str(rec(item.policy)?.state) ?? null;
    const capabilities = rec(item.capabilities);
    const supports = rec(capabilities?.supports) ?? {};
    const limits = rec(capabilities?.limits);
    const maxOutput = num(limits?.max_output_tokens);
    const maxPrompt = num(limits?.max_prompt_tokens);
    const usable =
      str(item.version) !== undefined &&
      Boolean(str(capabilities?.family)) &&
      rec(capabilities?.supports) !== undefined &&
      maxOutput !== undefined &&
      maxPrompt !== undefined &&
      typeof supports.tool_calls === "boolean";
    // Inutilisable par opencode et pas désactivée : absente de sa liste, donc de celle du cockpit.
    if (!usable && policyState !== "disabled") continue;

    const efforts = strings(supports.reasoning_effort);
    const messagesApi = strings(item.supported_endpoints).includes("/v1/messages");
    const maxBudget = num(supports.max_thinking_budget);
    const reasoning =
      supports.adaptive_thinking === true || efforts.length > 0 || maxBudget !== undefined || num(supports.min_thinking_budget) !== undefined;
    let variants: string[] = [];
    if (!messagesApi && efforts.length > 0) variants = efforts;
    else if (efforts.length > 0 && supports.adaptive_thinking === true) variants = efforts;
    else if (maxBudget) variants = ["max", "high"];

    const prices = rec(rec(item.billing)?.token_prices);
    const batch = num(prices?.batch_size) ?? 0;
    const defaults = rec(prices?.default);
    const perMillion = batch > 0 ? 10_000 / batch : 0;
    const input = (num(defaults?.input_price) ?? 0) * perMillion;
    const output = (num(defaults?.output_price) ?? 0) * perMillion;
    const cacheRead = (num(defaults?.cache_price) ?? 0) * perMillion;

    out.push({
      key: `github-copilot/${id}`,
      providerID: "github-copilot",
      providerName: "GitHub Copilot",
      modelID: id,
      name,
      price: input > 0 || output > 0 ? priceFromCatalog({ input, output, cache: { read: cacheRead, write: 0 } }) : null,
      contextLimit: num(limits?.max_context_window_tokens) ?? maxPrompt ?? null,
      outputLimit: maxOutput ?? null,
      reasoning,
      attachment: true,
      toolcall: supports.tool_calls === true,
      variants: [...new Set(variants)],
      status: "active",
      available: usable && policyState !== "disabled",
      policyState,
      messagesApi,
    });
  }
  return out;
}

/**
 * Message court et sans secret pour un échec réseau (proxy, certificat, pare-feu). Toute la chaîne des causes est lue : avec
 * NODE_USE_ENV_PROXY, Node 24 range le refus du proxy deux niveaux plus bas (fetch failed › Request was cancelled ›
 * « Proxy response (403) !== 200 when HTTP Tunneling », mesuré).
 */
export function describeNetworkError(err: unknown, host: string): string {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 6; depth++) {
    const link = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof link.code === "string") codes.push(link.code);
    if (typeof link.message === "string") messages.push(link.message);
    current = link.cause;
  }
  const code = codes.join(" ");
  const detail = messages.join(" ");
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(`${code} ${detail}`)) {
    return `${host} : certificat non reconnu (proxy d'entreprise qui inspecte le HTTPS ?). Lancez « cockpit.ps1 certs ».`;
  }
  const proxy = /Proxy response \((\d{3})\)/i.exec(detail);
  if (proxy) return `${host} : refusé par le proxy d'entreprise (réponse ${proxy[1]}).`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `${host} : nom introuvable (DNS, ou proxy d'entreprise non configuré).`;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code) || /timeout|aborted/i.test(detail)) {
    return `${host} : injoignable (pare-feu ou proxy d'entreprise qui bloque cette adresse).`;
  }
  return `${host} : ${redactSecrets(errorMessage(err)).slice(0, 200)}`;
}

function describeStatus(status: number, host: string): string {
  if (status === 401) return `${host} : jeton GitHub Copilot refusé (401). Reconnectez GitHub Copilot.`;
  if (status === 403) return `${host} : accès refusé (403) : abonnement ou politique Copilot de l'organisation.`;
  if (status === 407) return `${host} : le proxy d'entreprise demande une authentification (407).`;
  return `${host} : réponse ${status}.`;
}

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

/** Résultat d'une lecture de /models : liste, ou blocage par le réseau (échec de connexion, réponse sans marque GitHub). */
type ModelsAttempt = { models: CopilotModel[] } | { blocked: string };

export interface CopilotApiDeps {
  opencodeDataDir: string;
  githubEnterpriseDomain: string | null;
  /** COCKPIT_COPILOT_API_URL déjà validée (normalizeCopilotApiUrl), null : automatique. */
  copilotApiUrl: string | null;
  version: string;
  fetch?: FetchLike;
}

export class CopilotApi {
  readonly #d: CopilotApiDeps;
  readonly #fetch: FetchLike;
  #discovered: { url: string | null; plan: string | null; until: number; token: string } | null = null;
  /** Adresse de l'abonnement retenue parce que l'adresse d'office était bloquée (jusqu'à `until`). */
  #preferred: { url: string; token: string; until: number } | null = null;
  #status: CopilotStatus = { connected: false, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null };

  constructor(deps: CopilotApiDeps) {
    this.#d = deps;
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  get status(): CopilotStatus {
    return this.#status;
  }

  /** Oublie l'adresse annoncée et l'adresse retenue : la lecture suivante repart de l'adresse d'office (test de connexion). */
  resetDiscovery(): void {
    this.#discovered = null;
    this.#preferred = null;
  }

  /** Connexion Copilot d'opencode (auth.json, lecture seule) ; null si absente ou illisible. */
  async auth(): Promise<CopilotAuth | null> {
    let all: Record<string, CopilotAuth>;
    try {
      all = JSON.parse(await fs.readFile(path.join(this.#d.opencodeDataDir, "auth.json"), "utf8")) as Record<string, CopilotAuth>;
    } catch {
      return null;
    }
    const auth = all["github-copilot"];
    return auth && auth.type === "oauth" && (auth.refresh || auth.access) ? auth : null;
  }

  #headers(extra: Record<string, string>): Record<string, string> {
    return { accept: "application/json", "user-agent": `opencode-cockpit/${this.#d.version}`, ...extra };
  }

  /** Même adresse qu'opencode (copilot.ts base()) : domaine GitHub Enterprise accepté seulement s'il est déclaré dans .env. */
  #opencodeDefault(auth: CopilotAuth): string {
    return auth.enterpriseUrl ? `https://copilot-${apiHostFor(auth.enterpriseUrl, this.#d.githubEnterpriseDomain)}` : DEFAULT_COPILOT_API_URL;
  }

  /** Adresse de l'abonnement annoncée par GitHub (copilot_internal/user), relue au plus toutes les heures. */
  async #discover(auth: CopilotAuth, token: string): Promise<{ url: string | null; plan: string | null }> {
    const print = fingerprint(token);
    if (this.#discovered && this.#discovered.token === print && Date.now() < this.#discovered.until) return this.#discovered;
    const host = apiHostFor(auth.enterpriseUrl, this.#d.githubEnterpriseDomain);
    let found: { url: string | null; plan: string | null } = { url: null, plan: null };
    let ok = false;
    try {
      const res = await this.#fetch(`https://${host}/copilot_internal/user`, {
        headers: this.#headers({ authorization: `token ${token}` }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (res.ok) {
        const data = rec(await res.json());
        ok = true;
        const api = str(rec(data?.endpoints)?.api);
        found = { url: api ? normalizeCopilotApiUrl(api, this.#d.githubEnterpriseDomain) : null, plan: str(data?.copilot_plan) ?? null };
        this.#status = { ...this.#status, discoveryError: api && !found.url ? `${host} : adresse d'API inattendue ignorée.` : null };
      } else {
        await res.body?.cancel().catch(() => undefined);
        this.#status = { ...this.#status, discoveryError: describeStatus(res.status, host) };
      }
    } catch (err) {
      this.#status = { ...this.#status, discoveryError: describeNetworkError(err, host) };
    }
    this.#discovered = { ...found, until: Date.now() + (ok ? DISCOVERY_TTL_MS : DISCOVERY_FAILURE_TTL_MS), token: print };
    return found;
  }

  /** Lecture de /models : erreur de GitHub (réponse marquée) levée, blocage par le réseau renvoyé pour essayer une autre adresse. */
  async #tryModels(url: string, token: string): Promise<ModelsAttempt> {
    const host = new URL(url).hostname;
    let res: Response;
    try {
      res = await this.#fetch(`${url}/models`, {
        headers: this.#headers({ authorization: `Bearer ${token}`, "x-github-api-version": COPILOT_API_VERSION }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch (err) {
      return { blocked: describeNetworkError(err, host) };
    }
    const marked = res.headers.has("x-github-request-id");
    if (res.ok) {
      try {
        return { models: copilotModelsFromApi(await res.json()) };
      } catch (err) {
        // Page de blocage servie en 200 par un proxy : blocage réseau, pas une erreur de GitHub.
        if (!marked) return { blocked: `${host} : réponse ${res.status} illisible sans marque GitHub (page de blocage du proxy ?).` };
        throw new Error(`${host} : réponse illisible de l'API Copilot (${redactSecrets(errorMessage(err)).slice(0, 120)}).`);
      }
    }
    await res.body?.cancel().catch(() => undefined);
    if (!marked) return { blocked: `${host} : réponse ${res.status} sans marque GitHub (page de blocage du proxy ?).` };
    throw new Error(describeStatus(res.status, host));
  }

  /**
   * IA proposées à ce compte ; null si GitHub Copilot n'est pas connecté. Adresse : celle de COCKPIT_COPILOT_API_URL, sinon
   * celle qu'opencode utilise d'office, sinon (adresse d'office bloquée par le réseau) l'adresse de l'abonnement annoncée
   * par GitHub, retenue une heure. Échec : erreur au message lisible, sans jeton.
   */
  async listModels(): Promise<{ models: CopilotModel[]; endpoint: CopilotEndpoint } | null> {
    const auth = await this.auth();
    if (!auth) {
      this.#status = { connected: false, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null };
      return null;
    }
    const token = auth.refresh || auth.access || "";
    const print = fingerprint(token);
    let endpoint: CopilotEndpoint | null = null;
    const done = (models: CopilotModel[], chosen: CopilotEndpoint) => {
      this.#status = { ...this.#status, connected: true, endpoint: chosen, lastTried: chosen, modelsAt: Date.now(), models: models.length, error: null };
      return { models, endpoint: chosen };
    };
    try {
      const opencodeDefault = this.#opencodeDefault(auth);
      if (this.#d.copilotApiUrl) {
        const { plan } = await this.#discover(auth, token);
        endpoint = { url: this.#d.copilotApiUrl, source: "env", plan, opencodeDefault };
        const attempt = await this.#tryModels(endpoint.url, token);
        if ("models" in attempt) return done(attempt.models, endpoint);
        throw new Error(attempt.blocked);
      }

      const preferred = this.#preferred && this.#preferred.token === print && Date.now() < this.#preferred.until ? this.#preferred.url : null;
      if (preferred) {
        endpoint = { url: preferred, source: "github", plan: this.#discovered?.plan ?? null, opencodeDefault };
        const attempt = await this.#tryModels(preferred, token);
        if ("models" in attempt) return done(attempt.models, endpoint);
        this.#preferred = null;
      }

      endpoint = { url: opencodeDefault, source: "defaut", plan: this.#discovered?.plan ?? null, opencodeDefault };
      const first = await this.#tryModels(opencodeDefault, token);
      if ("models" in first) return done(first.models, endpoint);

      // Adresse d'office bloquée par le réseau : adresse de l'abonnement annoncée par GitHub, si elle est différente.
      const discovered = await this.#discover(auth, token);
      if (!discovered.url || discovered.url === opencodeDefault) throw new Error(first.blocked);
      endpoint = { url: discovered.url, source: "github", plan: discovered.plan, opencodeDefault };
      const second = await this.#tryModels(discovered.url, token);
      if (!("models" in second)) throw new Error(`${first.blocked} ${second.blocked}`);
      this.#preferred = { url: discovered.url, token: print, until: Date.now() + DISCOVERY_TTL_MS };
      return done(second.models, endpoint);
    } catch (err) {
      // Adresse en échec : jamais présentée comme l'adresse utilisée (ni imposée à opencode), sauf celle de .env.
      const kept = endpoint?.source === "env" ? endpoint : this.#status.endpoint;
      this.#status = { ...this.#status, connected: true, endpoint: kept, lastTried: endpoint, error: errorMessage(err) };
      throw err;
    }
  }

  /**
   * Joignabilité des adresses GitHub et Copilot à travers le proxy du cockpit, SANS jeton. Une réponse portant l'en-tête
   * x-github-request-id vient de GitHub ; toute autre réponse est probablement une page de blocage du proxy.
   */
  async probeHosts(): Promise<Reachability[]> {
    const domain = this.#d.githubEnterpriseDomain;
    const hosts = [...COPILOT_API_HOSTS, "api.github.com", "github.com", ...(domain ? [`copilot-api.${domain}`, `api.${domain}`] : [])];
    return Promise.all(
      hosts.map(async (host): Promise<Reachability> => {
        try {
          const res = await this.#fetch(`https://${host}/`, {
            headers: this.#headers({}),
            signal: AbortSignal.timeout(15_000),
            redirect: "manual",
          });
          await res.body?.cancel().catch(() => undefined);
          if (res.headers.has("x-github-request-id")) return { host, reachable: true, detail: `joignable (réponse ${res.status})` };
          return { host, reachable: false, detail: `réponse ${res.status} sans marque GitHub : page de blocage du proxy ?` };
        } catch (err) {
          return { host, reachable: false, detail: describeNetworkError(err, host) };
        }
      }),
    );
  }
}
