// Tests L10a : demandes autonomes (spécification §4.3, §4.8.1, §4.10, §4.12 ; plan d'exécution, fiche L10a).
// Harnais à modules déclarés (plan §2.2) : `modules: ["autonomy", "requests", "facts", "floors"]`, port `activation` surchargé à
// « permis » (la constante ACTIVATION_OUVERTE vaut true depuis la bascule du train de la vague 3 ; ces tests ouvrent le port par
// surcharge et ne la touchent jamais) et port `conversationAutonomy` surchargé pour poser le choix de la conversation.
// Ce que ces tests prouvent : une demande s'ouvre à l'envoi en choix automatique et se ferme à l'envoi suivant ; un choix qui vous
// demande n'ouvre rien ; un raccourci qui contient « !` » est refusé en choix automatique (409 raccourci-refuse-autonomie), rien
// n'est envoyé à opencode, et il passe en « Demander à chaque fois » ; compteurs, dépense (`ledger.spentSince`), événement
// `autonomie.demande` et `interrupt()` ; plafonds en vigueur (réglages, conversation, `plafondMaxUsd`). P6 partout.
// Aucun appel facturé : faux opencode seulement.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { AutonomyRequestStore, conversationCaps, templateRunsShell } from "./autonomy-requests.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import type { ActivationPort, ConversationAutonomyPort } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { SettingsStore } from "./settings.ts";
import { raccourciRefuse } from "./shared/autonomy-texts.ts";
import type { AutonomyChoice, AutonomyErrorBody } from "./shared/autonomy-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const MODEL_KEY = "github-copilot/gpt-5-mini";
const NL = String.fromCharCode(10);
const BQ = String.fromCharCode(96);
/** Ligne « !`commande` » d'un raccourci (§4.10) : opencode l'exécute à l'envoi, sans aucune demande d'autorisation. */
const SHELL_TEMPLATE = `Contexte : !${BQ}git status --short${BQ}${NL}Résume l'état du dépôt.`;
const PLAIN_TEMPLATE = `Résume l'état du dépôt, sans rien lancer.`;

const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

