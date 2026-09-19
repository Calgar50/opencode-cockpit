// Tests L1f : interface du portillon et Diagnostic du travail délégué (spécification §3.14, §3.11, §4.8.1 l.716, §6 l.1048 ; plan
// d'exécution, fiche L1f). Collecteur du Diagnostic sur le faux opencode (GET /config et GET /global/config, GET /agent avec
// `task: allow`, extensions de la configuration et de oc-config/plugin(s)/) et, pour GET /experimental/capabilities que le faux ne
// sert pas, sur un client qui répond à sa place ; relevés impossibles journalisés sans bandeau ; port partagé et avertissements
// espacés ; route T0 montée par le module ; textes de l'avis, de la carte détaillée et des agents internes ; garde-fous de
// l'interface lus dans les sources (aucun HTML brut, avis sans [Voir les équipes], « Arrêter » relié à l'arbre).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AGENTS_MAX,
  collectDelegationBanners,
  configuredExtensions,
  createDelegationDiagnostics,
  type DelegationDiagnosticsDeps,
  type DiagnosticCheck,
  delegatingAgents,
  NOM_MAX,
  NOMS_MAX,
  nomExtension,
  pluginFileNames,
  subagentDepth,
  WARN_INTERVAL_MS,
} from "./diagnostics-11.ts";
import { INSTALLED_AGENTS } from "./internal-agents.ts";
import type { Logger } from "./log.ts";
import type { OcAgentInfo, OcLookupSnapshot } from "./oc-lookup.ts";
import type { OpencodeClient, RequestOptions } from "./opencode.ts";
import type { DelegationRefusalCode, RuleActionLite } from "./shared/activity-types.ts";
import type { Rule } from "./shared/assistant-rules.ts";
import type { DelegationBanner, DelegationBannerCode, DiagnosticActiviteResponse } from "./shared/cockpit-event-types.ts";
import {
  avisSimple,
  bandeauDiagnostic,
  etatAgentInterne,
  libelleAction,
  libelleAgentInterne,
  libelleCible,
  libelleDroit,
  libelleIa,
  nomAgentInterne,
  phraseCompteurs,
  phraseEstimation,
  phraseRefusPrevu,
  TEXTES,
  titreAgentsInternes,
  titreDiagnostic,
} from "./shared/delegation-texts.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(APP_DIR, relative), "utf8");

const CODES = ["profondeur", "arriere-plan", "extension", "task-allow"] as const;
// Liste complète : un code ajouté au contrat sans phrase fait échouer la compilation (typecheck) de ce test.
const CODES_COMPLETS: [Exclude<DelegationBannerCode, (typeof CODES)[number]>] extends [never] ? true : false = true;
const REFUS: readonly DelegationRefusalCode[] = [
  "demande-morte",
  "cible-refusee",
  "task-id-hors-arbre",
  "consigne-refusee",
  "ia-refusee",
  "budget-refuse",
  "plafond-atteint",
];

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action });

const agent = (name: string, mode: OcAgentInfo["mode"], permission: Rule[], extra: Partial<OcAgentInfo> = {}): OcAgentInfo => ({
  name,
  mode,
  permission,
  ...extra,
});

const fakeAgent = (name: string, mode: FakeAgent["mode"], permission: FakeAgent["permission"], extra: Partial<FakeAgent> = {}): FakeAgent => ({
  name,
  mode,
  options: {},
  permission,
  ...extra,
});

/** Client qui sert GET /experimental/capabilities (absente du faux) et relaie le reste ; `calls` : requêtes reçues. */
function withCapabilities(client: Pick<OpencodeClient, "request">, capabilities: () => unknown, calls: string[] = []): Pick<OpencodeClient, "request"> {
  return {
    request: <T>(method: string, pathname: string, options?: RequestOptions): Promise<T> => {
      calls.push(`${method} ${pathname}`);
      if (method === "GET" && pathname === "/experimental/capabilities") return Promise.resolve(capabilities() as T);
      return client.request<T>(method, pathname, options);
    },
  };
}

