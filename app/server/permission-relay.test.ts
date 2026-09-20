// Tests L1b : réponses envoyées par les services au travers du portillon (spécification §3.8, §4.2, §6 l.1038, F-c ; mesures MX1
// M12 et M14). relayOnce : file → vérification « once » → inscription au registre → relais. rejectWhenAlone : refus retenu tant
// qu'une autre demande de la conversation attend, réévalué par la dérivation « gate », borné à 45 s. Arbre d'une conversation
// lu par sessions.descendants (un seul calcul, même borne que la 1.0).
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Cockpit11, EventDerivation, PermissionGate, Registrar } from "./contracts-11.ts";
import { openMemoryDb, transaction } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger } from "./log.ts";
import { OpencodeError, type OpencodeClient } from "./opencode.ts";
import { createPermissionGate, finishedToolSession, REJECT_HOLD_MAX_MS, REJECT_MESSAGE_MAX } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession, FakeToolScript } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const MESSAGE = "Refus du test : continue seul.";
const REPLY_ROUTE = /^\/permission\/([^/]+)\/reply$/;

/** Le portillon ne lit plus la base lui-même : tout accès échoue. */
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("le portillon ne doit pas lire la base");
    },
  },
) as DatabaseSync;

type RequestOptions = { query?: Record<string, unknown>; body?: unknown };
/** Options du vrai client (enveloppes des tests sur le faux opencode). */
type ClientOptions = Parameters<OpencodeClient["request"]>[2];
type Route = (method: string, pathname: string, options: RequestOptions) => unknown;
interface StubCall {
  method: string;
  pathname: string;
  query: Record<string, unknown> | undefined;
  body: unknown;
  /** Pour une réponse : la demande était déjà inscrite au registre quand l'appel est parti. */
  registered: boolean;
}

/** Portillon réel sur un client simulé : appels notés dans l'ordre. */
function stubGate(route: Route, sessions: SessionTracker = {} as SessionTracker) {
  const calls: StubCall[] = [];
  const ref: { gate?: PermissionGate } = {};
  const client = {
    request: async (method: string, pathname: string, options: RequestOptions = {}) => {
      const replyTo = REPLY_ROUTE.exec(pathname)?.[1];
      calls.push({
        method,
        pathname,
        query: options.query,
        body: options.body,
        registered: replyTo !== undefined && ref.gate?.emitted.has(decodeURIComponent(replyTo)) === true,
      });
      return route(method, pathname, options);
    },
  } as unknown as OpencodeClient;
  const gate = createPermissionGate({ client, db: NO_DB, log: createLogger("error"), hub: new EventHub(), sessions });
  ref.gate = gate;
  const derivations: EventDerivation[] = [];
  gate.install?.({ derivation: (d: EventDerivation) => derivations.push(d) } as unknown as Registrar, {} as Cockpit11);
  return {
    gate,
    calls,
    derivations,
    replies: () => calls.filter((c) => c.method === "POST"),
    lookups: () => calls.filter((c) => c.method === "GET" && c.pathname === "/permission").length,
    emit: (type: string, properties: Record<string, unknown>) => {
      for (const d of derivations) d.onEvent({ payload: { type, properties } });
    },
  };
}

/** Laisse passer les tâches en attente (promesses et setImmediate), sans minuteur : utilisable sous minuteurs simulés. */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Suit une promesse sans l'attendre. */
function track<T>(promise: Promise<T>): { done: () => boolean; value: () => T | undefined; promise: Promise<T> } {
  let settled = false;
  let result: T | undefined;
  void promise.then((value) => {
    settled = true;
    result = value;
  });
  return { done: () => settled, value: () => result, promise };
}

/** File libre : toute évaluation déjà commencée est terminée. */
async function queueIdle(gate: PermissionGate): Promise<void> {
  await flush();
  (await within(gate.acquire(), "file des réponses libre"))();
}

const notFound = () => new OpencodeError(404, { _tag: "PermissionNotFoundError", message: "Permission request not found" });

const task = (agent: string): FakeToolScript => ({
  tool: "task",
  input: { description: "Déléguer la lecture", prompt: "Lis a.txt.", subagent_type: agent },
  ask: { permission: "task", patterns: [agent], metadata: { description: "Déléguer la lecture", subagent_type: agent } },
  child: { agent, text: "Résumé." },
});