function choicePort(choices: Map<string, AutonomyChoice>): ConversationAutonomyPort {
  return {
    get: async () => null,
    choiceOf: (id) => choices.get(id) ?? "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

interface Bench {
  h: CockpitHarness;
  choices: Map<string, AutonomyChoice>;
}

async function startBench(t: TestContext, settings: Record<string, unknown> = {}): Promise<Bench> {
  const choices = new Map<string, AutonomyChoice>();
  const h = await startCockpit(t, {
    modules: ["autonomy", "requests", "facts", "floors"],
    settings: { ui: { mode: "simple" }, ...settings },
    ports: { conversationAutonomy: choicePort(choices), activation: PERMIS },
  });
  h.fake.setCommands([
    { name: "etat", template: SHELL_TEMPLATE, hints: [] },
    { name: "resume", template: PLAIN_TEMPLATE, hints: [] },
    // Gabarit qui n'est pas un texte : illisible, donc refusé en choix automatique (prudence).
    { name: "bizarre", template: 42 as unknown as string, hints: [] },
  ]);
  return { h, choices };
}

async function conversation(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

const prompt = (h: CockpitHarness, session: FakeSession, text = "Travaille.") =>
  h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });

const shortcut = (h: CockpitHarness, session: FakeSession, command: string) =>
  h.call("POST", `/api/oc/session/${session.id}/command`, {
    headers: h.headers.mutating,
    body: { command, arguments: "", model: MODEL_KEY, agent: "build" },
  });

interface RequestRow {
  id: string;
  root_id: string;
  choix: string;
  plafonds: string;
  started_at: number;
  ended_at: number | null;
  spent: number;
  auto: number;
  attentes: number;
  refus: number;
  controles: number;
  fichiers: number;
  delegations: number;
  fin: string | null;
}

const rows = (h: CockpitHarness, rootId: string): RequestRow[] =>
  h.db.prepare("SELECT * FROM autonomy_requests WHERE root_id = ? ORDER BY rowid").all(rootId) as unknown as RequestRow[];

const demandes = (h: CockpitHarness) => h.cockpitEvents().filter((event) => event.type === "autonomie.demande");

const commandsSent = (h: CockpitHarness, sessionId: string) =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/session/${sessionId}/command`);

// --- 1. Ouverture et fermeture d'une demande ---------------------------------------------------------------------------------------

describe("L10a : ouverture d'une demande autonome", () => {
  it("envoi en « Autonome » : une demande s'ouvre avec les plafonds, l'événement `autonomie.demande` part, le port la rend", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    h.fake.script(conv.id, { text: "Fait." });
    assert.equal((await prompt(h, conv)).status, 204);

    const open = await until(() => rows(h, conv.id).at(-1));
    assert.equal(open.ended_at, null);
    assert.equal(open.fin, null);
    assert.equal(open.choix, "autonome");
    assert.deepEqual(JSON.parse(open.plafonds), {
      plafondUsd: 1,
      actionsMax: 60,
      delegationsMax: 5,
      dureeMinutes: 30,
      fichiersMax: 25,
      controlesIaMax: 20,
    });
    const view = h.cockpit.c11.ports.requests.current(conv.id);
    assert.ok(view);
    assert.equal(view.id, open.id);
    assert.equal(view.rootId, conv.id);
    assert.equal(view.endedAt, null);
    assert.equal(h.cockpit.c11.ports.requests.spent(open.id), 0);
    assert.ok(demandes(h).length >= 1);
    h.assertNoGlobalRestart();
  });

  it("envoi suivant : la demande précédente est close (« terminee ») et une nouvelle s'ouvre", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    h.fake.script(conv.id, { text: "Un." }, { text: "Deux." });
    assert.equal((await prompt(h, conv, "Un.")).status, 204);
    const first = await until(() => rows(h, conv.id).at(-1));
    assert.equal((await prompt(h, conv, "Deux.")).status, 204);
    await until(() => rows(h, conv.id).length === 2);

    const [closed, open] = rows(h, conv.id) as [RequestRow, RequestRow];
    assert.equal(closed.id, first.id);
    assert.equal(closed.fin, "terminee");
    assert.ok(closed.ended_at !== null);
    assert.equal(open.ended_at, null);
    assert.equal(h.cockpit.c11.ports.requests.current(conv.id)?.id, open.id);
    h.assertNoGlobalRestart();
  });

  it("envoi en « Demander à chaque fois » : aucune demande ouverte, celle qui courait est close", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Conversation");
    choices.set(conv.id, "autonome");
    h.fake.script(conv.id, { text: "Un." }, { text: "Deux." });
    assert.equal((await prompt(h, conv, "Un.")).status, 204);
    await until(() => rows(h, conv.id).length === 1);

    choices.set(conv.id, "demander");
    assert.equal((await prompt(h, conv, "Deux.")).status, 204);
    await until(() => rows(h, conv.id)[0]?.fin === "terminee");
    assert.equal(rows(h, conv.id).length, 1, "aucune demande ouverte hors d'un choix automatique");
    assert.equal(h.cockpit.c11.ports.requests.current(conv.id), null);
    h.assertNoGlobalRestart();
  });

  it("dépense de la demande : `ledger.spentSince` depuis son début, jamais l'historique d'avant", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const usage = (messageId: string, at: number, cost: number) =>
      h.db
        .prepare(
          `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost)
           VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)`,
        )
        .run(messageId, conv.id, conv.id, at, at, cost);
    // Dépense antérieure à la demande : elle ne doit pas être comptée.
    usage("msg_avant", Date.now() - 60_000, 0.5);
    h.fake.script(conv.id, { text: "Fait." });
    assert.equal((await prompt(h, conv)).status, 204);
    const open = await until(() => rows(h, conv.id).at(-1));
    assert.equal(h.cockpit.c11.ports.requests.spent(open.id), 0);

    usage("msg_pendant", open.started_at + 1, 0.25);
    assert.equal(h.cockpit.c11.ports.requests.spent(open.id), 0.25);
    assert.equal(h.cockpit.c11.ports.requests.current(conv.id)?.spent, 0.25);
    h.assertNoGlobalRestart();
  });

  it("`interrupt(rootId, fin)` : la demande est close avec sa fin, et l'événement la porte", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    h.fake.script(conv.id, { text: "Fait." });
    assert.equal((await prompt(h, conv)).status, 204);
    await until(() => rows(h, conv.id).length === 1);

    h.cockpit.c11.ports.requests.interrupt(conv.id, "interrompue");
    const closed = rows(h, conv.id)[0];
    assert.ok(closed);
    assert.equal(closed.fin, "interrompue");
    assert.ok(closed.ended_at !== null);
    assert.equal(h.cockpit.c11.ports.requests.current(conv.id), null);
    const last = demandes(h).at(-1)?.data as { fin?: string; requestId: string };
    assert.equal(last.fin, "interrompue");
    assert.equal(last.requestId, closed.id);
    // Une interruption sans demande en cours ne fait rien.
    h.cockpit.c11.ports.requests.interrupt(conv.id, "vous");
    assert.equal(rows(h, conv.id).length, 1);
    h.assertNoGlobalRestart();
  });
});

// --- 2. Raccourcis « !` » (§4.10) ---------------------------------------------------------------------------------------------------

