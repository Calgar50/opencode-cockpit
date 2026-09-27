// Tests L1a : portillon extrait (permission-gate.ts) : registre des réponses émises (inscription avant l'envoi, borne), instance
// partagée entre le proxy et les services, et app-factory avec ports neutres = comportement 1.0 (« always » 403, « once » vérifié,
// arrêt relayé, demandes restées refusées).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { EmittedReply, PermissionGate } from "./contracts-11.ts";
import { createLogger } from "./log.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { createPermissionGate, EMITTED_MAX, emittedRegistry } from "./permission-gate.ts";
import { EventHub } from "./hub.ts";
// <gf5:d11>
import { createPendingTable, ListeBloqueeError } from "./pending-table.ts";
import { phraseListeBloquee } from "./shared/attentes-texts.ts";
// </gf5:d11>
import type { SessionTracker } from "./sessions.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession, FakeToolScript } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/** Conversation relayée par le proxy dont un « bash » attend une autorisation. */
async function pendingAsk(h: CockpitHarness, title: string): Promise<{ session: FakeSession; asked: FakePermissionRequest }> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  const since = h.fake.emitted.length;
  h.fake.script(session.id, { tools: [bash("ls")], followUp: { text: "fin" } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Liste." }] },
  });
  assert.equal(sent.status, 204, sent.body);
  const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
  return { session, asked };
}

/** Portillon réel dont le registre note, à chaque inscription, le nombre de requêtes déjà reçues par le faux. */
function spyGate(h: () => CockpitHarness | undefined, gate: PermissionGate, marks: Array<EmittedReply & { received: number }>): PermissionGate {
  return {
    ...gate,
    emitted: {
      record: (entry) => {
        marks.push({ ...entry, received: h()?.fake.requests.length ?? -1 });
        gate.emitted.record(entry);
      },
      has: (id) => gate.emitted.has(id),
    },
  };
}

