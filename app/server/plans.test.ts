// Tests L6b, Plan d'abord (spécification §4.9, §3.9, §6 l.1044, D12, D13, D-03, D-04, M2 ; plan d'exécution, fiche L6b) sur le
// harnais du cockpit (modules floors, conversationAutonomy et plans déclarés ; activation et faits par surcharge de port) et le faux
// opencode : racine PLAN vérifiée et outils retirés sur la racine et le travail délégué (listes de M2), « plan » permanent, crochet
// d'envoi qui repose PLAN, exécution sur une nouvelle racine CONVERSATION avec brouillon, 428 et 409 avant toute création,
// COCKPIT_AUTONOMY=off, aucun fork, aucun redémarrage d'opencode (P6).
// Écarts provoqués par un client opencode qui altère les réponses (TamperingClient) : le faux reste fidèle à opencode 1.18.30.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ActivationInput, ActivationPort, ActivationVerdict, FactsPort } from "./contracts-11.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import { OpencodeClient } from "./opencode.ts";
import { createPlanService, lastPlanText } from "./plans.ts";
import { floorHash } from "./session-floor-service.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { formatUsd } from "./shared/assistant-rules.ts";
import { raisonIndisponible, TEXTES as AUTONOMIE } from "./shared/autonomy-choice-texts.ts";
import type { ConversationAutonomyView, PlanCreateResponse, PlanExecutionResponse } from "./shared/autonomy-types.ts";
import { brouillonExecution, budgetPlan, TEXTES } from "./shared/plan-texts.ts";
import { buildFloor } from "./shared/session-floors.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { promptAsync, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const CONVERSATION = buildFloor("CONVERSATION");
const PLAN = buildFloor("PLAN");
const PLAN_MARK = `plan:${floorHash("PLAN")}`;
const CONVERSATION_MARK = `conversation:${floorHash("CONVERSATION")}`;
/** Outils de modification et shell : aucun ne doit rester dans une conversation de plan (edit write apply_patch bash, §4.9). */
const WRITERS = ["apply_patch", "bash", "edit", "write"];

interface M2Fixture {
  model: { providerID: string; modelID: string };
  configPermission: Record<string, unknown>;
  cases: Array<{ name: string; tools: string[] }>;
}
const m2 = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/m2-tools.json", import.meta.url), "utf8")) as M2Fixture;
const m2Tools = (name: string): string[] => {
  const found = m2.cases.find((c) => c.name === name);
  assert.ok(found, name);
  return found.tools;
};

// --- Doublures ------------------------------------------------------------------------------------------------------------------

/** `forward` relaie la requête au faux ; `body` : corps envoyé (texte JSON). */
type Tamper = (method: string, pathname: string, forward: () => Promise<Response>, body: string | null) => Promise<Response>;

/** Client opencode qui peut intercepter une requête ou altérer sa réponse ; lu par le proxy, le plancher et les plans. */
class TamperingClient extends OpencodeClient {
  tamper: Tamper | null = null;

  override raw(method: string, url: URL, init: Parameters<OpencodeClient["raw"]>[2] = {}): Promise<Response> {
    const forward = () => super.raw(method, url, init);
    const body = typeof init.body === "string" ? init.body : null;
    return this.tamper ? this.tamper(method.toUpperCase(), url.pathname, forward, body) : forward();
  }
}

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Port activation scriptable : verdicts dans l'ordre des appels (le dernier se répète), appels relevés. */
class ScriptedActivation implements ActivationPort {
  readonly calls: ActivationInput[] = [];
  verdicts: ActivationVerdict[] = [{ ok: true }];

  async check(input: ActivationInput): Promise<ActivationVerdict> {
    this.calls.push(input);
    return this.verdicts[Math.min(this.calls.length - 1, this.verdicts.length - 1)] ?? { ok: true };
  }
}

function spyFacts(): FactsPort & { appended: ActivityFact[] } {
  const appended: ActivityFact[] = [];
  return {
    appended,
    append: (facts) => void appended.push(...facts),
    since: () => ({ facts: [], partial: false }),
    work: { markDelegation: () => false, markWait: () => false },
  };
}

// --- Aides ----------------------------------------------------------------------------------------------------------------------

interface Started {
  h: CockpitHarness;
  client: TamperingClient;
  facts: ReturnType<typeof spyFacts>;
  store: ConversationAutonomyStore;
}

/** Harnais avec les modules du paquet ; activation neutre (porte I1 fermée) sauf surcharge ; faits espionnés. */
async function start(t: TestContext, options: CockpitHarnessOptions = {}): Promise<Started> {
  let client: TamperingClient | null = null;
  const facts = spyFacts();
  const h = await startCockpit(t, {
    modules: ["floors", "conversationAutonomy", "plans"],
    ...options,
    ports: { facts, ...options.ports },
    deps: (base) => {
      client = new TamperingClient(base.env);
      return { client };
    },
  });
  assert.ok(client);
  return { h, client, facts, store: new ConversationAutonomyStore(h.db) };
}

const requests = (h: CockpitHarness, method: string, pathname: string) => h.fake.requests.filter((r) => r.method === method && r.pathname === pathname);
const creations = (h: CockpitHarness) => requests(h, "POST", "/session").length;
const forks = (h: CockpitHarness) => h.fake.requests.filter((r) => r.pathname.endsWith("/fork"));
const markIn = (h: CockpitHarness, sessionId: string) => h.sessions.get(sessionId)?.plancher ?? null;

const createPlan = (h: CockpitHarness, body: unknown = { directory: h.fake.directory }, headers: Record<string, string> = h.headers.mutating) =>
  h.call("POST", "/api/plans", { headers, body });

async function newPlan(h: CockpitHarness, body?: unknown): Promise<PlanCreateResponse> {
  const res = await createPlan(h, body);
  assert.equal(res.status, 200, res.body);
  return res.json<PlanCreateResponse>();
}

const execute = (h: CockpitHarness, planId: string, body: unknown, headers: Record<string, string> = h.headers.mutating) =>
  h.call("POST", `/api/plans/${planId}/execution`, { headers, body });

function send(h: CockpitHarness, sessionId: string, text = "Prépare un plan.") {
  return h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, { headers: h.headers.mutating, body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] } });
}

/** Réponse du plan, envoyée par le proxy (garde normale, crochets) et terminée. */
async function answer(h: CockpitHarness, planId: string, text: string): Promise<void> {
  h.fake.script(planId, { text });
  const res = await send(h, planId);
  assert.equal(res.status, 204, res.body);
  await within(h.fake.settled(planId), "réponse du plan terminée");
}

