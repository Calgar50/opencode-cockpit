// Tests de croisement du train it2 V3 (plan d'exécution §2.3, §2.6, §5.2, ligne « V4 » du tableau des vagues ; propriété de
// l'intégrateur) : L10c (plafonds, « Passé sans contrôle », redémarrages), L10e (délégation en Autonome), L12a, L12b et L12c
// (sélecteur, bandeau, Journal), sur le câblage complet (modules « tous »), porte I1 BASCULÉE au train de cette vague.
// Chaque paquet a testé ses modules seul, avec les ports des autres surchargés ; ce que la vague doit prouver ensemble :
//   1. la BASCULE d'`ACTIVATION_OUVERTE` : en production, « PUT autonome » sans en-tête → 428, confirmé → 200 ; porte refermée
//      (par la fabrique) → 409 « a-venir ». C'est le test demandé par le §2.6, joué sur le câblage du dépôt, pas sur une
//      surcharge ;
//   2. plafond de coût (L10c) × arrêt de l'arbre (L1c) × choix d'autonomie (L6a) × faits (L4b) : la demande est close en
//      `plafond-cout`, l'arbre est arrêté, le fait `statut {cause: plafond}` est écrit, PUIS le choix revient à « Demander à
//      chaque fois » avec `retour_cause` et un fait `choix` ;
//   3. 6e délégation en Autonome (L10e) × surveillance des délégations (L1e) : refus avec message en Simple, attente en Avancé,
//      et l'arrêt de L1e n'est PAS déclenché — la délégation refusée n'est jamais comptée, le plafond de L1e (maxPerRequest)
//      n'est donc jamais dépassé ;
//   4. « différé = direct » sur la fixture d'autonomie (L10a) jouée sur le câblage COMPLET : les faits reçus en direct et ceux
//      relus par la route de L4b donnent la même liste, au fait près, alors que tous les modules de l'itération 2 sont montés.
// La minuterie du sondage de L10c est injectée (aucune minuterie posée pendant les tests) ; l'horloge ne sert pas ici, aucun
// plafond de durée n'est joué. Aucun appel facturé : faux opencode seulement (porte des exécutions facturées FERMÉE).
// P4 : aucune réponse « allow », « ask » ni « always ». P6 : assertNoGlobalRestart à chaque scénario.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { installActivation } from "./autonomy-activation.ts";
import { capWatchModuleWith } from "./autonomy-watch.ts";
import type { Cockpit11Module, ModuleName, PermissionGate } from "./contracts-11.ts";
import type { AppDeps } from "./http.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import { DELEGATION_AUTO_RULE } from "./shared/autonomy-rules.ts";
import type { AutonomyCaps, ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { messageRefusSimple } from "./shared/delegation-texts.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakePermissionRequest, type FakeSession, type FakeToolScript, readCapture } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";
import { ACTIVATION_OUVERTE, MODULE_ORDER } from "./wiring-11.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const DOSSIER = "/workspace/proj";
const FIN = "Synthèse du faux opencode.";
const FIXTURE = "autonomie-p8.jsonl";
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

/** Surveillance des plafonds sans minuterie réelle : les tours de sondage ne servent pas ici, aucune minuterie n'est posée. */
const CAP_WATCH_SANS_MINUTERIE: Cockpit11Module = capWatchModuleWith({ schedule: () => () => undefined });

/** Le câblage du DÉPÔT (porte I1 ouverte depuis la bascule), à la minuterie du sondage près. */
const TOUS: ReadonlyArray<ModuleName | Cockpit11Module> = MODULE_ORDER.map((name) => (name === "capWatch" ? CAP_WATCH_SANS_MINUTERIE : name));

/** Le même câblage, porte I1 REFERMÉE par la fabrique : ce que le cockpit rendait avant la bascule (§2.6). */
const TOUS_PORTE_FERMEE: ReadonlyArray<ModuleName | Cockpit11Module> = TOUS.map((entry) =>
  entry === "activation" ? ({ name: "activation", install: (reg, c11) => void installActivation(reg, c11, { activationOuverte: false }) } as Cockpit11Module) : entry,
);

/** Portillon réel dont le relais répond « ok » : un rejeu n'a aucune demande vivante chez opencode (comme la fixture de L10a). */
const RELAIS_OK = (deps: AppDeps): PermissionGate => {
  const real = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
  return { ...real, relayOnce: async () => "ok" };
};

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  "",
].join(NL);

