// Tests de l'activation des choix automatiques (L10d ; spécification §4.1, §4.10, §4.11, §4.13 ; décisions n° 13 et n° 14 ;
// plan d'exécution, fiche L10d, §2.6, §4.3, §4.4, §4.5). Harnais à modules déclarés (plan §2.2) : le plancher (L3), les faits
// (L4b) et le choix d'autonomie (L6a) sont réels, les autres ports restent neutres.
// Les deux branches de la porte I1 passent par la fabrique exportée (installActivation), jamais par wiring-11.ts,
// contracts-11.ts ni le harnais :
// - « activation » (le module livré) lit c11.activationOuverte, donc la constante du dépôt : il doit refuser « a-venir » même
//   pour une configuration parfaitement conforme, et rester inerte comme le port neutre ;
// - MODULE_OUVERT est le même module avec la porte ouverte : verdicts réels et crochet d'envoi.
// Un client qui fait échouer une lecture (FailingClient) tient les cas « configuration illisible » : le faux reste fidèle à
// opencode 1.18.30.
// P6 : aucun PATCH /global/config, aucun dispose, aucun redémarrage (assertNoGlobalRestart à chaque scénario).
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { type ActivationFactsDeps, collectActivationFacts } from "./activation-facts.ts";
import { installActivation, neutralActivation } from "./autonomy-activation.ts";
import type { Cockpit11Module } from "./contracts-11.ts";
import { createLogger } from "./log.ts";
import { OpencodeClient } from "./opencode.ts";
import type { SessionRow } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { PERMISSION_PRESETS } from "./shared/assistant-rules.ts";
import { activationRefusal } from "./shared/autonomy-rules.ts";
import { TEXTES as CHOIX, raisonIndisponible } from "./shared/autonomy-choice-texts.ts";
import { TEXTES, raisonRefus } from "./shared/autonomy-texts.ts";
import type { ActivationRefusalCode, ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, nativeAgents, rulesFromConfig } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
/** Profil livré (docker/opencode/opencode.default.jsonc) : conforme, avec l'exception « bash pwd » du §4.10. */
const PRUDENT = PERMISSION_PRESETS.prudent.permission;

/** Le module livré, mais porte ouverte : la fabrique reçoit `true` au lieu de c11.activationOuverte (plan §2.6). */
const MODULE_OUVERT: Cockpit11Module = {
  name: "activation",
  install: (reg, c11) => void installActivation(reg, c11, { activationOuverte: true }),
};

/** Client opencode dont certaines lectures échouent (« GET /config »), pour les relevés impossibles. */
class FailingClient extends OpencodeClient {
  readonly fail = new Set<string>();

  override raw(method: string, url: URL, init: Parameters<OpencodeClient["raw"]>[2] = {}): Promise<Response> {
    if (this.fail.has(`${method.toUpperCase()} ${url.pathname}`)) return Promise.resolve(new Response("indisponible", { status: 503 }));
    return super.raw(method, url, init);
  }
}

// --- Aides ------------------------------------------------------------------------------------------------------------------------

interface Started {
  h: CockpitHarness;
  client: FailingClient;
}

async function start(t: TestContext, options: { ouverte?: boolean } & CockpitHarnessOptions = {}): Promise<Started> {
  const { ouverte = true, ...rest } = options;
  let client: FailingClient | null = null;
  const h = await startCockpit(t, {
    modules: [ouverte ? MODULE_OUVERT : "activation", "floors", "facts", "conversationAutonomy"],
    ...rest,
    deps: (base) => {
      client = new FailingClient(base.env);
      return { client };
    },
  });
  assert.ok(client);
  return { h, client };
}

const url = (rootId: string) => `/api/conversations/${rootId}/autonomie`;

const putChoice = (h: CockpitHarness, rootId: string, body: unknown, headers = h.headers.confirmed) => h.call("PUT", url(rootId), { headers, body });

const send = (h: CockpitHarness, sessionId: string, agent = "build") =>
  h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent, model: MODEL, parts: [{ type: "text", text: "Continue." }] },
  });