/** Conversation ordinaire créée par le proxy (plancher CONVERSATION), suivie par le cockpit. */
async function conversation(h: CockpitHarness): Promise<FakeSession> {
  const res = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Ordinaire" } });
  assert.equal(res.status, 200, res.body);
  const session = res.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

const autonomyView = async (h: CockpitHarness, rootId: string) => {
  const res = await h.call("GET", `/api/conversations/${rootId}/autonomie`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<ConversationAutonomyView>();
};

const choiceEvents = (h: CockpitHarness) => h.cockpitEvents().filter((e) => e.type === "autonomie.choix").map((e) => e.data);

/** Conversations supprimées dans opencode par le cockpit (DELETE /session/:id), dans l'ordre. */
const deletedIds = (h: CockpitHarness) =>
  h.fake.requests.filter((r) => r.method === "DELETE" && r.pathname.startsWith("/session/")).map((r) => r.pathname.split("/")[2] ?? "");

/** Base qui refuse une écriture de conversation_autonomy (erreur SQLite) : `when` porte sur NEW. */
function refuseWrites(h: CockpitHarness, name: string, when: string): void {
  for (const event of ["INSERT", "UPDATE"]) {
    h.db.exec(`CREATE TRIGGER ${name}_${event.toLowerCase()} BEFORE ${event} ON conversation_autonomy WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refus de test'); END`);
  }
}

// --- Création ---------------------------------------------------------------------------------------------------------------------

describe("Plan d'abord : POST /api/plans", () => {
  it("racine PLAN vérifiée, « plan » permanent, fait et événement ; outils retirés sur la racine et le travail délégué (M2) ; rien envoyé", async (t) => {
    const { h, facts, store } = await start(t);
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.module === "plans"),
      [
        { kind: "hook", key: "beforeBilledSend", module: "plans" },
        { kind: "routes", key: "plans", module: "plans" },
      ],
    );
    h.fake.globalConfig = { ...h.fake.globalConfig, permission: m2.configPermission };
    const res = await createPlan(h);
    assert.equal(res.status, 200, res.body);
    const created = res.json<PlanCreateResponse>();
    const planId = created.rootId;
    // Réponse limitée à l'identifiant, au titre, au dossier et aux heures : aucune règle transmise.
    assert.deepEqual(Object.keys(created.session).sort(), ["directory", "id", "time", "title"]);
    assert.equal(created.session.id, planId);
    assert.equal(created.session.directory, h.fake.directory);

    // Plancher PLAN écrit par le serveur seul, écho vérifié, marque enregistrée (§3.4).
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { permission: PLAN });
    assert.deepEqual(h.fake.session(planId)?.permission, PLAN);
    assert.equal(markIn(h, planId), PLAN_MARK);
    assert.equal(await h.cockpit.c11.ports.floors.verified(planId), true);

    // Choix « plan » permanent, conversation d'origine absente (nouvelle conversation).
    const stored = store.read(planId);
    assert.equal(stored?.choix, "plan");
    assert.equal(stored?.planSourceId, null);
    assert.equal(stored?.executionDePlanId, null);
    const view = await autonomyView(h, planId);
    assert.equal(view.choix, "plan");
    assert.deepEqual(
      view.disponibles.map((d) => [d.choix, d.disponible, d.raison]),
      [
        ["demander", false, "racine-de-plan"],
        ["modifications", false, "racine-de-plan"],
        ["plan", true, null],
        ["autonome", false, "racine-de-plan"],
      ],
    );
    assert.deepEqual(choiceEvents(h), [{ rootId: planId, choix: "plan", cause: "clic" }]);
    assert.deepEqual(
      facts.appended.map((f) => ({ rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: f.data })),
      [{ rootId: planId, sessionId: planId, kind: "choix", ref: null, data: { choix: "plan", cause: "clic" } }],
    );
    // Création seule : aucun message envoyé ni facturé.
    assert.equal(h.fake.messages(planId).length, 0);

    // Outils retirés sur la racine (F-e) : listes de la mesure M2, et aucun outil d'écriture pour une IA à apply_patch.
    assert.deepEqual(h.fake.toolsFor(planId, { modelID: m2.model.modelID, agent: "build" }), m2Tools("racine-edit-bash-refuses"));
    assert.deepEqual(h.fake.toolsFor(planId, { modelID: MODEL.modelID, agent: "build" }).filter((tool) => WRITERS.includes(tool)), []);

    // Travail délégué (F-f) : l'enfant hérite des refus ; message envoyé par le proxy, avec la garde normale.
    h.fake.script(planId, {
      tools: [{ tool: "task", input: { description: "Lecture", prompt: "Lis a.txt.", subagent_type: "general" }, child: { agent: "general", text: "Résumé." } }],
      followUp: { text: "1. Lire a.txt." },
    });
    const sent = await send(h, planId, "Délègue la lecture.");
    assert.equal(sent.status, 204, sent.body);
    await within(h.fake.settled(planId), "délégation terminée");
    const [child] = await h.deps.client.request<FakeSession[]>("GET", `/session/${planId}/children`);
    assert.ok(child);
    assert.deepEqual(h.fake.toolsFor(child.id, { modelID: m2.model.modelID }), m2Tools("enfant-general"));
    assert.deepEqual(h.fake.toolsFor(child.id, { modelID: MODEL.modelID }).filter((tool) => WRITERS.includes(tool)), []);
    // Plancher PLAN à jour : envoi relayé sans PATCH.
    assert.equal(requests(h, "PATCH", `/session/${planId}`).length, 0);
    assert.deepEqual(forks(h), []);
    h.assertNoGlobalRestart();
  });

  it("conversation d'origine (« Plan d'abord (nouvelle conversation) ») : plan_source_id ; inconnue, enfant, supprimée → 404 ; autre dossier → 400", async (t) => {
    const { h, store } = await start(t);
    const origin = await conversation(h);
    const plan = await newPlan(h, { directory: h.fake.directory, source: origin.id });
    assert.equal(store.read(plan.rootId)?.planSourceId, origin.id);
    assert.equal((await autonomyView(h, plan.rootId)).planSourceId, origin.id);
    // La conversation d'origine garde son choix.
    assert.equal(store.read(origin.id), null);

    const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: origin.id, title: "Enfant" } });
    await until(() => h.sessions.get(child.id));
    const deleted = await conversation(h);
    h.sessions.markDeleted(deleted.id);
    // Session interne du cockpit (classement) et conversation de la Salle OMO (P11) : jamais d'origine d'un plan.
    const classifier = await h.deps.client.request<FakeSession>("POST", "/session", { body: { title: "[cockpit] Classement" } });
    await until(() => h.sessions.get(classifier.id));
    const omo = await conversation(h);
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(omo.id);
    const before = creations(h);
    for (const source of ["ses_inconnue", child.id, deleted.id, classifier.id, omo.id]) {
      const res = await createPlan(h, { directory: h.fake.directory, source });
      assert.equal(res.status, 404, `${source} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "not-found", message: TEXTES.partout.erreurs.sourceInconnue });
    }
    const elsewhere = `${h.fake.directory}/autre`;
    const res = await createPlan(h, { directory: elsewhere, source: origin.id });
    assert.equal(res.status, 400, res.body);
    assert.deepEqual(res.json(), { error: "invalid", message: TEXTES.partout.erreurs.requete });
    assert.equal(creations(h), before, "aucune conversation créée");
  });

  it("refus avant toute création : corps invalide (400), trop long (413), dossier hors du workspace (403), anti-CSRF ; sans le module, aucune route", async (t) => {
    const { h, store } = await start(t);
    const before = creations(h);
    const bodies: unknown[] = [{}, { directory: "" }, { directory: 3 }, { directory: h.fake.directory, titre: "x" }, { directory: h.fake.directory, source: "../x" }, [], "texte"];
    for (const body of bodies) {
      const res = await createPlan(h, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "invalid", message: TEXTES.partout.erreurs.requete });
    }
    const unreadable = await h.call("POST", "/api/plans", { headers: { ...h.headers.mutating, "content-type": "application/json" }, body: "{pas du json" });
    assert.equal(unreadable.status, 400, unreadable.body);
    const long = await createPlan(h, { directory: h.fake.directory, bourrage: "x".repeat(5_000) });
    assert.equal(long.status, 413, long.body);
    assert.deepEqual(long.json(), { error: "invalid", message: TEXTES.partout.erreurs.tropLong });
    for (const directory of ["/etc", `${h.fake.directory}/../etc`]) {
      const res = await createPlan(h, { directory });
      assert.equal(res.status, 403, `${directory} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "forbidden-directory", message: TEXTES.partout.erreurs.dossier });
    }
    const noCsrf = await createPlan(h, { directory: h.fake.directory }, h.headers.authed);
    assert.equal(noCsrf.status, 403, noCsrf.body);
    assert.equal(noCsrf.json<{ error: string }>().error, "csrf");
    const anonymous = await h.call("POST", "/api/plans", { body: { directory: h.fake.directory } });
    assert.equal(anonymous.status, 401, anonymous.body);
    assert.equal(creations(h), before, "aucune conversation créée");
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM conversation_autonomy").get()?.n, 0);
    assert.equal(store.read("ses_x"), null);

    const bare = await startCockpit(t);
    const off = await bare.call("POST", "/api/plans", { headers: bare.headers.mutating, body: { directory: bare.fake.directory } });
    assert.equal(off.status, 404, off.body);
    assert.equal(bare.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session").length, 0);
  });

  it("garde-fou budgétaire : budget du mois atteint → 409 budget-guard sans rien créer ; confirmé → 200 ; garde coupé → 200", async (t) => {
    const { h, store } = await start(t);
    h.ledger.percentUsed = () => 104;
    h.ledger.monthTotal = () => 156;
    const before = creations(h);
    const refused = await createPlan(h);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), {
      error: "budget-guard",
      allowed: false,
      code: "budget-exhausted",
      title: TEXTES.partout.budget.titre,
      message: budgetPlan(formatUsd(156), formatUsd(150)),
      percent: 104,
      outputPricePerM: null,
      run: null,
      modelName: null,
    });
    assert.match(refused.json<{ message: string }>().message, /^Budget du mois atteint \(156 \$ sur 150 \$\)\. Créer cette conversation de plan ne coûte rien/);
    assert.equal(creations(h), before);

    const confirmed = await createPlan(h, { directory: h.fake.directory }, h.headers.confirmed);
    assert.equal(confirmed.status, 200, confirmed.body);
    assert.equal(store.read(confirmed.json<PlanCreateResponse>().rootId)?.choix, "plan");

    h.settings.update({ budget: { guard: { ...h.settings.get().budget.guard, blockAtLimit: false } } });
    assert.equal((await createPlan(h)).status, 200);
    h.settings.update({ budget: { guard: { ...h.settings.get().budget.guard, blockAtLimit: true, enabled: false } } });
    assert.equal((await createPlan(h)).status, 200);
    h.ledger.percentUsed = () => 99.9;
    h.settings.update({ budget: { guard: { ...h.settings.get().budget.guard, enabled: true } } });
    assert.equal((await createPlan(h)).status, 200);
    // Seuil atteint tout juste : refusé, comme le premier refus de ledger.guard.
    h.ledger.percentUsed = () => 100;
    assert.equal((await createPlan(h)).status, 409);
  });

  it("choix « plan » non enregistré (erreur de la base) → 500, conversation retirée d'opencode, rien annoncé", async (t) => {
    const { h, store, facts } = await start(t);
    refuseWrites(h, "refus_plan", "NEW.choix = 'plan'");
    const res = await createPlan(h);
    assert.equal(res.status, 500, res.body);
    assert.equal(res.json<{ error: string }>().error, "internal");
    const [id] = deletedIds(h);
    assert.ok(id);
    assert.equal(requests(h, "POST", "/session").length, 1);
    assert.equal(h.fake.session(id), undefined, "conversation supprimée dans opencode");
    assert.notEqual(h.sessions.get(id)?.deleted_at ?? null, null);
    assert.equal(store.read(id), null);
    assert.deepEqual(choiceEvents(h), []);
    assert.deepEqual(facts.appended, []);
  });

  it("plancher non vérifié à la création : conversation supprimée → 502 « non créée » ; suppression impossible → 502 « refusée » ; aucun plan enregistré", async (t) => {
    const { h, client } = await start(t);
    let deleteFails = false;
    client.tamper = async (method, pathname, forward) => {
      if (method === "POST" && pathname === "/session") {
        const res = await forward();
        const session = (await res.json()) as Record<string, unknown>;
        return jsonResponse(200, { ...session, permission: CONVERSATION });
      }
      if (method === "DELETE" && deleteFails) return jsonResponse(500, { message: "panne" });
      return forward();
    };
    const gone = await createPlan(h);
    assert.equal(gone.status, 502, gone.body);
    assert.deepEqual(gone.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.planNonCree });
    const firstId = h.fake.requests.find((r) => r.method === "DELETE" && r.pathname.startsWith("/session/"))?.pathname.split("/")[2];
    assert.ok(firstId);
    assert.equal(h.fake.session(firstId), undefined, "conversation supprimée dans opencode");

    deleteFails = true;
    const left = await createPlan(h);
    assert.equal(left.status, 502, left.body);
    assert.deepEqual(left.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.planRefuse });
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM conversation_autonomy").get()?.n, 0, "aucune conversation de plan enregistrée");
    assert.deepEqual(choiceEvents(h), []);

    // Module « floors » absent : port neutre, rien créé ni enregistré.
    const noFloors = await start(t, { modules: ["conversationAutonomy", "plans"] });
    const res = await createPlan(noFloors.h);
    assert.equal(res.status, 502, res.body);
    assert.deepEqual(res.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.planRefuse });
    assert.equal(creations(noFloors.h), 0);
  });
});