/** Relevés impossibles reçus par le collecteur. */
function warnings() {
  const seen: Array<{ check: DiagnosticCheck; error: string }> = [];
  return {
    seen,
    warn: (check: DiagnosticCheck, err: unknown) => void seen.push({ check, error: err instanceof Error ? err.message : String(err) }),
    checks: () => seen.map((w) => w.check).sort(),
  };
}

/** Dossier de configuration jetable (oc-config), supprimé à la fin du test. */
function configDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-l1f-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir: string, relative: string, content = "export default {};") => {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
  fs.writeFileSync(path.join(dir, relative), content);
};

// --- Lectures pures ---------------------------------------------------------------------------------------------------------------

describe("Diagnostic du travail délégué : lectures (diagnostics-11.ts)", () => {
  it("subagent_depth : absente = 1 (défaut d'opencode), clé de premier niveau avant l'ancienne clé experimental, valeur illisible refusée", () => {
    assert.equal(CODES_COMPLETS, true);
    assert.equal(subagentDepth({}), 1);
    assert.equal(subagentDepth({ subagent_depth: null }), 1);
    assert.equal(subagentDepth({ subagent_depth: 0 }), 0);
    assert.equal(subagentDepth({ subagent_depth: 3 }), 3);
    assert.equal(subagentDepth({ experimental: { subagent_depth: 4 } }), 4, "ancienne clé reprise par config/v2-compat.ts");
    assert.equal(subagentDepth({ subagent_depth: 1, experimental: { subagent_depth: 4 } }), 1, "la clé de premier niveau l'emporte");
    for (const bad of ["2", -1, 1.5, true, {}, []]) assert.throws(() => subagentDepth({ subagent_depth: bad }), /subagent_depth illisible/, String(bad));
  });

  it("nom d'extension : jamais un chemin ni les identifiants ou paramètres d'une adresse ; caractères cachés retirés, longueur bornée", () => {
    // Adresse avec identifiants construite ici (jamais écrite d'un seul tenant dans le source : aucune alerte des analyses de secrets).
    const secret = ["https://", "utilisateur", ":", "motdepasse", "@exemple.test"].join("");
    const cases: Array<[unknown, string | null]> = [
      ["file:///home/node/.config/opencode/plugin/mon-outil.ts", "mon-outil.ts"],
      ["file:///C:/Users/personne/dossier-prive/p.js", "p.js"],
      ["file:///home/node/.config/opencode/plugin/mon%20outil.ts", "mon outil.ts"],
      ["/home/node/.config/opencode/plugins/absolu.ts", "absolu.ts"],
      ["C:\\Users\\personne\\plugins\\windows.ts", "windows.ts"],
      ["./plugins/relatif.ts", "relatif.ts"],
      ["oh-my-opencode@4.19.4", "oh-my-opencode@4.19.4"],
      ["@portee/extension@1.2.3", "@portee/extension@1.2.3"],
      ["npm:paquet@1.0.0", "paquet@1.0.0"],
      [["extension-avec-options@2", { option: true }], "extension-avec-options@2"],
      [`${secret}/dossier/distant.js?jeton=abc#fragment`, "distant.js"],
      [secret, "exemple.test"],
      ["git+ssh://git@exemple.test/org/depot.git", "depot.git"],
      ["", null],
      ["   ", null],
      [42, null],
      [null, null],
      [[], null],
      [[7, {}], null],
    ];
    for (const [spec, expected] of cases) assert.equal(nomExtension(spec), expected, JSON.stringify(spec));
    for (const [spec] of cases) {
      const name = nomExtension(spec) ?? "";
      assert.ok(!/[\\/]/.test(name.replace(/^@portee\//, "")), `aucun chemin : ${name}`);
      assert.ok(!name.includes("motdepasse") && !name.includes("utilisateur") && !name.includes("jeton"), `aucun identifiant : ${name}`);
    }
    const hidden = `plugin/a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x7)}c.ts`;
    assert.equal(nomExtension(hidden), "abc.ts");
    const long = nomExtension(`${"x".repeat(NOM_MAX * 2)}.ts`) ?? "";
    assert.equal(Array.from(long).length, NOM_MAX);
    assert.ok(long.endsWith("…"));
  });

  it("extensions : entrée plugin absente = aucune, illisible refusée ; fichiers .ts et .js de plugin/ et plugins/ seulement", async (t) => {
    assert.deepEqual(configuredExtensions(undefined), []);
    assert.deepEqual(configuredExtensions(null), []);
    assert.deepEqual(configuredExtensions(["a@1", ["b@2", {}], 3]), ["a@1", "b@2"]);
    assert.throws(() => configuredExtensions("a@1"), /plugin illisible/);
    assert.throws(() => configuredExtensions({ a: 1 }), /plugin illisible/);

    const dir = configDir(t);
    assert.deepEqual(await pluginFileNames(dir), [], "dossiers absents : aucun");
    write(dir, "plugin/outil.ts");
    write(dir, "plugins/local.js");
    write(dir, "plugin/notes.md");
    write(dir, "plugins/sous-dossier.ts/index.ts");
    write(dir, "agent/pas-une-extension.ts");
    assert.deepEqual(await pluginFileNames(dir), ["local.js", "outil.ts"]);
    const notADir = configDir(t);
    write(notADir, "plugin", "fichier, pas dossier");
    assert.deepEqual(await pluginFileNames(notADir), [], "plugin est un fichier : aucun");
  });

  it("task-allow : la dernière règle l'emporte, sur une cible existante ; appelants visibles et non internes ; sous-agents selon la profondeur", () => {
    const agents: OcAgentInfo[] = [
      agent("build", "primary", [rule("*", "*", "allow"), rule("task", "*", "ask")]),
      agent("libre", "primary", [rule("task", "*", "allow")]),
      agent("joker", "primary", [rule("*", "*", "allow")]),
      agent("cible-seule", "primary", [rule("task", "*", "ask"), rule("task", "explore", "allow")]),
      agent("fantome", "primary", [rule("task", "*", "ask"), rule("task", "inexistant", "allow")]),
      agent("revoque", "primary", [rule("task", "*", "allow"), rule("task", "*", "deny")]),
      agent("autre-droit", "primary", [rule("bash", "*", "allow"), rule("task", "*", "ask")]),
      agent("cache", "primary", [rule("task", "*", "allow")], { hidden: true }),
      agent("cockpit-controle", "primary", [rule("task", "*", "allow")]),
      agent("compaction", "primary", [rule("task", "*", "allow")]),
      agent("polyvalent", "all", [rule("task", "*", "allow")]),
      agent("explore", "subagent", [rule("task", "*", "allow")]),
    ];
    const primaires = ["libre", "joker", "cible-seule", "polyvalent"];
    assert.deepEqual(delegatingAgents(agents, 1), primaires, "profondeur 1 : un sous-agent ne délègue pas");
    assert.deepEqual(delegatingAgents(agents, 0), primaires);
    assert.deepEqual(delegatingAgents(agents, 2), [...primaires, "explore"]);
    assert.deepEqual(delegatingAgents(agents, null), [...primaires, "explore"], "profondeur non relevée : sous-agents retenus");
    assert.deepEqual(delegatingAgents([], 1), []);
    // Borne : au-delà de AGENTS_MAX, rien n'est examiné (ni appelant, ni cible).
    const many = Array.from({ length: AGENTS_MAX + 5 }, (_, i) => agent(`a${i}`, "primary", [rule("task", `a${AGENTS_MAX + 4}`, "allow")]));
    assert.deepEqual(delegatingAgents(many, 1), []);
  });
});

// --- Collecteur sur le faux opencode ----------------------------------------------------------------------------------------------

describe("Diagnostic du travail délégué : collecteur sur le faux opencode", () => {
  it("configuration livrée (profil Prudent) : aucun bandeau, aucun relevé impossible, aucune écriture ni redémarrage (P6)", async (t) => {
    const h = await startCockpit(t);
    const w = warnings();
    const calls: string[] = [];
    const banners = await collectDelegationBanners({
      client: withCapabilities(h.deps.client, () => ({ backgroundSubagents: false }), calls),
      lookup: h.deps.lookup,
      env: h.deps.env,
      warn: w.warn,
    });
    assert.deepEqual(banners, []);
    assert.deepEqual(w.seen, []);
    assert.deepEqual(calls.sort(), ["GET /config", "GET /experimental/capabilities"], "lectures seulement");
    h.assertNoGlobalRestart();
    assert.deepEqual(h.fake.failures, []);
  });

  it("profondeur : subagent_depth > 1 dans la configuration globale (/global/config) ou du dossier de travail (/config effective)", async (t) => {
    const h = await startCockpit(t);
    const collect = async () => {
      const w = warnings();
      const banners = await collectDelegationBanners({
        client: withCapabilities(h.deps.client, () => ({ backgroundSubagents: false })),
        lookup: h.deps.lookup,
        env: h.deps.env,
        warn: w.warn,
      });
      assert.deepEqual(w.seen, []);
      return banners;
    };
    h.fake.globalConfig = { ...h.fake.globalConfig, subagent_depth: 3 };
    const global = await h.deps.client.request<Record<string, unknown>>("GET", "/global/config");
    assert.equal(global.subagent_depth, 3, "configuration globale du faux");
    assert.deepEqual(await collect(), [{ code: "profondeur", noms: [] }]);
    h.fake.globalConfig = { ...h.fake.globalConfig, subagent_depth: 1 };
    assert.deepEqual(await collect(), [], "1 : défaut, aucun niveau de plus");
    h.fake.projectConfigs.set(h.fake.directory, { subagent_depth: 2 });
    assert.deepEqual(await collect(), [{ code: "profondeur", noms: [] }], "configuration effective du dossier de travail");
  });

  it("sous-agents en arrière-plan : capacité vraie → bandeau ; fausse → rien ; route absente (faux opencode) → rien et relevé impossible", async (t) => {
    const h = await startCockpit(t);
    const collect = async (client: Pick<OpencodeClient, "request">) => {
      const w = warnings();
      const banners = await collectDelegationBanners({ client, lookup: h.deps.lookup, env: h.deps.env, warn: w.warn });
      return { banners, checks: w.checks() };
    };
    assert.deepEqual(await collect(withCapabilities(h.deps.client, () => ({ backgroundSubagents: true }))), {
      banners: [{ code: "arriere-plan", noms: [] }],
      checks: [],
    });
    assert.deepEqual(await collect(withCapabilities(h.deps.client, () => ({ backgroundSubagents: false }))), { banners: [], checks: [] });
    assert.deepEqual(await collect(withCapabilities(h.deps.client, () => ({ backgroundSubagents: "oui" }))), { banners: [], checks: ["arriere-plan"] });
    assert.deepEqual(await collect(h.deps.client), { banners: [], checks: ["arriere-plan"] }, "le faux ne sert pas /experimental/capabilities (404)");
  });

  it("extensions : configuration (file://, npm) et oc-config/plugin(s)/, noms sans chemin, dédoublonnés, bornés", async (t) => {
    const h = await startCockpit(t);
    h.fake.globalConfig = {
      ...h.fake.globalConfig,
      plugin: ["file:///home/node/.config/opencode/plugin/outil.ts", "oh-my-opencode@4.19.4", ["extension-reglee@1", { niveau: 2 }]],
    };
    const dir = h.deps.env.opencodeConfigDir;
    write(dir, "plugin/outil.ts");
    write(dir, "plugins/local.js");
    write(dir, "plugin/notes.md");
    const w = warnings();
    const banners = await collectDelegationBanners({
      client: withCapabilities(h.deps.client, () => ({ backgroundSubagents: false })),
      lookup: h.deps.lookup,
      env: h.deps.env,
      warn: w.warn,
    });
    assert.deepEqual(banners, [{ code: "extension", noms: ["outil.ts", "oh-my-opencode@4.19.4", "extension-reglee@1", "local.js"] }]);
    assert.deepEqual(w.seen, []);
    for (const name of banners[0]?.noms ?? []) assert.ok(!name.includes("/") && !name.includes("home"), name);

    // Plus de NOMS_MAX extensions : liste coupée, « … » en plus.
    h.fake.globalConfig = { ...h.fake.globalConfig, plugin: Array.from({ length: NOMS_MAX + 3 }, (_, i) => `extension-${i}@1`) };
    const many = await collectDelegationBanners({
      client: withCapabilities(h.deps.client, () => ({ backgroundSubagents: false })),
      lookup: h.deps.lookup,
      env: h.deps.env,
      warn: w.warn,
    });
    const noms = many.find((b) => b.code === "extension")?.noms ?? [];
    assert.equal(noms.length, NOMS_MAX + 1);
    assert.equal(noms.at(-1), "…");
  });

  it("agents task: allow (faux GET /agent) : bandeau avec leurs noms ; sous-agent retenu seulement quand la profondeur le permet", async (t) => {
    const h = await startCockpit(t);
    h.fake.setAgents([
      fakeAgent("build", "primary", [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "ask" },
      ]),
      fakeAgent("delegue-tout", "primary", [{ permission: "task", pattern: "*", action: "allow" }]),
      fakeAgent("explore", "subagent", [{ permission: "task", pattern: "*", action: "allow" }]),
      fakeAgent("cockpit-classifier", "primary", [{ permission: "task", pattern: "*", action: "allow" }], { hidden: true }),
    ]);
    const collect = async () => {
      const w = warnings();
      const banners = await collectDelegationBanners({
        client: withCapabilities(h.deps.client, () => ({ backgroundSubagents: false })),
        lookup: h.deps.lookup,
        env: h.deps.env,
        warn: w.warn,
      });
      assert.deepEqual(w.seen, []);
      return banners;
    };
    assert.deepEqual(await collect(), [{ code: "task-allow", noms: ["delegue-tout"] }]);
    h.fake.globalConfig = { ...h.fake.globalConfig, subagent_depth: 2 };
    assert.deepEqual(await collect(), [
      { code: "profondeur", noms: [] },
      { code: "task-allow", noms: ["delegue-tout", "explore"] },
    ]);
  });

  it("relevés impossibles : aucun bandeau pour eux, un relevé impossible chacun ; les relevés lisibles restent servis", async (t) => {
    const dir = configDir(t);
    write(dir, "plugin/outil.ts");
    const failing: DelegationDiagnosticsDeps = {
      client: { request: async () => Promise.reject(new Error("opencode ne répond pas")) },
      lookup: { get: async () => Promise.reject(new Error("opencode ne répond pas")) },
      env: { opencodeConfigDir: dir },
    };
    const w = warnings();
    assert.deepEqual(await collectDelegationBanners({ ...failing, warn: w.warn }), [{ code: "extension", noms: ["outil.ts"] }]);
    assert.deepEqual(w.checks(), ["agents", "arriere-plan", "configuration"]);

    // Configuration lisible, subagent_depth illisible : pas de bandeau de profondeur, extensions de la configuration gardées, et les
    // sous-agents qui délèguent sont retenus (profondeur non relevée : le défaut n'est pas supposé).
    const snapshot: OcLookupSnapshot = {
      directory: null,
      agents: [agent("explore", "subagent", [rule("task", "*", "allow")])],
      commands: [],
      loadedAt: 0,
    };
    const partial = warnings();
    const banners = await collectDelegationBanners({
      client: {
        request: async <T>(_method: string, pathname: string): Promise<T> =>
          (pathname === "/config" ? { subagent_depth: "3", plugin: ["x@1"] } : { backgroundSubagents: false }) as T,
      },
      lookup: { get: async () => snapshot },
      env: { opencodeConfigDir: path.join(dir, "absent") },
      warn: partial.warn,
    });
    assert.deepEqual(banners, [
      { code: "extension", noms: ["x@1"] },
      { code: "task-allow", noms: ["explore"] },
    ]);
    assert.deepEqual(partial.checks(), ["profondeur"]);

    // Réponse qui n'est pas un objet : configuration illisible.
    const odd = warnings();
    await collectDelegationBanners({
      client: { request: async <T>(): Promise<T> => [] as T },
      lookup: { get: async () => snapshot },
      env: { opencodeConfigDir: path.join(dir, "absent") },
      warn: odd.warn,
    });
    assert.deepEqual(odd.checks(), ["arriere-plan", "configuration"]);
  });

  it("port : un relevé à la fois (appels simultanés partagés, puis relevé neuf) ; relevé impossible journalisé au plus une fois par minute", async () => {
    let configCalls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logged: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
    const log: Pick<Logger, "warn"> = { warn: (message, fields) => void logged.push({ message, fields }) };
    const port = createDelegationDiagnostics({
      client: {
        request: async <T>(_method: string, pathname: string): Promise<T> => {
          if (pathname === "/config") {
            configCalls++;
            await gate;
            return { subagent_depth: 2 } as T;
          }
          return { backgroundSubagents: false } as T;
        },
      },
      lookup: { get: async () => ({ directory: null, agents: [], commands: [], loadedAt: 0 }) },
      env: { opencodeConfigDir: path.join(os.tmpdir(), "cockpit-l1f-absent-", String(process.pid)) },
      log,
    });
    const first = port.delegation();
    const second = port.delegation();
    assert.equal(first, second, "même relevé");
    release();
    assert.deepEqual(await first, [{ code: "profondeur", noms: [] }]);
    assert.equal(configCalls, 1);
    await port.delegation();
    assert.equal(configCalls, 2, "relevé neuf une fois le précédent fini");
    assert.equal(logged.length, 0, "aucun relevé impossible");

    let now = 1_000_000;
    const failingPort = createDelegationDiagnostics(
      {
        client: { request: async () => Promise.reject(new Error("opencode ne répond pas")) },
        lookup: { get: async () => ({ directory: null, agents: [], commands: [], loadedAt: 0 }) },
        env: { opencodeConfigDir: path.join(os.tmpdir(), "cockpit-l1f-absent-", String(process.pid)) },
        log,
      },
      { now: () => now },
    );
    assert.deepEqual(await failingPort.delegation(), []);
    const releves = () => logged.map((entry) => String(entry.fields?.releve)).sort();
    assert.deepEqual(releves(), ["arriere-plan", "configuration"]);
    assert.ok(logged.every((entry) => entry.message === "Diagnostic du travail délégué : relevé impossible"));
    assert.ok(logged.every((entry) => entry.fields?.error === "opencode ne répond pas"));
    now += WARN_INTERVAL_MS - 1;
    await failingPort.delegation();
    assert.equal(logged.length, 2, "dans la minute : rien de plus");
    now += 1;
    await failingPort.delegation();
    assert.deepEqual(releves(), ["arriere-plan", "arriere-plan", "configuration", "configuration"]);
  });

  it("route GET /api/diagnostic/activite : bandeaux relevés par le module diagnostics, dans l'ordre, sans écriture ni redémarrage", async (t) => {
    const h = await startCockpit(t, { modules: ["diagnostics"] });
    h.fake.globalConfig = { ...h.fake.globalConfig, subagent_depth: 4, plugin: ["file:///home/node/.config/opencode/plugins/outil.js"] };
    h.fake.setAgents([fakeAgent("delegue-tout", "primary", [{ permission: "task", pattern: "*", action: "allow" }])]);
    const res = await h.call("GET", "/api/diagnostic/activite", { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const body = res.json<DiagnosticActiviteResponse>();
    // Le faux ne sert pas /experimental/capabilities : pas de bandeau « arriere-plan » (relevé impossible, journalisé).
    assert.deepEqual(body.delegation, [
      { code: "profondeur", noms: [] },
      { code: "extension", noms: ["outil.js"] },
      { code: "task-allow", noms: ["delegue-tout"] },
    ] satisfies DelegationBanner[]);
    assert.ok(Array.isArray(body.agentsInternes));
    assert.equal((await h.call("GET", "/api/diagnostic/activite")).status, 401, "sans cookie de session");
    h.assertNoGlobalRestart();
    assert.deepEqual(h.fake.failures, []);
  });
});

// --- Textes ---------------------------------------------------------------------------------------------------------------------

describe("Interface du portillon : textes (delegation-texts.ts)", () => {
  it("avis du mode Simple : texte de la décision n° 4 (Q5, option b), sans phrase sur les équipes", () => {
    assert.equal(avisSimple(), "En mode Simple, l'IA ne délègue pas : elle continue seule.");
    assert.ok(!/équipe/i.test(avisSimple()));
  });

  it("bandeaux : une phrase par code et par mode, noms joints ; code inconnu → rien ; titres", () => {
    for (const code of CODES) {
      for (const advanced of [false, true]) {
        const text = bandeauDiagnostic({ code, noms: ["alpha", "beta"] }, advanced);
        assert.ok(text, `${code} ${advanced}`);
        assert.ok(!text.includes("{"), text);
        if (code === "extension" || code === "task-allow") assert.ok(text.includes("alpha, beta"), text);
      }
    }
    assert.equal(bandeauDiagnostic({ code: "titre" as DelegationBannerCode, noms: [] }, false), null);
    assert.equal(bandeauDiagnostic({ code: "autre" as DelegationBannerCode, noms: [] }, true), null);
    assert.equal(bandeauDiagnostic({ code: "constructor" as DelegationBannerCode, noms: [] }, true), null, "pas de propriété héritée");
    assert.equal(bandeauDiagnostic({ code: "extension", noms: undefined as unknown as string[] }, false)?.includes("{noms}"), false);
    assert.notEqual(titreDiagnostic(false), titreDiagnostic(true));
    assert.ok(!/agent/i.test(titreDiagnostic(false)) && !/agent/i.test(titreAgentsInternes(false)));
    assert.match(bandeauDiagnostic({ code: "profondeur", noms: [] }, true) ?? "", /subagent_depth/);
  });

  it("agents internes : chaque agent installé a un libellé Simple ; nom réservé seulement en Avancé ; état en mots, heure du prochain essai", () => {
    for (const { name } of INSTALLED_AGENTS) {
      const label = libelleAgentInterne(name);
      assert.ok(label, name);
      assert.equal(nomAgentInterne(name, false), label);
      assert.ok(!label.includes("cockpit-"), label);
    }
    assert.equal(nomAgentInterne("cockpit-inconnu", false), TEXTES.simple.agentsInternes.inconnu);
    assert.equal(nomAgentInterne("cockpit-inconnu", true), "cockpit-inconnu");
    assert.equal(libelleAgentInterne("constructor"), null, "pas de propriété héritée");

    const heure = (ms: number) => `H${ms}`;
    const t = TEXTES.partout.agentsInternes;
    assert.equal(etatAgentInterne({ etat: "installe", prochainEssai: null }, heure), t.installe);
    assert.equal(etatAgentInterne({ etat: "en-attente", prochainEssai: null }, heure), t.enAttente, "avant la première tentative : aucune raison");
    const reprise = etatAgentInterne({ etat: "en-attente", prochainEssai: 42 }, heure);
    assert.match(reprise, /moment sans réponse en cours/);
    assert.ok(reprise.includes("H42"));
    assert.ok(etatAgentInterne({ etat: "echec", prochainEssai: 7 }, heure).includes("H7"));
    assert.equal(etatAgentInterne({ etat: "echec", prochainEssai: null }, heure), t.refusee, "échec sans reprise : refusé par opencode");
    assert.equal(etatAgentInterne({ etat: "non-suivi", prochainEssai: null }, heure), t.nonSuivi);
    assert.equal(etatAgentInterne({ etat: "autre" as "installe", prochainEssai: null }, heure), t.nonSuivi);
  });

  it("carte détaillée : cible, IA, estimation, compteurs, droits et refus prévu, sans gabarit resté ouvert", () => {
    const c = TEXTES.avance.carte;
    assert.equal(libelleCible(null), c.cibleInconnue);
    assert.equal(libelleCible({ nom: "explore", titre: "explore", mode: "subagent", interne: false }), `explore · ${c.ciblePortee.subagent}`);
    assert.equal(libelleCible({ nom: "revue", titre: "Relecteur", mode: "all", interne: false }), `Relecteur (revue) · ${c.ciblePortee.all}`);
    assert.equal(libelleCible({ nom: "revue", titre: "", mode: "étrange", interne: false }), "revue · étrange");
    assert.ok(libelleCible({ nom: "cockpit-controle", titre: "cockpit-controle", mode: "primary", interne: true }).endsWith(c.cibleInterne));
    assert.equal(libelleCible({ nom: "x", titre: "x", mode: "constructor", interne: false }), "x · constructor");

    assert.equal(libelleIa({ model: "github-copilot/gpt-5-mini", disponible: true }), "github-copilot/gpt-5-mini");
    assert.equal(libelleIa({ model: "autre/ia", disponible: false }), `autre/ia : ${c.iaRefusee}`);
    assert.equal(libelleIa({ model: null, disponible: false }), `${c.iaInconnue} : ${c.iaRefusee}`);

    assert.equal(phraseEstimation(null), c.estimationInconnue);
    assert.equal(phraseEstimation(Number.NaN), c.estimationInconnue);
    assert.equal(phraseEstimation(0.18), "≈ 0,18 $ en général");
    assert.equal(phraseCompteurs({ delegations: 2, delegationsMax: 5, depenseUsd: 0.12, plafondUsd: 1 }), "délégations : 2 sur 5 · dépense : 0,12 $ sur 1 $");

    assert.equal(libelleDroit("task"), c.droitsNoms.task);
    assert.equal(libelleDroit("todowrite"), "todowrite");
    assert.equal(libelleDroit("constructor"), "constructor");
    for (const action of ["allow", "ask", "deny"] as const) assert.equal(libelleAction(action), c.actions[action]);
    assert.equal(libelleAction(null), c.actionInconnue);
    assert.equal(libelleAction("toString" as RuleActionLite), c.actionInconnue);

    for (const code of REFUS) {
      const text = phraseRefusPrevu(code);
      assert.ok(text.endsWith(c.raisons[code]), code);
      assert.ok(!text.includes("{"), text);
    }
    assert.equal(phraseRefusPrevu("autre" as DelegationRefusalCode), c.refusPrevuSansRaison);
    assert.match(c.arobase, /@fichier/);
    assert.match(c.arobase, /lu sans vous demander/);
  });
});

// --- Garde-fous de l'interface (sources) ------------------------------------------------------------------------------------------

describe("Interface du portillon : garde-fous lus dans les sources", () => {
  const COMPONENTS = [
    "web/pages/chat/delegation/DelegationNotice.tsx",
    "web/pages/chat/delegation/DelegationDetails.tsx",
    "web/pages/diagnostics/DelegationDiagnostics.tsx",
  ];

  it("aucun HTML brut : textes d'IA, d'opencode et du serveur rendus en texte par React", () => {
    for (const file of COMPONENTS) {
      const source = read(file);
      assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), file);
      assert.ok(source.includes("server/shared/delegation-texts.ts"), `${file} : textes contrôlés par le test « textes »`);
    }
    // Carte détaillée : nom et titre de l'assistant, IA, portée passent par boundedAiText (caractères cachés retirés, longueur bornée).
    const details = read(COMPONENTS[1] ?? "");
    assert.match(details, /const bounded = \(value: unknown, max: number\): string => boundedAiText\(value, max\)\.text\.trim\(\);/);
    for (const field of ["view.cible.nom", "view.cible.titre", "view.cible.mode", "view.ia.model"]) assert.ok(details.includes(`bounded(${field},`), field);
  });

  it("avis du mode Simple : ni [Voir les équipes] ni équipe (Q5, option b) ; rien en mode Avancé", () => {
    const source = read("web/pages/chat/delegation/DelegationNotice.tsx").replace(/\/\/.*$/gm, "");
    assert.ok(!/équipe/i.test(source));
    assert.match(source, /if \(advanced \|\| !ID_RE\.test\(rootId\)\) return null;/);
    assert.match(read("web/pages/chat/delegation/DelegationDetails.tsx"), /if \(!advanced\) return null;/, "carte détaillée : mode Avancé seulement");
  });

  it("« Arrêter » visible dès que l'arbre travaille (§4.8.1 l.716) : saisie reliée à l'activité de l'arbre (T2, L5b)", () => {
    assert.match(read("web/pages/chat/Composer.tsx"), /\{busy \|\| stopVisible \? \(/);
    const chat = read("web/pages/ChatPage.tsx");
    assert.match(chat, /stopVisible=\{Boolean\(sessionId\) && treeWorking\}/);
    assert.match(chat, /onTreeWorking=\{onTreeWorking\}/);
    assert.match(read("web/pages/chat/activity/ActivityRegion.tsx"), /useEffect\(\(\) => onTreeWorking\(working\), \[working, onTreeWorking\]\);/);
  });
});