/** Conversation créée par le proxy (plancher CONVERSATION vérifié), puis un envoi pour qu'opencode rapporte son assistant. */
async function conversation(h: CockpitHarness, agent = "build"): Promise<SessionRow> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Autonomie" } });
  assert.equal(created.status, 200, created.body);
  const { id } = created.json<{ id: string }>();
  const sent = await send(h, id, agent);
  assert.equal(sent.status, 204, sent.body);
  await within(h.fake.settled(id), "réponse du faux terminée");
  return until(() => {
    const row = h.sessions.get(id);
    return row?.agent === agent ? row : undefined;
  });
}

/** Configuration globale d'opencode : ses règles donnent aussi celles des assistants natifs (GET /agent). */
function globalPermission(h: CockpitHarness, permission: Record<string, unknown>): void {
  h.fake.globalConfig = { ...h.fake.globalConfig, permission };
  h.deps.lookup.invalidate();
}

/** Vérification du port, telle que L6a et le crochet d'envoi l'appellent. */
const check = (h: CockpitHarness, root: SessionRow, choix: "modifications" | "autonome" = "autonome") =>
  h.cockpit.c11.ports.activation.check({ rootId: root.id, choix, agent: root.agent, directory: root.directory || null });

/** Corps d'un 409 de PUT …/autonomie : le code, et la phrase du module de textes des routes (L6a, autonomy-choice-texts.ts). */
const refus = (raison: ActivationRefusalCode) => ({ error: "autonomie-indisponible", message: raisonIndisponible(raison), raison });

/** Faits « choix » écrits par le magasin réel (module « facts » déclaré). */
const factsOf = (h: CockpitHarness, rootId: string) =>
  h.cockpit.c11.ports.facts
    .since(rootId, 0)
    .facts.filter((fact: ActivityFact) => fact.kind === "choix")
    .map((fact: ActivityFact) => ({ rootId: fact.rootId, data: fact.data }));

const prompts = (h: CockpitHarness) => h.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async")).length;

/** Assistant qui agit déjà sans demander : refusé par le §4.10, quel que soit le profil global. */
const SANS_DEMANDE: FakeAgent = {
  name: "sans-demande",
  mode: "primary",
  options: {},
  permission: rulesFromConfig({ "*": "allow", edit: "allow", bash: "allow", task: "allow", webfetch: "allow", websearch: "allow" }),
};

// --- Relevé des faits : replis quand une lecture échoue -----------------------------------------------------------------------

/** Dépendances du relevé, toutes lisibles et conformes ; chaque test en remplace une pour vérifier son repli. */
function factsDeps(over: Partial<ActivationFactsDeps> = {}): ActivationFactsDeps {
  return {
    env: { autonomy: true, opencodeConfigDir: path.join(os.tmpdir(), "cockpit-activation-sans-dossier") },
    log: createLogger("error"),
    client: { request: async () => ({ permission: PRUDENT }) as never },
    lookup: { get: async () => ({ directory: null, agents: [], commands: [], loadedAt: 0 }) },
    ports: { floors: { verified: async () => true, createWithFloor: async () => assert.fail("createWithFloor : le relevé n'écrit rien") } },
    ...over,
  };
}

const RELEVE = { sessionId: "ses_1", agent: "build", directory: null, activationOuverte: true };

