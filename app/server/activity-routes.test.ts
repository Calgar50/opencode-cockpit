// Dérivation « facts » et routes d'activité (spécification §3.9, §3.10, §5.7.3, P12 ; plan d'exécution, fiche L4b, Q4) : captures
// p1, p6 puis p7 rejouées sur le faux opencode avec le processeur réel (faits persistés, délégations et attentes par le port, aucun
// texte, état final jamais régressé), libération d'instance (M14), session inconnue (sessions.ensure hors de l'appel, 5 s, 30 s),
// onEvent sans appel réseau (espion), formes de GET …/activity et …/facts et leurs 400, POST …/facts/affichage (CSRF, 404, aucun
// contenu, un fait par 2 s, mémoire bornée), purge par la suppression d'une conversation, routes absentes sans le module.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { activityDerivation, ENSURE_RETRY_MS, ENSURE_TIMEOUT_MS } from "./activity-deriver.ts";
import type { Cockpit11 } from "./contracts-11.ts";
import { createFactStore, PARTIAL_FACT_ETAT } from "./fact-store.ts";
import type { OcGlobalEvent, OcSession } from "./opencode.ts";
import { AFFICHAGE_INTERVAL_MS, AFFICHAGE_RATTRAPE_ETAT, AFFICHAGE_ROOTS_MAX, registerActivityRoutes } from "./routes-activity.ts";
import type { SessionTracker } from "./sessions.ts";
import { factDataProblem } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityResponse, FactsResponse } from "./shared/activity-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { createId, readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

/** Racine des captures p1, p6 et p7 (expérience « ocgraph », opencode 1.18.30). */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Demande de p1, envoyée par le proxy du cockpit. */
const P1_MESSAGE = { id: "msg_09e702c4e001phPA6LcfC9t4WK", created: 1789364546638 };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Rejoue une capture sur le flux du faux : le processeur réel du cockpit la reçoit comme d'opencode. */
function replay(h: CockpitHarness, name: string): void {
  for (const { wire } of readCapture(name)) h.fake.emitRaw(wire);
}

interface FactRow {
  session_id: string;
  kind: string;
  ref: string | null;
  data: string;
}

const factRows = (h: CockpitHarness) => h.db.prepare("SELECT session_id, kind, ref, data FROM activity_facts ORDER BY at, id").all() as unknown as FactRow[];

const delegationState = (h: CockpitHarness, callSuffix: string) =>
  (h.db.prepare("SELECT state FROM delegations WHERE call_id LIKE ?").get(`%${callSuffix}`) as { state: string } | undefined)?.state;

/** Forme lisible d'un fait (comme activity-facts.test.ts) : alias de session, nature, état, champs non nuls hors identifiants. */
function compact(facts: ReadonlyArray<Pick<ActivityFact, "sessionId" | "kind" | "data">>): string[] {
  const aliases = new Map<string, string>([[ROOT, "R"]]);
  const alias = (id: unknown) => {
    const key = String(id);
    if (!aliases.has(key)) aliases.set(key, `E${aliases.size}`);
    return aliases.get(key);
  };
  const detail = new Set(["outil", "appel", "appel-fini", "redige"]);
  const out: string[] = [];
  for (const fact of facts) {
    const who = alias(fact.sessionId);
    if (fact.kind === "statut" && detail.has(String(fact.data.etat))) continue;
    const words = [who, fact.kind];
    for (const [key, value] of Object.entries(fact.data)) {
      if (value === null || ["messageId", "callId", "fichier", "dossier"].includes(key)) continue;
      if (key === "etat" || key === "origine" || key === "reponse") words.push(String(value));
      else words.push(`${key}=${key === "enfant" || key === "parent" ? alias(value) : String(value)}`);
    }
    out.push(words.join(" "));
  }
  return out;
}

/** Textes des captures (consignes, sorties, titres, entrées d'outil) : aucun ne doit se retrouver dans les tables dérivées. */
function captureTexts(name: string): string[] {
  const texts = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (value.length >= 20 && /\s/.test(value)) texts.add(value.slice(0, 20));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) Object.values(value).forEach(walk);
  };
  for (const { wire } of readCapture(name)) walk(wire.payload);
  return [...texts];
}

function dumpDerived(h: CockpitHarness): string {
  const all = (sql: string) => JSON.stringify(h.db.prepare(sql).all());
  return [all("SELECT * FROM activity_facts"), all("SELECT * FROM delegations"), all("SELECT * FROM permission_waits")].join("\n");
}