/** Conversation relayée par le proxy dont chaque outil scripté attend une autorisation (toutes publiées avant le retour). */
async function pendingAsks(h: CockpitHarness, title: string, tools: FakeToolScript[]): Promise<{ session: FakeSession; asked: FakePermissionRequest[] }> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  h.fake.script(session.id, { tools, followUp: { text: "fin" } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
  const asked = await until(() => {
    const list = h.fake.pendingPermissions().filter((p) => p.sessionID === session.id);
    return list.length === tools.length ? list : null;
  });
  return { session, asked };
}

const replyRequests = (h: CockpitHarness, requestId: string) =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${requestId}/reply`);

describe("L1b : relayOnce", () => {
  it("inscrit la réponse au registre avant l'envoi, puis « ok » ; corps exact { reply: \"once\" } et dossier transmis", async () => {
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return [{ id: "per_a", sessionID: "ses_a" }];
      if (pathname === "/session/status") return { ses_a: { type: "busy" } };
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    assert.equal(await stub.gate.relayOnce("per_a", "/workspace/projet", "controle"), "ok");
    assert.deepEqual(stub.replies(), [
      { method: "POST", pathname: "/permission/per_a/reply", query: { directory: "/workspace/projet" }, body: { reply: "once" }, registered: true },
    ]);
    assert.equal(stub.gate.emitted.has("per_a"), true);
  });

  it("404 PermissionNotFoundError → « deja-repondu » et autre erreur → « echec », jamais de nouvel essai", async () => {
    for (const [error, expected] of [
      [notFound(), "deja-repondu"],
      [new OpencodeError(500, { name: "UnknownError" }), "echec"],
      [new Error("fetch failed"), "echec"],
    ] as const) {
      const stub = stubGate((method, pathname) => {
        if (pathname === "/permission") return [{ id: "per_a", sessionID: "ses_a" }];
        if (pathname === "/session/status") return { ses_a: { type: "busy" } };
        if (method === "POST") throw error;
        throw new Error(`route inattendue : ${method} ${pathname}`);
      });
      assert.equal(await stub.gate.relayOnce("per_a", null, "cockpit"), expected, error.message);
      assert.equal(stub.replies().length, 1, "un seul envoi");
      assert.equal(await stub.gate.relayOnce("per_a", null, "cockpit"), "deja-repondu", "réponse inscrite : aucune seconde réponse");
      assert.equal(stub.replies().length, 1);
    }
  });

  it("demande qui n'est plus active → « expiree » sans « once » ni refus ; vérification impossible ou identifiant illisible → « echec »", async () => {
    const cases: Array<{ name: string; route: Route; expected: string }> = [
      { name: "demande absente", route: (_m, p) => (p === "/permission" ? [] : { ses_a: { type: "busy" } }), expected: "expiree" },
      {
        name: "conversation au repos (orpheline)",
        route: (_m, p) => (p === "/permission" ? [{ id: "per_a", sessionID: "ses_a" }] : {}),
        expected: "expiree",
      },
      {
        name: "appel d'outil terminé",
        route: (_m, p) => {
          if (p === "/permission") return [{ id: "per_a", sessionID: "ses_a", tool: { messageID: "msg_a", callID: "call_a" } }];
          if (p === "/session/status") return { ses_a: { type: "busy" } };
          return { info: { id: "msg_a" }, parts: [{ type: "tool", callID: "call_a", state: { status: "error" } }] };
        },
        expected: "expiree",
      },
      {
        name: "opencode injoignable",
        route: () => {
          throw new Error("fetch failed");
        },
        expected: "echec",
      },
    ];
    for (const { name, route, expected } of cases) {
      const stub = stubGate(route);
      assert.equal(await stub.gate.relayOnce("per_a", null, "cockpit"), expected, name);
      assert.deepEqual(stub.replies(), [], `${name} : rien n'est envoyé`);
      assert.equal(stub.gate.emitted.has("per_a"), false, `${name} : rien n'est inscrit`);
    }
    const stub = stubGate(() => {
      throw new Error("aucun appel attendu");
    });
    assert.equal(await stub.gate.relayOnce("../per_a", null, "cockpit"), "echec");
    assert.deepEqual(stub.calls, []);
  });

  it("déjà inscrite au registre → « deja-repondu », aucune seconde réponse : avant la vérification, et refus du navigateur inscrit pendant celle-ci", async () => {
    // Répondue par le navigateur puis retirée par opencode : « déjà répondu », pas « expirée ».
    const answered = stubGate((_m, p) => (p === "/permission" ? [] : { ses_a: { type: "busy" } }));
    answered.gate.emitted.record({ requestId: "per_a", reply: "once", by: "vous", at: 1 });
    assert.equal(await answered.gate.relayOnce("per_a", null, "controle"), "deja-repondu");
    assert.deepEqual(answered.calls, [], "aucune vérification ni réponse");

    // Refus du navigateur (hors file) inscrit pendant la lecture des demandes : encore listée, ou déjà retirée par opencode.
    for (const listed of [true, false]) {
      const reading = Promise.withResolvers<void>();
      const late = stubGate(async (method, pathname) => {
        if (pathname === "/permission") {
          await reading.promise;
          return listed ? [{ id: "per_b", sessionID: "ses_b" }] : [];
        }
        if (pathname === "/session/status") return { ses_b: { type: "busy" } };
        if (method === "POST") return true;
        throw new Error(`route inattendue : ${method} ${pathname}`);
      });
      const relay = track(late.gate.relayOnce("per_b", null, "controle"));
      await until(() => late.lookups() === 1);
      late.gate.emitted.record({ requestId: "per_b", reply: "reject", by: "vous", at: 2 });
      reading.resolve();
      assert.equal(await relay.promise, "deja-repondu", listed ? "encore listée" : "retirée");
      assert.deepEqual(late.replies(), []);
    }
  });

  it("file tenue de la vérification jusqu'à la réponse d'opencode : une place demandée entre-temps attend", async () => {
    const replying = Promise.withResolvers<void>();
    const stub = stubGate(async (method, pathname) => {
      if (pathname === "/permission") return [{ id: "per_a", sessionID: "ses_a" }];
      if (pathname === "/session/status") return { ses_a: { type: "busy" } };
      if (method === "POST") {
        await replying.promise;
        return true;
      }
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const relay = track(stub.gate.relayOnce("per_a", null, "cockpit"));
    await until(() => stub.replies().length === 1);
    const place = track(stub.gate.acquire());
    await flush();
    assert.equal(place.done(), false, "la place attend la réponse d'opencode");
    replying.resolve();
    assert.equal(await relay.promise, "ok");
    (await within(place.promise, "place obtenue après le relais"))();
  });

  it("faux opencode : inscrite avant la réception, « ok », l'outil s'exécute ; seconde demande de relais → « deja-repondu », une seule réponse reçue", async (t) => {
    const ref: { h?: CockpitHarness } = {};
    const seen: Array<{ registered: boolean; receivedBefore: boolean }> = [];
    const h = await startCockpit(t, {
      gate: (deps) => {
        const client = {
          request: (method: string, pathname: string, options: ClientOptions) => {
            const replyTo = REPLY_ROUTE.exec(pathname)?.[1];
            if (method === "POST" && replyTo !== undefined && ref.h) {
              const id = decodeURIComponent(replyTo);
              seen.push({ registered: ref.h.cockpit.gate.emitted.has(id), receivedBefore: replyRequests(ref.h, id).length > 0 });
            }
            return deps.client.request(method, pathname, options);
          },
        } as unknown as OpencodeClient;
        return createPermissionGate({ client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
      },
    });
    ref.h = h;
    const { session, asked } = await pendingAsks(h, "Relais", [bash("ls")]);
    const [request] = asked;
    assert.ok(request);
    assert.equal(await h.cockpit.gate.relayOnce(request.id, null, "controle"), "ok");
    assert.deepEqual(seen, [{ registered: true, receivedBefore: false }], "inscrite avant la réception par opencode");
    assert.deepEqual(
      replyRequests(h, request.id).map((r) => r.body),
      [{ reply: "once" }],
    );
    await within(h.fake.settled(session.id), "réponse terminée");
    const tool = h.fake.messages(session.id).flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
    assert.equal((tool?.state as { status?: string } | undefined)?.status, "completed");

    assert.equal(await h.cockpit.gate.relayOnce(request.id, null, "controle"), "deja-repondu");
    const late = await h.call("POST", `/api/oc/permission/${request.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(late.status, 409, late.body);
    assert.equal(replyRequests(h, request.id).length, 1, "une seule réponse reçue par opencode");
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("faux opencode, rechargement (mesure MX1 M14) : demande retirée pendant le relais → 404 → « deja-repondu » sans nouvel essai ; retirée avant → « expiree » sans « once »", async (t) => {
    const ref: { h?: CockpitHarness } = {};
    let disposeDuringReply = false;
    const h = await startCockpit(t, {
      gate: (deps) => {
        const client = {
          request: (method: string, pathname: string, options: ClientOptions) => {
            if (method === "POST" && REPLY_ROUTE.test(pathname) && disposeDuringReply) ref.h?.fake.emitGlobalDisposed({ resetInstances: true });
            return deps.client.request(method, pathname, options);
          },
        } as unknown as OpencodeClient;
        return createPermissionGate({ client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
      },
    });
    ref.h = h;
    const first = await pendingAsks(h, "Rechargement pendant", [bash("ls")]);
    const [during] = first.asked;
    assert.ok(during);
    disposeDuringReply = true;
    assert.equal(await h.cockpit.gate.relayOnce(during.id, null, "controle"), "deja-repondu");
    disposeDuringReply = false;
    assert.equal(replyRequests(h, during.id).length, 1, "404 : aucun nouvel essai");
    await within(h.fake.settled(first.session.id), "tour coupé par le rechargement");

    const second = await pendingAsks(h, "Rechargement avant", [bash("pwd -P")]);
    const [before] = second.asked;
    assert.ok(before);
    h.fake.emitGlobalDisposed({ resetInstances: true });
    assert.equal(await h.cockpit.gate.relayOnce(before.id, null, "controle"), "expiree");
    assert.deepEqual(replyRequests(h, before.id), [], "aucun « once » envoyé");
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("aucun arrêt du navigateur ne s'intercale entre la vérification et le « once » d'un service", async (t) => {
    const replying = Promise.withResolvers<void>();
    let proxyAcquires = 0;
    const h = await startCockpit(t, {
      gate: (deps) => {
        const client = {
          request: async (method: string, pathname: string, options: ClientOptions) => {
            if (method === "POST" && REPLY_ROUTE.test(pathname)) await replying.promise;
            return deps.client.request(method, pathname, options);
          },
        } as unknown as OpencodeClient;
        const real = createPermissionGate({ client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
        return {
          ...real,
          acquire: () => {
            proxyAcquires++;
            return real.acquire();
          },
        };
      },
    });
    const { session, asked } = await pendingAsks(h, "Arrêt pendant le relais", [bash("ls")]);
    const [request] = asked;
    assert.ok(request);
    const relay = track(h.cockpit.gate.relayOnce(request.id, null, "controle"));
    // Vérification faite, réponse inscrite : le « once » est retenu juste avant son envoi.
    await until(() => h.cockpit.gate.emitted.has(request.id));
    const stop = h.call("POST", `/api/oc/session/${session.id}/abort`, { headers: h.headers.mutating });
    await until(() => proxyAcquires >= 1);
    const abortRelayed = () => h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/session/${session.id}/abort`);
    // Absence prouvée sur une durée bornée : sans la file, l'arrêt part aussitôt.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(abortRelayed(), false, "arrêt en attente de la file");
    replying.resolve();
    assert.equal(await within(relay.promise, "relais terminé"), "ok");
    const stopped = await within(stop, "arrêt relayé ensuite");
    assert.equal(stopped.status, 200, stopped.body);
    const index = (pathname: string) => h.fake.requests.findIndex((r) => r.method === "POST" && r.pathname === pathname);
    assert.ok(index(`/permission/${request.id}/reply`) >= 0);
    assert.ok(index(`/permission/${request.id}/reply`) < index(`/session/${session.id}/abort`), "« once » reçu avant l'arrêt");
    await within(h.fake.settled(session.id), "tour arrêté");
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });
});

describe("L1b : rejectWhenAlone", () => {
  it("seule demande de la conversation : inscrite avant l'envoi, refus avec message, « ok » ; message vide → refus sans message", async () => {
    let list = [{ id: "per_a", sessionID: "ses_a" }];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return list;
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    assert.equal(await stub.gate.rejectWhenAlone("per_a", "ses_a", "/workspace/projet", MESSAGE, "cockpit"), "ok");
    list = [{ id: "per_b", sessionID: "ses_b" }];
    assert.equal(await stub.gate.rejectWhenAlone("per_b", "ses_b", null, "", "cockpit"), "ok");
    assert.deepEqual(stub.replies(), [
      { method: "POST", pathname: "/permission/per_a/reply", query: { directory: "/workspace/projet" }, body: { reply: "reject", message: MESSAGE }, registered: true },
      { method: "POST", pathname: "/permission/per_b/reply", query: { directory: null }, body: { reply: "reject" }, registered: true },
    ]);
  });

  it("F-c : retenu tant qu'une autre demande de la conversation attend ; réveillé par permission.replied de cette conversation seulement, puis envoyé", async () => {
    let list = [
      { id: "per_bash", sessionID: "ses_a" },
      { id: "per_task", sessionID: "ses_a" },
      { id: "per_ailleurs", sessionID: "ses_b" },
    ];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return list;
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    assert.equal(stub.derivations.length, 1);
    assert.equal(stub.derivations[0]?.name, "gate");
    const refusal = track(stub.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => stub.lookups() === 1);
    await queueIdle(stub.gate);
    assert.equal(refusal.done(), false, "retenu");
    assert.deepEqual(stub.replies(), [], "aucun refus pendant que le bash attend");
    assert.equal(stub.gate.emitted.has("per_task"), false, "rien n'est inscrit");

    // Dérivation synchrone, sans appel réseau ; événements d'une autre conversation ou d'un autre type : aucune évaluation.
    const before = stub.calls.length;
    stub.emit("permission.replied", { sessionID: "ses_b", requestID: "per_ailleurs", reply: "once" });
    stub.emit("permission.asked", { sessionID: "ses_a", id: "per_autre" });
    stub.emit("session.idle", { sessionID: "ses_a" });
    assert.equal(stub.calls.length, before, "aucun appel réseau dans la dérivation");
    await queueIdle(stub.gate);
    assert.equal(stub.lookups(), 1, "aucune nouvelle évaluation");

    // Réponse au bash : la demande visée est désormais seule.
    list = list.filter((p) => p.id !== "per_bash");
    stub.emit("permission.replied", { sessionID: "ses_a", requestID: "per_bash", reply: "once" });
    assert.equal(await within(refusal.promise, "refus envoyé après la réponse au bash"), "ok");
    assert.deepEqual(
      stub.replies().map((c) => [c.pathname, c.body, c.registered]),
      [["/permission/per_task/reply", { reply: "reject", message: MESSAGE }, true]],
    );
  });

  it("entrées refusées et sorts sans envoi : identifiants, message trop long, autre conversation, demande absente, déjà inscrite, lecture impossible ; 404 → « deja-repondu »", async () => {
    const silent = stubGate(() => {
      throw new Error("aucun appel attendu");
    });
    for (const [requestId, sessionId] of [
      ["../per_a", "ses_a"],
      ["per_a", "ses a"],
    ] as const) {
      assert.equal(await silent.gate.rejectWhenAlone(requestId, sessionId, null, MESSAGE, "cockpit"), "echec", `${requestId} / ${sessionId}`);
    }
    assert.equal(await silent.gate.rejectWhenAlone("per_a", "ses_a", null, "x".repeat(REJECT_MESSAGE_MAX + 1), "cockpit"), "echec");
    assert.equal(REJECT_MESSAGE_MAX, 2_000);
    assert.deepEqual(silent.calls, []);

    const route = (list: unknown): Route => (method, pathname) => {
      if (pathname === "/permission") {
        if (list instanceof Error) throw list;
        return list;
      }
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    };
    const mismatch = stubGate(route([{ id: "per_a", sessionID: "ses_autre" }]));
    assert.equal(await mismatch.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"), "echec");
    assert.equal(await stubGate(route([])).gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"), "expiree");
    assert.equal(await stubGate(route(new Error("fetch failed"))).gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"), "echec");
    const answered = stubGate(route([]));
    answered.gate.emitted.record({ requestId: "per_a", reply: "once", by: "vous", at: 1 });
    assert.equal(await answered.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"), "deja-repondu");
    assert.deepEqual(answered.calls, [], "déjà inscrite : aucune lecture ni réponse");
    assert.deepEqual(mismatch.replies(), []);

    // Refus du navigateur inscrit pendant la lecture des demandes : il l'emporte, demande encore listée ou déjà retirée.
    for (const listed of [true, false]) {
      const reading = Promise.withResolvers<void>();
      const late = stubGate(async (method, pathname) => {
        if (pathname === "/permission") {
          await reading.promise;
          return listed ? [{ id: "per_a", sessionID: "ses_a" }] : [];
        }
        throw new Error(`route inattendue : ${method} ${pathname}`);
      });
      const refusal = track(late.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"));
      await until(() => late.lookups() === 1);
      late.gate.emitted.record({ requestId: "per_a", reply: "reject", by: "vous", at: 2 });
      reading.resolve();
      assert.equal(await refusal.promise, "deja-repondu", listed ? "encore listée" : "retirée");
      assert.deepEqual(late.replies(), []);
    }

    const gone = stubGate((method, pathname) => {
      if (pathname === "/permission") return [{ id: "per_a", sessionID: "ses_a" }];
      if (method === "POST") throw notFound();
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    assert.equal(await gone.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"), "deja-repondu");
    assert.equal(gone.replies().length, 1, "aucun nouvel essai");
  });

  it("borne de 45 s : dernière évaluation à la borne ; autre demande encore là → « retenu » sans rien envoyer ; partie sans événement → refus envoyé", async (t) => {
    assert.equal(REJECT_HOLD_MAX_MS, 45_000);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let list = [
      { id: "per_a", sessionID: "ses_a" },
      { id: "per_autre", sessionID: "ses_a" },
    ];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return list;
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });

    const held = track(stub.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"));
    await flush();
    assert.equal(stub.lookups(), 1);
    t.mock.timers.tick(REJECT_HOLD_MAX_MS - 1);
    await flush();
    assert.equal(held.done(), false, "toujours retenu juste avant la borne");
    assert.equal(stub.lookups(), 1, "aucune évaluation sans réveil");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(held.done(), true);
    assert.equal(held.value(), "retenu");
    assert.equal(stub.lookups(), 2, "dernière évaluation à la borne");
    assert.deepEqual(stub.replies(), [], "rien n'est envoyé : la demande attend l'utilisateur");
    assert.equal(stub.gate.emitted.has("per_a"), false);

    const vanished = track(stub.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"));
    await flush();
    assert.equal(stub.lookups(), 3);
    // L'autre demande disparaît sans permission.replied (aucun réveil) : la borne fait la dernière évaluation.
    list = [{ id: "per_a", sessionID: "ses_a" }];
    t.mock.timers.tick(REJECT_HOLD_MAX_MS);
    await flush();
    assert.equal(vanished.value(), "ok");
    assert.equal(stub.replies().length, 1);
  });

  it("refus retenus de la même conversation : un seul envoi, chacun inscrit, même sort (sans attendre la borne)", async () => {
    const list = [
      { id: "per_t1", sessionID: "ses_a" },
      { id: "per_t2", sessionID: "ses_a" },
    ];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return list;
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const first = track(stub.gate.rejectWhenAlone("per_t1", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => stub.lookups() === 1);
    await queueIdle(stub.gate);
    assert.equal(first.done(), false, "l'autre demande n'est pas encore un refus retenu : retenu");
    assert.deepEqual(stub.replies(), []);

    const second = stub.gate.rejectWhenAlone("per_t2", "ses_a", null, MESSAGE, "cockpit");
    assert.equal(await within(second, "second refus"), "ok");
    assert.equal(await within(first.promise, "premier refus emporté par le second"), "ok");
    assert.equal(stub.replies().length, 1, "un seul refus envoyé (F-c : il emporte l'autre)");
    assert.equal(stub.gate.emitted.has("per_t1"), true);
    assert.equal(stub.gate.emitted.has("per_t2"), true);
  });

  it("refus retenu annoncé pour une autre conversation : jamais partenaire, il n'emporte rien et n'est pas emporté", async () => {
    const list = [
      { id: "per_w", sessionID: "ses_a" },
      { id: "per_x", sessionID: "ses_a" },
    ];
    let reading: PromiseWithResolvers<void> | null = null;
    const stub = stubGate(async (method, pathname) => {
      if (pathname === "/permission") {
        if (reading) await reading.promise;
        return list;
      }
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const w = track(stub.gate.rejectWhenAlone("per_w", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => stub.lookups() === 1);
    await queueIdle(stub.gate);
    assert.equal(w.done(), false, "retenu : per_x attend");

    // Nouvelle évaluation de per_w, arrêtée pendant la lecture ; le refus de per_x, annoncé pour ses_b, attend son tour.
    const gate = Promise.withResolvers<void>();
    reading = gate;
    stub.emit("permission.replied", { sessionID: "ses_a", requestID: "per_autre", reply: "once" });
    await until(() => stub.lookups() === 2);
    const x = track(stub.gate.rejectWhenAlone("per_x", "ses_b", null, MESSAGE, "cockpit"));
    await flush();
    gate.resolve();
    assert.equal(await within(x.promise, "refus annoncé pour une autre conversation"), "echec");
    await queueIdle(stub.gate);
    assert.equal(w.done(), false, "toujours retenu : per_x n'est pas un refus retenu de ses_a");
    assert.deepEqual(stub.replies(), []);
  });

  it("réponse à l'autre demande arrivée pendant une évaluation : nouvelle évaluation aussitôt, sans attendre un autre événement", async () => {
    let list = [
      { id: "per_task", sessionID: "ses_a" },
      { id: "per_bash", sessionID: "ses_a" },
    ];
    const reading = Promise.withResolvers<void>();
    let first = true;
    const stub = stubGate(async (method, pathname) => {
      if (pathname === "/permission") {
        // Liste prise à l'appel : opencode a répondu avant que l'événement n'arrive.
        const snapshot = list;
        if (first) {
          first = false;
          await reading.promise;
        }
        return snapshot;
      }
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const refusal = track(stub.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => stub.lookups() === 1);
    list = [{ id: "per_task", sessionID: "ses_a" }];
    stub.emit("permission.replied", { sessionID: "ses_a", requestID: "per_bash", reply: "once" });
    reading.resolve();
    assert.equal(await within(refusal.promise, "refus envoyé sans autre événement"), "ok");
    assert.equal(stub.lookups(), 2);
    assert.equal(stub.replies().length, 1);
  });

  it("autre refus retenu dont la demande est déjà inscrite (refus du navigateur en vol) : il retient toujours, aucune seconde réponse", async () => {
    let list = [
      { id: "per_t1", sessionID: "ses_a" },
      { id: "per_t2", sessionID: "ses_a" },
      { id: "per_bash", sessionID: "ses_a" },
    ];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return list;
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const first = track(stub.gate.rejectWhenAlone("per_t1", "ses_a", null, MESSAGE, "cockpit"));
    const second = track(stub.gate.rejectWhenAlone("per_t2", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => stub.lookups() === 2);
    await queueIdle(stub.gate);
    // Le navigateur refuse la seconde (inscrite, envoi en vol) pendant que le bash reçoit sa réponse.
    stub.gate.emitted.record({ requestId: "per_t2", reply: "reject", by: "vous", at: 1 });
    list = list.filter((p) => p.id !== "per_bash");
    stub.emit("permission.replied", { sessionID: "ses_a", requestID: "per_bash", reply: "once" });
    assert.equal(await within(second.promise, "seconde demande déjà répondue"), "deja-repondu");
    await until(() => stub.lookups() >= 3);
    await queueIdle(stub.gate);
    assert.equal(first.done(), false, "toujours retenu : la réponse en vol emportera cette demande");
    assert.deepEqual(stub.replies(), []);
    // Le refus du navigateur arrive : opencode refuse aussi la première (F-c).
    list = [];
    stub.emit("permission.replied", { sessionID: "ses_a", requestID: "per_t2", reply: "reject" });
    assert.equal(await within(first.promise, "première demande emportée"), "expiree");
    assert.deepEqual(stub.replies(), []);
  });

  it("appel d'outil voisin du même message en préparation ou en cours, sans demande listée : retenu ; lu APRÈS GET /permission ; réveillé par la fin d'un appel de cette conversation seulement, puis envoyé", async () => {
    const tool = { messageID: "msg_a", callID: "call_task" };
    let parts: Array<Record<string, unknown>> = [
      { type: "text", text: "Je modifie, puis je délègue." },
      { type: "tool", callID: "call_task", state: { status: "running" } },
      { type: "tool", callID: "call_edit", state: { status: "running" } },
      { type: "tool", callID: "call_ls", state: { status: "completed" } },
    ];
    const stub = stubGate((method, pathname) => {
      if (pathname === "/permission") return [{ id: "per_task", sessionID: "ses_a", tool }];
      if (pathname === "/session/ses_a/message/msg_a") return { info: { id: "msg_a", role: "assistant" }, parts };
      if (method === "POST") return true;
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const refusal = track(stub.gate.rejectWhenAlone("per_task", "ses_a", "/workspace/projet", MESSAGE, "cockpit"));
    await until(() => stub.calls.length === 2);
    await queueIdle(stub.gate);
    assert.equal(refusal.done(), false, "retenu : l'appel voisin peut encore poser sa demande");
    assert.deepEqual(stub.replies(), []);
    assert.equal(stub.gate.emitted.has("per_task"), false, "rien n'est inscrit");
    assert.deepEqual(
      stub.calls.map((c) => [c.method, c.pathname, c.query]),
      [
        ["GET", "/permission", { directory: "/workspace/projet" }],
        ["GET", "/session/ses_a/message/msg_a", { directory: "/workspace/projet" }],
      ],
      "message relu après la liste des demandes, dans le même dossier",
    );

    // Aucun réveil : appel qui passe en cours, partie de texte, fin d'un appel d'une autre conversation, nouvelle demande.
    const before = stub.calls.length;
    stub.emit("message.part.updated", { sessionID: "ses_a", part: { sessionID: "ses_a", type: "tool", callID: "call_edit", state: { status: "running" } } });
    stub.emit("message.part.updated", { sessionID: "ses_a", part: { sessionID: "ses_a", type: "text", text: "…" } });
    stub.emit("message.part.updated", { sessionID: "ses_b", part: { sessionID: "ses_b", type: "tool", callID: "call_x", state: { status: "completed" } } });
    stub.emit("permission.asked", { sessionID: "ses_a", id: "per_autre" });
    assert.equal(stub.calls.length, before, "aucun appel réseau dans la dérivation");
    await queueIdle(stub.gate);
    assert.equal(stub.calls.length, before, "aucune nouvelle évaluation");

    // Fin de l'appel voisin : nouvelle évaluation, refus envoyé.
    parts = parts.map((p) => (p.callID === "call_edit" ? { ...p, state: { status: "completed" } } : p));
    stub.emit("message.part.updated", { sessionID: "ses_a", part: { sessionID: "ses_a", type: "tool", callID: "call_edit", state: { status: "completed" } } });
    assert.equal(await within(refusal.promise, "refus envoyé après la fin de l'appel voisin"), "ok");
    assert.deepEqual(
      stub.replies().map((c) => [c.pathname, c.body, c.registered]),
      [["/permission/per_task/reply", { reply: "reject", message: MESSAGE }, true]],
    );
  });

  it("appels voisins : demande voisine déjà listée (règle F-c), refus retenus voisins (un seul envoi) ; message introuvable ou arrêté → envoyé ; message ou champ `tool` illisible, opencode injoignable, refus du navigateur pendant la lecture → rien d'envoyé", async () => {
    const message = (parts: unknown[], info: Record<string, unknown> = { id: "msg_a", role: "assistant" }) => ({ info, parts });
    const running = (callID: string) => ({ type: "tool", callID, state: { status: "running" } });
    const gateOn = (list: unknown[], read: () => unknown) =>
      stubGate((method, pathname) => {
        if (pathname === "/permission") return list;
        if (pathname === "/session/ses_a/message/msg_a") return read();
        if (method === "POST") return true;
        throw new Error(`route inattendue : ${method} ${pathname}`);
      });

    // Demande voisine listée dont l'appel est en cours : c'est la règle F-c qui retient (autre demande en attente).
    const listed = gateOn(
      [
        { id: "per_task", sessionID: "ses_a", tool: { messageID: "msg_a", callID: "call_task" } },
        { id: "per_bash", sessionID: "ses_a", tool: { messageID: "msg_a", callID: "call_bash" } },
      ],
      () => message([running("call_task"), running("call_bash")]),
    );
    const held = track(listed.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => listed.calls.length === 2);
    await queueIdle(listed.gate);
    assert.equal(held.done(), false, "demande voisine en attente : retenu");

    // Deux délégations du même message, toutes deux refusées par le cockpit : leurs appels en cours ne retiennent pas, un seul envoi.
    const twins = gateOn(
      [
        { id: "per_t1", sessionID: "ses_a", tool: { messageID: "msg_a", callID: "call_t1" } },
        { id: "per_t2", sessionID: "ses_a", tool: { messageID: "msg_a", callID: "call_t2" } },
      ],
      () => message([running("call_t1"), running("call_t2")]),
    );
    const first = track(twins.gate.rejectWhenAlone("per_t1", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => twins.lookups() === 1);
    await queueIdle(twins.gate);
    assert.equal(first.done(), false);
    assert.equal(await within(twins.gate.rejectWhenAlone("per_t2", "ses_a", null, MESSAGE, "cockpit"), "second refus"), "ok");
    assert.equal(await within(first.promise, "premier refus emporté"), "ok");
    assert.equal(twins.replies().length, 1, "un seul refus envoyé");

    // Message introuvable (404) ou arrêté (erreur du message) : aucun appel voisin ne posera de demande, le refus part.
    const tool = { messageID: "msg_a", callID: "call_task" };
    const alone = [{ id: "per_task", sessionID: "ses_a", tool }];
    const gone = gateOn(alone, () => {
      throw new OpencodeError(404, { name: "NotFoundError", data: { message: "Message not found: msg_a" } });
    });
    assert.equal(await gone.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"), "ok", "message introuvable");
    const aborted = gateOn(alone, () => message([running("call_task"), running("call_edit")], { id: "msg_a", role: "assistant", error: { name: "MessageAbortedError" } }));
    assert.equal(await aborted.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"), "ok", "réponse arrêtée");

    // Appel voisin dont l'IA écrit encore l'entrée (« pending ») : il retient aussi.
    const writing = gateOn(alone, () => message([running("call_task"), { type: "tool", callID: "call_write", state: { status: "pending" } }]));
    const writingHeld = track(writing.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => writing.calls.length === 2);
    await queueIdle(writing.gate);
    assert.equal(writingHeld.done(), false, "appel voisin en préparation : retenu");
    assert.deepEqual(writing.replies(), []);

    // Vérification impossible : rien n'est envoyé (jamais un refus qui emporterait une demande pas encore vue).
    for (const [label, read] of [
      ["message illisible", () => ({ info: { id: "msg_a" } })],
      ["opencode injoignable", () => {
        throw new Error("fetch failed");
      }],
    ] as const) {
      const unreadable = gateOn(alone, read);
      assert.equal(await unreadable.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"), "echec", label);
      assert.deepEqual(unreadable.replies(), [], label);
    }
    const invalid = gateOn([{ id: "per_task", sessionID: "ses_a", tool: { messageID: "../msg", callID: "call_task" } }], () => {
      throw new Error("message lu malgré un champ tool illisible");
    });
    assert.equal(await invalid.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"), "echec", "champ tool illisible");
    assert.deepEqual(invalid.calls.map((c) => c.pathname), ["/permission"]);

    // Refus du navigateur inscrit pendant la lecture du message : il l'emporte.
    const reading = Promise.withResolvers<void>();
    const late = stubGate(async (method, pathname) => {
      if (pathname === "/permission") return alone;
      if (pathname === "/session/ses_a/message/msg_a") {
        await reading.promise;
        return message([running("call_task")]);
      }
      throw new Error(`route inattendue : ${method} ${pathname}`);
    });
    const refusal = track(late.gate.rejectWhenAlone("per_task", "ses_a", null, MESSAGE, "cockpit"));
    await until(() => late.calls.length === 2);
    late.gate.emitted.record({ requestId: "per_task", reply: "reject", by: "vous", at: 3 });
    reading.resolve();
    assert.equal(await refusal.promise, "deja-repondu");
    assert.deepEqual(late.replies(), []);
  });

  it("finishedToolSession : seule la fin d'un appel d'outil (terminé ou en erreur) désigne une conversation", () => {
    const part = (state: unknown, extra: Record<string, unknown> = {}) => ({ part: { sessionID: "ses_a", type: "tool", callID: "c", state, ...extra } });
    assert.equal(finishedToolSession(part({ status: "completed" })), "ses_a");
    assert.equal(finishedToolSession(part({ status: "error" })), "ses_a");
    assert.equal(finishedToolSession({ sessionID: "ses_b", part: { type: "tool", state: { status: "completed" } } }), "ses_b", "conversation de l'événement à défaut de celle de la partie");
    for (const [label, value] of [
      ["en préparation", part({ status: "pending" })],
      ["en cours", part({ status: "running" })],
      ["partie de texte", { part: { sessionID: "ses_a", type: "text", text: "fin" } }],
      ["état illisible", part("completed")],
      ["identifiant illisible", part({ status: "completed" }, { sessionID: "../ses" })],
      ["sans partie", { sessionID: "ses_a" }],
      ["rien", null],
    ] as const) {
      assert.equal(finishedToolSession(value), null, label);
    }
  });

  it("rechargement d'opencode (server.instance.disposed, global.disposed) : réveil, demande retirée sans événement → « expiree »", async () => {
    for (const type of ["server.instance.disposed", "global.disposed"]) {
      let list = [
        { id: "per_a", sessionID: "ses_a" },
        { id: "per_autre", sessionID: "ses_a" },
      ];
      const stub = stubGate((method, pathname) => {
        if (pathname === "/permission") return list;
        throw new Error(`route inattendue : ${method} ${pathname}`);
      });
      const refusal = track(stub.gate.rejectWhenAlone("per_a", "ses_a", null, MESSAGE, "cockpit"));
      await until(() => stub.lookups() === 1);
      await queueIdle(stub.gate);
      list = [];
      stub.emit(type, type === "global.disposed" ? {} : { directory: "/workspace" });
      assert.equal(await within(refusal.promise, type), "expiree", type);
      assert.deepEqual(stub.replies(), []);
    }
  });

  it("F-c sur le faux opencode, dans les deux ordres : bash et task en attente, aucun refus avant la réponse au bash ; puis refus avec message, bash exécuté, délégation refusée", async (t) => {
    const h = await startCockpit(t, { modules: ["gate"] });
    assert.deepEqual(h.cockpit.wiring.registrations, [{ kind: "derivation", key: "gate", module: "gate" }]);
    // Ordre des deux demandes non supposé (il a varié dans la mesure M12) : les deux ordres sont joués.
    for (const [order, tools] of [
      ["bash puis task", [bash("ls"), task("general")]],
      ["task puis bash", [task("general"), bash("ls")]],
    ] as const) {
      const { session, asked } = await pendingAsks(h, `Retenue, ${order}`, [...tools]);
      const bashAsk = asked.find((p) => p.permission === "bash");
      const taskAsk = asked.find((p) => p.permission === "task");
      assert.ok(bashAsk && taskAsk, order);
      const repliesOf = () =>
        h.fake.requests.filter((r) => r.method === "POST" && (r.pathname === `/permission/${bashAsk.id}/reply` || r.pathname === `/permission/${taskAsk.id}/reply`));

      const since = h.fake.requests.length;
      const refusal = track(h.cockpit.gate.rejectWhenAlone(taskAsk.id, session.id, null, MESSAGE, "cockpit"));
      await until(() => h.fake.requests.slice(since).some((r) => r.method === "GET" && r.pathname === "/permission"));
      await queueIdle(h.cockpit.gate);
      assert.equal(refusal.done(), false, `${order} : refus retenu`);
      assert.deepEqual(repliesOf(), [], `${order} : aucun refus avant la réponse au bash`);
      assert.equal(h.fake.pendingPermissions().filter((p) => p.sessionID === session.id).length, 2, `${order} : votre autre demande n'est pas annulée`);

      const once = await h.call("POST", `/api/oc/permission/${bashAsk.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
      assert.equal(once.status, 200, once.body);
      assert.equal(await within(refusal.promise, `${order} : refus envoyé après la réponse au bash`), "ok");
      assert.deepEqual(
        repliesOf().map((r) => [r.pathname, r.body]),
        [
          [`/permission/${bashAsk.id}/reply`, { reply: "once" }],
          [`/permission/${taskAsk.id}/reply`, { reply: "reject", message: MESSAGE }],
        ],
        order,
      );
      await within(h.fake.settled(session.id), `${order} : tour terminé`);
      const parts = h.fake.messages(session.id).flatMap((m) => m.parts);
      const state = (tool: string) => parts.find((p) => p.type === "tool" && p.tool === tool)?.state as { status?: string; error?: string } | undefined;
      assert.equal(state("bash")?.status, "completed", `${order} : le bash autorisé s'exécute`);
      assert.equal(state("task")?.status, "error", order);
      assert.match(state("task")?.error ?? "", /Refus du test : continue seul\./, order);
      assert.equal(h.cockpit.gate.emitted.has(taskAsk.id), true, order);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });
});

/** Référence : trackedDescendants de la 1.0 (http.ts), recopié tel quel (ancien calcul de l'arbre). */
function trackedDescendants10(db: DatabaseSync, sessionId: string): Set<string> {
  const CLEANUP_MAX_DEPTH = 8;
  const CLEANUP_MAX_SESSIONS = 200;
  const tree = new Set([sessionId]);
  const known = db.prepare("SELECT root_id FROM sessions WHERE id = ?").get(sessionId) as { root_id: string } | undefined;
  const rows = db
    .prepare("SELECT id, parent_id FROM sessions WHERE root_id = ? AND parent_id IS NOT NULL LIMIT ?")
    .all(known?.root_id ?? sessionId, CLEANUP_MAX_SESSIONS * 10) as Array<{ id: string; parent_id: string }>;
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.parent_id);
    if (list) list.push(row.id);
    else childrenOf.set(row.parent_id, [row.id]);
  }
  let frontier = [sessionId];
  for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (tree.has(child) || tree.size >= CLEANUP_MAX_SESSIONS) continue;
        tree.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return tree;
}

describe("L1b : arbre unique", () => {
  it("arrêt : l'arbre est lu par sessions.descendants(…, 200), sans lecture directe de la base ; demandes refusées identiques à l'ancien calcul", async (t) => {
    // Générateur déterministe MINSTD (données de test, aucun usage de sécurité).
    let seed = 20260916;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const trees: Array<{ name: string; rows: Array<[string, string | null, string]>; start: string }> = [
      // Largeur : 300 enfants directs (borne de 200 sessions), demandes lues dans l'ordre inverse.
      { name: "large", rows: [["w", null, "w"], ...Array.from({ length: 300 }, (_, i) => [`w${i}`, "w", "w"] as [string, string, string])], start: "w" },
      // Profondeur : chaîne de 12 niveaux (borne de 8).
      { name: "profond", rows: Array.from({ length: 13 }, (_, i) => [`p${i}`, i === 0 ? null : `p${i - 1}`, "p0"] as [string, string | null, string]), start: "p0" },
    ];
    for (let round = 0; round < 12; round++) {
      const size = 1 + next(250);
      const ids = Array.from({ length: size }, (_, i) => `s${round}_${i}`);
      const roots = [ids[0] as string, `s${round}_ailleurs`];
      const rows = ids.map((id, i): [string, string | null, string] => {
        if (i === 0) return [id, null, id];
        const kind = next(10);
        const parent = kind === 0 ? `s${round}_absent` : kind === 1 ? id : (ids[next(size)] as string);
        return [id, parent, roots[next(10) < 9 ? 0 : 1] as string];
      });
      trees.push({ name: `aléatoire ${round}`, rows, start: ids[next(Math.min(size, 5))] as string });
    }

    for (const { name, rows, start } of trees) {
      const db = openMemoryDb();
      t.after(() => db.close());
      const insert = db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)");
      transaction(db, () => {
        for (const [id, parent, root] of rows) insert.run(id, parent, root);
      });
      const tracker = new SessionTracker(db, {} as OpencodeClient);
      const descendantsCalls: Array<[string, number | undefined]> = [];
      const sessions = {
        descendants: (id: string, limit?: number) => {
          descendantsCalls.push([id, limit]);
          return tracker.descendants(id, limit);
        },
      } as unknown as SessionTracker;
      // Une demande par session connue (ordre inverse) et une par session inconnue du cockpit.
      const pending = [...rows.map(([id]) => id).reverse(), "ses_inconnue"].map((sessionID, i) => ({ id: `per_${i}`, sessionID }));
      const stub = stubGate((method, pathname) => {
        if (pathname === "/permission") return pending;
        if (pathname === "/session/status") return {};
        if (pathname.endsWith("/children")) return [];
        if (method === "POST") return true;
        throw new Error(`route inattendue : ${method} ${pathname}`);
      }, sessions);
      let released = 0;
      await stub.gate.rejectAborted(start, null, () => released++);
      const reference = trackedDescendants10(db, start);
      const expected = pending.filter((p) => reference.has(p.sessionID)).slice(0, 100).map((p) => `/permission/${p.id}/reply`);
      assert.deepEqual(descendantsCalls, [[start, 200]], `${name} : un seul calcul de l'arbre, borne 200`);
      assert.deepEqual(
        stub.replies().map((c) => c.pathname),
        expected,
        `${name} : mêmes demandes refusées que l'ancien calcul`,
      );
      assert.ok(stub.replies().every((c) => c.registered && (c.body as { reply?: string }).reply === "reject"), name);
      assert.equal(released, 1, `${name} : file libérée une fois la liste lue`);
    }
  });
});
