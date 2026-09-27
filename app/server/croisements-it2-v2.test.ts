// Tests de croisement du train it2 V2 (plan d'exécution §2.3, §2.6, §5.2 ; propriété de l'intégrateur) : L10d (activation des
// choix automatiques) et L10a (cycle d'une décision et demandes autonomes), sur le câblage complet (modules « tous »). Chaque
// paquet a testé ses modules seul, avec le port de l'autre surchargé ; ce que la vague doit prouver ensemble :
//   1. porte I1 FERMÉE en production : le module d'activation réel n'inscrit aucun crochet, ne lit rien d'opencode et rend
//      exactement le refus du port neutre (« a-venir ») ; les deux choix automatiques restent refusés par L6a ;
//   2. le cycle (L10a) interroge le port d'activation RÉEL (L10d), et non plus une surcharge : même avec un choix forcé à
//      « Autonome », une commande qui serait consultée automatiquement reste à l'utilisateur, avec « a-venir », et rien n'est
//      envoyé à opencode. C'est la garantie de production tant que la constante vaut false ;
//   3. répétition générale de la BASCULE de la vague 3 (même câblage, porte ouverte par la fabrique exportée, jamais par
//      wiring-11.ts) : le crochet d'activation s'inscrit AVANT celui des demandes ; « PUT autonome » confirmé → 200 (le test
//      demandé par le §2.6) ; une configuration conforme décide la commande automatiquement, avec exactement une réponse
//      « once » ; un assistant non conforme à l'envoi est refusé 409 par L10d avant que L10a n'ouvre sa demande, et rien n'est
//      relayé. Ce fichier est donc le témoin que la bascule d'`ACTIVATION_OUVERTE` se fera en une ligne, plus trois listes
//      d'inscriptions à corriger (voir l'avertissement ci-dessous) ;
//   4. examen en cours (L10a) × garde de rechargement (L1a) : `examining()` réel rend la garde occupée, et le redémarrage
//      d'opencode est refusé 409 tant que l'examen dure.
// L'exécution d'un plan en choix automatique (428 puis 409 « a-venir ») est déjà jouée sur le câblage complet par
// croisements-it1-v3.test.ts, qui installe désormais le module d'activation réel : elle n'est pas redite ici.
// Les deux états de la porte passent par installActivation, comme dans les tests de L10d.
//
// BASCULE D'`ACTIVATION_OUVERTE` FAITE au train de la vague 3 de l'itération 2 (20/09/2026) ; la liste laissée ici par le train
// de la vague 2 a été suivie au même commit :
//   a. { kind: "hook", key: "beforeBilledSend", module: "activation" } ajouté après « plans » dans les deux listes exhaustives
//      des inscriptions de production (wiring-11.test.ts, suite « production (tous les modules réels) » ; et
//      croisements-it1-v0.test.ts), compte beforeBilledSend porté de 3 à 4 ;
//   b. la première suite de CE fichier décrit la porte FERMÉE : elle est retournée, non retirée — elle tourne désormais sur
//      TOUS_PORTE_FERMEE, le câblage de production avec la seule porte refermée, et reste vraie point par point ;
//   c. la deuxième suite est restée vraie telle quelle : elle joue le câblage de production, porte ouverte, qui est maintenant
//      celui du dépôt. Le avant/après de la CONSTANTE elle-même est tenu par croisements-it2-v3.test.ts.
// Aucun appel facturé : faux opencode seulement (porte des exécutions facturées FERMÉE).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { installActivation, neutralActivation } from "./autonomy-activation.ts";
import type { ActivationPort, Cockpit11Module, ConversationAutonomyPort, ModuleName } from "./contracts-11.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";
import { raisonIndisponible } from "./shared/autonomy-choice-texts.ts";
import { raisonRefus } from "./shared/autonomy-texts.ts";
import type { AutonomyChoice, ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, type FakePermissionRequest, type FakeSession, type FakeToolScript, rulesFromConfig } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";
import { ACTIVATION_OUVERTE, MODULE_ORDER } from "./wiring-11.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const DOSSIER = "/workspace/proj";
const FIN = "Synthèse du faux opencode.";
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  "",
].join(NL);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Le module livré, mais porte ouverte : la fabrique reçoit `true` au lieu de c11.activationOuverte (plan §2.6, fiche L10d). */
const MODULE_OUVERT: Cockpit11Module = {
  name: "activation",
  install: (reg, c11) => void installActivation(reg, c11, { activationOuverte: true }),
};

