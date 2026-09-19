// Tests de croisement du train it1 V3 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L1d (garde du « task once »,
// refus Simple, détails), L1e (surveillance des délégations lancées sans demande), L6b (plans), L6s (sélecteur), L5b (activité,
// « Qui travaille ? »), L5t (transcription, Déroulé, renommages) et L5c (bande néon), sur le câblage complet (modules « tous »).
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul (chaque paquet a testé ses modules déclarés) :
//   1. `task` en Simple puis en Avancé, choix « demander » : exactement une réponse à la délégation (registre emitted) ; en Simple,
//      le refus retenu par le portillon réel (L1b) sert le refus Simple de L1d : rien n'est envoyé avant votre réponse au `bash` ;
//   2. délégation accordée « once » (L1d, portillon) jamais comptée par L1e, qui compte pourtant la délégation lancée sans demande
//      par l'enfant accordé ; sessions de contrôle jamais comptées, ni par L1e ni par le plafond de la garde du « once » (L1d) ;
//   3. exécution d'un plan (L6b) sur le câblage complet : « modifications » et « autonome » → 428 sans en-tête, 409 « a-venir »
//      avec (porte I1), aucune racine créée ; COCKPIT_AUTONOMY=off : plan et « demander » 200, choix automatiques 403 ; conversation
//      d'origine (plan_source_id, demande de contrat de L6b) ;
//   4. interfaces entre paquets web : la bande néon (L5c) reçoit le dossier de la conversation d'ActivityRegion (L5b) ; renommage
//      « Actions maximum » (L5t, D1) jusque dans le message de validation du Studio.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { validateDraft } from "../web/pages/studio/shared.ts";
import type { PermissionGate } from "./contracts-11.ts";
import type { ConversationAutonomyView, PlanCreateResponse, PlanExecutionResponse } from "./shared/autonomy-types.ts";
import { avisSimple, messageRefusSimple } from "./shared/delegation-texts.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession, FakeToolScript } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const FIN = "Synthèse faite seule.";

/** Conversation créée par le proxy (plancher posé par L3), suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Envoi par le proxy (ligne chat_turns = début de la demande, crochets d'envoi), puis relais. */
async function sendThroughProxy(h: CockpitHarness, sessionId: string, text: string): Promise<void> {
  const sent = await h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

/** Délégation qui demande votre accord (tool/task.ts : patterns = [subagent_type], metadata {description, subagent_type}). */
function askedTask(description: string, child: Partial<NonNullable<FakeToolScript["child"]>> = {}): FakeToolScript {
  return {
    tool: "task",
    input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
    ask: { permission: "task", patterns: ["general"], metadata: { description, subagent_type: "general" } },
    child: { agent: "general", text: "Résumé du sous-agent.", ...child },
  };
}

/** Délégation d'un agent du Studio avec `task: allow` : aucune demande n'est posée. */
function allowTask(description: string, child: Partial<NonNullable<FakeToolScript["child"]>> = {}): FakeToolScript {
  return { ...askedTask(description), agentRules: [{ permission: "task", pattern: "*", action: "allow" }], child: { agent: "general", workMs: 20, ...child } };
}

const repliesTo = (h: CockpitHarness, requestId: string) =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${requestId}/reply`).map((r) => r.body);

const once = (h: CockpitHarness, requestId: string) =>
  h.call("POST", `/api/oc/permission/${requestId}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });

const eventsOf = (h: CockpitHarness, type: string) => h.cockpitEvents().filter((e) => e.type === type).map((e) => e.data);

/** Les `count` demandes d'autorisation de la session, toutes en attente. */
async function pending(h: CockpitHarness, sessionId: string, count: number): Promise<FakePermissionRequest[]> {
  return until(() => {
    const list = h.fake.pendingPermissions().filter((p) => p.sessionID === sessionId);
    return list.length === count ? list : null;
  });
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** File des réponses libre : toute évaluation déjà commencée est terminée. */
async function queueIdle(gate: PermissionGate): Promise<void> {
  await flush();
  (await within(gate.acquire(), "file des réponses libre"))();
}

/** Attend la fin de tout le travail de la racine et de ses sous-agents, puis vérifie qu'aucune session ne travaille. */
async function settledTree(h: CockpitHarness, rootId: string): Promise<void> {
  const tree = [rootId, ...h.sessions.descendants(rootId)];
  await within(Promise.all(tree.map((id) => h.fake.settled(id))), "arbre au repos", 5_000);
  assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {}, "aucune session occupée");
}

const lastText = (h: CockpitHarness, sessionId: string): unknown =>
  h.fake
    .messages(sessionId)
    .flatMap((m) => m.parts)
    .findLast((p) => p.type === "text")?.text;

