// Tests du choix d'autonomie par conversation (L6a ; spécification §3.9, §4.1, §4.2, §4.9, §4.11, §4.13, D10, D13 ; plan
// d'exécution, fiche L6a). Harnais à modules déclarés (plan §2.2) : `modules: ["conversationAutonomy"]`, les autres ports restent
// neutres ; l'activation est ouverte par surcharge de port (porte I1 fermée en production), les faits sont lus par un espion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ActivationInput, ActivationPort, ActivationVerdict, FactsPort } from "./contracts-11.ts";
import { ConversationAutonomyStore, returnToAsk } from "./conversation-autonomy.ts";
import { openMemoryDb } from "./db.ts";
import type { OcSession } from "./opencode.ts";
import type { SessionRow } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { descriptionChoix, libelleChoix, raisonIndisponible, TEXTES } from "./shared/autonomy-choice-texts.ts";
import type { ActivationRefusalCode, AutonomyChoice, ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { until, within } from "./test-support/helpers.ts";

// --- Doublures ------------------------------------------------------------------------------------------------------------------

/** Port activation scriptable : verdict réglable, et une vérification retenue à la demande (courses). */
class ScriptedActivation implements ActivationPort {
  readonly calls: ActivationInput[] = [];
  verdict: ActivationVerdict = { ok: true };
  #hold: { choix: ActivationInput["choix"]; entered: () => void; gate: Promise<void> } | null = null;

  /** La prochaine vérification de `choix` attend release() ; `waiting` est tenue quand elle attend. */
  holdNext(choix: ActivationInput["choix"]): { waiting: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    this.#hold = { choix, entered: entered.resolve, gate: gate.promise };
    return { waiting: entered.promise, release: gate.resolve };
  }

  async check(input: ActivationInput): Promise<ActivationVerdict> {
    this.calls.push(input);
    const hold = this.#hold;
    if (hold && hold.choix === input.choix) {
      this.#hold = null;
      hold.entered();
      await hold.gate;
    }
    return this.verdict;
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

const url = (rootId: string) => `/api/conversations/${rootId}/autonomie`;

async function start(t: Parameters<typeof startCockpit>[0], options: Parameters<typeof startCockpit>[1] = {}) {
  const activation = new ScriptedActivation();
  const facts = spyFacts();
  const h = await startCockpit(t, { modules: ["conversationAutonomy"], ...options, ports: { activation, facts, ...options.ports } });
  return { h, activation, facts, port: h.cockpit.c11.ports.conversationAutonomy, store: new ConversationAutonomyStore(h.db) };
}

/** Conversation créée par le proxy, suivie par le cockpit. */
async function conversation(h: CockpitHarness, title = "Autonomie"): Promise<SessionRow> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const { id } = created.json<{ id: string }>();
  return until(() => h.sessions.get(id));
}

/** Session créée directement dans opencode (enfant, session interne), suivie par le processeur. */
async function ocSession(h: CockpitHarness, body: Record<string, unknown>, directory?: string): Promise<SessionRow> {
  const info = await h.deps.client.request<OcSession>("POST", "/session", { body, ...(directory ? { directory } : {}) });
  return until(() => h.sessions.get(info.id));
}

const putChoice = (h: CockpitHarness, rootId: string, body: unknown, headers: Record<string, string> = h.headers.mutating) =>
  h.call("PUT", url(rootId), { headers, body });

const choiceEvents = (h: CockpitHarness) => h.cockpitEvents().filter((e) => e.type === "autonomie.choix").map((e) => e.data);

const choiceFacts = (facts: readonly ActivityFact[]) => facts.map((f) => ({ rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: f.data }));

/** Ligne posée avant ce démarrage du cockpit (heure passée) : un choix d'un démarrage précédent. */
function previousBoot(h: CockpitHarness, rootId: string, choix: string, retourCause: string | null = null) {
  h.db
    .prepare("INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause) VALUES (?, ?, '{}', ?, ?)")
    .run(rootId, choix, Date.now() - 60_000, retourCause);
}

const ALL_CODES: Readonly<Record<ActivationRefusalCode, true>> = {
  "a-venir": true,
  "autonomie-coupee": true,
  "regle-allow": true,
  "mcp-ou-extension": true,
  "profil-sans-confirmation": true,
  "plancher-non-verifie": true,
  "racine-de-plan": true,
  "nouvelle-conversation": true,
};

// --- Tests ----------------------------------------------------------------------------------------------------------------------

describe("choix d'autonomie : racines seulement", () => {
  it("GET d'une racine : « demander » par défaut, plafonds des réglages, choix disponibles avec leur raison ; module inscrit", async (t) => {
    const { h, port } = await start(t, { ports: { activation: { check: async () => ({ ok: false, raison: "a-venir" }) } } });
    assert.deepEqual(h.cockpit.wiring.registrations, [
      { kind: "startup", key: "startup", module: "conversationAutonomy" },
      { kind: "routes", key: "autonomy", module: "conversationAutonomy" },
    ]);
    const root = await conversation(h);
    const res = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const caps = h.settings.get().budget.autonomie;
    assert.deepEqual(res.json(), {
      rootId: root.id,
      choix: "demander",
      plafonds: {
        plafondUsd: caps.plafondUsd,
        actionsMax: caps.actionsMax,
        delegationsMax: caps.delegationsMax,
        dureeMinutes: caps.dureeMinutes,
        fichiersMax: caps.fichiersMax,
        controlesIaMax: caps.controlesIaMax,
      },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: true,
      disponibles: [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: "a-venir" },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: "a-venir" },
      ],
      demande: null,
    } satisfies ConversationAutonomyView);
    assert.equal(port.choiceOf(root.id), "demander");
    h.assertNoGlobalRestart();
  });

  it("identifiant d'enfant, session interne, conversation supprimée, autre instance, racine inconnue : 404 ; le choix d'un enfant est celui de sa racine", async (t) => {
    const { h, port, store } = await start(t);
    const root = await conversation(h);
    const child = await ocSession(h, { parentID: root.id, title: "Enfant" }, root.directory);
    assert.equal(child.root_id, root.id);
    const classifier = await ocSession(h, { title: "[cockpit] Classement" });
    const controle = await ocSession(h, { title: "Contrôle", metadata: { cockpit: "controle" } });
    const deleted = await conversation(h, "Supprimée");
    h.sessions.markDeleted(deleted.id);
    const omo = await conversation(h, "Salle");
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(omo.id);

    for (const id of [child.id, classifier.id, controle.id, deleted.id, omo.id, "ses_inconnue"]) {
      const got = await h.call("GET", url(id), { headers: h.headers.authed });
      assert.equal(got.status, 404, `${id} : ${got.body}`);
      assert.deepEqual(got.json(), { error: "not-found", message: TEXTES.partout.erreurs.inconnue });
      const put = await putChoice(h, id, { choix: "autonome" }, h.headers.confirmed);
      assert.equal(put.status, 404, `${id} : ${put.body}`);
      assert.equal(store.read(id), null);
    }

    const set = await putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(set.status, 200, set.body);
    // Une demande d'enfant porte l'identifiant de l'enfant (§4.1) : la racine décide.
    assert.equal(port.choiceOf(child.id), "autonome");
    assert.equal(port.choiceOf(root.id), "autonome");
    assert.equal(port.choiceOf("ses_inconnue"), "demander");
    assert.equal(port.choiceOf("pas un identifiant"), "demander");
  });

  it("identifiants refusés (400) sur GET et PUT, avant toute lecture ; anti-CSRF et authentification des gardes globales", async (t) => {
    const { h, store } = await start(t);
    const root = await conversation(h);
    for (const id of ["ses.x", "ses%20x", "ses%2F..%2Fx", "s".repeat(129)]) {
      const got = await h.call("GET", url(id), { headers: h.headers.authed });
      assert.equal(got.status, 400, `${id} : ${got.body}`);
      assert.deepEqual(got.json(), { error: "invalid", message: TEXTES.partout.erreurs.identifiant });
      const put = await putChoice(h, id, { choix: "demander" });
      assert.equal(put.status, 400, `${id} : ${put.body}`);
      assert.deepEqual(put.json(), { error: "invalid", message: TEXTES.partout.erreurs.identifiant });
    }
    const anonymous = await h.call("GET", url(root.id));
    assert.equal(anonymous.status, 401, anonymous.body);
    const noCsrf = await putChoice(h, root.id, { choix: "autonome" }, { ...h.headers.authed, "x-cockpit-confirm": "1" });
    assert.equal(noCsrf.status, 403, noCsrf.body);
    assert.equal(noCsrf.json<{ error: string }>().error, "csrf");
    const foreign = await putChoice(h, root.id, { choix: "autonome" }, { ...h.headers.confirmed, origin: "http://ailleurs.test" });
    assert.equal(foreign.status, 403, foreign.body);
    assert.equal(foreign.json<{ error: string }>().error, "csrf");
    assert.equal(store.read(root.id), null);
    assert.deepEqual(choiceEvents(h), []);
  });

  it("corps refusés (400) : JSON illisible, choix inconnu (« omo » compris), champ en trop, plafond hors bornes ; corps trop long (413)", async (t) => {
    const { h, store, activation } = await start(t);
    const root = await conversation(h);
    const bodies: unknown[] = [
      "pas du json",
      { choix: "omo" },
      { choix: "tout" },
      {},
      { choix: "demander", plafondUsd: 1 },
      { choix: "autonome", plafonds: { plafondUsd: 5.01 } },
      { choix: "autonome", plafonds: { plafondMaxUsd: 50 } },
      { choix: "autonome", plafonds: { actionsMax: 0 } },
      { choix: "autonome", plafonds: { inconnu: 1 } },
    ];
    for (const body of bodies) {
      const res = await putChoice(h, root.id, body, h.headers.confirmed);
      assert.equal(res.status, 400, `${JSON.stringify(body)} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "invalid", message: TEXTES.partout.erreurs.requete });
    }
    const long = await putChoice(h, root.id, { choix: "demander", bourrage: "x".repeat(5_000) }, h.headers.confirmed);
    assert.equal(long.status, 413, long.body);
    assert.deepEqual(long.json(), { error: "invalid", message: TEXTES.partout.erreurs.tropLong });
    assert.equal(store.read(root.id), null);
    assert.equal(activation.calls.length, 0);
    assert.deepEqual(choiceEvents(h), []);
  });
});

describe("choix d'autonomie : « Plan d'abord »", () => {
  it("jamais posé par PUT (409 nouvelle-conversation) ; racine de plan : « plan » permanent, autres choix refusés (409 racine-de-plan)", async (t) => {
    const { h, port, store } = await start(t);
    const root = await conversation(h);
    const refused = await putChoice(h, root.id, { choix: "plan" }, h.headers.confirmed);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), {
      error: "autonomie-indisponible",
      message: TEXTES.partout.raisons["nouvelle-conversation"],
      raison: "nouvelle-conversation",
    });
    assert.equal(store.read(root.id), null);

    // Posé par les plans (L6b) sur une nouvelle racine.
    const plan = await conversation(h, "Plan");
    store.setPlan(plan.id, root.id, Date.now());
    const child = await ocSession(h, { parentID: plan.id, title: "Délégué" }, plan.directory);
    const got = await h.call("GET", url(plan.id), { headers: h.headers.authed });
    assert.equal(got.status, 200, got.body);
    const view = got.json<ConversationAutonomyView>();
    assert.equal(view.choix, "plan");
    assert.equal(view.planSourceId, root.id);
    assert.deepEqual(view.disponibles, [
      { choix: "demander", disponible: false, raison: "racine-de-plan" },
      { choix: "modifications", disponible: false, raison: "racine-de-plan" },
      { choix: "plan", disponible: true, raison: null },
      { choix: "autonome", disponible: false, raison: "racine-de-plan" },
    ]);
    for (const body of [{ choix: "demander" }, { choix: "autonome" }, { choix: "plan", plafonds: { plafondUsd: 2 } }]) {
      const res = await putChoice(h, plan.id, body, h.headers.confirmed);
      assert.equal(res.status, 409, `${JSON.stringify(body)} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: TEXTES.partout.raisons["racine-de-plan"], raison: "racine-de-plan" });
    }
    const same = await putChoice(h, plan.id, { choix: "plan" });
    assert.equal(same.status, 200, same.body);
    assert.equal(same.json<ConversationAutonomyView>().choix, "plan");
    assert.equal(port.choiceOf(child.id), "plan");

    // Racine d'exécution d'un plan : le lien est posé, le choix en vigueur est gardé.
    const execution = await conversation(h, "Exécution");
    assert.equal((await putChoice(h, execution.id, { choix: "modifications" }, h.headers.confirmed)).status, 200);
    store.setExecutionDePlan(execution.id, plan.id, Date.now());
    assert.equal(store.read(execution.id)?.choix, "modifications");
    assert.equal(store.read(execution.id)?.executionDePlanId, plan.id);
    const fresh = await conversation(h, "Exécution neuve");
    store.setExecutionDePlan(fresh.id, plan.id, Date.now());
    assert.equal(store.read(fresh.id)?.choix, "demander");

    // Le démarrage ne touche pas une racine de plan.
    await h.cockpit.startup();
    assert.equal(store.read(plan.id)?.choix, "plan");
  });
});