/** Le câblage de production, à ceci près que la porte I1 est ouverte : ce que la bascule de la vague 3 a donné. */
const TOUS_PORTE_OUVERTE: ReadonlyArray<ModuleName | Cockpit11Module> = MODULE_ORDER.map((name) => (name === "activation" ? MODULE_OUVERT : name));

/** Le même module, porte FERMÉE : depuis la bascule du train de la vague 3, c'est par la fabrique que la porte se referme. */
const MODULE_FERME: Cockpit11Module = {
  name: "activation",
  install: (reg, c11) => void installActivation(reg, c11, { activationOuverte: false }),
};

/** Le câblage de production d'AVANT la bascule : ce que le cockpit rendrait si la porte I1 était refermée (§2.6). */
const TOUS_PORTE_FERMEE: ReadonlyArray<ModuleName | Cockpit11Module> = MODULE_ORDER.map((name) => (name === "activation" ? MODULE_FERME : name));

/** Assistant qui agit déjà sans demander : refusé par le §4.10, quel que soit le profil global (même agent que les tests L10d). */
const SANS_DEMANDE: FakeAgent = {
  name: "sans-demande",
  mode: "primary",
  options: {},
  permission: rulesFromConfig({ "*": "allow", edit: "allow", bash: "allow", task: "allow", webfetch: "allow", websearch: "allow" }),
};

// --- Workspace et harnais -----------------------------------------------------------------------------------------------------

/** Workspace réel monté en /workspace : `proj` = dossier de la conversation, avec un dépôt git sain (faits de la porte shell). */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-it2-v2-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": CLEAN_GIT_CONFIG,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