const waitRow = (h: CockpitHarness, permissionId: string) =>
  h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(permissionId) as
    | { reply: string | null; replied_by: string | null }
    | undefined;

describe("croisements it1 V3 : délégation en Simple et en Avancé, choix « demander »", () => {
  it("Simple : `bash` + `task` ; le refus retenu du portillon (L1b) attend votre réponse au bash, l'avis répond au « once » (L1d) ; exactement une réponse à la délégation, par le cockpit (registre, attente, faits) ; rien compté par L1e ; P6", async (t) => {
    // Plafond de délégations à 0 : une délégation refusée, qui ne lance aucun sous-agent, ne doit rien déclencher chez L1e.
    const h = await startCockpit(t, { modules: "tous", settings: { budget: { delegation: { maxPerRequest: 0 } } } });
    assert.equal(h.settings.get().ui.mode, "simple", "mode Simple par défaut");
    const root = await trackedRoot(h, "Simple, demander");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");

    const since = h.fake.requests.length;
    const sinceEvents = h.fake.emitted.length;
    h.fake.script(root.id, { tools: [bash("ls"), askedTask("Analyser les journaux")], followUp: { text: FIN } });
    await sendThroughProxy(h, root.id, "Travaille.");
    const asked = await pending(h, root.id, 2);
    const bashAsk = asked.find((p) => p.permission === "bash");
    const taskAsk = asked.find((p) => p.permission === "task");
    assert.ok(bashAsk && taskAsk);

    // Le refus Simple (dérivation de L1d) a atteint le portillon réel (GET /permission) et y est retenu : votre bash attend encore.
    await until(() => h.fake.requests.slice(since).some((r) => r.method === "GET" && r.pathname === "/permission"));
    await queueIdle(h.cockpit.gate);
    assert.deepEqual([...repliesTo(h, bashAsk.id), ...repliesTo(h, taskAsk.id)], [], "aucune réponse avant la vôtre au bash");
    assert.equal(h.cockpit.gate.emitted.has(taskAsk.id), false);

    // « Autoriser une fois » la délégation en Simple : l'avis (Q5), rien relayé.
    const refused = await once(h, taskAsk.id);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "delegation-refusee", message: avisSimple() });
    assert.deepEqual(repliesTo(h, taskAsk.id), []);

    // Votre réponse au bash (relais 1.0, la garde ne vise que `task`), puis le refus retenu part : l'IA continue seule.
    const bashOnce = await once(h, bashAsk.id);
    assert.equal(bashOnce.status, 200, bashOnce.body);
    await within(h.fake.settled(root.id), "tour terminé");
    assert.deepEqual(repliesTo(h, bashAsk.id), [{ reply: "once" }]);
    assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }], "exactement une réponse à la délégation");
    assert.equal(h.cockpit.gate.emitted.has(taskAsk.id), true, "refus inscrit au registre (P9)");
    assert.equal(lastText(h, root.id), FIN);

    // « once » tardif : refusé, toujours une seule réponse.
    const late = await once(h, taskAsk.id);
    assert.equal(late.status, 409, late.body);
    assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }]);

    // Écrivain unique (L4b) : attente close « reject » par le cockpit ; faits « reponse » concordants (flux et refus Simple).
    assert.deepEqual({ ...(await until(() => (waitRow(h, taskAsk.id)?.replied_by ? waitRow(h, taskAsk.id) : null))) }, { reply: "reject", replied_by: "cockpit" });
    const replies = await until(() => {
      const list = h.cockpit.c11.ports.facts.since(root.id, 0).facts.filter((f) => f.kind === "reponse" && f.ref === taskAsk.id);
      return list.some((f) => f.data.par === "cockpit") ? list : null;
    });
    assert.ok(replies.every((f) => f.data.reponse === "reject"), JSON.stringify(replies.map((f) => f.data)));

    // L1e : aucun sous-agent, aucune délégation comptée malgré le plafond à 0.
    assert.equal(h.fake.emitted.slice(sinceEvents).some((w) => w.payload.type === "session.created"), false, "aucun sous-agent lancé");
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []]);
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("Avancé : « once » relayé une seule fois (garde L1d, registre) ; l'enfant accordé n'est pas compté par L1e, sa délégation lancée sans demande l'est ; « once » répété refusé ; P6", async (t) => {
    // Plafond à 1 : la garde (L1d) accepte la première délégation de la demande ; L1e arrêterait tout à la 2e délégation comptée.
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" }, budget: { delegation: { maxPerRequest: 1 } } } });
    const root = await trackedRoot(h, "Avancé, demander");
    // L'enfant accordé délègue à son tour, sans demande (agent `task: allow`) : cette délégation-là compte pour la demande.
    h.fake.script(root.id, {
      tools: [askedTask("Analyse accordée", { text: undefined, turn: { tools: [allowTask("Sous-analyse")], followUp: { text: "Sous-analyse faite." } } })],
      followUp: { text: FIN },
    });
    await sendThroughProxy(h, root.id, "Délègue.");
    const [ask] = await pending(h, root.id, 1);
    assert.ok(ask);
    await until(() => waitRow(h, ask.id));
    await queueIdle(h.cockpit.gate);
    assert.deepEqual(repliesTo(h, ask.id), [], "aucun refus Simple en Avancé");

    const accepted = await once(h, ask.id);
    assert.equal(accepted.status, 200, accepted.body);
    const again = await once(h, ask.id);
    assert.equal(again.status, 409, again.body);
    assert.deepEqual(repliesTo(h, ask.id), [{ reply: "once" }], "exactement une réponse");
    assert.equal(h.cockpit.gate.emitted.has(ask.id), true);

    await until(() => h.sessions.descendants(root.id).length === 2 && lastText(h, root.id) === FIN, 5_000);
    await settledTree(h, root.id);
    // Une seule délégation comptée par L1e (celle de l'enfant) : sous le plafond de 1, aucun arrêt.
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []], "délégation accordée non comptée");
    // Attente close « once » ; jamais attribuée au cockpit (l'auteur « vous » d'une réponse relayée n'est pas encore écrit : constat
    // du train it1 V3, remis à la relecture).
    const row = waitRow(h, ask.id);
    assert.equal(row?.reply, "once");
    assert.notEqual(row?.replied_by, "cockpit");
    h.assertNoGlobalRestart();
  });
});

