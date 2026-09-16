// Tests L1a : portillon extrait (permission-gate.ts) : registre des réponses émises (inscription avant l'envoi, borne), instance
// partagée entre le proxy et les services, et app-factory avec ports neutres = comportement 1.0 (« always » 403, « once » vérifié,
// arrêt relayé, demandes restées refusées).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { EmittedReply, PermissionGate } from "./contracts-11.ts";
import { createLogger } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";
import { createPermissionGate, EMITTED_MAX, emittedRegistry } from "./permission-gate.ts";
import { EventHub } from "./hub.ts";
import type { SessionTracker } from "./sessions.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
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

  it("createPermissionGate : refus du serveur (orphelines) inscrits « cockpit » avant chaque envoi ; relayOnce et rejectWhenAlone refusés avant L1b", async () => {
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
    await assert.rejects(gate.relayOnce("per_x", null, "vous"), /relayOnce non disponible avant L1b/);
    await assert.rejects(gate.rejectWhenAlone("per_x", "ses_x", null, "non", "cockpit"), /rejectWhenAlone non disponible avant L1b/);
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
