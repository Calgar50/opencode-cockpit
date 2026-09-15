import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { describe, it, type TestContext } from "node:test";
import {
  type OcAssistantMessage,
  type OcEvent,
  type OcGlobalEvent,
  type OcMessageWithParts,
  type OcPart,
  type OcUserMessage,
  OpencodeClient,
  OpencodeError,
} from "./opencode.ts";
import {
  createId,
  FakeOpencode,
  type FakeOpencodeOptions,
  type FakePermissionRequest,
  type FakeSession,
  type FakeToolScript,
  idTime,
  readCapture,
  type SyncPayload,
} from "./test-support/fake-opencode.ts";

const PASSWORD = "p".repeat(24);
const FIXTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"];
const REJECTED = "The user rejected permission to use this specific tool call.";

const clientFor = (fake: FakeOpencode, password = PASSWORD) =>
  new OpencodeClient({ opencodeUrl: fake.url, opencodeUsername: "opencode", opencodePassword: password });

async function startFake(t: TestContext, options: FakeOpencodeOptions = {}) {
  const fake = new FakeOpencode({ password: PASSWORD, ...options });
  await fake.start();
  t.after(() => fake.close());
  return { fake, oc: clientFor(fake) };
}

/** Attend qu'une lecture renvoie une valeur (sondage toutes les 5 ms). */
async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error("condition non atteinte à temps");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Abonnement du cockpit (subscribeGlobal) : blocs reçus, dans l'ordre. */
async function subscribe(t: TestContext, oc: OpencodeClient): Promise<OcGlobalEvent[]> {
  const events: OcGlobalEvent[] = [];
  let connected = false;
  const stop = oc.subscribeGlobal(
    (event) => events.push(event),
    (status) => {
      if (status === "connected") connected = true;
    },
  );
  t.after(stop);
  await until(() => connected && events.some((e) => e.payload.type === "server.connected"));
  return events;
}

const props = (event: { payload: OcEvent | SyncPayload }): Record<string, unknown> => ("properties" in event.payload ? event.payload.properties ?? {} : {});
const newSession = (oc: OpencodeClient, body: Record<string, unknown> = {}, directory?: string) =>
  oc.request<FakeSession>("POST", "/session", { body, ...(directory ? { directory } : {}) });
const reply = (oc: OpencodeClient, id: string, body: Record<string, unknown>) => oc.request<boolean>("POST", `/permission/${id}/reply`, { body });
const statusIs = (status: number) => (err: unknown) => err instanceof OpencodeError && err.status === status;

async function promptAsync(oc: OpencodeClient, sessionID: string, text: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await oc.raw("POST", oc.url(`/session/${sessionID}/prompt_async`), {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "build", parts: [{ type: "text", text }], ...extra }),
  });
  await res.arrayBuffer();
  return res.status;
}

const bash = (command: string, extra: Partial<FakeToolScript> = {}): FakeToolScript => ({
  tool: "bash",
  input: { command, description: `Lancer ${command}` },
  ask: { permission: "bash", patterns: [command], metadata: { command }, always: [`${command.split(" ")[0]} *`] },
  output: "ok",
  ...extra,
});

/** Trace lisible « type:détail@nom » des sessions nommées (jumeaux, deltas et événements serveur ignorés). */
function trace(events: ReadonlyArray<{ payload: OcEvent | SyncPayload }>, names: Record<string, string>): string[] {
  const out: string[] = [];
  for (const event of events) {
    const p = props(event);
    const who = typeof p.sessionID === "string" ? names[p.sessionID] : undefined;
    if (!who || event.payload.type === "message.part.delta") continue;
    let detail = "";
    if (event.payload.type === "session.status") detail = `:${(p.status as { type: string }).type}`;
    if (event.payload.type === "session.error") detail = `:${(p.error as { name: string }).name}`;
    if (event.payload.type === "permission.replied") detail = `:${String(p.reply)}`;
    if (event.payload.type === "message.updated") {
      const info = p.info as OcAssistantMessage;
      detail = `:${info.role}${info.error ? `:${info.error.name}` : info.time.completed ? `:${info.finish}` : ""}`;
    }
    if (event.payload.type === "message.part.updated") {
      const part = p.part as { type: string; state?: { status: string } };
      detail = `:${part.type}${part.state ? `:${part.state.status}` : ""}`;
    }
    out.push(`${event.payload.type}${detail}@${who}`);
  }
  return out;
}

function assertSubsequence(actual: string[], expected: string[]): void {
  let found = 0;
  for (const item of actual) if (item === expected[found]) found++;
  assert.equal(found, expected.length, `attendu ensuite : ${expected[found]}\ntrace : ${actual.join(", ")}`);
}

const toolParts = (message: OcMessageWithParts) => message.parts.filter((p) => p.type === "tool") as Array<OcPart & { state: Record<string, unknown> }>;
const assistants = (messages: OcMessageWithParts[]) => messages.filter((m) => m.info.role === "assistant").map((m) => m.info as OcAssistantMessage);

describe("faux opencode : transport", () => {
  it("santé et authentification Basic : 401 sans le bon mot de passe, accès par OpencodeClient", async (t) => {
    const { fake, oc } = await startFake(t);
    assert.deepEqual(await oc.health(), { healthy: true, version: "1.18.30" });
    const anonymous = await fetch(`${fake.url}/global/health`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("www-authenticate"), 'Basic realm="Secure Area"');
    await assert.rejects(clientFor(fake, "mauvais-mot-de-passe").request("GET", "/session/status"), statusIs(401));
    const token = Buffer.from(`opencode:${PASSWORD}`).toString("base64");
    assert.equal((await fetch(`${fake.url}/global/health?auth_token=${encodeURIComponent(token)}`)).status, 200);
    assert.deepEqual(
      fake.requests.map((r) => r.authorized),
      [true, false, false, true],
    );
    assert.ok(!JSON.stringify(fake.requests).includes(PASSWORD) && !JSON.stringify(fake.requests).includes(token), "aucun secret dans le journal");

    const open = new FakeOpencode();
    await open.start();
    t.after(() => open.close());
    assert.equal((await fetch(`${open.url}/global/health`)).status, 200);
  });

  it("journal des requêtes : méthode, chemin, paramètres et corps JSON", async (t) => {
    const { fake, oc } = await startFake(t);
    await newSession(oc, { title: "Journal" }, "/workspace");
    assert.deepEqual(fake.requests.at(-1), {
      method: "POST",
      pathname: "/session",
      query: { directory: "/workspace" },
      body: { title: "Journal" },
      authorized: true,
    });
  });

  it("identifiants horodatés comme opencode : evt/msg/per croissants, ses décroissant", () => {
    const now = Date.now();
    const a = createId("evt", "ascending", now);
    const b = createId("evt", "ascending", now);
    assert.match(a, /^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.ok(a.slice(0, 16) < b.slice(0, 16), "compteur dans la même milliseconde");
    assert.equal(idTime(a, "ascending", now), now);
    const older = createId("ses", "descending", now);
    const newer = createId("ses", "descending", now + 5);
    assert.ok(newer.slice(0, 16) < older.slice(0, 16), "une session récente trie avant");
    assert.equal(idTime(older, "descending", now), now);
    // Identifiants réels de la capture (research-events §2.3) : heure de réception et création de la racine.
    assert.ok(Math.abs(idTime("evt_09e75b371001UNhP225SGGq6Hv", "ascending", 1789364908921) - 1789364908921) <= 250);
    assert.ok(Math.abs(idTime("msg_09e75b36c001x5Cehfmxl57pRZ", "ascending", 1789364908908) - 1789364908908) <= 2);
    assert.ok(Math.abs(idTime("ses_f618ff214ffevi6gfuGx6TvpTP", "descending", 1789364538859) - 1789364538859) <= 2);
  });

  it("flux /global/event lu par subscribeGlobal : server.connected, enveloppe {directory, project, payload}, jumeaux sync par session", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    assert.equal(events[0]?.directory, undefined);
    const before = Date.now();
    const session = await newSession(oc, { title: "Flux" });
    await oc.request("PATCH", `/session/${session.id}`, { body: { title: "Flux 2" } });
    fake.emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "busy" } } });
    const status = await until(() => events.find((e) => e.payload.type === "session.status"));
    assert.equal(status.directory, "/workspace");
    assert.equal(status.project, "global");
    const created = events.find((e) => e.payload.type === "session.created");
    assert.ok(created?.payload.id);
    const at = idTime(created.payload.id);
    assert.ok(at >= before - 5 && at <= Date.now() + 5, "heure de l'événement dans son identifiant");
    const twins = events.filter((e) => e.payload.type === "sync").map((e) => e.payload as unknown as SyncPayload);
    assert.deepEqual(
      twins.map((s) => [s.syncEvent.type, s.syncEvent.seq, s.syncEvent.aggregateID]),
      [
        ["session.created.1", 0, session.id],
        ["session.updated.1", 1, session.id],
      ],
    );
    assert.equal(twins[0]?.id, created.payload.id);
    assert.equal(twins[0]?.syncEvent.id, created.payload.id);
    assert.deepEqual(twins[0]?.syncEvent.data, created.payload.properties);
  });

  it("jumeaux sync désactivables ; emit() dans un autre répertoire", async (t) => {
    const { fake, oc } = await startFake(t, { syncTwins: false });
    const events = await subscribe(t, oc);
    const session = await newSession(oc);
    fake.emit({ type: "message.updated", properties: { sessionID: session.id, info: { id: "msg_x", role: "user" } } }, "/autre");
    const moved = await until(() => events.find((e) => e.payload.type === "message.updated"));
    assert.equal(moved.directory, "/autre");
    assert.match(moved.payload.id ?? "", /^evt_/);
    assert.equal(events.filter((e) => e.payload.type === "sync").length, 0);
  });

  it("battement de cœur server.heartbeat à l'intervalle choisi, sans répertoire", async (t) => {
    const { oc } = await startFake(t, { heartbeatMs: 20 });
    const events = await subscribe(t, oc);
    const beats = await until(() => {
      const list = events.filter((e) => e.payload.type === "server.heartbeat");
      return list.length >= 2 ? list : false;
    });
    assert.equal(beats[0]?.directory, undefined);
    assert.match(beats[0]?.payload.id ?? "", /^evt_/);
  });

  it("emitGlobalDisposed : global.disposed sur « global » ; resetInstances vide demandes et états", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    const session = await newSession(oc);
    fake.script(session.id, { tools: [bash("ls")] });
    await promptAsync(oc, session.id, "Liste");
    await fake.waitForEvent("permission.asked");
    fake.emitGlobalDisposed({ resetInstances: true });
    const disposed = await until(() => events.find((e) => e.payload.type === "global.disposed"));
    assert.equal(disposed.directory, "global");
    assert.equal(disposed.project, undefined);
    assert.deepEqual(disposed.payload.properties, {});
    assert.deepEqual(await oc.request("GET", "/permission"), []);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
  });
});

