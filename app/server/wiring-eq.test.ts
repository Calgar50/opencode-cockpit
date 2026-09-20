// Tests de cadre du câblage des équipes (plan d'exécution it4 §2.6, §4.1.3, §4.1.6 ; T4) : constantes d'ouverture et d'injection,
// ordre figé vérifié avec des modules factices, couples refusés, ports neutres, décorateur de stopTree posé seulement avec
// teamGuards (D-eq-05), c11.reloadBusy composé par apply seulement avec teamRunner et une seule fois (D-eq-06), verrou neutre,
// propriétaires des squelettes, emitEquipe.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Hono } from "hono";
import { type Cockpit11, PortUnavailableError, type StopTreePort } from "./contracts-11.ts";
import {
  type EqDeps,
  type EqModule,
  type EqModuleName,
  type EqPortName,
  EqPortUnavailableError,
  type EqRegistrar,
  type RunPlan,
  type TeamGuardsPort,
  type TeamProxyGuardRequest,
  type TeamRow,
  type TeamRunnerPort,
} from "./contracts-eq.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import { emitEquipe } from "./team-events.ts";
import { neutralRunner } from "./team-runner.ts";
import {
  buildEquipes,
  EQ_MODULE_ORDER,
  EQ_MODULES,
  EQ_NEUTRAL_PORTS,
  EQ_STEP_ORDER,
  EQUIPES_INJECTION,
  EQUIPES_SIMPLE_OUVERTES,
  type EquipesWiring,
} from "./wiring-eq.ts";

const ROOT = "ses_racine";
const RESULT: StopResult = { rootId: ROOT, rejected: 0, aborted: [ROOT], unconfirmed: [], durationMs: 1 };

interface FakeCockpit {
  c11: Cockpit11;
  deps: EqDeps;
  warnings: string[];
  /** Décision « examen en cours » de la 1.1 (ports.autonomy.examining). */
  examining: { value: boolean };
  inner: StopTreePort;
  innerCalls: Array<[string, StopCause]>;
}

/** c11 minimal : stopTree et reloadBusy de la 1.1, journal espion ; le reste n'est pas lu par le câblage des équipes. */
function fakeCockpit(options: { innerFails?: boolean } = {}): FakeCockpit {
  const warnings: string[] = [];
  const log: Logger = { ...createLogger("error"), warn: (message) => void warnings.push(message) };
  const examining = { value: false };
  const innerCalls: Array<[string, StopCause]> = [];
  const inner: StopTreePort = {
    run: async (rootId, cause) => {
      innerCalls.push([rootId, cause]);
      if (options.innerFails) throw new PortUnavailableError("stopTree");
      return { ...RESULT, rootId };
    },
  };
  const c11 = {
    log,
    ports: { stopTree: inner, autonomy: { examining: () => examining.value } },
    reloadBusy: () => examining.value,
  } as unknown as Cockpit11;
  const deps: EqDeps = { c11, classifier: { onIdle: () => undefined }, assistants: { install: async () => ({}) as never } };
  return { c11, deps, warnings, examining, inner, innerCalls };
}

const TEAM: TeamRow = {
  id: "revue-sql",
  titre: "Revue SQL",
  description: "",
  flow: '{"version":1,"blocs":[]}',
  origine: "exemple",
  exemple_id: "revue-sql",
  exemple_version: 1,
  avance: 0,
  created_at: 1,
  updated_at: 1,
};