/** Workspace réel monté en /workspace : `proj` = dossier de la conversation, avec un dépôt git sain (faits de la porte shell). */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-it2-v3-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": CLEAN_GIT_CONFIG,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

async function start(t: TestContext, options: CockpitHarnessOptions & { root?: string } = {}): Promise<CockpitHarness> {
  const { root, ...rest } = options;
  return startCockpit(t, { modules: TOUS, ...rest, env: { workspaceDir: root ?? workspace(t), ...(rest.env ?? {}) } });
}

// --- Conversation, envoi, demandes ----------------------------------------------------------------------------------------------

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

/** Conversation dont opencode a rapporté l'assistant : l'activation réelle lit les règles de cet assistant-là. */
async function withAgent(h: CockpitHarness, title: string, agent = "build"): Promise<FakeSession> {
  const session = await conversation(h, title);
  await send(h, session, []);
  await within(h.fake.settled(session.id), "réponse du faux terminée");
  await until(() => h.sessions.get(session.id)?.agent === agent);
  return session;
}

const url = (rootId: string) => `/api/conversations/${rootId}/autonomie`;

const putChoice = (h: CockpitHarness, rootId: string, body: unknown, headers?: Record<string, string>) =>
  h.call("PUT", url(rootId), { headers: headers ?? h.headers.confirmed, body });

/** Appel `task` qui demande une autorisation (tool/task.ts : patterns = [subagent_type], metadata {description, subagent_type}). */
function task(agent: string, description: string, beforeAsk?: () => Promise<void>): FakeToolScript {
  return {
    tool: "task",
    input: { description, prompt: "Analyse ce dossier.", subagent_type: agent },
    ask: { permission: "task", patterns: [agent], metadata: { description, subagent_type: agent } },
    ...(beforeAsk ? { beforeAsk } : {}),
    child: { agent, text: "Résumé du sous-agent." },
  };
}

// --- Lectures ---------------------------------------------------------------------------------------------------------------------

interface RequestRow {
  id: string;
  root_id: string;
  auto: number;
  delegations: number;
  fin: string | null;
}

const requests = (h: CockpitHarness, rootId: string): RequestRow[] =>
  h.db.prepare("SELECT id, root_id, auto, delegations, fin FROM autonomy_requests WHERE root_id = ? ORDER BY rowid").all(rootId) as unknown as RequestRow[];

const facts = (h: CockpitHarness, rootId: string, kind: string): ActivityFact[] =>
  (h.db.prepare("SELECT * FROM activity_facts WHERE root_id = ? AND kind = ? ORDER BY id").all(rootId, kind) as Array<Record<string, string>>).map(
    (row) => ({ ...row, data: JSON.parse(row.data ?? "{}") }) as unknown as ActivityFact,
  );

/** Faits « statut » d'un arrêt ou d'un plafond (`data.cause`) ; ceux du Déroulé (L4b) portent `etat`. */
const statuts = (h: CockpitHarness, rootId: string): ActivityFact[] => facts(h, rootId, "statut").filter((fact) => fact.data.cause !== undefined);

interface DecisionRow {
  permission_id: string | null;
  permission: string;
  verdict: string;
  regle: string;
  par: string;
  relais: string | null;
}

const decisions = (h: CockpitHarness): DecisionRow[] =>
  h.db.prepare("SELECT permission_id, permission, verdict, regle, par, relais FROM autonomy_decisions ORDER BY id").all() as unknown as DecisionRow[];

const decisionOf = (h: CockpitHarness, permissionId: string): Promise<DecisionRow> => until(() => decisions(h).find((row) => row.permission_id === permissionId));

