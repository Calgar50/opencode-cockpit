// Tests de croisement 1.1 × 1.0.6 (R106-a ; fiche-fusion-v106 §9.3, décisions A22, A29 et D3) : sentinelle d'instance.
// Le faux opencode décode `directory` deux fois, comme opencode 1.18.30 : un dossier nommé « a%2F..%2F..%2Fsecret » y ouvre
// l'instance « /secret ». Chaque famille de routes du cockpit qui transmet un dossier à opencode, ou qui le lit pour décider, est
// jouée avec ce dossier piège ET avec des noms légitimes (« Remise 20% », accents, « & », « + »). Attendu, toujours :
// - dossier piège : refus, aucune requête dont le dossier porte une séquence %XX, aucune ligne `usage` ;
// - noms légitimes : relayés à l'octet, instance ouverte dans ce dossier ;
// - aucune instance hors de /workspace (fake.instancesHors ; le harnais le revérifie au nettoyage de chaque test).
// Sections que chaque fusion ajoute ici (fiche §3.10 à §8) : <gf1:v106>, <gf2:v106>, <gf3:v106>, <gf4:v106>, L39o, <gf5:v106> (GF5 :
// arrêt de l'arbre, table des attentes, suppression), NAV.
// L39o : sa sentinelle T-L39 est dans agent-map-omo.test.ts (fiche §7 et tableau du §11), avec ce même faux à double décodage
// (train de V2 de F2) ; aucune section ici.
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
import { capWatchModuleWith } from "./autonomy-watch.ts";
import { createConsignesStore } from "./consignes-store.ts";
import type { ActivationPort, Cockpit11, Cockpit11Module, ControlAiInput, ConversationAutonomyPort, RequestsPort } from "./contracts-11.ts";
import { CONTROL_AGENT_PROMPT, createControlAiModule } from "./control-ai.ts";
import { collectEditFacts } from "./edit-facts.ts";
import { decideConnect, egressAllowedHosts, type LoginWindow, splitConnectTarget } from "./egress-policy.ts";
import { hoteAutoriseDeLEnvironnement } from "./egress-proxy.ts";
import { parseCopilotApiUrl, parseGithubEnterpriseDomain } from "./env.ts";
import { forbiddenCommandArguments, forbiddenProxyBody, PERMISSION_MESSAGES } from "./http.ts";
// <gf5:d11>
import { OpencodeError } from "./opencode.ts";
import { phraseListeIllisible } from "./shared/attentes-texts.ts";
// </gf5:d11>
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
// <gf3:v106> début : équipes × 1.0.6 (fiche-fusion-v106 §5)
import type { Flow, TeamEstimateResponse, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import { exampleById, exampleFlow } from "./team-examples.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { EQ_MODULES } from "./wiring-eq.ts";
// </gf3:v106> fin
// <gf4:v106> début : construction × 1.0.6 (fiche-fusion-v106 §6)
import { SECOND_READING_CATALOG_ID } from "./shared/construction-constants.ts";
import type { FlowStep } from "./shared/team-types.ts";
// </gf4:v106> fin
// <nav:v106>
import { FICHIERS_ROUTES } from "./shared/fichiers-regles.ts";
// </nav:v106>

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

// --- GET /permission rejeté par opencode 1.18.30 (fiche §10.3, A23, A31 a) : corrigé par GF5 (table des attentes, D11) -------------
// Option `permissionListeRejetee` du faux, VRAIE PAR DÉFAUT depuis GF5 (A32 (4)) : GET /permission répond 400 (« schema rejection »)
// tant qu'une demande de l'instance a un argument facultatif omis recopié dans ses métadonnées (METADONNEES_FACULTATIVES : webfetch
// sans timeout, glob ou grep sans path, etc. ; jamais bash), comme opencode 1.18.30 réel (mesure D11, A31). Ces trois tests
// figeaient l'état défectueux (R106-a) ; GF5 les RETOURNE : avec la table des attentes (module « pending »), le « once », la
// décision automatique et l'arrêt passent. Les TÉMOINS « table non fiable → 503 » sont gardés : sans table, ou flux coupé depuis la
// dernière lecture, rien n'est deviné (503 « liste-bloquee », phrase dédiée), et le refus reste relayé.

describe("croisements v106 : GET /permission rejeté par opencode (option permissionListeRejetee) — corrigé à GF5 (D11, table des attentes)", () => {
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
    await h.processor.settled();
    return { session, asked: event.properties as unknown as FakePermissionRequest };
  }

  it("« once » RELAYÉ (table fiable) : liste des approbations servie (200, forme d'opencode) ; « once » sur le bash d'une autre conversation ET sur le webfetch ; témoins sans table : 503 « liste-bloquee », rien relayé, refus relayé", async (t) => {
    const { h } = await start(t, { modules: ["pending"] });
    assert.equal(h.fake.permissionListeRejetee, true, "option du faux posée par défaut (A32 (4))");
    const dir = dirOf("proj");
    const web = await waitingFor(h, dir, "Web", webfetch);
    const autre = await waitingFor(h, dir, "Commande", bash("ls -la"));
    await h.attentesAuRepos();
    // Le faux rejette bien la liste de l'instance (poison webfetch sans délai), comme opencode 1.18.30.
    await assert.rejects(h.deps.client.request("GET", "/permission", { query: { directory: dir } }), (err) => err instanceof OpencodeError && err.status === 400);

    // Liste des approbations (ChatPage : oc.permissions) : la table, au format d'opencode, à la place du 400.
    const list = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(list.status, 200, list.body);
    assert.deepEqual(list.json(), JSON.parse(JSON.stringify(h.fake.pendingPermissions())), "même forme et même ordre que la liste d'opencode");

    const answer = (id: string, reply: string) => h.call("POST", `/api/oc/permission/${id}/reply?directory=${q(dir)}`, { headers: h.headers.mutating, body: { reply } });
    const onceBash = await answer(autre.asked.id, "once");
    assert.equal(onceBash.status, 200, onceBash.body);
    await within(h.fake.settled(autre.session.id), "commande exécutée");
    const onceWeb = await answer(web.asked.id, "once");
    assert.equal(onceWeb.status, 200, onceWeb.body);
    await within(h.fake.settled(web.session.id), "page lue");
    assert.deepEqual(
      replies(h).map((r) => r.body),
      [{ reply: "once" }, { reply: "once" }],
    );
    assertSentinel(h, "once relayé");

    // TÉMOIN « table non fiable → 503 » : cockpit sans le module « pending » (aucune table), même poison.
    const temoin = await start(t);
    const poison = await waitingFor(temoin.h, dir, "Web", webfetch);
    const liste = await temoin.h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: temoin.h.headers.authed });
    assert.equal(liste.status, 503, liste.body);
    assert.deepEqual(liste.json(), { error: "liste-bloquee", message: phraseListeIllisible("web"), outil: "web" });
    const once = await temoin.h.call("POST", `/api/oc/permission/${poison.asked.id}/reply?directory=${q(dir)}`, { headers: temoin.h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 503, once.body);
    assert.deepEqual(once.json(), { error: "liste-bloquee", message: PERMISSION_MESSAGES.listeBloquee, outil: "web" });
    assert.notEqual(PERMISSION_MESSAGES.listeBloquee, PERMISSION_MESSAGES.verificationImpossible, "jamais « opencode ne répond pas »");
    assert.deepEqual(replies(temoin.h), [], "« once » jamais relayé sans table fiable");
    const reject = await temoin.h.call("POST", `/api/oc/permission/${poison.asked.id}/reply?directory=${q(dir)}`, { headers: temoin.h.headers.mutating, body: { reply: "reject" } });
    assert.equal(reject.status, 200, reject.body);
    assert.deepEqual(
      replies(temoin.h).map((r) => r.body),
      [{ reply: "reject" }],
    );
    await within(temoin.h.fake.settled(poison.session.id), "réponse close par le refus");
    const guerie = await temoin.h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: temoin.h.headers.authed });
    assert.equal(guerie.status, 200, "un refus guérit la liste (mesure D11, S3)");
  });

  it("TÉMOIN « flux coupé depuis la dernière lecture » : table non fiable → 503 « liste-bloquee » et nouveau message ; le refus guérit, la liste repasse à 200", async (t) => {
    const { h } = await start(t, { modules: ["pending"] });
    const dir = dirOf("proj");
    const web = await waitingFor(h, dir, "Web", webfetch);
    await h.attentesAuRepos();
    const avant = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(avant.status, 200, "table fiable avant la coupure");
    h.fake.disconnectStreams();
    await until(() => h.processor.status.connected === false || h.cockpitEvents().some((e) => e.type === "opencode.connection" && (e.data as { connected?: boolean }).connected === false));
    await until(() => h.processor.status.connected, 10_000);
    await h.attentesAuRepos();
    const apres = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(apres.status, 503, `reconnexion : la relecture proactive échoue sur le poison, rien n'est deviné (${apres.body})`);
    const once = await h.call("POST", `/api/oc/permission/${web.asked.id}/reply?directory=${q(dir)}`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 503, once.body);
    assert.equal(once.json<{ error: string }>().error, "liste-bloquee");
    assert.deepEqual(replies(h), [], "rien relayé");
    const reject = await h.call("POST", `/api/oc/permission/${web.asked.id}/reply?directory=${q(dir)}`, { headers: h.headers.mutating, body: { reply: "reject" } });
    assert.equal(reject.status, 200, reject.body);
    await within(h.fake.settled(web.session.id), "réponse close par le refus");
    const guerie = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(guerie.status, 200, guerie.body);
  });

  it("autonomie : décision automatique (grep) RELAYÉE malgré un webfetch sans délai en attente dans le même dossier (journal « auto », relais « ok »)", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const { h } = await start(t, {
      modules: ["pending", "autonomy", "requests", "facts", "floors"],
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
    const web = await waitingFor(h, dir, "Demander", webfetch);
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
      10_000,
    );
    assert.deepEqual({ ...decision }, { verdict: "auto", regle: "A-grep", par: "regles", relais: "ok" });
    assert.deepEqual(
      replies(h)
        .filter((r) => r.pathname.includes(asked.id))
        .map((r) => r.body),
      [{ reply: "once" }],
      "« once » envoyé par l'autonomie",
    );
    await within(h.fake.settled(auto.id), "réponse autonome terminée");
    assert.ok(
      h.fake.pendingPermissions().some((p) => p.id === web.asked.id),
      "la demande web reste à l'utilisateur",
    );
    assertSentinel(h, "décision automatique");
  });

  it("arrêt par le proxy : la conversation s'arrête ET sa demande orpheline est refusée ; GET /permission du faux repasse à 200 ; témoin sans table : rien refusé", async (t) => {
    const { h } = await start(t, { modules: ["pending"] });
    const dir = dirOf("proj");
    const { session, asked } = await waitingFor(h, dir, "Web", webfetch);
    await h.attentesAuRepos();
    const before = h.fake.requests.length;
    const stopped = await h.call("POST", `/api/oc/session/${session.id}/abort?directory=${q(dir)}`, { headers: h.headers.mutating });
    assert.equal(stopped.status, 200, stopped.body);
    await until(() => replies(h).some((r) => r.pathname === `/permission/${asked.id}/reply`), 5_000);
    assert.deepEqual(
      replies(h).map((r) => r.body),
      [{ reply: "reject" }],
      "orpheline refusée par le nettoyage de l'arrêt",
    );
    assert.deepEqual(h.fake.pendingPermissions(), [], "plus rien en attente");
    assert.ok(h.fake.requests.slice(before).some((r) => r.method === "GET" && r.pathname === "/permission"));
    const liste = await h.call("GET", `/api/oc/permission?directory=${q(dir)}`, { headers: h.headers.authed });
    assert.equal(liste.status, 200, "la liste d'opencode repasse à 200");
    assert.deepEqual(liste.json(), []);

    // TÉMOIN : sans table, l'arrêt ne refuse rien et l'orpheline reste (comportement d'avant GF5, gardé comme témoin).
    const temoin = await start(t);
    const orpheline = await waitingFor(temoin.h, dir, "Web", webfetch);
    const avant = temoin.h.fake.requests.length;
    const arret = await temoin.h.call("POST", `/api/oc/session/${orpheline.session.id}/abort?directory=${q(dir)}`, { headers: temoin.h.headers.mutating });
    assert.equal(arret.status, 200, arret.body);
    await until(() => temoin.h.fake.requests.slice(avant).some((r) => r.method === "GET" && r.pathname === "/permission"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(replies(temoin.h), [], "aucun refus envoyé sans table");
    assert.deepEqual(
      temoin.h.fake.pendingPermissions().map((p) => p.id),
      [orpheline.asked.id],
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
    // gf5:d11 : relecture proactive de la table des attentes (première apparition du dossier), déclenchée par la création ci-dessus.
    await h.attentesAuRepos();
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

// <gf3:v106>
// --- Grande fusion, GF3 : équipes × 1.0.6 (fiche-fusion-v106 §5) ------------------------------------------------------------------
// Les équipes transmettent un dossier à opencode par le pré-lancement (estimation), le runner (sessions d'étape) et la carte ; tous
// héritent du refus %XX d'isAllowedDirectory. Ici, le câblage complet (modules « tous », les cinq modules d'équipes réels, option
// `omo` : les DEUX instances sont comptées), le faux à double décodage, et l'équipe « Revue SQL sur réplica » posée en base.

const EQUIPE = "revue-sql";

/** Équipe posée en base (déroulé de l'exemple de L37a), son assistant déclaré au faux, que le vrai pré-lancement relit. */
function equipePosee(h: CockpitHarness): Flow {
  const exemple = exampleById(EQUIPE);
  assert.ok(exemple, "exemple « revue-sql » absent du catalogue");
  const flow = exampleFlow(exemple, new Map());
  h.db
    .prepare("INSERT INTO teams (id, titre, description, flow, origine, created_at, updated_at) VALUES (?, ?, '', ?, 'creee', 1, 1)")
    .run(EQUIPE, "[synthétique] Revue SQL", JSON.stringify(flow));
  const assistants = new Set(flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : [])).map((e) => e.assistant));
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const lecture = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
  ] as FakeAgent["permission"];
  const nouveaux: FakeAgent[] = [...assistants]
    .filter((nom) => !connus.has(nom))
    .map((name) => ({ name, mode: "all", description: name, model: MODEL, options: {}, permission: lecture, steps: 20 }));
  h.fake.setAgents([...h.fake.agents(), ...nouveaux]);
  return flow;
}

async function demarrerEquipes(t: TestContext, options: CockpitHarnessOptions = {}): Promise<{ h: CockpitHarness; omo: NonNullable<CockpitHarness["omo"]> }> {
  const { h } = await start(t, {
    settings: { ui: { mode: "avance" } },
    modules: "tous",
    omo: true,
    equipes: [EQ_MODULES.agentMap, EQ_MODULES.teams, EQ_MODULES.teamPreflight, createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }), EQ_MODULES.teamGuards],
    ...options,
  });
  assert.ok(h.omo, "option « omo » du harnais");
  equipePosee(h);
  return { h, omo: h.omo };
}

