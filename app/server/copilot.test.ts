import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { describe, it } from "node:test";
import { ModelCatalog, UNAVAILABLE_REASONS } from "./catalog.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import { billRefusal, canBill, ConfigWriteQueue } from "./config-queue.ts";
import type { ControlService } from "./control.ts";
import { CopilotApi, type CopilotEndpoint, type CopilotModel, copilotModelsFromApi, type FetchLike } from "./copilot.ts";
import { type AppEnv, EnvError, loadEnv, parseCopilotApiUrl } from "./env.ts";
import { EventHub } from "./hub.ts";
import type { Logger } from "./log.ts";
import {
  CopilotConfigSync,
  copilotBaseUrlTarget,
  currentCopilotBaseUrl,
  DEFERRED_CAUSE,
  OPENCODE_DEFAULT_COPILOT_URL,
  providerBaseUrl,
  resyncOnIdle,
  resyncOnReconnect,
  STARTUP_CAUSE,
  SYNC_DUE_MAX_MS,
  SYNC_RETRY_LEAD_MS,
  SYNC_RETRY_MIN_MS,
  type SyncDueReason,
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

  it("origine de l'application en cours (configuration ou adresse Copilot) et motif du refus d'une demande facturée, toujours cohérent avec canBill", async () => {
    const queue = new ConfigWriteQueue();
    const control = { restarting: false };
    let reason: SyncDueReason | null = null;
    const copilotConfig = {
      get syncDue() {
        return reason !== null;
      },
      get dueReason() {
        return reason;
      },
    };
    const refusal = (label: string) => {
      const found = billRefusal({ queue, control, copilotConfig });
      assert.equal(canBill({ queue, control, copilotConfig }), found === null, label);
      return found;
    };
    assert.equal(queue.applyingOrigin, null);
    assert.equal(refusal("au repos"), null);
    await queue.applyingWhile(async () => {
      assert.equal(queue.applying, true);
      assert.equal(queue.applyingOrigin, "adresse-copilot");
      assert.equal(refusal("écriture de la synchro"), "adresse-en-verification");
      reason = "coupure";
      assert.equal(refusal("écriture de la synchro, flux coupé"), "adresse-en-verification");
      reason = null;
      // Application de la configuration qui chevauche : son origine et son message l'emportent.
      await queue.applyingWhile(async () => {
        assert.equal(queue.applyingOrigin, "configuration");
        assert.equal(refusal("configuration pendant l'écriture de la synchro"), "redemarrage");
      });
      assert.equal(queue.applyingOrigin, "adresse-copilot");
      control.restarting = true;
      assert.equal(refusal("redémarrage pendant l'écriture de la synchro"), "redemarrage");
      control.restarting = false;
    }, "adresse-copilot");
    assert.equal(queue.applyingOrigin, null);
    await queue.applyingWhile(async () => {
      assert.equal(queue.applyingOrigin, "configuration");
      assert.equal(refusal("application de la configuration"), "redemarrage");
    });
    // Origine retirée même en échec.
    await assert.rejects(
      queue.applyingWhile(async () => {
        throw new Error("écriture de l'adresse en échec");
      }, "adresse-copilot"),
      /en échec/,
    );
    assert.equal(queue.applyingOrigin, null);
    assert.equal(queue.applying, false);
    // « Synchro due » selon sa raison ; un redémarrage l'emporte toujours.
    const expected: Array<[SyncDueReason, string]> = [
      ["verification", "adresse-en-verification"],
      ["coupure", "reconnexion"],
      ["correction-differee", "correction-differee"],
    ];
    for (const [due, motive] of expected) {
      reason = due;
      assert.equal(refusal(due), motive);
      control.restarting = true;
      assert.equal(refusal(`${due} pendant un redémarrage`), "redemarrage");
      control.restarting = false;
    }
    reason = null;
    assert.equal(refusal("indicateur levé"), null);
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
    options: { endpoint?: CopilotEndpoint | null; retryMs?: number; log?: Logger; now?: () => number; targetImposed?: boolean; loaded?: boolean } = {},
  ) => {
    const h = {
      endpoint: options.endpoint === undefined ? ep(BIZ) : options.endpoint,
      /** Liste des IA lue au moins une fois (ModelCatalog.loaded). */
      loaded: options.loaded ?? true,
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
      /** Appelé à chaque relecture du catalogue demandée par la synchro (après une écriture). */
      onRefresh: (): void => undefined,
      events: [] as string[],
      sync: null as unknown as CopilotConfigSync,
    };
    h.sync = new CopilotConfigSync({
      client: fake.client,
      catalog: {
        get sources() {
          return { opencodeError: null, copilotVerified: h.endpoint !== null, copilotError: null, endpoint: h.endpoint, unavailable: [] };
        },
        get loaded() {
          return h.loaded;
        },
        refresh: async () => {
          h.refreshes++;
          h.onRefresh();
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
      targetImposed: options.targetImposed,
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
  const STREAM_DOWN_MESSAGE = "opencode est injoignable ou redémarre (flux d'événements coupé) : l'adresse sera revérifiée à la reconnexion.";
  const STARTUP_WAIT_MESSAGE = "opencode ne répond pas encore : l'adresse sera vérifiée dès qu'il répondra.";
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

  it("« synchro due » levée à la fin de la synchro relancée quel que soit l'état final, exception comprise, sauf adresse fausse relue pendant une réponse ; posée pendant une synchro : laissée à la suivante", async () => {
    type Harness = ReturnType<typeof setup>;
    type Fake = ReturnType<typeof fakeOpencode>;
    const cases: Array<{ state: string; label: string; fake: () => Fake; prepare?: (h: Harness, fake: Fake) => void; keeps?: true }> = [
      { state: "a-jour", label: "dossiers à la cible", fake: () => fakeOpencode({ baseURL: BIZ }) },
      { state: "a-jour", label: "dossiers à la cible, conversation en cours", fake: () => fakeOpencode({ baseURL: BIZ }), prepare: (h) => (h.busy = async () => true) },
      { state: "applique", label: "adresse appliquée", fake: () => fakeOpencode() },
      // Adresse fausse relue sans pouvoir l'écrire (C2) : pose gardée, sous soupape, jusqu'à la fin de l'épisode.
      { state: "en-attente", label: "conversation en cours", fake: () => fakeOpencode(), prepare: (h) => (h.busy = async () => true), keeps: true },
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
        assert.equal(h.sync.syncDue, c.keeps === true, c.label);
        assert.equal(h.sync.dueReason, c.keeps ? "correction-differee" : null, c.label);
        assert.equal(canBill({ queue: h.queue, control: { restarting: false }, copilotConfig: h.sync }), c.keeps !== true, c.label);
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
      assert.equal(h.sync.status.message, STREAM_DOWN_MESSAGE);
      assert.equal(h.sync.dueReason, "coupure");
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
      assert.equal(h.sync.dueReason, "verification");
      assert.equal(h.sync.status.message, DUE_MESSAGE);
      await waitFor(() => !h.sync.syncDue, "levée par la synchro de reconnexion");
      assert.equal(fake.requests.length, reads + 2);
      assert.equal(h.sync.status.state, "a-jour");
      assert.equal(h.sync.dueReason, null);
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

  it("coupure du flux de plus de 90 s (C1) : aucune soupape tant que le flux est coupé (message de coupure, un seul warn par coupure, aucune boucle), levée par la synchro de reconnexion", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const hub = new EventHub();
    const connection = (connected: boolean) => hub.cockpit("opencode.connection", { connected, error: connected ? null : "fetch failed" });
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake, { retryMs: 5, log, now: () => clock });
    const stop = resyncOnReconnect(hub, h.sync);
    const cut = (label: string) => {
      assert.equal(h.sync.syncDue, true, label);
      assert.equal(h.sync.dueReason, "coupure", label);
      assert.equal(billable(h), false, label);
      assert.equal(h.sync.status.state, "en-attente", label);
      assert.equal(h.sync.status.message, STREAM_DOWN_MESSAGE, label);
    };
    try {
      connection(true);
      connection(false);
      cut("dès la coupure");
      // opencode injoignable : nouvelles tentatives, aucune ne lève l'indicateur (reconnexion attendue).
      fake.failProviders = new Error("fetch failed");
      assert.equal((await h.sync.sync()).state, "en-attente");
      await waitFor(() => fake.requests.length >= 8, "nouvelles tentatives pendant la coupure");
      cut("pendant les tentatives");
      // opencode de retour, flux pas encore rebranché (S14) : tentatives arrêtées (« a-jour »), indicateur toujours posé.
      fake.failProviders = null;
      assert.equal((await h.sync.sync()).state, "a-jour");
      cut("opencode de retour, flux coupé");
      const count = fake.requests.length;
      await sleep(30);
      assert.equal(fake.requests.length, count, "aucune tentative en cours");

      clock += SYNC_DUE_MAX_MS - 1;
      cut("juste avant 90 s");
      assert.equal(warns.length, 0);
      clock += 1;
      cut("à 90 s : aucune soupape pendant la coupure");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", /flux d'événements coupé depuis longtemps, demandes facturées refusées jusqu'à la reconnexion/);
      assert.deepEqual(warns[0]?.[1], { cause: "flux d'événements d'opencode coupé", waitedMs: SYNC_DUE_MAX_MS });
      // Coupure qui dure (reconnexion jamais aboutie) : lectures répétées, aucun autre journal, aucune synchro.
      for (let minute = 2; minute <= 11; minute++) {
        clock += 60_000;
        cut(`coupure depuis ${minute} min`);
      }
      // Écriture pendant la coupure : attente de la reconnexion gardée, toujours sans soupape.
      assert.equal(h.sync.markDue("fichier de configuration brut"), true);
      clock += SYNC_DUE_MAX_MS;
      cut("écriture pendant la coupure, 90 s plus tard");
      await sleep(30);
      assert.equal(fake.requests.length, count);
      assert.equal(warns.length, 1, "un seul warn par coupure");

      // Reconnexion : nouvelle pose, puis synchro qui la lève.
      connection(true);
      assert.equal(h.sync.dueReason, "verification");
      await waitFor(() => !h.sync.syncDue, "levée par la synchro de reconnexion");
      assert.equal(h.sync.status.state, "a-jour");
      assert.equal(billable(h), true);
      assert.equal(fake.requests.length, count + 2);
      assert.equal(warns.length, 1);

      // Nouvelle coupure longue : de nouveau un seul warn, compté depuis le début de cette coupure.
      connection(false);
      clock += 5 * SYNC_DUE_MAX_MS;
      cut("seconde coupure");
      cut("seconde coupure, relue");
      assert.equal(warns.length, 2);
      assert.equal(warns[1]?.[1]?.waitedMs, 5 * SYNC_DUE_MAX_MS);
      connection(true);
      await waitFor(() => !h.sync.syncDue, "levée par la seconde synchro de reconnexion");
      assert.equal(warns.length, 2);
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("soupape : pose sans coupure en cours (écriture sans synchro relancée, reconnexion dont la synchro attend) levée de force après 90 s (log.warn), sans relancer ni reposer quoi que ce soit ; délai compté depuis la dernière pose", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const hub = new EventHub();
    const fake = fakeOpencode({ baseURL: BIZ });
    const h = setup(fake, { retryMs: 5, log, now: () => clock });
    const stop = resyncOnReconnect(hub, h.sync);
    try {
      // Écriture dont la synchro relancée n'arrive jamais (événement perdu).
      assert.equal(h.sync.markDue("fichier de configuration brut"), true);
      assert.equal(h.sync.dueReason, "verification");
      clock += SYNC_DUE_MAX_MS - 1;
      assert.equal(h.sync.syncDue, true);
      assert.equal(warns.length, 0);
      clock += 1;
      assert.equal(h.sync.syncDue, false);
      assert.equal(h.sync.dueReason, null);
      assert.equal(billable(h), true);
      assert.equal(h.sync.status.state, "inactif");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", /revérification attendue trop longtemps/);
      assert.deepEqual(warns[0]?.[1], { cause: "fichier de configuration brut", waitedMs: SYNC_DUE_MAX_MS });
      // Levée sans effet de bord : aucune synchro, aucune nouvelle pose, aucun autre journal.
      await sleep(30);
      assert.deepEqual(fake.requests, []);
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

      // Reconnexion faite, sa synchro retenue dans la file : plus de coupure en cours, soupape de nouveau.
      let finish!: () => void;
      const holding = h.queue.run(() => new Promise<void>((resolve) => (finish = resolve)));
      await waitFor(() => typeof finish === "function", "file retenue");
      hub.cockpit("opencode.connection", { connected: true, error: null });
      hub.cockpit("opencode.connection", { connected: false, error: "fetch failed" });
      hub.cockpit("opencode.connection", { connected: true, error: null });
      assert.equal(h.sync.dueReason, "verification");
      clock += SYNC_DUE_MAX_MS;
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 3);
      assert.deepEqual(warns[2]?.[1], { cause: "flux d'événements d'opencode rétabli", waitedMs: SYNC_DUE_MAX_MS });
      finish();
      await holding;
      await waitFor(() => h.sync.status.state === "a-jour", "synchro de reconnexion faite");
      assert.equal(h.sync.syncDue, false);
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("adresse fausse relue pendant une réponse (C2) : « synchro due » créée, jamais réarmée par les nouvelles tentatives, soupape comptée depuis la première détection ; épisode expiré : nouvel épisode à la synchro suivante (D2) ; nouvel épisode après « applique »", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const fake = fakeOpencode();
    const h = setup(fake, { log, now: () => clock });
    h.busy = async () => true;
    const deferred = (label: string) => {
      assert.equal(h.sync.syncDue, true, label);
      assert.equal(h.sync.dueReason, "correction-differee", label);
      assert.equal(billable(h), false, label);
    };
    try {
      const first = await h.sync.sync();
      assert.equal(first.state, "en-attente");
      assert.equal(first.message, "Une conversation travaille : adresse appliquée à la prochaine vérification.");
      deferred("première détection");
      // Diagnostic : état de la synchro qui a relu l'adresse fausse, adresses relues comprises.
      assert.equal(h.sync.status, first);
      assert.deepEqual(first.details.checked, both(""));
      // Nouvelles tentatives (toutes les 30 s), réponse toujours en cours : pose gardée, jamais réarmée.
      for (const step of [30_000, 30_000, 29_999]) {
        clock += step;
        assert.equal((await h.sync.sync()).state, "en-attente");
        deferred(`tentative à +${clock - 1_000_000} ms`);
      }
      assert.equal(warns.length, 0);
      clock += 1;
      assert.equal(h.sync.syncDue, false, "90 s après la première détection");
      assert.equal(billable(h), true);
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", /revérification attendue trop longtemps/);
      assert.equal(DEFERRED_CAUSE, "adresse Copilot fausse, correction différée");
      assert.deepEqual(warns[0]?.[1], { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS });
      // Épisode expiré, réponse toujours en cours, pose levée : la synchro suivante relit l'adresse fausse et ouvre un nouvel épisode,
      // compté depuis sa fin (D2 : plus jamais rien qui garde sinon), sans autre journal et sans rien écrire.
      clock += 30_000;
      const renewedAt = clock;
      assert.equal((await h.sync.sync()).state, "en-attente");
      deferred("nouvel épisode après la soupape");
      // Écriture pendant le nouvel épisode : reprise sans réarmer (soupape comptée depuis le renouvellement, pas depuis l'écriture).
      assert.equal(h.sync.markDue("fichier de configuration brut"), true);
      assert.equal(h.sync.dueReason, "verification");
      clock += 10_000;
      assert.equal((await h.sync.sync()).state, "en-attente");
      deferred("écriture reprise par le nouvel épisode");
      clock = renewedAt + SYNC_DUE_MAX_MS - 1;
      deferred("nouvel épisode, 90 s moins 1 ms après le renouvellement");
      assert.equal(warns.length, 1);
      assert.deepEqual(fake.patches, []);

      // Réponse finie : adresse appliquée, épisode clos. Dossier revenu sur l'adresse d'office pendant une autre réponse : nouvel épisode.
      h.busy = async () => false;
      assert.equal((await h.sync.sync()).state, "applique");
      assert.equal(h.sync.syncDue, false);
      fake.instances.set(APP, "");
      h.busy = async () => true;
      clock += 1_000;
      assert.equal((await h.sync.sync()).state, "en-attente");
      deferred("nouvel épisode");
      clock += SYNC_DUE_MAX_MS - 1;
      deferred("nouvel épisode, juste avant 90 s");
      clock += 1;
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 2);
    } finally {
      h.sync.stop();
    }
  });

  it("« correction différée » (C2) : levée par « applique » et par « redemarrage-requis » ; aucune pose sans adresse fausse ni sans adresse cible ; demande en vol ; écriture couverte gardée, soupape depuis la détection ; coupure pendant l'épisode", async () => {
    let clock = 1_000_000;
    const now = () => clock;

    // Adresses justes, conversation occupée : « a-jour » sans sonde, aucune pose.
    const right = setup(fakeOpencode({ baseURL: BIZ }), { now });
    right.busy = async () => true;
    assert.equal((await right.sync.sync()).state, "a-jour");
    assert.equal(right.sync.syncDue, false);
    assert.equal(right.busyCalls, 0);

    // Levée par « applique » : réponse finie avant la soupape.
    const applied = setup(fakeOpencode(), { now });
    applied.busy = async () => true;
    try {
      assert.equal((await applied.sync.sync()).state, "en-attente");
      assert.equal(applied.sync.dueReason, "correction-differee");
      clock += 10_000;
      applied.busy = async () => false;
      assert.equal((await applied.sync.sync()).state, "applique");
      assert.equal(applied.sync.syncDue, false);
      assert.equal(billable(applied), true);
    } finally {
      applied.sync.stop();
    }

    // Levée par « redemarrage-requis » : le Diagnostic propose Redémarrer opencode, le blocage n'est jamais indéfini.
    const stuckFake = fakeOpencode({ instances: [[APP, ""]] });
    stuckFake.stuck.add(APP);
    const stuck = setup(stuckFake, { now });
    stuck.busy = async () => true;
    try {
      assert.equal((await stuck.sync.sync()).state, "en-attente");
      assert.equal(stuck.sync.dueReason, "correction-differee");
      stuck.busy = async () => false;
      assert.equal((await stuck.sync.sync()).state, "redemarrage-requis");
      assert.equal(stuck.sync.syncDue, false);
      assert.equal(stuck.sync.dueReason, null);
      assert.equal(billable(stuck), true);
    } finally {
      stuck.sync.stop();
    }

    // Demande facturée en vol (aucune sonde) : même épisode.
    const flying = setup(fakeOpencode(), { now });
    const endBilled = flying.queue.beginBilled();
    try {
      assert.equal((await flying.sync.sync()).state, "en-attente");
      assert.equal(flying.busyCalls, 0);
      assert.equal(flying.sync.dueReason, "correction-differee");
    } finally {
      endBilled();
      flying.sync.stop();
    }

    // Adresse cible perdue pendant la synchro : rien à revérifier, aucune pose.
    const lost = setup(fakeOpencode(), { now });
    lost.busy = async () => {
      lost.endpoint = null;
      return true;
    };
    try {
      assert.equal((await lost.sync.sync()).state, "en-attente");
      assert.equal(lost.sync.syncDue, false);
    } finally {
      lost.sync.stop();
    }

    // Écriture couverte par une synchro qui relit l'adresse fausse : gardée, soupape comptée depuis la détection (pas depuis
    // l'écriture). Écriture pendant l'épisode : reprise sans réarmer. Reposée pendant une synchro : laissée à la suivante.
    const covered = setup(fakeOpencode(), { now });
    covered.busy = async () => true;
    try {
      assert.equal(covered.sync.markDue("fichier de configuration brut"), true);
      clock += 50_000;
      const detectedAt = clock;
      assert.equal((await covered.sync.sync()).state, "en-attente");
      assert.equal(covered.sync.dueReason, "correction-differee");
      clock = detectedAt + 20_000;
      assert.equal(covered.sync.markDue("permissions globales"), true);
      assert.equal(covered.sync.dueReason, "verification");
      assert.equal((await covered.sync.sync()).state, "en-attente");
      assert.equal(covered.sync.dueReason, "correction-differee", "écriture reprise par l'épisode");
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      covered.busy = async () => {
        await gate;
        return true;
      };
      const running = covered.sync.sync();
      await waitFor(() => covered.busyCalls === 3, "synchro de l'épisode dans la sonde des conversations");
      assert.equal(covered.sync.markDue("correctif de configuration (mode Avancé)"), true);
      open();
      assert.equal((await running).state, "en-attente");
      assert.equal(covered.sync.dueReason, "verification", "reposée pendant la synchro : laissée à la suivante");
      covered.busy = async () => true;
      assert.equal((await covered.sync.sync()).state, "en-attente");
      assert.equal(covered.sync.dueReason, "correction-differee");
      clock = detectedAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(covered.sync.syncDue, true, "90 s moins 1 ms après la détection, 140 s après la première écriture");
      clock += 1;
      assert.equal(covered.sync.syncDue, false);
    } finally {
      covered.sync.stop();
    }

    // Coupure pendant l'épisode : pose de coupure sans soupape ; synchro pendant la coupure sans épisode compté ; à la
    // reconnexion, nouvel épisode compté depuis la synchro de reconnexion.
    const hub = new EventHub();
    const cut = setup(fakeOpencode(), { now });
    cut.busy = async () => true;
    const stop = resyncOnReconnect(hub, cut.sync);
    try {
      hub.cockpit("opencode.connection", { connected: true, error: null });
      assert.equal((await cut.sync.sync()).state, "en-attente");
      assert.equal(cut.sync.dueReason, "correction-differee");
      hub.cockpit("opencode.connection", { connected: false, error: "fetch failed" });
      assert.equal(cut.sync.dueReason, "coupure");
      assert.equal((await cut.sync.sync()).state, "en-attente");
      assert.equal(cut.sync.dueReason, "coupure", "synchro pendant la coupure : la pose attend la reconnexion");
      clock += 3 * SYNC_DUE_MAX_MS;
      assert.equal(cut.sync.dueReason, "coupure");
      hub.cockpit("opencode.connection", { connected: true, error: null });
      await waitFor(() => cut.sync.dueReason === "correction-differee", "nouvel épisode à la reconnexion");
      clock += SYNC_DUE_MAX_MS - 1;
      assert.equal(cut.sync.dueReason, "correction-differee");
      clock += 1;
      assert.equal(cut.sync.syncDue, false);
    } finally {
      stop();
      cut.sync.stop();
    }
  });

  it("coupure courte pendant un épisode « correction différée » (C2) : la coupure clôt l'épisode, aucune synchro pendant la coupure n'en ouvre ; soupape du nouvel épisode comptée depuis la reconnexion", async () => {
    let clock = 1_000_000;
    const hub = new EventHub();
    const cut = setup(fakeOpencode(), { now: () => clock });
    cut.busy = async () => true;
    const stop = resyncOnReconnect(hub, cut.sync);
    try {
      hub.cockpit("opencode.connection", { connected: true, error: null });
      assert.equal((await cut.sync.sync()).state, "en-attente");
      assert.equal(cut.sync.deferredEpisode, true);
      clock += 20_000;
      hub.cockpit("opencode.connection", { connected: false, error: "fetch failed" });
      assert.equal(cut.sync.deferredEpisode, false, "coupure : épisode clos");
      clock += 5_000;
      assert.equal((await cut.sync.sync()).state, "en-attente");
      assert.equal(cut.sync.deferredEpisode, false, "synchro pendant la coupure : aucun épisode");
      assert.equal(cut.sync.dueReason, "coupure");
      clock += 5_000;
      const reconnectAt = clock;
      hub.cockpit("opencode.connection", { connected: true, error: null });
      await waitFor(() => cut.sync.dueReason === "correction-differee", "nouvel épisode à la reconnexion");
      clock = reconnectAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(cut.sync.dueReason, "correction-differee", "ni la détection d'avant la coupure, ni la synchro pendant la coupure ne comptent");
      clock += 1;
      assert.equal(cut.sync.syncDue, false);
    } finally {
      stop();
      cut.sync.stop();
    }
  });

  it("écriture de l'adresse par la synchro (C3) : origine « adresse-copilot » de la sonde à la dernière relecture, demande facturée refusée avec le motif « adresse en vérification »", async () => {
    const fake = fakeOpencode();
    const h = setup(fake);
    const seen: Array<[string, string | null, string | null]> = [];
    const refusal = () => billRefusal({ queue: h.queue, control: h.control, copilotConfig: h.sync });
    fake.onRequest = (line) => void seen.push([line, h.queue.applyingOrigin, refusal()]);
    h.busy = async () => {
      seen.push(["sonde des conversations", h.queue.applyingOrigin, refusal()]);
      return false;
    };
    assert.equal((await h.sync.sync()).state, "applique");
    assert.deepEqual(seen, [
      ["GET /config/providers", null, null],
      [`GET /config/providers ${APP}`, null, null],
      ["sonde des conversations", "adresse-copilot", "adresse-en-verification"],
      ["PATCH /global/config", "adresse-copilot", "adresse-en-verification"],
      ["PATCH /global/config", "adresse-copilot", "adresse-en-verification"],
      ["POST /global/dispose", "adresse-copilot", "adresse-en-verification"],
      ["GET /config/providers", "adresse-copilot", "adresse-en-verification"],
      [`GET /config/providers ${APP}`, "adresse-copilot", "adresse-en-verification"],
    ]);
    assert.equal(h.queue.applyingOrigin, null);
    assert.equal(refusal(), null);
  });

  type HubEvent = Parameters<EventHub["publish"]>[0];
  /** Fin de réponse telle qu'opencode 1.18.30 la publie sur /global/event, relayée par le processeur. */
  const idleEvent = (sessionID: string): HubEvent => ({ kind: "opencode", directory: APP, event: { type: "session.idle", properties: { sessionID } } });
  const statusEvent = (sessionID: string, type: string): HubEvent => ({
    kind: "opencode",
    directory: APP,
    event: { type: "session.status", properties: { sessionID, status: { type } } },
  });

  it("fin de réponse pendant un épisode « correction différée » (D1) : synchro relancée par session.idle ou session.status idle, sans avancer l'horloge ; rien hors épisode ni pour un autre événement", async () => {
    // Filtre seul : aucune synchro hors épisode, ni pour un statut occupé, ni pour un autre événement.
    const bus = new EventHub();
    let calls = 0;
    let episode = false;
    const off = resyncOnIdle(bus, {
      sync: async () => {
        calls++;
        return { state: "a-jour", message: null, at: 0, details: { checked: [] } };
      },
      get deferredEpisode() {
        return episode;
      },
    });
    bus.publish(idleEvent("ses_a"));
    bus.publish(statusEvent("ses_a", "idle"));
    assert.equal(calls, 0, "hors épisode");
    episode = true;
    bus.cockpit("session.idle", { sessionID: "ses_a" });
    bus.publish({ kind: "opencode", event: { type: "session.updated", properties: { info: { id: "ses_a" } } } });
    bus.publish(statusEvent("ses_a", "busy"));
    bus.publish(statusEvent("ses_a", "retry"));
    bus.publish({ kind: "opencode", event: { type: "session.status", properties: { sessionID: "ses_a" } } });
    assert.equal(calls, 0, "pendant l'épisode, sans fin de réponse");
    bus.publish(idleEvent("ses_a"));
    assert.equal(calls, 1);
    bus.publish(statusEvent("ses_b", "idle"));
    assert.equal(calls, 2);
    off();
    bus.publish(idleEvent("ses_a"));
    assert.equal(calls, 2);

    // Synchro réelle : épisode ouvert, réponse finie, adresse corrigée au premier événement de fin.
    let clock = 1_000_000;
    const hub = new EventHub();
    for (const [label, event] of [
      ["session.idle", idleEvent("ses_a")],
      ["session.status idle", statusEvent("ses_a", "idle")],
    ] as const) {
      const fake = fakeOpencode();
      const h = setup(fake, { now: () => clock });
      h.busy = async () => true;
      const stop = resyncOnIdle(hub, h.sync);
      try {
        assert.equal((await h.sync.sync()).state, "en-attente", label);
        assert.equal(h.sync.dueReason, "correction-differee", label);
        assert.equal(h.sync.deferredEpisode, true, label);
        // Réponse toujours en cours : aucune synchro.
        const reads = fake.requests.length;
        hub.publish(statusEvent("ses_a", "busy"));
        hub.publish(statusEvent("ses_a", "retry"));
        await sleep(30);
        assert.equal(fake.requests.length, reads, label);
        const at = clock;
        h.busy = async () => false;
        hub.publish(event);
        await waitFor(() => h.sync.status.state === "applique", `${label} : adresse corrigée à la fin de la réponse`);
        assert.equal(clock, at, label);
        assert.equal(h.sync.syncDue, false, label);
        assert.equal(h.sync.dueReason, null, label);
        assert.equal(billable(h), true, label);
        assert.equal(h.sync.deferredEpisode, false, label);
        assert.deepEqual(fake.patches, ["", BIZ], label);
        // Épisode clos : fins de réponse suivantes sans synchro.
        await sleep(20);
        const after = fake.requests.length;
        hub.publish(idleEvent("ses_b"));
        hub.publish(statusEvent("ses_b", "idle"));
        await sleep(30);
        assert.equal(fake.requests.length, after, `${label} : hors épisode`);
        assert.equal(h.busyCalls, 2, label);
      } finally {
        stop();
        h.sync.stop();
      }
      clock += 1_000;
    }

    // Jamais d'épisode (adresses justes, conversation occupée) : aucune synchro à chaque fin de réponse.
    const right = fakeOpencode({ baseURL: BIZ });
    const r = setup(right, { now: () => clock });
    r.busy = async () => true;
    const stopRight = resyncOnIdle(hub, r.sync);
    try {
      assert.equal((await r.sync.sync()).state, "a-jour");
      const reads = right.requests.length;
      for (let i = 0; i < 5; i++) hub.publish(idleEvent(`ses_${i}`));
      await sleep(30);
      assert.equal(right.requests.length, reads);
      assert.equal(r.sync.deferredEpisode, false);
    } finally {
      stopRight();
      r.sync.stop();
    }
  });

  it("fin de réponse avec une autre conversation encore occupée (D1) : synchro relancée qui rend « en-attente », pose gardée sans réarmer la soupape (comptée depuis la première détection)", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const hub = new EventHub();
    const fake = fakeOpencode();
    const h = setup(fake, { log, now: () => clock });
    h.busy = async () => true;
    const stop = resyncOnIdle(hub, h.sync);
    try {
      const detectedAt = clock;
      assert.equal((await h.sync.sync()).state, "en-attente");
      clock += 40_000;
      // Première conversation au repos, seconde encore occupée (la sonde répond occupée).
      hub.publish(idleEvent("ses_a"));
      await waitFor(() => h.busyCalls === 2, "synchro relancée à la fin de la première réponse");
      await sleep(20);
      assert.equal(h.sync.status.state, "en-attente");
      assert.equal(h.sync.status.message, "Une conversation travaille : adresse appliquée à la prochaine vérification.");
      assert.equal(h.sync.dueReason, "correction-differee");
      assert.equal(billable(h), false);
      assert.deepEqual(fake.patches, []);
      assert.equal(h.sync.deferredEpisode, true);
      clock = detectedAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(h.sync.syncDue, true, "90 s moins 1 ms après la première détection");
      assert.equal(warns.length, 0);
      clock += 1;
      assert.equal(h.sync.syncDue, false, "soupape à 90 s de la première détection, pas de la synchro relancée");
      assert.equal(warns.length, 1);
      assert.deepEqual(warns[0]?.[1], { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS });
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("rafale de fins de réponse pendant un épisode « correction différée » (D1) : 50 événements au repos fondus en 2 synchros au plus, réponse finie ou non ; aucune synchro de plus ensuite", async () => {
    const hub = new EventHub();
    // Réponse finie : la première synchro corrige, la seconde (demandée pendant la première) relit « a-jour » ; épisode clos.
    const fake = fakeOpencode();
    const h = setup(fake);
    h.busy = async () => true;
    const stop = resyncOnIdle(hub, h.sync);
    const defaultReads = () => fake.requests.filter((line) => line === "GET /config/providers").length;
    try {
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.deferredEpisode, true);
      const before = defaultReads();
      h.busy = async () => false;
      for (let i = 0; i < 50; i++) hub.publish(i % 2 === 0 ? idleEvent(`ses_${i}`) : statusEvent(`ses_${i}`, "idle"));
      await waitFor(() => h.sync.status.state === "a-jour", "rafale traitée");
      await sleep(50);
      // Instance par défaut relue une fois par relecture : synchro 1 (avant et après l'écriture), synchro 2 (avant).
      assert.equal(defaultReads() - before, 3);
      assert.equal(h.busyCalls, 2);
      assert.deepEqual(fake.patches, ["", BIZ]);
      assert.equal(h.sync.deferredEpisode, false);
    } finally {
      stop();
      h.sync.stop();
    }

    // Réponse toujours en cours (autre conversation) : 2 synchros « en-attente » au plus, pose gardée, rien d'écrit.
    const busyFake = fakeOpencode();
    const b = setup(busyFake);
    b.busy = async () => true;
    const stopBusy = resyncOnIdle(hub, b.sync);
    try {
      assert.equal((await b.sync.sync()).state, "en-attente");
      const probes = b.busyCalls;
      for (let i = 0; i < 50; i++) hub.publish(idleEvent(`ses_${i}`));
      await waitFor(() => b.busyCalls >= probes + 2, "rafale traitée");
      await sleep(50);
      assert.equal(b.busyCalls, probes + 2);
      assert.equal(b.sync.dueReason, "correction-differee");
      assert.equal(billable(b), false);
      assert.deepEqual(busyFake.patches, []);
    } finally {
      stopBusy();
      b.sync.stop();
    }
  });

  it("synchro qui corrige un épisode « correction différée », partie 90 s + 1 ms après la détection (D2) : aucune soupape à son démarrage ni pendant sa tâche, aucun warn, demandes facturées refusées jusqu'à sa fin", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const fake = fakeOpencode();
    const h = setup(fake, { log, now: () => clock });
    h.busy = async () => true;
    try {
      const detectedAt = clock;
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.dueReason, "correction-differee");
      // Aucune lecture de la garde d'ici là : pose encore en place quand la correction démarre, après l'échéance.
      clock = detectedAt + SYNC_DUE_MAX_MS + 1;
      const seen: Array<[string, boolean, string | null, number]> = [];
      const watch = (line: string) => void seen.push([line, billable(h), billRefusal({ queue: h.queue, control: h.control, copilotConfig: h.sync }), warns.length]);
      fake.onRequest = watch;
      h.onRefresh = () => watch("relecture du catalogue");
      h.busy = async () => {
        watch("sonde des conversations");
        return false;
      };
      const status = await h.sync.sync();
      assert.equal(status.state, "applique", status.message ?? "");
      assert.deepEqual(seen, [
        ["GET /config/providers", false, "correction-differee", 0],
        [`GET /config/providers ${APP}`, false, "correction-differee", 0],
        ["sonde des conversations", false, "adresse-en-verification", 0],
        ["PATCH /global/config", false, "adresse-en-verification", 0],
        ["PATCH /global/config", false, "adresse-en-verification", 0],
        ["POST /global/dispose", false, "adresse-en-verification", 0],
        ["GET /config/providers", false, "adresse-en-verification", 0],
        [`GET /config/providers ${APP}`, false, "adresse-en-verification", 0],
        // Adresse écrite et relue : la relecture de la liste des IA n'attend plus la fin d'une réponse (message de vérification).
        ["relecture du catalogue", false, "adresse-en-verification", 0],
      ]);
      assert.equal(warns.length, 0, "chemin normal : aucun warn de soupape");
      assert.equal(h.sync.syncDue, false);
      assert.equal(h.sync.dueReason, null);
      assert.equal(billable(h), true);
      assert.equal(h.sync.deferredEpisode, false);
      assert.deepEqual(fake.patches, ["", BIZ]);
      // Hors d'une synchro qui la couvre, la soupape reste appliquée à la lecture (nouvel épisode, aucune synchro).
      fake.instances.set(APP, "");
      h.busy = async () => true;
      fake.onRequest = () => undefined;
      assert.equal((await h.sync.sync()).state, "en-attente");
      clock += SYNC_DUE_MAX_MS;
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 1);
    } finally {
      h.sync.stop();
    }
  });

  it("tentatives pendant un épisode « correction différée » (D2) : la dernière avant la soupape part SYNC_RETRY_LEAD_MS avant l'échéance, pose encore en place ; jamais de rafale ; délai normal hors épisode", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // Minuteries simulées : attente des synchros par tours de boucle (setImmediate), jamais par setTimeout.
    const flush = async () => {
      for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    let clock = 1_000_000;
    const advance = async (ms: number) => {
      clock += ms;
      t.mock.timers.tick(ms);
      await flush();
    };
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    assert.equal(SYNC_RETRY_LEAD_MS, 5_000);
    assert.equal(SYNC_RETRY_MIN_MS, 1_000);

    const fake = fakeOpencode();
    const h = setup(fake, { retryMs: 30_000, log, now: () => clock });
    const starts: Array<[number, boolean, SyncDueReason | null, number]> = [];
    const detectedAt = clock;
    h.busy = async () => {
      starts.push([clock - detectedAt, billable(h), h.sync.dueReason, warns.length]);
      return true;
    };
    try {
      assert.equal((await h.sync.sync()).state, "en-attente");
      // Loin de l'échéance : délai normal (30 s), deux fois.
      await advance(29_999);
      assert.equal(h.busyCalls, 1);
      await advance(1);
      assert.equal(h.busyCalls, 2, "tentative à +30 s");
      await advance(29_999);
      assert.equal(h.busyCalls, 2);
      await advance(1);
      assert.equal(h.busyCalls, 3, "tentative à +60 s");
      // Tentative suivante avancée : échéance − marge = +85 s, soit 25 s plus tard au lieu de 30.
      await advance(24_999);
      assert.equal(h.busyCalls, 3, "rien avant +85 s");
      await advance(1);
      assert.equal(h.busyCalls, 4, "tentative à +85 s, avant la soupape");
      // Première détection : aucune pose encore, sonde gardée par l'écriture de la synchro (applying) ; tentatives : pose en place.
      assert.deepEqual(starts, [
        [0, false, null, 0],
        [30_000, false, "correction-differee", 0],
        [60_000, false, "correction-differee", 0],
        [SYNC_DUE_MAX_MS - SYNC_RETRY_LEAD_MS, false, "correction-differee", 0],
      ]);
      // Synchro partie dans la marge, réponse toujours en cours : délai normal ensuite, aucune rafale jusqu'à l'échéance.
      await advance(SYNC_RETRY_LEAD_MS - 1);
      assert.equal(h.busyCalls, 4, "aucune tentative dans les dernières secondes");
      assert.equal(h.sync.syncDue, true);
      await advance(1);
      assert.equal(h.sync.syncDue, false, "soupape à l'échéance");
      assert.equal(warns.length, 1);
      assert.equal(h.busyCalls, 4);
      await advance(30_000 - SYNC_RETRY_LEAD_MS - 1);
      assert.equal(h.busyCalls, 4);
      await advance(1);
      assert.equal(h.busyCalls, 5, "tentative à +115 s : retryMs après celle de +85 s");
      // Épisode expiré, réponse toujours en cours : cette tentative (aucune pose couverte) ouvre un nouvel épisode compté depuis
      // +115 s, au même calendrier : +145, +175, puis +200 (= 115 + 90 − 5) avant sa soupape à +205 ; troisième épisode à +230.
      assert.equal(h.sync.dueReason, "correction-differee", "nouvel épisode à +115 s");
      assert.equal(billable(h), false);
      assert.equal(warns.length, 1);
      await advance(30_000);
      assert.equal(h.busyCalls, 6, "tentative à +145 s");
      await advance(30_000);
      assert.equal(h.busyCalls, 7, "tentative à +175 s");
      await advance(24_999);
      assert.equal(h.busyCalls, 7);
      await advance(1);
      assert.equal(h.busyCalls, 8, "tentative avancée du nouvel épisode à +200 s");
      await advance(SYNC_RETRY_LEAD_MS - 1);
      assert.equal(h.sync.syncDue, true, "nouvel épisode encore gardé à +204,999 s");
      await advance(1);
      assert.equal(h.sync.syncDue, false, "soupape du nouvel épisode à +205 s");
      assert.equal(warns.length, 2);
      await advance(25_000);
      assert.equal(h.busyCalls, 9, "tentative à +230 s");
      assert.equal(h.sync.dueReason, "correction-differee", "troisième épisode");
      assert.deepEqual(starts.slice(4), [
        [115_000, false, null, 1],
        [145_000, false, "correction-differee", 1],
        [175_000, false, "correction-differee", 1],
        [200_000, false, "correction-differee", 1],
        [230_000, false, null, 2],
      ]);
      assert.equal(warns.length, 2);
      assert.deepEqual(fake.patches, []);
    } finally {
      h.sync.stop();
    }

    // Hors épisode : pose de revérification (écriture pendant une synchro qui ne joint pas opencode), 80 s d'âge à la fin de la
    // synchro : délai normal, jamais avancé vers sa soupape.
    const plain = fakeOpencode();
    const k = setup(plain, { retryMs: 30_000, log: quiet, now: () => clock });
    try {
      plain.failProviders = new Error("fetch failed");
      let posed = false;
      plain.onRequest = () => {
        if (posed) return;
        posed = true;
        assert.equal(k.sync.markDue("fichier de configuration brut"), true);
        clock += SYNC_DUE_MAX_MS - SYNC_RETRY_LEAD_MS - 5_000;
      };
      assert.equal((await k.sync.sync()).state, "en-attente");
      assert.equal(k.sync.dueReason, "verification");
      assert.equal(k.sync.deferredEpisode, false);
      const reads = plain.requests.length;
      await advance(5_000);
      assert.equal(plain.requests.length, reads, "aucune tentative avancée hors épisode");
      await advance(25_000 - 1);
      assert.equal(plain.requests.length, reads);
      await advance(1);
      assert.ok(plain.requests.length > reads, "tentative à retryMs");
    } finally {
      k.sync.stop();
    }

    // Borne minimale : départ visé à moins de SYNC_RETRY_MIN_MS (synchro finie dans la marge) → délai normal, jamais de rafale ;
    // à SYNC_RETRY_MIN_MS pile → délai avancé.
    for (const [endedAt, delay] of [
      [SYNC_DUE_MAX_MS - SYNC_RETRY_LEAD_MS - SYNC_RETRY_MIN_MS + 1, 30_000],
      [SYNC_DUE_MAX_MS - SYNC_RETRY_LEAD_MS - SYNC_RETRY_MIN_MS, SYNC_RETRY_MIN_MS],
    ] as const) {
      const g = setup(fakeOpencode(), { retryMs: 30_000, log: quiet, now: () => clock });
      g.busy = async () => true;
      try {
        const since = clock;
        assert.equal((await g.sync.sync()).state, "en-attente");
        // Synchro relancée (fin de réponse d'une autre conversation, celle-ci encore en cours) endedAt après la détection.
        clock = since + endedAt;
        assert.equal((await g.sync.sync()).state, "en-attente");
        assert.equal(g.sync.dueReason, "correction-differee");
        const probes = g.busyCalls;
        await advance(delay - 1);
        assert.equal(g.busyCalls, probes, `rien avant ${delay} ms (synchro finie à +${endedAt} ms)`);
        await advance(1);
        assert.equal(g.busyCalls, probes + 1, `tentative à ${delay} ms (synchro finie à +${endedAt} ms)`);
      } finally {
        g.sync.stop();
      }
    }
  });

  it("épisode « correction différée » expiré (D2) : synchro partie après l'échéance qui rend encore « en-attente » : pose tenue pendant sa tâche puis levée par la soupape (un warn) ; la synchro suivante ouvre un nouvel épisode : jamais de pose sans fin, jamais plus rien qui garde ; correction à la fin de la réponse", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const hub = new EventHub();
    const fake = fakeOpencode();
    const h = setup(fake, { log, now: () => clock });
    h.busy = async () => true;
    const stop = resyncOnIdle(hub, h.sync);
    try {
      const detectedAt = clock;
      assert.equal((await h.sync.sync()).state, "en-attente");
      clock += 30_000;
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.dueReason, "correction-differee");
      // Synchro partie 90 s + 10 ms après la détection, sans lecture de la garde d'ici là ; la conversation travaille encore.
      clock = detectedAt + SYNC_DUE_MAX_MS + 10;
      const during: Array<[boolean, SyncDueReason | null, number]> = [];
      h.busy = async () => {
        during.push([billable(h), h.sync.dueReason, warns.length]);
        return true;
      };
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.deepEqual(during, [[false, "correction-differee", 0]], "pose tenue pendant la tâche, aucune soupape avant sa fin");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", /revérification attendue trop longtemps, demandes facturées de nouveau admises/);
      assert.deepEqual(warns[0]?.[1], { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS + 10 });
      assert.equal(h.sync.syncDue, false, "levée à la fin de la synchro qui la couvrait, sans renouvellement par elle");
      assert.equal(billable(h), true);
      assert.equal(h.sync.deferredEpisode, true, "épisode toujours ouvert : adresse toujours fausse");
      // Conversation qui ne finit pas, tentatives toutes les 30 s pendant 5 min : chaque synchro sans pose couverte ouvre un nouvel
      // épisode, levé par la soupape à la synchro qui le couvre 90 s plus tard. Pose d'au plus 90 s, puis au moins une tentative sans
      // pose, jamais plus d'une tentative sans pose d'affilée.
      const expected: Array<[string, boolean, number]> = [
        ["nouvel épisode", true, 1],
        ["gardé", true, 1],
        ["gardé", true, 1],
        ["soupape", false, 2],
        ["nouvel épisode", true, 2],
        ["gardé", true, 2],
        ["gardé", true, 2],
        ["soupape", false, 3],
        ["nouvel épisode", true, 3],
        ["gardé", true, 3],
      ];
      for (const [i, [label, guarded, warned]] of expected.entries()) {
        clock += 30_000;
        during.length = 0;
        assert.equal((await h.sync.sync()).state, "en-attente");
        assert.equal(during.length, 1);
        assert.equal(during[0]?.[0], false, `tentative ${i + 1} : demandes refusées pendant sa tâche (sonde gardée)`);
        assert.equal(h.sync.syncDue, guarded, `tentative ${i + 1} (${label})`);
        assert.equal(billable(h), !guarded, `tentative ${i + 1} (${label})`);
        if (guarded) assert.equal(h.sync.dueReason, "correction-differee", `tentative ${i + 1} (${label})`);
        assert.equal(warns.length, warned, `tentative ${i + 1} (${label})`);
        assert.equal(h.sync.deferredEpisode, true);
      }
      assert.deepEqual(
        warns.map(([, fields]) => fields),
        [
          { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS + 10 },
          { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS },
          { cause: DEFERRED_CAUSE, waitedMs: SYNC_DUE_MAX_MS },
        ],
      );
      assert.deepEqual(fake.patches, []);
      // Fin de la réponse pendant le quatrième épisode : synchro relancée, adresse corrigée, épisode clos.
      h.busy = async () => false;
      hub.publish(idleEvent("ses_a"));
      await waitFor(() => h.sync.status.state === "applique", "correction à la fin de la réponse");
      assert.equal(h.sync.deferredEpisode, false);
      assert.equal(h.sync.syncDue, false);
      assert.deepEqual(fake.patches, ["", BIZ]);
      assert.equal(warns.length, 3);
      // Nouvel épisode : pose de nouveau, soupape comptée depuis cette détection.
      await sleep(20);
      fake.instances.set(APP, "");
      h.busy = async () => true;
      clock += 1_000;
      const again = clock;
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.dueReason, "correction-differee");
      clock = again + SYNC_DUE_MAX_MS - 1;
      assert.equal(h.sync.syncDue, true);
      clock += 1;
      assert.equal(h.sync.syncDue, false);
      assert.equal(warns.length, 4);
      // Épisode expiré, pose levée, opencode injoignable : aucun nouvel épisode sans adresse relue (épisode toujours ouvert) ;
      // opencode de retour, adresse relue fausse, réponse toujours en cours : nouvel épisode.
      fake.failProviders = new Error("fetch failed");
      clock += 30_000;
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.syncDue, false, "opencode injoignable : aucun nouvel épisode");
      assert.equal(h.sync.deferredEpisode, true);
      fake.failProviders = null;
      clock += 30_000;
      assert.equal((await h.sync.sync()).state, "en-attente");
      assert.equal(h.sync.dueReason, "correction-differee", "adresse relue fausse : nouvel épisode");
      assert.equal(warns.length, 4);
    } finally {
      stop();
      h.sync.stop();
    }
  });

  it("démarrage du cockpit avec adresse imposée par .env (D3) : « synchro due » dès la construction, avant toute lecture de la liste des IA ; refus « adresse en vérification » jusqu'à la fin de la première synchro, qui la lève ; sans adresse imposée, rien", async () => {
    // Sans adresse imposée (adresse inconnue, ou découverte par la liste des IA) : aucune pose, ni à la construction ni ensuite.
    for (const endpoint of [null, ep(BIZ)]) {
      const free = setup(fakeOpencode(), { endpoint });
      assert.equal(free.sync.syncDue, false);
      assert.equal(free.sync.dueReason, null);
      assert.equal(billable(free), true);
      assert.equal(free.sync.markStartup(), false);
      assert.equal(free.sync.syncDue, false);
    }

    const clock = 1_000_000;
    const lines: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const log: Logger = {
      debug: (message: string, fields?: Record<string, unknown>) => void lines.push(["debug", message, fields]),
      info: (message: string, fields?: Record<string, unknown>) => void lines.push(["info", message, fields]),
      warn: (message: string, fields?: Record<string, unknown>) => void lines.push(["warn", message, fields]),
      error: (message: string, fields?: Record<string, unknown>) => void lines.push(["error", message, fields]),
    };
    const fake = fakeOpencode();
    const h = setup(fake, { endpoint: null, targetImposed: true, loaded: false, log, now: () => clock });
    // Construit, rien lu, opencode jamais joint : adresse encore inconnue du cockpit, opencode peut tourner sur l'adresse d'office.
    assert.equal(STARTUP_CAUSE, "démarrage du cockpit");
    assert.equal(h.sync.syncDue, true);
    assert.equal(h.sync.dueReason, "coupure");
    assert.equal(billable(h), false);
    assert.equal(billRefusal({ queue: h.queue, control: h.control, copilotConfig: h.sync }), "reconnexion");
    assert.deepEqual(h.sync.status, { state: "en-attente", message: STARTUP_WAIT_MESSAGE, at: clock, details: { checked: [] } });
    assert.deepEqual(lines, [["debug", "adresse de l'API Copilot d'opencode : revérification due", { cause: STARTUP_CAUSE, untilReconnect: false }]]);
    assert.deepEqual(fake.requests, []);
    // opencode répond (boucle de santé de main.ts) : pose reposée, revérification ordinaire.
    assert.equal(h.sync.markStartup(), true);
    assert.equal(h.sync.dueReason, "verification");
    assert.equal(billRefusal({ queue: h.queue, control: h.control, copilotConfig: h.sync }), "adresse-en-verification");
    assert.deepEqual(h.sync.status, { state: "en-attente", message: DUE_MESSAGE, at: clock, details: { checked: [] } });
    assert.equal(lines.length, 2);
    // Liste des IA lue (adresse de .env retenue), puis synchro de démarrage : refus jusqu'à sa fin, pose levée ensuite.
    h.lastEndpoint = ep(BIZ, "env");
    h.loaded = true;
    const seen: boolean[] = [];
    fake.onRequest = () => void seen.push(billable(h));
    h.onRefresh = () => void seen.push(billable(h));
    assert.equal((await h.sync.sync()).state, "applique");
    assert.equal(seen.length, 8);
    assert.ok(
      seen.every((admitted) => !admitted),
      JSON.stringify(seen),
    );
    assert.equal(h.sync.syncDue, false);
    assert.equal(h.sync.dueReason, null);
    assert.equal(billable(h), true);
    assert.equal(h.sync.status.state, "applique");
    assert.equal(
      lines.filter(([, message]) => message === "adresse de l'API Copilot d'opencode : revérification faite").length,
      1,
    );

    // Adresse imposée mais GitHub Copilot non connecté (liste des IA lue, aucune adresse retenue) : première synchro « inactif », pose
    // levée.
    const offline = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: true });
    assert.equal(billable(offline), false);
    assert.equal((await offline.sync.sync()).state, "inactif");
    assert.equal(offline.sync.syncDue, false);
    assert.equal(billable(offline), true);

    // Conversation en cours au démarrage (S2, S15) : la première synchro ouvre l'épisode « correction différée », sans intervalle.
    const busyAtStart = setup(fakeOpencode(), { endpoint: null, targetImposed: true });
    busyAtStart.lastEndpoint = ep(BIZ, "env");
    busyAtStart.busy = async () => true;
    try {
      assert.equal(billable(busyAtStart), false);
      assert.equal((await busyAtStart.sync.sync()).state, "en-attente");
      assert.equal(busyAtStart.sync.dueReason, "correction-differee");
      assert.equal(billable(busyAtStart), false);
    } finally {
      busyAtStart.sync.stop();
    }
  });

  it("démarrage avec adresse imposée et opencode injoignable (D3) : aucune soupape tant qu'opencode n'a jamais répondu (motif « reconnexion », Diagnostic « en-attente », un seul warn, aucune boucle) ; synchros « en-attente » (opencode injoignable, redémarrage, écriture inachevée) : pose gardée, jamais reposée par elles ; opencode de retour : pose reposée sous soupape, levée par la synchro de démarrage", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const refusal = (x: ReturnType<typeof setup>) => billRefusal({ queue: x.queue, control: x.control, copilotConfig: x.sync });
    const WAIT_WARN = /opencode injoignable depuis le démarrage du cockpit, demandes facturées refusées jusqu'à sa réponse/;
    // Attente d'opencode : refus « reconnexion » (jamais « réessayez dans quelques secondes »), Diagnostic « en-attente », jamais « inactif ».
    const waiting = (x: ReturnType<typeof setup>, label: string) => {
      assert.equal(billable(x), false, label);
      assert.equal(x.sync.dueReason, "coupure", label);
      assert.equal(refusal(x), "reconnexion", label);
      assert.equal(x.sync.status.state, "en-attente", label);
      assert.equal(x.sync.status.message, STARTUP_WAIT_MESSAGE, label);
    };
    const fake = fakeOpencode();
    const h = setup(fake, { endpoint: null, targetImposed: true, loaded: false, retryMs: 5, log, now: () => clock });
    try {
      // Attente d'opencode (boucle de santé de main.ts), arrêté plus de 90 s (S17 variante longue) : aucune synchro ne part.
      clock += SYNC_DUE_MAX_MS - 1;
      waiting(h, "juste avant 90 s");
      assert.equal(warns.length, 0);
      clock += 1;
      waiting(h, "à 90 s : aucune soupape tant qu'opencode n'a jamais répondu");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", WAIT_WARN);
      assert.deepEqual(warns[0]?.[1], { cause: STARTUP_CAUSE, waitedMs: SYNC_DUE_MAX_MS });
      for (let minute = 2; minute <= 6; minute++) {
        clock += 60_000;
        waiting(h, `attente depuis ${minute} min`);
      }
      await sleep(30);
      assert.deepEqual(fake.requests, [], "aucune synchro, aucune boucle");
      assert.equal(warns.length, 1, "un seul warn");
      // opencode répond : pose reposée (main.ts, une fois), refus « adresse en vérification » jusqu'à la fin de la synchro de démarrage.
      h.lastEndpoint = ep(BIZ, "env");
      h.loaded = true;
      assert.equal(h.sync.markStartup(), true);
      assert.equal(billable(h), false);
      assert.equal(h.sync.dueReason, "verification");
      assert.equal(refusal(h), "adresse-en-verification");
      assert.equal(h.sync.status.message, DUE_MESSAGE);
      assert.equal((await h.sync.sync()).state, "applique");
      assert.equal(billable(h), true);
      assert.equal(warns.length, 1);
    } finally {
      h.sync.stop();
    }

    // Liste des IA lue pendant l'attente (catalog.onChange) : synchros « en-attente » (lectures en échec, sonde des conversations en
    // échec, redémarrage en cours, écriture inachevée) : pose de démarrage gardée, tentatives sans boucle, aucune soupape tant
    // qu'opencode n'a jamais répondu. opencode répond : pose reposée par main.ts, sous soupape comptée depuis cette pose (un warn),
    // jamais reposée par une synchro ; pose reposée puis levée par la synchro de démarrage.
    warns.length = 0;
    const down = fakeOpencode();
    const g = setup(down, { endpoint: null, targetImposed: true, retryMs: 5, log, now: () => clock });
    const builtAt = clock;
    try {
      g.lastEndpoint = ep(BIZ, "env");
      down.failProviders = new Error("fetch failed");
      waiting(g, "construction");
      assert.equal((await g.sync.sync()).state, "en-attente");
      waiting(g, "lectures en échec : pose gardée");
      await waitFor(() => down.requests.length >= 10, "nouvelles tentatives pendant l'attente");
      g.sync.stop();
      waiting(g, "tentatives : pose gardée");
      // Adresse relue (fausse) mais sonde des conversations en échec : pose gardée.
      down.failProviders = null;
      g.busy = async () => {
        throw new Error("fetch failed");
      };
      assert.equal((await g.sync.sync()).state, "en-attente");
      waiting(g, "sonde en échec : pose gardée");
      // Redémarrage lancé pendant la sonde, puis redémarrage en cours dès le début de la synchro suivante : pose gardée.
      g.busy = async () => {
        g.control.restarting = true;
        return false;
      };
      assert.equal((await g.sync.sync()).state, "en-attente");
      assert.equal(g.sync.dueReason, "coupure", "redémarrage lancé pendant la sonde : pose gardée");
      assert.equal((await g.sync.sync()).state, "en-attente");
      assert.equal(g.sync.dueReason, "coupure", "redémarrage en cours : pose gardée");
      g.control.restarting = false;
      g.busy = async () => false;
      assert.deepEqual(down.patches, []);
      // Écriture inachevée (PATCH cible refusé deux fois après l'adresse intermédiaire) : opencode sur l'adresse d'office, pose gardée.
      down.failPatch = (rank) => (rank === 1 ? null : new Error("opencode 500"));
      const unfinished = await g.sync.sync();
      assert.equal(unfinished.state, "en-attente");
      assert.ok(unfinished.message?.startsWith("Adresse intermédiaire (adresse d'office) restée écrite"), unfinished.message ?? "");
      waiting(g, "écriture inachevée : pose gardée");
      down.failPatch = () => null;
      assert.deepEqual(down.patches, [""]);
      // 90 s depuis la construction, opencode jamais joint : aucune soupape, un seul warn.
      clock = builtAt + SYNC_DUE_MAX_MS - 1;
      waiting(g, "juste avant 90 s");
      assert.equal(warns.length, 0);
      clock += 1;
      waiting(g, "à 90 s");
      assert.equal(warns.length, 1);
      assert.match(warns[0]?.[0] ?? "", WAIT_WARN);
      // opencode répond : pose reposée par main.ts, sous soupape comptée depuis cette pose ; une synchro qui ne joint pas opencode ne
      // repose rien ensuite.
      assert.equal(g.sync.markStartup(), true);
      const answeredAt = clock;
      assert.equal(g.sync.dueReason, "verification");
      clock = answeredAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(billable(g), false);
      clock += 1;
      assert.equal(billable(g), true, "soupape : jamais de blocage indéfini une fois opencode joint");
      assert.equal(warns.length, 2);
      assert.match(warns[1]?.[0] ?? "", /revérification attendue trop longtemps/);
      assert.deepEqual(warns[1]?.[1], { cause: STARTUP_CAUSE, waitedMs: SYNC_DUE_MAX_MS });
      down.failProviders = new Error("fetch failed");
      assert.equal((await g.sync.sync()).state, "en-attente");
      assert.equal(g.sync.syncDue, false);
      assert.equal(warns.length, 2);
      // Pose reposée : refus jusqu'à la fin de la synchro de démarrage, qui la lève.
      down.failProviders = null;
      assert.equal(g.sync.markStartup(), true);
      assert.equal(billable(g), false);
      assert.equal((await g.sync.sync()).state, "applique");
      assert.equal(g.sync.syncDue, false);
      assert.equal(billable(g), true);
      assert.deepEqual(down.patches, ["", "", BIZ]);
      assert.equal(warns.length, 2);
    } finally {
      g.sync.stop();
    }
  });

  it("écriture ou redémarrage pendant le démarrage, adresse imposée par .env (D3) : avant la première lecture de la liste des IA, pose de démarrage reposée (jamais effacée) et gardée par une synchro « inactif » partie avant cette lecture ; levée par la synchro qui connaît l'adresse, ou par la soupape ; pose de démarrage en vigueur : l'écriture en garde le caractère", async () => {
    let clock = 1_000_000;
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = { ...quiet, warn: (message: string, fields?: Record<string, unknown>) => void warns.push([message, fields]) };
    const refusal = (x: ReturnType<typeof setup>) => billRefusal({ queue: x.queue, control: x.control, copilotConfig: x.sync });
    const RESTART = "redémarrage d'opencode (page Diagnostic)";
    const fake = fakeOpencode();
    const h = setup(fake, { endpoint: null, targetImposed: true, loaded: false, log, now: () => clock });
    try {
      // opencode joignable (main.ts), première lecture de la liste des IA en cours (jusqu'à 35 s avec un GitHub lent).
      assert.equal(h.sync.markStartup(), true);
      clock += 10_000;
      // « Redémarrer opencode » (page Diagnostic) pendant cette lecture : pose reposée, jamais effacée.
      assert.equal(h.sync.markDue(RESTART), true);
      assert.equal(h.sync.syncDue, true);
      assert.equal(h.sync.dueReason, "verification");
      assert.equal(refusal(h), "adresse-en-verification");
      // Synchro relancée par la route, adresse encore inconnue : « inactif », pose gardée (rien n'a été vérifié).
      assert.equal((await h.sync.sync()).state, "inactif");
      assert.equal(h.sync.syncDue, true);
      assert.equal(refusal(h), "adresse-en-verification");
      // Rechargement du Studio pendant la même lecture : même chemin, soupape comptée depuis cette pose.
      clock += 10_000;
      assert.equal(h.sync.markDue("rechargement du Studio"), true);
      const posedAt = clock;
      assert.equal((await h.sync.sync()).state, "inactif");
      assert.equal(refusal(h), "adresse-en-verification");
      assert.deepEqual(fake.requests, []);
      clock = posedAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(refusal(h), "adresse-en-verification");
      assert.equal(warns.length, 0);
      // Liste lue, adresse de .env connue : synchro qui la corrige, pose levée, demande admise.
      h.lastEndpoint = ep(BIZ, "env");
      h.loaded = true;
      assert.equal((await h.sync.sync()).state, "applique");
      assert.equal(h.sync.syncDue, false);
      assert.equal(refusal(h), null);
      assert.deepEqual(fake.patches, ["", BIZ]);
      assert.equal(warns.length, 0);
    } finally {
      h.sync.stop();
    }

    // Liste jamais lue, opencode joint : soupape à 90 s de la dernière pose (un warn), jamais de blocage indéfini.
    const g = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: false, log, now: () => clock });
    try {
      assert.equal(g.sync.markStartup(), true);
      clock += 30_000;
      assert.equal(g.sync.markDue(RESTART), true);
      const posedAt = clock;
      assert.equal((await g.sync.sync()).state, "inactif");
      clock = posedAt + SYNC_DUE_MAX_MS - 1;
      assert.equal(billable(g), false);
      clock += 1;
      assert.equal(billable(g), true);
      assert.equal(warns.length, 1);
      assert.deepEqual(warns[0]?.[1], { cause: RESTART, waitedMs: SYNC_DUE_MAX_MS });
    } finally {
      g.sync.stop();
    }

    // Synchro « inactif » dont la tâche part avant la fin de la première lecture et se règle après : pose gardée (elle n'a rien vu).
    // Fin de la lecture PENDANT la synchro : au premier accès de #sync à l'adresse retenue, une microtâche (effective avant le
    // règlement) marque la liste lue et retient l'adresse de .env. Seule la valeur lue en tête de tâche compte, jamais celle du règlement.
    const race = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: false });
    try {
      assert.equal(race.sync.markStartup(), true);
      let flipped = false;
      Object.defineProperty(race, "endpoint", {
        get: () => {
          if (!flipped) {
            flipped = true;
            queueMicrotask(() => {
              race.loaded = true;
              race.lastEndpoint = ep(BIZ, "env");
            });
          }
          return null;
        },
      });
      assert.equal((await race.sync.sync()).state, "inactif");
      assert.equal(flipped, true, "adresse retenue lue par la synchro");
      assert.equal(race.loaded, true, "liste lue pendant la synchro, avant son règlement");
      assert.equal(race.sync.syncDue, true, "liste lue pendant la synchro : pose gardée");
      assert.equal(refusal(race), "adresse-en-verification", "liste lue pendant la synchro : pose gardée");
    } finally {
      race.sync.stop();
    }

    // Adresse de .env connue (lecture Copilot faite) mais liste des IA pas encore lue : synchro « applique » qui lève la pose de
    // démarrage ; écriture ordinaire ensuite, levée par une synchro « inactif » (GitHub Copilot déconnecté), liste toujours non lue.
    const partial = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: false });
    partial.lastEndpoint = ep(BIZ, "env");
    try {
      assert.equal(partial.sync.markStartup(), true);
      assert.equal((await partial.sync.sync()).state, "applique");
      assert.equal(partial.sync.syncDue, false, "adresse vérifiée : pose levée, liste non lue");
      assert.equal(partial.sync.markDue("fichier de configuration brut"), true);
      partial.lastEndpoint = null;
      assert.equal((await partial.sync.sync()).state, "inactif");
      assert.equal(partial.sync.syncDue, false, "pose ordinaire : levée par « inactif »");
    } finally {
      partial.sync.stop();
    }

    // Liste lue, GitHub Copilot non connecté (aucune adresse retenue) : rien à revérifier, markDue retire la pose et n'en pose aucune ;
    // synchro « inactif » partie la liste lue : pose de démarrage levée. Sans adresse imposée, liste pas encore lue : rien.
    const offline = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: true });
    try {
      assert.equal(offline.sync.markStartup(), true);
      assert.equal(offline.sync.markDue(RESTART), false);
      assert.equal(offline.sync.syncDue, false);
      assert.equal(billable(offline), true);
      assert.equal(offline.sync.markStartup(), true);
      assert.equal((await offline.sync.sync()).state, "inactif");
      assert.equal(offline.sync.syncDue, false);
    } finally {
      offline.sync.stop();
    }
    const free = setup(fakeOpencode(), { endpoint: null, loaded: false });
    assert.equal(free.sync.markDue(RESTART), false);
    assert.equal(free.sync.syncDue, false);

    // Adresse connue (liste lue), pose de démarrage en vigueur (flux d'événements pas encore suivi) : écriture qui en garde le
    // caractère, gardée par une synchro « en-attente » (opencode injoignable). Pose de démarrage levée ou expirée : écriture ordinaire,
    // levée par une telle synchro comme avant.
    const kfake = fakeOpencode();
    const known = setup(kfake, { endpoint: null, targetImposed: true, loaded: true, log: quiet, now: () => clock });
    known.lastEndpoint = ep(BIZ, "env");
    try {
      assert.equal(known.sync.markStartup(), true);
      assert.equal(known.sync.markDue("rechargement du Studio"), true);
      known.busy = async () => {
        throw new Error("fetch failed");
      };
      assert.equal((await known.sync.sync()).state, "en-attente");
      assert.equal(refusal(known), "adresse-en-verification", "écriture pendant le démarrage : pose gardée");
      known.busy = async () => false;
      assert.equal((await known.sync.sync()).state, "applique");
      assert.equal(known.sync.syncDue, false);
      kfake.failProviders = new Error("fetch failed");
      assert.equal(known.sync.markDue("fichier de configuration brut"), true);
      assert.equal(known.sync.markDue("rechargement du Studio"), true);
      assert.equal((await known.sync.sync()).state, "en-attente");
      assert.equal(known.sync.syncDue, false, "pose de démarrage levée : écritures ordinaires, la seconde ne prend aucun caractère « démarrage »");
      assert.equal(known.sync.markStartup(), true);
      clock += SYNC_DUE_MAX_MS;
      assert.equal(known.sync.markDue("rechargement du Studio"), true);
      assert.equal((await known.sync.sync()).state, "en-attente");
      assert.equal(known.sync.syncDue, false, "pose de démarrage expirée : écriture ordinaire");
    } finally {
      known.sync.stop();
    }

    // opencode jamais joint, adresse connue : redémarrage demandé pendant l'attente, aucune soupape (opencode peut revenir sur
    // l'adresse d'office avant que la boucle de santé le voie).
    const early = setup(fakeOpencode(), { endpoint: null, targetImposed: true, loaded: true, log: quiet, now: () => clock });
    early.lastEndpoint = ep(BIZ, "env");
    clock += 2 * SYNC_DUE_MAX_MS;
    assert.equal(early.sync.markDue(RESTART), true);
    clock += 5 * SYNC_DUE_MAX_MS;
    assert.equal(billable(early), false);
    assert.equal(refusal(early), "reconnexion");
    early.sync.stop();

    // Coupure pendant la pose de démarrage (opencode joint), écriture 90 s plus tard (flux toujours coupé), puis reconnexion : la pose
    // garde le caractère « démarrage » ; synchro de reconnexion « en-attente » (opencode injoignable) : pose gardée, sous soupape.
    const cfake = fakeOpencode();
    const cut = setup(cfake, { endpoint: null, targetImposed: true, loaded: true, log: quiet, now: () => clock });
    cut.lastEndpoint = ep(BIZ, "env");
    try {
      assert.equal(cut.sync.markStartup(), true);
      assert.equal(cut.sync.markDue("flux d'événements d'opencode coupé", "coupure"), true);
      clock += SYNC_DUE_MAX_MS;
      assert.equal(cut.sync.markDue("fichier de configuration brut"), true);
      assert.equal(cut.sync.markDue("flux d'événements d'opencode rétabli", "reconnexion"), true);
      cfake.failProviders = new Error("fetch failed");
      assert.equal((await cut.sync.sync()).state, "en-attente");
      assert.equal(refusal(cut), "adresse-en-verification", "caractère « démarrage » gardé à travers la coupure");
      clock += SYNC_DUE_MAX_MS;
      assert.equal(billable(cut), true, "sous soupape");
    } finally {
      cut.sync.stop();
    }
  });

  it("Studio : libérations et redémarrages dans la file partagée (applying posé), « synchro due » posée avant la libération d'applying (libération en erreur ou hors délai comprise) puis synchro relancée ; aucun blocage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-studio-file-"));
    // Cache global périmé (S7/S8) : une libération du Studio reconstruit les dossiers sur l'adresse d'office.
    const fake = fakeOpencode({ baseURL: BIZ, cachedBaseURL: "", instances: [[null, BIZ], [APP, BIZ]] });
    const h = setup(fake);
    const seen: Array<[string, boolean]> = [];
    const origins: Array<string | null> = [];
    fake.onRequest = (line) => {
      seen.push([line, h.queue.applying]);
      if (line === "POST /global/dispose") origins.push(h.queue.applyingOrigin);
    };
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
      // Origine : application de la configuration pour le Studio (message « redémarrage »), adresse Copilot pour la synchro.
      assert.deepEqual(origins, ["configuration", "adresse-copilot"]);

      // Libération en erreur ou hors délai (C4) : opencode a pu libérer quand même, pose puis synchro relancée après la tâche.
      const failures = [new Error("fetch failed"), new DOMException("The operation was aborted due to timeout", "TimeoutError")];
      for (const [index, failure] of failures.entries()) {
        fake.failDispose = failure;
        await settle(studio.saveInstructions({ type: "global" }, `# Consignes ${index + 2}\n`), `rechargement en échec : ${failure.message}`);
        assert.deepEqual(marks.slice(1 + index), [["rechargement du Studio", true]], failure.message);
        assert.deepEqual(syncs.slice(1 + index), [{ applying: false, due: true }], failure.message);
        await waitFor(() => !h.sync.syncDue, `adresse revérifiée après la libération en échec : ${failure.message}`);
        assert.equal(h.sync.status.state, "a-jour", failure.message);
      }
      fake.failDispose = null;
      fake.disposed = false;

      // Démarrage (après la synchro de démarrage) : agent de classement installé, libération dans la file, adresse revérifiée.
      await settle(studio.ensureClassifierAgent(), "installation de l'agent de classement");
      assert.deepEqual(marks.slice(3), [["rechargement du Studio", true]]);
      assert.deepEqual(syncs.slice(3), [{ applying: false, due: true }]);
      await waitFor(() => !h.sync.syncDue, "adresse revérifiée après l'installation");

      // Configuration refusée qui reste bloquante : retour arrière puis redémarrage, dans la file, adresse revérifiée.
      fs.rmSync(path.join(dir, "agents", `${CLASSIFIER_AGENT}.md`), { force: true });
      agentRefused = true;
      await assert.rejects(settle(studio.ensureClassifierAgent(), "redémarrage du Studio"), (err: unknown) => err instanceof StudioApplyError && err.restarted);
      assert.deepEqual(restarts, [["configuration invalide annulée", true]]);
      assert.deepEqual(marks.slice(4), [
        ["rechargement du Studio", true],
        ["rechargement du Studio", true],
        ["redémarrage d'opencode (configuration invalide annulée)", true],
      ]);
      assert.equal(syncs.length, 7);
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
