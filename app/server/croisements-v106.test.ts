// Tests de croisement 1.1 × 1.0.6 (R106-a ; fiche-fusion-v106 §9.3, décisions A22, A29 et D3) : sentinelle d'instance.
// Le faux opencode décode `directory` deux fois, comme opencode 1.18.30 : un dossier nommé « a%2F..%2F..%2Fsecret » y ouvre
// l'instance « /secret ». Chaque famille de routes du cockpit qui transmet un dossier à opencode, ou qui le lit pour décider, est
// jouée avec ce dossier piège ET avec des noms légitimes (« Remise 20% », accents, « & », « + »). Attendu, toujours :
// - dossier piège : refus, aucune requête dont le dossier porte une séquence %XX, aucune ligne `usage` ;
// - noms légitimes : relayés à l'octet, instance ouverte dans ce dossier ;
// - aucune instance hors de /workspace (fake.instancesHors ; le harnais le revérifie au nettoyage de chaque test).
// Sections que chaque fusion ajoute ici (fiche §3.10 à §8) : <gf1:v106>, <gf2:v106>, <gf3:v106>, <gf4:v106>, L39o, NAV.
// Aucun appel facturé : faux opencode seulement.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { knownDirectories, probeSessionsBusyStrict } from "./assistants.ts";
import { requestPendingRescan } from "./autonomy-requests.ts";
import { createConsignesStore } from "./consignes-store.ts";
import type { ActivationPort, Cockpit11, Cockpit11Module, ControlAiInput, ConversationAutonomyPort, RequestsPort } from "./contracts-11.ts";
import { CONTROL_AGENT_PROMPT, createControlAiModule } from "./control-ai.ts";
import { collectEditFacts } from "./edit-facts.ts";
import { decideConnect, egressAllowedHosts, type LoginWindow, splitConnectTarget } from "./egress-policy.ts";
import { hoteAutoriseDeLEnvironnement } from "./egress-proxy.ts";
import { parseCopilotApiUrl, parseGithubEnterpriseDomain } from "./env.ts";
import { forbiddenCommandArguments, forbiddenProxyBody, PERMISSION_MESSAGES } from "./http.ts";
import { createLogger } from "./log.ts";
import { createOcProxy, PROXY_RULES_OMO } from "./oc-proxy.ts";
import type { OmoActivationPort, OmoControlPort, OmoPrecheckPort, OmoRoomPort, OmoStopPort } from "./omo-contracts.ts";
import { createOmoControl } from "./omo-control.ts";
import { createOmoRoom } from "./omo-room.ts";
import { creerModuleOmoStop } from "./omo-stop.ts";
import { ProjectsService } from "./projects.ts";
import { registerOmoRoutes } from "./routes-omo.ts";
import type { AutonomyChoice, AutonomyRequestView } from "./shared/autonomy-types.ts";
import { CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { decoupeCibleConnect, egressAllow } from "./shared/egress-allow.ts";
import { ecrireEtat } from "./shared/omo-control-protocol.ts";
import type { OmoPreparedProjects, OmoSupervisorState } from "./shared/omo-types.ts";
import type { RevoirConsignesEnfantResponse, RevoirEtatResponse, RevoirResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { classifyCommand } from "./shared/shell-gate.ts";
import { collectShellContext } from "./shell-facts.ts";
import { StudioService } from "./studio.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakePermissionRequest, FakeSession, FakeToolScript } from "./test-support/fake-opencode.ts";
import { bash, promptAsync, until, within } from "./test-support/helpers.ts";

const OC = "/workspace";
/** Nom créable par une IA, valide sous NTFS : opencode 1.18.30 l'ouvrirait en « /secret ». */
const TRAP = "a%2F..%2F..%2Fsecret";
const TRAP_DIR = `${OC}/${TRAP}`;
/** Noms légitimes : « % » isolé (jamais décodé), accents, « & », « + » (encodé %2B par le cockpit, rendu tel quel). */
const LEGIT = ["Remise 20%", "Données & co", "R+D équipe"] as const;
const dirOf = (name: string) => `${OC}/${name}`;
const q = (value: string) => encodeURIComponent(value);
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const NL = String.fromCharCode(10);
const PERCENT = /%[0-9A-Fa-f]{2}/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Workspace réel monté en /workspace : dossier piège, noms légitimes et « proj », chacun avec a.txt. */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-v106-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [TRAP, ...LEGIT, "proj"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "a.txt"), `ligne 1${NL}TODO ligne 2${NL}ligne 3${NL}`);
  }
  return root;
}

async function start(t: TestContext, options: CockpitHarnessOptions = {}): Promise<{ h: CockpitHarness; root: string }> {
  const root = workspace(t);
  const h = await startCockpit(t, { ...options, env: { workspaceDir: root, ...(options.env ?? {}) } });
  return { h, root };
}

/** Requêtes reçues par le faux dont le dossier porte une séquence %XX (valeur reçue, avant le second décodage d'opencode). */
const percentRequests = (h: CockpitHarness): string[] =>
  h.fake.requests.filter((r) => PERCENT.test(r.query.directory ?? "")).map((r) => `${r.method} ${r.pathname}?directory=${r.query.directory}`);

/** Sentinelle : aucune instance hors de /workspace, aucun dossier %XX transmis. */
function assertSentinel(h: CockpitHarness, label: string): void {
  assert.deepEqual(h.fake.instancesHors(), [], `${label} : instance d'opencode ouverte hors de ${OC}`);
  assert.deepEqual(percentRequests(h), [], `${label} : dossier %XX transmis à opencode`);
}

const usageRows = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
const directoriesSent = (h: CockpitHarness, since: number): string[] => h.fake.requests.slice(since).flatMap((r) => (r.query.directory === undefined ? [] : [r.query.directory]));

function assertForbidden(res: { status: number; body: string }, label: string, message?: string): void {
  assert.equal(res.status, 403, `${label} : ${res.body}`);
  const body = JSON.parse(res.body) as { error?: string; message?: string };
  assert.equal(body.error, "forbidden-directory", `${label} : ${res.body}`);
  if (message !== undefined) assert.equal(body.message, message, label);
}

