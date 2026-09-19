// Tests de la carte de plan (L6c ; spécification §4.9 points 4 à 6, §4.11 l.776, I7 ; plan d'exécution, fiche L6c).
// Le modèle pur (web/pages/chat/plan/plan-card.ts) porte la logique : affichage (rien, phrase d'honnêteté seule, carte),
// boutons indisponibles avec leur raison, effet d'un clic, suite d'une exécution refusée (428 → confirmation, puis appel avec
// l'en-tête ; 403 et 409 → la raison), réponse terminée (même critère que lastPlanText). Le parcours est rejoué avec le client du
// navigateur (web/lib/api-plans.ts, api-autonomy.ts, api.ts) branché sur le vrai cockpit (harnais, faux opencode) : mêmes appels
// que PlanCard.tsx. L'interface n'étant pas exécutée par `npm test`, le composant et sa feuille de style sont relus (contrat
// statique : aucun texte recopié, boutons focalisables décrits par leur raison, aucune animation, aucun raccourci).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { autonomyApi, autonomyError } from "../web/lib/api-autonomy.ts";
import { planApi } from "../web/lib/api-plans.ts";
import { errorText, oc } from "../web/lib/api.ts";
import {
  answerCompleted,
  buildPlanCard,
  choiceEventRoot,
  clickEffect,
  type ExecutionErrorInfo,
  type ExecutionFailure,
  executionFailure,
  isAutomaticAction,
  PLAN_CARD_ICONS,
  PLAN_CARD_ORDER,
  type PlanCardAction,
  type PlanCardButton,
  type PlanCardInput,
  type PlanCardModel,
  planAnswered,
} from "../web/pages/chat/plan/plan-card.ts";
import type { ActivationInput, ActivationPort, ActivationVerdict } from "./contracts-11.ts";
import { lastPlanText } from "./plans.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { raisonIndisponible, TEXTES as CHOIX } from "./shared/autonomy-choice-texts.ts";
import { CHOICE_ICONS } from "./shared/autonomy-menu.ts";
import { raisonRefus, TEXTES as AUTONOMIE } from "./shared/autonomy-texts.ts";
import type {
  ActivationRefusalCode,
  AutonomyCaps,
  AutonomyChoice,
  BootstrapAutonomy,
  ConversationAutonomyView,
  PlanCreateResponse,
  PlanExecutionBody,
  PlanExecutionResponse,
} from "./shared/autonomy-types.ts";
import { brouillonExecution, TEXTES } from "./shared/plan-texts.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { within } from "./test-support/helpers.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const MODEL_FILE = "web/pages/chat/plan/plan-card.ts";
const COMPONENT_FILE = "web/pages/chat/plan/PlanCard.tsx";
const CSS_FILE = "web/pages/chat/plan/plan.css";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

// --- Doublures ------------------------------------------------------------------------------------------------------------------

const CAPS: AutonomyCaps = {
  plafondUsd: DEFAULT_SETTINGS.budget.autonomie.plafondUsd,
  actionsMax: DEFAULT_SETTINGS.budget.autonomie.actionsMax,
  delegationsMax: DEFAULT_SETTINGS.budget.autonomie.delegationsMax,
  dureeMinutes: DEFAULT_SETTINGS.budget.autonomie.dureeMinutes,
  fichiersMax: DEFAULT_SETTINGS.budget.autonomie.fichiersMax,
  controlesIaMax: DEFAULT_SETTINGS.budget.autonomie.controlesIaMax,
};

/** Vue synthétique de GET …/autonomie ; une racine de plan a les disponibilités du serveur (seul « plan »). */
function viewOf(rootId: string, choix: AutonomyChoice, interrupteur = true): ConversationAutonomyView {
  return {
    rootId,
    choix,
    plafonds: { ...CAPS },
    depuis: 1,
    retourCause: null,
    planSourceId: null,
    executionDePlanId: null,
    interrupteur,
    disponibles: (["demander", "modifications", "plan", "autonome"] as const).map((c) =>
      choix === "plan"
        ? { choix: c, disponible: c === "plan", raison: c === "plan" ? null : "racine-de-plan" }
        : { choix: c, disponible: c === "demander", raison: c === "demander" ? null : c === "plan" ? "nouvelle-conversation" : "a-venir" },
    ),
    demande: null,
  };
}

const OPEN: BootstrapAutonomy = { interrupteur: true, activationOuverte: true };
const GATE_CLOSED: BootstrapAutonomy = { interrupteur: true, activationOuverte: false };