/** Rien reçu par les DEUX instances pendant `appel` (le sondage GET /session/status de la 1.1, qui tourne seul, est écarté). */
async function sansRequete<T>(h: CockpitHarness, omo: NonNullable<CockpitHarness["omo"]>, label: string, appel: () => Promise<T>): Promise<T> {
  const principale = h.fake.requests.length;
  const salle = omo.fake.requests.length;
  const resultat = await appel();
  const utiles = (liste: ReadonlyArray<{ method: string; pathname: string }>, depuis: number) =>
    liste.slice(depuis).filter((r) => !(r.method === "GET" && r.pathname === "/session/status")).map((r) => `${r.method} ${r.pathname}`);
  assert.deepEqual(utiles(h.fake.requests, principale), [], `${label} : requête à l'instance principale`);
  assert.deepEqual(utiles(omo.fake.requests, salle), [], `${label} : requête à la salle`);
  return resultat;
}

const lancementsEnBase = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n;

async function vueDuLancement(h: CockpitHarness, runId: string, predicat: (v: TeamRunView) => boolean, label: string): Promise<TeamRunView> {
  const limite = Date.now() + 10_000;
  for (;;) {
    const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const vue = res.json<TeamRunView>();
    if (predicat(vue)) return vue;
    assert.ok(Date.now() < limite, `${label} : état ${vue.state}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Les avis parallèles de l'exemple tous « en-cours » ET leur message reçu par le faux. Le runner passe une étape « en-cours »
 * AVANT son `prompt_async` (transition bloquante, D-eq-06) : attendre une seule étape laissait les envois de ses sœurs tomber
 * dans la fenêtre mesurée par `sansRequete` (course vue à l'intégration de F2, vague 0 : T-EQ2 rouge 2 fois sur 40 sous charge).
 */
async function avisEnvoyes(h: CockpitHarness, runId: string): Promise<TeamRunView> {
  const bloc = exampleById(EQUIPE)?.flow.blocs.find((b) => b.type === "avis");
  const attendus = bloc?.type === "avis" ? bloc.avis.length : 0;
  assert.ok(attendus > 1, "l'exemple « revue-sql » a des avis parallèles");
  return vueDuLancement(
    h,
    runId,
    (v) => {
      const envoyees = v.steps.filter((s) => s.state === "en-cours" && s.sessionId !== null);
      return (
        envoyees.length === attendus &&
        envoyees.every((s) => h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/session/${s.sessionId}/prompt_async`))
      );
    },
    "avis envoyés",
  );
}