describe("câblage des équipes : constantes et ordre figé", () => {
  it("EQUIPES_SIMPLE_OUVERTES vaut false dans le dépôt (décision U1) ; EQUIPES_INJECTION vaut « noReply » (D-eq-14)", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.equal(EQUIPES_INJECTION, "noReply");
    // Ouverture en une ligne : la constante seule, jamais une variable d'environnement ni un réglage lu en production.
    const source = fs.readFileSync(path.join(import.meta.dirname, "wiring-eq.ts"), "utf8");
    assert.match(source, /^export const EQUIPES_SIMPLE_OUVERTES = false;$/m);
    assert.equal(/process\.env|env\.\w*[Ee]quipe/.test(source), false);
    const factory = fs.readFileSync(path.join(import.meta.dirname, "app-factory.ts"), "utf8");
    assert.equal(factory.includes("simpleOuvertes"), false, "app-factory ne transmet jamais l'ouverture des tests");
    const { deps } = fakeCockpit();
    assert.equal(buildEquipes(deps).eq.simpleOuvertes, false);
    assert.equal(buildEquipes(deps, { modules: [] }).eq.injection, "noReply");
    assert.equal(buildEquipes(deps, { modules: [], simpleOuvertes: true }).eq.simpleOuvertes, true, "surcharge réservée aux tests");
  });

  it("EQ_MODULE_ORDER et EQ_STEP_ORDER : tableau du plan it4 §4.1.3", () => {
    assert.deepEqual([...EQ_MODULE_ORDER], ["agentMap", "teams", "teamPreflight", "teamRunner", "teamGuards"]);
    assert.deepEqual(JSON.parse(JSON.stringify(EQ_STEP_ORDER)), {
      derivations: ["teamRunner", "teamGuards"],
      hub: [
        ["teamGuards", "usage.updated"],
        ["teamRunner", "opencode.connection"],
      ],
      startup: ["teamRunner"],
      routes: [
        ["agent-map", "agentMap"],
        ["teams", "teams"],
        ["team-runs", "teamRunner"],
        ["team-runs", "teamGuards"],
      ],
      proxyGuard: ["teamGuards"],
      stopTreeDecorator: ["teamGuards"],
      reloadBusy: ["teamRunner"],
    });
  });

  it("EQ_MODULES et EQ_NEUTRAL_PORTS : un module réel par nom, un port neutre par port (agentMap n'en a pas)", () => {
    assert.deepEqual(Object.keys(EQ_MODULES), [...EQ_MODULE_ORDER]);
    for (const name of EQ_MODULE_ORDER) assert.equal(EQ_MODULES[name].name, name);
    assert.deepEqual(Object.keys(EQ_NEUTRAL_PORTS), ["teams", "preflight", "runner", "guards"] satisfies EqPortName[]);
  });

  it("modules factices : dérivations, abonnements, démarrage, routes, verrou, décorateur et prédicat rangés par EQ_STEP_ORDER", async () => {
    const { deps, c11 } = fakeCockpit();
    const trace: string[] = [];
    const derivation = (name: EqModuleName) => ({ name, onEvent: () => void trace.push(name) });
    const factices: EqModule[] = [
      { name: "agentMap", install: (reg) => reg.routes("agent-map", () => void trace.push("agent-map/agentMap")) },
      { name: "teams", install: (reg) => reg.routes("teams", () => void trace.push("teams/teams")) },
      { name: "teamPreflight", install: () => undefined },
      {
        name: "teamRunner",
        install: (reg) => {
          reg.reloadBusy(() => {
            trace.push("reloadBusy/teamRunner");
            return false;
          });
          reg.routes("team-runs", () => void trace.push("team-runs/teamRunner"));
          reg.startup(async () => void trace.push("startup/teamRunner"));
          reg.hub("opencode.connection", () => void trace.push("teamRunner:opencode.connection"));
          reg.derivation(derivation("teamRunner"));
        },
      },
      {
        name: "teamGuards",
        install: (reg) => {
          reg.stopTreeDecorator((inner) => ({
            run: (rootId, cause) => {
              trace.push("stopTree/teamGuards");
              return inner.run(rootId, cause);
            },
          }));
          reg.proxyGuard(async () => {
            trace.push("proxyGuard/teamGuards");
            return null;
          });
          reg.routes("team-runs", () => void trace.push("team-runs/teamGuards"));
          reg.hub("usage.updated", () => void trace.push("teamGuards:usage.updated"));
          reg.derivation(derivation("teamGuards"));
        },
      },
    ];
    const wiring = buildEquipes(deps, { modules: [...factices].reverse() });
    assert.deepEqual(wiring.modules, [...EQ_MODULE_ORDER]);
    const run = async (fn: () => Promise<unknown> | unknown) => {
      trace.length = 0;
      await fn();
      return [...trace];
    };
    const event = { payload: { type: "session.status", properties: {} } };
    assert.deepEqual(await run(() => wiring.derivations.forEach((d) => d.onEvent(event))), ["teamRunner", "teamGuards"]);
    assert.deepEqual(
      await run(() => wiring.subscriptions.forEach((sub) => (sub.fn as (data: unknown) => void)({}))),
      ["teamGuards:usage.updated", "teamRunner:opencode.connection"],
    );
    assert.deepEqual(wiring.subscriptions.map((sub) => sub.type), ["usage.updated", "opencode.connection"]);
    assert.deepEqual(
      await run(async () => {
        for (const start of wiring.startup) await start();
      }),
      ["startup/teamRunner"],
    );
    assert.deepEqual(
      await run(() => wiring.routes.forEach((register) => register({} as Hono))),
      ["agent-map/agentMap", "teams/teams", "team-runs/teamRunner", "team-runs/teamGuards"],
    );
    const req: TeamProxyGuardRequest = { entree: "proxy", method: "GET", sub: "/session", directory: null, sessionId: null, permissionId: null };
    assert.deepEqual(await run(() => wiring.proxyGuard(req)), ["proxyGuard/teamGuards"]);
    assert.deepEqual(await run(() => wiring.stepsBusy()), ["reloadBusy/teamRunner"]);
    wiring.apply(c11);
    assert.deepEqual(await run(() => c11.ports.stopTree.run(ROOT, "vous")), ["stopTree/teamGuards"]);
    assert.deepEqual(await run(() => c11.reloadBusy()), ["reloadBusy/teamRunner"]);
    assert.deepEqual(
      wiring.registrations.map((r) => `${r.kind}:${r.key}/${r.module}`),
      [
        "derivation:teamRunner/teamRunner",
        "derivation:teamGuards/teamGuards",
        "hub:usage.updated/teamGuards",
        "hub:opencode.connection/teamRunner",
        "startup:startup/teamRunner",
        "routes:agent-map/agentMap",
        "routes:teams/teams",
        "routes:team-runs/teamRunner",
        "routes:team-runs/teamGuards",
        "proxyGuard:proxyGuard/teamGuards",
        "stopTreeDecorator:stopTreeDecorator/teamGuards",
        "reloadBusy:reloadBusy/teamRunner",
      ],
    );
  });

  it("couple absent de EQ_STEP_ORDER : le câblage échoue", () => {
    const { deps } = fakeCockpit();
    const refused: EqModule[] = [
      { name: "teams", install: (reg) => reg.derivation({ name: "teams", onEvent: () => undefined }) },
      { name: "teamRunner", install: (reg) => reg.hub("usage.updated", () => undefined) },
      { name: "teamGuards", install: (reg) => reg.hub("opencode.connection", () => undefined) },
      { name: "teamPreflight", install: (reg) => reg.startup(async () => undefined) },
      { name: "teams", install: (reg) => reg.routes("team-runs", () => undefined) },
      { name: "agentMap", install: (reg) => reg.routes("teams", () => undefined) },
      { name: "teamRunner", install: (reg) => reg.routes("agent-map", () => undefined) },
      { name: "teamRunner", install: (reg) => reg.proxyGuard(async () => null) },
      { name: "teamRunner", install: (reg) => reg.stopTreeDecorator((inner) => inner) },
      { name: "teamGuards", install: (reg) => reg.reloadBusy(() => false) },
      { name: "teams", install: (reg) => reg.routes("inconnu" as "teams", () => undefined) },
    ];
    for (const module of refused) {
      assert.throws(() => buildEquipes(deps, { modules: [module] }), /couple non prévu dans EQ_STEP_ORDER/, String(module.install));
    }
  });

  it("module inconnu, déclaré deux fois ou inscription hors installation : le câblage échoue", () => {
    const { deps } = fakeCockpit();
    assert.throws(() => buildEquipes(deps, { modules: ["salle" as EqModuleName] }), /module inconnu \(salle\)/);
    assert.throws(() => buildEquipes(deps, { modules: [{ name: "floors" as EqModuleName, install: () => undefined }] }), /module inconnu/);
    assert.throws(() => buildEquipes(deps, { modules: ["teams", { name: "teams", install: () => undefined }] }), /déclaré deux fois \(teams\)/);
    let kept: EqRegistrar | null = null;
    buildEquipes(deps, {
      modules: [
        {
          name: "teamRunner",
          install: (reg) => {
            kept = reg;
          },
        },
      ],
    });
    assert.throws(() => (kept as EqRegistrar | null)?.startup(async () => undefined), /hors de l'installation/);
  });
});