/** Entrée d'une conversation de plan au repos, réponse terminée : la carte à quatre boutons. */
const planInput = (over: Partial<PlanCardInput> = {}): PlanCardInput => ({
  rootId: "ses_P",
  view: viewOf("ses_P", "plan"),
  answer: { rootId: "ses_P", answered: true },
  busy: false,
  boot: OPEN,
  ...over,
});

/** Résumé des boutons : [action, désactivé, code de raison]. */
const summary = (model: PlanCardModel) => model.boutons.map((b) => [b.action, b.desactive, b.raisonCode]);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const button = (action: PlanCardAction, desactive = false): PlanCardButton => ({
  action,
  libelle: "x",
  icone: "list",
  desactive,
  raisonCode: desactive ? "a-venir" : null,
  raison: desactive ? "x" : null,
});

/** Messages opencode (forme de GET /session/:id/message). */
const userMsg = (text: string) => ({ info: { id: "msg_u", role: "user", time: { created: 1 } }, parts: [{ type: "text", text }] });
const aiMsg = (parts: unknown[], info: Record<string, unknown> = {}) => ({
  info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, ...info },
  parts,
});
const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra });

// --- Modèle -------------------------------------------------------------------------------------------------------------------------

describe("carte de plan : affichage (§4.9 points 4 et 6)", () => {
  it("rien hors d'une conversation de plan : vue absente, vue d'une autre conversation, autre choix en vigueur", () => {
    const cases: Array<Partial<PlanCardInput>> = [
      { view: null },
      { view: viewOf("ses_AUTRE", "plan") },
      ...(["demander", "modifications", "autonome"] as const).map((choix) => ({ view: viewOf("ses_P", choix) })),
    ];
    for (const over of cases) {
      const model = buildPlanCard(planInput(over));
      assert.equal(model.affichage, "aucune", JSON.stringify(over));
      assert.deepEqual([model.boutons, model.raisons, model.plafonds], [[], [], null]);
    }
  });

  it("phrase d'honnêteté seule tant qu'aucune réponse n'est terminée (lecture absente, d'une autre conversation, sans réponse) ou que la racine travaille", () => {
    const cases: Array<Partial<PlanCardInput>> = [
      { answer: null },
      { answer: { rootId: "ses_AUTRE", answered: true } },
      { answer: { rootId: "ses_P", answered: false } },
      { busy: true },
    ];
    for (const over of cases) {
      const model = buildPlanCard(planInput(over));
      assert.equal(model.affichage, "note", JSON.stringify(over));
      assert.equal(model.honnetete, TEXTES.partout.honnetete);
    }
  });

  it("après chaque réponse, au repos : carte « Plan d'abord », phrase d'honnêteté, quatre boutons dans l'ordre, plafonds de la vue", () => {
    const input = deepFreeze(planInput());
    const model = buildPlanCard(input);
    assert.equal(model.affichage, "carte");
    assert.equal(model.titre, CHOIX.partout.choix.plan.libelle);
    assert.equal(model.icone, CHOICE_ICONS.plan);
    assert.equal(model.honnetete, "Cette conversation ne peut rien modifier, même plus tard.");
    assert.deepEqual(
      model.boutons.map((b) => [b.action, b.libelle, b.icone]),
      [
        ["demander", TEXTES.partout.carte.executerDemander, CHOICE_ICONS.demander],
        ["modifications", TEXTES.partout.carte.executerModifications, CHOICE_ICONS.modifications],
        ["autonome", TEXTES.partout.carte.executerAutonome, CHOICE_ICONS.autonome],
        ["continuer", TEXTES.partout.carte.continuer, CHOICE_ICONS.plan],
      ],
    );
    assert.deepEqual(PLAN_CARD_ORDER, ["demander", "modifications", "autonome", "continuer"]);
    assert.deepEqual(model.plafonds, CAPS);
    // Une nouvelle réponse commence : la carte attend (phrase seule), puis revient.
    assert.equal(buildPlanCard({ ...input, busy: true }).affichage, "note");
    assert.equal(buildPlanCard({ ...input, busy: false }).affichage, "carte");
  });
});

