import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { describe, it } from "node:test";
import { ModelCatalog, UNAVAILABLE_REASONS } from "./catalog.ts";
import { CopilotApi, type CopilotEndpoint, type CopilotModel, copilotModelsFromApi, type FetchLike } from "./copilot.ts";
import { EnvError, loadEnv, parseCopilotApiUrl } from "./env.ts";
import type { Logger } from "./log.ts";
import { CopilotConfigSync, copilotBaseUrlTarget, currentCopilotBaseUrl } from "./oc-copilot-config.ts";
import type { OpencodeClient } from "./opencode.ts";
import { configProviderIssues, normalizeCopilotApiUrl } from "./shared/assistant-rules.ts";
import { certificateBlocks, trustCorporateCertificates } from "./tls-trust.ts";

const TOKEN = `gho_${"x".repeat(36)}`;
const COPILOT = ["github-copilot"];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** Entrée de GET /models de l'API Copilot (forme lue par opencode 1.18.30, plugin/github-copilot/models.ts). */
const remote = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  version: `${id}-2026-01-01`,
  model_picker_enabled: true,
  policy: { state: "enabled" },
  capabilities: {
    family: id,
    limits: { max_context_window_tokens: 400_000, max_output_tokens: 64_000, max_prompt_tokens: 272_000 },
    supports: { tool_calls: true, reasoning_effort: ["low", "high"] },
  },
  supported_endpoints: ["/chat/completions", "/responses"],
  billing: { token_prices: { batch_size: 10_000, default: { input_price: 2.5, output_price: 15, cache_price: 0.25 } } },
  ...extra,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const connected = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-copilot-"));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "github-copilot": { type: "oauth", refresh: TOKEN, access: TOKEN, expires: 0 } }));
  return dir;
};

const api = (fetch: FetchLike, copilotApiUrl: string | null = null) =>
  new CopilotApi({ opencodeDataDir: connected(), githubEnterpriseDomain: null, copilotApiUrl, version: "test", fetch });

/** Forme mesurée d'un refus du proxy (Node 24, NODE_USE_ENV_PROXY=1) : deux niveaux de causes sous « fetch failed ». */
const proxyRefusal = () =>
  new TypeError("fetch failed", {
    cause: new Error("Request was cancelled.", {
      cause: Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), { name: "AbortError", code: "UND_ERR_ABORTED" }),
    }),
  });