describe("croisements it1 V3 : sessions de contrôle et plafonds de délégation", () => {
  it("6 sessions de contrôle sous la conversation : ni la garde du « once » (L1d) ni la surveillance (L1e) ne les comptent ; témoin : 2 délégations lancées sans demande dépassent le plafond de 1", async (t) => {
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" }, budget: { delegation: { maxPerRequest: 1 } } } });
    const root = await trackedRoot(h, "Contrôles");
    h.fake.script(root.id, { tools: [askedTask("Seule délégation")], followUp: { text: FIN } });
    await sendThroughProxy(h, root.id, "Une délégation.");
    const [ask] = await pending(h, root.id, 1);
    assert.ok(ask);
    for (let i = 1; i <= 6; i++) {
      const control = await h.deps.client.request<FakeSession>("POST", "/session", {
        body: { parentID: root.id, title: "Contrôle de sécurité", metadata: { cockpit: "controle", demande: `d${i}` } },
      });
      await until(() => h.sessions.get(control.id)?.purpose === "controle");
    }
    // L1d : les contrôles ne sont pas des délégations lancées ; le plafond de 1 laisse passer la première.
    const accepted = await once(h, ask.id);
    assert.equal(accepted.status, 200, accepted.body);
    assert.deepEqual(repliesTo(h, ask.id), [{ reply: "once" }]);
    await until(() => lastText(h, root.id) === FIN, 5_000);
    await settledTree(h, root.id);
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []], "6 contrôles jamais comptés");

    // Témoin (module réel bien installé) : demande suivante, 2 délégations lancées sans demande → plafond « nombre », arrêt.
    h.fake.script(root.id, { tools: [allowTask("Un", { workMs: 60_000 }), allowTask("Deux", { workMs: 60_000 })] });
    await sendThroughProxy(h, root.id, "Deux délégations.");
    const stopped = await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
    assert.deepEqual(stopped, { rootId: root.id, cause: "plafond-delegations", unconfirmed: [] });
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "nombre" }]);
    await settledTree(h, root.id);
    h.assertNoGlobalRestart();
  });
});