describe("carte de plan : boutons indisponibles avec leur raison (I7, §4.11)", () => {
  it("porte I1 fermée (amorçage sans autonomy, ou activationOuverte faux) : choix automatiques désactivés, raison « a-venir », phrase fixée", () => {
    for (const boot of [undefined, GATE_CLOSED]) {
      const model = buildPlanCard(planInput({ boot }));
      assert.deepEqual(summary(model), [
        ["demander", false, null],
        ["modifications", true, "a-venir"],
        ["autonome", true, "a-venir"],
        ["continuer", false, null],
      ]);
      // Une seule ligne par raison, décrite par ses deux boutons.
      assert.deepEqual(model.raisons, [{ code: "a-venir", texte: "Pas encore disponible dans cette version du cockpit." }]);
      assert.equal(model.boutons[1]?.raison, raisonIndisponible("a-venir"));
    }
  });

  it("COCKPIT_AUTONOMY=off (amorçage ou vue du serveur) : « autonomie-coupee », même si l'activation est ouverte", () => {
    for (const over of [
      { boot: { interrupteur: false, activationOuverte: true } },
      { boot: { interrupteur: false, activationOuverte: false } },
      { view: viewOf("ses_P", "plan", false), boot: OPEN },
    ] satisfies Array<Partial<PlanCardInput>>) {
      const model = buildPlanCard(planInput(over));
      assert.deepEqual(
        summary(model).map(([, desactive, code]) => [desactive, code]),
        [
          [false, null],
          [true, "autonomie-coupee"],
          [true, "autonomie-coupee"],
          [false, null],
        ],
        JSON.stringify(over),
      );
      assert.deepEqual(model.raisons, [{ code: "autonomie-coupee", texte: CHOIX.partout.raisons["autonomie-coupee"] }]);
    }
  });

  it("activation ouverte et interrupteur ouvert : les quatre boutons utilisables (le serveur vérifie encore l'activation)", () => {
    const model = buildPlanCard(planInput());
    assert.ok(model.boutons.every((b) => !b.desactive && b.raison === null && b.raisonCode === null));
    assert.deepEqual(model.raisons, []);
  });

  it("« Exécuter en demandant à chaque fois » et « Continuer à planifier » ne sont jamais désactivés (§4.11 : restent Demander et Plan)", () => {
    const boots: Array<BootstrapAutonomy | undefined> = [undefined, OPEN, GATE_CLOSED, { interrupteur: false, activationOuverte: false }];
    for (const boot of boots) {
      for (const interrupteur of [true, false]) {
        const model = buildPlanCard(planInput({ boot, view: viewOf("ses_P", "plan", interrupteur) }));
        for (const action of ["demander", "continuer"] as const) {
          assert.equal(model.boutons.find((b) => b.action === action)?.desactive, false, `${action} ${JSON.stringify(boot)} ${interrupteur}`);
        }
      }
    }
  });

  it("choix automatiques : « modifications » et « autonome » seulement", () => {
    assert.deepEqual(
      PLAN_CARD_ORDER.filter((a) => isAutomaticAction(a)),
      ["modifications", "autonome"],
    );
    assert.deepEqual(PLAN_CARD_ICONS, { demander: "question", modifications: "edit", autonome: "shield", continuer: "list" });
  });
});