describe("câblage des équipes : ports neutres et apply", () => {
  it("modules: [] : aucune inscription ; ports neutres ; verrou neutre → null ; apply ne touche ni stopTree ni reloadBusy", async () => {
    const { deps, c11, inner } = fakeCockpit();
    const reloadBusy = c11.reloadBusy;
    const wiring = buildEquipes(deps, { modules: [] });
    assert.deepEqual(wiring.modules, []);
    assert.deepEqual(wiring.registrations, []);
    assert.deepEqual([wiring.derivations, wiring.subscriptions, wiring.startup, wiring.routes], [[], [], [], []]);
    const req: TeamProxyGuardRequest = { entree: "archive", method: "DELETE", sub: "", directory: null, sessionId: ROOT, permissionId: null };
    assert.equal(await wiring.proxyGuard(req), null);
    assert.equal(wiring.stepsBusy(), false);
    wiring.apply(c11);
    assert.equal(c11.ports.stopTree, inner, "aucun décorateur");
    assert.equal(c11.reloadBusy, reloadBusy, "aucune composition");

    const p = wiring.eq.ports;
    assert.equal(p.teams.get("revue-sql"), null);
    assert.deepEqual(await p.teams.estimate("revue-sql", { directory: "/workspace/app", rootId: null }, "avance"), { ok: false, status: 409, code: "a-venir" });
    assert.equal((await p.preflight.assistants("/workspace/app")).size, 0);
    assert.deepEqual(await p.preflight.estimate(TEAM, { directory: "/workspace/app", rootId: null }, "simple"), { ok: false, status: 409, code: "a-venir" });
    const body = { directory: "/workspace/app", rootId: null, demande: "x", fichiers: [], agentConversation: "build", estimateSha256: "0", confirmations: {} };
    assert.deepEqual(await p.preflight.check({ team: TEAM, body, mode: "avance", confirmed: false }), { ok: false, status: 409, code: "a-venir" });
    const plan = {} as RunPlan;
    assert.deepEqual(await p.preflight.recheck(plan, ROOT), { ok: false, genre: "changement", code: "a-venir" });
    await assert.rejects(p.runner.launch(plan, body), EqPortUnavailableError);
    const refusal = { ok: false, status: 409, code: "a-venir" };
    assert.deepEqual(await p.runner.continue("run", {}, false), refusal);
    assert.deepEqual(await p.runner.relaunch("run", plan), refusal);
    assert.deepEqual(p.runner.close("run"), refusal);
    assert.deepEqual(await p.runner.addResults("run"), refusal);
    assert.notEqual(p.runner.close("a"), p.runner.close("b"), "un refus neuf à chaque appel");
    assert.deepEqual(
      [p.runner.view("run"), p.runner.runsOf(ROOT), p.runner.runOfStepSession(ROOT), p.runner.activeRunOf(ROOT), p.runner.stepOf(ROOT), p.runner.stepsBusy()],
      [null, [], null, null, null, false],
    );
    assert.equal(p.runner.stopRequested(ROOT, "vous"), undefined);
    assert.equal(p.runner.stopped(ROOT, "vous", null), undefined);
    assert.equal(p.runner.interrupt("run", "rechargement"), undefined);
    assert.equal(await p.guards.proxyGuard(req), null);
    assert.equal(await p.guards.stopForCap("run"), undefined);
  });

  // Les modules réels arrivent paquet par paquet et ajoutent leurs propres inscriptions (L37a : routes « teams » ; L37b :
  // dérivation, abonnement, démarrage et routes « team-runs » du runner). Le test porte donc sur les inscriptions attendues,
  // présentes UNE fois chacune, et sur leur neutralité au repos, jamais sur l'absence des autres.
  it("production (tous les modules) : routes, verrou, décorateur, prédicat et inscriptions du runner posés une fois, neutres tant que rien ne travaille", async () => {
    const { deps, c11, innerCalls } = fakeCockpit();
    const wiring = buildEquipes(deps);
    assert.deepEqual(wiring.modules, [...EQ_MODULE_ORDER]);
    const inscriptions = wiring.registrations.map((r) => `${r.kind}/${r.key}/${r.module}`);
    for (const attendue of [
      "routes/teams/teams",
      "proxyGuard/proxyGuard/teamGuards",
      "stopTreeDecorator/stopTreeDecorator/teamGuards",
      "reloadBusy/reloadBusy/teamRunner",
      "derivation/teamRunner/teamRunner",
      "hub/opencode.connection/teamRunner",
      "startup/startup/teamRunner",
      "routes/team-runs/teamRunner",
    ]) {
      assert.equal(inscriptions.filter((entry) => entry === attendue).length, 1, `${attendue} : une seule fois`);
    }
    const req: TeamProxyGuardRequest = { entree: "proxy", method: "POST", sub: `/session/${ROOT}/prompt_async`, directory: null, sessionId: ROOT, permissionId: null };
    assert.equal(await wiring.proxyGuard(req), null);
    wiring.apply(c11);
    assert.equal(c11.reloadBusy(), false);
    assert.deepEqual(await c11.ports.stopTree.run(ROOT, "vous"), RESULT, "arrêt inchangé");
    assert.deepEqual(innerCalls, [[ROOT, "vous"]]);
  });

  it("décorateur de stopTree posé seulement si teamGuards est installé : runner prévenu avant puis après l'arrêt interne, même en échec", async () => {
    // Sans teamGuards : stopTree inchangé.
    for (const modules of [["teamRunner"], ["agentMap", "teams", "teamPreflight", "teamRunner"]] as EqModuleName[][]) {
      const bare = fakeCockpit();
      buildEquipes(bare.deps, { modules }).apply(bare.c11);
      assert.equal(bare.c11.ports.stopTree, bare.inner, modules.join(","));
    }

    const trace: string[] = [];
    const runner = (fails = false): TeamRunnerPort => ({
      ...neutralRunner(),
      stopRequested: (rootId, cause) => {
        trace.push(`stopRequested ${rootId} ${cause}`);
        if (fails) throw new Error("runner en panne");
      },
      stopped: (rootId, cause, result) => {
        trace.push(`stopped ${rootId} ${cause} ${result ? "résultat" : "null"}`);
        if (fails) throw new Error("runner en panne");
      },
    });
    const withGuards = fakeCockpit();
    buildEquipes(withGuards.deps, { modules: ["teamGuards"], ports: { runner: runner() } }).apply(withGuards.c11);
    assert.notEqual(withGuards.c11.ports.stopTree, withGuards.inner);
    const result = await withGuards.c11.ports.stopTree.run(ROOT, "equipe");
    assert.deepEqual(result, RESULT);
    assert.deepEqual(trace, [`stopRequested ${ROOT} equipe`, `stopped ${ROOT} equipe résultat`]);
    assert.deepEqual(withGuards.innerCalls, [[ROOT, "equipe"]], "arrêt interne appelé entre les deux");

    // Arrêt interne en échec : l'erreur remonte telle quelle, le runner est prévenu avec null.
    trace.length = 0;
    const failing = fakeCockpit({ innerFails: true });
    buildEquipes(failing.deps, { modules: ["teamGuards"], ports: { runner: runner() } }).apply(failing.c11);
    await assert.rejects(failing.c11.ports.stopTree.run(ROOT, "vous"), PortUnavailableError);
    assert.deepEqual(trace, [`stopRequested ${ROOT} vous`, `stopped ${ROOT} vous null`]);

    // Runner en panne : l'arrêt a lieu quand même (jamais contournable), l'erreur est journalisée.
    trace.length = 0;
    const broken = fakeCockpit();
    buildEquipes(broken.deps, { modules: ["teamGuards"], ports: { runner: runner(true) } }).apply(broken.c11);
    assert.deepEqual(await broken.c11.ports.stopTree.run(ROOT, "vous"), RESULT);
    assert.deepEqual(broken.innerCalls, [[ROOT, "vous"]]);
    assert.equal(broken.warnings.length, 2);
  });

  it("c11.reloadBusy composé par apply seulement si teamRunner est installé : étapes seules → vrai, examen seul → vrai, aucun → faux ; apply deux fois → une composition", () => {
    const busy = { value: false };
    const reads = { count: 0 };
    const runner: TeamRunnerPort = {
      ...neutralRunner(),
      stepsBusy: () => {
        reads.count++;
        return busy.value;
      },
    };
    const f = fakeCockpit();
    const original = f.c11.reloadBusy;
    const wiring: EquipesWiring = buildEquipes(f.deps, { modules: ["teamRunner"], ports: { runner } });
    wiring.apply(f.c11);
    const composed = f.c11.reloadBusy;
    assert.notEqual(composed, original);
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ];
    for (const [steps, exam, expected] of cases) {
      busy.value = steps;
      f.examining.value = exam;
      assert.equal(f.c11.reloadBusy(), expected, `étapes ${steps}, examen ${exam}`);
    }
    // Port lu au moment de l'appel : une surcharge posée plus tard est prise en compte.
    wiring.eq.ports.runner = { ...neutralRunner(), stepsBusy: () => true };
    f.examining.value = false;
    assert.equal(f.c11.reloadBusy(), true);
    wiring.eq.ports.runner = runner;

    wiring.apply(f.c11);
    assert.equal(f.c11.reloadBusy, composed, "second apply : rien de plus");
    busy.value = false;
    reads.count = 0;
    f.c11.reloadBusy();
    assert.equal(reads.count, 1, "une seule composition : stepsBusy lu une fois par appel");

    // Sans teamRunner (teamGuards seul) : aucune composition.
    const g = fakeCockpit();
    const before = g.c11.reloadBusy;
    buildEquipes(g.deps, { modules: ["teamGuards"], ports: { runner: { ...neutralRunner(), stepsBusy: () => true } } }).apply(g.c11);
    assert.equal(g.c11.reloadBusy, before);
    assert.equal(g.c11.reloadBusy(), false);
  });

  it("surcharge de ports : l'emporte sur le module installé ; verrou inscrit lu au moment de l'appel", async () => {
    const { deps } = fakeCockpit();
    const refusal = new Response(JSON.stringify({ error: "equipe-en-cours", message: "x" }), { status: 409 });
    const guards: TeamGuardsPort = { proxyGuard: async () => refusal, stopForCap: async () => undefined };
    const wiring = buildEquipes(deps, { modules: ["teamGuards"], ports: { guards } });
    const req: TeamProxyGuardRequest = { entree: "proxy", method: "POST", sub: "/session", directory: null, sessionId: null, permissionId: null };
    assert.equal(await wiring.proxyGuard(req), refusal);
    wiring.eq.ports.guards = { proxyGuard: async () => null, stopForCap: async () => undefined };
    assert.equal(await wiring.proxyGuard(req), null);
  });
});