describe("activation : relevé des faits en lecture seule", () => {
  it("tout lisible et conforme : aucun refus, et l'interrupteur comme la porte sont repris tels quels", async () => {
    const deps = factsDeps({ lookup: { get: async () => ({ directory: null, agents: [{ name: "build", mode: "all", permission: [] }], commands: [], loadedAt: 0 }) } });
    assert.deepEqual(await collectActivationFacts(deps, RELEVE), {
      interrupteur: true,
      activationOuverte: true,
      agentRules: [],
      mcpOuExtension: false,
      profilSansConfirmation: false,
      plancherVerifie: true,
    });
    assert.equal(activationRefusal(await collectActivationFacts(deps, RELEVE)), null);
    assert.equal(activationRefusal(await collectActivationFacts({ ...deps, env: { ...deps.env, autonomy: false } }, RELEVE)), "autonomie-coupee");
    assert.equal(activationRefusal(await collectActivationFacts(deps, { ...RELEVE, activationOuverte: false })), "a-venir");
  });

  it("une lecture qui échoue refuse, sans entraîner les autres", async () => {
    const boum = () => {
      throw new Error("opencode muet");
    };
    // Règles de l'assistant illisibles (GET /agent muet) : agentRules null → « regle-allow ».
    const agents = await collectActivationFacts(factsDeps({ lookup: { get: async () => boum() } }), RELEVE);
    assert.deepEqual([agents.agentRules, agents.mcpOuExtension, agents.profilSansConfirmation, agents.plancherVerifie], [null, false, false, true]);
    assert.equal(activationRefusal(agents), "regle-allow");
    // Outils non relevés (GET /config muet) : tenus pour déclarés.
    const tools = await collectActivationFacts(
      factsDeps({ client: { request: async (_m, p) => (p === "/config" ? boum() : ({ permission: PRUDENT } as never)) } }),
      RELEVE,
    );
    assert.equal(tools.mcpOuExtension, true);
    assert.equal(activationRefusal({ ...tools, agentRules: [] }), "mcp-ou-extension");
    // Profil non vérifiable : réponse inattendue, puis lecture en échec.
    for (const reponse of [async () => "pas un objet" as never, async () => boum()]) {
      const profil = await collectActivationFacts(factsDeps({ client: { request: async (_m, p) => (p === "/config" ? ({} as never) : reponse()) } }), RELEVE);
      assert.equal(profil.profilSansConfirmation, true);
      assert.equal(activationRefusal({ ...profil, agentRules: [] }), "profil-sans-confirmation");
    }
    // Port du plancher en échec : session tenue pour non vérifiée.
    const plancher = await collectActivationFacts(
      factsDeps({ ports: { floors: { verified: async () => boum(), createWithFloor: async () => assert.fail("jamais") } } }),
      RELEVE,
    );
    assert.equal(plancher.plancherVerifie, false);
    assert.equal(activationRefusal({ ...plancher, agentRules: [] }), "plancher-non-verifie");
  });

  it("aucun assistant visé : liste vide (rien à reprocher) ; assistant absent de la liste : illisible", async () => {
    const deps = factsDeps();
    assert.deepEqual((await collectActivationFacts(deps, { ...RELEVE, agent: null })).agentRules, []);
    assert.deepEqual((await collectActivationFacts(deps, { ...RELEVE, agent: "" })).agentRules, []);
    assert.equal((await collectActivationFacts(deps, RELEVE)).agentRules, null);
  });
});

// --- Porte I1 -----------------------------------------------------------------------------------------------------------------

describe("activation : porte I1 (ACTIVATION_OUVERTE)", () => {
  it("fermée, configuration parfaitement conforme : le port répond comme le port neutre, sans aucune lecture, et n'inscrit aucun crochet", async (t) => {
    const { h } = await start(t, { ouverte: false });
    // La constante du dépôt, lue par le module : ce test échoue si la bascule est faite sans lui.
    assert.equal(h.cockpit.c11.activationOuverte, false);
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.kind === "hook").map((r) => `${r.key}/${r.module}`),
      ["createSession/floors", "sessionCreated/floors", "beforeBilledSend/floors"],
    );
    const root = await conversation(h);

    const before = h.fake.requests.length;
    const verdict = await check(h, root);
    assert.deepEqual(verdict, { ok: false, raison: "a-venir" });
    assert.deepEqual(verdict, await neutralActivation().check({ rootId: root.id, choix: "autonome", agent: root.agent, directory: root.directory }));
    assert.equal(h.fake.requests.length, before, "porte fermée : rien n'est demandé à opencode");

    for (const choix of ["modifications", "autonome"] as const) {
      const res = await putChoice(h, root.id, { choix });
      assert.equal(res.status, 409, res.body);
      assert.deepEqual(res.json(), refus("a-venir"));
    }
    const vue = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.deepEqual(vue.json<ConversationAutonomyView>().disponibles, [
      { choix: "demander", disponible: true, raison: null },
      { choix: "modifications", disponible: false, raison: "a-venir" },
      { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
      { choix: "autonome", disponible: false, raison: "a-venir" },
    ]);
    // Phrase fixée par le contrat de « a-venir » (autonomy-types.ts), rendue à l'identique par les deux modules de textes.
    assert.equal(raisonRefus("a-venir"), "Pas encore disponible dans cette version du cockpit.");
    assert.equal(raisonIndisponible("a-venir"), raisonRefus("a-venir"));
    h.assertNoGlobalRestart();
  });

  it("ouverte : le crochet d'envoi est inscrit au rang « activation », après le plancher", async (t) => {
    const { h } = await start(t);
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.kind === "hook" && r.key === "beforeBilledSend").map((r) => r.module),
      ["floors", "activation"],
    );
    h.assertNoGlobalRestart();
  });
});

