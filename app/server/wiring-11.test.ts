// Tests de cadre du câblage 1.1 (plan d'exécution §2.2, §2.6, §4.4, §4.7 ; T0) : ordre figé vérifié avec des modules factices,
// ports neutres (= 1.0.4), porte I1, route du Diagnostic, salle coupée (D-10), motifs d'identifiants, propriétaires des squelettes.
// Le harnais T1 n'existe pas encore : createApp est monté avec des dépendances minimales, sans réseau (app.request).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { emitCockpit } from "./cockpit-events.ts";
import {
  type Cockpit11Deps,
  type Cockpit11Module,
  type HookStep,
  type ModuleName,
  type PortName,
  PortUnavailableError,
  type ProxyContext,
  type Registrar,
} from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { createApp } from "./http.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import { sessionValue } from "./security.ts";
import { SettingsStore } from "./settings.ts";
import { ID, ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import type { StudioService } from "./studio.ts";
import { ACTIVATION_OUVERTE, buildCockpit11, type Cockpit11Wiring, MODULE_ORDER, MODULES, NEUTRAL_PORTS, STEP_ORDER } from "./wiring-11.ts";

/** Jeton de test généré à chaque exécution, jamais imprimé. */
const TOKEN = crypto.randomBytes(36).toString("base64url");

function testEnv(autonomy: boolean): AppEnv {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    allowedHosts: ["127.0.0.1"],
    dataDir: "/data",
    archiveDir: "/archives",
    workspaceDir: "/workspace",
    opencodeWorkspaceDir: "/workspace",
    opencodeConfigDir: "/oc-config",
    opencodeDataDir: "/oc-data",
    controlDir: "/control",
    certsDir: "/certs",
    webDir: path.join(import.meta.dirname, "interface-absente"),
    opencodeUrl: "http://opencode:4096",
    opencodeUsername: "opencode",
    opencodePassword: crypto.randomBytes(18).toString("base64url"),
    tlsInsecure: false,
    projectConfig: false,
    githubEnterpriseDomain: null,
    allowedProviders: ["github-copilot"],
    copilotApiUrl: null,
    autonomy,
    version: "test",
  };
}

const stub = <T>(): T => ({}) as T;

function setup(options: { autonomy?: boolean; classifierError?: Error } = {}) {
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  const warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  const log: Logger = { ...createLogger("error"), warn: (message, fields) => void warnings.push({ message, fields }) };
  const classifier = { calls: 0 };
  const studio = {
    ensureClassifierAgent: async () => {
      classifier.calls++;
      if (options.classifierError) throw options.classifierError;
    },
  } as unknown as StudioService;
  const env = testEnv(options.autonomy ?? true);
  const hub = new EventHub();
  const deps: Cockpit11Deps = {
    env,
    log,
    db,
    client: stub(),
    hub,
    settings,
    sessions: stub(),
    ledger: stub(),
    archive: stub(),
    lookup: stub(),
    catalog: stub(),
    tiers: stub(),
    projects: stub(),
    control: stub(),
    configQueue: stub(),
    copilotConfig: stub(),
    studio,
    gate: stub(),
    occupancy: async () => "idle",
  };
  return { db, settings, warnings, classifier, deps };
}

/** createApp avec des dépendances minimales et les routes 1.1 rendues par le câblage. */
function mount(s: ReturnType<typeof setup>, routes: ReadonlyArray<(app: Hono) => void>) {
  const secret = crypto.randomBytes(32).toString("base64url");
  s.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', ?, ?)").run(secret, Date.now());
  const app = createApp({
    env: s.deps.env,
    log: s.deps.log,
    db: s.db,
    settings: s.settings,
    hub: s.deps.hub,
    studio: s.deps.studio,
    client: stub(),
    catalog: stub(),
    ledger: stub(),
    archive: stub(),
    classifier: stub(),
    projects: stub(),
    control: stub(),
    quota: stub(),
    processor: stub(),
    lookup: stub(),
    tiers: stub(),
    assistants: stub(),
    copilot: stub(),
    copilotConfig: stub(),
    routes: [...routes],
  });
  const host = "127.0.0.1:7777";
  const cookie = `cockpit_session=${sessionValue(TOKEN, secret)}`;
  const request = (method: string, pathname: string, headers: Record<string, string>, body?: string) =>
    app.request(pathname, { method, headers: { host, ...headers }, ...(body === undefined ? {} : { body }) });
  return {
    request,
    authed: { cookie },
    mutating: { cookie, "x-cockpit-csrf": "1", "content-type": "application/json", origin: `http://${host}` },
  };
}