describe("L10a : raccourcis refusés en choix automatique", () => {
  it("raccourci dont le gabarit contient « !` » en « Autonome » : 409 raccourci-refuse-autonomie, rien n'est envoyé", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const res = await shortcut(h, conv, "etat");
    assert.equal(res.status, 409, res.body);
    const body = res.json<AutonomyErrorBody>();
    assert.equal(body.error, "raccourci-refuse-autonomie");
    assert.equal(body.message, raccourciRefuse());
    assert.match(body.message, /Raccourci refusé/);
    assert.deepEqual(commandsSent(h, conv.id), [], "le raccourci n'est jamais relayé à opencode");
    assert.deepEqual(rows(h, conv.id), [], "aucune demande autonome ouverte");
    h.assertNoGlobalRestart();
  });

  it("même raccourci en « Modifications automatiques » : refusé aussi ; en « Demander à chaque fois » : relayé", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Conversation");
    choices.set(conv.id, "modifications");
    assert.equal((await shortcut(h, conv, "etat")).status, 409);
    assert.deepEqual(commandsSent(h, conv.id), []);

    choices.set(conv.id, "demander");
    h.fake.script(conv.id, { text: "Fait." });
    const res = await shortcut(h, conv, "etat");
    assert.notEqual(res.status, 409, res.body);
    assert.equal(commandsSent(h, conv.id).length, 1, "hors choix automatique, le raccourci part normalement");
    assert.deepEqual(rows(h, conv.id), []);
    h.assertNoGlobalRestart();
  });

  it("raccourci sans « !` » en « Autonome » : relayé, et une demande s'ouvre", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    h.fake.script(conv.id, { text: "Fait." });
    const res = await shortcut(h, conv, "resume");
    assert.notEqual(res.status, 409, res.body);
    assert.equal(commandsSent(h, conv.id).length, 1);
    await until(() => rows(h, conv.id).length === 1);
    h.assertNoGlobalRestart();
  });

  it("gabarit illisible : refusé en choix automatique, rien n'est envoyé", async (t) => {
    const { h, choices } = await startBench(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const res = await shortcut(h, conv, "bizarre");
    assert.equal(res.status, 409, res.body);
    assert.equal(res.json<AutonomyErrorBody>().error, "raccourci-refuse-autonomie");
    assert.deepEqual(commandsSent(h, conv.id), [], "rien n'est relayé quand le gabarit ne se lit pas");
    assert.deepEqual(rows(h, conv.id), []);
    h.assertNoGlobalRestart();
  });

  it("`templateRunsShell` : « !` » sous toutes ses formes, et prudence sur un gabarit illisible", () => {
    assert.equal(templateRunsShell(`Voir !${BQ}ls${BQ}`), true);
    assert.equal(templateRunsShell(`Voir ! ${BQ}ls${BQ}`), true);
    assert.equal(templateRunsShell(`Ligne 1${NL}!${BQ}pwd${BQ}`), true);
    assert.equal(templateRunsShell("Résume le projet."), false);
    assert.equal(templateRunsShell(`Un accent grave seul : ${BQ}code${BQ}`), false);
    assert.equal(templateRunsShell("Une exclamation seule !"), false);
    assert.equal(templateRunsShell(undefined), true);
    assert.equal(templateRunsShell(42), true);
    assert.equal(templateRunsShell("a".repeat(200_001)), true);
  });
});

