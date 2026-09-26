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
import { knownDirectories, probeSessionsBusyStrict } from "./assistants.ts";
import { requestPendingRescan } from "./autonomy-requests.ts";
import type { ActivationPort, ControlAiInput, ConversationAutonomyPort, RequestsPort } from "./contracts-11.ts";
import { CONTROL_AGENT_PROMPT, createControlAiModule } from "./control-ai.ts";
import { collectEditFacts } from "./edit-facts.ts";
import { ProjectsService } from "./projects.ts";
import type { AutonomyChoice, AutonomyRequestView } from "./shared/autonomy-types.ts";
import { CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { classifyCommand } from "./shared/shell-gate.ts";
import { collectShellContext } from "./shell-facts.ts";
import { StudioService } from "./studio.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";

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