/** Réponses d'autorisation réellement envoyées à opencode. */
const replies = (h: CockpitHarness): Array<{ id: string; body: unknown }> =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/")).map((r) => ({ id: r.pathname.split("/")[2] ?? "", body: r.body }));

const repliesTo = (h: CockpitHarness, permissionId: string): unknown[] => replies(h).filter((r) => r.id === permissionId).map((r) => r.body);

const aborts = (h: CockpitHarness) => h.fake.requests.filter((r) => r.method === "POST" && /^\/session\/[^/]+\/abort$/.test(r.pathname));

/** P4 : ni « allow », ni « ask », ni « always » ; le seul refus possible est celui du mode Simple, avec le texte de L1d. */
function assertNeverForbidden(h: CockpitHarness): void {
  for (const reply of replies(h)) {
    const body = isRecord(reply.body) ? reply.body : {};
    if (body.reply === "once") continue;
    assert.deepEqual(body, { reply: "reject", message: messageRefusSimple() }, `réponse interdite envoyée : ${JSON.stringify(reply.body)}`);
  }
  h.assertNoGlobalRestart();
}

/** Dépense de l'arbre enregistrée au registre, comme le fait le processeur pour un message clos. */
const depense = (h: CockpitHarness, rootId: string, cost: number, at = Date.now()) =>
  h.db
    .prepare(
      `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost)
       VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)`,
    )
    .run(`msg_${String(at)}_${String(Math.round(cost * 1000))}`, rootId, rootId, at, at, cost);

/** Publication de `usage.updated {rootId}` : la surveillance des plafonds est hors file, sur cet abonnement (§4.8.1). */
const usageUpdated = (h: CockpitHarness, rootId: string) =>
  h.hub.cockpit("usage.updated", { rootId, sessionId: rootId, monthSpentUsd: 0, percent: 0 });

const vue = async (h: CockpitHarness, rootId: string): Promise<ConversationAutonomyView> => {
  const res = await h.call("GET", url(rootId), { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<ConversationAutonomyView>();
};

const ligneAutonomie = (h: CockpitHarness, rootId: string) =>
  h.db.prepare("SELECT choix, retour_cause FROM conversation_autonomy WHERE root_id = ?").get(rootId) as { choix: string; retour_cause: string | null };

/** Les `count` demandes d'autorisation de la conversation, toutes posées. */
const asked = (h: CockpitHarness, sessionId: string, count: number): Promise<FakePermissionRequest[]> =>
  until(() => {
    const list = h.fake.pendingPermissions().filter((p) => p.sessionID === sessionId);
    return list.length === count ? list : null;
  }, 5_000);

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

// --- 1. Bascule de la porte I1 (§2.6) ---------------------------------------------------------------------------------------------

describe("croisements it2 V3 : bascule de la porte I1 (ACTIVATION_OUVERTE) sur le câblage du dépôt", () => {
  it("production, porte OUVERTE : « PUT autonome » sans en-tête → 428, confirmé → 200 ; le crochet d'activation est inscrit entre les plans et les demandes", async (t) => {
    const h = await start(t);
    assert.equal(ACTIVATION_OUVERTE, true, "porte I1 basculée au train de cette vague");
    assert.equal(h.cockpit.c11.activationOuverte, true);
    const inscriptions: readonly Inscription[] = h.cockpit.wiring.registrations;
    assert.deepEqual(crochets(inscriptions, "beforeBilledSend"), ["floors", "plans", "activation", "requests"]);
    // Non-régression de l'ouverture 2bis-V2 : un crochet de la salle sort de la liste, un crochet de l'instance principale y reste.
    assert.deepEqual(crochets([...inscriptions, { kind: "hook", key: "beforeBilledSend", module: "omoActivation", instances: ["omo"] }], "beforeBilledSend"), [
      "floors",
      "plans",
      "activation",
      "requests",
    ]);
    assert.deepEqual(crochets([...inscriptions, { kind: "hook", key: "beforeBilledSend", module: "autre" }], "beforeBilledSend"), [
      "floors",
      "plans",
      "activation",
      "requests",
      "autre",
    ]);

    const root = await withAgent(h, "Porte ouverte");
    const sans = await putChoice(h, root.id, { choix: "autonome" }, h.headers.mutating);
    assert.equal(sans.status, 428, sans.body);
    assert.equal(sans.json<{ error: string }>().error, "confirmation-requise");

    const res = await putChoice(h, root.id, { choix: "autonome" });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json<ConversationAutonomyView>().choix, "autonome");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "autonome");
    // Les deux choix automatiques sont désormais annoncés disponibles par le serveur (c'est le sélecteur de L12a qui les lit).
    const disponibles = (await vue(h, root.id)).disponibles;
    for (const choix of ["modifications", "autonome"] as const) {
      assert.deepEqual(disponibles.find((entry) => entry.choix === choix), { choix, disponible: true, raison: null }, choix);
    }
    assertNeverForbidden(h);
  });

  it("porte REFERMÉE par la fabrique : « PUT autonome » confirmé → 409 « a-venir », aucun crochet d'activation, choix indisponibles", async (t) => {
    const h = await start(t, { modules: TOUS_PORTE_FERMEE });
    assert.deepEqual(crochets(h.cockpit.wiring.registrations, "beforeBilledSend"), ["floors", "plans", "requests"]);
    const root = await withAgent(h, "Porte refermée");
    const res = await putChoice(h, root.id, { choix: "autonome" });
    assert.equal(res.status, 409, res.body);
    assert.equal(res.json<{ raison: string }>().raison, "a-venir");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");
    const disponibles = (await vue(h, root.id)).disponibles;
    for (const choix of ["modifications", "autonome"] as const) {
      assert.deepEqual(disponibles.find((entry) => entry.choix === choix), { choix, disponible: false, raison: "a-venir" }, choix);
    }
    assertNeverForbidden(h);
  });
});