describe("carte de plan : clic et suite d'une exécution refusée (§4.11 l.776)", () => {
  it("clic : rien sur un bouton désactivé ou pendant une exécution ; exécution ; retour à la saisie pour « Continuer à planifier »", () => {
    assert.equal(clickEffect(button("modifications", true), false), "rien");
    for (const action of PLAN_CARD_ORDER) assert.equal(clickEffect(button(action), true), "rien", action);
    assert.equal(clickEffect(button("demander"), false), "executer");
    assert.equal(clickEffect(button("autonome"), false), "executer");
    assert.equal(clickEffect(button("continuer"), false), "continuer");
  });

  it("428 d'un choix automatique envoyé sans en-tête : confirmation de ce choix ; jamais deux fois, jamais pour « demander »", () => {
    const e428: ExecutionErrorInfo = { error: "confirmation-requise" };
    assert.deepEqual(executionFailure("autonome", e428, "srv", false), { kind: "confirmer", choix: "autonome" });
    assert.deepEqual(executionFailure("modifications", e428, "srv", false), { kind: "confirmer", choix: "modifications" });
    // Déjà confirmé : la phrase du serveur, aucune nouvelle confirmation (pas de boucle).
    assert.deepEqual(executionFailure("autonome", e428, "srv", true), { kind: "message", texte: "srv" });
    assert.deepEqual(executionFailure("demander", e428, "srv", false), { kind: "message", texte: "srv" });
  });

  it("403 et 409 avec une raison : la phrase propre au code (autonomy-texts, L9b), plus précise que la phrase générique du serveur", () => {
    const codes: ActivationRefusalCode[] = ["a-venir", "autonomie-coupee", "regle-allow", "mcp-ou-extension", "profil-sans-confirmation", "plancher-non-verifie"];
    for (const raison of codes) {
      const error: ExecutionErrorInfo = { error: raison === "autonomie-coupee" ? "autonomie-coupee" : "autonomie-indisponible", raison };
      assert.deepEqual(executionFailure("autonome", error, raisonIndisponible(raison), true), { kind: "message", texte: raisonRefus(raison) }, raison);
    }
    assert.equal(raisonRefus("regle-allow"), AUTONOMIE.partout.refusActivation["regle-allow"]);
    assert.notEqual(raisonRefus("regle-allow"), raisonIndisponible("regle-allow"));
  });

  it("409 sans raison (un autre choix est arrivé), autre erreur ou réseau : la phrase reçue", () => {
    assert.deepEqual(executionFailure("autonome", { error: "autonomie-indisponible" }, CHOIX.partout.erreurs.remplace, true), {
      kind: "message",
      texte: CHOIX.partout.erreurs.remplace,
    });
    assert.deepEqual(executionFailure("demander", null, TEXTES.partout.erreurs.sansReponse, false), { kind: "message", texte: TEXTES.partout.erreurs.sansReponse });
  });
});

describe("carte de plan : réponse terminée (même critère que lastPlanText)", () => {
  const cases: Array<[string, unknown[], boolean]> = [
    ["aucun message", [], false],
    ["message de l'utilisateur seul", [userMsg("Prépare un plan.")], false],
    ["réponse en cours", [aiMsg([text("1. Lire.")], { time: { created: 1 } })], false],
    ["réponse en erreur", [aiMsg([text("1. Lire.")], { error: { name: "APIError" } })], false],
    ["résumé", [aiMsg([text("Résumé.")], { summary: true })], false],
    ["texte synthétique seul", [aiMsg([text("1. Lire.", { synthetic: true })])], false],
    ["texte ignoré seul", [aiMsg([text("1. Lire.", { ignored: true })])], false],
    ["texte vide", [aiMsg([text("  \n ")])], false],
    ["outil et réflexion seuls", [aiMsg([{ type: "tool", tool: "read" }, { type: "reasoning", text: "Je lis." }])], false],
    ["parties absentes", [{ info: { role: "assistant", time: { completed: 2 } } }], false],
    ["réponse terminée avec un texte", [userMsg("Prépare un plan."), aiMsg([text("1. Lire.\n2. Écrire.")])], true],
    ["réponse terminée puis nouvelle réponse en cours", [aiMsg([text("1. Lire.")]), aiMsg([text("…")], { time: { created: 3 } })], true],
    ["entrées illisibles ignorées", [null, 3, { info: null, parts: [] }, aiMsg([text("Plan.")])], true],
  ];

  for (const [label, messages, expected] of cases) {
    it(`${label} → ${expected ? "réponse" : "aucune réponse"}, comme le serveur`, () => {
      assert.equal(planAnswered(messages), expected);
      assert.equal(lastPlanText(messages) !== null, expected, "parité avec le texte de plan lu par POST …/execution");
    });
  }

  it("liste illisible : aucune réponse (jamais une exception)", () => {
    for (const value of [null, undefined, {}, "x", 3]) assert.equal(planAnswered(value), false);
  });

  it("message.updated : un message d'IA terminé de cette conversation seulement déclenche la relecture", () => {
    const done = { id: "msg_a", sessionID: "ses_P", role: "assistant", time: { created: 1, completed: 2 } };
    assert.equal(answerCompleted(done, "ses_P"), true);
    assert.equal(answerCompleted(done, "ses_AUTRE"), false);
    assert.equal(answerCompleted({ ...done, time: { created: 1 } }, "ses_P"), false);
    assert.equal(answerCompleted({ ...done, role: "user" }, "ses_P"), false);
    assert.equal(answerCompleted({ ...done, error: { name: "APIError" } }, "ses_P"), false);
    for (const value of [null, "x", [], { sessionID: "ses_P" }]) assert.equal(answerCompleted(value, "ses_P"), false);
  });

  it("autonomie.choix : racine lue avec prudence", () => {
    assert.equal(choiceEventRoot({ rootId: "ses_P", choix: "plan" }), "ses_P");
    for (const value of [null, "ses_P", [], { rootId: 3 }, {}]) assert.equal(choiceEventRoot(value), null);
  });
});