describe("croisements it1 V3 : Plan d'abord sur le câblage complet", () => {
  const createPlan = (h: CockpitHarness, body: unknown) => h.call("POST", "/api/plans", { headers: h.headers.mutating, body });
  const execute = (h: CockpitHarness, planId: string, body: unknown, headers: Record<string, string>) =>
    h.call("POST", `/api/plans/${planId}/execution`, { headers, body });
  const creations = (h: CockpitHarness) => h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session").length;
  const view = async (h: CockpitHarness, rootId: string) => {
    const res = await h.call("GET", `/api/conversations/${rootId}/autonomie`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    return res.json<ConversationAutonomyView>();
  };
  /** Réponse du plan, envoyée par le proxy (crochets d'envoi du plancher et des plans) et terminée. */
  async function answer(h: CockpitHarness, planId: string, text: string): Promise<void> {
    h.fake.script(planId, { text });
    await sendThroughProxy(h, planId, "Prépare un plan.");
    await within(h.fake.settled(planId), "réponse du plan terminée");
  }

  it("conversation d'origine enregistrée ; exécution « modifications » ou « autonome » : 428 sans en-tête, 409 « a-venir » avec (porte I1), aucune racine ; « demander » : nouvelle racine liée au plan", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    assert.equal(h.cockpit.c11.activationOuverte, false);
    const origin = await trackedRoot(h, "Origine du plan");
    const created = await createPlan(h, { directory: h.fake.directory, source: origin.id });
    assert.equal(created.status, 200, created.body);
    const planId = created.json<PlanCreateResponse>().rootId;
    const planView = await view(h, planId);
    assert.deepEqual([planView.choix, planView.planSourceId], ["plan", origin.id], "choix « plan » permanent, conversation d'origine");
    await answer(h, planId, "1. Lire a.txt.");

    const before = creations(h);
    const choiceEventsBefore = eventsOf(h, "autonomie.choix").length;
    for (const choix of ["modifications", "autonome"]) {
      const bare = await execute(h, planId, { choix }, h.headers.mutating);
      assert.equal(bare.status, 428, `${choix} : ${bare.body}`);
      assert.equal(bare.json<{ error: string }>().error, "confirmation-requise");
      const confirmed = await execute(h, planId, { choix }, h.headers.confirmed);
      assert.equal(confirmed.status, 409, `${choix} : ${confirmed.body}`);
      const body = confirmed.json<{ error: string; raison: string }>();
      assert.deepEqual([body.error, body.raison], ["autonomie-indisponible", "a-venir"], choix);
    }
    assert.equal(creations(h), before, "aucune racine créée");
    assert.equal(eventsOf(h, "autonomie.choix").length, choiceEventsBefore, "aucun choix annoncé");

    const ask = await execute(h, planId, { choix: "demander" }, h.headers.mutating);
    assert.equal(ask.status, 200, ask.body);
    const execution = ask.json<PlanExecutionResponse>();
    assert.equal(creations(h), before + 1);
    const executionView = await view(h, execution.rootId);
    assert.deepEqual([executionView.choix, executionView.executionDePlanId], ["demander", planId]);
    assert.equal(execution.brouillon, "Exécute le plan suivant.\n\n1. Lire a.txt.");
    assert.equal((await view(h, planId)).choix, "plan", "le plan reste un plan");
    h.assertNoGlobalRestart();
  });

  it("COCKPIT_AUTONOMY=off : POST /api/plans et exécution « demander » → 200 ; « modifications » et « autonome » → 403, aucune racine", async (t) => {
    const h = await startCockpit(t, { modules: "tous", env: { autonomy: false } });
    const created = await createPlan(h, { directory: h.fake.directory });
    assert.equal(created.status, 200, created.body);
    const planId = created.json<PlanCreateResponse>().rootId;
    await answer(h, planId, "Plan.");
    const ask = await execute(h, planId, { choix: "demander" }, h.headers.mutating);
    assert.equal(ask.status, 200, ask.body);
    const before = creations(h);
    for (const [choix, headers] of [
      ["autonome", h.headers.confirmed],
      ["modifications", h.headers.confirmed],
      ["autonome", h.headers.mutating],
    ] as const) {
      const res = await execute(h, planId, { choix }, headers);
      assert.equal(res.status, 403, `${choix} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "autonomie-coupee");
    }
    assert.equal(creations(h), before, "aucune racine créée");
    h.assertNoGlobalRestart();
  });
});

describe("croisements it1 V3 : interfaces entre paquets web", () => {
  const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

  it("ActivityRegion (L5b) rend la bande néon (L5c) avec le dossier de la conversation (relecture des textes du zoom 3)", () => {
    const source = read("../web/pages/chat/activity/ActivityRegion.tsx");
    // Entrée [Voir une démonstration] (L5d) permise après le dossier ; son câblage est vérifié dans demo-p1.test.ts.
    assert.match(source, /<NeonBand\s+rootId=\{rootId\}\s+facts=\{[^}]+\}\s+advanced=\{advanced\}\s+directory=\{directory\}(?:\s+onDemonstration=\{\w+\})?\s*\/>/);
    assert.match(read("../web/pages/chat/activity/NeonBand.tsx"), /oc\.messages\(sessionId, directory\)/);
  });

  it("« Actions maximum » (L5t, D1) : le message de validation du Studio ne dit plus « étapes »", () => {
    const issues = validateDraft("agents", { name: "analyste", frontmatter: { description: "Analyse.", steps: 0 }, body: "Analyse." });
    assert.deepEqual(
      issues.filter((i) => i.message === "Nombre entier entre 1 et 10 000."),
      [{ path: "actions maximum", message: "Nombre entier entre 1 et 10 000." }],
    );
  });
});