/** Lancement réel dans `directory` ; chaque étape reste en cours (outil qui ne rend jamais la main) si `bloquee`. */
async function lancerDans(h: CockpitHarness, directory: string, bloquee: boolean): Promise<TeamRunStarted & { estimateSha256: string }> {
  h.fake.scriptWhen(
    (s) => (s.metadata as { cockpit?: string } | undefined)?.cockpit === "equipe",
    bloquee
      ? { tools: [{ tool: "read", input: { filePath: `${directory}/a.txt` }, beforeAsk: () => new Promise<void>(() => undefined) }], stepMs: 1 }
      : { text: "[synthétique] Constat.", cost: 0.01, stepMs: 5 },
  );
  const estimation = await h.call("POST", `/api/teams/${EQUIPE}/estimate`, { headers: h.headers.mutating, body: { directory, rootId: null } });
  assert.equal(estimation.status, 200, estimation.body);
  const { estimateSha256 } = estimation.json<TeamEstimateResponse>();
  const run = await h.call("POST", `/api/teams/${EQUIPE}/run`, {
    headers: h.headers.mutating,
    body: { directory, rootId: null, demande: "[synthétique] Relis la requête.", fichiers: [], agentConversation: "build", estimateSha256, confirmations: {} },
  });
  assert.equal(run.status, 202, run.body);
  return { ...run.json<TeamRunStarted>(), estimateSha256 };
}