describe("adresse de l'API GitHub Copilot", () => {
  it(".env : adresse limitée aux hôtes GitHub Copilot officiels", () => {
    assert.equal(parseCopilotApiUrl("https://api.business.githubcopilot.com/", null), "https://api.business.githubcopilot.com");
    assert.equal(parseCopilotApiUrl(" ", null), null);
    for (const bad of [
      "http://api.business.githubcopilot.com",
      "https://api.business.githubcopilot.com/v1",
      "https://api.githubcopilot.com.evil.example",
      "https://evilgithubcopilot.com",
      "https://user:pw@api.githubcopilot.com",
      "https://api.githubcopilot.com:8443",
      "https://api.githubcopilot.com/?x=1",
    ]) {
      assert.throws(() => parseCopilotApiUrl(bad, null), EnvError, bad);
    }
    assert.equal(normalizeCopilotApiUrl("https://copilot-api.entreprise.ghe.com", "entreprise.ghe.com"), "https://copilot-api.entreprise.ghe.com");
    assert.equal(normalizeCopilotApiUrl("https://copilot-api.autre.ghe.com", "entreprise.ghe.com"), null);
    const base = { COCKPIT_TOKEN: "t".repeat(32), OPENCODE_SERVER_PASSWORD: "p".repeat(16) };
    assert.equal(loadEnv({ ...base, COCKPIT_COPILOT_API_URL: "https://api.business.githubcopilot.com" }).copilotApiUrl, "https://api.business.githubcopilot.com");
    assert.equal(loadEnv(base).copilotApiUrl, null);
    assert.throws(() => loadEnv({ ...base, COCKPIT_COPILOT_API_URL: "https://proxy.example" }), EnvError);
  });

  it("verrou d'opencode : adresse d'API officielle seulement (le jeton y part)", () => {
    const base = { enabled_providers: ["github-copilot"] };
    const withUrl = (baseURL: unknown) => ({ ...base, provider: { "github-copilot": { options: { baseURL } } } });
    assert.deepEqual(configProviderIssues(withUrl("https://api.business.githubcopilot.com"), COPILOT), []);
    assert.deepEqual(configProviderIssues(withUrl(""), COPILOT), []);
    assert.deepEqual(
      configProviderIssues(withUrl("https://exfiltration.example"), COPILOT).map((i) => i.path),
      ["provider.github-copilot.options.baseURL"],
    );
    assert.deepEqual(
      configProviderIssues(withUrl(42), COPILOT).map((i) => i.path),
      ["provider.github-copilot.options.baseURL"],
    );
    assert.deepEqual(configProviderIssues(withUrl("https://copilot-api.entreprise.ghe.com"), COPILOT, "entreprise.ghe.com"), []);
    // Autres clés qu'opencode lit pour l'adresse (provider.ts:1515) et module d'accès qui reçoit le jeton.
    const gateway = {
      ...base,
      provider: {
        "github-copilot": {
          options: { baseURL: "" },
          api: "https://llm-gateway.example",
          npm: "@exemple/sdk",
          models: {
            "gpt-5-mini": { provider: { api: "https://llm-gateway.example", npm: "@exemple/sdk" } },
            "gpt-5.4": { provider: { api: "https://api.business.githubcopilot.com" } },
          },
        },
      },
    };
    assert.deepEqual(
      configProviderIssues(gateway, COPILOT).map((i) => i.path),
      [
        "provider.github-copilot.api",
        "provider.github-copilot.npm",
        "provider.github-copilot.models.gpt-5-mini.provider.api",
        "provider.github-copilot.models.gpt-5-mini.provider.npm",
      ],
    );
  });
});