/** Conversation créée par le proxy dans `directory`, suivie par le cockpit. */
async function conversation(h: CockpitHarness, directory: string, title = "Conversation"): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${q(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

// --- Proxy /api/oc/* et /api/chat/resolve -------------------------------------------------------------------------------------

describe("croisements v106 : proxy /api/oc/* et /api/chat/resolve", () => {
  it("dossier %XX : 403 forbidden-directory sur chaque route, AUCUNE requête vers opencode ; noms légitimes relayés à l'octet ; aucune instance hors /workspace", async (t) => {
    const { h } = await start(t);
    const trap = q(TRAP_DIR);
    const prompt = { model: MODEL, parts: [{ type: "text", text: "Travaille." }] };
    const before = h.fake.requests.length;
    const refused: Array<[string, { status: number; body: string }]> = [
      ["GET /session", await h.call("GET", `/api/oc/session?directory=${trap}`, { headers: h.headers.authed })],
      ["GET /agent", await h.call("GET", `/api/oc/agent?directory=${trap}`, { headers: h.headers.authed })],
      ["GET /command", await h.call("GET", `/api/oc/command?directory=${trap}`, { headers: h.headers.authed })],
      ["GET /session/status", await h.call("GET", `/api/oc/session/status?directory=${trap}`, { headers: h.headers.authed })],
      ["GET /permission", await h.call("GET", `/api/oc/permission?directory=${trap}`, { headers: h.headers.authed })],
      ["GET /find/file", await h.call("GET", `/api/oc/find/file?query=auth.json&directory=${trap}`, { headers: h.headers.authed })],
      ["POST /session", await h.call("POST", `/api/oc/session?directory=${trap}`, { headers: h.headers.mutating, body: { title: "Piège" } })],
      ["POST prompt_async", await h.call("POST", `/api/oc/session/ses_x/prompt_async?directory=${trap}`, { headers: h.headers.mutating, body: prompt })],
      [
        "POST prompt_async (sous-dossier %2f)",
        await h.call("POST", `/api/oc/session/ses_x/prompt_async?directory=${q(`${dirOf(LEGIT[0])}/sous%2f..%2f..%2f..%2fetc`)}`, { headers: h.headers.mutating, body: prompt }),
      ],
      ["POST /api/chat/resolve", await h.call("POST", "/api/chat/resolve", { headers: h.headers.mutating, body: { directory: TRAP_DIR, agent: "build" } })],
    ];
    for (const [label, res] of refused) assertForbidden(res, label, "Ce dossier est hors du workspace monté.");
    assert.deepEqual(h.fake.requests.slice(before).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête vers opencode");
    assert.equal(usageRows(h), 0, "rien de facturé");
    assertSentinel(h, "dossier %XX");

    for (const name of LEGIT) {
      const directory = dirOf(name);
      const since = h.fake.requests.length;
      const agents = await h.call("GET", `/api/oc/agent?directory=${q(directory)}`, { headers: h.headers.authed });
      assert.equal(agents.status, 200, `${name} : ${agents.body}`);
      const session = await conversation(h, directory, name);
      assert.equal(session.directory, directory, `${name} : session créée dans le dossier, à l'octet`);
      h.fake.script(session.id, { text: `Réponse dans ${name}.` });
      const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${q(directory)}`, { headers: h.headers.mutating, body: prompt });
      assert.equal(sent.status, 204, `${name} : ${sent.body}`);
      await within(h.fake.settled(session.id), `réponse dans ${name}`);
      const resolved = await h.call("POST", "/api/chat/resolve", { headers: h.headers.mutating, body: { directory, agent: "build" } });
      assert.equal(resolved.status, 200, `${name} : ${resolved.body}`);
      assert.deepEqual([...new Set(directoriesSent(h, since))], [directory], `${name} : seul ce dossier est transmis, tel quel`);
      assert.ok(h.fake.instancesChargees().includes(directory), `${name} : instance ouverte dans ce dossier`);
    }
    assertSentinel(h, "noms légitimes");
  });

  it("en-tête x-opencode-directory posé par le navigateur : jamais relayé, même vers le dossier piège (opencode le lirait sans le paramètre)", async (t) => {
    const { h } = await start(t);
    const res = await h.call("GET", "/api/oc/session", { headers: { ...h.headers.authed, "x-opencode-directory": TRAP_DIR } });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(h.fake.instancesChargees(), [OC], "instance du dossier du serveur seulement");
    assertSentinel(h, "en-tête");
  });
});

// --- Câblage de la fenêtre de connexion (egressLogin) dans l'application 1.1 ------------------------------------------------------

describe("croisements v106 : fenêtre de connexion du relais (egressLogin) à travers createCockpitApp", () => {
  it("createCockpitApp transmet egressLogin à createApp : ouverte par …/oauth/authorize et …/callback du proxy, jamais par un corps refusé ni par une autre route", async (t) => {
    let opens = 0;
    const { h } = await start(t, { deps: () => ({ egressLogin: { open: () => void opens++ } }) });
    const post = (route: string, body: unknown) => h.call("POST", `/api/oc${route}`, { headers: h.headers.mutating, body });
    // Domaine GitHub Enterprise non déclaré : corps refusé, fenêtre fermée.
    assert.equal((await post("/provider/github-copilot/oauth/authorize", { method: 0, inputs: { deploymentType: "enterprise", enterpriseUrl: "github-login.example" } })).status, 403);
    assert.equal((await post("/session", { title: "x" })).status, 200);
    assert.equal(opens, 0);
    await post("/provider/github-copilot/oauth/authorize", { method: 0, inputs: { deploymentType: "github.com" } });
    assert.equal(opens, 1, "demande du code : fenêtre ouverte");
    await post("/provider/github-copilot/oauth/callback", { method: 0 });
    assert.equal(opens, 2, "attente de l'accord : fenêtre prolongée");
  });
});

// --- Studio, portée projet -----------------------------------------------------------------------------------------------------

describe("croisements v106 : Studio (portée projet)", () => {
  /** Studio réel (lectures, écritures, rechargement d'opencode) sur les services du harnais. */
  const realStudio: CockpitHarnessOptions["deps"] = (base) => ({
    studio: new StudioService({ env: base.env, client: base.client, projects: base.projects, control: base.control, log: base.log, ...(base.configQueue ? { queue: base.configQueue } : {}) }),
  });

  it("projet %XX : 403 en lecture et en écriture, aucun fichier écrit, aucune requête ; « Remise 20% » et autres : AGENTS.md écrit, instance du projet libérée à l'octet", async (t) => {
    const { h, root } = await start(t, { settings: { ui: { mode: "avance" } }, deps: realStudio });
    const scope = `?project=${q(TRAP)}`;
    const before = h.fake.requests.length;
    const refused: Array<[string, { status: number; body: string }]> = [
      ["GET instructions", await h.call("GET", `/api/studio/instructions${scope}`, { headers: h.headers.authed })],
      ["GET agents", await h.call("GET", `/api/studio/agents${scope}`, { headers: h.headers.authed })],
      ["GET agents/espion", await h.call("GET", `/api/studio/agents/espion${scope}`, { headers: h.headers.authed })],
      ["PUT instructions", await h.call("PUT", `/api/studio/instructions${scope}`, { headers: h.headers.mutating, body: { content: "consignes" } })],
      ["PUT agents/espion", await h.call("PUT", `/api/studio/agents/espion${scope}`, { headers: h.headers.mutating, body: { frontmatter: { description: "x" }, body: "x" } })],
      ["DELETE agents/espion", await h.call("DELETE", `/api/studio/agents/espion${scope}`, { headers: h.headers.mutating })],
    ];
    for (const [label, res] of refused) assertForbidden(res, label, "Nom de dossier non pris en charge (séquence %XX).");
    assert.deepEqual(fs.readdirSync(path.join(root, TRAP)), ["a.txt"], "aucun fichier écrit dans le dossier piège");
    assert.deepEqual(h.fake.requests.slice(before).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête vers opencode, garde comprise");
    assertSentinel(h, "Studio %XX");

    for (const name of LEGIT) {
      const since = h.fake.requests.length;
      const saved = await h.call("PUT", `/api/studio/instructions?project=${q(name)}`, { headers: h.headers.mutating, body: { content: `Consignes de ${name}` } });
      assert.equal(saved.status, 200, `${name} : ${saved.body}`);
      assert.equal(fs.readFileSync(path.join(root, name, "AGENTS.md"), "utf8"), `Consignes de ${name}`);
      const disposed = h.fake.requests.slice(since).filter((r) => r.method === "POST" && r.pathname === "/instance/dispose");
      assert.deepEqual(
        disposed.map((r) => r.query.directory),
        [dirOf(name)],
        `${name} : instance du projet libérée, dossier transmis à l'octet`,
      );
    }
    assertSentinel(h, "Studio noms légitimes");
  });

  it("mode Simple : écritures du Studio refusées par « mode Avancé » AVANT le contrôle de portée (advanced puis studioScopeFirst), sans lire la portée, projet %XX compris ; en Avancé, la portée d'abord", async (t) => {
    const scopes: string[] = [];
    const { h } = await start(t, {
      deps: (base) => {
        const studio = new StudioService({ env: base.env, client: base.client, projects: base.projects, control: base.control, log: base.log });
        const checkScope = studio.checkScope.bind(studio);
        studio.checkScope = async (scope) => {
          scopes.push(scope.type === "project" ? scope.project : "(global)");
          return checkScope(scope);
        };
        return { studio };
      },
    });
    const writes = (project: string) => {
      const scope = `?project=${q(project)}`;
      return [
        ["PUT instructions", () => h.call("PUT", `/api/studio/instructions${scope}`, { headers: h.headers.mutating, body: { content: "consignes" } })],
        ["PUT agents/espion", () => h.call("PUT", `/api/studio/agents/espion${scope}`, { headers: h.headers.mutating, body: { frontmatter: { description: "x" }, body: "x" } })],
        ["DELETE agents/espion", () => h.call("DELETE", `/api/studio/agents/espion${scope}`, { headers: h.headers.mutating })],
      ] as const;
    };
    const before = h.fake.requests.length;
    for (const project of [TRAP, LEGIT[0]]) {
      for (const [label, write] of writes(project)) {
        const res = await write();
        assert.equal(res.status, 403, `${project}, ${label} : ${res.body}`);
        assert.equal(res.json<{ error: string }>().error, "mode-avance", `${project}, ${label} : le mode d'abord`);
      }
    }
    assert.deepEqual(scopes, [], "portée jamais lue en mode Simple");
    assert.equal(h.fake.requests.length, before, "aucune requête vers opencode");

    // Témoin : en mode Avancé, la portée %XX est refusée par studioScopeFirst, avant la garde.
    h.settings.update({ ui: { mode: "avance" } });
    for (const [label, write] of writes(TRAP)) assertForbidden(await write(), label, "Nom de dossier non pris en charge (séquence %XX).");
    assert.deepEqual(scopes, [TRAP, TRAP, TRAP]);
    assertSentinel(h, "Studio, mode Simple");
  });
});

// --- Dossiers connus (assistants, garde de rechargement) --------------------------------------------------------------------------

describe("croisements v106 : dossiers connus (assistants.ts, garde de rechargement)", () => {
  it("ligne de conversation au dossier %XX (héritée) : jamais interrogée ; les dossiers légitimes le sont, à l'octet", async (t) => {
    const { h } = await start(t, { settings: { ui: { mode: "avance" } } });
    for (const name of LEGIT) await conversation(h, dirOf(name), name);
    const legacy = await conversation(h, dirOf("proj"), "Héritée");
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacy.id);

    const known = await knownDirectories({ projects: h.deps.projects, db: h.db });
    assert.deepEqual(known.filter((d) => d !== null).sort(), LEGIT.map(dirOf).sort());

    const since = h.fake.requests.length;
    assert.equal(await probeSessionsBusyStrict({ client: h.deps.client, projects: h.deps.projects, db: h.db, log: h.deps.log }), "idle");
    // Même sonde par la route : garde de rechargement d'une écriture du Studio (portée globale).
    const saved = await h.call("PUT", "/api/studio/agents/espion", { headers: h.headers.mutating, body: { frontmatter: { description: "x" }, body: "x" } });
    assert.equal(saved.status, 200, saved.body);
    const probed = h.fake.requests.slice(since).filter((r) => r.method === "GET" && r.pathname === "/session/status");
    assert.deepEqual([...new Set(probed.map((r) => r.query.directory ?? "(défaut)"))].sort(), ["(défaut)", ...LEGIT.map(dirOf)].sort());
    assertSentinel(h, "dossiers connus");
  });
});

// --- Plans et plancher ----------------------------------------------------------------------------------------------------------

describe("croisements v106 : plans et plancher (createWithFloor)", () => {
  it("POST /api/plans et …/execution : dossier %XX refusé avant toute création ; plan dans « Remise 20% » et autres : racines créées dans ce dossier", async (t) => {
    const { h } = await start(t, { modules: ["floors", "conversationAutonomy", "plans"] });
    const creations = () => h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session").length;
    const before = creations();
    assertForbidden(await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: TRAP_DIR } }), "POST /api/plans");
    assert.equal(creations(), before, "aucune racine créée");
    assertSentinel(h, "plan %XX");

    for (const name of LEGIT) {
      const created = await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: dirOf(name) } });
      assert.equal(created.status, 200, `${name} : ${created.body}`);
      const plan = created.json<{ rootId: string; session: { directory: string } }>();
      assert.equal(plan.session.directory, dirOf(name));
      assert.equal(h.fake.session(plan.rootId)?.directory, dirOf(name), `${name} : racine PLAN créée dans ce dossier`);
      h.fake.script(plan.rootId, { text: `Plan pour ${name}.` });
      const sent = await h.call("POST", `/api/oc/session/${plan.rootId}/prompt_async?directory=${q(dirOf(name))}`, {
        headers: h.headers.mutating,
        body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Prépare un plan." }] },
      });
      assert.equal(sent.status, 204, sent.body);
      await within(h.fake.settled(plan.rootId), `plan de ${name} terminé`);
      const executed = await h.call("POST", `/api/plans/${plan.rootId}/execution`, { headers: h.headers.mutating, body: { choix: "demander" } });
      assert.equal(executed.status, 200, `${name} : ${executed.body}`);
      const execution = executed.json<{ rootId: string; session: { directory: string } }>();
      assert.equal(h.fake.session(execution.rootId)?.directory, dirOf(name), `${name} : conversation d'exécution créée dans ce dossier`);
    }

    // Plan suivi par le cockpit dont le dossier est %XX (ligne héritée) : exécution refusée avant toute création.
    const legacy = await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: dirOf("proj") } });
    assert.equal(legacy.status, 200, legacy.body);
    const legacyId = legacy.json<{ rootId: string }>().rootId;
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacyId);
    const beforeExecution = creations();
    assertForbidden(await h.call("POST", `/api/plans/${legacyId}/execution`, { headers: h.headers.mutating, body: { choix: "demander" } }), "…/execution");
    assert.equal(creations(), beforeExecution, "aucune conversation d'exécution créée");
    assertSentinel(h, "plans");
  });

  it("port floors.createWithFloor : dossier %XX refusé sans rien envoyer ; noms légitimes : session créée dans le dossier", async (t) => {
    const { h } = await start(t, { modules: ["floors"] });
    const floors = h.cockpit.c11.ports.floors;
    const before = h.fake.requests.length;
    await assert.rejects(floors.createWithFloor("CONVERSATION", { directory: TRAP_DIR }), RangeError);
    assert.equal(h.fake.requests.length, before, "rien envoyé à opencode");
    for (const name of LEGIT) {
      const session = await floors.createWithFloor("CONVERSATION", { directory: dirOf(name), title: name });
      assert.equal(session.directory, dirOf(name), name);
    }
    assertSentinel(h, "plancher");
  });
});