describe("dérivation « facts » sur le faux opencode, processeur réel", () => {
  it("p1 : faits persistés dans l'ordre, un activite.fait par fait, délégations et attente écrites par le port, aucun texte", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    // Ligne écrite par le proxy AVANT le relais de la demande (enforceTurn) : le message est « Vous » (cas 1).
    h.ledger.recordChatTurn({ session_id: ROOT, created_at: P1_MESSAGE.created - 40, kind: "message", agent: "orchestrateur", command: null, tier: null, model: null, variant: null, runs: [] });
    replay(h, "p1-delegation-parallele.jsonl");
    await until(() => delegationState(h, "91b009") === "terminee" && factRows(h).some((r) => r.session_id === ROOT && r.data === '{"etat":"repos"}'), 10_000);

    const res = await h.call("GET", `/api/conversations/${ROOT}/facts?since=0`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const { facts, partial } = res.json<FactsResponse>();
    assert.equal(partial, false);
    assert.deepEqual(compact(facts), [
      "R statut creee role=conversation instance=principale",
      "R origine demande cas=1",
      "R statut occupee",
      "R consigne prepare",
      "E1 statut creee role=delegation parent=R agent=analyste-journaux instance=principale",
      "R consigne envoyee enfant=E1 agent=analyste-journaux source=ia reprise=false",
      "E1 origine consigne cas=3",
      "E1 statut occupee",
      "R consigne prepare",
      "R attente permission=task agent=analyste-changements",
      "R reponse once",
      "E2 statut creee role=delegation parent=R agent=analyste-changements instance=principale",
      "R consigne envoyee enfant=E2 agent=analyste-changements source=ia reprise=false",
      "E2 origine consigne cas=3",
      "E2 statut occupee",
      "E1 statut repos",
      "R resultat rendu enfant=E1",
      "E2 statut repos",
      "R resultat rendu enfant=E2",
      "R statut repos",
    ]);
    for (const fact of facts) assert.equal(factDataProblem(fact.data), null, JSON.stringify(fact));
    const published = h.cockpitEvents().filter((e) => e.type === "activite.fait").map((e) => (e.data as ActivityFact).id);
    assert.deepEqual(published, facts.map((f) => f.id));

    // Aucun texte des captures (consigne, sortie, titre, entrée d'outil) dans les faits, les délégations ni les attentes.
    const dump = dumpDerived(h);
    const texts = captureTexts("p1-delegation-parallele.jsonl");
    assert.ok(texts.length > 10, "textes relevés dans la capture");
    for (const text of texts) assert.ok(!dump.includes(text), `texte recopié : ${text}`);

    const activity = await h.call("GET", `/api/conversations/${ROOT}/activity`, { headers: h.headers.authed });
    assert.equal(activity.status, 200, activity.body);
    const body = activity.json<ActivityResponse>();
    const children = new Map(facts.filter((f) => f.kind === "statut" && f.data.etat === "creee" && f.sessionId !== ROOT).map((f, i) => [f.sessionId, `E${i + 1}`]));
    assert.deepEqual(
      body.delegations.map((d) => [d.callId.slice(-6), d.agent, children.get(d.childSessionId ?? ""), d.source, d.sansConfirmation, d.state, d.permissionId]),
      [
        ["b65537", "analyste-journaux", "E1", "ia", false, "terminee", null],
        ["91b009", "analyste-changements", "E2", "ia", false, "terminee", "per_09e7042aa001xfPstev3QOCjVX"],
      ],
    );
    assert.ok(body.delegations.every((d) => d.rootId === ROOT && d.parentSessionId === ROOT && d.startedAt !== null && d.endedAt !== null));
    assert.deepEqual(
      body.waits.map((w) => [w.permissionId, w.sessionId, w.permission, w.target, w.reply, w.repliedBy, w.repliedAt !== null]),
      [["per_09e7042aa001xfPstev3QOCjVX", ROOT, "task", "analyste-changements", "once", null, true]],
    );
    assert.deepEqual([body.runs, body.decisions, body.requests], [[], [], []]);
    assert.ok(body.usageSpans.length > 0 && body.usageSpans.every((span) => span.sessionId === ROOT || children.has(span.sessionId)));
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("p6 puis p7 : délégation interrompue « arretee », seconde « jamais-demarree » ; la demande reste en attente, « once » tardif enregistré ; état final jamais régressé", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    h.sessions.upsert({ id: ROOT, title: "ocgraph", directory: "/workspace", projectID: "global", time: { created: 1, updated: 1 } } as OcSession);
    replay(h, "p6-arret-global.jsonl");
    await until(() => delegationState(h, "e18551") === "jamais-demarree" && delegationState(h, "81e60e") === "arretee", 10_000);
    const waitOf = () => h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id LIKE '%lS5EU2'").get() as { reply: string | null; replied_by: string | null };
    // Partie `task` interrompue : la demande reste posée dans opencode (p7 le montre), elle n'est pas dite expirée.
    assert.deepEqual({ ...waitOf() }, { reply: null, replied_by: null });

    replay(h, "p7-autorisation-orpheline.jsonl");
    await until(() => waitOf().reply === "once", 10_000);
    assert.equal(delegationState(h, "e18551"), "jamais-demarree");
    assert.equal(delegationState(h, "81e60e"), "arretee");
    const second = h.db.prepare("SELECT permission_id FROM delegations WHERE call_id LIKE '%e18551'").get() as { permission_id: string };
    assert.match(second.permission_id, /lS5EU2$/);
    // Sous-agent détaché de p7 : ses faits sont enregistrés, rattachés à la racine.
    await until(() => factRows(h).some((r) => r.kind === "statut" && r.session_id.endsWith("NDOlwk") && r.data === '{"etat":"occupee"}'), 10_000);
    const dump = dumpDerived(h);
    for (const text of [...captureTexts("p6-arret-global.jsonl"), ...captureTexts("p7-autorisation-orpheline.jsonl")]) assert.ok(!dump.includes(text), text);
  });

  it("libération d'instance (M14) : demandes en attente de ce dossier « expiree », délégation qui attendait « expiree », fait reponse ; global.disposed : toutes", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    const here = await h.deps.client.request<OcSession>("POST", "/session", { body: { title: "Libération" } });
    const elsewhere = await h.deps.client.request<OcSession>("POST", "/session", { directory: "/workspace/autre", body: { title: "Autre dossier" } });
    await until(() => h.sessions.get(here.id) && h.sessions.get(elsewhere.id));
    const ask = (session: OcSession, id: string, callID: string) =>
      h.fake.emit(
        {
          type: "permission.asked",
          properties: { id, sessionID: session.id, permission: "task", patterns: ["explore"], metadata: { subagent_type: "explore" }, always: ["*"], tool: { messageID: "msg_demande1", callID } },
        },
        session.directory,
      );
    ask(here, "per_ici", "call_ici");
    ask(elsewhere, "per_ailleurs", "call_ailleurs");
    const reply = (id: string) => (h.db.prepare("SELECT reply FROM permission_waits WHERE permission_id = ?").get(id) as { reply: string | null } | undefined)?.reply;
    await until(() => reply("per_ici") === null && reply("per_ailleurs") === null && delegationState(h, "call_ailleurs") === "attente-accord");

    h.fake.emitInstanceDisposed(here.directory);
    await until(() => reply("per_ici") === "expiree");
    assert.equal(delegationState(h, "call_ici"), "expiree");
    assert.equal(reply("per_ailleurs"), null, "autre dossier : demande toujours posée");
    assert.equal(delegationState(h, "call_ailleurs"), "attente-accord");
    const expired = factRows(h).filter((r) => r.kind === "reponse");
    assert.deepEqual(expired.map((r) => [r.session_id, r.ref, r.data]), [[here.id, "per_ici", '{"reponse":"expiree"}']]);

    h.fake.emitGlobalDisposed();
    await until(() => reply("per_ailleurs") === "expiree");
    assert.equal(delegationState(h, "call_ailleurs"), "expiree");
    // Une seconde libération ne réécrit rien.
    h.fake.emitGlobalDisposed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(factRows(h).filter((r) => r.kind === "reponse").length, 2);
  });
});