// --- 2. Plafond de coût : L10c × L1c × L6a × L4b -----------------------------------------------------------------------------------

describe("croisements it2 V3 : plafond de coût (L10c) × arrêt de l'arbre (L1c) × choix (L6a) × faits (L4b)", () => {
  it("le plafond de coût clôt la demande en « plafond-cout », arrête l'arbre et écrit le fait « statut », PUIS ramène à « Demander à chaque fois » avec `retour_cause` et un fait « choix »", async (t) => {
    const h = await start(t);
    const root = await withAgent(h, "Plafond de coût");
    const plafonds: Partial<AutonomyCaps> = { plafondUsd: 0.05 };
    assert.equal((await putChoice(h, root.id, { choix: "autonome", plafonds })).status, 200);

    // Un envoi ouvre la demande autonome (crochet « requests » de L10a, après celui de l'activation).
    await send(h, root, []);
    const ouverte = await until(() => requests(h, root.id).at(-1));
    assert.equal(ouverte.fin, null);

    depense(h, root.id, 0.08);
    usageUpdated(h, root.id);

    const close = await until(() => requests(h, root.id).find((row) => row.fin !== null));
    assert.deepEqual([close.id, close.fin], [ouverte.id, "plafond-cout"]);
    // L1c : l'arbre est arrêté et le fait statut {cause: plafond, motif: plafond-cout} est écrit par stopTree.
    const statut = await until(() => statuts(h, root.id).find((fact) => fact.data.cause === "plafond"));
    assert.equal(statut.data.motif, "plafond-cout");
    assert.ok(aborts(h).length > 0, "l'arbre doit être arrêté au plafond de coût");
    assert.ok(h.cockpitEvents().some((event) => event.type === "conversation.arretee"));

    // L6a : retour à « Demander à chaque fois », ligne, fait « choix », vue lue par le sélecteur (L12a) et le bandeau (L12b).
    const ligne = await until(() => {
      const row = ligneAutonomie(h, root.id);
      return row.choix === "demander" ? row : undefined;
    });
    assert.equal(ligne.retour_cause, "plafond-cout");
    assert.deepEqual(facts(h, root.id, "choix").at(-1)?.data, { choix: "demander", cause: "plafond-cout" });
    const view = await vue(h, root.id);
    assert.deepEqual([view.choix, view.retourCause], ["demander", "plafond-cout"]);
    assert.ok(h.cockpitEvents().some((event) => event.type === "autonomie.choix"));
    assertNeverForbidden(h);
  });
});