describe("croisements v106 <gf3:v106> : équipes × 1.0.6 (fiche §5)", () => {
  it("T-EQ1 : estimation, lancement et relance avec un dossier %XX → 403 forbidden-directory, zéro requête aux deux instances, aucune ligne team_runs", async (t) => {
    const { h, omo } = await demarrerEquipes(t);
    const corps = { directory: TRAP_DIR, rootId: null, demande: "[synthétique] Relis.", fichiers: [], agentConversation: "build", estimateSha256: "a".repeat(64), confirmations: {} };
    const avant = lancementsEnBase(h);
    assertForbidden(
      await sansRequete(h, omo, "estimation", () => h.call("POST", `/api/teams/${EQUIPE}/estimate`, { headers: h.headers.mutating, body: { directory: TRAP_DIR, rootId: null } })),
      "POST …/estimate",
    );
    assertForbidden(await sansRequete(h, omo, "lancement", () => h.call("POST", `/api/teams/${EQUIPE}/run`, { headers: h.headers.mutating, body: corps })), "POST …/run");
    assert.equal(lancementsEnBase(h), avant, "aucune ligne team_runs pour un dossier %XX");

    // Relance d'un lancement hérité au dossier %XX (ligne d'une base d'avant la 1.0.6) : estimation et relance refusées.
    const { runId } = await lancerDans(h, dirOf("proj"), true);
    await avisEnvoyes(h, runId);
    const eq = h.cockpit.equipes.eq;
    eq.ports.runner.interrupt(runId, "rechargement");
    await vueDuLancement(h, runId, (v) => v.relancable, "lancement relançable");
    h.db.prepare("UPDATE team_runs SET directory = ? WHERE id = ?").run(TRAP_DIR, runId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lignes = lancementsEnBase(h);
    assertForbidden(
      await sansRequete(h, omo, "estimation de relance", () => h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} })),
      "POST /api/team-runs/:id/estimate",
    );
    assertForbidden(
      await sansRequete(h, omo, "relance", () => h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: "a".repeat(64) } })),
      "POST /api/team-runs/:id/relancer",
    );
    assert.equal(lancementsEnBase(h), lignes);
    assertSentinel(h, "T-EQ1");
  });

  it("T-EQ2 : équipe en cours + PUT /api/studio/instructions?project=<%XX> → 403 (pas 409), zéro requête ; un projet légitime reçoit bien le 409 de la garde", async (t) => {
    const { h, omo } = await demarrerEquipes(t, {
      deps: (base) => ({
        studio: new StudioService({ env: base.env, client: base.client, projects: base.projects, control: base.control, log: base.log, ...(base.configQueue ? { queue: base.configQueue } : {}) }),
      }),
    });
    const { runId } = await lancerDans(h, dirOf("proj"), true);
    await avisEnvoyes(h, runId);
    assert.equal(h.cockpit.c11.reloadBusy(), true, "une étape travaille : la garde de rechargement est occupée");
    const piege = await sansRequete(h, omo, "Studio %XX", () =>
      h.call("PUT", `/api/studio/instructions?project=${q(TRAP)}`, { headers: h.headers.mutating, body: { content: "[synthétique] consignes" } }),
    );
    assertForbidden(piege, "PUT instructions %XX pendant une équipe", "Nom de dossier non pris en charge (séquence %XX).");
    // Témoin : sans séquence %XX, la même écriture bute sur la garde composée (étapes), en 409.
    const legitime = await h.call("PUT", `/api/studio/instructions?project=${q(LEGIT[0])}`, { headers: h.headers.mutating, body: { content: "[synthétique] consignes" } });
    assert.equal(legitime.status, 409, legitime.body);
    await h.call("POST", `/api/team-runs/${runId}/stop`, { headers: h.headers.mutating });
    assertSentinel(h, "T-EQ2");
  });

  it("T-EQ3 : sentinelle d'instance sur un lancement complet dans « Remise 20% » : sessions d'étape créées dans ce dossier, aucune instance hors de /workspace, aucun %XX transmis", async (t) => {
    const { h } = await demarrerEquipes(t);
    const directory = dirOf("Remise 20%");
    const depuis = h.fake.requests.length;
    const { runId } = await lancerDans(h, directory, false);
    const vue = await vueDuLancement(h, runId, (v) => v.state === "terminee", "équipe terminée");
    assert.equal(vue.steps.length, 4);
    for (const step of vue.steps) {
      assert.ok(step.sessionId, `étape ${step.stepId} sans session`);
      assert.equal(h.fake.session(step.sessionId)?.directory, directory, `${step.stepId} : session d'étape créée dans le dossier, à l'octet`);
    }
    // Toute création de session du lancement (racine et étapes) : le dossier transmis tel quel, jamais un autre.
    const creations = h.fake.requests.slice(depuis).filter((r) => r.method === "POST" && r.pathname === "/session");
    assert.ok(creations.length >= vue.steps.length, `créations de session : ${creations.length}`);
    assert.deepEqual(
      [...new Set(creations.map((r) => r.query.directory))],
      [directory],
      "dossier transmis tel quel à chaque création de session du lancement",
    );
    assert.deepEqual(h.fake.instancesHors(), [], "instance hors de /workspace");
    assertSentinel(h, "T-EQ3");
  });

  // Relecture de F2, vague 0 : la liste, l'aperçu, l'enregistrement et l'installation d'un exemple lisent les assistants par
  // assistantsMap (team-service.ts), avec le dossier par défaut des réglages. Ce réglage s'écrit en mode Simple (PUT /api/settings)
  // et peut venir d'une base d'avant la 1.0.6 : il n'est transmis à opencode que s'il passe isAllowedDirectory ; sinon, instance
  // par défaut (aucun paramètre directory).
  it("T-EQ4 : dossier par défaut des réglages %XX ou hors du workspace → GET /api/teams (Simple), aperçu, enregistrement et installation d'un exemple (Avancé) lisent l'instance par défaut ; « Remise 20% » transmis à l'octet", async (t) => {
    const { h, omo } = await demarrerEquipes(t, { settings: { ui: { mode: "simple" } } });
    // Équipe posée = équipe de l'exemple : l'installation, idempotente, relit les assistants sans rien écrire (Studio non appelé).
    h.db.prepare("UPDATE teams SET origine = 'exemple', exemple_id = ?, exemple_version = 1 WHERE id = ?").run(EQUIPE, EQUIPE);
    const flow = JSON.parse((h.db.prepare("SELECT flow FROM teams WHERE id = ?").get(EQUIPE) as { flow: string }).flow) as Flow;
    const lectures = async (label: string): Promise<void> => {
      const liste = await h.call("GET", "/api/teams", { headers: h.headers.authed });
      assert.equal(liste.status, 200, `${label} : GET /api/teams : ${liste.body}`);
      if (h.settings.get().ui.mode !== "avance") return;
      const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow } });
      assert.equal(apercu.status, 200, `${label} : aperçu : ${apercu.body}`);
      const enregistre = await h.call("PUT", "/api/teams/revue-sql-bis", {
        headers: h.headers.mutating,
        body: { titre: "[synthétique] Revue SQL bis", description: "", flow },
      });
      assert.equal(enregistre.status, 200, `${label} : PUT /api/teams/:id : ${enregistre.body}`);
      const installe = await h.call("POST", `/api/teams/examples/${EQUIPE}/install`, { headers: h.headers.mutating, body: {} });
      assert.equal(installe.status, 200, `${label} : installation : ${installe.body}`);
    };

    for (const valeur of [TRAP_DIR, "/etc"]) {
      h.settings.update({ ui: { mode: "simple" } });
      const reglage = await h.call("PUT", "/api/settings", { headers: h.headers.mutating, body: { chat: { defaultDirectory: valeur } } });
      assert.equal(reglage.status, 200, `réglage écrit en Simple : ${reglage.body}`);
      assert.equal(h.settings.get().chat.defaultDirectory, valeur);
      const principale = h.fake.requests.length;
      const salle = omo.fake.requests.length;
      await lectures(`${valeur}, Simple`);
      h.settings.update({ ui: { mode: "avance" } });
      await lectures(`${valeur}, Avancé`);
      assert.deepEqual(
        directoriesSent(h, principale).filter((d) => d === valeur || !h.cockpit.c11.projects.isAllowedDirectory(d)),
        [],
        `${valeur} : dossier refusé transmis à opencode`,
      );
      assert.deepEqual(omo.fake.requests.slice(salle).map((r) => `${r.method} ${r.pathname}`).filter((r) => r !== "GET /session/status"), [], `${valeur} : requête à la salle`);
      assertSentinel(h, `T-EQ4 ${valeur}`);
    }

    // Témoin : un dossier par défaut légitime est transmis tel quel, à l'octet.
    const legitime = dirOf(LEGIT[0]);
    h.settings.update({ chat: { defaultDirectory: legitime } });
    const depuis = h.fake.requests.length;
    await lectures("Remise 20%, Avancé");
    assert.ok(directoriesSent(h, depuis).includes(legitime), `« ${LEGIT[0]} » non transmis : ${JSON.stringify(directoriesSent(h, depuis))}`);
    assertSentinel(h, "T-EQ4 témoin");
  });
});
// </gf3:v106>