describe("faux opencode : sessions", () => {
  it("POST /session stocke parentID, title, permission, metadata, directory et émet session.created", async (t) => {
    const { fake, oc } = await startFake(t);
    const permission = [{ permission: "read", pattern: "*.env", action: "deny" }];
    const since = fake.emitted.length;
    const root = await newSession(oc, { title: "Racine", metadata: { cockpit: "equipe", run: 1 }, permission }, "/workspace/projet");
    assert.equal(root.title, "Racine");
    assert.deepEqual(root.permission, permission);
    assert.deepEqual(root.metadata, { cockpit: "equipe", run: 1 });
    assert.equal(root.directory, "/workspace/projet");
    assert.equal(root.parentID, undefined);
    assert.equal(root.version, "1.18.30");
    assert.equal(root.projectID, "global");
    assert.ok(Math.abs(idTime(root.id, "descending", root.time.created) - root.time.created) <= 1, "id décroissant horodaté");
    const event = await fake.waitForEvent("session.created", (p) => (p.info as FakeSession).id === root.id, { since });
    assert.deepEqual(event.properties.info, root);
    assert.equal(fake.emitted.find((w) => w.payload === event)?.directory, "/workspace/projet");

    const child = await newSession(oc, { parentID: root.id });
    assert.equal(child.parentID, root.id);
    assert.match(child.title, /^Child session - \d{4}-\d{2}-\d{2}T/);
    assert.match((await oc.request<FakeSession>("POST", "/session")).title, /^New session - /);
    await assert.rejects(newSession(oc, { permission: [{ permission: "read", action: "tout" }] }), statusIs(400));
  });

  it("GET /session/:id, et 404 NotFoundError pour une session inconnue", async (t) => {
    const { oc } = await startFake(t);
    const session = await newSession(oc, { title: "Lue" });
    assert.deepEqual(await oc.request("GET", `/session/${session.id}`), session);
    await assert.rejects(oc.request("GET", "/session/ses_inconnue"), (err: unknown) => {
      assert.ok(err instanceof OpencodeError && err.status === 404);
      assert.deepEqual(err.body, { name: "NotFoundError", data: { message: "Session not found: ses_inconnue" } });
      return true;
    });
  });

  it("PATCH /session/:id AJOUTE les règles reçues, sans jamais remplacer ni retirer (F-g)", async (t) => {
    const { fake, oc } = await startFake(t);
    const a = { permission: "read", pattern: "*.env", action: "deny" };
    const b = { permission: "edit", pattern: "*", action: "deny" };
    const c = { permission: "bash", pattern: "*", action: "deny" };
    const session = await newSession(oc, { permission: [a] });
    const since = fake.emitted.length;
    assert.deepEqual((await oc.request<FakeSession>("PATCH", `/session/${session.id}`, { body: { permission: [b, c] } })).permission, [a, b, c]);
    assert.deepEqual((await oc.request<FakeSession>("PATCH", `/session/${session.id}`, { body: { permission: [a] } })).permission, [a, b, c, a]);
    assert.deepEqual((await oc.request<FakeSession>("PATCH", `/session/${session.id}`, { body: { permission: [] } })).permission, [a, b, c, a]);
    const renamed = await oc.request<FakeSession>("PATCH", `/session/${session.id}`, { body: { title: "Renommée" } });
    assert.equal(renamed.title, "Renommée");
    assert.deepEqual(renamed.permission, [a, b, c, a]);
    assert.deepEqual((await oc.request<FakeSession>("GET", `/session/${session.id}`)).permission, [a, b, c, a]);
    const updated = await fake.waitForEvent("session.updated", () => true, { since });
    assert.deepEqual((updated.properties.info as FakeSession).permission, [a, b, c]);
  });

  it("DELETE /session/:id supprime aussi les descendants et émet session.deleted, enfants d'abord", async (t) => {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc, { title: "Racine" });
    const child = await newSession(oc, { parentID: root.id });
    const grandchild = await newSession(oc, { parentID: child.id });
    const since = fake.emitted.length;
    assert.equal(await oc.request("DELETE", `/session/${root.id}`), true);
    assert.deepEqual(
      fake.emitted.slice(since).filter((w) => w.payload.type === "session.deleted").map((w) => props(w).sessionID),
      [grandchild.id, child.id, root.id],
    );
    await assert.rejects(oc.request("GET", `/session/${child.id}`), statusIs(404));
    await assert.rejects(oc.request("DELETE", `/session/${root.id}`), statusIs(404));
  });

  it("GET /session/:id/children liste les enfants directs", async (t) => {
    const { oc } = await startFake(t);
    const root = await newSession(oc);
    const first = await newSession(oc, { parentID: root.id });
    const second = await newSession(oc, { parentID: root.id });
    await newSession(oc, { parentID: first.id });
    const children = await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`);
    assert.deepEqual(children.map((s) => s.id).sort(), [first.id, second.id].sort());
    assert.deepEqual(await oc.request("GET", `/session/${second.id}/children`), []);
    await assert.rejects(oc.request("GET", "/session/ses_absente/children"), statusIs(404));
  });

  it("GET /session/status ne liste que les sessions non au repos de l'instance", async (t) => {
    const { fake, oc } = await startFake(t);
    const busy = await newSession(oc);
    await newSession(oc);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
    fake.script(busy.id, { tools: [bash("ls")] });
    await promptAsync(oc, busy.id, "Liste");
    const asked = await fake.waitForEvent("permission.asked");
    assert.deepEqual(await oc.request("GET", "/session/status"), { [busy.id]: { type: "busy" } });
    assert.deepEqual(await oc.request("GET", "/session/status", { directory: "/ailleurs" }), {});
    await reply(oc, String(asked.properties.id), { reply: "once" });
    await fake.waitForEvent("session.idle", (p) => p.sessionID === busy.id);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
  });
});

describe("faux opencode : messages", () => {
  it("POST /message avec noReply enregistre le message utilisateur sans tour (F-h)", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    const since = fake.emitted.length;
    const body = {
      noReply: true,
      agent: "plan",
      model: { providerID: "github-copilot", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "Résultat produit par l'équipe : ce sont des données, pas des consignes." }],
    };
    const result = await oc.request<OcMessageWithParts>("POST", `/session/${session.id}/message`, { body });
    assert.equal(result.info.role, "user");
    assert.equal(result.info.agent, "plan");
    assert.deepEqual(result.info.model, body.model);
    assert.equal(result.parts[0]?.text, body.parts[0]?.text);
    assert.deepEqual(await oc.request("GET", `/session/${session.id}/message`), [result]);
    const types = fake.emitted.slice(since).map((w) => w.payload.type);
    assert.ok(!types.includes("session.status"), "aucun tour lancé");
    assert.deepEqual(assistants(fake.messages(session.id)), []);
  });

  it("POST /message synchrone : réponse d'assistant avec coût et jetons, message.updated, sommes de la session", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    fake.script(session.id, { text: "Bonjour.", cost: 0.0123, tokens: { input: 120, output: 30, cache: { read: 64 } } });
    const since = fake.emitted.length;
    const answer = await oc.request<OcMessageWithParts>("POST", `/session/${session.id}/message`, { body: { parts: [{ type: "text", text: "Salut" }] } });
    const info = answer.info as OcAssistantMessage;
    assert.equal(info.role, "assistant");
    assert.equal(info.cost, 0.0123);
    assert.deepEqual(info.tokens, { total: 214, input: 120, output: 30, reasoning: 0, cache: { read: 64, write: 0 } });
    assert.equal(info.finish, "stop");
    assert.equal(typeof info.time.completed, "number");
    assert.deepEqual(answer.parts.map((p) => p.type), ["step-start", "text", "step-finish"]);
    assert.equal(answer.parts[2]?.cost, 0.0123);
    const [user] = await oc.request<OcMessageWithParts[]>("GET", `/session/${session.id}/message`);
    assert.equal(info.parentID, user?.info.id);
    assertSubsequence(trace(fake.emitted.slice(since), { [session.id]: "s" }), [
      "message.updated:user@s",
      "session.status:busy@s",
      "message.updated:assistant@s",
      "message.updated:assistant:stop@s",
      "session.status:idle@s",
      "session.idle@s",
    ]);
    const completed = await fake.waitForEvent("message.updated", (p) => (p.info as OcAssistantMessage).time.completed !== undefined, { since });
    assert.equal((completed.properties.info as OcAssistantMessage).cost, 0.0123);
    const stored = await oc.request<FakeSession>("GET", `/session/${session.id}`);
    assert.equal(stored.cost, 0.0123);
    assert.equal(stored.tokens?.input, 120);
  });

  it("GET /session/:id/message et /message/:messageID ; 404 pour un message inconnu", async (t) => {
    const { oc } = await startFake(t);
    const session = await newSession(oc);
    const answer = await oc.request<OcMessageWithParts>("POST", `/session/${session.id}/message`, { body: { parts: [{ type: "text", text: "Salut" }] } });
    const all = await oc.request<OcMessageWithParts[]>("GET", `/session/${session.id}/message`);
    assert.deepEqual(all.map((m) => m.info.role), ["user", "assistant"]);
    assert.deepEqual(await oc.request("GET", `/session/${session.id}/message/${answer.info.id}`), answer);
    await assert.rejects(oc.request("GET", `/session/${session.id}/message/msg_absent`), (err: unknown) => {
      assert.ok(err instanceof OpencodeError && err.status === 404);
      assert.deepEqual(err.body, { name: "NotFoundError", data: { message: "Message not found: msg_absent" } });
      return true;
    });
  });

  it("« tools » d'un envoi REMPLACE les règles de session (F-h)", async (t) => {
    const { oc } = await startFake(t);
    const session = await newSession(oc, { permission: [{ permission: "read", pattern: "*.env", action: "deny" }] });
    await oc.request("POST", `/session/${session.id}/message`, { body: { noReply: true, tools: { bash: false, edit: true }, parts: [{ type: "text", text: "x" }] } });
    assert.deepEqual((await oc.request<FakeSession>("GET", `/session/${session.id}`)).permission, [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "allow" },
    ]);
  });
});

describe("faux opencode : prompt_async et autorisations", () => {
  it("prompt_async : 204, busy, assistant, partie d'outil, permission.asked, attente, once, reprise puis repos", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    const session = await newSession(oc, { title: "Tour" });
    fake.script(session.id, {
      cost: 0.01,
      tokens: { input: 100, output: 20 },
      tools: [bash("ls -la")],
      followUp: { text: "Deux fichiers.", cost: 0.002, tokens: { input: 50, output: 10 } },
    });
    assert.equal(await promptAsync(oc, session.id, "Liste les fichiers"), 204);
    const asked = await until(() => events.find((e) => e.payload.type === "permission.asked"));
    const request = props(asked) as unknown as FakePermissionRequest;
    assert.deepEqual(Object.keys(request).sort(), ["always", "id", "metadata", "patterns", "permission", "sessionID", "tool"]);
    assert.match(request.id, /^per_[0-9a-f]{12}/);
    assert.equal(request.sessionID, session.id);
    assert.equal(request.permission, "bash");
    assert.deepEqual(request.patterns, ["ls -la"]);
    assert.deepEqual(request.metadata, { command: "ls -la" });
    assert.deepEqual(request.always, ["ls *"]);
    const running = await until(() =>
      events
        .map((e) => props(e).part as (OcPart & { state?: { status: string } }) | undefined)
        .find((p) => p?.type === "tool" && p.callID === request.tool?.callID && p.state?.status === "running"),
    );
    assert.equal(running.messageID, request.tool?.messageID);
    assert.deepEqual(await oc.request("GET", "/permission"), [request]);
    assert.deepEqual(await oc.request("GET", "/session/status"), { [session.id]: { type: "busy" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(assistants(fake.messages(session.id)).length, 1, "le tour attend la réponse");

    assert.equal(await reply(oc, request.id, { reply: "once" }), true);
    await until(() => events.find((e) => e.payload.type === "session.idle" && props(e).sessionID === session.id));
    assertSubsequence(trace(events, { [session.id]: "s" }), [
      "session.status:busy@s",
      "message.updated:assistant@s",
      "message.part.updated:step-start@s",
      "message.part.updated:tool:pending@s",
      "permission.asked@s",
      "message.part.updated:tool:running@s",
      "permission.replied:once@s",
      "message.part.updated:tool:completed@s",
      "message.part.updated:step-finish@s",
      "message.updated:assistant:tool-calls@s",
      "session.status:busy@s",
      "message.updated:assistant@s",
      "message.part.updated:text@s",
      "message.updated:assistant:stop@s",
      "session.status:idle@s",
      "session.idle@s",
    ]);
    const messages = await oc.request<OcMessageWithParts[]>("GET", `/session/${session.id}/message`);
    const [first, reprise] = assistants(messages);
    assert.equal(first?.parentID, messages[0]?.info.id);
    assert.equal(reprise?.parentID, messages[0]?.info.id);
    assert.deepEqual([first?.cost, first?.finish, reprise?.cost, reprise?.finish], [0.01, "tool-calls", 0.002, "stop"]);
    assert.deepEqual(await oc.request("GET", "/permission"), []);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
    await assert.rejects(reply(oc, request.id, { reply: "once" }), (err: unknown) => {
      assert.ok(err instanceof OpencodeError && err.status === 404);
      assert.deepEqual(err.body, { _tag: "PermissionNotFoundError", requestID: request.id, message: `Permission request not found: ${request.id}` });
      return true;
    });
    assert.deepEqual(fake.failures, []);
  });

  it("reject sans message : refuse aussi les demandes sœurs de la session (F-c), pas celles des autres, et arrête le tour", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    const other = await newSession(oc);
    fake.script(session.id, { tools: [bash("git status"), bash("rm -rf dist")] });
    fake.script(other.id, { tools: [bash("pwd")] });
    await promptAsync(oc, session.id, "Deux commandes");
    await promptAsync(oc, other.id, "Une commande");
    await until(() => fake.pendingPermissions().length === 3);
    const listed = await oc.request<FakePermissionRequest[]>("GET", "/permission");
    const [first, sibling] = listed.filter((p) => p.sessionID === session.id);
    assert.ok(first && sibling);
    const since = fake.emitted.length;
    assert.equal(await reply(oc, first.id, { reply: "reject" }), true);
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since });
    assert.deepEqual(
      fake.emitted.slice(since).filter((w) => w.payload.type === "permission.replied").map((w) => props(w)),
      [
        { sessionID: session.id, requestID: first.id, reply: "reject" },
        { sessionID: session.id, requestID: sibling.id, reply: "reject" },
      ],
    );
    assert.deepEqual((await oc.request<FakePermissionRequest[]>("GET", "/permission")).map((p) => p.sessionID), [other.id]);
    const [message] = (await oc.request<OcMessageWithParts[]>("GET", `/session/${session.id}/message`)).filter((m) => m.info.role === "assistant");
    assert.ok(message);
    assert.deepEqual(toolParts(message).map((p) => [p.state.status, p.state.error]), [
      ["error", REJECTED],
      ["error", REJECTED],
    ]);
    assert.equal((message.info as OcAssistantMessage).finish, "tool-calls");
    assert.equal(assistants(fake.messages(session.id)).length, 1, "aucune reprise après un refus");
    assert.ok(!fake.emitted.slice(since).some((w) => w.payload.type === "session.error"));
    await assert.rejects(reply(oc, sibling.id, { reply: "once" }), statusIs(404));
  });

  it("reject avec message : consigne transmise, sœurs refusées ; seul, le tour reprend", async (t) => {
    const { fake, oc } = await startFake(t);
    const pair = await newSession(oc);
    fake.script(pair.id, { tools: [bash("grep -r TODO"), bash("find . -name x")] });
    await promptAsync(oc, pair.id, "Cherche");
    await until(() => fake.pendingPermissions().length === 2);
    const [first, sibling] = fake.pendingPermissions();
    assert.ok(first && sibling);
    await reply(oc, first.id, { reply: "reject", message: "Utilise plutôt rg." });
    await fake.waitForEvent("session.idle", (p) => p.sessionID === pair.id);
    const [pairMessage] = fake.messages(pair.id).filter((m) => m.info.role === "assistant");
    assert.ok(pairMessage);
    assert.deepEqual(toolParts(pairMessage).map((p) => p.state.error), [
      "The user rejected permission to use this specific tool call with the following feedback: Utilise plutôt rg.",
      REJECTED,
    ]);
    assert.deepEqual(fake.pendingPermissions(), []);

    const alone = await newSession(oc);
    fake.script(alone.id, { tools: [bash("grep -r TODO")], followUp: { text: "Avec rg." } });
    await promptAsync(oc, alone.id, "Cherche");
    const asked = await fake.waitForEvent("permission.asked", (p) => p.sessionID === alone.id);
    await reply(oc, String(asked.properties.id), { reply: "reject", message: "Utilise plutôt rg." });
    await fake.waitForEvent("session.idle", (p) => p.sessionID === alone.id);
    assert.deepEqual(assistants(fake.messages(alone.id)).map((m) => m.finish), ["tool-calls", "stop"]);
  });

  it("always : accorde les demandes sœurs couvertes et les suivantes sans demander", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    fake.script(session.id, { tools: [bash("git status"), bash("git status --short")] }, { tools: [bash("git log -1")], followUp: { text: "Journal." } });
    await promptAsync(oc, session.id, "État");
    await until(() => fake.pendingPermissions().length === 2);
    const [first, sibling] = fake.pendingPermissions();
    assert.ok(first && sibling);
    let since = fake.emitted.length;
    await reply(oc, first.id, { reply: "always" });
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since });
    assert.deepEqual(
      fake.emitted.slice(since).filter((w) => w.payload.type === "permission.replied").map((w) => [props(w).requestID, props(w).reply]),
      [
        [first.id, "always"],
        [sibling.id, "always"],
      ],
    );
    since = fake.emitted.length;
    await promptAsync(oc, session.id, "Dernier commit");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since });
    assert.ok(!fake.emitted.slice(since).some((w) => w.payload.type === "permission.asked"), "« git * » déjà accordé");
    assert.deepEqual(assistants(fake.messages(session.id)).map((m) => m.finish), ["tool-calls", "stop", "tool-calls", "stop"]);
  });

  it("règles : un deny ne pose aucune demande (F-b) ; la dernière règle l'emporte, session après agent (F-a, F-d)", async (t) => {
    const { fake, oc } = await startFake(t);
    const denied = await newSession(oc, { permission: [{ permission: "bash", pattern: "*", action: "deny" }] });
    fake.script(denied.id, { tools: [bash("cat .env")], followUp: { text: "Je continue sans." } });
    let since = fake.emitted.length;
    await promptAsync(oc, denied.id, "Lis");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === denied.id, { since });
    assert.ok(!fake.emitted.slice(since).some((w) => w.payload.type === "permission.asked"));
    const [deniedMessage] = fake.messages(denied.id).filter((m) => m.info.role === "assistant");
    assert.ok(deniedMessage);
    assert.match(String(toolParts(deniedMessage)[0]?.state.error), /^The user has specified a rule which prevents you from using this specific tool call\./);
    assert.deepEqual(assistants(fake.messages(denied.id)).map((m) => m.finish), ["tool-calls", "stop"]);

    const allowed = await newSession(oc, { permission: [{ permission: "bash", pattern: "git *", action: "allow" }] });
    fake.script(allowed.id, { tools: [bash("git log", { agentRules: [{ permission: "bash", pattern: "*", action: "deny" }] })] });
    since = fake.emitted.length;
    await promptAsync(oc, allowed.id, "Journal");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === allowed.id, { since });
    assert.ok(!fake.emitted.slice(since).some((w) => w.payload.type === "permission.asked"));
    const [allowedMessage] = fake.messages(allowed.id).filter((m) => m.info.role === "assistant");
    assert.equal(allowedMessage && toolParts(allowedMessage)[0]?.state.status, "completed");
  });

  it("task : sous-agent avec parentID, règles dérivées (F-f), metadata.sessionId, coûts non cumulés au parent", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    const root = await newSession(oc, {
      permission: [
        { permission: "read", pattern: "*.env", action: "deny" },
        { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
        { permission: "edit", pattern: "*", action: "ask" },
      ],
    });
    fake.script(root.id, {
      agent: "orchestrateur",
      cost: 0.01,
      tokens: { input: 300, output: 40 },
      tools: [
        {
          tool: "task",
          input: { description: "Analyser les journaux", prompt: "Lis app.log et résume.", subagent_type: "analyste-journaux" },
          ask: { permission: "task", patterns: ["analyste-journaux"], metadata: { description: "Analyser les journaux", subagent_type: "analyste-journaux" } },
          child: { agent: "analyste-journaux", text: "3 erreurs.", cost: 0.004, tokens: { input: 40, output: 8 }, agentRules: [{ permission: "todowrite", pattern: "*", action: "allow" }] },
        },
      ],
      followUp: { text: "Synthèse.", cost: 0.003 },
    });
    await promptAsync(oc, root.id, "Délègue");
    const asked = await fake.waitForEvent("permission.asked");
    const delegating = fake.messages(root.id).find((m) => m.info.role === "assistant");
    assert.ok(delegating);
    assert.equal(toolParts(delegating)[0]?.state.metadata, undefined, "en attente : pas encore d'enfant");
    await reply(oc, String(asked.properties.id), { reply: "once" });
    await until(() => events.find((e) => e.payload.type === "session.idle" && props(e).sessionID === root.id));

    const created = events.find((e) => e.payload.type === "session.created" && (props(e).info as FakeSession).parentID === root.id);
    const child = props(created ?? { payload: { type: "", properties: {} } }).info as FakeSession;
    assert.equal(child.agent, "analyste-journaux");
    assert.equal(child.title, "Analyser les journaux (@analyste-journaux subagent)");
    assert.deepEqual(child.permission, [
      { permission: "read", pattern: "*.env", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    const linked = events
      .map((e) => props(e).part as (OcPart & { state?: { status: string; metadata?: Record<string, unknown>; output?: string } }) | undefined)
      .filter((p) => p?.type === "tool");
    assert.deepEqual(linked.find((p) => p?.state?.status === "running" && p.state.metadata)?.state?.metadata, {
      parentSessionId: root.id,
      sessionId: child.id,
      model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
    });
    assert.ok(linked.find((p) => p?.state?.status === "completed")?.state?.output?.startsWith(`<task id="${child.id}" state="completed">`));
    assert.deepEqual((await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`)).map((s) => s.id), [child.id]);
    const childMessages = await oc.request<OcMessageWithParts[]>("GET", `/session/${child.id}/message`);
    assert.equal(childMessages[0]?.parts[0]?.text, "Lis app.log et résume.");
    assert.deepEqual(assistants(childMessages).map((m) => [m.agent, m.cost]), [["analyste-journaux", 0.004]]);
    const rootInfo = await oc.request<FakeSession>("GET", `/session/${root.id}`);
    assert.ok(Math.abs((rootInfo.cost ?? 0) - 0.013) < 1e-9, "coût propre de la racine seulement");
    assert.equal(rootInfo.tokens?.input, 300);
  });

  it("tour en erreur : session.error, repos, message clos avec l'erreur", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    const error = { name: "ProviderAuthError", data: { message: "Jeton Copilot refusé", providerID: "github-copilot" } };
    fake.script(session.id, { error });
    const since = fake.emitted.length;
    await promptAsync(oc, session.id, "Bonjour");
    await until(() => assistants(fake.messages(session.id))[0]?.error);
    assertSubsequence(trace(fake.emitted.slice(since), { [session.id]: "s" }), [
      "session.status:busy@s",
      "message.updated:assistant@s",
      "session.error:ProviderAuthError@s",
      "session.status:idle@s",
      "session.idle@s",
      "message.updated:assistant:ProviderAuthError@s",
    ]);
    const errored = await fake.waitForEvent("session.error", (p) => p.sessionID === session.id);
    assert.deepEqual(errored.properties.error, error);
    await until(() => fake.statusOf(session.id).type === "idle");
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
  });
});