describe("API GitHub Copilot", () => {
  it("liste des IA : disponibles, désactivées par l'organisation gardées « pas disponibles », règles d'opencode", () => {
    const models = copilotModelsFromApi({
      data: [
        remote("gpt-5.4-mini"),
        remote("cachee", { model_picker_enabled: false }),
        remote("gpt-6-astra", { policy: { state: "disabled" } }),
        remote("interdite-incomplete", { policy: { state: "disabled" }, capabilities: { family: "x" } }),
        remote("incomplete", { capabilities: { family: "x", limits: { max_output_tokens: 1 }, supports: { tool_calls: true } } }),
        remote("claude-sonnet-5", {
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude",
            limits: { max_output_tokens: 32_000, max_prompt_tokens: 200_000 },
            supports: { tool_calls: true, adaptive_thinking: true, reasoning_effort: ["low", "medium", "high"] },
          },
        }),
        remote("budget", {
          supported_endpoints: ["/v1/messages"],
          capabilities: { family: "b", limits: { max_output_tokens: 1_000, max_prompt_tokens: 1_000 }, supports: { tool_calls: false, max_thinking_budget: 32_000 } },
        }),
        "illisible",
      ],
    });
    assert.deepEqual(
      models.map((m) => [m.modelID, m.available]),
      [
        ["gpt-5.4-mini", true],
        ["gpt-6-astra", false],
        ["interdite-incomplete", false],
        ["claude-sonnet-5", true],
        ["budget", true],
      ],
    );
    const byId = Object.fromEntries(models.map((m) => [m.modelID, m]));
    assert.deepEqual(byId["gpt-5.4-mini"]?.variants, ["low", "high"]);
    assert.equal(byId["gpt-5.4-mini"]?.contextLimit, 400_000);
    assert.equal(byId["gpt-5.4-mini"]?.price?.rates.input, 2.5);
    assert.equal(byId["gpt-5.4-mini"]?.price?.rates.output, 15);
    assert.equal(byId["gpt-6-astra"]?.policyState, "disabled");
    assert.deepEqual(byId["claude-sonnet-5"]?.variants, ["low", "medium", "high"]);
    assert.equal(byId["claude-sonnet-5"]?.messagesApi, true);
    assert.deepEqual(byId.budget?.variants, ["max", "high"]);
    assert.equal(byId.budget?.toolcall, false);
    assert.throws(() => copilotModelsFromApi({}), /liste des IA absente/);
  });

  it("adresse d'office joignable : utilisée, aucune adresse d'abonnement demandée (compte individuel, réseau ouvert)", async () => {
    const calls: string[] = [];
    const client = api(async (url) => {
      calls.push(url);
      if (url.endsWith("/copilot_internal/user")) return json(200, { endpoints: { api: "https://api.individual.githubcopilot.com" } });
      return json(200, { data: [remote("gpt-5.4-mini")] }, { "x-github-request-id": "A" });
    });
    const result = await client.listModels();
    assert.equal(result?.endpoint.source, "defaut");
    assert.equal(result?.endpoint.url, "https://api.githubcopilot.com");
    assert.deepEqual(calls, ["https://api.githubcopilot.com/models"]);
  });

  it("adresse d'office bloquée : adresse de l'abonnement annoncée par GitHub, retenue ; jeton envoyé seulement aux hôtes reconnus", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let announced = "https://api.business.githubcopilot.com";
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      if (url === "https://api.github.com/copilot_internal/user") return json(200, { copilot_plan: "business", endpoints: { api: announced } });
      if (url === "https://api.githubcopilot.com/models") throw proxyRefusal();
      if (url.endsWith("/models")) return json(200, { data: [remote("gpt-5.4-mini")] }, { "x-github-request-id": "B" });
      return json(404, {});
    };
    const client = api(fetch);
    const result = await client.listModels();
    assert.deepEqual(result?.endpoint, {
      url: "https://api.business.githubcopilot.com",
      source: "github",
      plan: "business",
      opencodeDefault: "https://api.githubcopilot.com",
    });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://api.githubcopilot.com/models", "https://api.github.com/copilot_internal/user", "https://api.business.githubcopilot.com/models"],
    );
    assert.equal(calls[1]?.headers.authorization, `token ${TOKEN}`);
    assert.equal(calls[2]?.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[2]?.headers["x-github-api-version"], "2026-06-01");
    // Lecture suivante : adresse de l'abonnement directement.
    calls.length = 0;
    await client.listModels();
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://api.business.githubcopilot.com/models"],
    );

    // Page de blocage du proxy (réponse sans marque GitHub) : même repli.
    const page = api(async (url, init) => (url === "https://api.githubcopilot.com/models" ? new Response("Site bloqué", { status: 403 }) : fetch(url, init)));
    assert.equal((await page.listModels())?.endpoint.source, "github");
    // Page de blocage servie en 200 : même repli, pas une erreur de lecture.
    const html = api(async (url, init) =>
      url === "https://api.githubcopilot.com/models"
        ? new Response("<!DOCTYPE html><title>Bloqué</title>", { status: 200, headers: { "content-type": "text/html" } })
        : fetch(url, init),
    );
    assert.equal((await html.listModels())?.endpoint.source, "github");

    // Adresse annoncée hors des hôtes GitHub Copilot : ignorée (le jeton n'y part jamais), l'échec d'origine est rapporté.
    announced = "https://copilot.evil.example";
    calls.length = 0;
    const other = api(fetch);
    await assert.rejects(other.listModels(), /api\.githubcopilot\.com : refusé par le proxy d'entreprise \(réponse 403\)/);
    assert.equal(
      calls.some((c) => c.url.includes("evil")),
      false,
    );
    assert.match(other.status.discoveryError ?? "", /inattendue/);

    // Adresse imposée par .env : prioritaire, sans essai de l'adresse d'office.
    calls.length = 0;
    const forced = api(fetch, "https://api.enterprise.githubcopilot.com");
    assert.equal((await forced.listModels())?.endpoint.url, "https://api.enterprise.githubcopilot.com");
    assert.equal(
      calls.some((c) => c.url === "https://api.githubcopilot.com/models"),
      false,
    );
  });

  it("adresse de l'abonnement illisible : échec jamais présenté comme l'adresse utilisée ; « Tester la connexion » repart de zéro", async () => {
    let userCalls = 0;
    let down = true;
    const client = api(async (url) => {
      if (url === "https://api.githubcopilot.com/models") throw proxyRefusal();
      if (url.endsWith("/copilot_internal/user")) {
        userCalls++;
        if (down) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        return json(200, { endpoints: { api: "https://api.business.githubcopilot.com" } });
      }
      return json(200, { data: [remote("gpt-5.4-mini")] }, { "x-github-request-id": "E" });
    });
    await assert.rejects(client.listModels());
    assert.equal(client.status.endpoint, null);
    assert.equal(client.status.lastTried?.url, "https://api.githubcopilot.com");
    assert.match(client.status.discoveryError ?? "", /injoignable/);
    down = false;
    client.resetDiscovery();
    const result = await client.listModels();
    assert.equal(result?.endpoint.url, "https://api.business.githubcopilot.com");
    const recovered = client.status;
    assert.equal(recovered.endpoint?.url, "https://api.business.githubcopilot.com");
    assert.equal(userCalls, 2);
  });

  it("non connecté : null ; refus de GitHub et pannes réseau : messages lisibles, sans jeton", async () => {
    const absent = new CopilotApi({ opencodeDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-noauth-")), githubEnterpriseDomain: null, copilotApiUrl: null, version: "test" });
    assert.equal(await absent.listModels(), null);

    const refused = api(async (url) => (url.endsWith("/models") ? json(401, { message: "bad" }, { "x-github-request-id": "C" }) : json(500, {})));
    await assert.rejects(refused.listModels(), /jeton GitHub Copilot refusé \(401\)/);
    assert.match(refused.status.error ?? "", /401/);

    const cert = Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify" } });
    const intercepted = api(async () => Promise.reject(cert), "https://api.business.githubcopilot.com");
    await assert.rejects(intercepted.listModels(), (err: Error) => /certificat non reconnu/.test(err.message) && !err.message.includes(TOKEN));
  });

  it("joignabilité sans jeton : seule une réponse marquée par GitHub compte", async () => {
    const seen: Array<Record<string, string>> = [];
    const client = api(async (url, init) => {
      seen.push(init.headers as Record<string, string>);
      if (url === "https://api.githubcopilot.com/") throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      if (url === "https://api.business.githubcopilot.com/") return json(404, {}, { "x-github-request-id": "D" });
      return new Response("Accès bloqué par la politique de sécurité", { status: 403 });
    });
    const byHost = Object.fromEntries((await client.probeHosts()).map((h) => [h.host, h]));
    assert.equal(byHost["api.business.githubcopilot.com"]?.reachable, true);
    assert.equal(byHost["api.githubcopilot.com"]?.reachable, false);
    assert.match(byHost["api.githubcopilot.com"]?.detail ?? "", /injoignable/);
    assert.equal(byHost["api.enterprise.githubcopilot.com"]?.reachable, false);
    assert.match(byHost["api.enterprise.githubcopilot.com"]?.detail ?? "", /page de blocage/);
    assert.equal(
      seen.some((h) => "authorization" in h),
      false,
    );
  });
});