/** Port `conversationAutonomy` surchargé : seul moyen de tenir un choix automatique tant que la porte I1 est fermée (§2.2, §2.6). */
function choicePort(choices: Map<string, AutonomyChoice>): ConversationAutonomyPort {
  return {
    get: async () => null,
    choiceOf: (id) => choices.get(id) ?? "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

/**
 * Port d'activation qui retient l'examen jusqu'à `release()` : l'examen dure, la garde de rechargement peut être interrogée.
 *
 * `laisserPasser` : nombre de vérifications rendues tout de suite AVANT de retenir. Depuis la bascule de la porte I1 (train de
 * la vague 3), le crochet d'envoi de L10d consulte ce MÊME port pour vérifier l'assistant visé : retenir dès le premier appel
 * bloquerait l'envoi lui-même, et le cockpit n'atteindrait jamais l'examen. On laisse donc passer la vérification de l'envoi.
 */
function activationBarrier(laisserPasser = 0): { port: ActivationPort; reached: Promise<void>; release: () => void } {
  const hit = Promise.withResolvers<void>();
  const open = Promise.withResolvers<void>();
  let restant = laisserPasser;
  return {
    port: {
      check: async () => {
        if (restant > 0) {
          restant -= 1;
          return { ok: true };
        }
        hit.resolve();
        await open.promise;
        return { ok: true };
      },
    },
    reached: hit.promise,
    release: () => open.resolve(),
  };
}

async function start(t: TestContext, options: CockpitHarnessOptions & { root?: string } = {}): Promise<CockpitHarness> {
  const { root, ...rest } = options;
  return startCockpit(t, { modules: "tous", ...rest, env: { workspaceDir: root ?? workspace(t), ...(rest.env ?? {}) } });
}

/** Conversation créée par le proxy dans `directory` (plancher posé par L3), suivie par le cockpit. */
async function conversation(h: CockpitHarness, title: string, directory = DOSSIER): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

const sendRaw = (h: CockpitHarness, session: FakeSession, body: Record<string, unknown>) =>
  h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${encodeURIComponent(session.directory)}`, { headers: h.headers.mutating, body });

async function send(h: CockpitHarness, session: FakeSession, tools: FakeToolScript[], agent = "build"): Promise<void> {
  h.fake.script(session.id, { tools, followUp: { text: FIN } });
  const sent = await sendRaw(h, session, { agent, model: MODEL, parts: [{ type: "text", text: "Travaille." }] });
  assert.equal(sent.status, 204, sent.body);
}

/** Envoie et rend la demande d'autorisation posée par le premier outil. */
async function ask(h: CockpitHarness, session: FakeSession, tool: FakeToolScript): Promise<FakePermissionRequest> {
  const since = h.fake.emitted.length;
  await send(h, session, [tool]);
  const event = await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since });
  return event.properties as unknown as FakePermissionRequest;
}

/** Conversation dont opencode a rapporté l'assistant (l'activation lit les règles de cet assistant-là). */
async function withAgent(h: CockpitHarness, title: string, agent = "build"): Promise<FakeSession> {
  const session = await conversation(h, title);
  await send(h, session, []);
  await within(h.fake.settled(session.id), "réponse du faux terminée");
  await until(() => h.sessions.get(session.id)?.agent === agent);
  return session;
}

// --- Lectures -----------------------------------------------------------------------------------------------------------------

interface DecisionRow {
  permission_id: string | null;
  verdict: string;
  regle: string;
  par: string;
  relais: string | null;
}

const decisions = (h: CockpitHarness): DecisionRow[] =>
  h.db.prepare("SELECT permission_id, verdict, regle, par, relais FROM autonomy_decisions ORDER BY id").all() as unknown as DecisionRow[];

const decisionOf = (h: CockpitHarness, permissionId: string): Promise<DecisionRow> => until(() => decisions(h).find((row) => row.permission_id === permissionId));

/** Réponses d'autorisation réellement envoyées à opencode. */
const replies = (h: CockpitHarness): Array<{ id: string; body: unknown }> =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/")).map((r) => ({ id: r.pathname.split("/")[2] ?? "", body: r.body }));

const repliesTo = (h: CockpitHarness, permissionId: string): unknown[] => replies(h).filter((r) => r.id === permissionId).map((r) => r.body);

/** P4 : ni « allow », ni « ask », ni « always » ; l'autonomie n'envoie jamais de refus non plus. */
function assertNeverForbidden(h: CockpitHarness): void {
  for (const reply of replies(h)) {
    const value = isRecord(reply.body) ? reply.body.reply : null;
    assert.equal(value, "once", `réponse interdite envoyée : ${JSON.stringify(reply.body)}`);
  }
  h.assertNoGlobalRestart();
}

/** Lectures d'opencode que le relevé d'activation ferait (activation-facts.ts) : elles doivent rester à zéro porte fermée. */
const activationReads = (h: CockpitHarness): number =>
  h.fake.requests.filter((r) => r.method === "GET" && ["/agent", "/config", "/global/config"].includes(r.pathname)).length;

/**
 * Inscription du câblage, lue sans dépendre du champ `instances` que T3b ajoutera (plan 2 bis §4.2, D-2b-40) : une inscription
 * qui ne le porte pas sert l'instance principale.
 */
interface Inscription {
  kind: string;
  key: string;
  module: string;
  instances?: readonly string[];
}

/**
 * Ouverture 2bis-V2 : les listes de crochets de ce fichier ne comparent que les inscriptions de l'instance PRINCIPALE. Sans ce
 * filtre, elles tombaient dès que la salle inscrivait omoActivation puis omoCaps sur `beforeBilledSend` (§4.1.2, L22c et L22d),
 * dans un fichier de croisement qu'aucun paquet n'a le droit de corriger. Les listes attendues, elles, ne bougent pas.
 */
const sertPrincipale = (r: Inscription): boolean => (r.instances ?? ["principale"]).includes("principale");

/** Modules inscrits sur une étape, instance principale seule, dans l'ordre du câblage. */
const crochets = (list: readonly Inscription[], step: string): string[] =>
  list.filter((r) => r.kind === "hook" && r.key === step && sertPrincipale(r)).map((r) => r.module);

const hooksOf = (h: CockpitHarness, step: string): string[] => crochets(h.cockpit.wiring.registrations, step);

const autonomyRequestCount = (h: CockpitHarness, rootId: string): number =>
  (h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_requests WHERE root_id = ?").get(rootId) as { n: number }).n;

const url = (rootId: string) => `/api/conversations/${rootId}/autonomie`;

const putChoice = (h: CockpitHarness, rootId: string, choix: string, headers?: Record<string, string>) =>
  h.call("PUT", url(rootId), { headers: headers ?? h.headers.confirmed, body: { choix } });

// --- 1. Porte I1 fermée sur le câblage complet ----------------------------------------------------------------------------------

describe("croisements it2 V2 : porte I1 fermée sur le câblage complet (L10d × L6a × L10a)", () => {
  it("le module d'activation réel reste inerte : aucun crochet inscrit, aucune lecture d'opencode, le refus du port neutre au code près ; les deux choix automatiques restent 409 « a-venir »", async (t) => {
    // Bascule faite au train de la vague 3 : la porte fermée se joue désormais par la fabrique (TOUS_PORTE_FERMEE), et la
    // constante du dépôt vaut true. Ce que cette suite décrit reste vrai de la porte fermée, point par point.
    const h = await start(t, { modules: TOUS_PORTE_FERMEE });
    assert.equal(ACTIVATION_OUVERTE, true, "la constante du dépôt est basculée depuis le train de la vague 3");
    // Le crochet d'envoi du paquet L10a (rang « requests ») est là ; celui de l'activation ne l'est pas tant que la porte est
    // fermée. À la bascule, « activation » s'insère entre « plans » et « requests » (avertissement en tête de fichier, point a).
    // <c5:crochets-it2>
    // Grande fusion (GF4) : le câblage complet porte aussi la construction, dont le crochet de la Seconde lecture est le PREMIER
    // de beforeBilledSend (il ne refuse jamais, wiring-construction.ts). Le rang de l'activation par rapport à « plans » et
    // « requests », que cette suite éprouve, ne change pas.
    assert.deepEqual(hooksOf(h, "beforeBilledSend"), ["secondReading", "floors", "plans", "requests"]);
    // Non-régression de l'ouverture 2bis-V2 : un crochet de la salle sort de la liste, un crochet de l'instance principale y reste.
    const inscriptions: readonly Inscription[] = h.cockpit.wiring.registrations;
    assert.deepEqual(crochets([...inscriptions, { kind: "hook", key: "beforeBilledSend", module: "omoCaps", instances: ["omo"] }], "beforeBilledSend"), [
      "secondReading",
      "floors",
      "plans",
      "requests",
    ]);
    assert.deepEqual(crochets([...inscriptions, { kind: "hook", key: "beforeBilledSend", module: "autre" }], "beforeBilledSend"), [
      "secondReading",
      "floors",
      "plans",
      "requests",
      "autre",
    ]);
    // </c5:crochets-it2>

    const root = await withAgent(h, "Porte fermée");
    const lectures = activationReads(h);
    const neutre = await neutralActivation().check({ rootId: root.id, choix: "autonome", agent: "build", directory: DOSSIER });
    const reel = await h.cockpit.c11.ports.activation.check({ rootId: root.id, choix: "autonome", agent: "build", directory: DOSSIER });
    assert.deepEqual(reel, neutre, "le port réel répond exactement comme le port neutre");
    assert.deepEqual(reel, { ok: false, raison: "a-venir" });

    for (const choix of ["modifications", "autonome"]) {
      const res = await putChoice(h, root.id, choix);
      assert.equal(res.status, 409, `${choix} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonIndisponible("a-venir"), raison: "a-venir" });
    }
    assert.equal(activationReads(h), lectures, "aucune lecture d'opencode pour un verdict connu d'avance");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    const vue = await h.call("GET", url(root.id), { headers: h.headers.authed });
    const disponibles = vue.json<ConversationAutonomyView>().disponibles;
    for (const choix of ["modifications", "autonome"] as const) {
      assert.deepEqual(disponibles.find((entry) => entry.choix === choix), { choix, disponible: false, raison: "a-venir" }, choix);
    }
    h.assertNoGlobalRestart();
  });

  it("le cycle (L10a) sur le port d'activation réel : même en « Autonome » forcé, une commande consultée reste à l'utilisateur avec « a-venir » ; rien n'est envoyé", async (t) => {
    const choices = new Map<string, AutonomyChoice>();
    const h = await start(t, { modules: TOUS_PORTE_FERMEE, ports: { conversationAutonomy: choicePort(choices) } });
    const conv = await conversation(h, "Autonome forcé");
    choices.set(conv.id, "autonome");

    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    // Sans la porte, `grep` dans le dossier serait A-grep : la pré-condition d'activation passe avant l'aiguillage.
    assert.deepEqual([decision.verdict, decision.regle, decision.par, decision.relais], ["attente", "a-venir", "cockpit", null]);
    assert.deepEqual(repliesTo(h, request.id), [], "aucune réponse envoyée à opencode");
    // La demande autonome, elle, a bien été ouverte par L10a : la pré-condition franchie est bien celle de l'activation.
    assert.equal(autonomyRequestCount(h, conv.id), 1);
    assertNeverForbidden(h);
  });
});