describe("faux opencode : arrêt", () => {
  /** p6 : un sous-agent travaille, une seconde délégation attend son autorisation. */
  async function stuckDelegation(t: TestContext) {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc, { title: "Arrêt" });
    fake.script(root.id, {
      agent: "orchestrateur",
      tools: [
        {
          tool: "task",
          input: { description: "Analyser les journaux .log", prompt: "Lis app.log", subagent_type: "analyste-journaux" },
          child: { agent: "analyste-journaux", workMs: 60_000 },
        },
        {
          tool: "task",
          input: { description: "Analyser changements.md", prompt: "Lis changements.md", subagent_type: "analyste-changements" },
          ask: { permission: "task", patterns: ["analyste-changements"], metadata: { description: "Analyser changements.md", subagent_type: "analyste-changements" } },
          child: { agent: "analyste-changements", text: "Deux changements." },
        },
      ],
    });
    assert.equal(await promptAsync(oc, root.id, "Consulte les deux analystes."), 204);
    const asked = await fake.waitForEvent("permission.asked");
    const created = await fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id);
    const child = (created.properties.info as FakeSession).id;
    await until(() => fake.statusOf(child).type === "busy");
    return { fake, oc, root, child, request: asked.properties as unknown as FakePermissionRequest };
  }

  it("abort pendant l'attente : MessageAbortedError sur le sous-agent puis la racine, outils interrompus, demande toujours en attente (p6)", async (t) => {
    const { fake, oc, root, child, request } = await stuckDelegation(t);
    const since = fake.emitted.length;
    assert.equal(await oc.request("POST", `/session/${root.id}/abort`), true);
    assert.deepEqual(trace(fake.emitted.slice(since), { [root.id]: "racine", [child]: "enfant" }), [
      "session.error:MessageAbortedError@enfant",
      "session.status:idle@enfant",
      "session.idle@enfant",
      "message.updated:assistant:MessageAbortedError@enfant",
      "session.status:idle@enfant",
      "session.idle@enfant",
      "session.error:MessageAbortedError@racine",
      "session.status:idle@racine",
      "session.idle@racine",
      "message.part.updated:tool:error@racine",
      "message.part.updated:tool:error@racine",
      "message.updated:assistant:MessageAbortedError@racine",
      "session.status:idle@racine",
      "session.idle@racine",
    ]);
    const message = await oc.request<OcMessageWithParts>("GET", `/session/${root.id}/message/${request.tool?.messageID}`);
    assert.deepEqual((message.info as OcAssistantMessage).error, { name: "MessageAbortedError", data: { message: "Aborted" } });
    assert.deepEqual(toolParts(message).map((p) => [p.state.status, p.state.error, p.state.metadata]), [
      ["error", "Tool execution aborted", { parentSessionId: root.id, sessionId: child, model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, interrupted: true }],
      ["error", "Tool execution aborted", { interrupted: true }],
    ]);
    assert.deepEqual(await oc.request("GET", "/permission"), [request]);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
    assert.deepEqual(fake.failures, []);
  });

  it("once tardif après l'arrêt : sous-agent détaché qui travaille, parent jamais repris (p7)", async (t) => {
    const { fake, oc, root, request } = await stuckDelegation(t);
    await oc.request("POST", `/session/${root.id}/abort`);
    const since = fake.emitted.length;
    assert.equal(await reply(oc, request.id, { reply: "once" }), true);
    const created = await fake.waitForEvent("session.created", (p) => (p.info as FakeSession).agent === "analyste-changements", { since });
    const detached = created.properties.info as FakeSession;
    assert.equal(detached.parentID, root.id);
    assert.equal(detached.title, "Analyser changements.md (@analyste-changements subagent)");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === detached.id, { since });
    assert.deepEqual(trace(fake.emitted.slice(since), { [root.id]: "racine" }), ["permission.replied:once@racine"]);
    assert.deepEqual(assistants(await oc.request<OcMessageWithParts[]>("GET", `/session/${detached.id}/message`)).map((m) => m.finish), ["stop"]);
    const rootAssistants = assistants(fake.messages(root.id));
    assert.equal(rootAssistants.length, 1);
    assert.equal(rootAssistants[0]?.error?.name, "MessageAbortedError");
  });

  it("abort d'une session au repos : repos seulement, sans session.error", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    const since = fake.emitted.length;
    assert.equal(await oc.request("POST", `/session/${session.id}/abort`), true);
    assert.deepEqual(trace(fake.emitted.slice(since), { [session.id]: "s" }), ["session.status:idle@s", "session.idle@s"]);
  });
});