// --- IA de contrôle ---------------------------------------------------------------------------------------------------------------

describe("croisements v106 : IA de contrôle (control-ai)", () => {
  const REQUEST_ID = "req-v106-1";

  function requestView(rootId: string): AutonomyRequestView {
    return {
      id: REQUEST_ID,
      rootId,
      choix: "autonome",
      plafonds: { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 },
      startedAt: Date.now() - 1_000,
      endedAt: null,
      spent: 0,
      auto: 0,
      attentes: 0,
      refus: 0,
      controles: 0,
      fichiers: 0,
      delegations: 0,
      fin: null,
    };
  }

  it("racine au dossier %XX : aucune session de contrôle ; racines légitimes : session de contrôle créée dans leur dossier", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const requests = new Map<string, AutonomyRequestView>();
    const ports: { conversationAutonomy: ConversationAutonomyPort; requests: RequestsPort } = {
      conversationAutonomy: {
        get: async () => null,
        choiceOf: (rootId) => choices.get(rootId) ?? "demander",
        put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
      },
      requests: { current: (rootId) => requests.get(rootId) ?? null, spent: () => 0, interrupt: () => undefined },
    };
    const { h } = await start(t, {
      modules: ["floors", createControlAiModule({ messageTimeoutMs: 3_000, idleProbeMs: 20, idleWindowMs: 600 })],
      ports,
    });
    // Flux coupé comme dans control-ai.test.ts : le contrôle lit lui-même sa réponse.
    h.processor.stop();
    const controlAgent = { name: CONTROL_AGENT_NAME, mode: "primary", hidden: true, native: false, options: {}, permission: [{ permission: "*", pattern: "*", action: "deny" }], prompt: CONTROL_AGENT_PROMPT };
    h.fake.setAgents([...h.fake.agents(), controlAgent as FakeAgent]);
    h.fake.defaultTurn = { text: "RAISON: Affiche l'arborescence du dossier sans rien modifier.\nDÉCISION: AUTORISER", cost: 0.003, tokens: { input: 40, output: 12 } };
    const controlCreations = () =>
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session" && isRecord(r.body) && isRecord(r.body.metadata) && r.body.metadata.cockpit === "controle");
    const judge = (root: FakeSession) => {
      choices.set(root.id, "autonome");
      requests.set(root.id, requestView(root.id));
      const input: ControlAiInput = { rootId: root.id, sessionId: root.id, requestId: REQUEST_ID, command: "tree -L 2", head: "tree", relativeDir: "", directory: root.directory };
      return h.cockpit.c11.ports.controlAi.judge(input);
    };

    const legacy = await conversation(h, dirOf("proj"), "Héritée");
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacy.id);
    assert.deepEqual(await judge({ ...legacy, directory: TRAP_DIR }), { decision: "indisponible", raison: "desactive" });
    assert.equal(controlCreations().length, 0, "aucune session de contrôle pour la racine %XX");
    assertSentinel(h, "contrôle %XX");

    for (const name of LEGIT) {
      const root = await conversation(h, dirOf(name), name);
      const before = controlCreations().length;
      assert.equal((await within(judge(root), `contrôle dans ${name}`)).decision, "autoriser", name);
      const created = controlCreations().slice(before);
      assert.deepEqual(
        created.map((r) => r.query.directory),
        [dirOf(name)],
        `${name} : session de contrôle créée dans le dossier de la racine`,
      );
    }
    assertSentinel(h, "contrôle légitime");
  });
});

// --- Autonomie : relecture des demandes, faits du disque ---------------------------------------------------------------------------