// <gf4:v106>
// --- Grande fusion, GF4 : construction × 1.0.6 (fiche-fusion-v106 §6) -------------------------------------------------------------
// La construction ajoute un appel à opencode avec un dossier : l'estimation de la Seconde lecture (second-reading.ts,
// `isAllowedDirectory` avant `lookup.get`). Et la relance d'une relecture commencée, refusée « estimation-perimee » à chaque fois
// jusqu'au reste c2 de GF4 (constats-5b §3), part désormais : elle ne doit rien envoyer pour un dossier non contrôlé. Câblage
// complet (modules « tous », construction comprise ; option `omo` : les DEUX instances comptées), faux à double décodage.

const RELECTEUR_CRITIQUE = "relecteur-critique";
const EQUIPE_RELECTURE = "relecture-v106";
const AUTEUR_V106 = "redacteur-v106";
const RELECTEUR_V106 = "relecteur-v106";

/** Relecteur critique installé (ligne item_meta ET agent vu par opencode) : l'estimation lirait alors les assistants du dossier. */
function relecteurInstalle(h: CockpitHarness): void {
  h.fake.setAgents([...h.fake.agents(), { name: RELECTEUR_CRITIQUE, mode: "primary", description: RELECTEUR_CRITIQUE, model: MODEL, options: {}, permission: [], steps: 20 }]);
  h.deps.lookup.invalidate();
  const now = Date.now();
  h.db
    .prepare(
      `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
       VALUES ('agents', ?, 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
    )
    .run(RELECTEUR_CRITIQUE, SECOND_READING_CATALOG_ID, now, now);
}

/** Équipe « rédaction puis relecture » posée en base, ses deux assistants déclarés au faux (lecture seule, IA propre). */
function relecturePosee(h: CockpitHarness): void {
  const etape = (id: string, titre: string, assistant: string, recoit: FlowStep["recoit"]): FlowStep => ({
    id,
    titre,
    assistant,
    niveau: null,
    taille: "M",
    consigne: `[synthétique] ${titre}.`,
    recoit,
  });
  const flow: Flow = {
    version: 1,
    blocs: [
      {
        type: "relecture",
        id: "rel",
        auteur: etape("redac", "Rédaction", AUTEUR_V106, "demande"),
        relecteur: etape("relec", "Relecture", RELECTEUR_V106, "precedent"),
        toursMax: 2,
        pauseAvantRelecture: false,
      },
    ],
  };
  h.db
    .prepare("INSERT INTO teams (id, titre, description, flow, origine, created_at, updated_at) VALUES (?, ?, '', ?, 'creee', 1, 1)")
    .run(EQUIPE_RELECTURE, "[synthétique] Relecture", JSON.stringify(flow));
  const lecture = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
  ] as FakeAgent["permission"];
  h.fake.setAgents([
    ...h.fake.agents(),
    ...[AUTEUR_V106, RELECTEUR_V106].map((name): FakeAgent => ({ name, mode: "all", description: name, model: MODEL, options: {}, permission: lecture, steps: 20 })),
  ]);
}

/** Sessions d'étape d'UNE étape, d'UN dossier et d'UNE tentative : chaque inscription du faux vaut pour toute session qui lui correspond. */
const etapeDe = (etape: string, directory: string, tentative: number) => (s: FakeSession) => {
  const meta = s.metadata as { etape?: string; tentative?: number } | undefined;
  return meta?.etape === etape && meta.tentative === tentative && s.directory === directory;
};

/**
 * Relecture COMMENCÉE puis interrompue dans `directory` : le premier jet est fait, le relecteur travaille quand le cockpit
 * « recharge ». C'est le cas du défaut §3 : la relance refait le bloc entier, sessions neuves. `bloquee` : le relecteur ne rend
 * jamais la main (sa conversation reste occupée) ; sinon son tour, lent, finit après l'interruption et la conversation se libère
 * (une relance n'est acceptée que sur une conversation au repos).
 */
async function relectureInterrompue(h: CockpitHarness, directory: string, bloquee: boolean): Promise<string> {
  h.fake.scriptWhen(etapeDe("redac", directory, 1), { text: "[synthétique] Premier jet.", cost: 0.01, stepMs: 5 });
  h.fake.scriptWhen(
    etapeDe("relec", directory, 1),
    bloquee
      ? { tools: [{ tool: "read", input: { filePath: `${directory}/a.txt` }, beforeAsk: () => new Promise<void>(() => undefined) }], stepMs: 1 }
      : { text: "[synthétique] Relecture lente.", cost: 0.01, stepMs: 400 },
  );
  const estimation = await h.call("POST", `/api/teams/${EQUIPE_RELECTURE}/estimate`, { headers: h.headers.mutating, body: { directory, rootId: null } });
  assert.equal(estimation.status, 200, estimation.body);
  const { estimateSha256 } = estimation.json<TeamEstimateResponse>();
  const run = await h.call("POST", `/api/teams/${EQUIPE_RELECTURE}/run`, {
    headers: h.headers.mutating,
    body: { directory, rootId: null, demande: "[synthétique] Rédige puis relis.", fichiers: [], agentConversation: "build", estimateSha256, confirmations: {} },
  });
  assert.equal(run.status, 202, run.body);
  const { runId } = run.json<TeamRunStarted>();
  const auTravail = await vueDuLancement(h, runId, (v) => v.steps.some((s) => s.stepId === "relec" && s.state === "en-cours" && s.sessionId !== null), "relecteur au travail");
  h.cockpit.equipes.eq.ports.runner.interrupt(runId, "rechargement");
  await vueDuLancement(h, runId, (v) => v.relancable, "relecture interrompue, relançable");
  if (!bloquee) {
    const session = auTravail.steps.find((s) => s.stepId === "relec")?.sessionId ?? "";
    await until(() => (h.fake.statusOf(session).type === "idle" ? true : undefined), 5_000);
  }
  return runId;
}

describe("croisements v106 <gf4:v106> : construction × 1.0.6 (fiche §6)", () => {
  it("T-C1 : POST de l'estimation de la Seconde lecture avec un dossier %XX → 403 forbidden-directory, zéro requête aux deux instances ; « Remise 20% » lu à l'octet", async (t) => {
    const { h } = await start(t, { settings: { ui: { mode: "avance" } }, modules: "tous", omo: true });
    assert.ok(h.omo, "option « omo » du harnais");
    const omo = h.omo;
    relecteurInstalle(h);
    const corps = (directory: string) => ({ directory, sessionId: "ses_seconde_lecture", cible: "reponse" });
    const piege = await sansRequete(h, omo, "Seconde lecture %XX", () =>
      h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: corps(TRAP_DIR) }),
    );
    assertForbidden(piege, "POST /api/chat/second-reading/estimate");
    assert.equal(usageRows(h), 0, "rien de facturé");
    // Témoin : un nom légitime est lu dans son dossier, à l'octet (le relecteur installé y est cherché).
    const depuis = h.fake.requests.length;
    const legitime = await h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: corps(dirOf(LEGIT[0])) });
    assert.equal(legitime.status, 200, legitime.body);
    assert.deepEqual([...new Set(directoriesSent(h, depuis))], [dirOf(LEGIT[0])], "dossier transmis tel quel");
    assertSentinel(h, "T-C1");
  });

  it("T-C2 : relance d'une relecture commencée (constats-5b §3) — dossier %XX : estimation et relance 403, zéro requête ; « Remise 20% » : la relance part et refait le bloc DANS ce dossier", async (t) => {
    const { h, omo } = await demarrerEquipes(t);
    relecturePosee(h);

    // Dossier non contrôlé : un lancement hérité d'une base d'avant la 1.0.6, relecture commencée.
    const piege = await relectureInterrompue(h, dirOf("proj"), true);
    h.db.prepare("UPDATE team_runs SET directory = ? WHERE id = ?").run(TRAP_DIR, piege);
    const lignes = (h.db.prepare("SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ?").get(piege) as { n: number }).n;
    assertForbidden(
      await sansRequete(h, omo, "estimation de la relance %XX", () => h.call("POST", `/api/team-runs/${piege}/estimate`, { headers: h.headers.mutating, body: {} })),
      "POST /api/team-runs/:id/estimate",
    );
    assertForbidden(
      await sansRequete(h, omo, "relance %XX", () => h.call("POST", `/api/team-runs/${piege}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: "a".repeat(64) } })),
      "POST /api/team-runs/:id/relancer",
    );
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ?").get(piege) as { n: number }).n, lignes, "aucune étape recréée");

    // Témoin : dans « Remise 20% », la relance d'une relecture commencée PART (elle était refusée « estimation-perimee »), et
    // le bloc refait crée ses sessions neuves dans ce dossier, à l'octet.
    const directory = dirOf(LEGIT[0]);
    const runId = await relectureInterrompue(h, directory, false);
    h.fake.scriptWhen(etapeDe("redac", directory, 2), { text: "[synthétique] Version neuve.", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen(etapeDe("relec", directory, 2), { text: "[synthétique] Rien à redire.\nVERDICT: RIEN À REPRENDRE", cost: 0.01, stepMs: 5 });
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const depuis = h.fake.requests.length;
    const relance = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: estimation.json<TeamEstimateResponse>().estimateSha256 } });
    assert.equal(relance.status, 200, relance.body);
    const fini = await vueDuLancement(h, runId, (v) => v.state === "terminee" || v.state === "echec", "relance finie");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    const neuves = fini.steps.filter((s) => s.tentative === 2);
    assert.deepEqual(neuves.map((s) => s.stepId), ["redac", "relec"], "le bloc refait entier, tentative 2");
    for (const step of neuves) assert.equal(h.fake.session(step.sessionId ?? "")?.directory, directory, `${step.stepId} : session neuve dans le dossier`);
    assert.deepEqual([...new Set(directoriesSent(h, depuis))].filter((d) => d !== directory), [], "aucun autre dossier transmis par la relance");
    assertSentinel(h, "T-C2");
  });
});
// </gf4:v106>