// --- Verdicts réels ---------------------------------------------------------------------------------------------------------

describe("activation : verdicts réels (porte ouverte)", () => {
  it("configuration conforme : les deux choix automatiques s'activent ; l'exception « bash pwd » ne refuse pas", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    // Profil livré : bash « pwd » est sur allow, seule exception du §4.10.
    assert.deepEqual(h.fake.globalConfig.permission, PRUDENT);
    assert.deepEqual(await check(h, root, "modifications"), { ok: true });
    assert.deepEqual(await check(h, root), { ok: true });

    const res = await putChoice(h, root.id, { choix: "modifications" });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json<ConversationAutonomyView>().choix, "modifications");
    const auto = await putChoice(h, root.id, { choix: "autonome" });
    assert.equal(auto.status, 200, auto.body);
    assert.equal(auto.json<ConversationAutonomyView>().choix, "autonome");
    assert.deepEqual(factsOf(h, root.id), [
      { rootId: root.id, data: { choix: "modifications", cause: "clic" } },
      { rootId: root.id, data: { choix: "autonome", cause: "clic" } },
    ]);
    h.assertNoGlobalRestart();
  });

  it("une règle « allow » de l'assistant refuse l'activation ; règles illisibles de même", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    const cas: Array<{ nom: string; permission: Record<string, unknown> }> = [
      { nom: "edit", permission: { ...PRUDENT, edit: "allow" } },
      { nom: "bash hors pwd", permission: { ...PRUDENT, bash: { "*": "ask", pwd: "allow", "git status": "allow" } } },
      { nom: "bash", permission: { ...PRUDENT, bash: "allow" } },
      { nom: "task", permission: { ...PRUDENT, task: "allow" } },
      { nom: "webfetch", permission: { ...PRUDENT, webfetch: "allow" } },
      { nom: "websearch", permission: { ...PRUDENT, websearch: "allow" } },
    ];
    for (const { nom, permission } of cas) {
      globalPermission(h, permission);
      assert.deepEqual(await check(h, root), { ok: false, raison: "regle-allow" }, nom);
      const res = await putChoice(h, root.id, { choix: "autonome" });
      assert.equal(res.status, 409, nom);
      assert.deepEqual(res.json(), refus("regle-allow"), nom);
    }
    // Assistant absent de GET /agent : ses droits ne se lisent pas, l'activation est refusée de la même façon (jamais devinée).
    globalPermission(h, PRUDENT);
    h.fake.setAgents([]);
    h.deps.lookup.invalidate();
    assert.deepEqual(await check(h, root), { ok: false, raison: "regle-allow" }, "assistant inconnu");

    assert.equal(raisonRefus("regle-allow"), TEXTES.partout.refusActivation["regle-allow"]);
    assert.notEqual(raisonRefus("regle-allow"), raisonIndisponible("regle-allow"));
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    h.assertNoGlobalRestart();
  });

  it("aucun assistant rapporté : l'activation n'est pas refusée sur ce motif (l'envoi la réévalue)", async (t) => {
    const { h } = await start(t);
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Neuve" } });
    assert.equal(created.status, 200, created.body);
    const { id } = created.json<{ id: string }>();
    const row = await until(() => h.sessions.get(id));
    assert.equal(row.agent, null);
    assert.deepEqual(await check(h, row), { ok: true });
    h.assertNoGlobalRestart();
  });

  it("serveurs MCP ou extensions déclarés : activation refusée ; relevé impossible aussi", async (t) => {
    const { h, client } = await start(t);
    const root = await conversation(h);
    const base = { ...h.fake.globalConfig };

    h.fake.globalConfig = { ...base, mcp: { local: { type: "local", command: ["serveur-mcp"], enabled: false } } };
    assert.deepEqual(await check(h, root), { ok: false, raison: "mcp-ou-extension" }, "mcp déclaré, même désactivé");
    const res = await putChoice(h, root.id, { choix: "modifications" });
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), refus("mcp-ou-extension"));

    h.fake.globalConfig = base;
    h.fake.projectConfigs.set(root.directory, { plugin: ["file:///workspace/.opencode/plugins/ecrit.js"] });
    assert.deepEqual(await check(h, root), { ok: false, raison: "mcp-ou-extension" }, "extension déclarée");
    h.fake.projectConfigs.clear();
    assert.deepEqual(await check(h, root), { ok: true }, "relevé de nouveau conforme");

    // Relevé impossible : refus, jamais un « aucun » deviné (P1).
    client.fail.add("GET /config");
    assert.deepEqual(await check(h, root), { ok: false, raison: "mcp-ou-extension" }, "configuration illisible");
    client.fail.clear();

    assert.equal(raisonRefus("mcp-ou-extension"), TEXTES.partout.refusActivation["mcp-ou-extension"]);
    h.assertNoGlobalRestart();
  });

  it("profil « Sans confirmation (déconseillé) » actif : activation refusée ; profil non vérifiable aussi", async (t) => {
    const { h, client } = await start(t);
    const root = await conversation(h);
    // Assistants gardés conformes : seul le profil global change, sinon « regle-allow » l'emporterait (ordre du §4.11).
    h.fake.setAgents(nativeAgents(PRUDENT));
    globalPermission(h, PERMISSION_PRESETS.autonome.permission);
    assert.deepEqual(await check(h, root), { ok: false, raison: "profil-sans-confirmation" });
    const res = await putChoice(h, root.id, { choix: "autonome" });
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), refus("profil-sans-confirmation"));

    globalPermission(h, PRUDENT);
    assert.deepEqual(await check(h, root), { ok: true }, "profil revenu au profil livré");
    client.fail.add("GET /global/config");
    assert.deepEqual(await check(h, root), { ok: false, raison: "profil-sans-confirmation" }, "profil non vérifiable");
    client.fail.clear();

    assert.equal(raisonRefus("profil-sans-confirmation"), TEXTES.partout.refusActivation["profil-sans-confirmation"]);
    h.assertNoGlobalRestart();
  });

  it("plancher de la conversation non vérifié : activation refusée", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    h.db.prepare("UPDATE sessions SET plancher = NULL WHERE id = ?").run(root.id);
    assert.deepEqual(await check(h, root), { ok: false, raison: "plancher-non-verifie" });
    const res = await putChoice(h, root.id, { choix: "autonome" });
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), refus("plancher-non-verifie"));
    assert.equal(raisonRefus("plancher-non-verifie"), TEXTES.partout.refusActivation["plancher-non-verifie"]);
    h.assertNoGlobalRestart();
  });
});