describe("choix d'autonomie : relâcher, resserrer", () => {
  it("relâcher sans x-cockpit-confirm : 428, rien d'écrit ni de vérifié ; confirmé : port activation, 200, événement et fait « choix »", async (t) => {
    const { h, port, store, activation, facts } = await start(t);
    const root = await conversation(h);
    for (const choix of ["modifications", "autonome"]) {
      const res = await putChoice(h, root.id, { choix });
      assert.equal(res.status, 428, res.body);
      assert.deepEqual(res.json(), { error: "confirmation-requise", message: TEXTES.partout.erreurs.confirmation });
    }
    assert.equal(store.read(root.id), null);
    assert.equal(activation.calls.length, 0, "aucune vérification avant la confirmation");
    assert.deepEqual(choiceEvents(h), []);

    const ok = await putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(ok.status, 200, ok.body);
    const view = ok.json<ConversationAutonomyView>();
    assert.equal(view.choix, "autonome");
    assert.equal(view.retourCause, null);
    assert.ok(typeof view.depuis === "number");
    assert.deepEqual(activation.calls[0], { rootId: root.id, choix: "autonome", agent: root.agent, directory: root.directory });
    assert.equal(port.choiceOf(root.id), "autonome");
    assert.deepEqual(choiceEvents(h), [{ rootId: root.id, choix: "autonome", cause: "clic" }]);
    assert.deepEqual(choiceFacts(facts.appended), [{ rootId: root.id, sessionId: root.id, kind: "choix", ref: null, data: { choix: "autonome", cause: "clic" } }]);
    assert.ok(facts.appended.every((f) => Number.isSafeInteger(f.at)));

    // Plafond relevé sur un choix automatique : relâcher (428) ; plafond abaissé : resserrer, immédiat.
    const raised = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 2 } });
    assert.equal(raised.status, 428, raised.body);
    const lowered = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 0.5, actionsMax: 10 } });
    assert.equal(lowered.status, 200, lowered.body);
    assert.deepEqual(
      { usd: lowered.json<ConversationAutonomyView>().plafonds.plafondUsd, actions: lowered.json<ConversationAutonomyView>().plafonds.actionsMax },
      { usd: 0.5, actions: 10 },
    );
    // Même choix : aucun nouvel événement ni fait.
    assert.equal(choiceEvents(h).length, 1);
    assert.equal(facts.appended.length, 1);
    const confirmedRaise = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 3 } }, h.headers.confirmed);
    assert.equal(confirmedRaise.status, 200, confirmedRaise.body);
    assert.equal(confirmedRaise.json<ConversationAutonomyView>().plafonds.plafondUsd, 3);
    h.assertNoGlobalRestart();
  });

  it("resserrer est immédiat, sans confirmation ni activation, même quand l'activation refuserait désormais ; SSE et fait à chaque changement", async (t) => {
    const { h, port, activation, facts } = await start(t);
    const root = await conversation(h);
    assert.equal((await putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed)).status, 200);
    // L'assistant agit désormais sans demander : relâcher serait refusé, resserrer ne l'est jamais.
    activation.verdict = { ok: false, raison: "regle-allow" };

    const modifications = await putChoice(h, root.id, { choix: "modifications" });
    assert.equal(modifications.status, 200, modifications.body);
    assert.equal(modifications.json<ConversationAutonomyView>().choix, "modifications");
    assert.deepEqual(modifications.json<ConversationAutonomyView>().disponibles[1], { choix: "modifications", disponible: false, raison: "regle-allow" });
    assert.equal(port.choiceOf(root.id), "modifications", "écrit dès la réponse");

    const demander = await putChoice(h, root.id, { choix: "demander" });
    assert.equal(demander.status, 200, demander.body);
    assert.equal(port.choiceOf(root.id), "demander");
    const again = await putChoice(h, root.id, { choix: "demander" });
    assert.equal(again.status, 200, again.body);

    const refused = await putChoice(h, root.id, { choix: "modifications" }, h.headers.confirmed);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "autonomie-indisponible", message: raisonIndisponible("regle-allow"), raison: "regle-allow" });
    assert.equal(port.choiceOf(root.id), "demander");

    const expected = [
      { rootId: root.id, choix: "autonome", cause: "clic" },
      { rootId: root.id, choix: "modifications", cause: "clic" },
      { rootId: root.id, choix: "demander", cause: "clic" },
    ];
    assert.deepEqual(choiceEvents(h), expected);
    assert.deepEqual(
      facts.appended.map((f) => ({ rootId: f.rootId, kind: f.kind, data: f.data })),
      expected.map(({ rootId, choix, cause }) => ({ rootId, kind: "choix", data: { choix, cause } })),
    );
  });

  it("un choix arrivé pendant la vérification d'un relâchement l'emporte : resserrement (génération) ou retour à « demander » par un autre module", async (t) => {
    const { h, port, activation } = await start(t);
    const root = await conversation(h);

    const first = activation.holdNext("autonome");
    const loosening = putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    await within(first.waiting, "vérification du relâchement");
    const tighten = await putChoice(h, root.id, { choix: "demander" });
    assert.equal(tighten.status, 200, tighten.body);
    first.release();
    const late = await loosening;
    assert.equal(late.status, 409, late.body);
    assert.deepEqual(late.json(), { error: "autonomie-indisponible", message: TEXTES.partout.erreurs.remplace });
    assert.equal(port.choiceOf(root.id), "demander");
    assert.deepEqual(choiceEvents(h), []);

    // Écriture de la ligne pendant la vérification (plafond, activation : returnToAsk) : le relâchement n'est pas appliqué.
    assert.equal((await putChoice(h, root.id, { choix: "modifications" }, h.headers.confirmed)).status, 200);
    const second = activation.holdNext("autonome");
    const pending = putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    await within(second.waiting, "seconde vérification");
    assert.deepEqual(returnToAsk(h.cockpit.c11, "plafond-actions", { rootId: root.id }), [root.id]);
    second.release();
    const replaced = await pending;
    assert.equal(replaced.status, 409, replaced.body);
    assert.equal(port.choiceOf(root.id), "demander");
    const view = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(view.json<ConversationAutonomyView>().retourCause, "plafond-actions");
    assert.deepEqual(choiceEvents(h).at(-1), { rootId: root.id, choix: "demander", cause: "plafond-actions" });

    // Deux relâchements concurrents : le dernier envoyé l'emporte.
    const third = activation.holdNext("autonome");
    const older = putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    await within(third.waiting, "troisième vérification");
    const newer = await putChoice(h, root.id, { choix: "modifications" }, h.headers.confirmed);
    assert.equal(newer.status, 200, newer.body);
    third.release();
    assert.equal((await older).status, 409);
    assert.equal(port.choiceOf(root.id), "modifications");
  });

  it("activation fermée (port du module activation, porte I1) : 409 « a-venir » avec la phrase du contrat ; rien d'écrit", async (t) => {
    const h = await startCockpit(t, { modules: ["conversationAutonomy", "activation"] });
    const root = await conversation(h);
    const store = new ConversationAutonomyStore(h.db);
    for (const choix of ["modifications", "autonome"]) {
      const res = await putChoice(h, root.id, { choix }, h.headers.confirmed);
      assert.equal(res.status, 409, res.body);
      assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: "Pas encore disponible dans cette version du cockpit.", raison: "a-venir" });
    }
    assert.equal(store.read(root.id), null);
    const got = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.deepEqual(
      got.json<ConversationAutonomyView>().disponibles.map((d) => d.raison),
      [null, "a-venir", "nouvelle-conversation", "a-venir"],
    );
    h.assertNoGlobalRestart();
  });

  it("plafonds en vigueur : jamais au-delà de plafondMaxUsd, même abaissé après coup", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    assert.equal((await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 4 } }, h.headers.confirmed)).status, 200);
    h.settings.update({ budget: { autonomie: { plafondMaxUsd: 3 } } });
    const got = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(got.json<ConversationAutonomyView>().plafonds.plafondUsd, 3);
    const over = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 3.5 } }, h.headers.confirmed);
    assert.equal(over.status, 400, over.body);
  });
});