// --- 3. 6e délégation : L10e × L1e ---------------------------------------------------------------------------------------------------

describe("croisements it2 V3 : 6e délégation en Autonome (L10e) × surveillance des délégations (L1e)", () => {
  for (const mode of ["simple", "avance"] as const) {
    it(`${mode} : les cinq premières délégations passent seules (A-task), la sixième est ${mode === "simple" ? "refusée avec message" : "mise en attente"} ; l'arrêt de L1e n'est PAS déclenché`, async (t) => {
      const h = await start(t, { settings: { ui: { mode } } });
      const root = await withAgent(h, `Six délégations (${mode})`);
      assert.equal((await putChoice(h, root.id, { choix: "autonome" })).status, 200);

      // Cinq délégations comptées par les faits réels (L4b), comme un tour qui les aurait toutes lancées ; la sixième demande
      // son autorisation. Le plafond de L1e (budget.delegation.maxPerRequest = 5) n'arrête qu'au-delà de cinq COMPTÉES : la
      // sixième étant refusée ou en attente, elle n'est jamais comptée, donc L1e ne doit rien arrêter.
      assert.equal(h.settings.get().budget.delegation.maxPerRequest, 5);
      const cinq = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          assert.equal(
            h.cockpit.c11.ports.facts.work.markDelegation({ rootId: root.id, parentSessionId: root.id, callId: `call_${String(i)}`, agent: "general" }, "travaille", null),
            true,
          );
        }
      };
      await send(h, root, [task("general", "sixième", cinq)]);
      const [demande] = await asked(h, root.id, 1);
      assert.ok(demande);
      const ligne = await decisionOf(h, demande.id);
      assert.equal(ligne.regle, "D6", "plafond de délégations de la demande autonome");
      assert.notEqual(ligne.regle, DELEGATION_AUTO_RULE);

      if (mode === "simple") {
        // Décision n° 4 : refus avec le message de L1d, l'IA continue seule. Le refus part hors de l'appel (retenue F-c) : le
        // Journal dit d'abord l'attente, puis « Refusé automatiquement » une fois le refus parti.
        assert.equal(ligne.verdict, "attente", "rien n'est journalisé « refusé » avant l'envoi");
        await within(h.fake.settled(root.id), "tour terminé");
        assert.deepEqual(repliesTo(h, demande.id), [{ reply: "reject", message: messageRefusSimple() }]);
        const definitive = await until(() => decisions(h).filter((row) => row.permission_id === demande.id).find((row) => row.verdict === "refus-auto"));
        assert.deepEqual([definitive.regle, definitive.par, definitive.relais], ["D6", "cockpit", "ok"]);
      } else {
        assert.equal(ligne.verdict, "attente", "mode Avancé : votre accord");
        await flush();
        assert.deepEqual(repliesTo(h, demande.id), [], "rien n'est envoyé en Avancé");
        const carte = await h.call("GET", `/api/conversations/${root.id}/delegations/${demande.id}`, { headers: h.headers.authed });
        assert.equal(carte.status, 200, carte.body);
        assert.equal(carte.json<{ compteurs: { delegations: number } }>().compteurs.delegations, 5);
      }

      // L1e : aucun arrêt, aucun fait de plafond de délégations, aucune fin de demande par ce chemin.
      await flush();
      assert.deepEqual(statuts(h, root.id).filter((fact) => fact.data.motif === "plafond-delegations"), [], "L1e n'a rien arrêté");
      assert.deepEqual(aborts(h), [], "aucun arrêt d'arbre");
      assert.equal(h.cockpit.c11.ports.requests.current(root.id)?.fin ?? null, null, "la demande autonome reste ouverte");
      assertNeverForbidden(h);
    });
  }
});