describe("croisements v106 : autonomie (relecture de GET /permission, faits edit et shell)", () => {
  const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

  it("relecture des demandes d'une racine au dossier %XX : jamais demandée à opencode ; racines légitimes : relues dans leur dossier", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const { h } = await start(t, {
      modules: ["autonomy", "requests", "facts", "floors"],
      ports: {
        conversationAutonomy: { get: async () => null, choiceOf: (id) => choices.get(id) ?? "demander", put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }) },
        activation: PERMIS,
      },
    });
    const permissionReads = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission");

    const legacy = await conversation(h, dirOf("proj"), "Héritée");
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacy.id);
    choices.set(legacy.id, "autonome");
    const before = permissionReads().length;
    requestPendingRescan(h.cockpit.c11, legacy.id);
    // Témoin de fin de la relecture différée : une racine légitime relue juste après.
    const witness = await conversation(h, dirOf(LEGIT[0]), "Témoin");
    choices.set(witness.id, "autonome");
    requestPendingRescan(h.cockpit.c11, witness.id);
    await until(() => permissionReads().slice(before).some((r) => r.query.directory === dirOf(LEGIT[0])));
    assert.deepEqual(
      permissionReads()
        .slice(before)
        .map((r) => r.query.directory),
      [dirOf(LEGIT[0])],
      "seule la racine légitime est relue",
    );

    for (const name of LEGIT.slice(1)) {
      const root = await conversation(h, dirOf(name), name);
      choices.set(root.id, "autonome");
      const since = permissionReads().length;
      requestPendingRescan(h.cockpit.c11, root.id);
      await until(() => permissionReads().length > since);
      assert.deepEqual(
        permissionReads()
          .slice(since)
          .map((r) => r.query.directory),
        [dirOf(name)],
        name,
      );
    }
    assertSentinel(h, "relecture");
  });

  it("décision automatique dans « Remise 20% » (grep) : faits lus dans ce dossier, « once » relayé ; aucune instance hors /workspace", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const { h } = await start(t, {
      modules: ["autonomy", "requests", "facts", "floors"],
      settings: { budget: { autonomie: { controleIa: false } } },
      ports: {
        conversationAutonomy: { get: async () => null, choiceOf: (id) => choices.get(id) ?? "demander", put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }) },
        activation: PERMIS,
      },
    });
    const root = await conversation(h, dirOf(LEGIT[0]), "Autonome");
    choices.set(root.id, "autonome");
    const since = h.fake.emitted.length;
    h.fake.script(root.id, { tools: [bash("grep -rn 'TODO' a.txt")], followUp: { text: "Fini." } });
    const sent = await h.call("POST", `/api/oc/session/${root.id}/prompt_async?directory=${q(dirOf(LEGIT[0]))}`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Cherche." }] },
    });
    assert.equal(sent.status, 204, sent.body);
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id, { since })).properties as unknown as FakePermissionRequest;
    const decision = await until(
      () => h.db.prepare("SELECT verdict, regle, relais FROM autonomy_decisions WHERE permission_id = ?").get(asked.id) as { verdict: string; regle: string; relais: string | null } | undefined,
    );
    assert.deepEqual({ ...decision }, { verdict: "auto", regle: "A-grep", relais: "ok" });
    await within(h.fake.settled(root.id), "réponse terminée");
    assertSentinel(h, "décision automatique");
  });

  it("faits des demandes edit (E6) et shell : dossier %XX refusé sans rien lire (attente) ; noms légitimes lus", async (t) => {
    const root = workspace(t);
    const projects = new ProjectsService({ workspaceDir: root, opencodeWorkspaceDir: OC });
    const editRequest = (directory: string) => {
      const file = `${directory}/a.txt`;
      const diff = `Index: ${file}${NL}${"=".repeat(67)}${NL}--- ${file}${NL}+++ ${file}${NL}@@ -1,3 +1,3 @@${NL} ligne 1${NL}-TODO ligne 2${NL}+ligne deux${NL} ligne 3${NL}`;
      return { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["a.txt"], always: ["*"], metadata: { filepath: file, diff }, tool: { messageID: "msg_1", callID: "call_1" } };
    };
    const shellVerdict = async (directory: string) => {
      const command = "grep -rn 'TODO' a.txt";
      const facts = await collectShellContext(command, directory, projects);
      return classifyCommand(command, { ...facts, workdir: null, allowJudge: false });
    };

    const trapped = await collectEditFacts(editRequest(TRAP_DIR), TRAP_DIR, projects, 0);
    assert.equal(trapped.directoryAllowed, false, "edit : E6 pour le dossier %XX");
    assert.deepEqual(trapped.paths, [], "edit : aucun chemin lu");
    const shell = await shellVerdict(TRAP_DIR);
    assert.equal(shell.verdict, "attente", `shell : jamais automatique dans le dossier %XX (${JSON.stringify(shell)})`);

    for (const name of LEGIT) {
      const facts = await collectEditFacts(editRequest(dirOf(name)), dirOf(name), projects, 0);
      assert.equal(facts.directoryAllowed, true, name);
      assert.equal(facts.paths[0]?.inside, true, `${name} : fichier lu dans le dossier`);
      const verdict = await shellVerdict(dirOf(name));
      assert.deepEqual([verdict.verdict, verdict.regle], ["auto", "A-grep"], name);
    }
  });
});

// --- GET /permission rejeté par opencode 1.18.30 (fiche §10.3, A23) : état actuel figé ---------------------------------------------
// Option `permissionListeRejetee` du faux : GET /permission répond 400 (« schema rejection ») tant qu'une demande de l'instance a un
// argument facultatif omis recopié dans ses métadonnées (METADONNEES_FACULTATIVES : webfetch sans timeout, glob ou grep sans path,
// etc. ; jamais bash), comme opencode 1.18.30 réel (mesure D11, A31). Ces tests FIGENT ce que fait le cockpit aujourd'hui avec un
// webfetch sans délai ; GF5 les RETOURNE (repli sur la table des attentes alimentée par permission.asked/replied, A31 a). Un
// changement de comportement doit les modifier ici, en le disant.