describe("choix d'autonomie : COCKPIT_AUTONOMY=off", () => {
  it("PUT demander → 200 ; modifications et autonome → 403 autonomie-coupee, même confirmés et activation permise ; disponibles coupés", async (t) => {
    const { h, port, store, activation } = await start(t, { env: { autonomy: false } });
    const root = await conversation(h);
    const ask = await putChoice(h, root.id, { choix: "demander", plafonds: { actionsMax: 30 } });
    assert.equal(ask.status, 200, ask.body);
    for (const choix of ["modifications", "autonome"]) {
      for (const headers of [h.headers.mutating, h.headers.confirmed]) {
        const res = await putChoice(h, root.id, { choix }, headers);
        assert.equal(res.status, 403, res.body);
        assert.deepEqual(res.json(), { error: "autonomie-coupee", message: TEXTES.partout.raisons["autonomie-coupee"], raison: "autonomie-coupee" });
      }
    }
    const got = await h.call("GET", url(root.id), { headers: h.headers.authed });
    const view = got.json<ConversationAutonomyView>();
    assert.equal(view.interrupteur, false);
    assert.equal(view.choix, "demander");
    assert.deepEqual(view.disponibles.map((d) => [d.choix, d.disponible, d.raison]), [
      ["demander", true, null],
      ["modifications", false, "autonomie-coupee"],
      ["plan", false, "nouvelle-conversation"],
      ["autonome", false, "autonomie-coupee"],
    ]);
    assert.equal(activation.calls.length, 0, "le port activation n'est jamais consulté");
    assert.equal(store.read(root.id)?.choix, "demander");
    // Un choix automatique d'avant le redémarrage (interrupteur alors ouvert) ne s'applique pas.
    const older = await conversation(h, "Ancienne");
    previousBoot(h, older.id, "autonome");
    assert.equal(port.choiceOf(older.id), "demander");
  });
});

