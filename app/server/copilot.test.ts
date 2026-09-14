import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { describe, it } from "node:test";
import { ModelCatalog, UNAVAILABLE_REASONS } from "./catalog.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import { canBill, ConfigWriteQueue } from "./config-queue.ts";
import type { ControlService } from "./control.ts";
import { CopilotApi, type CopilotEndpoint, type CopilotModel, copilotModelsFromApi, type FetchLike } from "./copilot.ts";
import { type AppEnv, EnvError, loadEnv, parseCopilotApiUrl } from "./env.ts";
import { EventHub } from "./hub.ts";
import type { Logger } from "./log.ts";
import {
  CopilotConfigSync,
  copilotBaseUrlTarget,
  currentCopilotBaseUrl,
  OPENCODE_DEFAULT_COPILOT_URL,
  providerBaseUrl,
  resyncOnReconnect,
  SYNC_DUE_MAX_MS,
} from "./oc-copilot-config.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { configProviderIssues, normalizeCopilotApiUrl } from "./shared/assistant-rules.ts";
import { StudioApplyError, StudioService } from "./studio.ts";
import { certificateBlocks, trustCorporateCertificates } from "./tls-trust.ts";

const TOKEN = `gho_${"x".repeat(36)}`;
const COPILOT = ["github-copilot"];
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

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