// --- 3. Magasin et plafonds -----------------------------------------------------------------------------------------------------

describe("L10a : magasin des demandes et plafonds", () => {
  it("compteurs : ajoutés tant que la demande est ouverte, `fichiers` en total, rien après la fermeture", () => {
    const db = openMemoryDb();
    const store = new AutonomyRequestStore(db);
    const caps = { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 };
    const row = store.open({ id: "dem-1", rootId: "ses_abcdefghijklmnopqrstuvwxyz", choix: "autonome", plafonds: caps, startedAt: 1_000 });
    assert.equal(row.auto, 0);

    assert.equal(store.bump("dem-1", { auto: 1, fichiersTotal: 2 }, 0.1)?.auto, 1);
    const second = store.bump("dem-1", { auto: 1, attentes: 1, controles: 3, delegations: 1, fichiersTotal: 2 }, 0.2);
    assert.ok(second);
    assert.deepEqual([second.auto, second.attentes, second.controles, second.delegations, second.fichiers, second.spent], [2, 1, 3, 1, 2, 0.2]);
    // Total plus petit : jamais de recul.
    assert.equal(store.bump("dem-1", { fichiersTotal: 1 }, 0.2)?.fichiers, 2);

    assert.equal(store.openRoots(10).length, 1);
    const closed = store.close("ses_abcdefghijklmnopqrstuvwxyz", "terminee", 2_000, 0.2);
    assert.equal(closed?.fin, "terminee");
    assert.equal(store.bump("dem-1", { auto: 1 }, 0.3), null, "une demande close ne compte plus rien");
    assert.equal(store.current("ses_abcdefghijklmnopqrstuvwxyz"), null);
    assert.deepEqual(store.openRoots(10), []);
    db.close();
  });

  it("plafonds en vigueur : réglages, puis ceux de la conversation, et jamais au-delà de `plafondMaxUsd`", () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', 'x', 0)").run();
    const settings = new SettingsStore(db);
    const c11 = { db, settings };
    const rootId = "ses_abcdefghijklmnopqrstuvwxyz";
    assert.equal(conversationCaps(c11, rootId).plafondUsd, settings.get().budget.autonomie.plafondUsd);
    assert.equal(conversationCaps(c11, rootId).actionsMax, settings.get().budget.autonomie.actionsMax);

    const store = new ConversationAutonomyStore(db);
    store.write(rootId, { choix: "autonome", plafonds: { plafondUsd: 0.25, actionsMax: 7 }, depuis: 1, retourCause: null });
    assert.equal(conversationCaps(c11, rootId).plafondUsd, 0.25);
    assert.equal(conversationCaps(c11, rootId).actionsMax, 7);

    // Un plafond de conversation au-delà du maximum des réglages est ramené au maximum (arrêt plus tôt, jamais plus tard).
    settings.update({ budget: { autonomie: { plafondUsd: 0.5, plafondMaxUsd: 0.5 } } });
    store.write(rootId, { choix: "autonome", plafonds: { plafondUsd: 40 }, depuis: 1, retourCause: null });
    assert.equal(conversationCaps(c11, rootId).plafondUsd, 0.5);
    db.close();
  });
});