// --- Crochet d'envoi ------------------------------------------------------------------------------------------------------------

describe("Plan d'abord : crochet beforeBilledSend d'une conversation de plan", () => {
  it("marque perdue et opencode qui remplacerait les règles au PATCH : PLAN reposé avant le relais, la conversation ne peut toujours rien modifier", async (t) => {
    const { h, client } = await start(t);
    const { rootId: planId } = await newPlan(h);
    // opencode 1.18.30 ajoute les règles d'un PATCH (F-g) ; un opencode qui les remplacerait ne garderait que le dernier plancher.
    client.tamper = async (method, pathname, forward, body) => {
      const res = await forward();
      if (method !== "PATCH" || !pathname.startsWith("/session/") || !res.ok || body === null) return res;
      const sent = (JSON.parse(body) as { permission?: FakeSession["permission"] }).permission;
      const live = h.fake.session(pathname.split("/")[2] ?? "");
      if (!live || !sent) return res;
      live.permission = [...sent];
      return jsonResponse(200, { ...((await res.json()) as Record<string, unknown>), permission: sent });
    };
    h.sessions.setPlancher(planId, null);
    await answer(h, planId, "1. Lire.");
    // « floors » repose CONVERSATION (marque absente), puis « plans » repose PLAN, avant le relais.
    const patches = requests(h, "PATCH", `/session/${planId}`).map((r) => (r.body as { permission: unknown }).permission);
    assert.deepEqual(patches, [CONVERSATION, PLAN]);
    const promptAt = h.fake.requests.findIndex((r) => r.method === "POST" && r.pathname === `/session/${planId}/prompt_async`);
    const planPatchAt = h.fake.requests.findLastIndex((r) => r.method === "PATCH" && r.pathname === `/session/${planId}`);
    assert.ok(planPatchAt >= 0 && planPatchAt < promptAt, "PLAN posé avant le relais");
    assert.deepEqual(h.fake.session(planId)?.permission, PLAN);
    assert.equal(markIn(h, planId), PLAN_MARK);
    assert.deepEqual(h.fake.toolsFor(planId, { modelID: m2.model.modelID, agent: "build" }).filter((tool) => WRITERS.includes(tool)), []);

    // Marque à jour ensuite : aucun PATCH.
    await answer(h, planId, "2. Écrire le plan.");
    assert.equal(requests(h, "PATCH", `/session/${planId}`).length, 2);
  });

  it("travail délégué d'un plan : PLAN posé sur l'enfant avant un envoi qui le vise ; conversation ordinaire : jamais de PLAN", async (t) => {
    const { h } = await start(t);
    const { rootId: planId } = await newPlan(h);
    h.fake.script(planId, {
      tools: [{ tool: "task", input: { description: "Lecture", prompt: "Lis a.txt.", subagent_type: "general" }, child: { agent: "general", text: "Lu." } }],
      followUp: { text: "fin" },
    });
    assert.equal((await send(h, planId)).status, 204);
    await within(h.fake.settled(planId), "délégation terminée");
    const [child] = await h.deps.client.request<FakeSession[]>("GET", `/session/${planId}/children`);
    assert.ok(child);
    await until(() => h.sessions.get(child.id));
    await answer(h, child.id, "Suite.");
    assert.deepEqual(requests(h, "PATCH", `/session/${child.id}`).at(-1)?.body, { permission: PLAN });
    assert.equal(markIn(h, child.id), PLAN_MARK);
    assert.deepEqual(h.fake.session(child.id)?.permission?.slice(-PLAN.length), PLAN);

    const ordinary = await conversation(h);
    h.sessions.setPlancher(ordinary.id, null);
    await answer(h, ordinary.id, "Bonjour.");
    assert.deepEqual(
      requests(h, "PATCH", `/session/${ordinary.id}`).map((r) => r.body),
      [{ permission: CONVERSATION }],
    );
    assert.equal(markIn(h, ordinary.id), CONVERSATION_MARK);
  });

  it("sans le module « floors » : marque PLAN périmée ou absente → PLAN reposé par le crochet des plans, marque à jour", async (t) => {
    const { h, store } = await start(t, { modules: ["conversationAutonomy", "plans"] });
    const plan = await h.deps.client.request<FakeSession>("POST", "/session", { body: { title: "Plan", permission: PLAN } });
    await until(() => h.sessions.get(plan.id));
    store.setPlan(plan.id, null, Date.now());
    h.sessions.setPlancher(plan.id, `plan:${"0".repeat(64)}`);
    await answer(h, plan.id, "1. Lire.");
    assert.deepEqual(requests(h, "PATCH", `/session/${plan.id}`).map((r) => r.body), [{ permission: PLAN }]);
    assert.equal(markIn(h, plan.id), PLAN_MARK);
    h.sessions.setPlancher(plan.id, null);
    await answer(h, plan.id, "2. Écrire.");
    assert.equal(requests(h, "PATCH", `/session/${plan.id}`).length, 2);
    assert.equal(markIn(h, plan.id), PLAN_MARK);
    await answer(h, plan.id, "3. Relire.");
    assert.equal(requests(h, "PATCH", `/session/${plan.id}`).length, 2, "marque à jour : aucun PATCH");
  });

  it("PLAN non tenu par l'écho → 502 « nouvelle conversation de plan » ; opencode muet → 502 « réessayez » ; rien relayé", async (t) => {
    const { h, client } = await start(t);
    const { rootId: planId } = await newPlan(h);
    // Marque CONVERSATION à jour : seul le crochet des plans pose un PATCH.
    h.sessions.setPlancher(planId, CONVERSATION_MARK);
    client.tamper = async (method, pathname, forward) => {
      if (method === "PATCH" && pathname === `/session/${planId}`) {
        const res = await forward();
        return jsonResponse(200, { ...((await res.json()) as Record<string, unknown>), permission: CONVERSATION });
      }
      return forward();
    };
    const ecart = await send(h, planId);
    assert.equal(ecart.status, 502, ecart.body);
    assert.deepEqual(ecart.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.envoiEcart });

    client.tamper = async (method, pathname, forward) => {
      if (method === "PATCH" && pathname === `/session/${planId}`) throw new TypeError("fetch failed");
      return forward();
    };
    const silent = await send(h, planId);
    assert.equal(silent.status, 502, silent.body);
    assert.deepEqual(silent.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.envoi });

    // Écho d'une autre session, même avec les refus de PLAN : écart.
    client.tamper = async (method, pathname, forward) => {
      if (method === "PATCH" && pathname === `/session/${planId}`) {
        const res = await forward();
        return jsonResponse(200, { ...((await res.json()) as Record<string, unknown>), id: "ses_autre" });
      }
      return forward();
    };
    const other = await send(h, planId);
    assert.equal(other.status, 502, other.body);
    assert.deepEqual(other.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.envoiEcart });
    assert.equal(requests(h, "POST", `/session/${planId}/prompt_async`).length, 0, "rien relayé ni facturé");
    assert.equal(markIn(h, planId), CONVERSATION_MARK);
  });

  it("deux envois simultanés : un seul PATCH de PLAN ; pose terminée, la marque est relue au prochain envoi", async (t) => {
    const { h } = await start(t);
    const { rootId: planId } = await newPlan(h);
    h.sessions.setPlancher(planId, CONVERSATION_MARK);
    const service = createPlanService(h.cockpit.c11);
    const ctx = { c: {} as never, method: "POST", sub: `/session/${planId}/prompt_async`, directory: h.fake.directory, body: {}, sessionId: planId };
    assert.deepEqual(await Promise.all([service.beforeBilledSend(ctx), service.beforeBilledSend({ ...ctx })]), [null, null]);
    assert.deepEqual(requests(h, "PATCH", `/session/${planId}`).map((r) => r.body), [{ permission: PLAN }]);
    assert.equal(markIn(h, planId), PLAN_MARK);
    // Marque perdue après la pose : un nouvel envoi repose PLAN (aucun résultat gardé d'une pose terminée).
    h.sessions.setPlancher(planId, CONVERSATION_MARK);
    assert.equal(await service.beforeBilledSend(ctx), null);
    assert.equal(requests(h, "PATCH", `/session/${planId}`).length, 2);
    assert.equal(markIn(h, planId), PLAN_MARK);
  });
});