// --- 2. Répétition générale de la bascule ---------------------------------------------------------------------------------------

describe("croisements it2 V2 : répétition générale de la bascule (porte ouverte, câblage complet)", () => {
  it("le crochet d'activation s'inscrit avant celui des demandes, et « PUT autonome » confirmé rend 200 (§2.6)", async (t) => {
    const h = await start(t, { modules: TOUS_PORTE_OUVERTE });
    assert.equal(ACTIVATION_OUVERTE, true, "la porte du dépôt est ouverte depuis la bascule du train de la vague 3");
    // <c5:crochets-it2-ouverte>
    // Grande fusion (GF4) : la Seconde lecture de la construction en tête, puis l'ordre de l'itération 2, inchangé.
    assert.deepEqual(hooksOf(h, "beforeBilledSend"), ["secondReading", "floors", "plans", "activation", "requests"]);
    // </c5:crochets-it2-ouverte>

    const root = await withAgent(h, "Porte ouverte");
    const sans = await putChoice(h, root.id, "autonome", h.headers.mutating);
    assert.equal(sans.status, 428, sans.body);
    assert.equal(sans.json<{ error: string }>().error, "confirmation-requise");
    const res = await putChoice(h, root.id, "autonome");
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json<ConversationAutonomyView>().choix, "autonome");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "autonome");
    h.assertNoGlobalRestart();
  });

  it("configuration conforme : la commande consultée est décidée automatiquement, exactement une réponse « once », un fait et une ligne", async (t) => {
    const h = await start(t, { modules: TOUS_PORTE_OUVERTE });
    const root = await withAgent(h, "Autonome, porte ouverte");
    assert.equal((await putChoice(h, root.id, "autonome")).status, 200);

    const request = await ask(h, root, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par, decision.relais], ["auto", "A-grep", "regles", "ok"]);
    await until(() => repliesTo(h, request.id).length === 1);
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }], "exactement une réponse");
    assert.equal(autonomyRequestCount(h, root.id), 1, "une demande autonome ouverte par L10a");
    assertNeverForbidden(h);
  });

  it("assistant non conforme à l'envoi : L10d refuse 409 avant L10a, aucune demande autonome n'est ouverte et rien n'est relayé", async (t) => {
    const h = await start(t, { modules: TOUS_PORTE_OUVERTE });
    const root = await withAgent(h, "Assistant qui change");
    assert.equal((await putChoice(h, root.id, "autonome")).status, 200);
    h.fake.setAgents([...h.fake.agents(), SANS_DEMANDE]);
    h.deps.lookup.invalidate();

    const demandes = autonomyRequestCount(h, root.id);
    const envois = h.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async")).length;
    const res = await sendRaw(h, root, { agent: SANS_DEMANDE.name, model: MODEL, parts: [{ type: "text", text: "Continue." }] });
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), { error: "autonomie-indisponible", message: raisonRefus("regle-allow"), raison: "regle-allow" });
    assert.equal(h.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async")).length, envois, "aucun envoi relayé");
    assert.equal(autonomyRequestCount(h, root.id), demandes, "aucune demande autonome ouverte : le crochet d'activation passe avant celui des demandes");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    const vue = await h.call("GET", url(root.id), { headers: h.headers.authed });
    assert.equal(vue.json<ConversationAutonomyView>().retourCause, "agent-non-conforme");
    assertNeverForbidden(h);
  });
});