describe("file d'écriture de la configuration d'opencode", () => {
  it("une tâche à la fois, dans l'ordre ; un échec ne bloque pas la suivante ; indicateur applying posé le temps de la tâche", async () => {
    const queue = new ConfigWriteQueue();
    const order: string[] = [];
    let finish!: () => void;
    const slow = queue.run(async () => {
      order.push("lente:début");
      await new Promise<void>((resolve) => (finish = resolve));
      order.push("lente:fin");
    });
    const failing = assert.rejects(
      queue.run(async () => {
        order.push("échec");
        throw new Error("refusé par opencode");
      }),
      /refusé par opencode/,
    );
    const last = queue.run(async () => {
      order.push("dernière");
      return 42;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ["lente:début"]);
    finish();
    await slow;
    await failing;
    assert.equal(await last, 42);
    assert.deepEqual(order, ["lente:début", "lente:fin", "échec", "dernière"]);

    let seen = false;
    assert.equal(queue.applying, false);
    await assert.rejects(
      queue.applyingWhile(async () => {
        seen = queue.applying;
        throw new Error("application en échec");
      }),
      /application en échec/,
    );
    assert.equal(seen, true);
    assert.equal(queue.applying, false);
  });

  it("demandes facturées en vol : comptées de l'admission à la réponse, retirées une seule fois même si la fin est signalée deux fois", () => {
    const queue = new ConfigWriteQueue();
    assert.equal(queue.billedInFlight, 0);
    const first = queue.beginBilled();
    const second = queue.beginBilled();
    assert.equal(queue.billedInFlight, 2);
    first();
    first();
    assert.equal(queue.billedInFlight, 1);
    second();
    assert.equal(queue.billedInFlight, 0);
    // Compteur indépendant de l'indicateur d'application.
    assert.equal(queue.applying, false);
  });
});

describe("adresse de l'API Copilot imposée à opencode", () => {
  const BIZ = "https://api.business.githubcopilot.com";
  const ENT = "https://api.enterprise.githubcopilot.com";
  const OFFICE = "https://api.githubcopilot.com";
  const APP = "/workspace/app";
  const ep = (url: string, source: CopilotEndpoint["source"] = "github"): CopilotEndpoint => ({ url, source, plan: null, opencodeDefault: OFFICE });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (condition: () => boolean, what: string) => {
    for (let i = 0; i < 400 && !condition(); i++) await sleep(5);
    assert.ok(condition(), what);
  };
  const patchBody = (baseURL: string) => ({ provider: { "github-copilot": { options: { baseURL } } } });
  const merge = (base: unknown, next: unknown): unknown => {
    if (!base || typeof base !== "object" || Array.isArray(base) || !next || typeof next !== "object" || Array.isArray(next)) return next;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(next)) out[key] = merge(out[key], value);
    return out;
  };
  const both = (baseURL: string) => [
    { directory: null, baseURL },
    { directory: APP, baseURL },
  ];

  /**
   * Faux opencode fidèle aux mesures sur 1.18.30 : texte du fichier de configuration globale et cache global DISTINCTS (le cache,
   * servi par GET /global/config, peut être périmé), état du fournisseur rangé par dossier et construit depuis le cache au premier
   * GET /config/providers. Un PATCH qui change le texte du fichier invalide le cache et libère les instances (en tâche de fond) ;
   * un PATCH identique n'invalide rien ; POST /global/dispose libère toutes les instances, reconstruites ensuite depuis le cache,
   * même périmé. model.api.url reste l'adresse générale quoi qu'il arrive.
   */
  const fakeOpencode = (initial: { baseURL?: string; cachedBaseURL?: string; instances?: Array<[string | null, string]> } = {}) => {
    const configWith = (baseURL: string | undefined) => merge({ enabled_providers: ["github-copilot"] }, baseURL === undefined ? {} : patchBody(baseURL));
    let file = JSON.stringify(configWith(initial.baseURL));
    let cache: unknown = initial.cachedBaseURL === undefined ? null : configWith(initial.cachedBaseURL);
    const globalConfig = () => (cache ??= JSON.parse(file));
    let patchCount = 0;
    const fake = {
      /** Adresse par dossier (null = instance par défaut), telle qu'opencode l'utilise. */
      instances: new Map<string | null, string>(initial.instances ?? []),
      /** Dossiers dont l'instance n'est jamais libérée (seul un redémarrage la vide). */
      stuck: new Set<string | null>(),
      requests: [] as string[],
      /** Adresses des PATCH acceptés, dans l'ordre. */
      patches: [] as string[],
      invalidations: 0,
      /** Refus du PATCH selon son rang (1 = premier PATCH reçu) ; null : accepté. */
      failPatch: (_rank: number): Error | null => null,
      failDispose: null as Error | null,
      failProviders: null as Error | null,
      /** Lectures GET /config/providers en échec, seulement après une libération demandée (réussie ou non). */
      failProvidersAfterDispose: null as Error | null,
      disposed: false,
      /** Appelé à chaque demande reçue (« MÉTHODE chemin [dossier] »), avant tout traitement. */
      onRequest: (_line: string): void => undefined,
      fileBaseUrl: () => currentCopilotBaseUrl(JSON.parse(file)),
      globalBaseUrl: () => currentCopilotBaseUrl(globalConfig()),
      client: null as unknown as OpencodeClient,
    };
    const release = () => {
      for (const directory of [...fake.instances.keys()]) if (!fake.stuck.has(directory)) fake.instances.delete(directory);
    };
    fake.client = {
      request: async (method: string, pathname: string, options: { body?: unknown; directory?: string } = {}) => {
        const directory = options.directory ?? null;
        const line = `${method} ${pathname}${directory === null ? "" : ` ${directory}`}`;
        fake.requests.push(line);
        fake.onRequest(line);
        if (method === "GET" && pathname === "/global/config") return structuredClone(globalConfig());
        if (method === "GET" && pathname === "/config/providers") {
          if (fake.failProviders) throw fake.failProviders;
          if (fake.disposed && fake.failProvidersAfterDispose) throw fake.failProvidersAfterDispose;
          if (!fake.instances.has(directory)) fake.instances.set(directory, currentCopilotBaseUrl(globalConfig()));
          const baseURL = fake.instances.get(directory) ?? "";
          return {
            providers: [
              { id: "autre", options: { baseURL: "https://autre.example" }, models: {} },
              {
                id: "github-copilot",
                name: "GitHub Copilot",
                options: baseURL ? { apiKey: "", baseURL } : { apiKey: "" },
                models: { "gpt-5.4-mini": { id: "gpt-5.4-mini", api: { url: OFFICE } } },
              },
            ],
            default: { "github-copilot": "gpt-5.4-mini" },
          };
        }
        if (method === "PATCH" && pathname === "/global/config") {
          const refused = fake.failPatch(++patchCount);
          if (refused) throw refused;
          fake.patches.push(currentCopilotBaseUrl(options.body));
          const next = JSON.stringify(merge(JSON.parse(file), options.body));
          if (next !== file) {
            file = next;
            cache = null;
            fake.invalidations++;
            release();
          }
          return structuredClone(globalConfig());
        }
        if (method === "POST" && pathname === "/global/dispose") {
          fake.disposed = true;
          if (fake.failDispose) throw fake.failDispose;
          release();
          return true;
        }
        throw new Error(`route non simulée : ${method} ${pathname}`);
      },
    } as unknown as OpencodeClient;
    return fake;
  };

  const setup = (
    fake: ReturnType<typeof fakeOpencode>,
    options: { endpoint?: CopilotEndpoint | null; retryMs?: number; log?: Logger; now?: () => number } = {},
  ) => {
    const h = {
      endpoint: options.endpoint === undefined ? ep(BIZ) : options.endpoint,
      /** Adresse de la dernière lecture de CopilotApi (comptée seulement si imposée par .env). */
      lastEndpoint: null as CopilotEndpoint | null,
      directories: [null, APP] as Array<string | null>,
      /** Liste des dossiers en erreur : exception levée hors des lectures d'opencode. */
      directoriesFail: null as Error | null,
      busy: async (): Promise<boolean> => false,
      busyCalls: 0,
      control: { restarting: false },
      queue: new ConfigWriteQueue(),
      refreshes: 0,
      events: [] as string[],
      sync: null as unknown as CopilotConfigSync,
    };
    h.sync = new CopilotConfigSync({
      client: fake.client,
      catalog: {
        get sources() {
          return { opencodeError: null, copilotVerified: h.endpoint !== null, copilotError: null, endpoint: h.endpoint, unavailable: [] };
        },
        refresh: async () => {
          h.refreshes++;
        },
      } as unknown as ModelCatalog,
      copilot: {
        get status() {
          return { connected: true, endpoint: h.lastEndpoint, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null };
        },
      },
      hub: {
        cockpit: (type: string) => {
          h.events.push(type);
        },
      },
      log: options.log ?? quiet,
      queue: h.queue,
      control: h.control,
      directories: async () => {
        if (h.directoriesFail) throw h.directoriesFail;
        return h.directories;
      },
      busy: () => {
        h.busyCalls++;
        return h.busy();
      },
      retryMs: options.retryMs ?? 60_000,
      now: options.now,
    });
    return h;
  };

  it("adresse attendue, cache global et adresse utilisée par dossier", () => {
    assert.equal(copilotBaseUrlTarget(null), undefined);
    assert.equal(copilotBaseUrlTarget(ep(BIZ)), BIZ);
    assert.equal(copilotBaseUrlTarget(ep(OFFICE, "defaut")), "");
    assert.equal(currentCopilotBaseUrl({ provider: { "github-copilot": { options: { baseURL: `${BIZ}/` } } } }), BIZ);
    assert.equal(currentCopilotBaseUrl({}), "");
    // options.baseURL seulement : model.api.url reste l'adresse générale même quand opencode utilise une autre adresse.
    const listed = {
      providers: [
        { id: "autre", options: { baseURL: "https://autre.example" } },
        { id: "github-copilot", options: { apiKey: "", baseURL: `${BIZ}/` }, models: { m: { api: { url: OFFICE } } } },
      ],
    };
    assert.equal(providerBaseUrl(listed), BIZ);
    assert.equal(providerBaseUrl({ providers: [{ id: "github-copilot", options: { apiKey: "" }, models: { m: { api: { url: BIZ } } } }] }), "");
    assert.equal(providerBaseUrl({ providers: [] }), "");
    assert.throws(() => providerBaseUrl({ name: "UnknownError" }), /illisible/);
  });

  it("valeurs intermédiaires officielles (adresse d'office vide ou explicite) : acceptées par le verrou d'adresse", () => {
    const configWith = (baseURL: string) => ({ enabled_providers: ["github-copilot"], ...patchBody(baseURL) });
    assert.equal(OPENCODE_DEFAULT_COPILOT_URL, OFFICE);
    assert.equal(normalizeCopilotApiUrl(OPENCODE_DEFAULT_COPILOT_URL), OFFICE);
    assert.deepEqual(configProviderIssues(configWith(OPENCODE_DEFAULT_COPILOT_URL), ["github-copilot"]), []);
    assert.deepEqual(configProviderIssues(configWith(""), ["github-copilot"]), []);
  });

  it("dossiers déjà à la cible : « a-jour », rien n'est écrit ni libéré, aucune sonde des conversations", async () => {
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake);
    const status = await h.sync.sync();
    assert.equal(status.state, "a-jour");
    assert.deepEqual(status.details, {
      checked: [
        { directory: null, baseURL: BIZ },
        { directory: APP, baseURL: BIZ },
      ],
    });
    assert.deepEqual(fake.requests, ["GET /config/providers", `GET /config/providers ${APP}`]);
    assert.equal(h.busyCalls, 0);
    assert.deepEqual(h.events, []);
  });

  it("adresse appliquée : valeur intermédiaire puis cible, libération attendue, adresse relue dans chaque dossier ; demandes facturées bloquées de la sonde à la dernière relecture", async () => {
    const fake = fakeOpencode();
    const h = setup(fake);
    const seen: Array<[string, boolean]> = [];
    fake.onRequest = (line) => {
      seen.push([line, h.queue.applying]);
    };
    h.busy = async () => {
      seen.push(["sonde des conversations", h.queue.applying]);
      return false;
    };
    const status = await h.sync.sync();
    assert.equal(status.state, "applique", status.message ?? "");
    assert.equal(status.message, null);
    // Indicateur posé avant la sonde et gardé pendant la libération ET les relectures finales ; le cache global n'est jamais lu.
    assert.deepEqual(seen, [
      ["GET /config/providers", false],
      [`GET /config/providers ${APP}`, false],
      ["sonde des conversations", true],
      ["PATCH /global/config", true],
      ["PATCH /global/config", true],
      ["POST /global/dispose", true],
      ["GET /config/providers", true],
      [`GET /config/providers ${APP}`, true],
    ]);
    assert.deepEqual(fake.patches, ["", BIZ]);
    assert.equal(fake.invalidations, 2);
    assert.deepEqual(status.details.checked, [
      { directory: null, baseURL: BIZ },
      { directory: APP, baseURL: BIZ },
    ]);
    assert.equal(typeof status.details.disposeMs, "number");
    assert.equal(status.details.disposeOk, true);
    assert.equal(status.details.restartHelps, undefined);
    assert.equal(h.queue.applying, false);
    assert.deepEqual(h.events, ["opencode.config.changed"]);
    assert.equal(h.refreshes, 1);

    assert.equal((await h.sync.sync()).state, "a-jour");
    assert.deepEqual(fake.patches, ["", BIZ]);
  });

  it("cache global déjà à la cible mais dossier en retard : PATCH intermédiaire puis PATCH cible (un PATCH identique n'invalide rien)", async () => {
    // Fidélité du faux opencode : un PATCH qui ne change pas le texte n'invalide rien et ne libère aucune instance.
    const probe = fakeOpencode({ baseURL: BIZ, instances: [[APP, ""]] });
    await probe.client.request("PATCH", "/global/config", { body: patchBody(BIZ) });
    assert.equal(probe.invalidations, 0);
    assert.equal(probe.instances.get(APP), "");

    const fake = fakeOpencode({ baseURL: BIZ, instances: [[APP, ""]] });
    const h = setup(fake);
    const status = await h.sync.sync();
    assert.equal(status.state, "applique", status.message ?? "");
    assert.deepEqual(fake.patches, ["", BIZ]);
    assert.equal(fake.invalidations, 2);
    assert.deepEqual(status.details.checked, [
      { directory: null, baseURL: BIZ },
      { directory: APP, baseURL: BIZ },
    ]);

    // Même situation vers l'adresse d'office : valeur intermédiaire = adresse d'office explicite.
    const back = fakeOpencode({ baseURL: "", instances: [[APP, BIZ]] });
    const office = setup(back, { endpoint: ep(OFFICE, "defaut") });
    assert.equal((await office.sync.sync()).state, "applique");
    assert.deepEqual(back.patches, [OFFICE, ""]);
    assert.equal(back.instances.get(APP), "");
  });

  it("fichier déjà à la cible mais cache global périmé (S7/S8) : la double écriture répare sans redémarrage, là où un PATCH identique ne répare rien", async () => {
    // Fidélité du faux opencode (mesure S8) : PATCH identique puis libération, les dossiers sont reconstruits sur le cache périmé.
    const probe = fakeOpencode({ baseURL: BIZ, cachedBaseURL: "" });
    assert.equal(probe.fileBaseUrl(), BIZ);
    assert.equal(probe.globalBaseUrl(), "");
    assert.equal(providerBaseUrl(await probe.client.request<unknown>("GET", "/config/providers", { directory: APP })), "");
    await probe.client.request("PATCH", "/global/config", { body: patchBody(BIZ) });
    await probe.client.request("POST", "/global/dispose");
    assert.equal(probe.invalidations, 0);
    assert.equal(providerBaseUrl(await probe.client.request<unknown>("GET", "/config/providers", { directory: APP })), "");

    const fake = fakeOpencode({ baseURL: BIZ, cachedBaseURL: "" });
    const h = setup(fake);
    const status = await h.sync.sync();
    assert.equal(status.state, "applique", status.message ?? "");
    assert.deepEqual(fake.patches, ["", BIZ]);
    assert.equal(fake.invalidations, 2);
    assert.equal(fake.fileBaseUrl(), BIZ);
    assert.equal(fake.globalBaseUrl(), BIZ);
    assert.deepEqual(status.details.checked, both(BIZ));
  });

  it("retour à l'adresse d'office : adresse d'office explicite puis adresse vidée, vérifiée dans chaque dossier", async () => {
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake, { endpoint: ep(OFFICE, "defaut") });
    const status = await h.sync.sync();
    assert.equal(status.state, "applique", status.message ?? "");
    assert.deepEqual(fake.patches, [OFFICE, ""]);
    assert.equal(fake.globalBaseUrl(), "");
    assert.deepEqual(status.details.checked, [
      { directory: null, baseURL: "" },
      { directory: APP, baseURL: "" },
    ]);
  });

  it("PATCH refusé par opencode : « echec » avec son message, rien d'écrit ni libéré, aucun redémarrage proposé, jamais de nouvelle tentative", async () => {
    const fake = fakeOpencode();
    fake.failPatch = (rank) => (rank === 1 ? new Error("opencode 400 ConfigInvalidError") : null);
    const h = setup(fake, { retryMs: 5 });
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "echec");
      assert.match(status.message ?? "", /ConfigInvalidError/);
      assert.deepEqual(fake.patches, []);
      assert.equal(fake.requests.includes("POST /global/dispose"), false);
      // Rien d'écrit : les adresses relues juste avant restent celles qu'opencode utilise.
      assert.deepEqual(status.details.checked, both(""));
      assert.equal(status.details.disposeOk, undefined);
      assert.equal(status.details.restartHelps, undefined);
      assert.deepEqual(h.events, []);
      assert.equal(h.refreshes, 0);
      const count = fake.requests.length;
      await sleep(40);
      assert.equal(fake.requests.length, count);
      assert.equal(h.sync.status.state, "echec");
    } finally {
      h.sync.stop();
    }
  });

  it("PATCH intermédiaire écrit puis PATCH cible en échec une fois : PATCH cible retenté aussitôt, adresse appliquée", async () => {
    const fake = fakeOpencode();
    fake.failPatch = (rank) => (rank === 2 ? new Error("opencode 503 indisponible") : null);
    const h = setup(fake);
    const status = await h.sync.sync();
    assert.equal(status.state, "applique", status.message ?? "");
    assert.equal(fake.requests.filter((r) => r === "PATCH /global/config").length, 3);
    assert.deepEqual(fake.patches, ["", BIZ]);
    assert.equal(fake.globalBaseUrl(), BIZ);
    assert.deepEqual(status.details.checked, both(BIZ));
    assert.equal(status.details.disposeOk, true);
  });

  it("PATCH cible en échec deux fois après l'intermédiaire : « en-attente » qui dit l'adresse d'office restée écrite, sans adresses périmées, puis nouvelles tentatives jusqu'à l'application", async () => {
    const fake = fakeOpencode({ baseURL: BIZ, instances: [[APP, ""]] });
    fake.failPatch = (rank) => (rank === 2 || rank === 3 ? new Error("fetch failed") : null);
    const h = setup(fake, { retryMs: 5 });
    try {
      const first = await h.sync.sync();
      assert.equal(first.state, "en-attente");
      assert.equal(
        first.message,
        "Adresse intermédiaire (adresse d'office) restée écrite, adresse visée non écrite : nouvelle tentative à la prochaine vérification (fetch failed).",
      );
      assert.deepEqual(first.details.checked, []);
      assert.equal(first.details.disposeOk, undefined);
      assert.equal(fake.fileBaseUrl(), "");
      assert.equal(fake.requests.includes("POST /global/dispose"), false);
      assert.deepEqual(h.events, ["opencode.config.changed"]);
      assert.equal(h.refreshes, 1);
      await waitFor(() => h.sync.status.state === "applique", "adresse appliquée à une tentative suivante");
      assert.deepEqual(fake.patches, ["", "", BIZ]);
      assert.equal(fake.globalBaseUrl(), BIZ);
      assert.deepEqual(h.sync.status.details.checked, both(BIZ));
    } finally {
      h.sync.stop();
    }
  });

  it("libération des instances en échec mais adresse relue partout : « applique » qui signale la libération ratée (disposeOk faux), jamais de nouvelle tentative", async () => {
    const fake = fakeOpencode();
    fake.failDispose = new Error("The operation was aborted due to timeout");
    const h = setup(fake, { retryMs: 5 });
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "applique", status.message ?? "");
      assert.equal(status.message, "Adresse utilisée dans chaque dossier, bien que la libération des instances ait échoué : The operation was aborted due to timeout");
      assert.equal(status.details.disposeOk, false);
      assert.equal(typeof status.details.disposeMs, "number");
      assert.equal(status.details.restartHelps, undefined);
      // Relues après la dernière écriture : les PATCH qui changent le texte ont déjà libéré les instances.
      assert.deepEqual(status.details.checked, both(BIZ));
      assert.deepEqual(fake.requests.slice(-3), ["POST /global/dispose", "GET /config/providers", `GET /config/providers ${APP}`]);
      assert.deepEqual(h.events, ["opencode.config.changed"]);
      const count = fake.requests.length;
      await sleep(40);
      assert.equal(fake.requests.length, count);
      assert.equal(h.sync.status.state, "applique");
    } finally {
      h.sync.stop();
    }
  });

  it("libération en échec et dossier resté sur l'ancienne adresse : « redemarrage-requis » qui nomme le dossier et la libération ratée", async () => {
    const fake = fakeOpencode({ instances: [[APP, ""]] });
    fake.stuck.add(APP);
    fake.failDispose = new Error("opencode 500 UnknownError");
    const h = setup(fake, { retryMs: 5 });
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "redemarrage-requis");
      assert.equal(
        status.message,
        `Adresse écrite, mais opencode ne l'utilise pas encore dans ${APP} (libération des instances en échec : opencode 500 UnknownError) : redémarrez opencode (page Diagnostic).`,
      );
      assert.deepEqual(status.details.checked, [
        { directory: null, baseURL: BIZ },
        { directory: APP, baseURL: "" },
      ]);
      assert.equal(status.details.disposeOk, false);
      const count = fake.requests.length;
      await sleep(40);
      assert.equal(fake.requests.length, count);
    } finally {
      h.sync.stop();
    }
  });

  it("libération en échec puis relecture impossible : « echec » sans adresses, redémarrage d'opencode proposé, jamais de nouvelle tentative", async () => {
    const fake = fakeOpencode();
    fake.failDispose = new Error("The operation was aborted due to timeout");
    fake.failProvidersAfterDispose = new Error("fetch failed");
    const h = setup(fake, { retryMs: 5 });
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "echec");
      assert.equal(
        status.message,
        "Adresse écrite, mais opencode n'a pas libéré ses instances (The operation was aborted due to timeout) et l'adresse utilisée n'a pas pu être relue : opencode injoignable : fetch failed",
      );
      assert.deepEqual(status.details.checked, []);
      assert.equal(typeof status.details.disposeMs, "number");
      assert.equal(status.details.disposeOk, false);
      assert.equal(status.details.restartHelps, true);
      assert.deepEqual(h.events, ["opencode.config.changed"]);
      const count = fake.requests.length;
      await sleep(40);
      assert.equal(fake.requests.length, count);
      assert.equal(h.sync.status.state, "echec");
    } finally {
      h.sync.stop();
    }
  });

  it("relectures postérieures à la libération en échec (seules) : « en-attente » sans adresses périmées, puis vérifiée à la tentative suivante", async () => {
    const fake = fakeOpencode();
    fake.failProvidersAfterDispose = new Error("fetch failed");
    const h = setup(fake, { retryMs: 5 });
    try {
      const first = await h.sync.sync();
      assert.equal(first.state, "en-attente");
      assert.equal(first.message, "Adresse écrite, vérification impossible : opencode injoignable : fetch failed");
      assert.deepEqual(first.details.checked, []);
      assert.equal(first.details.disposeOk, true);
      assert.equal(first.details.restartHelps, undefined);
      // Lectures d'avant l'écriture réussies : seules les relectures ont échoué.
      assert.deepEqual(fake.requests.slice(0, 2), ["GET /config/providers", `GET /config/providers ${APP}`]);
      assert.deepEqual(fake.patches, ["", BIZ]);
      fake.failProvidersAfterDispose = null;
      await waitFor(() => h.sync.status.state === "a-jour", "adresse vérifiée à la tentative suivante");
      assert.deepEqual(h.sync.status.details.checked, both(BIZ));
      assert.deepEqual(fake.patches, ["", BIZ]);
    } finally {
      h.sync.stop();
    }
  });

  it("adresse écrite mais pas utilisée dans un dossier : « redemarrage-requis » qui nomme le dossier, jamais « applique », aucune nouvelle tentative", async () => {
    const fake = fakeOpencode({ instances: [[APP, ""]] });
    fake.stuck.add(APP);
    const h = setup(fake, { retryMs: 5 });
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "redemarrage-requis");
      assert.equal(status.message, `Adresse écrite, mais opencode ne l'utilise pas encore dans ${APP} : redémarrez opencode (page Diagnostic).`);
      assert.deepEqual(status.details.checked, [
        { directory: null, baseURL: BIZ },
        { directory: APP, baseURL: "" },
      ]);
      assert.equal(status.details.disposeOk, true);
      assert.equal(status.details.restartHelps, undefined);
      assert.equal(fake.globalBaseUrl(), BIZ);
      const count = fake.requests.length;
      await sleep(40);
      assert.equal(fake.requests.length, count);
      assert.equal(h.sync.status.state, "redemarrage-requis");
    } finally {
      h.sync.stop();
    }
  });

  it("conversation en cours : « en-attente », nouvelles tentatives répétées sans rien écrire, puis application au repos", async () => {
    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 5 });
    const patchesWhileBusy: number[] = [];
    h.busy = async () => {
      if (h.busyCalls > 3) return false;
      patchesWhileBusy.push(fake.patches.length);
      return true;
    };
    try {
      const first = await h.sync.sync();
      assert.equal(first.state, "en-attente");
      assert.equal(first.message, "Une conversation travaille : adresse appliquée à la prochaine vérification.");
      await waitFor(() => h.sync.status.state === "applique", "adresse appliquée au repos");
      assert.equal(h.busyCalls, 4);
      assert.deepEqual(patchesWhileBusy, [0, 0, 0]);
      assert.deepEqual(fake.patches, ["", BIZ]);
    } finally {
      h.sync.stop();
    }
  });

  it("demande facturée admise juste avant l'indicateur (en vol) : « occupée » sans sonde ni écriture, puis appliquée une fois la réponse reçue", async () => {
    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 5 });
    const endBilled = h.queue.beginBilled();
    try {
      const first = await h.sync.sync();
      assert.equal(first.state, "en-attente");
      assert.equal(first.message, "Une conversation travaille : adresse appliquée à la prochaine vérification.");
      assert.equal(h.busyCalls, 0);
      await sleep(30);
      assert.equal(h.busyCalls, 0);
      assert.deepEqual(fake.patches, []);
      assert.equal(fake.requests.includes("POST /global/dispose"), false);
      endBilled();
      await waitFor(() => h.sync.status.state === "applique", "adresse appliquée après la réponse");
      assert.deepEqual(fake.patches, ["", BIZ]);
    } finally {
      endBilled();
      h.sync.stop();
    }
  });

  it("sonde des conversations ou lecture des dossiers en erreur : « en-attente » opencode injoignable, jamais « occupé »", async () => {
    const fake = fakeOpencode();
    const h = setup(fake);
    h.busy = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.2:4096");
    };
    try {
      const probe = await h.sync.sync();
      assert.equal(probe.state, "en-attente");
      assert.match(probe.message ?? "", /^opencode injoignable : .*ECONNREFUSED/);
      assert.doesNotMatch(probe.message ?? "", /conversation/);
      assert.deepEqual(fake.patches, []);

      fake.failProviders = new Error("fetch failed");
      const read = await h.sync.sync();
      assert.equal(read.state, "en-attente");
      assert.match(read.message ?? "", /^opencode injoignable : fetch failed/);
      assert.deepEqual(read.details.checked, []);
      assert.deepEqual(fake.patches, []);
    } finally {
      h.sync.stop();
    }
  });

  it("redémarrage d'opencode en cours : « en-attente », rien n'est lu ni écrit, adresse appliquée à une tentative suivante", async () => {
    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 5 });
    h.control.restarting = true;
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "en-attente");
      assert.match(status.message ?? "", /redémarre/);
      assert.deepEqual(fake.requests, []);
      assert.equal(h.busyCalls, 0);
      h.control.restarting = false;
      await waitFor(() => h.sync.status.state === "applique", "adresse appliquée après le redémarrage");
      assert.deepEqual(fake.patches, ["", BIZ]);
    } finally {
      h.sync.stop();
    }
  });

  it("redémarrage lancé pendant la sonde des conversations : « en-attente » sans PATCH ni libération, applying levé, adresse appliquée à une tentative suivante", async () => {
    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 5 });
    h.busy = async () => {
      // Redémarrage demandé pendant la sonde (délai de 10 s) : seul le contrôle d'après la sonde évite PATCH et libération.
      if (h.busyCalls === 1) h.control.restarting = true;
      return false;
    };
    try {
      const status = await h.sync.sync();
      assert.equal(status.state, "en-attente");
      assert.match(status.message ?? "", /redémarre/);
      assert.equal(h.busyCalls, 1);
      assert.deepEqual(fake.patches, []);
      assert.equal(fake.requests.includes("POST /global/dispose"), false);
      assert.equal(h.queue.applying, false);
      h.control.restarting = false;
      await waitFor(() => h.sync.status.state === "applique", "adresse appliquée après le redémarrage");
      assert.deepEqual(fake.patches, ["", BIZ]);
    } finally {
      h.sync.stop();
    }
  });

  it("sync() pendant une synchro : seconde synchro lancée à la fin avec la cible relue, partagée par les appels suivants", async () => {
    const fake = fakeOpencode();
    const h = setup(fake);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    h.busy = async () => {
      await gate;
      return false;
    };
    const first = h.sync.sync();
    await waitFor(() => h.busyCalls === 1, "première synchro dans la sonde des conversations");
    h.endpoint = ep(ENT);
    const second = h.sync.sync();
    assert.equal(h.sync.sync(), second);
    assert.notEqual(second, first);
    open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.state, "applique");
    assert.equal(b.state, "applique");
    assert.deepEqual(fake.patches, ["", BIZ, "", ENT]);
    assert.deepEqual(b.details.checked, [
      { directory: null, baseURL: ENT },
      { directory: APP, baseURL: ENT },
    ]);
    assert.equal(h.sync.status, b);
    // Synchro terminée : un nouvel appel lance une synchro neuve.
    assert.equal((await h.sync.sync()).state, "a-jour");
  });

  it("stop() annule les nouvelles tentatives", async () => {
    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 5 });
    h.busy = async () => true;
    assert.equal((await h.sync.sync()).state, "en-attente");
    h.sync.stop();
    await sleep(40);
    assert.equal(h.busyCalls, 1);
    assert.deepEqual(fake.patches, []);
  });

  it("file d'écriture partagée : la synchro attend l'application de configuration en cours", async () => {
    const fake = fakeOpencode();
    const h = setup(fake);
    let finish!: () => void;
    const holding = h.queue.run(() => new Promise<void>((resolve) => (finish = resolve)));
    const pending = h.sync.sync();
    await sleep(20);
    assert.deepEqual(fake.requests, []);
    finish();
    await holding;
    assert.equal((await pending).state, "applique");
  });

  it("lecture de la liste en échec : rien n'est écrit dans opencode, sauf l'adresse imposée par .env", async () => {
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake, { endpoint: null });
    // Dernière adresse retenue par une lecture en échec : jamais écrite.
    h.lastEndpoint = ep(ENT);
    assert.equal((await h.sync.sync()).state, "inactif");
    assert.deepEqual(fake.requests, []);
    assert.equal(fake.globalBaseUrl(), BIZ);

    h.lastEndpoint = ep(ENT, "env");
    assert.equal((await h.sync.sync()).state, "applique");
    assert.equal(fake.globalBaseUrl(), ENT);
  });

  it("journal : info à chaque réécriture d'opencode, même quand l'état ne change pas ; debug seulement sans écriture ni changement", async () => {
    const lines: Array<[string, string]> = [];
    const log: Logger = {
      debug: (message) => void lines.push(["debug", message]),
      info: (message) => void lines.push(["info", message]),
      warn: (message) => void lines.push(["warn", message]),
      error: (message) => void lines.push(["error", message]),
    };
    const fake = fakeOpencode();
    const h = setup(fake, { log });
    assert.equal((await h.sync.sync()).state, "applique");
    // Dossier revenu sur l'adresse d'office : réécrit et libéré, état « applique » inchangé.
    fake.instances.set(APP, "");
    assert.equal((await h.sync.sync()).state, "applique");
    assert.deepEqual(fake.patches, ["", BIZ, "", BIZ]);
    assert.equal((await h.sync.sync()).state, "a-jour");
    assert.equal((await h.sync.sync()).state, "a-jour");
    assert.deepEqual(lines, [
      ["info", "adresse de l'API Copilot d'opencode : nouvel état"],
      ["info", "adresse de l'API Copilot d'opencode : réécrite, état inchangé"],
      ["info", "adresse de l'API Copilot d'opencode : nouvel état"],
      ["debug", "adresse de l'API Copilot d'opencode : état inchangé"],
    ]);
  });

  it("reconnexion du flux d'événements d'opencode (tout redémarrage) : synchro relancée à chaque reconnexion, jamais au premier branchement ; reconnexions rapprochées fondues", async () => {
    const hub = new EventHub();
    const connection = (connected: boolean) => hub.cockpit("opencode.connection", { connected, error: connected ? null : "flux terminé par opencode" });
    let calls = 0;
    const off = resyncOnReconnect(hub, {
      sync: async () => {
        calls++;
        return { state: "a-jour", message: null, at: 0, details: { checked: [] } };
      },
      markDue: () => true,
    });
    connection(true);
    assert.equal(calls, 0);
    hub.cockpit("opencode.config.changed", { connected: true });
    connection(false);
    assert.equal(calls, 0);
    connection(true);
    assert.equal(calls, 1);
    // Même état publié sans coupure : rien ; coupure puis reconnexion suivante : nouvelle synchro.
    connection(true);
    assert.equal(calls, 1);
    connection(false);
    connection(true);
    assert.equal(calls, 2);
    off();
    connection(false);
    connection(true);
    assert.equal(calls, 2);

    // Reconnexions répétées pendant une synchro réelle : une seule synchro relancée à sa fin, aucune boucle.
    const fake = fakeOpencode();
    const h = setup(fake);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    h.busy = async () => {
      await gate;
      return false;
    };
    const stop = resyncOnReconnect(hub, h.sync);
    try {
      connection(false);
      connection(true);
      await waitFor(() => h.busyCalls === 1, "synchro lancée par la reconnexion");
      for (let i = 0; i < 3; i++) {
        connection(false);
        connection(true);
      }
      open();
      await waitFor(() => h.sync.status.state === "a-jour", "synchro relancée à la fin de la première");
      await sleep(30);
      assert.equal(h.busyCalls, 1);
      assert.deepEqual(fake.patches, ["", BIZ]);
      assert.equal(fake.requests.filter((r) => r.startsWith("GET /config/providers")).length, 6);
    } finally {
      stop();
      h.sync.stop();
    }
  });

  const DUE_MESSAGE = "opencode redémarre ou recharge sa configuration : l'adresse sera revérifiée.";
  const billable = (h: ReturnType<typeof setup>) => canBill({ queue: h.queue, control: h.control, copilotConfig: h.sync });

  it("« synchro due » : posée seulement avec une adresse cible ; Diagnostic « en-attente » et demandes facturées refusées tant qu'elle est posée ; levée par la synchro relancée", async () => {
    // Sans adresse cible (synchro « inactif ») : jamais posée.
    const inactive = setup(fakeOpencode(), { endpoint: null });
    assert.equal(inactive.sync.markDue("fichier brut"), false);
    assert.equal(inactive.sync.syncDue, false);
    assert.equal(inactive.sync.status.state, "inactif");
    assert.equal(billable(inactive), true);

    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake);
    const current = await h.sync.sync();
    assert.equal(current.state, "a-jour");
    assert.equal(billable(h), true);
    assert.equal(h.sync.markDue("fichier de configuration brut"), true);
    assert.equal(h.sync.syncDue, true);
    assert.equal(billable(h), false);
    // Jamais l'« a-jour » d'avant l'écriture : adresses relues avant retirées.
    const shown = h.sync.status;
    assert.equal(shown.state, "en-attente");
    assert.equal(shown.message, DUE_MESSAGE);
    assert.deepEqual(shown.details, { checked: [] });
    // Garde commune : applying et redémarrage comptent toujours, indépendamment de l'indicateur.
    const endApplying = h.queue.applyingWhile(async () => assert.equal(canBill({ queue: h.queue, control: h.control, copilotConfig: inactive.sync }), false));
    await endApplying;
    h.control.restarting = true;
    assert.equal(canBill({ queue: h.queue, control: h.control, copilotConfig: inactive.sync }), false);
    h.control.restarting = false;

    const status = await h.sync.sync();
    assert.equal(status.state, "a-jour");
    assert.equal(h.sync.syncDue, false);
    assert.equal(billable(h), true);
    assert.equal(h.sync.status, status);
    // Aucune lecture ni écriture de plus que la synchro elle-même : l'indicateur ne relance rien.
    assert.deepEqual(fake.patches, []);
  });

  it("« synchro due » levée à la fin de la synchro relancée quel que soit l'état final, exception comprise ; posée pendant une synchro : laissée à la suivante", async () => {
    type Harness = ReturnType<typeof setup>;
    type Fake = ReturnType<typeof fakeOpencode>;
    const cases: Array<{ state: string; label: string; fake: () => Fake; prepare?: (h: Harness, fake: Fake) => void }> = [
      { state: "a-jour", label: "dossiers à la cible", fake: () => fakeOpencode({ baseURL: BIZ }) },
      { state: "applique", label: "adresse appliquée", fake: () => fakeOpencode() },
      { state: "en-attente", label: "conversation en cours", fake: () => fakeOpencode(), prepare: (h) => (h.busy = async () => true) },
      { state: "en-attente", label: "opencode injoignable", fake: () => fakeOpencode(), prepare: (_h, fake) => (fake.failProviders = new Error("fetch failed")) },
      { state: "en-attente", label: "redémarrage en cours", fake: () => fakeOpencode(), prepare: (h) => (h.control.restarting = true) },
      {
        state: "echec",
        label: "PATCH refusé",
        fake: () => fakeOpencode(),
        prepare: (_h, fake) => (fake.failPatch = (rank) => (rank === 1 ? new Error("opencode 400 ConfigInvalidError") : null)),
      },
      {
        state: "redemarrage-requis",
        label: "dossier bloqué",
        fake: () => {
          const stuck = fakeOpencode({ instances: [[APP, ""]] });
          stuck.stuck.add(APP);
          return stuck;
        },
      },
      { state: "inactif", label: "adresse cible perdue", fake: () => fakeOpencode(), prepare: (h) => (h.endpoint = null) },
      { state: "echec", label: "exception", fake: () => fakeOpencode(), prepare: (h) => (h.directoriesFail = new Error("base des sessions illisible")) },
    ];
    for (const c of cases) {
      const fake = c.fake();
      const h = setup(fake);
      try {
        assert.equal(h.sync.markDue("profil Prudent"), true, c.label);
        c.prepare?.(h, fake);
        const status = await h.sync.sync();
        assert.equal(status.state, c.state, c.label);
        if (c.label === "exception") assert.equal(status.message, "base des sessions illisible");
        assert.equal(h.sync.syncDue, false, c.label);
        assert.equal(canBill({ queue: h.queue, control: { restarting: false }, copilotConfig: h.sync }), true, c.label);
        assert.equal(h.sync.status, status, c.label);
      } finally {
        h.sync.stop();
      }
    }

    // Posée pendant qu'une synchro tourne (ses relectures sont peut-être antérieures) : pas levée par elle, levée par la suivante.
    const fake = fakeOpencode();
    const h = setup(fake);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    h.busy = async () => {
      await gate;
      return false;
    };
    const first = h.sync.sync();
    await waitFor(() => h.busyCalls === 1, "synchro dans la sonde des conversations");
    assert.equal(h.sync.markDue("correctif de configuration (mode Avancé)"), true);
    open();
    assert.equal((await first).state, "applique");
    assert.equal(h.sync.syncDue, true, "posée pendant la synchro : pas levée par elle");
    assert.equal(h.sync.status.state, "en-attente");
    assert.equal((await h.sync.sync()).state, "a-jour");
    assert.equal(h.sync.syncDue, false);

    // Posée avant la synchro puis reposée pendant (nouvelle écriture) : elle ne lève que la pose qu'elle couvre.
    const again = fakeOpencode();
    const g = setup(again);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    g.busy = async () => {
      await held;
      return false;
    };
    assert.equal(g.sync.markDue("fichier de configuration brut"), true);
    const running = g.sync.sync();
    await waitFor(() => g.busyCalls === 1, "synchro couvrant la première pose, dans la sonde");
    assert.equal(g.sync.markDue("permissions globales"), true);
    release();
    assert.equal((await running).state, "applique");
    assert.equal(g.sync.syncDue, true, "reposée pendant la synchro : pas levée par elle");
    assert.equal((await g.sync.sync()).state, "a-jour");
    assert.equal(g.sync.syncDue, false);
  });

  it("coupure du flux d'opencode : « synchro due » posée dès la coupure (jamais sans adresse cible), gardée par les synchros d'ici là, levée par la synchro de reconnexion", async () => {
    const hub = new EventHub();
    const connection = (connected: boolean) => hub.cockpit("opencode.connection", { connected, error: connected ? null : "flux terminé par opencode" });
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake);
    const stop = resyncOnReconnect(hub, h.sync);
    try {
      connection(true);
      assert.equal(h.sync.syncDue, false);
      connection(false);
      assert.equal(h.sync.syncDue, true);
      assert.equal(billable(h), false);
      assert.equal(h.sync.status.state, "en-attente");
      assert.equal(h.sync.status.message, DUE_MESSAGE);
      // Synchro partie pendant la coupure (nouvelle tentative, « Tester la connexion ») : opencode peut encore redémarrer.
      assert.equal((await h.sync.sync()).state, "a-jour");
      assert.equal(h.sync.syncDue, true);
      // Écriture faite pendant la coupure : l'attente de la reconnexion est gardée.
      assert.equal(h.sync.markDue("correctif de configuration (mode Avancé)"), true);
      assert.equal((await h.sync.sync()).state, "a-jour");
      assert.equal(h.sync.syncDue, true);
      const reads = fake.requests.length;
      connection(true);
      assert.equal(h.sync.syncDue, true, "posée jusqu'à la fin de la synchro de reconnexion");
      await waitFor(() => !h.sync.syncDue, "levée par la synchro de reconnexion");
      assert.equal(fake.requests.length, reads + 2);
      assert.equal(h.sync.status.state, "a-jour");
      assert.equal(billable(h), true);

      // Sans adresse cible (synchro « inactif ») : ni à la coupure, ni à la reconnexion.
      h.endpoint = null;
      connection(false);
      assert.equal(h.sync.syncDue, false);
      assert.equal(billable(h), true);
      connection(true);
      assert.equal(h.sync.syncDue, false);
      await waitFor(() => h.sync.status.state === "inactif", "synchro de reconnexion sans adresse cible");
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("soupape : « synchro due » levée de force après 90 s (log.warn) sans relancer ni reposer quoi que ce soit, quand la reconnexion n'arrive jamais", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const hub = new EventHub();
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake, { retryMs: 5, log, now: () => clock });
    const stop = resyncOnReconnect(hub, h.sync);
    try {
      hub.cockpit("opencode.connection", { connected: true, error: null });
      hub.cockpit("opencode.connection", { connected: false, error: "fetch failed" });
      // opencode injoignable : nouvelles tentatives, aucune ne lève l'indicateur (reconnexion attendue).
      fake.failProviders = new Error("fetch failed");
      assert.equal((await h.sync.sync()).state, "en-attente");
      await waitFor(() => fake.requests.length >= 8, "nouvelles tentatives pendant la coupure");
      assert.equal(h.sync.syncDue, true);
      // opencode de retour, flux jamais rebranché : tentatives arrêtées (« a-jour »), indicateur toujours posé.
      fake.failProviders = null;
      assert.equal((await h.sync.sync()).state, "a-jour");
      assert.equal(h.sync.syncDue, true);
      const count = fake.requests.length;
      await sleep(30);
      assert.equal(fake.requests.length, count, "aucune tentative en cours");

      clock += SYNC_DUE_MAX_MS - 1;
      assert.equal(h.sync.syncDue, true);
      assert.equal(warns.length, 0);
      clock += 1;
      assert.equal(h.sync.syncDue, false);
      assert.equal(billable(h), true);
      assert.equal(h.sync.status.state, "a-jour");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", /revérification attendue trop longtemps/);
      assert.deepEqual(warns[0]?.[1], { cause: "flux d'événements d'opencode coupé", waitedMs: SYNC_DUE_MAX_MS });
      // Levée sans effet de bord : aucune synchro, aucune nouvelle pose, aucun autre journal.
      await sleep(30);
      assert.equal(fake.requests.length, count);
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 1);

      // Écriture : délai compté depuis la dernière pose.
      assert.equal(h.sync.markDue("fichier de configuration brut"), true);
      clock += SYNC_DUE_MAX_MS - 10;
      assert.equal(h.sync.markDue("permissions globales"), true);
      clock += 20;
      assert.equal(h.sync.syncDue, true);
      clock += SYNC_DUE_MAX_MS;
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 2);
      assert.equal(warns[1]?.[1]?.cause, "permissions globales");
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("Studio : libérations et redémarrages dans la file partagée (applying posé), « synchro due » posée avant la libération d'applying puis synchro relancée ; aucun blocage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-studio-file-"));
    // Cache global périmé (S7/S8) : une libération du Studio reconstruit les dossiers sur l'adresse d'office.
    const fake = fakeOpencode({ baseURL: BIZ, cachedBaseURL: "", instances: [[null, BIZ], [APP, BIZ]] });
    const h = setup(fake);
    const seen: Array<[string, boolean]> = [];
    fake.onRequest = (line) => void seen.push([line, h.queue.applying]);
    let agentRefused = false;
    const client = {
      request: async (method: string, pathname: string, options: { body?: unknown; directory?: string } = {}) => {
        if (method === "GET" && pathname === "/agent") {
          if (agentRefused) throw new OpencodeError(400, { name: "ConfigInvalidError", data: { path: "/oc-config/agents/x.md", issues: [{ path: ["mode"], message: "valeur refusée" }] } });
          return [];
        }
        return fake.client.request(method, pathname, options);
      },
    } as unknown as OpencodeClient;
    const marks: Array<[string, boolean]> = [];
    const syncs: Array<{ applying: boolean; due: boolean }> = [];
    const restarts: Array<[string, boolean]> = [];
    const env = { opencodeConfigDir: dir, workspaceDir: dir, opencodeWorkspaceDir: "/workspace", projectConfig: false } as AppEnv;
    const studio = new StudioService({
      env,
      client,
      projects: new ProjectsService(env),
      control: {
        restartOpencode: async (reason: string) => {
          restarts.push([reason, h.queue.applying]);
          return { ok: true, durationMs: 0, message: "opencode a redémarré." };
        },
      } as unknown as ControlService,
      log: quiet,
      queue: h.queue,
      copilotConfig: {
        markDue: (cause, kind) => {
          marks.push([cause, h.queue.applying]);
          return h.sync.markDue(cause, kind);
        },
        sync: () => {
          syncs.push({ applying: h.queue.applying, due: h.sync.syncDue });
          return h.sync.sync();
        },
      },
    });
    /** Garde-fou : un blocage de la file fait échouer le test au lieu de le figer. */
    const settle = <T>(promise: Promise<T>, what: string): Promise<T> =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`blocage : ${what}`)), 2_000).unref())]);
    try {
      assert.equal((await h.sync.sync()).state, "a-jour");

      // Application en cours dans la file : le rechargement du Studio attend son tour, rien n'est libéré d'ici là.
      let finish!: () => void;
      const holding = h.queue.run(() => new Promise<void>((resolve) => (finish = resolve)));
      const saving = studio.saveInstructions({ type: "global" }, "# Consignes\n");
      await sleep(20);
      assert.equal(fake.requests.includes("POST /global/dispose"), false);
      assert.deepEqual(marks, []);
      finish();
      await holding;
      await settle(saving, "rechargement du Studio");
      assert.deepEqual(marks, [["rechargement du Studio", true]]);
      // Synchro relancée après la tâche : applying levé, indicateur déjà posé (aucun intervalle).
      assert.deepEqual(syncs, [{ applying: false, due: true }]);
      await waitFor(() => h.sync.status.state === "applique", "adresse rétablie par la synchro relancée");
      assert.equal(h.sync.syncDue, false);
      assert.deepEqual(fake.patches, ["", BIZ]);
      // Libération du Studio puis celle de la synchro : toutes deux pendant une application.
      assert.deepEqual(
        seen.filter(([line]) => line === "POST /global/dispose"),
        [
          ["POST /global/dispose", true],
          ["POST /global/dispose", true],
        ],
      );

      // Libération en échec : opencode pas touché, ni pose ni synchro.
      fake.failDispose = new Error("fetch failed");
      await settle(studio.saveInstructions({ type: "global" }, "# Consignes 2\n"), "rechargement en échec");
      assert.equal(marks.length, 1);
      assert.equal(syncs.length, 1);
      assert.equal(h.sync.syncDue, false);
      fake.failDispose = null;
      fake.disposed = false;

      // Démarrage (après la synchro de démarrage) : agent de classement installé, libération dans la file, adresse revérifiée.
      await settle(studio.ensureClassifierAgent(), "installation de l'agent de classement");
      assert.deepEqual(marks.slice(1), [["rechargement du Studio", true]]);
      assert.deepEqual(syncs.slice(1), [{ applying: false, due: true }]);
      await waitFor(() => !h.sync.syncDue, "adresse revérifiée après l'installation");

      // Configuration refusée qui reste bloquante : retour arrière puis redémarrage, dans la file, adresse revérifiée.
      fs.rmSync(path.join(dir, "agents", `${CLASSIFIER_AGENT}.md`), { force: true });
      agentRefused = true;
      await assert.rejects(settle(studio.ensureClassifierAgent(), "redémarrage du Studio"), (err: unknown) => err instanceof StudioApplyError && err.restarted);
      assert.deepEqual(restarts, [["configuration invalide annulée", true]]);
      assert.deepEqual(marks.slice(2), [
        ["rechargement du Studio", true],
        ["rechargement du Studio", true],
        ["redémarrage d'opencode (configuration invalide annulée)", true],
      ]);
      assert.equal(syncs.length, 5);
      assert.ok(
        syncs.every((s) => !s.applying && s.due),
        JSON.stringify(syncs),
      );
      await waitFor(() => !h.sync.syncDue, "adresse revérifiée après le redémarrage");
      assert.equal(h.queue.applying, false);
    } finally {
      h.sync.stop();
      fs.rmSync(dir, { recursive: true, force: true });
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