// --- Parcours avec le serveur -------------------------------------------------------------------------------------------------------

/** Port activation scriptable : verdicts dans l'ordre des appels (le dernier se répète). */
class ScriptedActivation implements ActivationPort {
  readonly calls: ActivationInput[] = [];
  readonly verdicts: ActivationVerdict[];

  constructor(verdicts: ActivationVerdict[]) {
    this.verdicts = verdicts;
  }

  async check(input: ActivationInput): Promise<ActivationVerdict> {
    this.calls.push(input);
    return this.verdicts[Math.min(this.calls.length - 1, this.verdicts.length - 1)] ?? { ok: true };
  }
}

/**
 * Le fetch du navigateur est branché sur le cockpit du harnais : les adresses relatives (/api/…) du client du navigateur y
 * partent avec le cookie de session ; les autres (cockpit → faux opencode) restent au vrai fetch.
 */
function bridgeFetch(t: TestContext, h: CockpitHarness): void {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/")) return realFetch(input, init);
    const headers = { ...h.headers.authed, ...((init?.headers ?? {}) as Record<string, string>) };
    const res = await h.call(init?.method ?? "GET", url, { headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return new Response(res.body === "" ? null : res.body, { status: res.status });
  });
}

async function start(t: TestContext, activation?: ActivationPort): Promise<CockpitHarness> {
  const h = await startCockpit(t, { modules: ["floors", "conversationAutonomy", "plans"], ...(activation ? { ports: { activation } } : {}) });
  bridgeFetch(t, h);
  return h;
}

const creations = (h: CockpitHarness) => h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session").length;

async function newPlan(h: CockpitHarness): Promise<string> {
  const res = await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: h.fake.directory } });
  assert.equal(res.status, 200, res.body);
  return res.json<PlanCreateResponse>().rootId;
}