/** Comptes génériques (CI, conteneurs) : leur nom figure dans des champs ordinaires des captures (`root`…), ce n'est pas une personne. */
const GENERIC_ACCOUNTS = new Set(["root", "node", "runner", "admin", "user", "ubuntu", "vscode", "github", "docker"]);

/** Nom de l'utilisateur qui lance les tests (4 caractères au moins, comptes génériques exclus) ; jamais écrit dans le dépôt. */
function localUsername(): string | null {
  try {
    const name = os.userInfo().username.toLowerCase();
    return name.length >= 4 && !GENERIC_ACCOUNTS.has(name) ? name : null;
  } catch {
    return null;
  }
}

/** Recherche de fixtures/README.md (« Nettoyage ») : noms des motifs trouvés dans `text`. */
function leaks(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["en-tête ou mot de passe", /authorization|\bbasic [A-Za-z0-9+/=]{8,}|\bbearer |password/i],
    ["jeton GitHub", /gh[oprsu]_[A-Za-z0-9]{20}|github_pat_/i],
    ["clé sk-", /\bsk-[A-Za-z0-9_-]{16,}/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\./],
    ["clé privée", /-----BEGIN/],
    ["adresse e-mail", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ["adresse IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
    ["localhost", /localhost/],
    ["chemin d'hôte", /\b[A-Za-z]:(\\\\|\/)|\/Users\/|AppData/],
  ];
  const found = patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const user = localUsername();
  if (user && text.toLowerCase().includes(user)) found.push("nom d'utilisateur");
  return found;
}

describe("faux opencode : captures réelles", () => {
  it("garde-fou des captures : chaque motif du README détecté sur un exemple planté (IP du réseau, sk-, JWT, ghr_, nom d'utilisateur)", () => {
    const planted: Array<[string, string]> = [
      ["adresse IP", `{"message":"connect ECONNREFUSED ${[172, 18, 0, 3].join(".")}:4096"}`],
      ["adresse IP", `{"url":"http://${[127, 0, 0, 1].join(".")}:4096"}`],
      ["clé sk-", `{"output":"${"sk"}-ant-${"a1B2c3D4".repeat(3)}"}`],
      ["JWT", `{"text":"${"ey"}JhbGciOiJIUzI1NiJ9.${"e30"}.x"}`],
      ["jeton GitHub", `{"text":"${"gh"}r_${"A".repeat(36)}"}`],
      ["jeton GitHub", `{"text":"${"gh"}o_${"b".repeat(36)}"}`],
      ["en-tête ou mot de passe", `{"headers":{"${"Author"}ization":"x"}}`],
      ["clé privée", `${"-".repeat(5)}BEGIN`],
      ["adresse e-mail", `{"text":"contact@exemple.fr"}`],
      ["localhost", `{"url":"http://localhost:4096"}`],
      ["chemin d'hôte", `{"cwd":"C:\\\\Users\\\\x"}`],
    ];
    for (const [label, sample] of planted) assert.ok(leaks(sample).includes(label), `${label} non détecté`);
    const user = localUsername();
    if (user) assert.ok(leaks(`{"cwd":"/home/${user}/projet"}`).includes("nom d'utilisateur"), "nom d'utilisateur non détecté");
    assert.deepEqual(leaks(`{"version":"1.18.30","id":"ses_f618ff214ffevi6gfuGx6TvpTP","path":{"root":"/"}}`), []);
  });

  it("image « app » : faux opencode, captures et tests retirés dans l'étape de construction, jamais copiés dans l'image finale", () => {
    const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const [, build = "", final = ""] = dockerfile.split(/^FROM .*$/m);
    const copied = build.indexOf("COPY app/ ./");
    assert.ok(copied !== -1, "sources copiées dans l'étape de construction");
    assert.match(build.slice(copied), /rm -rf server\/test-support\b/);
    assert.match(build.slice(copied), /find server -name '\*\.test\.ts' -delete/);
    assert.doesNotMatch(final, /^COPY (?!--from=build )/m, "image finale : copies depuis l'étape de construction seulement");
    // Une suppression dans l'image finale laisserait les fichiers dans la couche copiée : rien à y retirer.
    assert.doesNotMatch(final, /test-support|\.test\.ts/);
  });

  it("fixtures p1, p2, p6, p7 : lisibles, 300 Ko au plus, sans secret ni chemin d'hôte, contenu attendu", () => {
    let total = 0;
    const byName = new Map<string, Array<{ recv: number; payload: OcEvent | SyncPayload }>>();
    for (const name of FIXTURES) {
      const text = fs.readFileSync(new URL(`./test-support/fixtures/${name}`, import.meta.url), "utf8");
      total += Buffer.byteLength(text);
      assert.deepEqual(leaks(text), [], name);
      const rows = readCapture(name);
      assert.ok(rows.length > 0, name);
      byName.set(name, rows.map((r) => ({ recv: r.recv, payload: r.wire.payload })));
    }
    assert.ok(total <= 300_000, `fixtures trop lourdes : ${total} octets`);
    const of = (name: string, type: string) => (byName.get(name) ?? []).filter((r) => r.payload.type === type);
    const withParent = (name: string) => of(name, "session.created").filter((r) => (props(r).info as FakeSession).parentID);
    assert.equal(withParent("p1-delegation-parallele.jsonl").length, 2);
    assert.equal(of("p1-delegation-parallele.jsonl", "permission.asked").length, 1);
    assert.equal(of("p2-commande-subtask.jsonl", "command.executed").length, 1);
    assert.ok(of("p6-arret-global.jsonl", "sync").length > 0);
    const neverStarted = of("p6-arret-global.jsonl", "message.part.updated")
      .map((r) => props(r).part as { state?: { status: string; metadata?: Record<string, unknown> } })
      .filter((p) => p.state?.status === "error" && p.state.metadata?.interrupted === true && p.state.metadata.sessionId === undefined);
    assert.equal(neverStarted.length, 1, "p6 : délégation jamais démarrée");
    assert.deepEqual(of("p7-autorisation-orpheline.jsonl", "permission.replied").map((r) => props(r).reply), ["once"]);
    assert.equal(withParent("p7-autorisation-orpheline.jsonl").length, 1);
  });

  it("capture p6 rejouée par le faux : le client reçoit les mêmes blocs, jumeaux sync compris", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    const rows = readCapture("p6-arret-global.jsonl").filter((r) => !r.wire.payload.type.startsWith("server."));
    for (const row of rows) fake.emitRaw(row.wire);
    const received = await until(() => {
      const list = events.filter((e) => !e.payload.type.startsWith("server."));
      return list.length === rows.length ? list : false;
    });
    assert.deepEqual(received, rows.map((r) => r.wire));
  });
});