describe("câblage des équipes : squelettes et événements", () => {
  it("squelettes : « Propriétaire : Lxx » en première ligne ; aucun import de shared/agent-map.ts", () => {
    const owners: Record<string, string> = {
      "team-service.ts": "L37a",
      "routes-teams.ts": "L37a",
      "team-examples.ts": "L37a",
      "team-preflight.ts": "L37p",
      "team-runner.ts": "L37b",
      "routes-team-runs.ts": "L37b",
      "team-run-guards.ts": "L37c",
      "agent-map-service.ts": "L39b",
      "routes-agent-map.ts": "L39b",
    };
    for (const [file, owner] of Object.entries(owners)) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
      assert.equal((source.split("\n")[0] ?? "").replace(/\r$/, ""), `// Propriétaire : ${owner}.`, file);
      assert.equal(/from\s+"[^"]*shared\/agent-map\.ts"/.test(source), false, `${file} : agent-map.ts est écrit par L39a`);
    }
  });

  it("emitEquipe : publie l'événement d'équipe sur le hub (hub.cockpit)", () => {
    const hub = new EventHub();
    const received: BrowserEvent[] = [];
    hub.subscribe((event) => void received.push(event));
    emitEquipe(hub, "equipe.lancement", { runId: "run_1", rootId: ROOT, state: "en-cours", cause: null });
    emitEquipe(hub, "equipe.etape", { runId: "run_1", rootId: ROOT, stepId: "a1", tour: 1, tentative: 1, state: "en-file", sessionId: null });
    assert.deepEqual(received, [
      { kind: "cockpit", type: "equipe.lancement", data: { runId: "run_1", rootId: ROOT, state: "en-cours", cause: null } },
      { kind: "cockpit", type: "equipe.etape", data: { runId: "run_1", rootId: ROOT, stepId: "a1", tour: 1, tentative: 1, state: "en-file", sessionId: null } },
    ]);
  });
});