const ROOT = "ses_racine";
const ctx = {} as ProxyContext;

/**
 * Ports neutres : comportement 1.0.4 (aucune action 1.1, codes « a-venir »). `livres` : ports dont le module réel est fusionné,
 * vérifiés par leurs propres tests (ils lisent des dépendances que setup() ne fournit pas).
 */
async function assertNeutralPorts(wiring: Cockpit11Wiring, s: ReturnType<typeof setup>, autonomy = true, livres: readonly PortName[] = []) {
  const p = wiring.c11.ports;
  if (!livres.includes("stopTree")) await assert.rejects(p.stopTree.run(ROOT, "vous"), PortUnavailableError);
  if (!livres.includes("taskGuard")) {
    assert.equal(await p.taskGuard.details(ROOT, "per_1"), null);
    await assert.rejects(p.taskGuard.collectDelegationFacts({ rootId: ROOT, sessionId: ROOT, permissionId: "per_1", directory: null }), PortUnavailableError);
  }
  assert.deepEqual(p.delegationWatch, {});
  if (!livres.includes("floors")) {
    assert.equal(await p.floors.verified(ROOT), false);
    await assert.rejects(p.floors.createWithFloor("CONVERSATION", { directory: "/workspace/app" }), PortUnavailableError);
  }
  if (!livres.includes("facts")) {
    p.facts.append([{ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { cause: "arret" }, at: 1 }]);
    assert.deepEqual(p.facts.since(ROOT, 0), { facts: [], partial: false });
    assert.equal(p.facts.work.markDelegation({ rootId: ROOT, parentSessionId: ROOT, callId: "call_1", agent: "explore" }, "travaille", null), false);
    assert.equal(p.facts.work.markWait({ permissionId: "per_1", sessionId: ROOT, rootId: ROOT, permission: "edit" }, "once", "vous"), false);
  }
  const caps = s.settings.get().budget.autonomie;
  const automatic = autonomy ? "a-venir" : "autonomie-coupee";
  if (!livres.includes("conversationAutonomy")) {
    assert.deepEqual(await p.conversationAutonomy.get(ROOT), {
      rootId: ROOT,
      choix: "demander",
      plafonds: {
        plafondUsd: caps.plafondUsd,
        actionsMax: caps.actionsMax,
        delegationsMax: caps.delegationsMax,
        dureeMinutes: caps.dureeMinutes,
        fichiersMax: caps.fichiersMax,
        controlesIaMax: caps.controlesIaMax,
      },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: autonomy,
      disponibles: [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: automatic },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: automatic },
      ],
      demande: null,
    });
    assert.equal(p.conversationAutonomy.choiceOf(ROOT), "demander");
    assert.deepEqual(await p.conversationAutonomy.put(ROOT, { choix: "autonome" }, { confirmed: true }), {
      ok: false,
      status: 409,
      error: "autonomie-indisponible",
      raison: "a-venir",
    });
  }
  assert.deepEqual(p.plans, {});
  assert.equal(p.autonomy.examining(), false);
  assert.equal(p.requests.current(ROOT), null);
  assert.equal(p.requests.spent("req_1"), 0);
  assert.equal(p.requests.interrupt(ROOT, "interrompue"), undefined);
  // L10d, porte I1 basculée : module réel → la porte est ouverte, le relevé est tenté sur ce client factice et l'assistant
  // n'est pas jugé conforme (« regle-allow », contrôlé par autonomy-activation.test.ts) ; port neutre → « a-venir ».
  const activation = livres.includes("activation") ? "regle-allow" : "a-venir";
  assert.deepEqual(await p.activation.check({ rootId: ROOT, choix: "autonome", agent: "build", directory: "/workspace/app" }), { ok: false, raison: activation });
  // L10e : module réel → les faits de la délégation ne se lisent pas sur ce client factice, la demande attend sans qu'aucun refus
  // parte (X-illisible, contrôlé par autonomy-delegation.test.ts) ; port neutre → attente sans règle.
  const delegation = livres.includes("delegationPolicy") ? "X-illisible" : null;
  assert.deepEqual(await p.delegationPolicy.decide({ rootId: ROOT, sessionId: ROOT, permissionId: "per_1", directory: null, mode: "simple" }), {
    verdict: "attente",
    regle: delegation,
  });
  assert.deepEqual(p.capWatch, {});
  const judge = await p.controlAi.judge({ rootId: ROOT, sessionId: ROOT, requestId: null, command: "jq . a.json", head: "jq", relativeDir: ".", directory: null });
  // L11b : module réel → sans demande autonome, l'IA de contrôle n'est pas consultée (« desactive », aucun appel, contrôlé par
  // control-ai.test.ts) ; port neutre → « a-venir ».
  assert.deepEqual(judge, { decision: "indisponible", raison: livres.includes("controlAi") ? "desactive" : "a-venir" });
  // L1g : module réel installé → agent suivi, en attente du premier ensureAll ; port neutre → « non suivi ». L11b : le module réel
  // suit aussi cockpit-controle.
  const suivi = wiring.modules.includes("internalAgents") ? "en-attente" : "non-suivi";
  const controle = wiring.modules.includes("internalAgents") ? [{ nom: "cockpit-controle", etat: "en-attente", prochainEssai: null }] : [];
  assert.deepEqual(p.internalAgents.status(), [{ nom: "cockpit-classifier", etat: suivi, prochainEssai: null }, ...controle]);
  // L1f : module réel → le client factice ne répond à rien : relevés impossibles, dits par le bandeau « illisible » (train it1 V4) ;
  // port neutre → aucun bandeau.
  const illisible = wiring.modules.includes("diagnostics") ? [{ code: "illisible", noms: ["configuration", "arriere-plan", "agents"] }] : [];
  assert.deepEqual(await p.diagnostics.delegation(), illisible);
  assert.equal(wiring.c11.reloadBusy(), false);
  // Porte I1 basculée au train de la vague 3 (it2) : le cadre porte désormais true, y compris sans aucun module.
  assert.equal(wiring.c11.activationOuverte, true);
}