// <gf5:v106> début : grande fusion, croisements (GF5) × 1.0.6 — sentinelle complétée (fiche-fusion-v106 §9.3, §11 ligne GF5 ; A32 (5))
// Familles ajoutées par GF5 : arrêt de l'arbre (stop-tree, racine héritée au dossier %XX : A32 (5)), relecture proactive de la table
// des attentes (D11 : un dossier d'enveloppe refusé n'est jamais relu), suppression d'une conversation (refus préalable, D11).
describe("croisements v106 <gf5:v106> : grande fusion × 1.0.6 (sentinelle complète)", () => {
  it("T-GF5-1 (A32 (5)) : « Arrêter » une racine héritée au dossier %XX → 404, ZÉRO requête ; racines légitimes : arrêt dans leur dossier, à l'octet", async (t) => {
    const { h } = await start(t, { modules: ["stopTree", "facts", "requests"] });
    const legacy = await conversation(h, dirOf("proj"), "Héritée");
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacy.id);
    const avant = h.fake.requests.length;
    const refus = await h.call("POST", `/api/conversations/${legacy.id}/stop`, { headers: h.headers.mutating });
    assert.equal(refus.status, 404, refus.body);
    await assert.rejects(h.cockpit.c11.ports.stopTree.run(legacy.id, "plafond-cout"), /racine inconnue/, "port : même refus, pour un plafond aussi");
    assert.deepEqual(
      h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`),
      [],
      "rien n'est demandé à opencode pour la racine %XX",
    );
    for (const name of LEGIT) {
      const root = await conversation(h, dirOf(name), name);
      const depuis = h.fake.requests.length;
      const arret = await h.call("POST", `/api/conversations/${root.id}/stop`, { headers: h.headers.mutating });
      assert.equal(arret.status, 200, `${name} : ${arret.body}`);
      assert.deepEqual([...new Set(directoriesSent(h, depuis))], [dirOf(name)], `${name} : arrêt dans ce dossier seulement`);
    }
    assertSentinel(h, "T-GF5-1");
  });

  it("T-GF5-2 (D11) : relecture proactive de la table des attentes — enveloppe d'un dossier refusé (%XX, ou instance hors de /workspace) jamais relue ; dossiers légitimes relus à l'octet", async (t) => {
    const { h } = await start(t, { modules: ["pending"] });
    const lectures = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission");
    const avant = lectures().length;
    for (const directory of [TRAP_DIR, "/secret", "/workspace/../secret"]) {
      h.fake.emit({ type: "session.status", properties: { sessionID: "ses_gf5_piege", status: { type: "busy" } } }, directory);
    }
    for (const name of LEGIT) h.fake.emit({ type: "session.status", properties: { sessionID: "ses_gf5_legitime", status: { type: "busy" } } }, dirOf(name));
    await until(() => lectures().length - avant >= LEGIT.length);
    await h.attentesAuRepos();
    assert.deepEqual(
      lectures()
        .slice(avant)
        .map((r) => r.query.directory)
        .sort(),
      LEGIT.map(dirOf).sort(),
      "seuls les dossiers légitimes sont relus",
    );
    assertSentinel(h, "T-GF5-2");
  });

  it("T-GF5-3 (D11) : suppression d'une conversation au dossier %XX → 403 avant tout refus préalable, zéro requête ; « Remise 20% » : refus préalable puis suppression, dans ce dossier", async (t) => {
    const { h } = await start(t, { modules: ["pending"] });
    const avant = h.fake.requests.length;
    const refus = await h.call("DELETE", `/api/oc/session/ses_gf5_piege?directory=${q(TRAP_DIR)}`, { headers: h.headers.mutating });
    assertForbidden(refus, "suppression %XX");
    assert.deepEqual(h.fake.requests.slice(avant), [], "zéro requête");
    const dir = dirOf(LEGIT[0]);
    const session = await conversation(h, dir, "À supprimer");
    await h.attentesAuRepos();
    const depuis = h.fake.requests.length;
    const suppression = await h.call("DELETE", `/api/oc/session/${session.id}?directory=${q(dir)}`, { headers: h.headers.mutating });
    assert.equal(suppression.status, 200, suppression.body);
    assert.deepEqual(
      h.fake.requests
        .slice(depuis)
        .filter((r) => r.pathname === "/permission" || r.method === "DELETE")
        .map((r) => `${r.method} ${r.pathname} ${r.query.directory}`),
      [`GET /permission ${dir}`, `DELETE /session/${session.id} ${dir}`],
      "demandes lues (refus préalable) puis suppression, dans ce dossier",
    );
    assertSentinel(h, "T-GF5-3");
  });

  // Relecture de F2 (vague 3) : carte d'une délégation et sondage de l'autonomie, deux lectures de GET /permission qui partaient
  // avec le dossier d'une racine héritée sans passer par isAllowedDirectory (famille A22 ; défaut antérieur à GF5).
  it("T-GF5-4 (A22) : carte d'une délégation d'une racine héritée au dossier %XX → 404, ZÉRO requête ; racines légitimes : GET /permission dans leur dossier, à l'octet", async (t) => {
    const { h } = await start(t, { modules: ["taskGuard"], settings: { ui: { mode: "avance" } } });
    const legacy = await conversation(h, dirOf("proj"), "Héritée");
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, legacy.id);
    const avant = h.fake.requests.length;
    const refus = await h.call("GET", `/api/conversations/${legacy.id}/delegations/per_sondeRevue01`, { headers: h.headers.authed });
    assert.equal(refus.status, 404, refus.body);
    assert.equal(await h.cockpit.c11.ports.taskGuard.details(legacy.id, "per_sondeRevue01"), null, "port : même refus");
    assert.deepEqual(
      h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}?directory=${r.query.directory ?? ""}`),
      [],
      "rien n'est demandé à opencode pour la racine %XX",
    );
    const lectures = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission");
    for (const name of LEGIT) {
      const root = await conversation(h, dirOf(name), name);
      const depuis = lectures().length;
      const carte = await h.call("GET", `/api/conversations/${root.id}/delegations/per_sondeRevue01`, { headers: h.headers.authed });
      assert.equal(carte.status, 404, `${name} : ${carte.body}`);
      assert.deepEqual(
        lectures()
          .slice(depuis)
          .map((r) => r.query.directory),
        [dirOf(name)],
        `${name} : demandes lues dans ce dossier seulement`,
      );
    }
    assertSentinel(h, "T-GF5-4");
  });

  it("T-GF5-5 (A22) : sondage de l'autonomie (redémarrage d'opencode) sur une racine devenue héritée au dossier %XX → aucune lecture, rien d'affirmé ; dossier légitime : lu à l'octet", async (t) => {
    const tours: Array<() => Promise<void>> = [];
    const capWatch = capWatchModuleWith({
      schedule: (tour) => {
        tours.push(tour);
        return () => void tours.splice(tours.indexOf(tour), 1);
      },
    });
    const { h } = await start(t, {
      modules: ["floors", "facts", "conversationAutonomy", "requests", "stopTree", "autonomy", capWatch],
      settings: { ui: { mode: "simple" } },
      ports: { activation: { check: async () => ({ ok: true }) } },
    });
    const sonder = async () => {
      for (const tour of [...tours]) await tour();
    };
    const lectures = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission");
    const directory = dirOf(LEGIT[0]);
    const root = await conversation(h, directory, "Autonome");
    const choix = await h.call("PUT", `/api/conversations/${root.id}/autonomie`, { headers: h.headers.confirmed, body: { choix: "autonome" } });
    assert.equal(choix.status, 200, choix.body);
    h.fake.script(root.id, { tools: [{ tool: "bash", input: { command: "git push" }, ask: { permission: "bash", patterns: ["git push"] } }], followUp: { text: "Fait." } });
    const envoi = await h.call("POST", `/api/oc/session/${root.id}/prompt_async?directory=${q(directory)}`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Pousse." }] },
    });
    assert.equal(envoi.status, 204, envoi.body);
    await until(() => h.fake.pendingPermissions().at(0), 5_000);
    const demande = () => h.db.prepare("SELECT fin FROM autonomy_requests WHERE root_id = ? ORDER BY rowid DESC LIMIT 1").get(root.id) as { fin: string | null } | undefined;
    await until(() => demande());
    // Barrière du flux : une conversation créée après coup est suivie quand tout ce qui précède est traité (autonomy-watch.test.ts).
    await conversation(h, directory, "Barrière");
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Témoin : la demande d'autorisation tient toujours, le sondage relit GET /permission dans le dossier de la racine, à l'octet.
    let depuis = lectures().length;
    await sonder();
    assert.deepEqual(
      lectures()
        .slice(depuis)
        .map((r) => r.query.directory),
      [directory],
      "dossier légitime relu tel quel",
    );
    assert.equal(demande()?.fin, null, "témoin : rien d'affirmé, la demande tient");

    // Racine héritée au dossier %XX : aucune lecture ; une lecture partie aurait ouvert « /secret » et, n'y trouvant pas la demande,
    // affirmé à tort un redémarrage d'opencode (demande « interrompue »).
    h.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(TRAP_DIR, root.id);
    depuis = lectures().length;
    await sonder();
    assert.deepEqual(
      lectures()
        .slice(depuis)
        .map((r) => r.query.directory),
      [],
      "aucune lecture pour le dossier %XX",
    );
    assert.equal(demande()?.fin, null, "rien n'est affirmé : la demande n'est pas donnée pour interrompue");
    assertSentinel(h, "T-GF5-5");
  });
});
// </gf5:v106> fin