describe("faux opencode : attentes", () => {
  it("prédicat de waitForEvent qui lève : l'attente rejette avec cette erreur, le faux continue (réponse 204, jumeau sync, tour, autres attentes)", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    fake.script(session.id, { text: "Fini." });
    const since = fake.emitted.length;
    const status = (p: Record<string, unknown>) => (p.part as { state: { status: string } }).state.status;
    const faulty = assert.rejects(fake.waitForEvent("message.part.updated", (p) => status(p) === "completed", { timeoutMs: 2000 }), TypeError);
    const healthy = fake.waitForEvent("message.part.updated", (p) => (p.part as OcPart).type === "text", { since, timeoutMs: 2000 });
    assert.equal(await promptAsync(oc, session.id, "Bonjour"), 204);
    await faulty;
    assert.equal((await healthy).properties.sessionID, session.id);
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since });
    assert.ok(
      fake.emitted.slice(since).some((w) => w.payload.type === "sync" && (w.payload as SyncPayload).syncEvent.type === "message.part.updated.1"),
      "jumeau sync de la partie",
    );
    assert.deepEqual(assistants(fake.messages(session.id)).map((m) => m.finish), ["stop"]);
    // Balayage de l'historique : même erreur, rendue par la promesse.
    await assert.rejects(fake.waitForEvent("message.part.updated", (p) => status(p) === "x", { since }), TypeError);
    assert.deepEqual(fake.failures, []);
  });

  it("tour en erreur puis relance : les deux repos du tour en erreur émis ensemble, une attente relevée ensuite ne voit que la relance ; settled()", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    const error = { name: "ProviderAuthError", data: { message: "Jeton Copilot refusé", providerID: "github-copilot" } };
    fake.script(session.id, { error }, { tools: [bash("ls")], followUp: { text: "Liste." } });
    let since = fake.emitted.length;
    await promptAsync(oc, session.id, "Bonjour");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since });
    since = fake.emitted.length;
    await promptAsync(oc, session.id, "Liste");
    await until(() => fake.pendingPermissions().length === 1);
    const relance = trace(fake.emitted.slice(since), { [session.id]: "s" });
    assert.equal(relance[0], "message.updated:user@s", relance.join(", "));
    assert.ok(!relance.includes("session.idle@s"), relance.join(", "));
    assert.equal(await reply(oc, fake.pendingPermissions()[0]?.id ?? "", { reply: "once" }), true);
    await fake.settled(session.id);
    assert.equal(fake.statusOf(session.id).type, "idle");
    assert.deepEqual(assistants(fake.messages(session.id)).map((m) => m.error?.name ?? m.finish), ["ProviderAuthError", "tool-calls", "stop"]);
    assert.equal(await fake.settled("ses_sans_tour"), undefined);
    assert.deepEqual(fake.failures, []);
  });
});