// --- Outils qui échappent aux demandes (§4.10) -----------------------------------------------------------------------------------

/** Serveur MCP déclaré dans la configuration (outil sur « allow » par défaut : il écrirait sans demande). */
const MCP = { mcp: { depot: { type: "remote", url: "https://mcp.exemple.invalid/mcp" } } };

/** Raccourci lancé par le proxy (POST …/command), avec l'IA de la conversation. */
const runCommand = (h: CockpitHarness, sessionId: string, command: string) =>
  h.call("POST", `/api/oc/session/${sessionId}/command`, {
    headers: h.headers.mutating,
    body: { command, arguments: "", agent: "build", model: `${MODEL.providerID}/${MODEL.modelID}` },
  });

describe("Plan d'abord : outils MCP, extensions et lignes !`…` des raccourcis (« ne peut rien modifier », §4.9, §4.10)", () => {
  it("création : MCP ou extension dans la configuration effective, fichier .js/.ts dans plugin(s)/ du dossier de configuration → 409, aucune racine ; configuration illisible → 502", async (t) => {
    const { h, client } = await start(t);
    const base = { ...h.fake.globalConfig };
    const refused = async (label: string) => {
      const res = await createPlan(h);
      assert.equal(res.status, 409, `${label} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "outils-hors-controle", message: TEXTES.partout.erreurs.outilsCreation }, label);
      assert.equal(creations(h), 0, `${label} : aucune racine créée`);
    };

    h.fake.globalConfig = { ...base, ...MCP };
    await refused("MCP de la configuration globale");
    h.fake.globalConfig = { ...base, mcp: { local: { type: "local", command: ["serveur-mcp"], enabled: false } } };
    await refused("MCP déclaré mais désactivé");
    h.fake.globalConfig = base;
    h.fake.projectConfigs.set(h.fake.directory, { plugin: ["file:///workspace/.opencode/plugins/ecrit.js"] });
    await refused("extension du projet");
    h.fake.projectConfigs.clear();

    // Relevé du dossier de configuration monté : une extension posée dans plugin(s)/ sera chargée au prochain rechargement.
    const plugins = path.join(h.deps.env.opencodeConfigDir, "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, "ecrit.ts"), "export const Ecrit = async () => ({});\n");
    await refused("fichier dans plugins/");
    fs.rmSync(path.join(plugins, "ecrit.ts"));
    fs.mkdirSync(path.join(h.deps.env.opencodeConfigDir, "plugin"), { recursive: true });
    fs.writeFileSync(path.join(h.deps.env.opencodeConfigDir, "plugin", "autre.js"), "export const Autre = async () => ({});\n");
    await refused("fichier dans plugin/");
    fs.rmSync(path.join(h.deps.env.opencodeConfigDir, "plugin", "autre.js"));
    fs.writeFileSync(path.join(plugins, "LISEZMOI.md"), "Aucune extension ici.\n");

    // Configuration illisible : rien n'est créé (P1).
    client.tamper = async (method, pathname, forward) => {
      if (method === "GET" && pathname === "/config") throw new TypeError("fetch failed");
      return forward();
    };
    const unreadable = await createPlan(h);
    assert.equal(unreadable.status, 502, unreadable.body);
    assert.deepEqual(unreadable.json(), { error: "configuration-illisible", message: TEXTES.partout.erreurs.configurationCreation });
    client.tamper = async (method, pathname, forward) => (method === "GET" && pathname === "/config" ? jsonResponse(200, ["pas", "un", "objet"]) : forward());
    assert.equal((await createPlan(h)).status, 502, "réponse illisible");
    assert.equal(creations(h), 0);

    // Rien de déclaré (un fichier qui n'est pas une extension ne compte pas) : créée, configuration lue dans le dossier du plan.
    client.tamper = null;
    await newPlan(h);
    assert.equal(creations(h), 1);
    assert.equal(requests(h, "GET", "/config").at(-1)?.query.directory, h.fake.directory);
  });

  it("envoi dans un plan : MCP ou extension déclarés après la création → 409, rien relayé ni facturé ; retirés → relayé ; conversation ordinaire jamais refusée pour ça", async (t) => {
    const { h, client } = await start(t);
    const { rootId: planId } = await newPlan(h);
    const base = { ...h.fake.globalConfig };
    h.fake.globalConfig = { ...base, ...MCP };
    const refused = await send(h, planId);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "outils-hors-controle", message: TEXTES.partout.erreurs.outilsEnvoi });
    h.fake.globalConfig = { ...base, plugin: ["ecrit@1.0.0"] };
    assert.equal((await send(h, planId)).status, 409, "extension npm");
    assert.equal(requests(h, "POST", `/session/${planId}/prompt_async`).length, 0, "rien relayé ni facturé");

    // Configuration illisible : message non envoyé (P1).
    h.fake.globalConfig = base;
    client.tamper = async (method, pathname, forward) => {
      if (method === "GET" && pathname === "/config") throw new TypeError("fetch failed");
      return forward();
    };
    const unreadable = await send(h, planId);
    assert.equal(unreadable.status, 502, unreadable.body);
    assert.deepEqual(unreadable.json(), { error: "configuration-illisible", message: TEXTES.partout.erreurs.envoi });
    assert.equal(requests(h, "POST", `/session/${planId}/prompt_async`).length, 0);

    // Conversation ordinaire : l'activation des choix automatiques (§4.11) en juge, pas « Plan d'abord ».
    const ordinary = await conversation(h);
    h.fake.globalConfig = { ...base, ...MCP };
    await answer(h, ordinary.id, "Bonjour.");

    client.tamper = null;
    h.fake.globalConfig = base;
    await answer(h, planId, "1. Lire.");
    assert.equal(requests(h, "POST", `/session/${planId}/prompt_async`).length, 1);
  });

  it("raccourci dont le texte contient une ligne !`…` : refusé dans un plan (et son travail délégué), rien exécuté ; sans ligne !`…` → lancé ; conversation ordinaire → lancé", async (t) => {
    const { h } = await start(t);
    h.fake.setCommands([
      { name: "formate", template: "Lance !`npm run format` puis résume $ARGUMENTS.", hints: [] },
      { name: "resume", template: "Résume $ARGUMENTS en trois points.", hints: [] },
    ]);
    const { rootId: planId } = await newPlan(h);
    const refused = await runCommand(h, planId, "formate");
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "raccourci-commande", message: TEXTES.partout.erreurs.raccourciCommande });
    assert.equal(requests(h, "POST", `/session/${planId}/command`).length, 0, "raccourci jamais relayé");
    assert.equal(h.fake.messages(planId).length, 0);

    h.fake.script(planId, { text: "1. Lire." });
    const allowed = await runCommand(h, planId, "resume");
    assert.equal(allowed.status, 200, allowed.body);
    assert.equal(requests(h, "POST", `/session/${planId}/command`).length, 1);

    // Travail délégué d'un plan : même arbre, même refus.
    const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: planId, title: "Délégué" } });
    await until(() => h.sessions.get(child.id));
    assert.equal((await runCommand(h, child.id, "formate")).status, 409, "enfant d'un plan");

    const ordinary = await conversation(h);
    h.fake.script(ordinary.id, { text: "Formaté." });
    const outside = await runCommand(h, ordinary.id, "formate");
    assert.equal(outside.status, 200, outside.body);
  });
});

// --- Exécution ------------------------------------------------------------------------------------------------------------------

describe("Plan d'abord : POST /api/plans/:id/execution", () => {
  it("« demander » : nouvelle racine CONVERSATION vérifiée, execution_de_plan_id, brouillon du dernier texte ; plan inchangé ; aucun fork", async (t) => {
    const { h, store } = await start(t);
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Premier jet.");
    await answer(h, planId, "1. Lire a.txt.\n2. Corriger b.txt.");
    const res = await execute(h, planId, { choix: "demander" });
    assert.equal(res.status, 200, res.body);
    const done = res.json<PlanExecutionResponse>();
    assert.notEqual(done.rootId, planId);
    assert.equal(done.brouillon, "Exécute le plan suivant.\n\n1. Lire a.txt.\n2. Corriger b.txt.");
    assert.equal(done.brouillon, brouillonExecution("1. Lire a.txt.\n2. Corriger b.txt."));
    assert.deepEqual(Object.keys(done.session).sort(), ["directory", "id", "time", "title"]);
    assert.equal(done.session.directory, h.fake.directory);

    // Nouvelle racine, plancher CONVERSATION vérifié, aucun message envoyé : l'utilisateur relit et envoie.
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { permission: CONVERSATION });
    assert.deepEqual(h.fake.session(done.rootId)?.permission, CONVERSATION);
    assert.equal(h.fake.session(done.rootId)?.parentID, undefined);
    assert.equal(markIn(h, done.rootId), CONVERSATION_MARK);
    assert.equal(h.fake.messages(done.rootId).length, 0);
    const view = await autonomyView(h, done.rootId);
    assert.equal(view.choix, "demander");
    assert.equal(view.executionDePlanId, planId);
    assert.equal(store.read(done.rootId)?.executionDePlanId, planId);
    // Le plan reste un plan ; aucun fork (il recopierait les messages facturés, sans plancher).
    assert.equal(store.read(planId)?.choix, "plan");
    assert.deepEqual(forks(h), []);

    // « demander » avec des plafonds : posés par le même port que PUT …/autonomie (resserrer : sans confirmation).
    const capped = await execute(h, planId, { choix: "demander", plafonds: { actionsMax: 7 } });
    assert.equal(capped.status, 200, capped.body);
    const cappedView = await autonomyView(h, capped.json<PlanExecutionResponse>().rootId);
    assert.deepEqual([cappedView.choix, cappedView.plafonds.actionsMax, cappedView.executionDePlanId], ["demander", 7, planId]);
    h.assertNoGlobalRestart();
  });

  it("« modifications » ou « autonome » sans x-cockpit-confirm → 428 avant toute création de racine", async (t) => {
    const activation = new ScriptedActivation();
    const { h } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    const before = creations(h);
    for (const choix of ["modifications", "autonome"]) {
      const res = await execute(h, planId, { choix });
      assert.equal(res.status, 428, `${choix} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "confirmation-requise", message: AUTONOMIE.partout.erreurs.confirmation });
    }
    assert.equal(creations(h), before, "aucune racine créée");
    assert.equal(activation.calls.length, 0, "activation non consultée sans confirmation");
  });

  it("avec l'en-tête, activation fermée (ACTIVATION_OUVERTE faux, port neutre) → 409 avec la raison, aucune racine", async (t) => {
    const { h } = await start(t);
    assert.equal(h.cockpit.c11.activationOuverte, false);
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    const before = creations(h);
    for (const choix of ["modifications", "autonome"]) {
      const res = await execute(h, planId, { choix }, h.headers.confirmed);
      assert.equal(res.status, 409, `${choix} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonIndisponible("a-venir"), raison: "a-venir" });
    }
    assert.equal(creations(h), before);
  });

  it("activation surchargée à « permis » : racine CONVERSATION, choix « autonome » et plafonds, brouillon ; activation consultée avant la création", async (t) => {
    const activation = new ScriptedActivation();
    const { h, store } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "1. Tout refaire.");
    const creationsBefore = creations(h);
    const res = await execute(h, planId, { choix: "autonome", plafonds: { actionsMax: 12 } }, h.headers.confirmed);
    assert.equal(res.status, 200, res.body);
    const done = res.json<PlanExecutionResponse>();
    assert.equal(creations(h), creationsBefore + 1);
    assert.equal(done.brouillon, brouillonExecution("1. Tout refaire."));
    assert.deepEqual(h.fake.session(done.rootId)?.permission, CONVERSATION);
    // Vérifiée d'abord pour le dossier du plan (racine pas encore créée), puis refaite sur la nouvelle racine par le port.
    assert.deepEqual(activation.calls[0], { rootId: planId, choix: "autonome", agent: null, directory: h.fake.directory });
    assert.equal(activation.calls[1]?.rootId, done.rootId);
    const view = await autonomyView(h, done.rootId);
    assert.equal(view.choix, "autonome");
    assert.equal(view.plafonds.actionsMax, 12);
    assert.equal(view.executionDePlanId, planId);
    assert.equal(store.read(done.rootId)?.choix, "autonome");
    assert.deepEqual(choiceEvents(h).at(-1), { rootId: done.rootId, choix: "autonome", cause: "clic" });
    const modifications = await execute(h, planId, { choix: "modifications" }, h.headers.confirmed);
    assert.equal(modifications.status, 200, modifications.body);
    assert.equal(store.read(modifications.json<PlanExecutionResponse>().rootId)?.choix, "modifications");
    h.assertNoGlobalRestart();
  });

  it("activation refusée entre la vérification et la pose du choix → 409 avec la raison, racine créée puis supprimée", async (t) => {
    const activation = new ScriptedActivation();
    activation.verdicts = [{ ok: true }, { ok: false, raison: "regle-allow" }];
    const { h, store } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    const res = await execute(h, planId, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonIndisponible("regle-allow"), raison: "regle-allow" });
    const created = requests(h, "POST", "/session").at(-1);
    assert.ok(created);
    const removed = h.fake.requests.filter((r) => r.method === "DELETE" && r.pathname.startsWith("/session/"));
    assert.equal(removed.length, 1);
    const id = removed[0]?.pathname.split("/")[2] ?? "";
    assert.equal(activation.calls[1]?.rootId, id);
    assert.equal(h.fake.session(id), undefined, "racine supprimée dans opencode");
    assert.notEqual(h.sessions.get(id)?.deleted_at ?? null, null);
    assert.equal(store.read(id), null, "aucun choix ni exécution enregistrés");
  });

  it("racine retirée : marquée supprimée dans le cockpit dès la réponse de DELETE, sans attendre l'événement d'opencode", async (t) => {
    const activation = new ScriptedActivation();
    activation.verdicts = [{ ok: true }, { ok: false, raison: "regle-allow" }];
    const { h, client } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    // DELETE accepté sans être relayé : aucun événement session.deleted n'arrivera.
    const swallowed: string[] = [];
    client.tamper = async (method, pathname, forward) => {
      if (method !== "DELETE") return forward();
      swallowed.push(pathname.split("/")[2] ?? "");
      return jsonResponse(200, true);
    };
    const res = await execute(h, planId, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(res.status, 409, res.body);
    const [id] = swallowed;
    assert.ok(id);
    assert.ok(h.fake.session(id), "rien relayé à opencode");
    assert.notEqual(h.sessions.get(id)?.deleted_at ?? null, null, "marquée supprimée par le cockpit");
  });

  it("autre choix sur une racine de plan → 409 (PUT …/autonomie) ; « plan » y reste", async (t) => {
    const activation = new ScriptedActivation();
    const { h, store } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    for (const choix of ["demander", "modifications", "autonome"]) {
      const res = await h.call("PUT", `/api/conversations/${planId}/autonomie`, { headers: h.headers.confirmed, body: { choix } });
      assert.equal(res.status, 409, `${choix} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonIndisponible("racine-de-plan"), raison: "racine-de-plan" });
    }
    assert.equal(store.read(planId)?.choix, "plan");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(planId), "plan");
  });

  it("COCKPIT_AUTONOMY=off : POST /api/plans → 200, exécution « demander » → 200, « modifications » et « autonome » → 403 sans racine", async (t) => {
    const activation = new ScriptedActivation();
    const { h } = await start(t, { env: { autonomy: false }, ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    const ask = await execute(h, planId, { choix: "demander" });
    assert.equal(ask.status, 200, ask.body);
    const before = creations(h);
    for (const [choix, headers] of [
      ["autonome", h.headers.confirmed],
      ["modifications", h.headers.confirmed],
      ["autonome", h.headers.mutating],
    ] as const) {
      const res = await execute(h, planId, { choix }, headers);
      assert.equal(res.status, 403, `${choix} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "autonomie-coupee", message: raisonIndisponible("autonomie-coupee"), raison: "autonomie-coupee" });
    }
    assert.equal(creations(h), before);
    assert.equal(activation.calls.length, 0);
  });

  it("refus avant création : identifiant, corps, plan inconnu ou conversation ordinaire, plan sans réponse terminée, texte illisible", async (t) => {
    const activation = new ScriptedActivation();
    const { h, client, store } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    const ordinary = await conversation(h);
    const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: planId, title: "Enfant" } });
    await until(() => h.sessions.get(child.id));
    const deleted = await newPlan(h);
    h.sessions.markDeleted(deleted.rootId);
    // « plan » enregistré sur une session interne ou sur une conversation de la Salle OMO (écriture étrangère) : pas un plan.
    const internal = await h.deps.client.request<FakeSession>("POST", "/session", { body: { title: "[cockpit] Classement" } });
    await until(() => h.sessions.get(internal.id));
    store.setPlan(internal.id, null, Date.now());
    const omo = await newPlan(h);
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(omo.rootId);
    // Conversation de plan dont le dossier n'est plus dans le workspace monté.
    const outside = await h.deps.client.request<FakeSession>("POST", "/session", { directory: "/ailleurs", body: { title: "Hors workspace" } });
    await until(() => h.sessions.get(outside.id));
    store.setPlan(outside.id, null, Date.now());
    const before = creations(h);

    for (const id of ["ses.x", "ses%20x", "s".repeat(129)]) {
      const res = await execute(h, id, { choix: "demander" });
      assert.equal(res.status, 400, `${id} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "invalid", message: TEXTES.partout.erreurs.identifiant });
    }
    const bodies: unknown[] = [
      {},
      { choix: "plan" },
      { choix: "omo" },
      { choix: "demander", bourrage: 1 },
      { choix: "autonome", plafonds: { plafondUsd: 999 } },
      // Au-delà de plafondMaxUsd (5 $ par défaut) mais dans les bornes des réglages : refusé avant la création, comme par PUT.
      { choix: "autonome", plafonds: { plafondUsd: 6 } },
      { choix: "autonome", plafonds: { inconnu: 1 } },
      { choix: "demander", plafonds: { actionsMax: -1 } },
    ];
    for (const body of bodies) {
      const res = await execute(h, planId, body, h.headers.confirmed);
      assert.equal(res.status, 400, `${JSON.stringify(body)} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "invalid", message: TEXTES.partout.erreurs.requete });
    }
    const long = await execute(h, planId, { choix: "demander", bourrage: "x".repeat(5_000) });
    assert.equal(long.status, 413, long.body);

    for (const id of ["ses_inconnue", ordinary.id, child.id, deleted.rootId, internal.id, omo.rootId]) {
      const res = await execute(h, id, { choix: "autonome" }, h.headers.confirmed);
      assert.equal(res.status, 404, `${id} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "not-found", message: TEXTES.partout.erreurs.planInconnu });
    }
    const elsewhere = await execute(h, outside.id, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(elsewhere.status, 403, elsewhere.body);
    assert.deepEqual(elsewhere.json(), { error: "forbidden-directory", message: TEXTES.partout.erreurs.dossier });

    // Aucune réponse terminée : rien à exécuter.
    const empty = await execute(h, planId, { choix: "demander" });
    assert.equal(empty.status, 409, empty.body);
    assert.deepEqual(empty.json(), { error: "plan-sans-reponse", message: TEXTES.partout.erreurs.sansReponse });

    // Texte du plan illisible dans opencode.
    await answer(h, planId, "Plan.");
    client.tamper = async (method, pathname, forward) =>
      method === "GET" && pathname === `/session/${planId}/message` ? jsonResponse(500, { message: "panne" }) : forward();
    const unreadable = await execute(h, planId, { choix: "demander" });
    assert.equal(unreadable.status, 502, unreadable.body);
    assert.deepEqual(unreadable.json(), { error: "opencode-unreachable", message: TEXTES.partout.erreurs.lecture });
    assert.equal(creations(h), before, "aucune racine créée par une requête refusée");
    assert.equal(activation.calls.length, 0, "activation jamais consultée pour une requête refusée avant");
  });

  it("plancher non vérifié sur la conversation d'exécution → 502, supprimée, aucune exécution enregistrée", async (t) => {
    const { h, client, store } = await start(t);
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    let deleteFails = false;
    client.tamper = async (method, pathname, forward) => {
      if (method === "POST" && pathname === "/session") {
        const res = await forward();
        return jsonResponse(200, { ...((await res.json()) as Record<string, unknown>), permission: [] });
      }
      if (method === "DELETE" && deleteFails) return jsonResponse(500, { message: "panne" });
      return forward();
    };
    const gone = await execute(h, planId, { choix: "demander" });
    assert.equal(gone.status, 502, gone.body);
    assert.deepEqual(gone.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.executionNonCreee });
    deleteFails = true;
    const left = await execute(h, planId, { choix: "demander" });
    assert.equal(left.status, 502, left.body);
    assert.deepEqual(left.json(), { error: "plancher-non-verifie", message: TEXTES.partout.erreurs.executionRefusee });
    const rows = h.db.prepare("SELECT root_id FROM conversation_autonomy WHERE execution_de_plan_id IS NOT NULL").all();
    assert.deepEqual(rows, []);
    assert.equal(store.read(planId)?.choix, "plan");
  });

  it("lien au plan non enregistré (erreur de la base) → 500, conversation d'exécution retirée d'opencode", async (t) => {
    const activation = new ScriptedActivation();
    const { h, store } = await start(t, { ports: { activation } });
    const { rootId: planId } = await newPlan(h);
    await answer(h, planId, "Plan.");
    refuseWrites(h, "refus_execution", "NEW.execution_de_plan_id IS NOT NULL");
    for (const [choix, headers] of [
      ["demander", h.headers.mutating],
      ["autonome", h.headers.confirmed],
    ] as const) {
      const before = deletedIds(h).length;
      const res = await execute(h, planId, { choix }, headers);
      assert.equal(res.status, 500, `${choix} : ${res.body}`);
      const removed = deletedIds(h).slice(before);
      assert.equal(removed.length, 1, choix);
      const id = removed[0] ?? "";
      assert.notEqual(id, planId);
      assert.equal(h.fake.session(id), undefined, "conversation d'exécution supprimée dans opencode");
      assert.notEqual(h.sessions.get(id)?.deleted_at ?? null, null);
      assert.equal(store.read(id)?.executionDePlanId ?? null, null);
    }
    assert.equal(store.read(planId)?.choix, "plan");
    assert.ok(h.fake.session(planId), "le plan reste");
  });
});