function assertNoRegistration(wiring: Cockpit11Wiring) {
  for (const step of Object.keys(wiring.hooks) as HookStep[]) assert.deepEqual(wiring.hooks[step], [], step);
  assert.deepEqual(wiring.derivations, []);
  assert.deepEqual(wiring.subscriptions, []);
  assert.deepEqual(wiring.startup, []);
}

describe("câblage 1.1 : ordre figé", () => {
  // Porte I1 : basculée à true au train de la vague 3 de l'itération 2 (plan §2.6), après vérification de ses conditions.
  // Tant qu'elle valait false, le port d'activation réel répondait comme le port neutre et n'inscrivait aucun crochet.
  it("porte I1 : ACTIVATION_OUVERTE vaut true depuis la bascule du train de la vague 3", () => {
    assert.equal(ACTIVATION_OUVERTE, true);
  });

  // Exactitude des commentaires après la bascule (défaut relevé par la répétition générale de l'itération 2) : plus aucune source
  // du serveur ne peut écrire que la constante « vaut » ou « reste » false. Les tournures conditionnelles, comme « tant
  // qu'ACTIVATION_OUVERTE est fausse », restent permises : elles décrivent la branche fermée, que la fabrique tient toujours.
  it("porte I1 : aucune source du serveur ne donne encore ACTIVATION_OUVERTE pour false", () => {
    const perime = /ACTIVATION_OUVERTE`?\s+(?:vaut|reste|restait|est passée? à)\s+`?(?:false|faux|fausse)/i;
    const fichiers = fs.readdirSync(import.meta.dirname, { encoding: "utf8", recursive: true }).filter((nom) => nom.endsWith(".ts"));
    assert.ok(fichiers.length > 100, `sources parcourues : ${fichiers.length}`);
    for (const nom of fichiers) {
      const trouve = perime.exec(fs.readFileSync(path.join(import.meta.dirname, nom), "utf8"))?.[0];
      assert.equal(trouve, undefined, `${nom} : « ${trouve ?? ""} », alors que la constante vaut true depuis la bascule de la vague 3`);
    }
  });

  it("MODULE_ORDER et STEP_ORDER : ordre du plan §4.4", () => {
    assert.deepEqual(MODULE_ORDER, [
      "gate",
      "floors",
      "facts",
      "conversationAutonomy",
      "plans",
      "activation",
      "requests",
      "taskGuard",
      "delegationWatch",
      "stopTree",
      "autonomy",
      "delegationPolicy",
      "controlAi",
      "capWatch",
      "internalAgents",
      "diagnostics",
    ]);
    assert.deepEqual(STEP_ORDER, {
      hooks: {
        createSession: ["floors"],
        sessionCreated: ["floors"],
        beforeBilledSend: ["floors", "plans", "activation", "requests"],
        beforeOnceRelay: ["taskGuard"],
        abort: ["stopTree"],
      },
      derivations: ["gate", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch"],
      hub: [
        ["delegationWatch", "usage.updated"],
        ["autonomy", "opencode.connection"],
        ["capWatch", "usage.updated"],
      ],
      startup: ["conversationAutonomy", "internalAgents", "capWatch"],
      routes: [
        ["conversations", "stopTree"],
        ["delegations", "taskGuard"],
        ["activity", "facts"],
        ["autonomy", "conversationAutonomy"],
        ["plans", "plans"],
        ["diagnostic-11", "diagnostics"],
      ],
    });
  });

  it("MODULES et NEUTRAL_PORTS : un module réel par nom, un port neutre par module sauf gate", () => {
    assert.deepEqual(Object.keys(MODULES), [...MODULE_ORDER]);
    for (const name of MODULE_ORDER) assert.equal(MODULES[name].name, name);
    assert.deepEqual(Object.keys(NEUTRAL_PORTS).sort(), MODULE_ORDER.filter((name) => name !== "gate").sort());
  });

  it("modules factices : crochets, dérivations, abonnements, démarrage et routes rangés par STEP_ORDER", async () => {
    const s = setup();
    const trace: string[] = [];
    const hook = (name: ModuleName) => async () => {
      trace.push(name);
      return null;
    };
    const derivation = (name: ModuleName) => ({ name, onEvent: () => void trace.push(name) });
    const factices: Cockpit11Module[] = [
      { name: "gate", install: (reg) => reg.derivation(derivation("gate")) },
      {
        name: "floors",
        install: (reg) => {
          reg.hook("beforeBilledSend", hook("floors"));
          reg.hook("sessionCreated", hook("floors"));
          reg.hook("createSession", hook("floors"));
        },
      },
      {
        name: "facts",
        install: (reg) => {
          reg.routes("activity", () => void trace.push("activity"));
          reg.derivation(derivation("facts"));
        },
      },
      {
        name: "conversationAutonomy",
        install: (reg) => {
          reg.routes("autonomy", () => void trace.push("autonomy"));
          reg.startup(async () => void trace.push("conversationAutonomy"));
        },
      },
      {
        name: "plans",
        install: (reg) => {
          reg.routes("plans", () => void trace.push("plans"));
          reg.hook("beforeBilledSend", hook("plans"));
        },
      },
      { name: "activation", install: (reg) => reg.hook("beforeBilledSend", hook("activation")) },
      { name: "requests", install: (reg) => reg.hook("beforeBilledSend", hook("requests")) },
      {
        name: "taskGuard",
        install: (reg) => {
          reg.routes("delegations", () => void trace.push("delegations"));
          reg.derivation(derivation("taskGuard"));
          reg.hook("beforeOnceRelay", hook("taskGuard"));
        },
      },
      {
        name: "delegationWatch",
        install: (reg) => {
          reg.hub("usage.updated", () => void trace.push("delegationWatch:usage.updated"));
          reg.derivation(derivation("delegationWatch"));
        },
      },
      {
        name: "stopTree",
        install: (reg) => {
          reg.routes("conversations", () => void trace.push("conversations"));
          reg.hook("abort", hook("stopTree"));
        },
      },
      {
        name: "autonomy",
        install: (reg) => {
          reg.hub("opencode.connection", () => void trace.push("autonomy:opencode.connection"));
          reg.derivation(derivation("autonomy"));
        },
      },
      { name: "delegationPolicy", install: () => undefined },
      { name: "controlAi", install: () => undefined },
      {
        name: "capWatch",
        install: (reg) => {
          reg.startup(async () => void trace.push("capWatch"));
          reg.hub("usage.updated", () => void trace.push("capWatch:usage.updated"));
          reg.derivation(derivation("capWatch"));
        },
      },
      { name: "internalAgents", install: (reg) => reg.startup(async () => void trace.push("internalAgents")) },
      { name: "diagnostics", install: (reg) => reg.routes("diagnostic-11", () => void trace.push("diagnostic-11")) },
    ];
    const wiring = buildCockpit11(s.deps, { modules: [...factices].reverse() });
    assert.deepEqual(wiring.modules, [...MODULE_ORDER]);

    const run = async (fn: () => Promise<unknown> | unknown) => {
      trace.length = 0;
      await fn();
      return [...trace];
    };
    assert.deepEqual(await run(() => wiring.runHooks("createSession", ctx)), ["floors"]);
    assert.deepEqual(await run(() => wiring.runHooks("sessionCreated", ctx, {})), ["floors"]);
    assert.deepEqual(await run(() => wiring.runHooks("beforeBilledSend", ctx)), ["floors", "plans", "activation", "requests"]);
    assert.deepEqual(await run(() => wiring.runHooks("beforeOnceRelay", ctx, "per_1")), ["taskGuard"]);
    assert.deepEqual(await run(() => wiring.runHooks("abort", ctx, ROOT)), ["stopTree"]);
    const event = { payload: { type: "permission.replied", properties: {} } };
    assert.deepEqual(await run(() => wiring.derivations.forEach((d) => d.onEvent(event))), ["gate", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch"]);
    assert.deepEqual(
      await run(() => wiring.subscriptions.forEach((sub) => (sub.fn as (data: unknown) => void)({}))),
      ["delegationWatch:usage.updated", "autonomy:opencode.connection", "capWatch:usage.updated"],
    );
    assert.deepEqual(wiring.subscriptions.map((sub) => sub.type), ["usage.updated", "opencode.connection", "usage.updated"]);
    assert.deepEqual(
      await run(async () => {
        for (const start of wiring.startup) await start();
      }),
      ["conversationAutonomy", "internalAgents", "capWatch"],
    );
    assert.deepEqual(
      await run(() => wiring.routes.forEach((register) => register(stub<Hono>()))),
      ["conversations", "delegations", "activity", "autonomy", "plans", "diagnostic-11"],
    );
    assert.deepEqual(
      wiring.registrations.filter((r) => r.kind === "hook").map((r) => `${r.key}/${r.module}`),
      [
        "createSession/floors",
        "sessionCreated/floors",
        "beforeBilledSend/floors",
        "beforeBilledSend/plans",
        "beforeBilledSend/activation",
        "beforeBilledSend/requests",
        "beforeOnceRelay/taskGuard",
        "abort/stopTree",
      ],
    );
  });

  it("couple absent de STEP_ORDER : le câblage échoue", () => {
    const s = setup();
    const refused: Cockpit11Module[] = [
      { name: "plans", install: (reg) => reg.hook("abort", async () => null) },
      { name: "floors", install: (reg) => reg.hook("beforeOnceRelay", async () => null) },
      { name: "floors", install: (reg) => reg.hook("etape-inconnue" as HookStep, async () => null) },
      { name: "floors", install: (reg) => reg.derivation({ name: "floors", onEvent: () => undefined }) },
      { name: "autonomy", install: (reg) => reg.hub("usage.updated", () => undefined) },
      { name: "facts", install: (reg) => reg.startup(async () => undefined) },
      { name: "plans", install: (reg) => reg.routes("activity", () => undefined) },
    ];
    for (const module of refused) {
      assert.throws(() => buildCockpit11(s.deps, { modules: [module] }), /couple non prévu dans STEP_ORDER/, String(module.install));
    }
  });

  it("module inconnu, déclaré deux fois ou inscription hors installation : le câblage échoue", () => {
    const s = setup();
    assert.throws(() => buildCockpit11(s.deps, { modules: ["equipes" as ModuleName] }), /module inconnu \(equipes\)/);
    assert.throws(() => buildCockpit11(s.deps, { modules: [{ name: "equipes" as ModuleName, install: () => undefined }] }), /module inconnu/);
    assert.throws(() => buildCockpit11(s.deps, { modules: ["floors", { name: "floors", install: () => undefined }] }), /déclaré deux fois \(floors\)/);
    let kept: Registrar | null = null;
    buildCockpit11(s.deps, {
      modules: [
        {
          name: "capWatch",
          install: (reg) => {
            kept = reg;
          },
        },
      ],
    });
    assert.throws(() => (kept as Registrar | null)?.startup(async () => undefined), /hors de l'installation/);
  });
});

describe("câblage 1.1 : ports neutres", () => {
  it("modules: [] : aucun crochet, dérivation, abonnement, démarrage ni route ; ports neutres", async () => {
    const s = setup();
    const wiring = buildCockpit11(s.deps, { modules: [] });
    assert.deepEqual(wiring.modules, []);
    assert.deepEqual(wiring.registrations, []);
    assertNoRegistration(wiring);
    assert.deepEqual(wiring.routes, []);
    assert.equal(await wiring.runHooks("abort", ctx, ROOT), null);
    await assertNeutralPorts(wiring, s);
    const off = setup({ autonomy: false });
    await assertNeutralPorts(buildCockpit11(off.deps, { modules: [] }), off, false);
  });

  it("production (tous les modules réels) : modules livrés en V2 inscrits (L1c stopTree, L3 plancher, L6a choix d'autonomie, L4b faits), garde du « task once » (L1d), surveillance des délégations (L1e), plans (L6b), demandes et cycle d'autonomie (L10a), plafonds et redémarrages (L10c), délégation en Autonome (L10e), route du Diagnostic ; squelettes T0 restants neutres", async () => {
    const s = setup();
    const wiring = buildCockpit11(s.deps);
    assert.deepEqual(wiring.modules, [...MODULE_ORDER]);
    assert.deepEqual(wiring.registrations, [
      { kind: "hook", key: "createSession", module: "floors" },
      { kind: "hook", key: "sessionCreated", module: "floors" },
      { kind: "hook", key: "beforeBilledSend", module: "floors" },
      { kind: "hook", key: "beforeBilledSend", module: "plans" },
      // L10d : porte I1 basculée au train de la vague 3 (it2) → le crochet d'activation s'inscrit, entre « plans » et « requests ».
      { kind: "hook", key: "beforeBilledSend", module: "activation" },
      // L10a : la demande autonome s'ouvre à l'envoi, après l'activation (rang « requests » de STEP_ORDER).
      { kind: "hook", key: "beforeBilledSend", module: "requests" },
      { kind: "hook", key: "beforeOnceRelay", module: "taskGuard" },
      { kind: "hook", key: "abort", module: "stopTree" },
      { kind: "derivation", key: "facts", module: "facts" },
      { kind: "derivation", key: "taskGuard", module: "taskGuard" },
      // L1e : surveillance des délégations lancées sans demande (dérivation et abonnement usage.updated), port toujours vide.
      { kind: "derivation", key: "delegationWatch", module: "delegationWatch" },
      // L10a : cycle d'une décision (dérivation permission.asked) et relecture de GET /permission à la reconnexion d'opencode.
      { kind: "derivation", key: "autonomy", module: "autonomy" },
      // L10c : plafonds, « Passé sans contrôle » et redémarrages d'opencode (dérivation, abonnement usage.updated, reprise).
      { kind: "derivation", key: "capWatch", module: "capWatch" },
      { kind: "hub", key: "usage.updated", module: "delegationWatch" },
      { kind: "hub", key: "opencode.connection", module: "autonomy" },
      { kind: "hub", key: "usage.updated", module: "capWatch" },
      { kind: "startup", key: "startup", module: "conversationAutonomy" },
      { kind: "startup", key: "startup", module: "capWatch" },
      { kind: "routes", key: "conversations", module: "stopTree" },
      { kind: "routes", key: "delegations", module: "taskGuard" },
      { kind: "routes", key: "activity", module: "facts" },
      { kind: "routes", key: "autonomy", module: "conversationAutonomy" },
      { kind: "routes", key: "plans", module: "plans" },
      { kind: "routes", key: "diagnostic-11", module: "diagnostics" },
    ]);
    assert.deepEqual(
      [
        wiring.hooks.createSession.length,
        wiring.hooks.sessionCreated.length,
        wiring.hooks.beforeBilledSend.length,
        wiring.hooks.beforeOnceRelay.length,
        wiring.hooks.abort.length,
      ],
      // beforeBilledSend : 4 depuis la bascule de la porte I1 (floors, plans, activation, requests).
      [1, 1, 4, 1, 1],
    );
    assert.deepEqual(wiring.subscriptions.map((sub) => sub.type), ["usage.updated", "opencode.connection", "usage.updated"]);
    assert.equal(wiring.derivations.length, 5);
    assert.equal(wiring.startup.length, 2);
    assert.equal(wiring.routes.length, 6);
    // Ports réels de L6a (le neutre répondrait 409) et de L4b (le neutre n'écrit rien) ; leur comportement est contrôlé par
    // conversation-autonomy.test.ts et fact-store.test.ts.
    assert.deepEqual(await wiring.c11.ports.conversationAutonomy.put(ROOT, { choix: "omo" } as never, { confirmed: true }), {
      ok: false,
      status: 400,
      error: "invalid",
      raison: null,
    });
    wiring.c11.ports.facts.append([{ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 1 }]);
    assert.equal(wiring.c11.ports.facts.since(ROOT, 0).facts.length, 1);
    // L11b et L10e : ports réels de l'IA de contrôle et de la délégation en Autonome (aucune inscription).
    // L10d : porte I1 basculée au train de la vague 3 (it2), le port d'activation réel n'est donc plus inerte.
    await assertNeutralPorts(wiring, s, true, ["stopTree", "floors", "conversationAutonomy", "facts", "taskGuard", "controlAi", "delegationPolicy", "activation"]);
  });

  it("surcharge de ports : l'emporte sur le module installé ; reloadBusy suit ports.autonomy.examining", async () => {
    const s = setup();
    const activationOk: Cockpit11Module = {
      name: "activation",
      install: (_reg, c11) => {
        c11.ports.activation = { check: async () => ({ ok: true }) };
      },
    };
    const installed = buildCockpit11(s.deps, { modules: [activationOk] });
    assert.deepEqual(await installed.c11.ports.activation.check({ rootId: ROOT, choix: "modifications", agent: null, directory: null }), { ok: true });
    const overridden = buildCockpit11(s.deps, {
      modules: [activationOk],
      ports: { activation: { check: async () => ({ ok: false, raison: "regle-allow" }) } },
    });
    assert.deepEqual(await overridden.c11.ports.activation.check({ rootId: ROOT, choix: "modifications", agent: null, directory: null }), {
      ok: false,
      raison: "regle-allow",
    });

    let examining = false;
    const autonomy: Cockpit11Module = {
      name: "autonomy",
      install: (_reg, c11) => {
        c11.ports.autonomy = { examining: () => examining };
      },
    };
    const byModule = buildCockpit11(s.deps, { modules: [autonomy] });
    assert.equal(byModule.c11.reloadBusy(), false);
    examining = true;
    assert.equal(byModule.c11.reloadBusy(), true);
    assert.equal(buildCockpit11(s.deps, { modules: [], ports: { autonomy: { examining: () => true } } }).c11.reloadBusy(), true);
  });

  it("runHooks : la première Response l'emporte, les crochets suivants ne sont pas appelés ; null continue", async () => {
    const s = setup();
    const trace: string[] = [];
    let plansAnswer: Response | null = new Response(null, { status: 409 });
    const module = (name: ModuleName, answer: () => Response | null): Cockpit11Module => ({
      name,
      install: (reg) =>
        reg.hook("beforeBilledSend", async () => {
          trace.push(name);
          return answer();
        }),
    });
    const wiring = buildCockpit11(s.deps, {
      modules: [module("requests", () => null), module("activation", () => null), module("plans", () => plansAnswer), module("floors", () => null)],
    });
    assert.equal((await wiring.runHooks("beforeBilledSend", ctx))?.status, 409);
    assert.deepEqual(trace, ["floors", "plans"]);
    trace.length = 0;
    plansAnswer = null;
    assert.equal(await wiring.runHooks("beforeBilledSend", ctx), null);
    assert.deepEqual(trace, ["floors", "plans", "activation", "requests"]);
  });

  it("internalAgents neutre : agent de classement installé, erreur journalisée comme au démarrage de la 1.0.4", async () => {
    const ok = setup();
    await buildCockpit11(ok.deps, { modules: [] }).c11.ports.internalAgents.ensureAll();
    assert.equal(ok.classifier.calls, 1);
    assert.deepEqual(ok.warnings, []);
    const failing = setup({ classifierError: new Error("écriture refusée") });
    assert.equal(await buildCockpit11(failing.deps, { modules: [] }).c11.ports.internalAgents.ensureAll(), undefined);
    assert.equal(failing.classifier.calls, 1);
    assert.deepEqual(failing.warnings, [{ message: "agent de classement non installé", fields: { error: "écriture refusée" } }]);
  });
});

describe("câblage 1.1 : routes et cadre", () => {
  it("GET /api/diagnostic/activite : montée par le module diagnostics, lit les ports ; absente sans lui", async () => {
    const s = setup();
    const { request, authed } = mount(s, buildCockpit11(s.deps).routes);
    const res = await request("GET", "/api/diagnostic/activite", authed);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      // L1f : client factice sans réponse → relevés impossibles, bandeau « illisible » (train it1 V4).
      delegation: [{ code: "illisible", noms: ["configuration", "arriere-plan", "agents"] }],
      // L1g : module réel des agents internes, aucun ensureAll encore ; L11b : cockpit-controle suivi aussi.
      agentsInternes: [
        { nom: "cockpit-classifier", etat: "en-attente", prochainEssai: null },
        { nom: "cockpit-controle", etat: "en-attente", prochainEssai: null },
      ],
      interrupteur: true,
      controleIa: s.settings.get().budget.autonomie.controleIa,
      // Porte I1 basculée au train de la vague 3 (it2) : le Diagnostic la dit ouverte.
      activationOuverte: true,
    });
    assert.equal((await request("GET", "/api/diagnostic/activite", {})).status, 401);
    const bare = setup();
    const withoutModule = mount(bare, buildCockpit11(bare.deps, { modules: [] }).routes);
    assert.equal((await withoutModule.request("GET", "/api/diagnostic/activite", withoutModule.authed)).status, 404);
  });

  it("salle coupée (D-10) : POST /api/omo/rooms avec cookie et en-têtes anti-CSRF → 404 ; compose sans opencode-omo", async () => {
    const s = setup();
    const { request, mutating } = mount(s, buildCockpit11(s.deps).routes);
    const body = JSON.stringify({ projet: "/workspace/app" });
    // 404 tant que la salle n'existe pas ; 403 attendu en L18 (spécification §7.1).
    const res = await request("POST", "/api/omo/rooms", { ...mutating, "x-cockpit-confirm": "1" }, body);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "not-found");
    // Les en-têtes passent bien la garde anti-CSRF : sans eux, refus avant la route.
    const { "x-cockpit-csrf": _csrf, ...withoutCsrf } = mutating;
    assert.equal((await request("POST", "/api/omo/rooms", withoutCsrf, body)).status, 403);

    const composeText = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docker-compose.yml"), "utf8");
    const compose = parseYaml(composeText) as { services: Record<string, unknown> };
    assert.ok(Object.keys(compose.services).includes("cockpit"));
    assert.equal(Object.keys(compose.services).includes("opencode-omo"), false);
    assert.equal(composeText.includes("opencode-omo"), false);
  });

  it("shared/ids.ts : mêmes motifs que http.ts (tant que http.ts garde sa copie locale)", () => {
    const http = fs.readFileSync(path.join(import.meta.dirname, "http.ts"), "utf8");
    const localId = /^const ID = "([^"]+)";$/m.exec(http);
    const localSession = /^const SESSION_ID_RE = \/(.+)\/([a-z]*);$/m.exec(http);
    if (localId === null && localSession === null) {
      // L1a-1 : copie locale supprimée, http.ts importe les motifs partagés.
      assert.match(http, /from "\.\/shared\/ids\.ts"/);
      return;
    }
    assert.ok(localId && localSession, "ID et SESSION_ID_RE doivent quitter http.ts ensemble");
    assert.equal(ID, localId[1]);
    assert.match(http, /^const ID_RE = new RegExp\(`\^\$\{ID\}\$`\);$/m);
    assert.equal(ID_RE.source, new RegExp(`^${localId[1]}$`).source);
    assert.equal(ID_RE.flags, "");
    assert.equal(SESSION_ID_RE.source, localSession[1]);
    assert.equal(SESSION_ID_RE.flags, localSession[2]);
  });

  it("squelettes : « Propriétaire : Lxx » en première ligne", () => {
    const owners: Record<string, string> = {
      "stop-tree.ts": "L1c",
      "routes-conversations.ts": "L1c",
      "task-once-guard.ts": "L1d",
      "routes-delegations.ts": "L1d",
      "delegation-watch.ts": "L1e",
      "session-floor-service.ts": "L3",
      "fact-store.ts": "L4b",
      "activity-deriver.ts": "L4b",
      "routes-activity.ts": "L4b",
      "conversation-autonomy.ts": "L6a",
      "routes-autonomy.ts": "L6a puis L10d",
      "plans.ts": "L6b",
      "routes-plans.ts": "L6b",
      "autonomy.ts": "L10a",
      "autonomy-requests.ts": "L10a",
      "autonomy-activation.ts": "L10d",
      "autonomy-watch.ts": "L10c",
      "autonomy-delegation.ts": "L10e",
      "control-ai.ts": "L11b",
      "internal-agents.ts": "L1g (classifieur) puis L11b (cockpit-controle)",
      "diagnostics-11.ts": "L1f",
    };
    for (const [file, owner] of Object.entries(owners)) {
      const firstLine = fs.readFileSync(path.join(import.meta.dirname, file), "utf8").split("\n")[0] ?? "";
      assert.equal(firstLine.replace(/\r$/, ""), `// Propriétaire : ${owner}.`, file);
    }
  });

  it("emitCockpit : publie l'événement 1.1 sur le hub", () => {
    const hub = new EventHub();
    const received: BrowserEvent[] = [];
    hub.subscribe((event) => void received.push(event));
    emitCockpit(hub, "delegation.plafond", { rootId: ROOT, kind: "cout" });
    assert.deepEqual(received, [{ kind: "cockpit", type: "delegation.plafond", data: { rootId: ROOT, kind: "cout" } }]);
  });
});