describe("catalogue des IA", () => {
  const ocProviders = {
    providers: [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        models: Object.fromEntries(["gpt-5.4-mini", "gpt-6-astra", "claude-opus-5", "gemini-3.8-flash"].map((id) => [id, { id, name: `oc ${id}`, variants: { high: {} } }])),
      },
    ],
    default: { "github-copilot": "gpt-5.4-mini" },
  };
  const client = (fail = false) =>
    ({
      request: async () => {
        if (fail) throw new Error("opencode injoignable");
        return ocProviders;
      },
    }) as unknown as OpencodeClient;
  const endpoint = (url = "https://api.githubcopilot.com"): CopilotEndpoint => ({ url, source: "github", plan: "business", opencodeDefault: "https://api.githubcopilot.com" });
  const copilotList = (models: CopilotModel[], url?: string) => ({ listModels: async () => ({ models, endpoint: endpoint(url) }) });

  it("liste Copilot : IA du compte seulement, désactivées listées « pas disponibles », réflexions d'opencode conservées", async () => {
    const models = copilotModelsFromApi({ data: [remote("gpt-5.4-mini"), remote("gpt-6-astra", { policy: { state: "disabled" } }), remote("gpt-5-mini")] });
    const catalog = new ModelCatalog(client(), { copilot: copilotList(models) });
    await catalog.refresh();
    assert.deepEqual(
      catalog.list().map((m) => m.key),
      ["github-copilot/gpt-5.4-mini", "github-copilot/gpt-5-mini"],
    );
    assert.equal(catalog.get("github-copilot", "gpt-5.4-mini")?.name, "oc gpt-5.4-mini");
    assert.deepEqual(catalog.get("github-copilot", "gpt-5-mini")?.variants, ["low", "high"]);
    assert.deepEqual(catalog.sources.unavailable, [{ key: "github-copilot/gpt-6-astra", name: "GPT-6-ASTRA", reason: UNAVAILABLE_REASONS.disabled }]);
    assert.equal(catalog.sources.copilotVerified, true);
    assert.deepEqual(catalog.defaults, { "github-copilot": "gpt-5.4-mini" });
  });

  it("opencode injoignable : liste lue chez GitHub Copilot ; les deux en échec : erreur", async () => {
    const models = copilotModelsFromApi({ data: [remote("gpt-5.4-mini")] });
    const catalog = new ModelCatalog(client(true), { copilot: copilotList(models) });
    await catalog.refresh();
    assert.equal(catalog.loaded, true);
    assert.deepEqual(
      catalog.list().map((m) => m.key),
      ["github-copilot/gpt-5.4-mini"],
    );
    assert.equal(catalog.sources.opencodeError, "opencode injoignable");
    const none = new ModelCatalog(client(true), { copilot: { listModels: async () => null } });
    await assert.rejects(none.refresh(), /opencode injoignable/);
    assert.equal(none.loaded, false);
  });

  it("liste Copilot illisible : liste d'opencode non vérifiée ; adresse remplacée : IA Anthropic « pas disponibles »", async () => {
    const failing = new ModelCatalog(client(), {
      copilot: {
        listModels: async () => {
          throw new Error("api.githubcopilot.com : injoignable");
        },
      },
    });
    await failing.refresh();
    assert.equal(failing.list().length, 4);
    assert.equal(failing.sources.copilotVerified, false);
    assert.match(failing.sources.copilotError ?? "", /injoignable/);
    assert.deepEqual(failing.sources.unavailable, []);

    const models = copilotModelsFromApi({ data: [remote("gpt-5.4-mini"), remote("claude-opus-5", { supported_endpoints: ["/v1/messages"] })] });
    const replaced = new ModelCatalog(client(), { copilot: copilotList(models, "https://api.business.githubcopilot.com") });
    await replaced.refresh();
    assert.deepEqual(
      replaced.list().map((m) => m.modelID),
      ["gpt-5.4-mini"],
    );
    assert.deepEqual(
      replaced.sources.unavailable.map((m) => [m.key, m.reason]),
      [["github-copilot/claude-opus-5", UNAVAILABLE_REASONS.incompatible]],
    );
  });

  it("sans source Copilot : comportement 1.0.0 (liste d'opencode telle quelle)", async () => {
    const catalog = new ModelCatalog(client());
    await catalog.refresh();
    assert.equal(catalog.list().length, 4);
    assert.equal(catalog.sources.copilotVerified, false);
  });
});