// --- 3. Examen en cours × garde de rechargement -----------------------------------------------------------------------------------

describe("croisements it2 V2 : examen en cours (L10a) × garde de rechargement (L1a)", () => {
  it("pendant l'examen, reloadBusy est vrai et le redémarrage d'opencode est refusé 409 ; l'examen fini, la garde se rouvre", async (t) => {
    // 1 : la vérification du crochet d'envoi (L10d, porte ouverte) passe ; c'est celle du cycle (L10a) qui est retenue.
    const barrier = activationBarrier(1);
    const choices = new Map<string, AutonomyChoice>();
    const h = await start(t, { ports: { conversationAutonomy: choicePort(choices), activation: barrier.port } });
    const conv = await conversation(h, "Examen en cours");
    choices.set(conv.id, "autonome");
    assert.equal(h.cockpit.c11.reloadBusy(), false, "au repos avant l'examen");

    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    await within(barrier.reached, "examen commencé");
    assert.equal(h.cockpit.c11.ports.autonomy.examining(), true);
    assert.equal(h.cockpit.c11.reloadBusy(), true);
    // Mode Simple : refus sans dérogation proposée ; aucun redémarrage n'est demandé (P6).
    for (const headers of [h.headers.mutating, h.headers.confirmed]) {
      const res = await h.call("POST", "/api/system/restart-opencode", { headers });
      assert.equal(res.status, 409, res.body);
      assert.deepEqual(res.json(), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
    }

    barrier.release();
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle], ["auto", "A-grep"]);
    await until(() => h.cockpit.c11.ports.autonomy.examining() === false);
    assert.equal(h.cockpit.c11.reloadBusy(), false, "la garde se rouvre à la fin de l'examen");
    assertNeverForbidden(h);
  });
});
