// Tests de croisement du train it1 V0 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : T0 (contrats, câblage),
// T1 (harnais du cockpit, faux opencode) et MX1 (mesures hors ligne sur opencode 1.18.30, fixtures/mx1-mesures.json).
// Le harnais n'a pas encore d'option `modules` (L1a) : « tous » = buildCockpit11 sans liste, sur les dépendances du harnais.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import { ConfigWriteQueue } from "./config-queue.ts";
import type { Cockpit11Deps, HookStep } from "./contracts-11.ts";
import type { OcEvent } from "./opencode.ts";
import { SessionTracker } from "./sessions.ts";
import { CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import {
  createId,
  type FakePermissionRequest,
  type FakeSession,
  type FakeToolScript,
  type FakeWireEvent,
  parseApplyPatch,
  type PermissionRule,
} from "./test-support/fake-opencode.ts";
import { applyPatchTool, bash, editTool, leaks, promptAsync, within, writeTool } from "./test-support/helpers.ts";
import { ACTIVATION_OUVERTE, buildCockpit11, type Cockpit11Wiring, MODULE_ORDER } from "./wiring-11.ts";

type AskedShape = Pick<FakePermissionRequest, "permission" | "patterns" | "always" | "metadata">;

interface Mx1Fixture {
  files: Record<string, string>;
  metadata: Array<{
    name: string;
    directory: string;
    worktree: string;
    cases: Array<{ marker: string; model: string; tool: string; input: Record<string, unknown>; toolsOffered: string[]; asked: AskedShape; toolKeys: string[] }>;
  }>;
  m14: {
    asked: AskedShape;
    before: { status: Array<{ type: string }> };
    otherInstances: string[];
    order: string[];
    response: { status: number; body: unknown };
    permissionReplied: number;
    after: { permission: unknown[]; status: Record<string, unknown>; sessionKept: boolean; toolPart: { tool: string; status: string; error: string; metadata: unknown } };
    lateOnce: { status: number; body: Record<string, string> };
    effectFile: boolean;
    providerCallsAfterDispose: number;
    ids: Record<"session" | "message" | "permission" | "call", string>;
  };
  tools: {
    configPermission: Record<string, unknown>;
    mcpResourceTools: string[];
    floor: PermissionRule[];
    cases: Array<{ name: string; model: string; permission: PermissionRule[] | "floor" | null; patch?: boolean; tools: string[] }>;
  };
}

interface M2Fixture {
  model: { providerID: string; modelID: string };
  configPermission: Record<string, unknown>;
  cases: Array<{ name: string; agent: string; parent?: string; create: PermissionRule[] | null; patch: PermissionRule[] | null; tools: string[] }>;
}

const MX1_URL = new URL("./test-support/fixtures/mx1-mesures.json", import.meta.url);
const M2_URL = new URL("./test-support/fixtures/m2-tools.json", import.meta.url);
const mx1 = JSON.parse(fs.readFileSync(MX1_URL, "utf8")) as Mx1Fixture;
const m2 = JSON.parse(fs.readFileSync(M2_URL, "utf8")) as M2Fixture;

/** Outil scripté qui rejoue l'entrée exacte du banc MX1 ; motifs calculés par les aides du harnais (relatifs au worktree). */
function replayTool(c: Mx1Fixture["metadata"][number]["cases"][number], directory: string, worktree: string): FakeToolScript {
  const options = { directory, worktree };
  if (c.tool === "edit") return editTool(String(c.input.filePath), String(c.input.oldString), String(c.input.newString), options);
  if (c.tool === "write") return writeTool(String(c.input.filePath), String(c.input.content), options);
  const hunks = parseApplyPatch(String(c.input.patchText));
  assert.ok(hunks, `${c.marker} : texte d'apply_patch illisible`);
  return applyPatchTool(hunks, { ...options, input: { patchText: c.input.patchText } });
}

/** Libellé d'un événement de la séquence M14, dans la forme de la fixture ; null : événement hors de la session et du dossier suivis. */
function m14Label(wire: FakeWireEvent, sessionID: string, directory: string): string | null {
  if (wire.payload.type === "sync") return null;
  const { type, properties: p } = wire.payload as OcEvent;
  if (type === "global.disposed") return type;
  if (type === "server.instance.disposed") return p.directory === directory ? type : null;
  if (p.sessionID !== sessionID) return null;
  if (type === "session.error") return `${type}:${(p.error as { name: string }).name}`;
  if (type === "session.status") return `${type}:${(p.status as { type: string }).type}`;
  if (type === "message.part.updated") {
    const part = p.part as { type: string; state?: { status: string } };
    return `${type}:${part.type}:${part.state?.status}`;
  }
  if (type === "message.updated") {
    const info = p.info as { role: string; error?: { name: string } };
    return `${type}:${info.role}${info.error ? `:${info.error.name}` : ""}`;
  }
  return type;
}

describe("croisements it1 V0 : faux opencode (T1) et mesures (M2, MX1)", () => {
  it("fixtures des mesures : aucune fuite (motifs du README), 7 cas par dossier, suite M14 close par global.disposed", () => {
    assert.deepEqual(leaks(fs.readFileSync(MX1_URL, "utf8")), []);
    assert.deepEqual(leaks(fs.readFileSync(M2_URL, "utf8")), []);
    assert.deepEqual(
      mx1.metadata.map((d) => [d.name, d.worktree, d.cases.length]),
      [
        ["git", "/workspace/meta-git", 7],
        ["hors-git", "/", 7],
      ],
    );
    assert.equal(mx1.m14.order.at(-1), "global.disposed");
    assert.equal(m2.cases.length, 5);
  });

  it("toolsFor du faux = listes mesurées : 5 cas de M2, puis MX1 sans MCP (IA gpt- ou non, plancher à la création et par PATCH, ETAPE, read mcp:*, read *)", async (t) => {
    const h = await startCockpit(t);
    const oc = h.deps.client;
    const newSession = (body: Record<string, unknown>) => oc.request<FakeSession>("POST", "/session", { body });

    h.fake.globalConfig = { ...h.fake.globalConfig, permission: m2.configPermission };
    const roots = new Map<string, string>();
    for (const c of m2.cases.filter((candidate) => candidate.parent === undefined)) {
      const session = await newSession(c.create ? { permission: c.create } : {});
      if (c.patch) await oc.request("PATCH", `/session/${session.id}`, { body: { permission: c.patch } });
      assert.deepEqual(h.fake.toolsFor(session.id, { modelID: m2.model.modelID, agent: c.agent }), c.tools, `M2 ${c.name}`);
      roots.set(c.name, session.id);
    }
    const childCase = m2.cases.find((c) => c.parent !== undefined);
    const rootID = roots.get(childCase?.parent ?? "");
    assert.ok(childCase && rootID);
    h.fake.script(rootID, {
      tools: [{ tool: "task", input: { description: "Lecture", prompt: "Lis a.txt.", subagent_type: "general" }, child: { agent: "general", text: "Résumé." } }],
      followUp: { text: "fin" },
    });
    assert.equal(await promptAsync(oc, rootID, "Délègue.", { model: m2.model }), 204);
    await within(h.fake.settled(rootID), "délégation M2 terminée");
    const [child] = await oc.request<FakeSession[]>("GET", `/session/${rootID}/children`);
    assert.ok(child);
    assert.deepEqual(h.fake.toolsFor(child.id), childCase.tools, `M2 ${childCase.name}`);

    // MX1 : le faux n'a aucun outil MCP ; les trois outils de ressources mesurés (M3) sont retirés de la liste attendue.
    h.fake.globalConfig = { ...h.fake.globalConfig, permission: mx1.tools.configPermission };
    const mcp = new Set(mx1.tools.mcpResourceTools);
    assert.equal(mcp.size, 3);
    for (const c of mx1.tools.cases) {
      const rules = c.permission === "floor" ? mx1.tools.floor : c.permission;
      const session = await newSession(rules && !c.patch ? { permission: rules } : {});
      if (rules && c.patch) await oc.request("PATCH", `/session/${session.id}`, { body: { permission: rules } });
      assert.deepEqual(h.fake.toolsFor(session.id, { modelID: c.model, agent: "build" }), c.tools.filter((tool) => !mcp.has(tool)), `MX1 ${c.name}`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("métadonnées par défaut du faux = MX1 à l'octet : edit, write, apply_patch (ajout, modification, suppression, déplacement, multiple), dossier git et hors git ; motifs des aides ; relais du proxy intact ; refus sans écriture", async (t) => {
    const h = await startCockpit(t);
    const oc = h.deps.client;
    for (const dossier of mx1.metadata) {
      if (dossier.worktree !== dossier.directory) h.fake.worktrees.set(dossier.directory, dossier.worktree);
      const paths = await oc.request<{ worktree: string; directory: string }>("GET", "/path", { directory: dossier.directory });
      assert.deepEqual([paths.worktree, paths.directory], [dossier.worktree, dossier.directory]);
      for (const c of dossier.cases) {
        const label = `${dossier.name} ${c.marker}`;
        for (const [name, content] of Object.entries(mx1.files)) h.fake.files.set(`${dossier.directory}/${name}`, content);
        const session = await oc.request<FakeSession>("POST", "/session", { body: { title: c.marker }, directory: dossier.directory });
        h.fake.script(session.id, { tools: [replayTool(c, dossier.directory, dossier.worktree)], followUp: { text: "fin" } });
        const since = h.fake.emitted.length;
        assert.equal(await promptAsync(oc, session.id, `[${c.marker}]`), 204);
        const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
        const { permission, patterns, always, metadata } = asked;
        assert.deepEqual({ permission, patterns, always, metadata }, c.asked, label);
        assert.deepEqual(Object.keys(asked.tool ?? {}), c.toolKeys, label);
        const relayed = await h.call("GET", `/api/oc/permission?directory=${encodeURIComponent(dossier.directory)}`, { headers: h.headers.authed });
        assert.equal(relayed.status, 200, `${label} : ${relayed.body}`);
        assert.deepEqual(relayed.json<FakePermissionRequest[]>().find((p) => p.id === asked.id)?.metadata, c.asked.metadata, `${label} (proxy)`);
        assert.equal(await oc.request("POST", `/permission/${asked.id}/reply`, { body: { reply: "reject" }, directory: dossier.directory }), true);
        await within(h.fake.settled(session.id), `${label} : refus`);
        for (const [name, content] of Object.entries(mx1.files)) assert.equal(h.fake.files.get(`${dossier.directory}/${name}`), content, `${label} : ${name} inchangé`);
      }
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("redémarrage d'opencode avec une demande en attente = M14 : suite d'arrêt publiée avant server.instance.disposed, global.disposed en dernier, aucun permission.replied ; côté cockpit, liste vide et « once » tardif non relayé (409) ; P6 le signale", async (t) => {
    const h = await startCockpit(t);
    const oc = h.deps.client;
    const { m14 } = mx1;
    // Autre instance chargée : libérée sans événement de session.
    await oc.request<FakeSession>("POST", "/session", { body: { title: "autre" }, directory: "/workspace/autre" });
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "m14" } });
    assert.equal(created.status, 200, created.body);
    const session = created.json<FakeSession>();
    const directory = h.fake.directory;
    h.fake.script(session.id, { tools: [bash(String(m14.asked.metadata.command), { ask: { ...m14.asked } })], followUp: { text: "fin" } });
    assert.equal(await promptAsync(oc, session.id, "[M14]"), 204);
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id)).properties as unknown as FakePermissionRequest;
    assert.deepEqual({ permission: asked.permission, patterns: asked.patterns, metadata: asked.metadata, always: asked.always }, m14.asked);
    const pendingBefore = await h.call("GET", "/api/oc/permission", { headers: h.headers.authed });
    assert.deepEqual(pendingBefore.json<FakePermissionRequest[]>().map((p) => p.id), [asked.id]);
    assert.deepEqual(Object.values(await oc.request<Record<string, unknown>>("GET", "/session/status")), m14.before.status);

    const since = h.fake.emitted.length;
    assert.equal(await oc.request("POST", "/global/dispose"), m14.response.body);
    const wires = h.fake.emitted.slice(since).filter((w) => w.payload.type !== "sync");
    assert.deepEqual(
      wires.map((w) => m14Label(w, session.id, directory)).filter((label) => label !== null),
      m14.order,
    );
    const others = wires.filter((w) => w.directory !== directory && w.directory !== "global");
    assert.ok(others.some((w) => w.directory === "/workspace/autre"), "autre instance libérée");
    assert.deepEqual([...new Set(others.map((w) => w.payload.type))], m14.otherInstances);
    assert.equal(wires.at(-1)?.payload.type, "global.disposed");
    assert.equal(wires.filter((w) => w.payload.type === "permission.replied").length, m14.permissionReplied);

    assert.deepEqual(await oc.request("GET", "/permission"), m14.after.permission);
    assert.deepEqual(await oc.request("GET", "/session/status"), m14.after.status);
    assert.equal(h.fake.session(session.id) !== undefined, m14.after.sessionKept);
    const messages = h.fake.messages(session.id).filter((m) => m.info.role === "assistant");
    assert.equal(messages.length, 1 + m14.providerCallsAfterDispose, "aucune reprise après la libération");
    const part = messages[0]?.parts.find((p) => p.type === "tool") as { tool: string; state: { status: string; error: string; metadata: unknown } } | undefined;
    assert.ok(part);
    assert.deepEqual({ tool: part.tool, status: part.state.status, error: part.state.error, metadata: part.state.metadata }, m14.after.toolPart);

    const pendingAfter = await h.call("GET", "/api/oc/permission", { headers: h.headers.authed });
    assert.deepEqual(pendingAfter.json(), []);
    const late = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(late.status, 409, late.body);
    assert.equal(late.json<{ error: string }>().error, "demande-expiree");
    assert.ok(!h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`), "« once » tardif jamais relayé");
    // Réponse d'opencode à un « once » qui passerait quand même (L1b) : 404 PermissionNotFoundError, forme mesurée.
    const direct = await oc.raw("POST", oc.url(`/permission/${asked.id}/reply`), { headers: { "content-type": "application/json" }, body: JSON.stringify({ reply: "once" }) });
    assert.equal(direct.status, m14.lateOnce.status);
    assert.deepEqual(await direct.json(), JSON.parse(JSON.stringify(m14.lateOnce.body).replaceAll("<id>", asked.id)));
    assert.equal(m14.effectFile, false);
    await within(h.fake.settled(session.id), "tour coupé");
    assert.deepEqual(h.fake.failures, []);
    assert.throws(() => h.assertNoGlobalRestart(), /POST \/global\/dispose/);
  });
});

describe("croisements it1 V0 : câblage 1.1 (T0) sur le harnais (T1)", () => {
  it("tous les modules sur les dépendances réelles du harnais : modules livrés en V2 et route du Diagnostic seuls inscrits, autres ports neutres, porte I1 fermée, agent de classement = 1.0.4, aucun rechargement d'opencode", async (t) => {
    let wiring: Cockpit11Wiring | undefined;
    const h = await startCockpit(t, {
      deps: (base) => {
        const configQueue = base.configQueue ?? new ConfigWriteQueue();
        const deps: Cockpit11Deps = {
          env: base.env,
          log: base.log,
          db: base.db,
          client: base.client,
          hub: base.hub,
          settings: base.settings,
          sessions: new SessionTracker(base.db, base.client),
          ledger: base.ledger,
          archive: base.archive,
          lookup: base.lookup,
          catalog: base.catalog,
          tiers: base.tiers,
          projects: base.projects,
          control: base.control,
          configQueue,
          copilotConfig: base.copilotConfig,
          // L1g : Studio simulé du harnais, agent de classement déjà en place (ni écriture ni rechargement d'opencode).
          studio: { ...(base.studio as object), internalAgentUpToDate: async () => true } as unknown as Cockpit11Deps["studio"],
          // Portillon extrait par L1a : sans méthode install, le module « gate » n'inscrit rien.
          gate: {} as Cockpit11Deps["gate"],
          occupancy: async () => "idle",
        };
        wiring = buildCockpit11(deps);
        return { configQueue, routes: [...wiring.routes] };
      },
    });
    assert.ok(wiring);
    assert.deepEqual(wiring.modules, [...MODULE_ORDER]);
    // Modules livrés en V2 : le plancher (L3) inscrit ses trois crochets, ce montage ne les branche pas au proxy ; stopTree (L1c)
    // inscrit le crochet abort et les routes « conversations » ; les faits (L4b) leur dérivation, que ce montage ne branche pas au
    // processeur, et les routes d'activité ; le choix d'autonomie (L6a) le retour à « demander » au démarrage et ses routes. V3 :
    // la garde du « task once » (L1d) inscrit son crochet, sa dérivation (refus Simple) et les routes « delegations » ; la
    // surveillance des délégations (L1e) sa dérivation et son abonnement usage.updated ; les plans (L6b) leur crochet d'envoi,
    // après le plancher, et leurs routes. Itération 2 : les demandes autonomes (L10a) inscrivent leur crochet d'envoi, après
    // l'activation, et le cycle d'autonomie (L10a) sa dérivation et son abonnement opencode.connection. Le reste reste au repos.
    const hooked: Partial<Record<HookStep, number>> = { createSession: 1, sessionCreated: 1, beforeBilledSend: 3, beforeOnceRelay: 1, abort: 1 };
    assert.deepEqual(wiring.registrations, [
      ...(["createSession", "sessionCreated", "beforeBilledSend"] as const).map((key) => ({ kind: "hook", key, module: "floors" })),
      { kind: "hook", key: "beforeBilledSend", module: "plans" },
      { kind: "hook", key: "beforeBilledSend", module: "requests" },
      { kind: "hook", key: "beforeOnceRelay", module: "taskGuard" },
      { kind: "hook", key: "abort", module: "stopTree" },
      { kind: "derivation", key: "facts", module: "facts" },
      { kind: "derivation", key: "taskGuard", module: "taskGuard" },
      { kind: "derivation", key: "delegationWatch", module: "delegationWatch" },
      { kind: "derivation", key: "autonomy", module: "autonomy" },
      { kind: "hub", key: "usage.updated", module: "delegationWatch" },
      { kind: "hub", key: "opencode.connection", module: "autonomy" },
      { kind: "startup", key: "startup", module: "conversationAutonomy" },
      { kind: "routes", key: "conversations", module: "stopTree" },
      { kind: "routes", key: "delegations", module: "taskGuard" },
      { kind: "routes", key: "activity", module: "facts" },
      { kind: "routes", key: "autonomy", module: "conversationAutonomy" },
      { kind: "routes", key: "plans", module: "plans" },
      { kind: "routes", key: "diagnostic-11", module: "diagnostics" },
    ]);
    for (const step of Object.keys(wiring.hooks) as HookStep[]) assert.equal(wiring.hooks[step].length, hooked[step] ?? 0, step);
    assert.deepEqual([wiring.derivations.length, wiring.subscriptions.length, wiring.startup.length], [4, 2, 1]);
    assert.equal(wiring.c11.activationOuverte, ACTIVATION_OUVERTE);
    assert.equal(ACTIVATION_OUVERTE, false);
    assert.equal(wiring.c11.reloadBusy(), false);
    await wiring.c11.ports.internalAgents.ensureAll();

    const diag = await h.call("GET", "/api/diagnostic/activite", { headers: h.headers.authed });
    assert.equal(diag.status, 200, diag.body);
    assert.deepEqual(diag.json(), {
      delegation: [],
      // L1g : module réel, agent de classement suivi ; L11b : cockpit-controle suivi aussi (déjà en place pour ce Studio simulé).
      agentsInternes: [
        { nom: CLASSIFIER_AGENT, etat: "installe", prochainEssai: null },
        { nom: CONTROL_AGENT_NAME, etat: "installe", prochainEssai: null },
      ],
      interrupteur: h.deps.env.autonomy,
      controleIa: h.settings.get().budget.autonomie.controleIa,
      activationOuverte: false,
    });
    assert.equal((await h.call("GET", "/api/diagnostic/activite")).status, 401, "sans cookie de session");
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("identifiants : les motifs de shared/ids.ts acceptent ceux du faux et ceux d'opencode 1.18.30 relevés par MX1, et refusent chemins et séparateurs", () => {
    const measured = Object.values(mx1.m14.ids);
    const generated = ["ses", "msg", "per", "prt", "evt", "que"].map((prefix) => createId(prefix));
    for (const id of [...measured, ...generated, `call_${"a".repeat(24)}`]) {
      assert.match(id, ID_RE, id);
      assert.match(id, SESSION_ID_RE, id);
    }
    for (const bad of ["", "../ses_x", "ses_x/..", "per_x?y", "ses x", "ses_%2e%2e", "a".repeat(129)]) {
      assert.doesNotMatch(bad, ID_RE, bad);
      assert.doesNotMatch(bad, SESSION_ID_RE, bad);
    }
  });
});