describe("faux opencode : demandes de l'agent", () => {
  it("doom_loop : règles de l'agent seules (règles de session ignorées), demande sans appel d'outil (F-j) ; un outil de la même session reste refusé sans demande (F-b)", async (t) => {
    const { fake, oc } = await startFake(t);
    // Forme d'une session d'étape : tout refusé, lecture permise.
    const etape = await newSession(oc, { permission: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "read", pattern: "*", action: "allow" }] });
    const agentRules = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "doom_loop", pattern: "*", action: "ask" as const },
    ];
    fake.script(etape.id, {
      tools: [
        {
          tool: "read",
          input: { filePath: "app.log" },
          ask: { permission: "doom_loop", patterns: ["read"], metadata: { tool: "read", input: { filePath: "app.log" } }, always: ["read"] },
          agentRules,
          output: "contenu",
        },
      ],
      followUp: { text: "Lu." },
    });
    let since = fake.emitted.length;
    await promptAsync(oc, etape.id, "Lis app.log");
    const asked = await fake.waitForEvent("permission.asked", (p) => p.sessionID === etape.id, { since });
    assert.equal("tool" in asked.properties, false);
    const listed = await oc.request<FakePermissionRequest[]>("GET", "/permission");
    assert.deepEqual(listed, [asked.properties]);
    assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), ["always", "id", "metadata", "patterns", "permission", "sessionID"]);
    assert.equal(await reply(oc, String(asked.properties.id), { reply: "once" }), true);
    await fake.waitForEvent("session.idle", (p) => p.sessionID === etape.id, { since });
    assert.equal(fake.messages(etape.id).flatMap((m) => toolParts(m))[0]?.state.status, "completed");

    fake.script(etape.id, { tools: [bash("rm -rf dist", { agentRules })] });
    since = fake.emitted.length;
    await promptAsync(oc, etape.id, "Nettoie");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === etape.id, { since });
    assert.ok(!fake.emitted.slice(since).some((w) => w.payload.type === "permission.asked"));
    assert.match(String(fake.messages(etape.id).flatMap((m) => toolParts(m)).at(-1)?.state.error), /^The user has specified a rule which prevents you/);
    assert.deepEqual(fake.failures, []);
  });
});

describe("faux opencode : rechargement", () => {
  it("POST /instance/dispose : true, puis seule l'instance du dossier est libérée (tours coupés, demandes et états vidés) et server.instance.disposed {directory}", async (t) => {
    const { fake, oc } = await startFake(t);
    const a = await newSession(oc, {}, "/workspace/a");
    const b = await newSession(oc, {}, "/workspace/b");
    fake.script(a.id, { tools: [bash("ls")] });
    fake.script(b.id, { tools: [bash("pwd")] });
    await promptAsync(oc, a.id, "A");
    await promptAsync(oc, b.id, "B");
    await until(() => fake.pendingPermissions().length === 2);
    const since = fake.emitted.length;
    assert.equal(await oc.request("POST", "/instance/dispose", { directory: "/workspace/a" }), true);
    const disposed = await fake.waitForEvent("server.instance.disposed", () => true, { since });
    assert.deepEqual(disposed.properties, { directory: "/workspace/a" });
    const wire = fake.emitted.find((w) => w.payload === disposed);
    assert.deepEqual([wire?.directory, wire?.project], ["/workspace/a", "global"]);
    assert.deepEqual(fake.emitted.slice(since).map((w) => w.payload.type), ["server.instance.disposed"]);
    assert.deepEqual(await oc.request("GET", "/permission", { directory: "/workspace/a" }), []);
    assert.deepEqual(await oc.request("GET", "/session/status", { directory: "/workspace/a" }), {});
    assert.deepEqual((await oc.request<FakePermissionRequest[]>("GET", "/permission", { directory: "/workspace/b" })).map((p) => p.sessionID), [b.id]);
    assert.deepEqual(await oc.request("GET", "/session/status", { directory: "/workspace/b" }), { [b.id]: { type: "busy" } });
    assert.deepEqual(fake.failures, []);
  });

  it("POST /global/dispose : chaque instance chargée libérée puis server.instance.disposed, enfin global.disposed, puis réponse true ; emitGlobalDisposed émet aussi les événements d'instance", async (t) => {
    const { fake, oc } = await startFake(t);
    const events = await subscribe(t, oc);
    await newSession(oc, {}, "/workspace/a");
    const b = await newSession(oc, {}, "/workspace/b");
    fake.script(b.id, { tools: [bash("pwd")] });
    await promptAsync(oc, b.id, "B");
    await until(() => fake.pendingPermissions().length === 1);
    const kinds = (from: number) => fake.emitted.slice(from).map((w) => `${w.payload.type}@${w.directory}`);
    let since = fake.emitted.length;
    assert.equal(await oc.request("POST", "/global/dispose"), true);
    const seen = kinds(since);
    assert.equal(seen.at(-1), "global.disposed@global");
    assert.deepEqual(seen.slice(0, -1).sort(), [
      "server.instance.disposed@/workspace",
      "server.instance.disposed@/workspace/a",
      "server.instance.disposed@/workspace/b",
    ]);
    const received = await until(() => events.find((e) => e.payload.type === "server.instance.disposed" && e.directory === "/workspace/b"));
    assert.deepEqual([received.project, received.payload.properties], ["global", { directory: "/workspace/b" }]);
    assert.deepEqual(await oc.request("GET", "/permission", { directory: "/workspace/b" }), []);
    assert.deepEqual(await oc.request("GET", "/session/status", { directory: "/workspace/b" }), {});
    // Instance rechargée par ces lectures : emitGlobalDisposed l'annonce aussi, avant global.disposed.
    since = fake.emitted.length;
    fake.emitGlobalDisposed();
    assert.deepEqual(kinds(since), ["server.instance.disposed@/workspace/b", "global.disposed@global"]);
    assert.deepEqual(fake.failures, []);
  });
});