// --- Interrupteur, confirmation et plafonds (logique L6a, nourrie par le port) -------------------------------------------------

describe("activation : interrupteur, confirmation et plafonds", () => {
  it("COCKPIT_AUTONOMY=off : 403 autonomie-coupee pour les deux choix automatiques, « demander » reste possible", async (t) => {
    const { h } = await start(t, { env: { autonomy: false } });
    const root = await conversation(h);
    for (const choix of ["modifications", "autonome"] as const) {
      const res = await putChoice(h, root.id, { choix });
      assert.equal(res.status, 403, res.body);
      assert.deepEqual(res.json(), { error: "autonomie-coupee", message: raisonIndisponible("autonomie-coupee"), raison: "autonomie-coupee" });
    }
    assert.equal((await putChoice(h, root.id, { choix: "demander" })).status, 200);
    // L'interrupteur est aussi un fait de l'activation : le port ne peut jamais ouvrir un choix automatique sans lui.
    assert.deepEqual(await check(h, root), { ok: false, raison: "autonomie-coupee" });
    h.assertNoGlobalRestart();
  });

  it("relâcher sans x-cockpit-confirm : 428 ; resserrer : immédiat", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    for (const choix of ["modifications", "autonome"] as const) {
      const res = await putChoice(h, root.id, { choix }, h.headers.mutating);
      assert.equal(res.status, 428, res.body);
      assert.deepEqual(res.json(), { error: "confirmation-requise", message: CHOIX.partout.erreurs.confirmation });
    }
    assert.equal((await putChoice(h, root.id, { choix: "autonome" })).status, 200);
    const resserre = await putChoice(h, root.id, { choix: "modifications" }, h.headers.mutating);
    assert.equal(resserre.status, 200, resserre.body);
    assert.equal(resserre.json<ConversationAutonomyView>().choix, "modifications");
    h.assertNoGlobalRestart();
  });

  it("plafonds : bornés par plafondMaxUsd ; une valeur au-delà est refusée par le serveur", async (t) => {
    const { h } = await start(t, { settings: { budget: { autonomie: { plafondUsd: 1, plafondMaxUsd: 2 } } } });
    const root = await conversation(h);
    const trop = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 2.5 } });
    assert.equal(trop.status, 400, trop.body);
    assert.equal(trop.json<{ error: string }>().error, "invalid");
    const ok = await putChoice(h, root.id, { choix: "autonome", plafonds: { plafondUsd: 2 } });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json<ConversationAutonomyView>().plafonds.plafondUsd, 2);
    // Plafond maximal abaissé après coup : la vue borne celui de la conversation, sans réécriture.
    h.settings.update({ budget: { autonomie: { plafondMaxUsd: 1.5 } } });
    const vue = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(vue.json<ConversationAutonomyView>().plafonds.plafondUsd, 1.5);
    h.assertNoGlobalRestart();
  });
});