describe("choix d'autonomie : retour à « Demander » au démarrage du cockpit", () => {
  it("choix automatiques d'un démarrage précédent : lus « demander » avant l'étape de démarrage, remis à « demander » par elle avec événement et fait", async (t) => {
    const { h, port, store, facts } = await start(t);
    const autonome = await conversation(h, "Autonome d'avant");
    const modifications = await conversation(h, "Modifications d'avant");
    const plan = await conversation(h, "Plan d'avant");
    const ask = await conversation(h, "Demander d'avant");
    const settled = await conversation(h, "Remis par un clic");
    const recent = await conversation(h, "Choisi après le démarrage");
    previousBoot(h, autonome.id, "autonome");
    previousBoot(h, modifications.id, "modifications");
    previousBoot(h, plan.id, "plan");
    previousBoot(h, ask.id, "demander", "plafond-cout");
    previousBoot(h, settled.id, "autonome");
    assert.equal((await putChoice(h, recent.id, { choix: "autonome" }, h.headers.confirmed)).status, 200);
    const baseEvents = choiceEvents(h).length;
    const baseFacts = facts.appended.length;

    // Avant l'étape de démarrage (main.ts attend opencode) : rien ne s'applique, la vue le dit.
    assert.equal(port.choiceOf(autonome.id), "demander");
    assert.equal(port.choiceOf(modifications.id), "demander");
    assert.equal(port.choiceOf(plan.id), "plan");
    const early = (await h.call("GET", url(autonome.id), { headers: h.headers.authed })).json<ConversationAutonomyView>();
    assert.deepEqual([early.choix, early.retourCause], ["demander", "redemarrage-cockpit"]);
    assert.equal(store.read(autonome.id)?.choix, "autonome", "aucune écriture par une lecture");

    // Un PUT sur une ligne périmée la remet d'abord à « demander » (fait redemarrage-cockpit), sans fait « clic » en double.
    const click = await putChoice(h, settled.id, { choix: "demander" });
    assert.equal(click.status, 200, click.body);
    assert.deepEqual(choiceEvents(h).slice(baseEvents), [{ rootId: settled.id, choix: "demander", cause: "redemarrage-cockpit" }]);

    await h.cockpit.startup();
    const reset = [autonome.id, modifications.id].sort();
    for (const id of reset) {
      const row = store.read(id);
      assert.deepEqual([row?.choix, row?.retourCause], ["demander", "redemarrage-cockpit"], id);
    }
    assert.equal(store.read(plan.id)?.choix, "plan");
    assert.deepEqual([store.read(ask.id)?.choix, store.read(ask.id)?.retourCause], ["demander", "plafond-cout"]);
    assert.equal(store.read(recent.id)?.choix, "autonome", "choix posé après ce démarrage : gardé");
    assert.equal(port.choiceOf(recent.id), "autonome");
    const startupEvents = choiceEvents(h).slice(baseEvents + 1);
    assert.deepEqual(startupEvents, reset.map((rootId) => ({ rootId, choix: "demander", cause: "redemarrage-cockpit" })));
    assert.deepEqual(
      choiceFacts(facts.appended.slice(baseFacts)),
      [settled.id, ...reset].map((rootId) => ({ rootId, sessionId: rootId, kind: "choix", ref: null, data: { choix: "demander", cause: "redemarrage-cockpit" } })),
    );
    const after = (await h.call("GET", url(autonome.id), { headers: h.headers.authed })).json<ConversationAutonomyView>();
    assert.deepEqual([after.choix, after.retourCause], ["demander", "redemarrage-cockpit"]);

    // Idempotent : un second démarrage n'annonce rien.
    const count = choiceEvents(h).length;
    await h.cockpit.startup();
    assert.equal(choiceEvents(h).length, count);
    h.assertNoGlobalRestart();
  });
});