describe("adresse de l'API Copilot imposée à opencode", () => {
  const ep = (url: string, source: CopilotEndpoint["source"] = "github"): CopilotEndpoint => ({ url, source, plan: null, opencodeDefault: "https://api.githubcopilot.com" });

  it("adresse attendue et adresse effective", () => {
    assert.equal(copilotBaseUrlTarget(null), undefined);
    assert.equal(copilotBaseUrlTarget(ep("https://api.business.githubcopilot.com")), "https://api.business.githubcopilot.com");
    assert.equal(copilotBaseUrlTarget(ep("https://api.githubcopilot.com", "defaut")), "");
    assert.equal(currentCopilotBaseUrl({ provider: { "github-copilot": { options: { baseURL: "https://api.business.githubcopilot.com/" } } } }), "https://api.business.githubcopilot.com");
    assert.equal(currentCopilotBaseUrl({}), "");
  });

  it("PATCH vérifié : attente pendant une conversation, application, retour à l'adresse d'office, échec rapporté", async () => {
    let config: Record<string, unknown> = { enabled_providers: ["github-copilot"] };
    let busy = true;
    let failPatch = false;
    let refreshes = 0;
    const requests: string[] = [];
    let endpoint: CopilotEndpoint | null = ep("https://api.business.githubcopilot.com");
    const client = {
      request: async (method: string, pathname: string, options?: { body?: unknown }) => {
        requests.push(`${method} ${pathname}`);
        if (method === "GET") return structuredClone(config);
        if (method === "PATCH") {
          if (failPatch) throw new Error("opencode 400 ConfigInvalidError");
          const provider = (options?.body as { provider: Record<string, unknown> }).provider;
          config = { ...config, provider };
        }
        return true;
      },
    } as unknown as OpencodeClient;
    const sync = new CopilotConfigSync({
      client,
      catalog: {
        get sources() {
          return { opencodeError: null, copilotVerified: true, copilotError: null, endpoint, unavailable: [] };
        },
        refresh: async () => {
          refreshes++;
        },
      } as unknown as ModelCatalog,
      copilot: { status: { connected: true, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null } },
      hub: { cockpit: () => undefined },
      log: quiet,
      busy: async () => busy,
    });

    assert.equal((await sync.sync()).state, "en-attente");
    assert.equal(requests.includes("PATCH /global/config"), false);

    busy = false;
    assert.equal((await sync.sync()).state, "applique");
    assert.equal(currentCopilotBaseUrl(config), "https://api.business.githubcopilot.com");
    assert.deepEqual(requests.slice(-3), ["PATCH /global/config", "POST /global/dispose", "GET /global/config"]);
    assert.equal(refreshes, 1);
    assert.equal((await sync.sync()).state, "a-jour");

    // Adresse générale de nouveau joignable : retour à l'adresse d'office.
    endpoint = ep("https://api.githubcopilot.com", "defaut");
    assert.equal((await sync.sync()).state, "applique");
    assert.equal(currentCopilotBaseUrl(config), "");

    endpoint = ep("https://api.enterprise.githubcopilot.com", "env");
    failPatch = true;
    const failed = await sync.sync();
    assert.equal(failed.state, "echec");
    assert.match(failed.message ?? "", /ConfigInvalidError/);

    endpoint = null;
    assert.equal((await sync.sync()).state, "inactif");
  });

  it("lecture de la liste en échec : rien n'est écrit dans opencode, sauf l'adresse imposée par .env", async () => {
    let config: Record<string, unknown> = { provider: { "github-copilot": { options: { baseURL: "https://api.business.githubcopilot.com" } } } };
    const requests: string[] = [];
    let status = {
      connected: true,
      endpoint: ep("https://api.business.githubcopilot.com") as CopilotEndpoint | null,
      lastTried: ep("https://api.githubcopilot.com", "defaut") as CopilotEndpoint | null,
      modelsAt: 0,
      models: 0,
      error: "api.githubcopilot.com : injoignable",
      discoveryError: null,
    };
    const client = {
      request: async (method: string, pathname: string, options?: { body?: unknown }) => {
        requests.push(`${method} ${pathname}`);
        if (method === "GET") return structuredClone(config);
        if (method === "PATCH") config = { provider: (options?.body as { provider: unknown }).provider };
        return true;
      },
    } as unknown as OpencodeClient;
    const sync = new CopilotConfigSync({
      client,
      catalog: {
        sources: { opencodeError: null, copilotVerified: false, copilotError: status.error, endpoint: null, unavailable: [] },
        refresh: async () => undefined,
      } as unknown as ModelCatalog,
      copilot: {
        get status() {
          return status;
        },
      },
      hub: { cockpit: () => undefined },
      log: quiet,
      busy: async () => false,
    });
    assert.equal((await sync.sync()).state, "inactif");
    assert.deepEqual(requests, []);
    assert.equal(currentCopilotBaseUrl(config), "https://api.business.githubcopilot.com");

    status = { ...status, endpoint: { url: "https://api.enterprise.githubcopilot.com", source: "env", plan: null, opencodeDefault: "https://api.githubcopilot.com" } };
    assert.equal((await sync.sync()).state, "applique");
    assert.equal(currentCopilotBaseUrl(config), "https://api.enterprise.githubcopilot.com");
    sync.stop();
  });

  it("« en-attente » : nouvelle tentative automatique, sans nouvel appel", async () => {
    let config: Record<string, unknown> = {};
    let busy = true;
    const client = {
      request: async (method: string, _pathname: string, options?: { body?: unknown }) => {
        if (method === "GET") return structuredClone(config);
        if (method === "PATCH") config = { provider: (options?.body as { provider: unknown }).provider };
        return true;
      },
    } as unknown as OpencodeClient;
    const sync = new CopilotConfigSync({
      client,
      catalog: {
        sources: { opencodeError: null, copilotVerified: true, copilotError: null, endpoint: ep("https://api.business.githubcopilot.com"), unavailable: [] },
        refresh: async () => undefined,
      } as unknown as ModelCatalog,
      copilot: { status: { connected: true, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null } },
      hub: { cockpit: () => undefined },
      log: quiet,
      busy: async () => busy,
      retryMs: 10,
    });
    try {
      assert.equal((await sync.sync()).state, "en-attente");
      busy = false;
      for (let i = 0; i < 200 && sync.status.state !== "applique"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(sync.status.state, "applique");
      assert.equal(currentCopilotBaseUrl(config), "https://api.business.githubcopilot.com");
    } finally {
      sync.stop();
    }
  });
});

describe("certificats d'entreprise", () => {
  it("blocs CERTIFICATE valides seulement (jamais une clé), dossier absent sans effet", () => {
    const valid = tls.getCACertificates("bundled")[0] ?? "";
    const text = `${valid}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`;
    const blocks = certificateBlocks(text);
    assert.equal(blocks.valid.length, 1);
    assert.equal(blocks.rejected, 1);
    assert.deepEqual(trustCorporateCertificates(path.join(os.tmpdir(), "cockpit-certs-absent-xyz")), { files: 0, certificates: 0, rejected: 0, errors: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-certs-"));
    // Une entrée qui n'est pas un fichier, triée avant le vrai certificat, n'écarte pas les autres.
    fs.mkdirSync(path.join(dir, "a-dossier.pem"));
    fs.writeFileSync(path.join(dir, "entreprise.pem"), text);
    fs.writeFileSync(path.join(dir, "notes.txt"), valid);
    const result = trustCorporateCertificates(dir);
    assert.equal(result.files, 1);
    assert.equal(result.certificates, 1);
    assert.equal(result.rejected, 1);
    assert.deepEqual(result.errors, ["a-dossier.pem : n'est pas un fichier"]);
  });
});