describe("L1a : portillon extrait", () => {
  it("registre des réponses émises : borné (les plus anciennes sortent), dernière inscription gardée, copies rendues", () => {
    const registry = emittedRegistry(2);
    const at = 1;
    registry.record({ requestId: "per_a", reply: "once", by: "vous", at });
    registry.record({ requestId: "per_b", reply: "reject", by: "cockpit", at });
    registry.record({ requestId: "per_a", reply: "reject", by: "vous", at: 2 });
    registry.record({ requestId: "per_c", reply: "once", by: "controle", at });
    assert.equal(registry.has("per_b"), false, "la plus ancienne sort");
    assert.deepEqual(
      registry.entries().map((e) => [e.requestId, e.reply, e.at]),
      [
        ["per_a", "reject", 2],
        ["per_c", "once", 1],
      ],
    );
    const copy = registry.entries()[0];
    assert.ok(copy);
    copy.reply = "once";
    assert.equal(registry.entries()[0]?.reply, "reject");
    assert.equal(EMITTED_MAX, 2_000);
    const big = emittedRegistry();
    for (let i = 0; i < EMITTED_MAX + 5; i++) big.record({ requestId: `per_${i}`, reply: "once", by: "vous", at });
    assert.equal(big.entries().length, EMITTED_MAX);
    assert.equal(big.has("per_4"), false);
    assert.equal(big.has(`per_${EMITTED_MAX + 4}`), true);
  });

  // relayOnce et rejectWhenAlone (L1b) : permission-relay.test.ts.
  it("createPermissionGate : refus du serveur (orphelines) inscrits « cockpit » avant chaque envoi", async () => {
    const sent: Array<{ path: string; registered: boolean }> = [];
    let gate: PermissionGate | undefined;
    const client = {
      request: async (method: string, pathname: string) => {
        if (method === "GET" && pathname === "/session/status") return { ses_occupee: { type: "busy" } };
        if (method === "POST") {
          const id = pathname.split("/")[2] ?? "";
          sent.push({ path: pathname, registered: gate?.emitted.has(id) === true });
          return true;
        }
        throw new Error(`route inattendue : ${method} ${pathname}`);
      },
    } as unknown as OpencodeClient;
    gate = createPermissionGate({ client, db: {} as DatabaseSync, log: createLogger("error"), hub: new EventHub(), sessions: {} as SessionTracker });
    await gate.rejectOrphans(
      [
        { id: "per_repos", sessionID: "ses_repos", tool: null },
        { id: "per_occupee", sessionID: "ses_occupee", tool: null },
        { id: "../evasion", sessionID: "ses_repos", tool: null },
      ],
      null,
      { cause: "test" },
    );
    assert.deepEqual(sent, [{ path: "/permission/per_repos/reply", registered: true }]);
    assert.equal(gate.emitted.has("per_occupee"), false, "conversation qui travaille : ni envoyé ni inscrit");
  });

  it("proxy : chaque réponse du navigateur (« once », « reject ») est inscrite « vous » avant d'être reçue par opencode ; refusée avant le relais → jamais inscrite", async (t) => {
    const marks: Array<EmittedReply & { received: number }> = [];
    const ref: { h?: CockpitHarness } = {};
    const h = await startCockpit(t, {
      gate: (deps) =>
        spyGate(() => ref.h, createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: {} as SessionTracker }), marks),
    });
    ref.h = h;
    assert.equal(h.cockpit.c11.gate, h.cockpit.gate, "une seule instance : proxy et modules 1.1");

    const { session, asked } = await pendingAsk(h, "Registre");
    const once = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 200, once.body);
    const onceIndex = h.fake.requests.findIndex((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`);
    assert.ok(onceIndex >= 0);
    assert.deepEqual(
      marks.map((m) => [m.requestId, m.reply, m.by]),
      [[asked.id, "once", "vous"]],
    );
    assert.ok((marks[0]?.received ?? Infinity) <= onceIndex, "inscrite avant la réception par opencode");
    await within(h.fake.settled(session.id), "réponse terminée");

    const second = await pendingAsk(h, "Refus");
    const reject = await h.call("POST", `/api/oc/permission/${second.asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "reject", message: "non" } });
    assert.equal(reject.status, 200, reject.body);
    const rejectIndex = h.fake.requests.findIndex((r) => r.method === "POST" && r.pathname === `/permission/${second.asked.id}/reply`);
    const mark = marks.find((m) => m.requestId === second.asked.id);
    assert.equal(mark?.reply, "reject");
    assert.ok((mark?.received ?? Infinity) <= rejectIndex, "inscrite avant la réception par opencode");
    await within(h.fake.settled(second.session.id), "refus terminé");

    const count = marks.length;
    const always = await h.call("POST", "/api/oc/permission/per_toujours/reply", { headers: h.headers.mutating, body: { reply: "always" } });
    assert.equal(always.status, 403, always.body);
    const expired = await h.call("POST", "/api/oc/permission/per_expiree/reply", { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(expired.status, 409, expired.body);
    assert.equal(marks.length, count, "refus avant le relais : rien d'inscrit");
  });

  it("instance partagée : une place prise dans la file par un service bloque le « once » du proxy jusqu'à sa libération", async (t) => {
    const h = await startCockpit(t);
    const { session, asked } = await pendingAsk(h, "File partagée");
    const release = await h.cockpit.c11.gate.acquire();
    const pending = h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const relayed = () => h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`);
    assert.equal(relayed(), false, "« once » en attente de la file");
    assert.equal(h.fake.requests.some((r) => r.pathname === "/permission"), false, "vérification pas encore commencée");
    release();
    const res = await pending;
    assert.equal(res.status, 200, res.body);
    assert.ok(relayed());
    assert.equal(h.cockpit.gate.emitted.has(asked.id), true);
    await within(h.fake.settled(session.id), "réponse terminée");
  });

  // Ports neutres seulement (modules non déclarés) : ce test reste vrai quand les vrais modules sont fusionnés (plan §2.2) ;
  // « tous les modules » est le test de croisement de l'intégrateur.
  it("app-factory avec ports neutres = comportement 1.0 : « always » 403, « once » vérifié, arrêt relayé et demandes restées refusées", async (t) => {
    const h = await startCockpit(t);
    const hooks = h.cockpit.wiring.hooks;
    assert.deepEqual(
      Object.values(hooks).map((list) => list.length),
      [0, 0, 0, 0, 0],
    );
    assert.deepEqual([h.cockpit.wiring.derivations.length, h.cockpit.wiring.subscriptions.length, h.cockpit.wiring.routes.length], [0, 0, 0]);
    const { session, asked } = await pendingAsk(h, "Neutre");
    const always = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "always" } });
    assert.equal(always.status, 403, always.body);
    assert.equal(always.json<{ error: string }>().error, "toujours-refuse");
    const expired = await h.call("POST", "/api/oc/permission/per_inexistante/reply", { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(expired.status, 409, expired.body);
    assert.equal(expired.json<{ error: string }>().error, "demande-expiree");
    assert.ok(!h.fake.requests.some((r) => r.method === "POST" && r.pathname.startsWith("/permission/")), "rien relayé");

    const stop = await h.call("POST", `/api/oc/session/${session.id}/abort`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.ok(h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/session/${session.id}/abort`), "arrêt relayé");
    await within(h.fake.settled(session.id), "réponse arrêtée");
    // Demande restée en attente après l'arrêt : refusée par le nettoyage (inscrite « cockpit »), « once » tardif non relayé.
    await until(() => h.cockpit.gate.emitted.has(asked.id));
    const late = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(late.status, 409, late.body);
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`).map((r) => r.body),
      [{ reply: "reject" }],
    );
    h.assertNoGlobalRestart();
  });
});

// <gf5:d11>
// --- GF5 (D11, A31 a) : repli sur la table des attentes, poison actif (T-S9) ---------------------------------------------------------
// Le faux rejette GET /permission comme opencode 1.18.30 (option par défaut, A32 (4)) tant qu'un webfetch sans délai attend. Mesure
// D11 §6.6 n° 3 : (a) table fiable → checkOnce ok pour le bash d'une autre conversation ET pour le webfetch ; (b) flux coupé depuis la
// dernière lecture → 503 « bloquee » ; (c) 400 d'une autre forme → 503 comme avant ; (d) indice hors de la table, ou entrée citée qui
// n'est pas une permission de METADONNEES_FACULTATIVES sans la clé citée → 503 ; (e) rejectAborted refuse l'orpheline puis la liste
// du faux repasse à 200 ; (f) evaluateReject (rejectWhenAlone) n'est plus en « echec ». INVARIANT DE SÛRETÉ : l'accord relit en
// direct l'état des conversations et l'appel d'outil (espion), jamais la table.

const DIR = "/workspace";
const URL_WEB = "https://exemple.test/doc";
const webfetchSansDelai: FakeToolScript = {
  tool: "webfetch",
  input: { url: URL_WEB, format: "markdown" },
  ask: { permission: "webfetch", patterns: [URL_WEB], always: ["*"], metadata: { url: URL_WEB, format: "markdown" } },
  output: "contenu",
};

/** Conversation relayée par le proxy dont l'outil `tool` attend une autorisation (dossier racine du faux). */
async function attenteAvec(h: CockpitHarness, title: string, tool: FakeToolScript) {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  const since = h.fake.emitted.length;
  h.fake.script(session.id, { tools: [tool], followUp: { text: "fin" } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
  const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
  await h.processor.settled();
  return { session, asked };
}

/** Portillon sur un client double : GET /permission rend `erreur` (400) ; conversations au travail, appel d'outil en cours. */
function portillonDouble(corps: unknown, entrees: ReadonlyArray<Record<string, unknown>>) {
  const appels: string[] = [];
  const client = {
    request: async (method: string, pathname: string) => {
      appels.push(`${method} ${pathname}`);
      if (method === "GET" && pathname === "/permission") throw new OpencodeError(400, corps);
      if (method === "GET" && pathname === "/session/status") return { ses_a: { type: "busy" }, ses_b: { type: "busy" } };
      if (method === "GET" && pathname.startsWith("/session/")) {
        return { info: { id: "msg_a" }, parts: [{ type: "tool", callID: pathname.endsWith("msg_b") ? "call_b" : "call_a", state: { status: "running" } }] };
      }
      throw new Error(`route inattendue : ${method} ${pathname}`);
    },
  } as unknown as OpencodeClient;
  const attentes = createPendingTable({ racine: "/racine-du-double", planifier: () => undefined });
  attentes.derivation.onEvent({ payload: { type: "server.connected", properties: {} } } as never);
  attentes.finLecture(attentes.debutLecture(DIR), entrees);
  const gate = createPermissionGate({ client, db: {} as DatabaseSync, log: createLogger("error"), hub: new EventHub(), sessions: {} as SessionTracker, table: attentes });
  return { gate, appels, attentes };
}

const corpsDuDefaut = (indice: number, cle: string) => ({
  name: "BadRequest",
  data: { message: `Expected JSON value, got undefined${String.fromCharCode(10)}  at [${indice}]["metadata"]["${cle}"]`, kind: "Body" },
});
const entree = (id: string, sessionID: string, permission: string, metadata: Record<string, unknown>, callID = "call_a", messageID = "msg_a") => ({
  id,
  sessionID,
  permission,
  patterns: ["*"],
  metadata,
  always: ["*"],
  tool: { messageID, callID },
});
const WEB = entree("per_w", "ses_a", "webfetch", { url: URL_WEB, format: "markdown" });
const BASH = entree("per_b", "ses_b", "bash", { command: "ls" }, "call_b", "msg_b");

describe("GF5 (D11) : portillon et table des attentes, poison actif", () => {
  it("(a) table fiable : checkOnce ok pour le bash d'une AUTRE conversation et pour le webfetch lui-même ; gate.pending rend la table (métadonnées comprises)", async (t) => {
    const h = await startCockpit(t, { modules: ["pending"] });
    const web = await attenteAvec(h, "Web", webfetchSansDelai);
    const autre = await attenteAvec(h, "Commande", bash("ls"));
    await h.attentesAuRepos();
    await assert.rejects(h.deps.client.request("GET", "/permission"), (err) => err instanceof OpencodeError && err.status === 400, "le poison est actif");
    const lues = await h.cockpit.gate.pending(null);
    assert.deepEqual(
      lues.map((p) => [p.id, p.permission, p.metadata]),
      [
        [web.asked.id, "webfetch", { url: URL_WEB, format: "markdown" }],
        [autre.asked.id, "bash", { command: "ls" }],
      ],
    );
    assert.deepEqual(await h.cockpit.gate.checkOnce(autre.asked.id, null), { ok: true });
    assert.deepEqual(await h.cockpit.gate.checkOnce(web.asked.id, null), { ok: true });
    for (const s of [web, autre]) {
      const res = await h.call("POST", `/api/oc/permission/${s.asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
      assert.equal(res.status, 200, res.body);
      await within(h.fake.settled(s.session.id), "réponse terminée");
    }
  });

  it("(b) flux coupé depuis la dernière lecture : 503 « bloquee » (outil web), rien relayé ; message distinct d'« opencode ne répond pas »", async (t) => {
    const h = await startCockpit(t, { modules: ["pending"] });
    const web = await attenteAvec(h, "Web", webfetchSansDelai);
    await h.attentesAuRepos();
    assert.deepEqual(await h.cockpit.gate.checkOnce(web.asked.id, null), { ok: true }, "fiable avant la coupure");
    h.cockpit.wiring.subscriptions.filter((s) => s.type === "opencode.connection").forEach((s) => (s.fn as (d: unknown) => void)({ connected: false, error: "coupure" }));
    const verdict = await h.cockpit.gate.checkOnce(web.asked.id, null);
    assert.deepEqual(verdict, { ok: false, status: 503, request: null, orphan: false, bloquee: "web" });
    const res = await h.call("POST", `/api/oc/permission/${web.asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(res.status, 503, res.body);
    assert.deepEqual(res.json(), { error: "liste-bloquee", message: phraseListeBloquee("web"), outil: "web" });
    assert.equal(h.fake.requests.some((r) => r.method === "POST" && r.pathname.startsWith("/permission/")), false);
  });

  it("(c) 400 d'une AUTRE forme (message, kind, nom, statut) : 503 « opencode ne répond pas » comme avant, jamais la table", async () => {
    const formes: unknown[] = [
      { name: "BadRequest", data: { message: "Expected JSON value, got undefined", kind: "Body" } },
      { ...corpsDuDefaut(0, "timeout"), data: { ...corpsDuDefaut(0, "timeout").data, kind: "Query" } },
      { ...corpsDuDefaut(0, "timeout"), name: "ValidationError" },
      "Bad Request",
    ];
    for (const corps of formes) {
      const { gate } = portillonDouble(corps, [WEB, BASH]);
      assert.deepEqual(await gate.checkOnce("per_b", DIR), { ok: false, status: 503, request: null, orphan: false }, JSON.stringify(corps));
    }
    const { gate } = portillonDouble(corpsDuDefaut(0, "timeout"), [WEB, BASH]);
    assert.deepEqual(await gate.checkOnce("per_b", DIR), { ok: true }, "témoin : signature exacte, table cohérente");
  });

  it("(d) CONTRÔLE FORT : indice hors de la table, entrée citée qui n'est pas une permission de METADONNEES_FACULTATIVES, clé citée présente, clé d'un autre outil, entrée précédente illisible → 503 « bloquee »", async () => {
    const cas: Array<[string, unknown, ReadonlyArray<Record<string, unknown>>]> = [
      ["indice = taille de la table", corpsDuDefaut(2, "timeout"), [WEB, BASH]],
      ["indice au-delà", corpsDuDefaut(9, "timeout"), [WEB, BASH]],
      ["entrée citée : bash (hors de METADONNEES_FACULTATIVES)", corpsDuDefaut(1, "timeout"), [WEB, BASH]],
      ["entrée citée : webfetch AVEC timeout", corpsDuDefaut(0, "timeout"), [{ ...WEB, metadata: { url: URL_WEB, format: "markdown", timeout: 30 } }, BASH]],
      ["clé citée d'un autre outil (path pour webfetch)", corpsDuDefaut(0, "path"), [WEB, BASH]],
      ["entrée précédente illisible (opencode l'aurait citée)", corpsDuDefaut(1, "path"), [WEB, entree("per_g", "ses_b", "glob", { pattern: "*" })]],
    ];
    for (const [nom, corps, entrees] of cas) {
      const { gate, appels } = portillonDouble(corps, entrees);
      const verdict = await gate.checkOnce(String(entrees[0]?.id), DIR);
      assert.equal(verdict.ok, false, nom);
      assert.equal(!verdict.ok && verdict.status, 503, nom);
      assert.equal(!verdict.ok && verdict.bloquee !== undefined, true, `${nom} : 503 « liste bloquée », jamais « opencode ne répond pas »`);
      await assert.rejects(gate.pending(DIR), ListeBloqueeError, nom);
      assert.equal(appels.filter((a) => a.startsWith("POST")).length, 0, nom);
    }
  });

  it("table jamais fiable (aucun server.connected, ou dossier « incertain ») : 503 « bloquee »", async () => {
    const { gate, attentes } = portillonDouble(corpsDuDefaut(0, "timeout"), [WEB, BASH]);
    assert.deepEqual(await gate.checkOnce("per_b", DIR), { ok: true });
    attentes.derivation.onEvent({ directory: DIR, payload: { type: "permission.asked", properties: { id: "per x" } } } as never);
    assert.deepEqual(await gate.checkOnce("per_b", DIR), { ok: false, status: 503, request: null, orphan: false, bloquee: "web" }, "dossier incertain");
    const neuf = createPermissionGate({
      client: { request: async () => Promise.reject(new OpencodeError(400, corpsDuDefaut(0, "timeout"))) } as unknown as OpencodeClient,
      db: {} as DatabaseSync,
      log: createLogger("error"),
      hub: new EventHub(),
      sessions: {} as SessionTracker,
    });
    await assert.rejects(neuf.pending(DIR), ListeBloqueeError, "au démarrage, rien n'est fiable");
  });

  it("INVARIANT DE SÛRETÉ : l'accord sur la table relit EN DIRECT l'état des conversations et l'appel d'outil ; appel fini ou conversation au repos → 409", async () => {
    const { gate, appels } = portillonDouble(corpsDuDefaut(0, "timeout"), [WEB, BASH]);
    assert.deepEqual(await gate.checkOnce("per_b", DIR), { ok: true });
    assert.deepEqual(appels, ["GET /permission", "GET /session/status", "GET /session/ses_b/message/msg_b"], "état et appel d'outil lus en direct");
    // Appel d'outil qui n'est plus en cours : la table dit la demande présente, l'accord est refusé quand même.
    const fini = portillonDouble(corpsDuDefaut(0, "timeout"), [WEB, entree("per_c", "ses_b", "bash", { command: "ls" }, "call_autre", "msg_b")]);
    const verdict = await fini.gate.checkOnce("per_c", DIR);
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.status, 409);
    // Conversation au repos : orpheline, jamais « once ».
    const repos = portillonDouble(corpsDuDefaut(0, "timeout"), [WEB, entree("per_r", "ses_repos", "bash", { command: "ls" })]);
    const orpheline = await repos.gate.checkOnce("per_r", DIR);
    assert.deepEqual(!orpheline.ok && [orpheline.status, orpheline.orphan], [409, true]);
  });

  it("(e) rejectAborted refuse l'orpheline d'une conversation arrêtée, puis GET /permission du faux repasse à 200", async (t) => {
    const h = await startCockpit(t, { modules: ["pending"] });
    const web = await attenteAvec(h, "Web", webfetchSansDelai);
    await h.attentesAuRepos();
    await h.deps.client.request("POST", `/session/${web.session.id}/abort`);
    await within(h.fake.settled(web.session.id), "arrêtée");
    const release = await h.cockpit.gate.acquire();
    await h.cockpit.gate.rejectAborted(web.session.id, null, release);
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${web.asked.id}/reply`).map((r) => r.body),
      [{ reply: "reject" }],
    );
    assert.deepEqual(await h.deps.client.request("GET", "/permission"), [], "la liste d'opencode repasse à 200");
  });

  it("(f) evaluateReject (refus retenu du cockpit) n'est plus en « echec » : le refus part ; suppression d'une conversation : refus PRÉALABLE de ses demandes", async (t) => {
    const h = await startCockpit(t, { modules: ["pending"] });
    const web = await attenteAvec(h, "Web", webfetchSansDelai);
    const autre = await attenteAvec(h, "Commande", bash("ls"));
    await h.attentesAuRepos();
    assert.equal(await h.cockpit.gate.rejectWhenAlone(autre.asked.id, autre.session.id, null, "", "cockpit"), "ok");
    await within(h.fake.settled(autre.session.id), "refus reçu");
    // Suppression (proxy DELETE /session/:id) : la demande web est refusée AVANT, puis la conversation supprimée.
    const supprimee = await h.call("DELETE", `/api/oc/session/${web.session.id}`, { headers: h.headers.mutating });
    assert.equal(supprimee.status, 200, supprimee.body);
    const ordre = h.fake.requests.filter((r) => (r.method === "POST" && r.pathname === `/permission/${web.asked.id}/reply`) || (r.method === "DELETE" && r.pathname === `/session/${web.session.id}`));
    assert.deepEqual(
      ordre.map((r) => `${r.method} ${r.pathname}`),
      [`POST /permission/${web.asked.id}/reply`, `DELETE /session/${web.session.id}`],
      "refus AVANT la suppression",
    );
    assert.deepEqual(await h.deps.client.request("GET", "/permission"), [], "aucune orpheline : la liste repasse à 200");

    // Témoin sans table : demandes illisibles → rien n'est supprimé (503), la conversation reste.
    const temoin = await startCockpit(t);
    const poison = await attenteAvec(temoin, "Web", webfetchSansDelai);
    const refus = await temoin.call("DELETE", `/api/oc/session/${poison.session.id}`, { headers: temoin.headers.mutating });
    assert.equal(refus.status, 503, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "liste-bloquee");
    assert.equal(temoin.fake.requests.some((r) => r.method === "DELETE"), false, "rien supprimé");
  });
});
// </gf5:d11>