/** Réponse du plan, envoyée par le proxy et terminée. */
async function answer(h: CockpitHarness, planId: string, value: string): Promise<void> {
  h.fake.script(planId, { text: value });
  const res = await h.call("POST", `/api/oc/session/${planId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Prépare un plan." }] },
  });
  assert.equal(res.status, 204, res.body);
  await within(h.fake.settled(planId), "réponse du plan terminée");
}

/** Carte lue comme PlanCard.tsx : vue par GET …/autonomie, réponse par les messages lus par le proxy. */
async function cardOf(h: CockpitHarness, rootId: string, boot: BootstrapAutonomy): Promise<PlanCardModel> {
  const view = await autonomyApi.get(rootId);
  const messages = await oc.messages(rootId, h.fake.directory);
  return buildPlanCard({ rootId, view, answer: { rootId, answered: planAnswered(messages) }, busy: false, boot });
}

/** Mêmes appels que `execute` de PlanCard.tsx : premier appel sans en-tête (plafonds null), appel confirmé avec les plafonds. */
async function attempt(planId: string, action: PlanExecutionBody["choix"], plafonds: AutonomyCaps | null): Promise<{ kind: "ok"; value: PlanExecutionResponse } | ExecutionFailure> {
  const confirmed = plafonds !== null;
  const body: PlanExecutionBody = plafonds === null ? { choix: action } : { choix: action, plafonds };
  try {
    return { kind: "ok", value: await planApi.execute(planId, body, { confirm: confirmed }) };
  } catch (err) {
    return executionFailure(action, autonomyError(err), errorText(err), confirmed);
  }
}

describe("carte de plan : parcours avec le cockpit (client du navigateur, harnais, faux opencode)", () => {
  it("porte I1 fermée : phrase seule avant la réponse, carte après ; 428 → confirmation, confirmé → 409 « a-venir » sans conversation ; « demander » → brouillon", async (t) => {
    const h = await start(t);
    const boot: BootstrapAutonomy = { interrupteur: true, activationOuverte: h.cockpit.c11.activationOuverte };
    assert.equal(boot.activationOuverte, false);
    const planId = await newPlan(h);
    assert.equal((await cardOf(h, planId, boot)).affichage, "note");
    await answer(h, planId, "1. Lire le code.\n2. Écrire les tests.");
    const card = await cardOf(h, planId, boot);
    assert.equal(card.affichage, "carte");
    assert.deepEqual(card.raisons.map((r) => r.code), ["a-venir"]);
    assert.ok(card.plafonds);

    const before = creations(h);
    assert.deepEqual(await attempt(planId, "autonome", null), { kind: "confirmer", choix: "autonome" });
    assert.deepEqual(await attempt(planId, "autonome", card.plafonds), { kind: "message", texte: raisonRefus("a-venir") });
    assert.equal(creations(h), before, "aucune conversation créée");

    const done = await attempt(planId, "demander", null);
    assert.equal(done.kind, "ok");
    assert.ok(done.kind === "ok");
    assert.equal(done.value.brouillon, brouillonExecution("1. Lire le code.\n2. Écrire les tests."));
    assert.equal(creations(h), before + 1);
    // La conversation d'exécution n'est pas un plan : aucune carte.
    assert.equal((await cardOf(h, done.value.rootId, boot)).affichage, "aucune");
    h.assertNoGlobalRestart();
  });

  it("activation permise : 428 sans en-tête → confirmation ; appel confirmé avec les plafonds → conversation « autonome », brouillon", async (t) => {
    const activation = new ScriptedActivation([{ ok: true }]);
    const h = await start(t, activation);
    const planId = await newPlan(h);
    await answer(h, planId, "Plan.");
    const card = await cardOf(h, planId, OPEN);
    assert.deepEqual(summary(card).map(([, desactive]) => desactive), [false, false, false, false]);
    for (const action of ["modifications", "autonome"] as const) {
      assert.deepEqual(await attempt(planId, action, null), { kind: "confirmer", choix: action });
    }
    assert.equal(activation.calls.length, 0, "activation non consultée sans confirmation");
    const done = await attempt(planId, "autonome", { ...CAPS, actionsMax: 12 });
    assert.ok(done.kind === "ok", JSON.stringify(done));
    assert.equal(done.value.brouillon, brouillonExecution("Plan."));
    const view = await autonomyApi.get(done.value.rootId);
    assert.deepEqual([view.choix, view.plafonds.actionsMax, view.executionDePlanId], ["autonome", 12, planId]);
    h.assertNoGlobalRestart();
  });

  it("activation refusée (assistant sur allow) : 409 → la phrase propre à la raison dans la carte, aucune conversation gardée", async (t) => {
    const h = await start(t, new ScriptedActivation([{ ok: false, raison: "regle-allow" }]));
    const planId = await newPlan(h);
    await answer(h, planId, "Plan.");
    const before = creations(h);
    assert.deepEqual(await attempt(planId, "modifications", CAPS), { kind: "message", texte: raisonRefus("regle-allow") });
    assert.equal(creations(h), before);
  });

  it("plan sans réponse terminée : la carte n'est pas offerte, et le serveur refuserait l'exécution avec sa phrase", async (t) => {
    const h = await start(t);
    const planId = await newPlan(h);
    assert.equal((await cardOf(h, planId, OPEN)).affichage, "note");
    assert.deepEqual(await attempt(planId, "demander", null), { kind: "message", texte: TEXTES.partout.erreurs.sansReponse });
  });
});

// --- Textes, composant, feuille de style et pureté ------------------------------------------------------------------------------

/** Phrases affichées par la carte (plan-texts, autonomy-choice-texts, autonomy-texts), à ne recopier nulle part. */
function cardPhrases(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const inner of Object.values(value)) walk(inner);
  };
  walk(TEXTES.partout.carte);
  walk(TEXTES.partout.executionCreee);
  walk(TEXTES.partout.honnetete);
  walk(CHOIX.partout.choix.plan);
  walk(CHOIX.partout.raisons);
  walk(AUTONOMIE.partout.refusActivation);
  return out;
}

/** Source sans commentaires (bloc, et ligne hors « :// » et chaîne). */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** Chaînes entre guillemets doubles d'un source, commentaires retirés. */
function quoted(source: string): string[] {
  return [...withoutComments(source).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

describe("carte de plan : textes (sans doublon), contrat du composant, feuille de style, pureté du modèle", () => {
  it("aucune phrase de la carte recopiée dans le modèle, le composant ou la feuille de style", () => {
    const phrases = cardPhrases();
    assert.ok(phrases.length >= 12);
    for (const file of [MODEL_FILE, COMPONENT_FILE, CSS_FILE]) {
      const source = withoutComments(read(file));
      for (const phrase of phrases) assert.equal(source.includes(phrase), false, `${file} : « ${phrase} » recopié`);
    }
  });

  it("modèle : aucun texte affiché écrit en dur (chaînes = codes ou chemins)", () => {
    for (const literal of quoted(read(MODEL_FILE))) {
      assert.doesNotMatch(literal, /\p{L}\s+\p{L}|(?=\P{ASCII})\p{L}/u, `texte affiché dans le modèle : « ${literal} »`);
    }
  });

  it("composant : aucun texte affiché écrit en dur (ni texte JSX, ni aria-label, title, placeholder ou alt littéraux)", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    const jsxText = [...source.matchAll(/>([^<>{}()=;]*\p{L}[^<>{}()=;]*)</gu)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    assert.deepEqual(jsxText, []);
    assert.doesNotMatch(source, /\b(?:aria-label|title|placeholder|alt)="/);
    assert.match(source, /from "\.\/plan-card\.ts"/);
  });

  it("composant : exécution sans en-tête, confirmation sur 428 puis appel confirmé, raison sur 403 et 409, brouillon ouvert", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    for (const needle of [
      'import "./plan.css";',
      "buildPlanCard({ rootId, view, answer, busy, boot: boot.autonomy })",
      // Premier appel sans en-tête ; l'appel confirmé porte les plafonds de la confirmation.
      "void execute(bouton.action, null)",
      "const confirmed = plafonds !== null;",
      "planApi.execute(planRoot, body, { confirm: confirmed })",
      "executionFailure(action, autonomyError(err), errorText(err), confirmed)",
      "onOpenConversation(created.rootId, created.brouillon)",
      "<AutonomyConfirm",
      "open={confirm !== null}",
      "plafonds={model.plafonds}",
      "void execute(confirm, plafonds)",
      "onCancel={cancelConfirm}",
      'role="alert"',
      // Gardes : double clic, conversation changée pendant l'appel, clic sans effet sur un bouton désactivé.
      "if (inflight.current) return;",
      "if (rootRef.current !== planRoot) return;",
      "clickEffect(bouton, pending !== null || inflight.current)",
    ]) {
      assert.ok(source.includes(needle), `absent : ${needle}`);
    }
  });

  it("composant : exécution créée après un changement de conversation ou de page → ni navigation ni saisie remplacée ; brouillon gardé pour son ouverture, notification [Ouvrir]", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    const call = source.indexOf("planApi.execute(planRoot, body, { confirm: confirmed })");
    const guard = source.indexOf("if (!mounted.current || rootRef.current !== planRoot) {", call);
    const open = source.indexOf("onOpenConversation(created.rootId, created.brouillon)", call);
    assert.ok(call > 0 && guard > call && open > guard, "la garde de la réussite suit l'appel et précède l'ouverture");
    // Branche gardée : brouillon rangé sous la conversation d'exécution, notification (ou brouillon remis si elle est déjà affichée).
    const branch = /if \(!mounted\.current \|\| rootRef\.current !== planRoot\) \{([\s\S]*?)\n {8}return;\n {6}\}/.exec(source)?.[1] ?? "";
    assert.ok(branch.includes("keepDraft(created.rootId, created.brouillon);"), branch);
    assert.ok(branch.includes("if (mounted.current && rootRef.current === created.rootId) setDraftTick((tick) => tick + 1);"), branch);
    assert.match(branch, /toast\.success\(PLAN\.executionCreee\.titre, PLAN\.executionCreee\.message, \{\s*label: PLAN\.executionCreee\.ouvrir,\s*onClick: \(\) => navigate\("chat", created\.rootId\),\s*\}\);/);
    assert.doesNotMatch(branch, /onOpenConversation|setConfirm|setMessage|navigate\("chat", created\.rootId\)\s*;/);
    // Carte démontée (autre page) : référence posée à faux au démontage.
    assert.match(source, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{\s*mounted\.current = false;\s*\};\s*\}, \[\]\);/);
    // Brouillon remis à la saisie à l'ouverture de SA conversation, une seule fois (retiré avant d'être remis).
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*const draft = pendingDrafts\.get\(rootId\);\s*if \(draft === undefined\) return;\s*pendingDrafts\.delete\(rootId\);\s*openRef\.current\(rootId, draft\);\s*\}, \[rootId, draftTick\]\);/,
    );
    assert.match(source, /const PENDING_DRAFTS_MAX = \d+;/);
    assert.match(source, /while \(pendingDrafts\.size > PENDING_DRAFTS_MAX\)/);
    // Textes de la notification : plan-texts.ts, jamais recopiés.
    assert.match(source, /import \{ TEXTES as PLAN_TEXTES \} from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/plan-texts\.ts";/);
    for (const phrase of Object.values(TEXTES.partout.executionCreee)) assert.equal(source.includes(phrase), false, phrase);
  });

  it("composant : boutons focalisables même indisponibles (aria-disabled, jamais disabled), décrits par leur raison ; aucun raccourci", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    assert.ok(source.includes("aria-disabled={bouton.desactive || pending !== null || undefined}"));
    assert.ok(source.includes("aria-describedby={bouton.raisonCode ? reasonId(bouton.raisonCode) : undefined}"));
    assert.ok(source.includes("id={reasonId(raison.code)}"));
    assert.ok(source.includes('type="button"'));
    // Attribut natif `disabled` (retire le bouton de la tabulation) ; `aria-disabled` n'est pas visé.
    assert.doesNotMatch(source, /(?<![\w-])disabled(?:=|\s|\/?>)/);
    assert.doesNotMatch(source, /addEventListener\(\s*["']key(?:down|up|press)["']|\bonKey(?:Down|Up|Press)\b|\baccessKey\b/);
  });

  it("composant : messages lus seulement pour une conversation de plan au repos ; jamais une carte sur une vue illisible", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    const guard = source.indexOf("if (!isPlan || busy) return;");
    const fetchAt = source.indexOf("oc.messages(");
    assert.ok(guard > 0 && fetchAt > guard, "la lecture des messages doit suivre la garde « conversation de plan au repos »");
    assert.ok(source.includes("setAnswer({ rootId: id, answered: planAnswered(messages) })"));
    assert.ok(source.includes('if (model.affichage === "aucune") return null;'));
    assert.match(source, /console\.warn\("carte de plan : lecture du choix impossible", errorText\(err\)\);\s*setView\(null\);/);
  });

  it("composant : changement de conversation, rien de l'ancienne ne reste ; « Continuer à planifier » rend le focus à la saisie sans rien envoyer", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    assert.match(source, /useEffect\(\(\) => \{\s*setView\(null\);\s*setAnswer\(null\);\s*setMessage\(null\);\s*setConfirm\(null\);\s*refreshView\(rootId\);/);
    assert.match(source, /\}, \[rootId, refreshView\]\);/);
    assert.ok(source.includes('if (effect === "continuer") continuePlanning();'));
    const body = /const continuePlanning = \(\) => \{([\s\S]*?)\n {2}\};/.exec(source)?.[1] ?? "";
    assert.equal(body.trim(), 'document.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")?.focus();');
  });

  it("feuille de style : aucune animation ni opacité, boutons qui passent à la ligne, focus visible, forced-colors, raison en --text-2", () => {
    const css = read(CSS_FILE).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /\banimation\b|@keyframes|\binfinite\b|\btransition\b/);
    assert.doesNotMatch(css, /\bopacity\b/);
    // Surcharges de .btn qualifiées (styles.css est chargée après cette feuille).
    assert.match(css, /\.btn\.plan-card-button \{[^}]*height: auto;[^}]*white-space: normal;/);
    assert.match(css, /\.plan-card-actions \{[^}]*flex-wrap: wrap;/);
    assert.match(css, /\.btn\.plan-card-button:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
    assert.match(css, /\.plan-card-actions \.btn\.plan-card-button\[aria-disabled="true"\][^{]*\{[^}]*cursor: not-allowed;/);
    assert.match(css, /\.plan-card-reason \{[^}]*color: var\(--text-2\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /@media \(max-width: 480px\)/);
  });

  it("pureté : le modèle n'importe que des textes, le modèle du menu et des types ; ni module node, ni process, ni horloge, ni DOM, ni réseau", () => {
    const source = read(MODEL_FILE);
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, [
      "../../../../server/shared/autonomy-choice-texts.ts",
      "../../../../server/shared/autonomy-menu.ts",
      "../../../../server/shared/autonomy-texts.ts",
      "../../../../server/shared/autonomy-types.ts",
      "../../../../server/shared/plan-texts.ts",
    ]);
    for (const forbidden of [/"node:/, /\bprocess\./, /\bDate\b/, /Math\.random/, /\bfetch\s*\(/, /\bset(?:Timeout|Interval)\b/, /\bwindow\b/, /\bdocument\b/]) {
      assert.doesNotMatch(withoutComments(source), forbidden);
    }
  });
});