// --- Crochet d'envoi --------------------------------------------------------------------------------------------------------

describe("activation : crochet beforeBilledSend", () => {
  it("assistant visé non conforme : 409 avec la phrase exacte, retour à « demander », fait « choix » écrit, rien de relayé", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    assert.equal((await putChoice(h, root.id, { choix: "autonome" })).status, 200);
    h.fake.setAgents([...h.fake.agents(), SANS_DEMANDE]);
    h.deps.lookup.invalidate();

    const avant = prompts(h);
    const res = await send(h, root.id, SANS_DEMANDE.name);
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonRefus("regle-allow"), raison: "regle-allow" });
    assert.equal(prompts(h), avant, "aucun envoi relayé");

    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    const vue = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(vue.json<ConversationAutonomyView>().retourCause, "agent-non-conforme");
    assert.deepEqual(factsOf(h, root.id).at(-1), { rootId: root.id, data: { choix: "demander", cause: "agent-non-conforme" } });
    assert.deepEqual(
      h
        .cockpitEvents()
        .filter((e) => e.type === "autonomie.choix")
        .at(-1),
      { type: "autonomie.choix", data: { rootId: root.id, choix: "demander", cause: "agent-non-conforme" } },
    );
    h.assertNoGlobalRestart();
  });

  it("aucun assistant dans le corps de l'envoi : celui de la session est vérifié", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    assert.equal((await putChoice(h, root.id, { choix: "modifications" })).status, 200);
    globalPermission(h, { ...PRUDENT, edit: "allow" });
    const res = await h.call("POST", `/api/oc/session/${root.id}/prompt_async`, {
      headers: h.headers.mutating,
      body: { model: MODEL, parts: [{ type: "text", text: "Continue." }] },
    });
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonRefus("regle-allow"), raison: "regle-allow" });
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    h.assertNoGlobalRestart();
  });

  it("assistant conforme ou choix non automatique : l'envoi part, aucun retour à « demander »", async (t) => {
    const { h } = await start(t);
    const root = await conversation(h);
    assert.equal((await putChoice(h, root.id, { choix: "autonome" })).status, 200);
    const passe = await send(h, root.id);
    assert.equal(passe.status, 204, passe.body);
    await within(h.fake.settled(root.id), "réponse du faux terminée");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "autonome");

    // Choix « demander » : le crochet ne relève rien, même avec un assistant qui agit sans demander.
    const ordinaire = await conversation(h);
    h.fake.setAgents([...h.fake.agents(), SANS_DEMANDE]);
    h.deps.lookup.invalidate();
    const libre = await send(h, ordinaire.id, SANS_DEMANDE.name);
    assert.equal(libre.status, 204, libre.body);
    await within(h.fake.settled(ordinaire.id), "réponse du faux terminée");
    assert.deepEqual(factsOf(h, ordinaire.id), []);
    h.assertNoGlobalRestart();
  });
});