describe("faux opencode : IA et variante", () => {
  it("prompt_async {agent, model, variant} : session.updated (assistant, IA, variante) avant le message, variante sur les messages, héritée par l'enfant d'un task sauf IA fixée par l'agent cible ; sans variante : « default » sur la session, champ absent des messages", async (t) => {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc, { title: "Variante" });
    const model = { providerID: "github-copilot", modelID: "claude-opus-5" };
    const fixed = { providerID: "github-copilot", modelID: "gpt-5-mini" };
    const task = (agent: string, child: Partial<NonNullable<FakeToolScript["child"]>> = {}): FakeToolScript => ({
      tool: "task",
      input: { description: `Déléguer à ${agent}`, prompt: "Lis app.log", subagent_type: agent },
      child: { agent, text: "Rien.", ...child },
    });
    fake.script(root.id, { tools: [task("analyste"), task("fixe", { model: fixed })], followUp: { text: "Synthèse." } });
    const since = fake.emitted.length;
    assert.equal(await promptAsync(oc, root.id, "Délègue", { agent: "orchestrateur", model, variant: "high" }), 204);
    await fake.waitForEvent("session.idle", (p) => p.sessionID === root.id, { since });

    assert.deepEqual(trace(fake.emitted.slice(since), { [root.id]: "racine" }).slice(0, 2), ["session.updated@racine", "message.updated:user@racine"]);
    const stored = await oc.request<FakeSession>("GET", `/session/${root.id}`);
    assert.deepEqual([stored.agent, stored.model], ["orchestrateur", { id: "claude-opus-5", providerID: "github-copilot", variant: "high" }]);
    assert.deepEqual((fake.messages(root.id)[0]?.info as OcUserMessage).model, { ...model, variant: "high" });
    assert.deepEqual(assistants(fake.messages(root.id)).map((m) => m.variant), ["high", "high"]);
    const delegating = fake.messages(root.id).find((m) => m.info.role === "assistant");
    assert.ok(delegating);
    assert.deepEqual(toolParts(delegating).map((p) => (p.state.metadata as { model?: unknown }).model), [model, fixed]);

    const children = await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`);
    const heir = children.find((s) => s.agent === "analyste");
    const own = children.find((s) => s.agent === "fixe");
    assert.ok(heir && own);
    assert.deepEqual(heir.model, { id: "claude-opus-5", providerID: "github-copilot", variant: "high" });
    assert.deepEqual((fake.messages(heir.id)[0]?.info as OcUserMessage).model, { ...model, variant: "high" });
    assert.deepEqual(assistants(fake.messages(heir.id)).map((m) => m.variant), ["high"]);
    assert.deepEqual(trace(fake.emitted.slice(since), { [heir.id]: "enfant" }).slice(0, 3), ["session.created@enfant", "session.updated@enfant", "message.updated:user@enfant"]);
    assert.deepEqual(own.model, { id: "gpt-5-mini", providerID: "github-copilot", variant: "default" });
    assert.deepEqual((fake.messages(own.id)[0]?.info as OcUserMessage).model, fixed);
    assert.ok(assistants(fake.messages(own.id)).every((m) => !("variant" in m)));

    // Sans variante : « default » sur la session, champ absent des messages ; même assistant et même IA : aucun session.updated avant le message.
    const plain = await newSession(oc);
    let from = fake.emitted.length;
    await promptAsync(oc, plain.id, "Bonjour");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === plain.id, { since: from });
    const plainInfo = await oc.request<FakeSession>("GET", `/session/${plain.id}`);
    assert.deepEqual([plainInfo.agent, plainInfo.model], ["build", { id: "gpt-5-mini", providerID: "github-copilot", variant: "default" }]);
    assert.ok(!("variant" in (fake.messages(plain.id)[0]?.info as OcUserMessage).model));
    assert.ok(assistants(fake.messages(plain.id)).every((m) => !("variant" in m)));
    from = fake.emitted.length;
    await promptAsync(oc, plain.id, "Encore");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === plain.id, { since: from });
    assert.equal(trace(fake.emitted.slice(from), { [plain.id]: "s" })[0], "message.updated:user@s");
    assert.deepEqual(fake.failures, []);
  });
});

describe("faux opencode : délégation et arrêts ciblés", () => {
  /** La racine délègue sans demande à un enfant qui travaille longtemps. */
  async function workingChild(t: TestContext) {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc, { title: "Délégation" });
    fake.script(root.id, {
      cost: 0.01,
      tools: [{ tool: "task", input: { description: "Analyser app.log", prompt: "Lis app.log", subagent_type: "analyste" }, child: { agent: "analyste", workMs: 60_000 } }],
      followUp: { text: "Sans le résultat.", cost: 0.002 },
    });
    assert.equal(await promptAsync(oc, root.id, "Délègue"), 204);
    const created = await fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id);
    const child = (created.properties.info as FakeSession).id;
    await until(() => fake.statusOf(child).type === "busy");
    return { fake, oc, root, child };
  }

  /** Enfant arrêté : « Task cancelled » chez la racine (metadata gardée), reprise facturée, aucun outil ouvert dans un message clos. */
  async function assertCancelledThenResumed(fake: FakeOpencode, rootID: string, child: string, since: number) {
    await fake.waitForEvent("session.idle", (p) => p.sessionID === rootID, { since });
    const rootAssistants = assistants(fake.messages(rootID));
    assert.deepEqual(rootAssistants.map((m) => m.finish), ["tool-calls", "stop"]);
    assert.equal(rootAssistants[0]?.parentID, rootAssistants[1]?.parentID);
    const delegating = fake.messages(rootID).find((m) => m.info.role === "assistant");
    assert.ok(delegating);
    assert.deepEqual(toolParts(delegating).map((p) => [p.state.status, p.state.error, p.state.metadata]), [
      ["error", "Task cancelled", { parentSessionId: rootID, sessionId: child, model: { providerID: "github-copilot", modelID: "gpt-5-mini" } }],
    ]);
    assert.ok(Math.abs((fake.session(rootID)?.cost ?? 0) - 0.012) < 1e-9, "reprise facturée");
    for (const id of [rootID, child]) {
      for (const message of fake.messages(id)) {
        if (message.info.role !== "assistant" || (message.info as OcAssistantMessage).time.completed === undefined) continue;
        assert.ok(toolParts(message).every((p) => p.state.status !== "pending" && p.state.status !== "running"), "outil ouvert dans un message clos");
      }
    }
    assert.deepEqual(fake.failures, []);
  }

  it("arrêt de l'enfant seul : MessageAbortedError puis repos chez l'enfant, « Task cancelled » chez la racine qui reprend (et facture)", async (t) => {
    const { fake, oc, root, child } = await workingChild(t);
    const since = fake.emitted.length;
    assert.equal(await oc.request("POST", `/session/${child}/abort`), true);
    await assertCancelledThenResumed(fake, root.id, child, since);
    assertSubsequence(trace(fake.emitted.slice(since), { [root.id]: "racine", [child]: "enfant" }), [
      "session.error:MessageAbortedError@enfant",
      "session.status:idle@enfant",
      "session.idle@enfant",
      "message.updated:assistant:MessageAbortedError@enfant",
      "session.status:idle@enfant",
      "session.idle@enfant",
      "message.part.updated:tool:error@racine",
      "message.updated:assistant:tool-calls@racine",
      "session.status:busy@racine",
      "message.updated:assistant@racine",
      "message.updated:assistant:stop@racine",
      "session.status:idle@racine",
      "session.idle@racine",
    ]);
  });

  it("DELETE d'un enfant « task » occupé : arrêt visible chez l'enfant avant session.deleted, « Task cancelled » chez la racine qui reprend", async (t) => {
    const { fake, oc, root, child } = await workingChild(t);
    const since = fake.emitted.length;
    assert.equal(await oc.request("DELETE", `/session/${child}`), true);
    await assertCancelledThenResumed(fake, root.id, child, since);
    assertSubsequence(trace(fake.emitted.slice(since), { [root.id]: "racine", [child]: "enfant" }), [
      "session.error:MessageAbortedError@enfant",
      "message.updated:assistant:MessageAbortedError@enfant",
      "session.deleted@enfant",
      "message.part.updated:tool:error@racine",
      "message.updated:assistant:stop@racine",
    ]);
    assert.deepEqual(await oc.request("GET", `/session/${root.id}/children`), []);
  });

  it("DELETE d'une session occupée : session.deleted, la session reste occupée, puis son tour échoue à sa prochaine écriture (clé étrangère) et passe au repos ; jamais coupé en silence", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    fake.script(session.id, { text: "Trop tard.", stepMs: 150 });
    const since = fake.emitted.length;
    assert.equal(await promptAsync(oc, session.id, "Bonjour"), 204);
    await fake.waitForEvent("session.status", (p) => p.sessionID === session.id && (p.status as { type: string }).type === "busy", { since });
    assert.equal(await oc.request("DELETE", `/session/${session.id}`), true);
    const deleted = fake.emitted.findIndex((w) => w.payload.type === "session.deleted" && props(w).sessionID === session.id);
    assert.ok(deleted >= since);
    assert.deepEqual(await oc.request("GET", "/session/status"), { [session.id]: { type: "busy" } });
    const failed = await fake.waitForEvent("session.error", (p) => p.sessionID === session.id, { since: deleted });
    assert.deepEqual(failed.properties.error, { name: "UnknownError", data: { message: "FOREIGN KEY constraint failed" } });
    await fake.waitForEvent("session.idle", (p) => p.sessionID === session.id, { since: deleted });
    assert.deepEqual(trace(fake.emitted.slice(deleted + 1), { [session.id]: "s" }), ["session.error:UnknownError@s", "session.status:idle@s", "session.idle@s"]);
    assert.deepEqual(await oc.request("GET", "/session/status"), {});
    assert.deepEqual(fake.failures, []);
  });

  it("abort avant busy (juste après le 204) : un seul repos, sans session.error ni message d'assistant", async (t) => {
    const { fake, oc } = await startFake(t);
    const session = await newSession(oc);
    fake.script(session.id, { text: "Jamais.", stepMs: 300 });
    assert.equal(await promptAsync(oc, session.id, "Bonjour"), 204);
    const since = fake.emitted.length;
    assert.equal(await oc.request("POST", `/session/${session.id}/abort`), true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(trace(fake.emitted.slice(since), { [session.id]: "s" }), ["session.status:idle@s", "session.idle@s"]);
    assert.deepEqual(assistants(fake.messages(session.id)), []);
    assert.deepEqual(fake.failures, []);
  });

  it("délégation autorisée d'office : aucun « running » sans metadata, l'enfant est créé d'abord (p1, p6) ; avec demande : « running » sans metadata juste après permission.asked (p1)", async (t) => {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc);
    const task = (callID: string, agent: string, ask?: FakeToolScript["ask"]): FakeToolScript => ({
      tool: "task",
      callID,
      input: { description: `Déléguer à ${agent}`, prompt: "Lis", subagent_type: agent },
      ...(ask ? { ask } : {}),
      child: { agent, text: "Fait." },
    });
    fake.script(root.id, { tools: [task("call_libre", "libre"), task("call_demande", "demande", { permission: "task", patterns: ["demande"] })], followUp: { text: "Synthèse." } });
    const since = fake.emitted.length;
    await promptAsync(oc, root.id, "Délègue");
    const asked = await fake.waitForEvent("permission.asked", () => true, { since });
    assert.equal(await reply(oc, String(asked.properties.id), { reply: "once" }), true);
    await fake.waitForEvent("session.idle", (p) => p.sessionID === root.id, { since });
    const steps = (callID: string, agent: string) =>
      fake.emitted.slice(since).flatMap((w) => {
        if (w.payload.type === "sync") return [];
        const p = props(w);
        if (w.payload.type === "session.created" && (p.info as FakeSession).agent === agent) return ["enfant créé"];
        if (w.payload.type === "permission.asked" && (p.tool as { callID?: string } | undefined)?.callID === callID) return ["demande"];
        const part = p.part as (OcPart & { state?: { status: string; metadata?: unknown } }) | undefined;
        if (w.payload.type !== "message.part.updated" || part?.callID !== callID) return [];
        return [`${part.state?.status}${part.state?.metadata ? "+metadata" : ""}`];
      });
    assert.deepEqual(steps("call_libre", "libre"), ["pending", "enfant créé", "running+metadata", "completed+metadata"]);
    assert.deepEqual(steps("call_demande", "demande"), ["pending", "demande", "running", "enfant créé", "running+metadata", "completed+metadata"]);
  });

  it("task avec task_id d'un enfant existant : session reprise (ni création ni second enfant, messages ajoutés) ; task_id inconnu : nouvel enfant", async (t) => {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc);
    const task = (extra: Record<string, unknown> = {}): FakeToolScript => ({
      tool: "task",
      input: { description: "Analyser app.log", prompt: "Lis app.log", subagent_type: "analyste", ...extra },
      child: { agent: "analyste", text: "Résumé." },
    });
    const run = async (text: string) => {
      const from = fake.emitted.length;
      await promptAsync(oc, root.id, text);
      await fake.waitForEvent("session.idle", (p) => p.sessionID === root.id, { since: from });
      return from;
    };
    fake.script(root.id, { tools: [task()] });
    await run("Délègue");
    const [first] = await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`);
    assert.ok(first);
    fake.script(root.id, { tools: [task({ task_id: first.id })] });
    const from = await run("Reprends");
    assert.ok(!fake.emitted.slice(from).some((w) => w.payload.type === "session.created"), "aucune création");
    assert.deepEqual((await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`)).map((s) => s.id), [first.id]);
    assert.deepEqual(fake.messages(first.id).map((m) => m.info.role), ["user", "assistant", "user", "assistant"]);
    const resumed = fake.messages(root.id).flatMap((m) => toolParts(m)).at(-1);
    assert.ok(String(resumed?.state.output).startsWith(`<task id="${first.id}" state="completed">`));
    assert.equal((resumed?.state.metadata as { sessionId?: string }).sessionId, first.id);

    fake.script(root.id, { tools: [task({ task_id: "ses_inconnue" })] });
    await run("Nouvelle délégation");
    assert.equal((await oc.request<FakeSession[]>("GET", `/session/${root.id}/children`)).length, 2);
    assert.deepEqual(fake.failures, []);
  });

  it("enfant « task » scripté par un tour complet : demande posée par l'enfant, coût de l'enfant à chaque étape, résultat = dernier texte de l'enfant", async (t) => {
    const { fake, oc } = await startFake(t);
    const root = await newSession(oc);
    fake.script(root.id, {
      tools: [
        {
          tool: "task",
          input: { description: "Chercher les TODO", prompt: "Cherche", subagent_type: "chercheur" },
          child: { agent: "chercheur", turn: { cost: 0.003, stepMs: 50, tools: [bash("grep -r TODO")], followUp: { text: "2 TODO.", cost: 0.001 } } },
        },
      ],
      followUp: { text: "Synthèse." },
    });
    const since = fake.emitted.length;
    await promptAsync(oc, root.id, "Délègue");
    const asked = await fake.waitForEvent("permission.asked", () => true, { since });
    const childID = String(asked.properties.sessionID);
    assert.notEqual(childID, root.id);
    assert.equal(fake.session(childID)?.parentID, root.id);
    assert.equal(fake.statusOf(childID).type, "busy");
    assert.equal(await reply(oc, String(asked.properties.id), { reply: "once" }), true);
    const billed = await fake.waitForEvent("session.updated", (p) => p.sessionID === childID && ((p.info as FakeSession).cost ?? 0) > 0, { since });
    assert.ok(Math.abs(((billed.properties.info as FakeSession).cost ?? 0) - 0.003) < 1e-9, "coût de la première étape");
    assert.equal(fake.statusOf(root.id).type, "busy", "la racine attend encore");
    await fake.waitForEvent("session.idle", (p) => p.sessionID === root.id, { since });
    assert.deepEqual(assistants(fake.messages(childID)).map((m) => m.finish), ["tool-calls", "stop"]);
    assert.ok(Math.abs((fake.session(childID)?.cost ?? 0) - 0.004) < 1e-9);
    const delegating = fake.messages(root.id).find((m) => m.info.role === "assistant");
    assert.ok(delegating);
    assert.match(String(toolParts(delegating)[0]?.state.output), /<task_result>\n2 TODO\.\n<\/task_result>/);
    assert.deepEqual(fake.failures, []);
  });
});