describe("croisements v106 : GET /permission rejeté par opencode (option permissionListeRejetee) — état actuel, correction à GF5 (D11)", () => {
  const URL_DOC = "https://exemple.test/doc";
  /** Demande webfetch sans délai : ses métadonnées n'ont pas de `timeout` (tool/webfetch.ts:43-47). */
  const webfetch: FakeToolScript = {
    tool: "webfetch",
    input: { url: URL_DOC, format: "markdown" },
    ask: { permission: "webfetch", patterns: [URL_DOC], always: ["*"], metadata: { url: URL_DOC, format: "markdown" } },
    output: "contenu",
  };
  const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };
  const replies = (h: CockpitHarness) => h.fake.requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/"));

  /** Conversation dans `directory` dont la réponse attend un accord ; rend la demande. */
  async function waitingFor(h: CockpitHarness, directory: string, title: string, tool: FakeToolScript): Promise<{ session: FakeSession; asked: FakePermissionRequest }> {
    const session = await conversation(h, directory, title);
    const since = h.fake.emitted.length;
    h.fake.script(session.id, { tools: [tool], followUp: { text: "Fini." } });
    const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${q(directory)}`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
    });
    assert.equal(sent.status, 204, sent.body);
    const event = await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since });
    return { session, asked: event.properties as unknown as FakePermissionRequest };
  }

  it("portillon et liste des approbations : liste relayée en 400 ; « once » refusé en 503 sans rien relayer (la demande reste ouverte) ; « reject » relayé ; témoin sans l'option : « once » relayé", async (t) => {
    const { h } = await start(t);
    const dir = dirOf("proj");
    const { session, asked } = await waitingFor(h, dir, "Web", webfetch);
    h.fake.permissionListeRejetee = true;

    // Liste des approbations de l'interface (ChatPage : oc.permissions) : 400 d'opencode relayé tel quel.
    const list = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(list.status, 400, list.body);
    assert.match(list.json<{ data: { message: string } }>().data.message, /\["metadata"\]\["timeout"\]/);

    const answer = (reply: string) => h.call("POST", `/api/oc/permission/${asked.id}/reply?directory=${q(dir)}`, { headers: h.headers.mutating, body: { reply } });
    const once = await answer("once");
    assert.equal(once.status, 503, once.body);
    assert.deepEqual(once.json(), { error: "verification-impossible", message: PERMISSION_MESSAGES.verificationImpossible });
    assert.deepEqual(replies(h), [], "« once » jamais relayé");
    assert.deepEqual(
      h.fake.pendingPermissions().map((p) => p.id),
      [asked.id],
      "la demande reste ouverte",
    );

    // Le refus n'autorise rien : relayé sans vérification.
    const reject = await answer("reject");
    assert.equal(reject.status, 200, reject.body);
    assert.deepEqual(
      replies(h).map((r) => r.body),
      [{ reply: "reject" }],
    );
    await within(h.fake.settled(session.id), "réponse close par le refus");

    // Témoin : liste lisible, « once » relayé.
    h.fake.permissionListeRejetee = false;
    const other = await waitingFor(h, dir, "Témoin", webfetch);
    const relayed = await h.call("POST", `/api/oc/permission/${other.asked.id}/reply?directory=${q(dir)}`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(relayed.status, 200, relayed.body);
    assert.deepEqual(replies(h).at(-1)?.body, { reply: "once" });
    await within(h.fake.settled(other.session.id), "réponse du témoin terminée");
  });

  it("autonomie : décision automatique (grep) impossible à relayer, journal « attente » avec relais « echec », la demande reste à l'utilisateur", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const { h } = await start(t, {
      modules: ["autonomy", "requests", "facts", "floors"],
      settings: { budget: { autonomie: { controleIa: false } } },
      ports: {
        conversationAutonomy: {
          get: async () => null,
          choiceOf: (id) => choices.get(id) ?? "demander",
          put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
        },
        activation: PERMIS,
      },
    });
    const dir = dirOf("proj");
    // Une demande webfetch sans délai attend dans le même dossier (conversation en « Demander ») : la liste de l'instance est rejetée.
    await waitingFor(h, dir, "Demander", webfetch);
    h.fake.permissionListeRejetee = true;
    const auto = await conversation(h, dir, "Autonome");
    choices.set(auto.id, "autonome");
    const since = h.fake.emitted.length;
    h.fake.script(auto.id, { tools: [bash("grep -rn 'TODO' a.txt")], followUp: { text: "Fini." } });
    const sent = await h.call("POST", `/api/oc/session/${auto.id}/prompt_async?directory=${q(dir)}`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Cherche." }] },
    });
    assert.equal(sent.status, 204, sent.body);
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === auto.id, { since })).properties as unknown as FakePermissionRequest;
    const decision = await until(
      () =>
        h.db.prepare("SELECT verdict, regle, par, relais FROM autonomy_decisions WHERE permission_id = ?").get(asked.id) as
          | { verdict: string; regle: string; par: string; relais: string | null }
          | undefined,
    );
    assert.deepEqual({ ...decision }, { verdict: "attente", regle: "A-grep", par: "regles", relais: "echec" });
    assert.deepEqual(
      replies(h).filter((r) => r.pathname.includes(asked.id)),
      [],
      "aucun « once » envoyé",
    );
    assert.ok(
      h.fake.pendingPermissions().some((p) => p.id === asked.id),
      "la demande reste à l'utilisateur",
    );
  });

  it("arrêt par le proxy : la conversation s'arrête, mais les demandes en attente ne sont pas refusées (liste illisible) et restent ouvertes", async (t) => {
    const { h } = await start(t);
    const dir = dirOf("proj");
    const { session, asked } = await waitingFor(h, dir, "Web", webfetch);
    h.fake.permissionListeRejetee = true;
    const before = h.fake.requests.length;
    const stopped = await h.call("POST", `/api/oc/session/${session.id}/abort?directory=${q(dir)}`, { headers: h.headers.mutating });
    assert.equal(stopped.status, 200, stopped.body);
    // Nettoyage de l'arrêt tenté : sa lecture de GET /permission est partie, puis rien.
    await until(() => h.fake.requests.slice(before).some((r) => r.method === "GET" && r.pathname === "/permission"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(replies(h), [], "aucun refus envoyé");
    assert.deepEqual(
      h.fake.pendingPermissions().map((p) => p.id),
      [asked.id],
      "la demande reste ouverte jusqu'à une réponse ou un redémarrage",
    );
  });
});

// <gf1:v106>
// --- Grande fusion, GF1 : salle × 1.0.6 (fiche-fusion-v106 §3.10 ; décisions A29 : D1, D2, D4) ------------------------------------
// La salle entre fermée (SALLE_OUVERTE fausse dans le dépôt) : chaque test l'ouvre pour lui seul, comme ses propres tests (L18c,
// L22c, L23b). Deux faux opencode, aucun appel facturé. T-S7 (banc complet de la salle) et T-S10 (omo-image.test.ts) sont ailleurs.

/** Projet piège de la salle (fiche §3.5) : un seul segment ici ; après le double décodage d'opencode, son dossier de données. */
const TRAP_SALLE = "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode";
/** Nom légitime avec un % isolé : jamais une séquence %XX. */
const REMISE = "Remise 20%";
const RACINE_DEPOT = path.join(import.meta.dirname, "..", "..");

interface SalleOuverte {
  h: CockpitHarness;
  omo: NonNullable<CockpitHarness["omo"]>;
  workspace: string;
  /** Projets passés au pré-contrôle (espion) : un projet refusé avant ne doit jamais y arriver. */
  prechecks: string[];
}

/**
 * Cockpit réel, salle branchée sur le VRAI service de L18c et ses routes /api/omo/*, porte SALLE_OUVERTE ouverte pour ce test seul ;
 * pré-contrôle, arrêt et contrôle en espions. `projets` : préparés dans omo-projets.json, comme install.ps1 l'écrirait, et créés
 * dans le dossier de travail.
 */
async function salleOuverte(t: TestContext, projets: readonly string[], options: Pick<CockpitHarnessOptions, "deps"> = {}): Promise<SalleOuverte> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-v106-salle-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dossier = (nom: string) => {
    const complet = path.join(tmp, nom);
    fs.mkdirSync(complet, { recursive: true });
    return complet;
  };
  const workspace = dossier("workspace");
  for (const projet of projets) fs.mkdirSync(path.join(workspace, projet, ".git"), { recursive: true });
  const projetsFichier = path.join(dossier("source"), "omo-projets.json");
  const liste: OmoPreparedProjects = {
    version: 1,
    genereLe: "2026-09-27T00:00:00Z",
    projets: projets.map((chemin) => ({ chemin, git: "dossier" as const })),
    gitProteges: projets.map((chemin) => ({ chemin: `${chemin}/.git`, forme: "dossier" as const })),
  };
  fs.writeFileSync(projetsFichier, `${JSON.stringify(liste)}\n`, "utf8");
  const prechecks: string[] = [];
  const omoPrecheck: OmoPrecheckPort = {
    check: async (projet) => {
      prechecks.push(projet);
      return { ok: true, resultat: { projet, verdict: "conforme", raison: null, trouves: [] } };
    },
    beforeStart: async (startId) => ({ ok: true, startId, resultats: [] }),
  };
  const omoStop: OmoStopPort = { run: async () => assert.fail("arrêt inattendu"), relaunchAfterRequest: async () => undefined };
  const omoControl: OmoControlPort = {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => null,
    suspend: () => undefined,
    resume: () => undefined,
    suspended: () => false,
  };
  const controlDir = dossier("control");
  const authDir = dossier("auth");
  const egressJournal = dossier("egress");
  const moduleSalle: Cockpit11Module = {
    name: "omoRoom",
    install(reg, c11) {
      const ouvert: Cockpit11 = { ...c11, salleOuverte: true };
      ouvert.ports.omoRoom = createOmoRoom({
        db: c11.db,
        sessions: c11.sessions,
        log: c11.log,
        env: c11.env,
        workspace,
        controlDir,
        authDir,
        projectsFile: projetsFichier,
        egressJournal,
        ports: () => c11.ports,
        instance: () => c11.instances?.omo ?? null,
        salleOuverte: () => true,
      });
      reg.routes("omo", (app) => registerOmoRoutes(app, ouvert), { instances: ["omo"] });
    },
  };
  const h = await startCockpit(t, {
    ...options,
    omo: true,
    modules: [moduleSalle],
    ports: { omoPrecheck, omoStop, omoControl },
    settings: { ui: { mode: "avance" } },
    env: { workspaceDir: workspace },
  });
  assert.ok(h.omo, "harnais : option « omo »");
  return { h, omo: h.omo, workspace, prechecks };
}

/** Montage /api/omo/oc/* de la salle construit comme dans http.ts (createOcProxy, PROXY_RULES_OMO), hors de la porte SALLE_OUVERTE. */
function proxySalle(h: CockpitHarness, omo: NonNullable<CockpitHarness["omo"]>, egressLogin?: Pick<LoginWindow, "open">): Hono {
  const app = new Hono();
  app.all(
    "/api/omo/oc/*",
    createOcProxy({
      env: h.deps.env,
      log: h.deps.log,
      projects: h.deps.projects,
      hooks: h.cockpit.wiring,
      instanceOf: (id: string) => h.sessions.get(id)?.instance ?? null,
      forbiddenProxyBody,
      forbiddenCommandArguments,
      enforceTurn: async (_c, _sub, _directory, body) => body,
      instance: omo.deps,
      prefix: "/api/omo/oc",
      rules: PROXY_RULES_OMO,
      ...(egressLogin === undefined ? {} : { egressLogin }),
    }),
  );
  return app;
}

const lignesRooms = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM omo_rooms").get() as { n: number }).n;
const requetesDe = (requetes: ReadonlyArray<{ method: string; pathname: string }>, depuis: number): string[] =>
  requetes.slice(depuis).map((r) => `${r.method} ${r.pathname}`);

interface ServiceCompose {
  profiles?: string[];
  networks?: string[] | Record<string, unknown>;
  network_mode?: string;
  environment?: Record<string, string>;
}
interface ComposeLu {
  services: Record<string, ServiceCompose>;
  networks?: Record<string, { internal?: boolean } | null>;
}
const COMPOSE_TEXTE = fs.readFileSync(path.join(RACINE_DEPOT, "docker-compose.yml"), "utf8");
/** Réseaux d'un service : sans clé, `default` seul (Compose) ; network_mode : aucun réseau du projet. */
function reseauxDe(service: ServiceCompose | undefined): string[] {
  if (service?.network_mode !== undefined) return [];
  if (service?.networks === undefined) return ["default"];
  return Array.isArray(service.networks) ? [...service.networks] : Object.keys(service.networks);
}

describe("croisements v106 <gf1:v106> : salle × 1.0.6 (fiche §3.10)", () => {
  it("T-S1 : ouverture et pré-contrôle d'un projet préparé au nom %XX → 400 hors-workspace, zéro requête, aucune ligne omo_rooms ; « Remise 20% » préparé → ouvert, à l'octet", async (t) => {
    const s = await salleOuverte(t, [TRAP_SALLE, REMISE]);
    const repereSalle = s.omo.fake.requests.length;
    const reperePrincipal = s.h.fake.requests.length;
    const ouverture = await s.h.call("POST", "/api/omo/rooms", { headers: s.h.headers.confirmed, body: { projet: TRAP_SALLE } });
    assert.equal(ouverture.status, 400, ouverture.body);
    assert.equal(ouverture.json<{ error: string }>().error, "hors-workspace");
    const precontrole = await s.h.call("GET", `/api/omo/precheck?projet=${q(TRAP_SALLE)}`, { headers: s.h.headers.authed });
    assert.equal(precontrole.status, 400, precontrole.body);
    assert.equal(precontrole.json<{ error: string }>().error, "hors-workspace");
    assert.deepEqual(requetesDe(s.omo.fake.requests, repereSalle), [], "zéro requête à l'instance de la salle");
    assert.deepEqual(requetesDe(s.h.fake.requests, reperePrincipal), [], "zéro requête à l'instance principale");
    assert.deepEqual(s.prechecks, [], "le dossier piège n'est jamais lu par le pré-contrôle");
    assert.equal(lignesRooms(s.h), 0);

    // Témoin : un % isolé n'est pas une séquence ; la salle s'ouvre, dans ce dossier, à l'octet.
    const remise = await s.h.call("POST", "/api/omo/rooms", { headers: s.h.headers.confirmed, body: { projet: REMISE } });
    assert.equal(remise.status, 200, remise.body);
    assert.deepEqual(s.prechecks, [REMISE]);
    assert.equal(lignesRooms(s.h), 1);
    const creations = s.omo.fake.requests.slice(repereSalle).filter((r) => r.method === "POST" && r.pathname === "/session");
    assert.deepEqual(
      creations.map((r) => r.query.directory),
      [path.join(s.workspace, REMISE)],
    );
  });

  it("T-S2 : proxy de la salle avec un dossier %XX — session, agent, prompt_async → 403 forbidden-directory, zéro requête à la salle", async (t) => {
    const s = await salleOuverte(t, []);
    const racine = await s.omo.deps.client.request<FakeSession>("POST", "/session", { directory: `${OC}/proj`, body: { title: "proj" } });
    await until(() => s.h.sessions.get(racine.id)?.instance === "omo");
    const proxy = proxySalle(s.h, s.omo);
    const trap = q(`${OC}/${TRAP_SALLE}`);
    const repere = s.omo.fake.requests.length;
    const refus: Array<[string, Response]> = [
      ["GET /session", await proxy.request(`/api/omo/oc/session?directory=${trap}`)],
      ["GET /agent", await proxy.request(`/api/omo/oc/agent?directory=${trap}`)],
      [
        "POST prompt_async",
        await proxy.request(`/api/omo/oc/session/${racine.id}/prompt_async?directory=${trap}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text: "Travaille." }] }),
        }),
      ],
    ];
    for (const [label, res] of refus) {
      const corps = await res.text();
      assert.equal(res.status, 403, `${label} : ${corps}`);
      assert.equal((JSON.parse(corps) as { error: string }).error, "forbidden-directory", label);
    }
    assert.deepEqual(requetesDe(s.omo.fake.requests, repere), [], "zéro requête à la salle");
    assert.deepEqual(s.omo.fake.instancesHors(), [], "aucune instance de la salle hors de /workspace");
  });

  it("T-S3 : routes OAuth sur le montage de la salle → refus, fenêtre de connexion jamais ouverte ; montage principal : ouverte (I4) ; egressLogin passé au seul montage /api/oc", async (t) => {
    let ouvertures = 0;
    const fenetre = { open: () => void ouvertures++ };
    const s = await salleOuverte(t, [], { deps: () => ({ egressLogin: fenetre }) });
    // Même si un câblage futur passait la fenêtre au montage de la salle : PROXY_RULES_OMO n'a aucune route OAuth.
    const proxy = proxySalle(s.h, s.omo, fenetre);
    const repere = s.omo.fake.requests.length;
    for (const route of ["authorize", "callback"]) {
      const res = await proxy.request(`/api/omo/oc/provider/github-copilot/oauth/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: 0 }),
      });
      assert.equal(res.status, 404, route);
      assert.equal(((await res.json()) as { error: string }).error, "not-allowed", route);
      // Montage réel de l'application (fermé par SALLE_OUVERTE) : refusé aussi, sans rien ouvrir.
      const reel = await s.h.call("POST", `/api/omo/oc/provider/github-copilot/oauth/${route}`, { headers: s.h.headers.mutating, body: { method: 0 } });
      assert.ok(reel.status === 403 || reel.status === 404, `${route} : ${reel.status} ${reel.body}`);
    }
    assert.equal(ouvertures, 0, "fenêtre de connexion jamais ouverte depuis la salle");
    assert.deepEqual(requetesDe(s.omo.fake.requests, repere), []);
    // Montage principal : la demande du code ouvre la fenêtre (I4 inchangé par le déplacement du proxy, L18b).
    await s.h.call("POST", "/api/oc/provider/github-copilot/oauth/authorize", { headers: s.h.headers.mutating, body: { method: 0, inputs: { deploymentType: "github.com" } } });
    assert.equal(ouvertures, 1);
    // Câblage : egressLogin n'est passé qu'au montage /api/oc, jamais à proxyCommun ni au montage de la salle.
    const http = fs.readFileSync(path.join(import.meta.dirname, "http.ts"), "utf8");
    const passages = [...http.matchAll(/egressLogin: deps\.egressLogin/g)].map((m) => m.index ?? 0);
    assert.equal(passages.length, 1);
    const principal = http.lastIndexOf('prefix: "/api/oc",', passages[0]);
    const salle = http.indexOf('prefix: "/api/omo/oc",');
    assert.ok(principal > 0 && (passages[0] ?? 0) - principal < 600 && (passages[0] ?? 0) < salle, "dans l'appel createOcProxy du montage principal");
    assert.doesNotMatch(/const proxyCommun = \{[^\n]*\}/.exec(http)?.[0] ?? "", /egressLogin/);
  });

  it("T-S4 : docker-compose.yml fusionné valide (clés uniques, ancres fusionnées), avec et sans le profil omo ; une seule clé networks à la racine et dans cockpit", () => {
    const complet = parseYaml(COMPOSE_TEXTE, { merge: true, uniqueKeys: true }) as ComposeLu;
    assert.deepEqual(Object.keys(complet.services).sort(), ["cockpit", "egress", "omo-init", "opencode", "opencode-omo"]);
    const sansProfil = Object.fromEntries(Object.entries(complet.services).filter(([, s]) => !(s.profiles ?? []).includes("omo")));
    assert.deepEqual(Object.keys(sansProfil).sort(), ["cockpit", "opencode"]);
    // Tout réseau cité, avec ou sans le profil, est déclaré une fois à la racine.
    for (const services of [complet.services, sansProfil]) {
      for (const [nom, service] of Object.entries(services)) {
        for (const reseau of reseauxDe(service)) assert.ok(reseau === "default" || Object.hasOwn(complet.networks ?? {}, reseau), `${nom} : ${reseau}`);
      }
    }
    assert.equal((COMPOSE_TEXTE.match(/^networks:$/gm) ?? []).length, 1);
    const blocCockpit = COMPOSE_TEXTE.slice(COMPOSE_TEXTE.indexOf("\n  cockpit:\n"), COMPOSE_TEXTE.indexOf("\n  # --- Salle Oh My OpenAgent"));
    assert.equal((blocCockpit.match(/^ {4}networks:/gm) ?? []).length, 1);
    // Témoin : la fusion automatique de GF1 (seconde clé networks) est refusée par la même lecture.
    assert.throws(() => parseYaml(`${COMPOSE_TEXTE}\nnetworks:\n  omo-internal:\n    internal: true\n`, { merge: true, uniqueKeys: true }), /unique/i);
  });

  it("T-S5 : réseaux — interne = {cockpit, opencode}, omo-internal = {cockpit, egress, opencode-omo} ; NO_PROXY d'opencode sans la salle, celui de la salle avec 0.0.0.0 et egress", () => {
    const c = parseYaml(COMPOSE_TEXTE, { merge: true }) as ComposeLu;
    const membres = (reseau: string) =>
      Object.entries(c.services)
        .filter(([, service]) => reseauxDe(service).includes(reseau))
        .map(([nom]) => nom)
        .sort();
    assert.deepEqual(membres("interne"), ["cockpit", "opencode"]);
    assert.deepEqual(membres("omo-internal"), ["cockpit", "egress", "opencode-omo"]);
    assert.equal(c.networks?.interne?.internal, true);
    assert.equal(c.networks?.["omo-internal"]?.internal, true);
    assert.ok(!reseauxDe(c.services.opencode).includes("omo-internal"), "opencode jamais sur le réseau de la salle");
    assert.deepEqual(reseauxDe(c.services["opencode-omo"]), ["omo-internal"], "la salle ni sur interne ni sur default");
    const liste = (service: string, cle: string) => String(c.services[service]?.environment?.[cle] ?? "").split(",");
    for (const cle of ["NO_PROXY", "no_proxy"]) {
      const oc = liste("opencode", cle);
      assert.ok(oc.includes("0.0.0.0"), cle);
      assert.ok(!oc.includes("opencode-omo") && !oc.includes("egress"), `${cle} : ${oc.join(",")}`);
    }
    const salle = liste("opencode-omo", "NO_PROXY");
    assert.ok(salle.includes("0.0.0.0") && salle.includes("egress"), salle.join(","));
    assert.ok(!salle.includes("opencode"), salle.join(","));
  });

  it("T-S6 : NO_PROXY du cockpit garde opencode-omo et egress (sinon NODE_USE_ENV_PROXY enverrait le mot de passe de la salle au proxy de l'entreprise)", () => {
    const c = parseYaml(COMPOSE_TEXTE, { merge: true }) as ComposeLu;
    const cockpit = c.services.cockpit?.environment ?? {};
    assert.equal(cockpit.NODE_USE_ENV_PROXY, "1");
    const hotes = String(cockpit.NO_PROXY).replace(/\$\{[^}]*\}*/g, "").split(",");
    for (const nom of ["opencode-omo", "egress", "opencode", "cockpit", "localhost", "127.0.0.1"]) assert.ok(hotes.includes(nom), nom);
  });

  it("T-S8 : egressAllow (salle) et decideConnect (relais) — mêmes décisions et mêmes raisons sur un corpus hostile ; écarts figés, tous fermés côté salle ; vecteurs GHE", () => {
    const PERMIS = "api.githubcopilot.com";
    const KELVIN = String.fromCharCode(0x212a);
    const corpus = [
      "api.githubcopilot.com:443",
      "API.GitHubCopilot.COM:443",
      "api.githubcopilot.com.:443",
      "api.githubcopilot.com..:443",
      "api.githubcopilot.com:80",
      "api.githubcopilot.com:8443",
      "api.githubcopilot.com",
      "api.githubcopilot.com:",
      "api.githubcopilot.com:0443",
      "api.githubcopilot.com:99999",
      "api.github.com:443",
      "github.com:443",
      "models.opencode.ai:443",
      "registry.npmjs.org:443",
      "api.githubcopilot.com.evil.test:443",
      "evil.api.githubcopilot.com:443",
      `api.githubcopilot.${KELVIN}om:443`,
      `${KELVIN}.githubcopilot.com:443`,
      "127.0.0.1:443",
      "127.1:443",
      "2130706433:443",
      "0x7f.1:443",
      "10.0.0.1.:443",
      "[::1]:443",
      "::1:443",
      "[fe80::1%25eth0]:443",
      "user:pass@api.githubcopilot.com:443",
      "api.githubcopilot.com/chemin:443",
      "https://api.githubcopilot.com:443",
      "localhost:443",
      "api-.githubcopilot.com:443",
      "-api.githubcopilot.com:443",
      `${"a".repeat(64)}.githubcopilot.com:443`,
      "api.githubcopilot.com :443",
      ":443",
      "",
    ];
    /** Écarts connus, figés : la salle refuse ce que le relais accepte, ou refuse pour une autre raison ; jamais l'inverse. */
    const ECARTS: Record<string, { salle: string; relais: string }> = {
      // Point final : le relais tolère UN point final et fait sortir le nom canonique (1.0.6) ; egress le refuse (plus fermé).
      "api.githubcopilot.com.:443": { salle: "invalide", relais: "ok" },
      // Nom d'une seule étiquette : refusé des deux côtés, « hote » pour egress, « invalide » pour le relais (deux étiquettes au moins).
      "localhost:443": { salle: "hote", relais: "invalide" },
    };
    for (const cible of corpus) {
      const { hote, port } = decoupeCibleConnect(cible);
      const salle = egressAllow(hote, port, PERMIS);
      const relais = decideConnect(cible, new Set([PERMIS]));
      const vu = { salle: salle.autorise ? "ok" : salle.raison, relais: relais.allow ? "ok" : relais.reason };
      assert.deepEqual(vu, ECARTS[cible] ?? { salle: vu.relais, relais: vu.relais }, JSON.stringify(cible));
      if (vu.salle === "ok") assert.equal(vu.relais, "ok", `${JSON.stringify(cible)} : la salle jamais plus ouverte que le relais`);
      const coupe = splitConnectTarget(cible);
      assert.deepEqual([hote, port], [coupe.host, coupe.port], `découpage de ${JSON.stringify(cible)}`);
    }

    // Vecteurs GHE : hôte d'API d'egress (lu dans SON environnement) et hôtes du relais (lus par le cockpit, loadEnv, I10).
    const vecteurs: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ["https://api.business.githubcopilot.com", undefined],
      ["https://copilot-api.entreprise.ghe.com", "entreprise.ghe.com"],
      ["https://copilot-api.entreprise.ghe.com", "Entreprise.GHE.com"],
      ["https://copilot-api.entreprise.ghe.com", "https://entreprise.ghe.com/"],
      ["https://copilot-api.entreprise.ghe.com", " entreprise.ghe.com "],
      ["https://copilot-api.entreprise.ghe.com", "entreprise.ghe.com."],
      [undefined, "entreprise.ghe.com"],
    ];
    for (const [url, domaine] of vecteurs) {
      const salle = hoteAutoriseDeLEnvironnement({ COCKPIT_COPILOT_API_URL: url, COCKPIT_GITHUB_ENTERPRISE_DOMAIN: domaine });
      const d = parseGithubEnterpriseDomain(domaine);
      const relais = egressAllowedHosts({ copilotApiUrl: parseCopilotApiUrl(url, d), endpointUrl: null, enterpriseDomain: d, loginOpen: false });
      const label = JSON.stringify([url, domaine]);
      assert.ok(salle !== null && relais.has(salle), `${label} : ${salle} / ${[...relais].join(",")}`);
      // Adresse imposée : un seul hôte d'API, le même des deux côtés. Sans elle, egress n'ouvre que l'adresse d'office, celle
      // que la salle appelle (COCKPIT_COPILOT_API_URL d'office dans docker-compose.yml).
      if (url !== undefined) assert.deepEqual([...relais], [salle], label);
    }
    // Domaine refusé par le cockpit (qui ne démarre pas) : egress ne laisse rien sortir non plus.
    assert.throws(() => parseGithubEnterpriseDomain("10.0.0.1"));
    assert.equal(hoteAutoriseDeLEnvironnement({ COCKPIT_GITHUB_ENTERPRISE_DOMAIN: "10.0.0.1" }), null);
  });

  it("T-S9 : arrêt de la salle quand GET /permission échoue (option permissionListeRejetee, passée explicitement) — sessions arrêtées, aucune demande acceptée, une ligne d'avertissement ; comportement actuel figé", async (t) => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-v106-arret-")));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const dossier = (nom: string) => {
      const complet = path.join(tmp, nom);
      fs.mkdirSync(complet, { recursive: true });
      return complet;
    };
    const workspace = dossier("workspace");
    dossier("workspace/app");
    const controlDir = dossier("control-omo");
    const stateDir = dossier("omo-state");
    const control = createOmoControl({
      controlDir,
      stateDir,
      authDir: dossier("omo-auth"),
      opencodeDataDir: dossier("oc-data"),
      cockpitDataDir: dossier("donnees-cockpit"),
      projectsFile: null,
      actif: () => true,
      log: createLogger("error"),
    });
    t.after(async () => {
      control.stopHeartbeat();
      await control.settled();
    });
    const START = "0f5c3b1e-1111-4111-8111-00000000f106";
    const etat: OmoSupervisorState = {
      startId: START,
      phase: "opencode-lance",
      imageId: "",
      manifestSha256: "",
      manifesteReference: "ok",
      validation: "ok",
      dossiersConfig: [{ chemin: "/home/node/.omo", ok: true }],
      projets: [{ chemin: "app", gitLectureSeule: true }],
      workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
      startedAt: 1,
    };
    const publier = (valeur: OmoSupervisorState) => fs.writeFileSync(path.join(stateDir, "state.json"), ecrireEtat(valeur));
    // Superviseur simulé par la pause de la sonde : dès que stop-request existe, state.json passe en phase « arret ».
    const superviseur = async () => {
      if (fs.existsSync(path.join(controlDir, "stop-request"))) publier({ ...etat, phase: "arret" });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    };
    const racines = new Set<string>();
    const omoRoom: OmoRoomPort = { open: async () => assert.fail(), status: async () => assert.fail(), openProjects: () => ["app"], isRoomRoot: (id) => racines.has(id) };
    const omoActivation: OmoActivationPort = {
      view: async () => null,
      put: async () => assert.fail("activation inattendue"),
      consume: async () => assert.fail("envoi inattendu"),
      activeRequest: () => null,
      endRequest: () => undefined,
    };
    const arretReel = creerModuleOmoStop({ sleep: superviseur });
    const moduleArret: Cockpit11Module = { name: "omoStop", install: (reg, c11) => arretReel.install(reg, { ...c11, salleOuverte: true }) };
    const journal: string[] = [];
    const h = await startCockpit(t, {
      omo: true,
      modules: ["floors", moduleArret],
      ports: { omoControl: control, omoRoom, omoActivation },
      env: { workspaceDir: workspace },
      log: createLogger("warn", (ligne) => void journal.push(ligne)),
    });
    const omo = h.omo;
    assert.ok(omo);
    const DIR = `${OC}/app`;
    const URL_DOC = "https://exemple.test/doc";
    const racine = await omo.deps.client.request<FakeSession>("POST", "/session", { directory: DIR, body: { title: "app" } });
    await until(() => h.sessions.get(racine.id)?.instance === "omo");
    h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'app', 1)").run(racine.id);
    racines.add(racine.id);
    // Demande webfetch sans délai : ses métadonnées n'ont pas de `timeout`, la liste de ce dossier est rejetée (mesure D11).
    const depuis = omo.fake.emitted.length;
    omo.fake.script(racine.id, {
      tools: [
        {
          tool: "webfetch",
          input: { url: URL_DOC, format: "markdown" },
          ask: { permission: "webfetch", patterns: [URL_DOC], always: ["*"], metadata: { url: URL_DOC, format: "markdown" } },
          output: "contenu",
        },
      ],
    });
    assert.equal(await promptAsync(omo.deps.client, racine.id, "Travaille."), 204);
    const demande = (await omo.fake.waitForEvent("permission.asked", (p) => p.sessionID === racine.id, { since: depuis })).properties as unknown as FakePermissionRequest;
    await until(() => omo.fake.statusOf(racine.id).type === "busy");
    // Option du faux passée EXPLICITEMENT : elle reste désactivée par défaut (A32).
    omo.fake.permissionListeRejetee = true;
    publier(etat);
    h.db.prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id) VALUES (1, '', '', '[]', '', ?)").run(START);
    const repere = omo.fake.requests.length;

    const resultat = await within(h.cockpit.c11.ports.omoStop.run(racine.id, "vous"), "arrêt de la salle", 10_000);

    const pendant = requetesDe(omo.fake.requests, repere);
    assert.ok(pendant.includes("GET /permission"), "la liste des demandes a été lue (et rejetée)");
    assert.deepEqual(
      omo.fake.requests.slice(repere).filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/")),
      [],
      "aucune réponse envoyée : ni accord, ni refus (liste illisible)",
    );
    assert.equal(resultat.rejected, 0);
    assert.ok(resultat.aborted.includes(racine.id), JSON.stringify(resultat));
    assert.ok(pendant.includes(`POST /session/${racine.id}/abort`), pendant.join("\n"));
    await within(omo.fake.settled(racine.id), "racine de la salle arrêtée");
    const avertissements = journal.filter((ligne) => ligne.includes("arrêt de la salle : demandes d'autorisation illisibles"));
    assert.equal(avertissements.length, 1, journal.join(""));
    assert.ok(fs.existsSync(path.join(controlDir, "stop-request")), "salle relancée à neuf (stop-request écrit)");
    assert.notEqual(demande.id, "");
  });
});
// </gf1:v106>

// <gf2:v106>
// --- Grande fusion, GF2 : 3D × 1.0.6 (fiche-fusion-v106 §4) -------------------------------------------------------------------
// La 3D n'ajoute qu'un appel à opencode avec un dossier : GET /session/status {directory} des territoires (territoires-service.ts),
// sur les dossiers des racines récentes filtrés par projects.isAllowedDirectory (refus %XX de la 1.0.6). « Revoir » et ses
// consignes gardées ne parlent jamais à opencode. Câblage complet (modules « tous »), faux à double décodage.

/** Racine de conversation récente posée en base, comme une conversation héritée d'une version antérieure, dans `directory`. */
function racineRecente(h: CockpitHarness, id: string, directory: string): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'chat', 'principale', ?, ?)",
    )
    .run(id, id, directory, "[synthétique] conversation héritée", maintenant, maintenant);
}

const RACINE_PIEGE = "ses_gf2_piege";
const racineLegitime = (index: number) => `ses_gf2_legitime_${index}`;

describe("croisements v106 <gf2:v106> : 3D × 1.0.6 (fiche §4)", () => {
  it("T-3D1 : racine au dossier %XX → absente des territoires, aucun GET /session/status avec ce dossier ; noms légitimes interrogés à l'octet", async (t) => {
    const { h } = await start(t, { modules: "tous" });
    racineRecente(h, RACINE_PIEGE, TRAP_DIR);
    LEGIT.forEach((nom, index) => racineRecente(h, racineLegitime(index), dirOf(nom)));
    const avant = h.fake.requests.length;
    const usageAvant = usageRows(h);

    const reponse = await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed });
    assert.equal(reponse.status, 200, reponse.body);
    const vue = reponse.json<TerritoiresResponse>();
    const territoires = [...vue.projets, ...(vue.salle?.projets ?? [])];
    const racines = territoires.flatMap((territoire) => territoire.conversations.map((c) => c.rootId));
    assert.equal(racines.includes(RACINE_PIEGE), false, "une racine au dossier %XX n'est jamais un territoire");
    assert.equal(
      territoires.some((territoire) => PERCENT.test(territoire.projet)),
      false,
      "aucun territoire au nom %XX (projets du workspace filtrés comme les racines)",
    );
    for (const [index, nom] of LEGIT.entries()) {
      const territoire = vue.projets.find((candidat) => candidat.projet === nom);
      assert.ok(territoire, `territoire « ${nom} »`);
      assert.deepEqual(
        territoire.conversations.map((c) => c.rootId),
        [racineLegitime(index)],
      );
    }
    const statuts = h.fake.requests.slice(avant).filter((r) => r.method === "GET" && r.pathname === "/session/status");
    assert.deepEqual(statuts.map((r) => r.query.directory ?? "").sort(), LEGIT.map(dirOf).sort(), "un statut par dossier légitime, à l'octet");
    assert.deepEqual(
      h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`),
      statuts.map(() => "GET /session/status"),
      "aucune autre requête",
    );
    assert.equal(usageRows(h), usageAvant);
    assertSentinel(h, "T-3D1");
  });

  it("T-3D2 : « Revoir » (route, état, consigne, consignes d'un enfant) → zéro requête à opencode, racine %XX comprise, avec le faux à double décodage", async (t) => {
    const { h } = await start(t, { modules: "tous" });
    const legitime = await conversation(h, dirOf("Remise 20%"), "Remise");
    racineRecente(h, RACINE_PIEGE, TRAP_DIR);
    const store = createConsignesStore(h.db);
    for (const rootId of [legitime.id, RACINE_PIEGE]) {
      assert.equal(store.enregistrer({ rootId, parent: rootId, enfant: "ses_gf2_enfant", callId: "call_gf2", brut: "[synthétique] consigne", at: 1 }), "enregistree");
    }
    const avant = h.fake.requests.length;
    const usageAvant = usageRows(h);

    for (const rootId of [legitime.id, RACINE_PIEGE]) {
      const revoir = await h.call("GET", `/api/revoir/${rootId}`, { headers: h.headers.authed });
      assert.equal(revoir.status, 200, revoir.body);
      assert.equal(revoir.json<RevoirResponse>().instance, "principale");
      const etat = await h.call("GET", `/api/revoir/${rootId}?etat=1`, { headers: h.headers.authed });
      assert.equal(etat.json<RevoirEtatResponse>().acces, true);
      const consigne = await h.call("GET", `/api/revoir/${rootId}/consignes/call_gf2`, { headers: h.headers.authed });
      assert.equal(consigne.status, 200, consigne.body);
      const parEnfant = await h.call("GET", `/api/revoir/${rootId}/consignes?enfant=ses_gf2_enfant`, { headers: h.headers.authed });
      assert.equal(parEnfant.json<RevoirConsignesEnfantResponse>().consignes.length, 1);
    }
    assert.deepEqual(
      h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`),
      [],
      "« Revoir » ne parle jamais à opencode",
    );
    assert.equal(usageRows(h), usageAvant, "aucune ligne usage pendant « Revoir »");
    assertSentinel(h, "T-3D2");
  });
});
// </gf2:v106>