// --- 4. « Différé = direct » sur le câblage complet (§7.1, P12) -----------------------------------------------------------------------

describe("croisements it2 V3 : « différé = direct » sur la fixture d'autonomie, câblage complet", () => {
  it("la fixture jouée sur TOUS les modules de l'itération 2 : faits relus = faits publiés, au fait près", async (t) => {
    // Port `activation` ouvert par surcharge : la conversation de la capture n'est pas créée par le cockpit, son plancher n'est
    // donc pas posé et l'activation réelle la refuserait à bon droit (« plancher-non-verifie »). Ce que cette suite doit
    // prouver n'est pas l'activation — elle l'est ci-dessus — mais que « différé = direct » tient TOUS les modules montés.
    const h = await start(t, {
      settings: { ui: { mode: "simple" }, budget: { autonomie: { controleIa: true, actionsMax: 1 } } },
      ports: { activation: { check: async () => ({ ok: true }) } },
      gate: RELAIS_OK,
    });

    // La conversation de la capture est celle de la fixture : le cockpit la découvre par son événement de création.
    const capture = readCapture(FIXTURE);
    const created = capture.find(({ wire }) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "session.created");
    assert.ok(created && "payload" in created.wire && !("syncEvent" in created.wire.payload), "la capture crée une conversation");
    const properties = created.wire.payload.properties;
    assert.ok(isRecord(properties) && isRecord(properties.info) && typeof properties.info.id === "string");
    const rootId = properties.info.id;
    h.fake.emitRaw(created.wire);
    await until(() => h.sessions.get(rootId));

    // Choix par la route réelle, porte I1 ouverte comprise ; la demande autonome est ouverte à la main (la capture ne rejoue
    // pas l'envoi du proxy).
    const ouvert = await putChoice(h, rootId, { choix: "autonome" });
    assert.equal(ouvert.status, 200, ouvert.body);
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('v3', ?, 'autonome', ?, ?)")
      .run(rootId, JSON.stringify({ plafondUsd: 1, actionsMax: 1, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());

    for (const { wire } of capture) h.fake.emitRaw(wire);
    const lignes = await until(() => {
      const rows = decisions(h);
      return rows.length === 4 ? rows : null;
    }, 8_000);
    assert.deepEqual(
      lignes.map((row) => [row.verdict, row.regle]),
      [
        ["attente", "E2"],
        ["attente", "S7"],
        ["auto", "A-pwd"],
        ["attente", "plafond-actions"],
      ],
      "les quatre situations de la fixture, inchangées par les modules montés en plus",
    );

    const resserre = await putChoice(h, rootId, { choix: "demander" }, h.headers.mutating);
    assert.equal(resserre.status, 200, resserre.body);

    // Direct : ce que le navigateur reçoit du flux, JSON compris (aucun objet partagé avec le serveur).
    const direct = h
      .cockpitEvents()
      .filter((event) => event.type === "activite.fait")
      .map((event) => JSON.parse(JSON.stringify(event.data)) as ActivityFact)
      .filter((fact) => fact.rootId === rootId);
    // Différé : la route de L4b, telle que le Déroulé la lit à l'ouverture d'un onglet.
    const relu = await h.call("GET", `/api/conversations/${rootId}/facts?since=0`, { headers: h.headers.authed });
    assert.equal(relu.status, 200, relu.body);
    const body = relu.json<FactsResponse>();
    assert.equal(body.partial, false, "aucune borne de faits atteinte par la fixture");

    assert.deepEqual(body.facts, direct, "faits relus = faits publiés, câblage complet");
    // Invariant général (§7.4, D-01) plutôt que le compte de cette fixture : une ligne de Journal sans son fait resterait invisible.
    assert.equal(direct.filter((fact) => fact.kind === "decision").length, decisions(h).length, "un fait « decision » par ligne du Journal");
    assert.deepEqual(
      direct.filter((fact) => fact.kind === "choix").map((fact) => [fact.data.choix, fact.data.cause]),
      [
        ["autonome", "clic"],
        ["demander", "clic"],
      ],
    );
    assertNeverForbidden(h);
  });
});