describe("choix d'autonomie : magasin", () => {
  it("lecture prudente : choix inconnu → « demander », plafonds illisibles ignorés, cause inconnue → null ; resetAutomatic borné par heure et racine", () => {
    const db = openMemoryDb();
    try {
      const store = new ConversationAutonomyStore(db);
      const insert = db.prepare("INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause) VALUES (?, ?, ?, ?, ?)");
      insert.run("ses_omo", "omo", "{pas du json", 10, "inventee");
      insert.run("ses_caps", "autonome", JSON.stringify({ plafondUsd: 2, inconnu: 1 }), 10, null);
      insert.run("ses_ok", "modifications", JSON.stringify({ actionsMax: 12 }), 20, "clic");
      insert.run("ses_new", "autonome", "{}", 40, null);
      assert.deepEqual(store.read("ses_omo"), {
        rootId: "ses_omo",
        choix: "demander",
        plafonds: {},
        depuis: 10,
        retourCause: null,
        planSourceId: null,
        executionDePlanId: null,
      });
      assert.deepEqual(store.read("ses_caps")?.plafonds, {}, "clé inconnue : plafonds entiers ignorés");
      assert.deepEqual(store.read("ses_ok")?.plafonds, { actionsMax: 12 });
      assert.equal(store.read("ses_absente"), null);

      assert.deepEqual(store.resetAutomatic({ before: 30, depuis: 50, cause: "plafond-duree", rootId: "ses_ok" }), ["ses_ok"]);
      assert.deepEqual(store.resetAutomatic({ before: 30, depuis: 60, cause: "redemarrage-cockpit" }), ["ses_caps"]);
      assert.deepEqual(store.resetAutomatic({ before: 30, depuis: 70, cause: "redemarrage-cockpit" }), []);
      assert.deepEqual([store.read("ses_ok")?.choix, store.read("ses_ok")?.retourCause, store.read("ses_ok")?.depuis], ["demander", "plafond-duree", 50]);
      assert.equal(store.read("ses_new")?.choix, "autonome");
      assert.equal(db.prepare("SELECT choix FROM conversation_autonomy WHERE root_id = 'ses_omo'").get()?.choix, "omo", "valeur étrangère non réécrite");
    } finally {
      db.close();
    }
  });
});