/** Espion réseau : toute requête du client opencode ou tout fetch pendant `inside` est relevé. */
function spyNetwork(t: TestContext, h: CockpitHarness) {
  const client = h.deps.client;
  const state = { inside: false, during: [] as string[], calls: [] as string[] };
  const raw = client.raw.bind(client);
  client.raw = ((method: string, url: URL, init?: Parameters<typeof raw>[2]) => {
    state.calls.push(`${method} ${url.pathname}`);
    if (state.inside) state.during.push(`${method} ${url.pathname}`);
    return raw(method, url, init);
  }) as typeof client.raw;
  const fetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (state.inside) state.during.push("fetch");
    return fetch(...args);
  }) as typeof fetch;
  t.after(() => {
    Reflect.deleteProperty(client, "raw");
    globalThis.fetch = fetch;
  });
  return state;
}

const global = (type: string, properties: Record<string, unknown>, directory = "/workspace"): OcGlobalEvent => ({ directory, payload: { id: createId("evt"), type, properties } });

describe("dérivation « facts » : aucune attente réseau dans onEvent, session inconnue", () => {
  it("p1 appelé directement : aucun appel réseau pendant onEvent ni après (toutes les sessions viennent du flux) ; faits écrits", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    const derivation = activityDerivation(h.cockpit.c11);
    const spy = spyNetwork(t, h);
    for (const { wire } of readCapture("p1-delegation-parallele.jsonl")) {
      if (!("payload" in wire) || wire.payload.type === "sync") continue;
      spy.inside = true;
      try {
        derivation.onEvent(wire as OcGlobalEvent);
      } finally {
        spy.inside = false;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(spy.during, []);
    assert.deepEqual(spy.calls.filter((call) => call.includes("/session/")), []);
    assert.ok(factRows(h).length > 20);
  });

  it("session inconnue : événements gardés, sessions.ensure hors de l'appel (microtâche), puis dérivés dans l'ordre", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    const session = await h.deps.client.request<OcSession>("POST", "/session", { body: { title: "Inconnue du cockpit" } });
    await until(() => h.sessions.get(session.id));
    // Oubliée par le cockpit (par exemple créée pendant une coupure du flux) ; nouvelle dérivation, sans mémoire du flux.
    h.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    const derivation = activityDerivation(h.cockpit.c11);
    const spy = spyNetwork(t, h);
    // Faits d'état de cette session (la dérivation du module, branchée au processeur, a déjà écrit sa création).
    const states = () => factRows(h).filter((r) => r.session_id === session.id && r.kind === "statut" && !r.data.includes("creee"));
    spy.inside = true;
    try {
      derivation.onEvent(global("session.status", { sessionID: session.id, status: { type: "busy" } }, session.directory));
      derivation.onEvent(global("todo.updated", { sessionID: session.id, todos: [{ status: "completed" }, { status: "pending" }] }, session.directory));
    } finally {
      spy.inside = false;
    }
    assert.deepEqual(spy.during, [], "aucune requête pendant onEvent");
    assert.equal(states().length, 0, "rien d'écrit avant la recherche");
    await until(() => spy.calls.includes(`GET /session/${session.id}`));
    await until(() => states().length === 2);
    assert.deepEqual(
      states().map((r) => r.data),
      ['{"etat":"occupee"}', '{"etat":"taches","faites":1,"total":2}'],
    );
    assert.ok(h.sessions.get(session.id), "session enregistrée par sessions.ensure");
  });

  it("recherche bornée (5 s, ici 30 ms) : au-delà, événements abandonnés et journalisés ; pas de nouvelle recherche pendant 30 s", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    assert.equal(ENSURE_TIMEOUT_MS, 5_000);
    let ensures = 0;
    const warnings: string[] = [];
    const sessions = { get: (id: string) => h.sessions.get(id), ensure: () => (ensures++, new Promise(() => undefined)) } as unknown as SessionTracker;
    const log = { ...h.deps.log, warn: (message: string) => void warnings.push(message) };
    const c11: Cockpit11 = { ...h.cockpit.c11, sessions, log };
    let clock = 1_000_000;
    const derivation = activityDerivation(c11, { ensureTimeoutMs: 30, now: () => clock });
    const unknown = "ses_inconnue";
    derivation.onEvent(global("session.status", { sessionID: unknown, status: { type: "busy" } }));
    derivation.onEvent(global("session.status", { sessionID: unknown, status: { type: "idle" } }));
    await until(() => warnings.some((w) => w.includes("session inconnue")), 2_000);
    assert.equal(ensures, 1, "une seule recherche pour les événements gardés");
    assert.equal(factRows(h).length, 0);

    clock += 1_000;
    derivation.onEvent(global("session.status", { sessionID: unknown, status: { type: "busy" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ensures, 1, "pas de nouvelle recherche avant 30 s");

    clock += ENSURE_RETRY_MS;
    derivation.onEvent(global("session.status", { sessionID: unknown, status: { type: "busy" } }));
    await until(() => ensures === 2, 2_000);
  });
});

describe("dérivation « facts » : origine « demande » et événements manqués", () => {
  const RACINE = "ses_racine_directe";

  async function direct(t: TestContext) {
    const h = await startCockpit(t, { modules: ["facts"] });
    h.sessions.upsert({ id: RACINE, title: "Racine", directory: "/workspace", time: { created: 1, updated: 1 } } as OcSession);
    const derivation = activityDerivation(h.cockpit.c11);
    const send = (type: string, properties: Record<string, unknown>) => derivation.onEvent(global(type, { sessionID: RACINE, ...properties }));
    return { h, send };
  }

  it("une ligne chat_turns (message ou raccourci, jamais résumé) ne fait « Vous » qu'un seul message ; le suivant reste d'origine non identifiée", async (t) => {
    const { h, send } = await direct(t);
    const T = 1_800_000_000_000;
    const turn = (created_at: number, kind: "message" | "resume") =>
      h.ledger.recordChatTurn({ session_id: RACINE, created_at, kind, agent: "build", command: null, tier: null, model: null, variant: null, runs: [] });
    turn(T - 100, "message");
    turn(T + 500, "resume");
    const user = (id: string, created: number) => {
      send("message.updated", { info: { id, sessionID: RACINE, role: "user", time: { created } } });
      send("message.part.updated", { part: { id: `prt_${id}`, type: "text", text: "Consigne libre de la demande", messageID: id, sessionID: RACINE } });
      send("message.updated", { info: { id: `${id}_reponse`, sessionID: RACINE, role: "assistant", parentID: id, time: { created: created + 10 } } });
    };
    user("msg_un", T);
    user("msg_deux", T + 1_000);
    const origins = factRows(h)
      .filter((r) => r.kind === "origine")
      .map((r) => [r.ref, JSON.parse(r.data).origine, JSON.parse(r.data).cas]);
    assert.deepEqual(origins, [
      ["msg_un", "demande", 1],
      ["msg_deux", "origine-inconnue", 7],
    ]);
  });

  it("réponse ou consigne manquée (coupure du flux) : l'enfant lancé prouve l'accord, les étapes observables sont posées dans l'ordre", async (t) => {
    const { h, send } = await direct(t);
    const task = (callID: string, status: string, enfant?: string) =>
      send("message.part.updated", {
        part: {
          id: `prt_${callID}_${status}`,
          type: "tool",
          tool: "task",
          callID,
          messageID: "msg_parent",
          sessionID: RACINE,
          state: { status, input: { subagent_type: "explore" }, ...(enfant ? { metadata: { sessionId: enfant } } : {}) },
        },
      });
    const ask = (id: string, callID: string) =>
      send("permission.asked", { id, permission: "task", metadata: { subagent_type: "explore" }, tool: { messageID: "msg_parent", callID } });
    const row = (callId: string) =>
      h.db.prepare("SELECT state, permission_id, child_session_id, started_at FROM delegations WHERE call_id = ?").get(callId) as {
        state: string;
        permission_id: string | null;
        child_session_id: string | null;
        started_at: number | null;
      };

    // Réponse « once » manquée : demande posée, enfant lancé, puis rendu.
    ask("per_t1", "call_t1");
    assert.equal(row("call_t1").state, "attente-accord");
    task("call_t1", "running", "ses_enfant1");
    assert.equal(row("call_t1").state, "travaille");
    task("call_t1", "completed", "ses_enfant1");
    assert.deepEqual({ ...row("call_t1"), started_at: row("call_t1").started_at !== null }, { state: "terminee", permission_id: "per_t1", child_session_id: "ses_enfant1", started_at: true });

    // Consigne envoyée manquée : préparée, puis rendue par son enfant.
    task("call_t2", "pending");
    assert.equal(row("call_t2").state, "prepare");
    task("call_t2", "completed", "ses_enfant2");
    assert.deepEqual([row("call_t2").state, row("call_t2").child_session_id], ["terminee", "ses_enfant2"]);

    // Réponse et consigne manquées : demande posée, puis rendu.
    ask("per_t3", "call_t3");
    task("call_t3", "completed", "ses_enfant3");
    assert.equal(row("call_t3").state, "terminee");

    // Sans enfant, une fin n'est jamais un travail : « jamais-demarree », la demande reste posée.
    ask("per_t4", "call_t4");
    task("call_t4", "error");
    assert.equal(row("call_t4").state, "jamais-demarree");
    assert.equal((h.db.prepare("SELECT reply FROM permission_waits WHERE permission_id = 'per_t4'").get() as { reply: string | null }).reply, null);
  });
});

describe("routes d'activité", () => {
  async function seeded(t: TestContext) {
    const h = await startCockpit(t, { modules: ["facts"] });
    const CHILD = "ses_enfant";
    const OTHER = "ses_autre";
    const at = (created: number) => ({ created, updated: created });
    h.sessions.upsert({ id: ROOT, title: "Racine", directory: "/workspace", time: at(1) } as OcSession);
    h.sessions.upsert({ id: CHILD, parentID: ROOT, title: "Enfant", directory: "/workspace", time: at(2) } as OcSession);
    h.sessions.upsert({ id: OTHER, title: "Autre", directory: "/workspace", time: at(3) } as OcSession);
    // Écrivain unique, horloge fixe.
    const writer = createFactStore({ db: h.db, hub: h.hub, now: () => 5_000 }).work;
    writer.markDelegation({ rootId: ROOT, parentSessionId: ROOT, callId: "call_1", agent: "explore", childSessionId: CHILD }, "travaille", null);
    writer.markDelegation({ rootId: CHILD, parentSessionId: CHILD, callId: "call_2", agent: "general", source: "raccourci", sansConfirmation: true, command: "revue" }, "prepare", null);
    writer.markDelegation({ rootId: OTHER, parentSessionId: OTHER, callId: "call_3", agent: "explore" }, "prepare", null);
    writer.markWait({ permissionId: "per_1", sessionId: ROOT, rootId: ROOT, permission: "bash" }, "attente", null);
    writer.markWait({ permissionId: "per_2", sessionId: CHILD, rootId: ROOT, permission: "task", target: "explore" }, "once", "vous");
    writer.markWait({ permissionId: "per_3", sessionId: OTHER, rootId: OTHER, permission: "edit" }, "attente", null);
    // Tables de l'itération 2 (L10a) : lignes de test posées directement.
    const decision = h.db.prepare(
      `INSERT INTO autonomy_decisions (request_id, root_id, session_id, permission_id, permission, resume, choix, regle, rules_version, verdict, par, raison,
         ia_model, ia_cost, ia_ms, relais, asked_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, 'autonome', 'B01', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    decision.run("req_1", ROOT, CHILD, "per_2", "bash", `Commande ghp_${"a".repeat(36)} puis ${"x".repeat(200)}`, "attente", "ia-controle", "password=motdepasse-secret", "github-copilot/gpt-5-mini", 0.002, 800, "ok", 10, 11);
    decision.run(null, OTHER, OTHER, null, "edit", "autre", "auto", "regles", "", null, null, null, null, 12, null);
    h.db
      .prepare(
        `INSERT INTO autonomy_requests (id, root_id, prompt_message_id, choix, plafonds, started_at, ended_at, spent, auto, attentes, refus, controles, fichiers, delegations, fin)
         VALUES ('req_1', ?, 'msg_1', 'autonome', '{"plafondUsd":2,"actionsMax":"beaucoup"}', 20, 30, 0.5, 3, 1, 0, 1, 2, 1, 'terminee')`,
      )
      .run(ROOT);
    const usage = h.db.prepare("INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)");
    usage.run("msg_a", ROOT, ROOT, 40, 41, 0.01);
    usage.run("msg_b", CHILD, ROOT, 42, null, 0);
    usage.run("msg_c", OTHER, OTHER, 43, 44, 1);
    return { h, CHILD, OTHER };
  }

  it("GET …/activity : forme exacte, lignes de la conversation (racine et sessions rattachées) seulement, résumé et raison masqués", async (t) => {
    const { h, CHILD } = await seeded(t);
    const res = await h.call("GET", `/api/conversations/${ROOT}/activity`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const caps = h.settings.get().budget.autonomie;
    const body = res.json<ActivityResponse>();
    const ids = (h.db.prepare("SELECT id, call_id FROM delegations ORDER BY id").all() as Array<{ id: number; call_id: string }>).map((r) => r.id);
    assert.deepEqual(body, {
      runs: [],
      delegations: [
        {
          id: ids[0],
          rootId: ROOT,
          parentSessionId: ROOT,
          childSessionId: CHILD,
          callId: "call_1",
          agent: "explore",
          command: null,
          source: "ia",
          sansConfirmation: false,
          state: "travaille",
          permissionId: null,
          createdAt: 5_000,
          startedAt: 5_000,
          endedAt: null,
        },
        {
          id: ids[1],
          rootId: CHILD,
          parentSessionId: CHILD,
          childSessionId: null,
          callId: "call_2",
          agent: "general",
          command: "revue",
          source: "raccourci",
          sansConfirmation: true,
          state: "prepare",
          permissionId: null,
          createdAt: 5_000,
          startedAt: null,
          endedAt: null,
        },
      ],
      waits: [
        { permissionId: "per_1", sessionId: ROOT, rootId: ROOT, permission: "bash", target: null, askedAt: 5_000, repliedAt: null, reply: null, repliedBy: null },
        { permissionId: "per_2", sessionId: CHILD, rootId: ROOT, permission: "task", target: "explore", askedAt: 5_000, repliedAt: 5_000, reply: "once", repliedBy: "vous" },
      ],
      decisions: [
        {
          id: 1,
          requestId: "req_1",
          sessionId: CHILD,
          permissionId: "per_2",
          permission: "bash",
          resume: `Commande gh_**** puis ${"x".repeat(120 - "Commande gh_**** puis ".length)}`,
          choix: "autonome",
          regle: "B01",
          rulesVersion: 1,
          verdict: "attente",
          par: "ia-controle",
          raison: "password=****",
          iaModel: "github-copilot/gpt-5-mini",
          iaCost: 0.002,
          iaMs: 800,
          relais: "ok",
          askedAt: 10,
          decidedAt: 11,
        },
      ],
      requests: [
        {
          id: "req_1",
          rootId: ROOT,
          choix: "autonome",
          plafonds: {
            plafondUsd: 2,
            actionsMax: caps.actionsMax,
            delegationsMax: caps.delegationsMax,
            dureeMinutes: caps.dureeMinutes,
            fichiersMax: caps.fichiersMax,
            controlesIaMax: caps.controlesIaMax,
          },
          startedAt: 20,
          endedAt: 30,
          spent: 0.5,
          auto: 3,
          attentes: 1,
          refus: 0,
          controles: 1,
          fichiers: 2,
          delegations: 1,
          fin: "terminee",
        },
      ],
      usageSpans: [
        { sessionId: ROOT, messageId: "msg_a", start: 40, end: 41, cost: 0.01 },
        { sessionId: CHILD, messageId: "msg_b", start: 42, end: null, cost: 0 },
      ],
    });
    assert.equal((await h.call("GET", `/api/conversations/${ROOT}/activity`)).status, 401, "sans cookie de session");
  });

  it("GET …/facts?since= : faits de la conversation depuis l'instant, partial ; 400 sur since absent ou invalide", async (t) => {
    const { h, CHILD } = await seeded(t);
    h.cockpit.c11.ports.facts.append([
      { rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 100 },
      { rootId: ROOT, sessionId: CHILD, kind: "statut", ref: null, data: { etat: "repos" }, at: 200 },
    ]);
    const get = (query: string) => h.call("GET", `/api/conversations/${ROOT}/facts${query}`, { headers: h.headers.authed });
    const all = await get("?since=0");
    assert.equal(all.status, 200, all.body);
    assert.deepEqual(
      all.json<FactsResponse>().facts.map((f) => [f.sessionId, f.data.etat, f.at]),
      [
        [ROOT, "occupee", 100],
        [CHILD, "repos", 200],
      ],
    );
    assert.deepEqual((await get("?since=150")).json<FactsResponse>().facts.map((f) => f.at), [200]);
    assert.equal((await get("?since=150")).json<FactsResponse>().partial, false);
    for (const query of ["", "?since=", "?since=-1", "?since=1.5", "?since=abc", "?since=99999999999999999", "?since=1e3"]) {
      const res = await get(query);
      assert.equal(res.status, 400, `${query} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "invalid");
    }
  });

  it("400 : identifiant de conversation invalide sur les trois routes, rien n'est écrit", async (t) => {
    const { h } = await seeded(t);
    const before = factRows(h).length;
    for (const rootId of ["ses.1", "ses%20racine", "ses%2F..%2Fautre", "s".repeat(129)]) {
      for (const [method, suffix, headers] of [
        ["GET", "activity", h.headers.authed],
        ["GET", "facts?since=0", h.headers.authed],
        ["POST", "facts/affichage", h.headers.mutating],
      ] as const) {
        const res = await h.call(method, `/api/conversations/${rootId}/${suffix}`, { headers, ...(method === "POST" ? { body: {} } : {}) });
        assert.equal(res.status, 400, `${method} ${rootId} ${suffix} : ${res.body}`);
        assert.deepEqual(res.json(), { error: "invalid", message: "Identifiant de conversation invalide." }, `${method} ${rootId} ${suffix}`);
      }
    }
    assert.equal(factRows(h).length, before);
  });

  it("POST …/facts/affichage : CSRF, conversation connue, aucun contenu, un fait « Affichage rattrapé » par 2 s", async (t) => {
    const { h, CHILD } = await seeded(t);
    const post = (rootId: string, body: unknown = {}, headers = h.headers.mutating) => h.call("POST", `/api/conversations/${rootId}/facts/affichage`, { headers, body });
    const affichages = () => factRows(h).filter((r) => r.kind === "affichage");

    assert.equal((await post(ROOT, {}, h.headers.authed)).status, 403, "sans en-tête anti-CSRF");
    assert.equal((await post("ses_inconnue")).status, 404);
    assert.equal((await post(CHILD)).status, 404, "session enfant : pas une conversation");
    h.sessions.upsert({ id: "ses_classement", title: "[cockpit] classement", directory: "/workspace", time: { created: 1, updated: 1 } } as OcSession);
    assert.equal((await post("ses_classement")).status, 404, "session cachée du classement");
    for (const body of [{ texte: "Affichage rattrapé" }, "texte brut", [], { etat: "rattrape" }, JSON.stringify({ a: "x".repeat(100) })]) {
      const res = await post(ROOT, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} : ${res.body}`);
    }
    assert.deepEqual(affichages(), []);

    const first = await post(ROOT);
    assert.equal(first.status, 200, first.body);
    assert.deepEqual(first.json(), { enregistre: true });
    assert.deepEqual(
      affichages().map((r) => [r.session_id, r.ref, r.data]),
      [[ROOT, null, JSON.stringify({ etat: AFFICHAGE_RATTRAPE_ETAT })]],
    );
    assert.ok(h.cockpitEvents().some((e) => e.type === "activite.fait" && (e.data as ActivityFact).kind === "affichage"));
    const empty = await h.call("POST", `/api/conversations/${ROOT}/facts/affichage`, { headers: h.headers.mutating });
    assert.deepEqual([empty.status, empty.json()], [200, { enregistre: false }], "corps vide accepté, borne de 2 s");
    assert.equal(affichages().length, 1);
  });

  it("borne de 2 s par conversation (horloge du test), « Déroulé partiel » respecté, mémoire bornée", async (t) => {
    const { h, OTHER } = await seeded(t);
    let clock = 10_000_000;
    const app = new Hono();
    registerActivityRoutes(app, h.cockpit.c11, { now: () => clock });
    const post = async (rootId: string) => {
      const res = await app.request(`/api/conversations/${rootId}/facts/affichage`, { method: "POST", body: "{}" });
      assert.equal(res.status, 200);
      return ((await res.json()) as { enregistre: boolean }).enregistre;
    };
    assert.equal(await post(ROOT), true);
    clock += AFFICHAGE_INTERVAL_MS - 1;
    assert.equal(await post(ROOT), false);
    assert.equal(await post(OTHER), true, "borne par conversation");
    clock += 1;
    assert.equal(await post(ROOT), true);
    assert.equal(factRows(h).filter((r) => r.kind === "affichage" && r.session_id === ROOT).length, 2);

    // Conversation close par « Déroulé partiel » : rien n'est écrit, et la réponse le dit.
    h.db.prepare("INSERT INTO sessions (id, root_id, title, created_at, updated_at) VALUES ('ses_close', 'ses_close', '', 1, 1)").run();
    h.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19999)
      INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) SELECT 'ses_close', 'ses_close', 'statut', NULL, '{"etat":"occupee"}', i FROM n`);
    h.db.prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES ('ses_close', 'ses_close', 'affichage', NULL, ?, 20000)").run(JSON.stringify({ etat: PARTIAL_FACT_ETAT }));
    assert.equal(await post("ses_close"), false);
    assert.equal(factRows(h).filter((r) => r.session_id === "ses_close").length, 20_000);

    // Mémoire bornée : au-delà de AFFICHAGE_ROOTS_MAX conversations, la plus ancienne est oubliée.
    const insert = h.db.prepare("INSERT INTO sessions (id, root_id, title, created_at, updated_at) VALUES (?, ?, '', 1, 1)");
    for (let i = 0; i < AFFICHAGE_ROOTS_MAX; i++) insert.run(`ses_m${i}`, `ses_m${i}`);
    clock += AFFICHAGE_INTERVAL_MS;
    assert.equal(await post(ROOT), true);
    for (let i = 0; i < AFFICHAGE_ROOTS_MAX; i++) assert.equal(await post(`ses_m${i}`), true);
    assert.equal(await post(ROOT), true, "entrée la plus ancienne oubliée");
  });

  it("suppression d'une conversation (DELETE /api/archive/:id, purge L2b) : faits supprimés, délégations et attentes gardées", async (t) => {
    const { h } = await seeded(t);
    h.cockpit.c11.ports.facts.append([{ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 100 }]);
    assert.equal((await h.call("POST", `/api/conversations/${ROOT}/facts/affichage`, { headers: h.headers.mutating, body: {} })).status, 200);
    h.db.prepare("INSERT INTO conversations (session_id, created_at, updated_at) VALUES (?, 1, 1)").run(ROOT);
    const removed = await h.call("DELETE", `/api/archive/${ROOT}`, { headers: h.headers.mutating });
    assert.deepEqual([removed.status, removed.json()], [200, { deleted: true }]);
    const facts = await h.call("GET", `/api/conversations/${ROOT}/facts?since=0`, { headers: h.headers.authed });
    assert.deepEqual(facts.json(), { facts: [], partial: false });
    const activity = (await h.call("GET", `/api/conversations/${ROOT}/activity`, { headers: h.headers.authed })).json<ActivityResponse>();
    assert.deepEqual([activity.delegations.length, activity.waits.length], [2, 2]);
  });

  it("sans le module facts : routes absentes (404), aucune dérivation", async (t) => {
    const h = await startCockpit(t);
    assert.equal((await h.call("GET", `/api/conversations/${ROOT}/activity`, { headers: h.headers.authed })).status, 404);
    assert.equal((await h.call("GET", `/api/conversations/${ROOT}/facts?since=0`, { headers: h.headers.authed })).status, 404);
    assert.equal((await h.call("POST", `/api/conversations/${ROOT}/facts/affichage`, { headers: h.headers.mutating, body: {} })).status, 404);
    assert.deepEqual(h.cockpit.wiring.derivations, []);
  });
});