// <nav:v106>
// Onglet « Fichiers » × 1.0.6 (fiche-fusion-v106 §8 et §9.3, décisions D14 (b) et A22 ; rang de fusion GFN). L'onglet ne décode rien
// et n'appelle jamais opencode : un dossier %XX (ici le nom même de la faille mesurée par A22) y est listé et lisible comme un dossier
// ordinaire, sans aucune requête vers les deux instances ni ligne `usage` ; il n'est JAMAIS proposé pour une conversation (absent de
// /api/projects, refusé en 403 forbidden-directory par le proxy et /api/chat/resolve avant toute requête : PERCENT_ESCAPE
// d'isAllowedDirectory). Le dossier piège de R106-a (« secret » dans son nom) reste protégé par son nom, sans accès disque.
const DOSSIER_XX_NAV = "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode";

describe("croisements v106, section NAV : onglet « Fichiers » × 1.0.6 (fiche §8, D14 (b))", () => {
  it("dossier %XX listé et lisible dans « Fichiers », zéro requête aux deux instances ni ligne usage ; jamais proposé pour une conversation", async (t) => {
    const { h, root } = await start(t, { modules: "tous", equipes: "tous", omo: true });
    assert.ok(h.omo, "harnais avec la salle (coupée)");
    fs.mkdirSync(path.join(root, DOSSIER_XX_NAV));
    fs.writeFileSync(path.join(root, DOSSIER_XX_NAV, "a.txt"), `lu dans Fichiers${NL}`);
    const fichiers = (route: keyof typeof FICHIERS_ROUTES, body: Record<string, string>) =>
      h.call("POST", FICHIERS_ROUTES[route], { headers: h.headers.mutating, body });
    const avant = { principale: h.fake.requests.length, salle: h.omo.fake.requests.length };
    const lignes = usageRows(h);

    const racine = await fichiers("dossier", { projet: "", chemin: "" });
    assert.equal(racine.status, 200, racine.body);
    const entrees = racine.json<{ entrees: Array<{ nom: string; type: string }> }>().entrees;
    assert.equal(entrees.find((e) => e.nom === DOSSIER_XX_NAV)?.type, "dossier", "dossier %XX listé sous « Tout le workspace »");
    assert.equal(entrees.some((e) => e.nom === TRAP), false, "dossier piège de R106-a : protégé par son nom, jamais listé");
    for (const [projet, chemin] of [["", `${DOSSIER_XX_NAV}/a.txt`], [DOSSIER_XX_NAV, "a.txt"]] as const) {
      const lu = await fichiers("contenu", { projet, chemin });
      assert.equal(lu.status, 200, `${projet || "racine"} : ${lu.body}`);
      assert.equal(lu.json<{ texte: string }>().texte, "lu dans Fichiers");
    }
    const protege = await fichiers("contenu", { projet: "", chemin: `${TRAP}/a.txt` });
    assert.deepEqual([protege.status, protege.json<{ error: string }>().error], [403, "protege"]);
    assert.deepEqual(h.fake.requests.slice(avant.principale).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête vers opencode");
    assert.deepEqual(h.omo.fake.requests.slice(avant.salle).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête vers la salle");
    assert.equal(usageRows(h), lignes, "rien de facturé");

    // Jamais proposé pour une conversation : absent des projets (projects.list() écarte les noms %XX), refusé avant toute requête.
    const projets = await h.call("GET", "/api/projects", { headers: h.headers.authed });
    assert.equal(projets.status, 200, projets.body);
    const noms = projets.json<Array<{ name: string }>>().map((p) => p.name);
    assert.ok(noms.includes("proj"), `témoin : projet ordinaire proposé (${noms.join(", ")})`);
    assert.deepEqual(noms.filter((n) => PERCENT.test(n)), [], "aucun projet %XX proposé");
    const depuis = h.fake.requests.length;
    assertForbidden(
      await h.call("POST", `/api/oc/session?directory=${q(dirOf(DOSSIER_XX_NAV))}`, { headers: h.headers.mutating, body: { title: "Depuis Fichiers" } }),
      "POST /session (dossier %XX de l'onglet)",
    );
    assertForbidden(
      await h.call("POST", "/api/chat/resolve", { headers: h.headers.mutating, body: { directory: dirOf(DOSSIER_XX_NAV), agent: "build" } }),
      "POST /api/chat/resolve (dossier %XX de l'onglet)",
    );
    assert.deepEqual(h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête vers opencode");
    assertSentinel(h, "NAV");
    assert.deepEqual(h.omo.fake.instancesHors(), [], "aucune instance de la salle hors de /workspace");
  });
});
// </nav:v106>