describe("textes des choix d'autonomie", () => {
  it("nom du sélecteur et libellés (§2.1), descriptions exactes (§4.13), « Plan d'abord (nouvelle conversation) » (§4.9)", () => {
    assert.equal(TEXTES.partout.selecteur, "Autonomie");
    const choices: AutonomyChoice[] = ["demander", "modifications", "plan", "autonome"];
    assert.deepEqual(
      choices.map((choix) => [libelleChoix(choix), descriptionChoix(choix)]),
      [
        ["Demander à chaque fois", "L'IA lit, puis vous demande avant chaque modification, commande, accès web ou travail délégué."],
        ["Modifications automatiques", "L'IA modifie les fichiers de ce dossier sans vous demander, sauf les fichiers protégés. Elle demande pour tout le reste."],
        ["Plan d'abord", "L'IA propose un plan dans une nouvelle conversation qui ne peut rien modifier."],
        [
          "Autonome avec contrôle",
          "L'IA enchaîne le travail. Le cockpit laisse passer les actions jugées sûres et vous demande pour tout le reste. Arrêt automatique aux plafonds.",
        ],
      ],
    );
    assert.equal(libelleChoix("plan", true), "Plan d'abord (nouvelle conversation)");
    assert.equal(libelleChoix("autonome", true), "Autonome avec contrôle");
  });

  it("raisons par code : « a-venir » = phrase du contrat, jamais « itération » ; chaque code a une phrase ; code sans phrase propre → phrase générique", () => {
    const contract = fs.readFileSync(path.join(import.meta.dirname, "shared", "autonomy-types.ts"), "utf8");
    const fixed = /-\s*a-venir\s*:[\s\S]*?phrase affichée[^«]*«\s*([^»]+?)\s*»/u.exec(contract)?.[1];
    assert.equal(fixed, "Pas encore disponible dans cette version du cockpit.");
    assert.equal(raisonIndisponible("a-venir"), fixed);
    for (const code of Object.keys(ALL_CODES) as ActivationRefusalCode[]) {
      const phrase = raisonIndisponible(code);
      assert.ok(phrase.length > 0, code);
      assert.doesNotMatch(phrase, /it[ée]rations?/iu, code);
    }
    for (const phrase of Object.values(TEXTES.partout.raisons)) assert.doesNotMatch(phrase, /it[ée]rations?/iu);
    assert.equal(raisonIndisponible("autonomie-coupee"), TEXTES.partout.raisons["autonomie-coupee"]);
    assert.equal(raisonIndisponible("nouvelle-conversation"), TEXTES.partout.raisons["nouvelle-conversation"]);
    assert.equal(raisonIndisponible("racine-de-plan"), TEXTES.partout.raisons["racine-de-plan"]);
    assert.equal(raisonIndisponible("regle-allow"), TEXTES.partout.raisons.autre);
    assert.equal(raisonIndisponible(null), TEXTES.partout.raisons.autre);
  });
});