// --- Dernier texte du plan, textes ------------------------------------------------------------------------------------------------

describe("Plan d'abord : dernier texte du plan et textes", () => {
  const assistant = (text: string | null, extra: Record<string, unknown> = {}, parts?: unknown[]) => ({
    info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, ...extra },
    parts: parts ?? (text === null ? [] : [{ type: "text", text }]),
  });
  const user = (text: string) => ({ info: { id: "msg_u", role: "user", time: { created: 1 } }, parts: [{ type: "text", text }] });

  it("dernière réponse terminée, sans erreur ni résumé ; parties synthétiques et ignorées écartées ; secrets masqués", () => {
    assert.equal(lastPlanText([user("Plan ?"), assistant("Ancien."), assistant("Nouveau.")]), "Nouveau.");
    // Réponse en cours (non terminée), en erreur ou résumé : la précédente fait foi.
    assert.equal(lastPlanText([assistant("Plan."), assistant("En cours", { time: { created: 3 } })]), "Plan.");
    assert.equal(lastPlanText([assistant("Plan."), assistant("Coupé", { error: { name: "MessageAbortedError" } })]), "Plan.");
    assert.equal(lastPlanText([assistant("Plan."), assistant("Résumé", { summary: true })]), "Plan.");
    // Message d'outils seul, puis texte : le texte ; parties synthétiques ou ignorées écartées.
    const mixed = [
      { type: "text", text: "Je relis.", synthetic: true },
      { type: "tool", tool: "read" },
      { type: "text", text: "  Étape A  " },
      { type: "text", text: "masqué", ignored: true },
      { type: "text", text: "Étape B" },
    ];
    assert.equal(lastPlanText([assistant("Plan."), assistant(null, {}, mixed), assistant(null, {}, [{ type: "tool", tool: "grep" }])]), "Étape A  \nÉtape B");
    assert.equal(lastPlanText([assistant("Utiliser token=abcdef123456 puis continuer.")]), "Utiliser token=**** puis continuer.");
    assert.equal(lastPlanText([user("Plan ?"), assistant("   ")]), null);
    // Message de l'utilisateur, même marqué terminé : jamais pris pour le plan.
    const userDone = { info: { id: "msg_u2", role: "user", time: { created: 3, completed: 4 } }, parts: [{ type: "text", text: "Exécute." }] };
    assert.equal(lastPlanText([assistant("Plan."), userDone]), "Plan.");
    assert.equal(lastPlanText([]), null);
    assert.equal(lastPlanText([null, "x", { info: null }, { info: { role: "assistant" }, parts: "x" }]), null);
    assert.throws(() => lastPlanText({}), TypeError);
  });

  it("phrases exactes (§4.9) : honnêteté, carte, brouillon ; gabarit du garde-fou rempli", () => {
    assert.equal(TEXTES.partout.honnetete, "Cette conversation ne peut rien modifier, même plus tard.");
    assert.deepEqual(TEXTES.partout.carte, {
      executerDemander: "Exécuter en demandant à chaque fois",
      executerModifications: "Exécuter avec modifications automatiques",
      executerAutonome: "Exécuter en autonome avec contrôle",
      continuer: "Continuer à planifier",
    });
    assert.equal(TEXTES.partout.brouillon, "Exécute le plan suivant.");
    assert.equal(brouillonExecution("A\nB"), "Exécute le plan suivant.\n\nA\nB");
    const budget = budgetPlan("12 $", "10 $");
    assert.ok(budget.startsWith("Budget du mois atteint (12 $ sur 10 $). "), budget);
    assert.doesNotMatch(budget, /\{\w+\}/);
    // Honnêteté du plancher : la phrase ne vaut que parce que PLAN retire edit, write, apply_patch et bash.
    assert.deepEqual(
      PLAN.slice(-2),
      [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
      ],
    );
    // Refus du §4.10 : ils nomment ce qui passerait sans demande et disent que rien n'est parti.
    const { erreurs } = TEXTES.partout;
    for (const phrase of [erreurs.outilsCreation, erreurs.outilsEnvoi]) assert.match(phrase, /outils MCP ou des extensions, qui (?:peuvent|pourraient) modifier des fichiers sans vous demander/);
    assert.match(erreurs.outilsCreation, /^Conversation de plan non créée : .*Aucun message n'a été envoyé ni facturé\.$/);
    assert.match(erreurs.configurationCreation, /^Conversation de plan non créée : .*Aucun message n'a été envoyé ni facturé\. Réessayez dans un instant\.$/);
    assert.match(erreurs.outilsEnvoi, /^Message non envoyé : .*Rien n'a été facturé\./);
    assert.equal(
      erreurs.raccourciCommande,
      "Raccourci non lancé : son texte contient une ligne « !`…` », qu'opencode exécuterait sans vous demander. Une conversation de plan ne peut rien modifier : lancez ce raccourci dans une autre conversation. Rien n'a été facturé.",
    );
  });

  it("création sans aucun envoi ; même un message envoyé hors du cockpit ne trouve aucun outil d'écriture (refus portés par opencode)", async (t) => {
    const { h } = await start(t);
    const { rootId: planId } = await newPlan(h);
    assert.equal(h.fake.requests.filter((r) => r.method === "POST" && r.pathname.startsWith(`/session/${planId}/`)).length, 0);
    const direct = await promptAsync(h.deps.client, planId, "Hors cockpit.", { model: MODEL });
    assert.equal(direct, 204);
    await within(h.fake.settled(planId), "réponse terminée");
    // Même hors du cockpit, opencode applique les refus de la session : aucun outil d'écriture proposé.
    assert.deepEqual(h.fake.toolsFor(planId, { agent: "build" }).filter((tool) => WRITERS.includes(tool)), []);
  });
});
