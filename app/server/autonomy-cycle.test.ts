// Tests L10a : cycle d'une décision d'autonomie (spécification §4.3, §4.4, §4.5, §4.7, §4.10, §4.12 ; §6, lignes « Autorisé
// automatiquement », « Ne lève jamais un refus » et « L'IA de contrôle ne peut pas autoriser une commande interdite » ; plan
// d'exécution, fiche L10a).
// Harnais à modules déclarés (plan §2.2) : `modules: ["autonomy", "requests", "facts", "floors"]`, port `activation` surchargé à
// « permis » (la constante ACTIVATION_OUVERTE vaut true depuis la bascule du train de la vague 3 ; ces tests ouvrent le port par
// surcharge et ne la touchent JAMAIS, §2.6) et port `conversationAutonomy` surchargé pour poser le choix de la conversation.
// Les tests restent vrais après la fusion de L10d, L10c et L10e.
// Ce que ces tests prouvent : aucun `allow`, `ask` ni `always` envoyé ; aucune réponse hors de la racine choisie ; un
// resserrement pendant l'examen annule la décision ; exactement un fait `decision` par ligne de `autonomy_decisions` ;
// `.github/workflows/x.yml` → attente avec la phrase E2 ; assistant « Lecture seule » en Autonome → aucun outil `edit` visible et
// aucune demande `edit` ; `grep` dans le dossier → automatique ; `git status` sur dépôt piégé → attente (G04) ; programme non
// listé + IA de contrôle indisponible → attente ; 404 au relais → « Déjà répondu par vous. » ; jamais de refus envoyé ; demande
// déjà au registre `emitted` → aucune réponse ; pré-conditions dans l'ordre ; borne des 45 s ; relecture de GET /permission à la
// reconnexion, au relâchement du choix (route L6a réelle) et pour une attente dont la cause a disparu (R-modifications, plafond),
// jamais à un resserrement ; un CODE interne de l'IA de contrôle n'est jamais montré et n'est jamais attribué à l'IA ; P6 partout.
// La fixture `autonomie-p8.jsonl` est relue ici (analyse de secrets et rejeu).
// Aucun appel facturé : faux opencode seulement (porte des exécutions facturées FERMÉE).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { autonomyModuleWith } from "./autonomy.ts";
import type { ActivationPort, Cockpit11Ports, ControlAiPort, ConversationAutonomyPort, DelegationPolicyPort, PermissionGate } from "./contracts-11.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import { phraseRegle, phraseRelais, TEXTES } from "./shared/autonomy-texts.ts";
import type { AutonomyChoice } from "./shared/autonomy-types.ts";
import { CONTROL_PROBLEMS } from "./shared/control-ai-output.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, type FakePermissionRequest, type FakeSession, type FakeToolScript, readCapture } from "./test-support/fake-opencode.ts";
import { bash, editTool, leaks, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
/** IA nommée par un verdict du port `controlAi` (L11b), telle qu'elle arrive dans `autonomy_decisions.ia_model`. */
const IA_MODELE = "github-copilot/gpt-5-mini";
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
/** Dépôt piégé : `git status` lancerait ce programme (G04, §4.5 S6). */
const TRAPPED_GIT_CONFIG = `${CLEAN_GIT_CONFIG}[core]${NL}${TAB}fsmonitor = /tmp/temoin${NL}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Workspace et harnais -----------------------------------------------------------------------------------------------------

/** Workspace réel monté en /workspace : `proj` = dossier de la conversation, avec un dépôt git dont la configuration est donnée. */
function workspace(t: TestContext, gitConfig = CLEAN_GIT_CONFIG): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-l10a-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": gitConfig,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

/** Port `activation` ouvert par surcharge (ACTIVATION_OUVERTE vaut true depuis la bascule ; ce test ne touche jamais la constante). */
const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

function choicePort(choices: Map<string, AutonomyChoice>): ConversationAutonomyPort {
  return {
    get: async () => null,
    choiceOf: (id) => choices.get(id) ?? "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

/** Portillon réel dont une méthode est remplacée (espion). */
function wrapGate(over: (real: PermissionGate) => Partial<PermissionGate>): NonNullable<CockpitHarnessOptions["gate"]> {
  return (deps): PermissionGate => {
    const real = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
    return { ...real, ...over(real) };
  };
}

interface CycleOptions {
  mode?: UiMode;
  controleIa?: boolean;
  gitConfig?: string;
  /** Plafonds de la conversation (budget.autonomie). */
  caps?: Record<string, number>;
  ports?: Partial<Cockpit11Ports>;
  modules?: CockpitHarnessOptions["modules"];
  gate?: CockpitHarnessOptions["gate"];
  /** COCKPIT_AUTONOMY. */
  autonomy?: boolean;
}

interface Cycle {
  h: CockpitHarness;
  choices: Map<string, AutonomyChoice>;
  root: string;
}

async function startCycle(t: TestContext, options: CycleOptions = {}): Promise<Cycle> {
  const root = workspace(t, options.gitConfig);
  const choices = new Map<string, AutonomyChoice>();
  const h = await startCockpit(t, {
    modules: options.modules ?? ["autonomy", "requests", "facts", "floors"],
    env: { workspaceDir: root, ...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }) },
    settings: {
      ui: { mode: options.mode ?? "simple" },
      budget: { autonomie: { controleIa: options.controleIa ?? true, ...(options.caps ?? {}) } },
    },
    ports: { conversationAutonomy: choicePort(choices), activation: PERMIS, ...(options.ports ?? {}) },
    ...(options.gate ? { gate: options.gate } : {}),
  });
  return { h, choices, root };
}

/** Conversation créée par le proxy dans `directory` (plancher posé par L3), suivie par le cockpit. */
async function conversation(h: CockpitHarness, title: string, directory = DOSSIER): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

async function send(h: CockpitHarness, session: FakeSession, tools: FakeToolScript[]): Promise<void> {
  h.fake.script(session.id, { tools, followUp: { text: FIN } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${encodeURIComponent(session.directory)}`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

/** Envoie et rend la demande d'autorisation posée par le premier outil. */
async function ask(h: CockpitHarness, session: FakeSession, tool: FakeToolScript): Promise<FakePermissionRequest> {
  const since = h.fake.emitted.length;
  await send(h, session, [tool]);
  const event = await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since });
  return event.properties as unknown as FakePermissionRequest;
}

// --- Lectures -------------------------------------------------------------------------------------------------------------------

interface DecisionRow {
  id: number;
  request_id: string | null;
  root_id: string;
  session_id: string;
  permission_id: string | null;
  permission: string;
  resume: string;
  choix: string;
  regle: string;
  rules_version: number;
  verdict: string;
  par: string;
  raison: string;
  ia_model: string | null;
  ia_cost: number | null;
  ia_ms: number | null;
  relais: string | null;
}

const decisions = (h: CockpitHarness): DecisionRow[] => h.db.prepare("SELECT * FROM autonomy_decisions ORDER BY id").all() as unknown as DecisionRow[];

const decisionOf = (h: CockpitHarness, permissionId: string): Promise<DecisionRow> =>
  until(() => decisions(h).find((row) => row.permission_id === permissionId));

/** Relectures de `GET /permission` réellement demandées au faux opencode (§4.3 étape 8). */
const permissionReads = (h: CockpitHarness): number => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission").length;

/** Réponses d'autorisation réellement envoyées à opencode. */
const replies = (h: CockpitHarness): Array<{ id: string; body: unknown }> =>
  h.fake.requests
    .filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/"))
    .map((r) => ({ id: r.pathname.split("/")[2] ?? "", body: r.body }));

const repliesTo = (h: CockpitHarness, permissionId: string): unknown[] => replies(h).filter((r) => r.id === permissionId).map((r) => r.body);

/** P4 : ni « allow », ni « ask », ni « always » ; et ce paquet n'envoie jamais de refus. */
function assertNeverForbidden(h: CockpitHarness): void {
  for (const reply of replies(h)) {
    const value = isRecord(reply.body) ? reply.body.reply : null;
    assert.equal(value, "once", `réponse interdite envoyée : ${JSON.stringify(reply.body)}`);
  }
  h.assertNoGlobalRestart();
}

/** Un fait « decision » par ligne de `autonomy_decisions`, avec la même demande et le même verdict (D-01). */
function assertOneFactPerDecision(h: CockpitHarness): void {
  const rows = decisions(h);
  const facts = h.db.prepare("SELECT root_id, session_id, ref, data FROM activity_facts WHERE kind = 'decision' ORDER BY id").all() as Array<{
    root_id: string;
    session_id: string;
    ref: string | null;
    data: string;
  }>;
  assert.equal(facts.length, rows.length, "un fait « decision » par ligne de autonomy_decisions");
  for (const [index, row] of rows.entries()) {
    const fact = facts[index];
    assert.ok(fact, `fait ${index}`);
    assert.equal(fact.ref, row.permission_id);
    assert.equal(fact.root_id, row.root_id);
    assert.equal(fact.session_id, row.session_id);
    assert.deepEqual(JSON.parse(fact.data), { verdict: row.verdict, regle: row.regle });
  }
}

const wait = (h: CockpitHarness, permissionId: string): { reply: string | null; par: string | null } | null => {
  const row = h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(permissionId) as
    | { reply: string | null; replied_by: string | null }
    | undefined;
  return row === undefined ? null : { reply: row.reply, par: row.replied_by };
};

const requestRow = (h: CockpitHarness, rootId: string): Record<string, number> =>
  h.db.prepare("SELECT auto, attentes, refus, controles, fichiers, delegations FROM autonomy_requests WHERE root_id = ? ORDER BY rowid DESC LIMIT 1").get(rootId) as unknown as Record<
    string,
    number
  >;

/** Laisse les microtâches et les tours d'événement déjà engagés se terminer (examen déféré par la dérivation). */
async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Barrière posée dans le port `activation` : l'examen s'arrête là jusqu'à `release()`. */
function activationBarrier(): { port: ActivationPort; reached: Promise<void>; release: () => void } {
  const hit = Promise.withResolvers<void>();
  const open = Promise.withResolvers<void>();
  return {
    port: {
      check: async () => {
        hit.resolve();
        await open.promise;
        return { ok: true };
      },
    },
    reached: hit.promise,
    release: () => open.resolve(),
  };
}

const PHRASES = (mode: UiMode = "simple", controleIa = true) => ({ mode, controleIa });

// --- 1. Décisions automatiques ----------------------------------------------------------------------------------------------------

describe("L10a : décision automatique", () => {
  it("`grep -rn 'TODO' src` dans le dossier de la conversation : « once » relayé, journal, fait, compteurs et attente close", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);

    assert.equal(decision.verdict, "auto");
    assert.equal(decision.regle, "A-grep");
    assert.equal(decision.par, "regles");
    assert.equal(decision.relais, "ok");
    assert.equal(decision.choix, "autonome");
    assert.equal(decision.permission, "bash");
    assert.equal(decision.resume, "grep -rn 'TODO' src");
    assert.equal(decision.rules_version, 1);
    assert.equal(decision.raison, TEXTES.partout.consultation);
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }]);
    assert.deepEqual(wait(h, request.id), { reply: "once", par: "cockpit" });
    await until(() => requestRow(h, conv.id).auto === 1);
    assert.equal(requestRow(h, conv.id).attentes, 0);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
    // L'événement d'examen précède celui de la décision (§4.3 étapes 2 et 6).
    const types = h.cockpitEvents().map((e) => e.type);
    assert.ok(types.indexOf("autonomie.examen") >= 0 && types.indexOf("autonomie.examen") < types.indexOf("autonomie.decision"));
  });

  it("`skill` en Autonome : automatique ; en « Modifications automatiques » : attente (seul `edit` y passe)", async (t) => {
    const { h, choices } = await startCycle(t);
    const skill: FakeToolScript = { tool: "skill", input: { name: "revue" }, ask: { permission: "skill", patterns: ["revue"], metadata: {} }, output: "ok" };

    const autonome = await conversation(h, "Autonome");
    choices.set(autonome.id, "autonome");
    const first = await ask(h, autonome, skill);
    const auto = await decisionOf(h, first.id);
    assert.deepEqual([auto.verdict, auto.regle, auto.relais], ["auto", "A-skill", "ok"]);

    const modifications = await conversation(h, "Modifications");
    choices.set(modifications.id, "modifications");
    const second = await ask(h, modifications, skill);
    const attente = await decisionOf(h, second.id);
    assert.deepEqual([attente.verdict, attente.regle, attente.relais], ["attente", "R-modifications", null]);
    assert.deepEqual(repliesTo(h, second.id), []);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });
});

// --- 2. Attentes : règles E, porte des commandes, IA de contrôle ------------------------------------------------------------------

describe("L10a : attentes", () => {
  it("`.github/workflows/x.yml` : attente avec la phrase E2, rien de relayé", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, editTool(".github/workflows/x.yml", "", `on: push${NL}`, { directory: DOSSIER, worktree: DOSSIER }));
    const decision = await decisionOf(h, request.id);

    assert.equal(decision.verdict, "attente");
    assert.equal(decision.regle, "E2");
    assert.equal(decision.par, "regles");
    assert.equal(decision.raison, phraseRegle("E2", PHRASES()));
    assert.equal(decision.raison, "Fichier protégé (configuration, CI/CD, infrastructure ou consignes d'IA)");
    assert.deepEqual(repliesTo(h, request.id), []);
    assert.ok(h.fake.pendingPermissions().some((p) => p.id === request.id), "la demande reste en attente de votre accord");
    await until(() => requestRow(h, conv.id).attentes === 1);
    assert.equal(requestRow(h, conv.id).auto, 0);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("modification du dossier, hors fichier protégé : automatique (contre-épreuve de E2)", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    // Une ligne changée sur quatre : ni suppression, ni vidage (E3 tient), diff lisible (E4).
    const avant = `export const a = 1;${NL}export const b = 2;${NL}export const c = 3;${NL}export const d = 4;${NL}`;
    const apres = `export const a = 1;${NL}export const b = 20;${NL}export const c = 3;${NL}export const d = 4;${NL}`;
    const request = await ask(h, conv, editTool("src/a.ts", avant, apres, { directory: DOSSIER, worktree: DOSSIER }));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["auto", "A-edit", "ok"]);
    assert.equal(decision.resume, `${DOSSIER}/src/a.ts`);
    await until(() => requestRow(h, conv.id).fichiers === 1);
    assertNeverForbidden(h);
  });

  it("`git status --short` sur un dépôt piégé : attente G04 ; sur un dépôt sain : automatique", async (t) => {
    const trapped = await startCycle(t, { gitConfig: TRAPPED_GIT_CONFIG });
    const convA = await conversation(trapped.h, "Autonome");
    trapped.choices.set(convA.id, "autonome");
    const asked = await ask(trapped.h, convA, bash("git status --short"));
    const decision = await decisionOf(trapped.h, asked.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "G04", null]);
    assert.equal(decision.raison, phraseRegle("G04", PHRASES()));
    assert.deepEqual(repliesTo(trapped.h, asked.id), []);
    assertNeverForbidden(trapped.h);

    const clean = await startCycle(t);
    const convB = await conversation(clean.h, "Autonome");
    clean.choices.set(convB.id, "autonome");
    const ok = await ask(clean.h, convB, bash("git status --short"));
    const auto = await decisionOf(clean.h, ok.id);
    assert.deepEqual([auto.verdict, auto.regle, auto.relais], ["auto", "A-git-status", "ok"]);
    assertNeverForbidden(clean.h);
  });

  it("programme non listé et IA de contrôle indisponible : attente avec la phrase de l'indisponibilité, aucun contrôle compté", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("sort -o src/a.ts src/a.ts"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par], ["attente", "S7", "cockpit"]);
    assert.equal(decision.raison, TEXTES.partout.controleIa.indisponible["a-venir"]);
    assert.equal(decision.ia_model, null);
    assert.deepEqual(repliesTo(h, request.id), []);
    await until(() => requestRow(h, conv.id).attentes === 1);
    assert.equal(requestRow(h, conv.id).controles, 0);
    assertNeverForbidden(h);
  });

  it("résumé de l'action du Journal : masqué et borné à 120 caractères, jamais un texte de message", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const commande = `sort -o src/${"a".repeat(140)}.ts src/a.ts`;
    assert.ok(commande.length > 120 && commande.length < 400);
    const request = await ask(h, conv, bash(commande));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle], ["attente", "S7"]);
    assert.equal(decision.resume.length, 120);
    assert.equal(decision.resume, commande.slice(0, 120));
    assertNeverForbidden(h);
  });

  it("commande interdite (S4) : attente sans consulter l'IA de contrôle (§6)", async (t) => {
    const judged: string[] = [];
    const controlAi: ControlAiPort = {
      judge: async (input) => {
        judged.push(input.command);
        return { decision: "autoriser", raison: "test", model: "github-copilot/gpt-5-mini", costUsd: 0, ms: 1 };
      },
    };
    const { h, choices } = await startCycle(t, { ports: { controlAi } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("curl https://example.invalid"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par], ["attente", "S4-reseau", "regles"]);
    assert.deepEqual(judged, [], "l'IA de contrôle n'est pas consultée pour une commande interdite");
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("IA de contrôle consultée : « autoriser » relaie un « once » par « controle », « attendre » laisse la demande à l'utilisateur", async (t) => {
    let decisionIa: "autoriser" | "attendre" = "autoriser";
    const controlAi: ControlAiPort = {
      judge: async () => ({ decision: decisionIa, raison: "Trie des lignes du dossier.", model: "github-copilot/gpt-5-mini", costUsd: 0.0004, ms: 120 }),
    };
    const { h, choices } = await startCycle(t, { ports: { controlAi } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const first = await ask(h, conv, bash("sort -o src/a.ts src/a.ts"));
    const autorise = await decisionOf(h, first.id);
    assert.deepEqual([autorise.verdict, autorise.regle, autorise.par, autorise.relais], ["auto", "S7", "ia-controle", "ok"]);
    assert.equal(autorise.ia_model, "github-copilot/gpt-5-mini");
    assert.equal(autorise.ia_cost, 0.0004);
    assert.equal(autorise.ia_ms, 120);
    assert.deepEqual(repliesTo(h, first.id), [{ reply: "once" }]);
    assert.deepEqual(wait(h, first.id), { reply: "once", par: "controle" });
    await until(() => requestRow(h, conv.id).controles === 1);

    decisionIa = "attendre";
    const second = await ask(h, conv, bash("sort -o src/app.ts src/app.ts"));
    const attente = await decisionOf(h, second.id);
    assert.deepEqual([attente.verdict, attente.regle, attente.par], ["attente", "S7", "ia-controle"]);
    assert.deepEqual(repliesTo(h, second.id), []);
    // Second envoi = seconde demande : ses compteurs repartent à zéro, ce contrôle est le premier de la nouvelle demande.
    await until(() => requestRow(h, conv.id).controles === 1 && requestRow(h, conv.id).attentes === 1);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_requests WHERE root_id = ?").get(conv.id) as { n: number }).n, 2);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("web, dossier hors projet, lecture et outil inconnu : attente avec leur règle (§4.3 étape 4)", async (t) => {
    const { h, choices } = await startCycle(t);
    const cases: Array<[string, string]> = [
      ["webfetch", "R-web"],
      ["external_directory", "R-hors-projet"],
      ["read", "R-lecture"],
      ["doom_loop", "R-repetition"],
      ["mcp_outil", "R-autre"],
    ];
    // Une conversation par cas : une demande laissée en attente bloque le tour de la sienne.
    for (const [permission, regle] of cases) {
      const conv = await conversation(h, `Autonome ${permission}`);
      choices.set(conv.id, "autonome");
      const tool: FakeToolScript = {
        tool: permission === "mcp_outil" ? "mcp_outil" : permission,
        input: {},
        ask: { permission, patterns: ["*"], metadata: {}, ...(permission === "doom_loop" ? { scope: "agent" as const } : {}) },
        output: "ok",
      };
      const request = await ask(h, conv, tool);
      const decision = await decisionOf(h, request.id);
      assert.deepEqual([decision.verdict, decision.regle], ["attente", regle], permission);
      assert.deepEqual(repliesTo(h, request.id), [], permission);
    }
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("codes internes de l'IA de contrôle : phrase française dans le Journal, jamais le code, « Par » selon qui a décidé", async (t) => {
    const { controleIa } = TEXTES.partout;
    /** Sort attendu de chaque code de CONTROL_PROBLEMS : la phrase montrée et la colonne « Par » de la ligne du Journal. */
    const ATTENDUS = new Map<string, { raison: string; par: string }>([
      // Délai de 30 s : l'appel est parti, l'IA n'a pas répondu à temps.
      ["delai-depasse", { raison: controleIa.sansReponse, par: "ia-controle" }],
      // Aucune réponse lue (rien n'est parti, ou l'appel a échoué) : la décision est celle du cockpit, pas celle de l'IA.
      ["session-non-verifiee", { raison: controleIa.nonAbouti, par: "cockpit" }],
      ["appel-en-erreur", { raison: controleIa.nonAbouti, par: "cockpit" }],
      ["reponse-en-erreur", { raison: controleIa.nonAbouti, par: "cockpit" }],
      // L'IA a répondu, mais sa réponse ne se lit pas (L11a).
      ...(["reponse-vide", "decision-absente", "decision-multiple", "decision-non-finale", "decision-invalide", "raison-absente", "raison-multiple", "raison-vide", "raison-trop-longue"] as const).map(
        (code) => [code, { raison: controleIa.illisible, par: "ia-controle" }] as [string, { raison: string; par: string }],
      ),
    ]);
    assert.deepEqual([...ATTENDUS.keys()].sort(), [...CONTROL_PROBLEMS].sort(), "la table couvre exactement CONTROL_PROBLEMS");

    let raisonRendue = "delai-depasse";
    const controlAi: ControlAiPort = {
      // Forme exacte produite par control-ai.ts (L11b) pour un défaut : un CODE dans `raison`, avec l'IA et la durée.
      judge: async () => ({ decision: "attendre", raison: raisonRendue, model: IA_MODELE, costUsd: null, ms: 30_000 }),
    };
    const { h, choices } = await startCycle(t, { ports: { controlAi } });

    for (const [code, attendu] of ATTENDUS) {
      raisonRendue = code;
      // Une conversation par cas : une demande laissée en attente bloque le tour de la sienne.
      const conv = await conversation(h, `Autonome ${code}`);
      choices.set(conv.id, "autonome");
      const request = await ask(h, conv, bash("sort -o src/a.ts src/a.ts"));
      const decision = await decisionOf(h, request.id);
      assert.deepEqual([decision.verdict, decision.regle], ["attente", "S7"], code);
      assert.equal(decision.raison, attendu.raison, code);
      assert.equal(decision.par, attendu.par, code);
      for (const interne of CONTROL_PROBLEMS) assert.ok(!decision.raison.includes(interne), `${code} : code interne « ${interne} » montré à l'utilisateur`);
      // Session non vérifiée : aucun message n'est parti, donc aucune IA à nommer ; la place du plafond reste prise.
      assert.equal(decision.ia_model, code === "session-non-verifiee" ? null : IA_MODELE, code);
      assert.equal(decision.ia_ms, 30_000, code);
      assert.deepEqual(repliesTo(h, request.id), [], code);
      await until(() => requestRow(h, conv.id).controles === 1);
    }

    // Contre-épreuve : un vrai texte de l'IA n'est pas touché, et la décision lui est bien attribuée.
    raisonRendue = "Trie des lignes du dossier.";
    const conv = await conversation(h, "Autonome texte");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("sort -o src/a.ts src/a.ts"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par, decision.ia_model], ["attente", "S7", "ia-controle", IA_MODELE]);
    assert.equal(decision.raison, "L'IA de contrôle demande votre accord : Trie des lignes du dossier.");
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });
});

// --- 3. Pré-conditions (§4.3 étape 3) ---------------------------------------------------------------------------------------------

describe("L10a : pré-conditions", () => {
  it("interrupteur coupé (COCKPIT_AUTONOMY=off) : attente « X-coupee », aucune vérification d'activation", async (t) => {
    let checks = 0;
    const activation: ActivationPort = {
      check: async () => {
        checks++;
        return { ok: true };
      },
    };
    const { h, choices } = await startCycle(t, { autonomy: false, ports: { activation } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par], ["attente", "X-coupee", "cockpit"]);
    assert.equal(checks, 0, "l'activation n'est interrogée qu'après les trois premières pré-conditions");
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("aucune demande en cours (envoi fait hors du cockpit) : attente « X-hors-demande »", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    // Envoi direct à opencode : le crochet `beforeBilledSend` n'est pas passé, aucune demande autonome n'est ouverte.
    h.fake.script(conv.id, { tools: [bash("grep -rn 'TODO' src")], followUp: { text: FIN } });
    const since = h.fake.emitted.length;
    await h.deps.client.request("POST", `/session/${conv.id}/prompt_async`, {
      directory: conv.directory,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
    });
    const event = await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === conv.id, { since });
    const request = event.properties as unknown as FakePermissionRequest;
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.request_id], ["attente", "X-hors-demande", null]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("activation refusée pendant la demande : attente avec le code du refus", async (t) => {
    const activation: ActivationPort = { check: async () => ({ ok: false, raison: "regle-allow" }) };
    const { h, choices } = await startCycle(t, { ports: { activation } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.par], ["attente", "regle-allow", "cockpit"]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("plafond d'actions atteint dans la même demande : la décision suivante attend avec « plafond-actions »", async (t) => {
    const { h, choices } = await startCycle(t, { caps: { actionsMax: 1 } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    // Un envoi = une demande (les compteurs repartent à zéro) : les deux commandes sont du MÊME envoi.
    await send(h, conv, [bash("grep -rn 'TODO' src"), bash("pwd")]);
    await until(() => decisions(h).length === 2, 8_000);
    const rows = decisions(h);
    assert.equal(rows.filter((row) => row.verdict === "auto").length, 1, "une seule décision automatique");
    const attente = rows.find((row) => row.verdict === "attente");
    assert.ok(attente);
    assert.deepEqual([attente.regle, attente.par, attente.relais], ["plafond-actions", "cockpit", null]);
    assert.deepEqual(repliesTo(h, attente.permission_id ?? ""), []);
    assert.equal(requestRow(h, conv.id).auto, 1);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });
});

// --- 4. Relais : resserrement, registre, 404, borne des 45 s ------------------------------------------------------------------------

describe("L10a : relais", () => {
  it("resserrement pendant l'examen : la décision est annulée, rien n'est relayé", async (t) => {
    const barrier = activationBarrier();
    const { h, choices } = await startCycle(t, { ports: { activation: barrier.port } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    await within(barrier.reached, "examen commencé");
    assert.equal(h.cockpit.c11.ports.autonomy.examining(), true, "examining() pendant l'examen (garde de rechargement)");
    assert.equal(h.cockpit.c11.reloadBusy(), true);
    choices.set(conv.id, "demander");
    barrier.release();
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "X-illisible", null]);
    assert.deepEqual(repliesTo(h, request.id), []);
    await until(() => h.cockpit.c11.ports.autonomy.examining() === false);
    assertNeverForbidden(h);
  });

  it("demande déjà inscrite au registre `emitted` : aucune réponse, « Déjà répondu par vous. »", async (t) => {
    const barrier = activationBarrier();
    const { h, choices } = await startCycle(t, { ports: { activation: barrier.port } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    await within(barrier.reached, "examen commencé");
    h.cockpit.gate.emitted.record({ requestId: request.id, reply: "once", by: "vous", at: Date.now() });
    barrier.release();
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "A-grep", null]);
    assert.equal(decision.raison, phraseRelais("deja-repondu"));
    assert.deepEqual(repliesTo(h, request.id), [], "aucune réponse envoyée par l'autonomie");
    assertNeverForbidden(h);
  });

  it("404 au relais (demande déjà répondue) : « Déjà répondu par vous. », sans nouvel essai", async (t) => {
    let relays = 0;
    const { h, choices } = await startCycle(t, {
      gate: wrapGate(() => ({
        relayOnce: async () => {
          relays++;
          return "deja-repondu";
        },
      })),
    });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "A-grep", "deja-repondu"]);
    assert.equal(decision.raison, "Déjà répondu par vous.");
    assert.equal(relays, 1, "aucun nouvel essai");
    assert.deepEqual(repliesTo(h, request.id), []);
    assert.equal(wait(h, request.id)?.reply, null, "l'attente n'est pas close par le cockpit");
    assertNeverForbidden(h);
  });

  it("examen plus long que la borne de décision : plus rien n'est relayé", async (t) => {
    const { h, choices } = await startCycle(t, { modules: [autonomyModuleWith({ examMaxMs: 0 }), "requests", "facts", "floors"] });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "X-illisible", null]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("aucune réponse hors de la racine choisie : la conversation en « Demander » n'est jamais autorisée", async (t) => {
    const { h, choices } = await startCycle(t);
    const autonome = await conversation(h, "Autonome");
    const demander = await conversation(h, "Demander");
    choices.set(autonome.id, "autonome");
    const asked = await ask(h, autonome, bash("grep -rn 'TODO' src"));
    await decisionOf(h, asked.id);
    const other = await ask(h, demander, bash("grep -rn 'TODO' src"));

    // Rien pour l'autre conversation : ni réponse, ni ligne de journal.
    await until(() => replies(h).length === 1);
    assert.deepEqual(
      replies(h).map((r) => r.id),
      [asked.id],
    );
    assert.deepEqual(repliesTo(h, other.id), []);
    assert.deepEqual(
      decisions(h).map((d) => d.root_id),
      [autonome.id],
    );
    assert.ok(h.fake.pendingPermissions().some((p) => p.id === other.id));
    assertNeverForbidden(h);
  });
});

// --- 5. Délégation : jamais de refus envoyé par ce paquet ---------------------------------------------------------------------------

describe("L10a : délégation", () => {
  const taskTool = (agent: string): FakeToolScript => ({
    tool: "task",
    input: { description: `Déléguer à ${agent}`, prompt: "Résume le projet.", subagent_type: agent },
    ask: { permission: "task", patterns: [agent], metadata: { description: `Déléguer à ${agent}`, subagent_type: agent } },
    child: { agent, text: "Résumé du sous-agent." },
  });

  it("politique de délégation « refus » : attente tant que le refus n'est pas parti, puis « refus-auto » ; aucune réponse envoyée par l'autonomie", async (t) => {
    // Contrat de L10e : le refus part HORS de l'appel, et son sort est rendu au cycle. Ici, il part.
    const delegationPolicy: DelegationPolicyPort = {
      decide: async (input) => {
        queueMicrotask(() => input.onRefusalSettled?.("ok", "D6"));
        return { verdict: "refus", regle: "D6" };
      },
    };
    const { h, choices } = await startCycle(t, { ports: { delegationPolicy } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, taskTool("explore"));
    const decision = await until(() => decisions(h).find((row) => row.permission_id === request.id && row.verdict === "refus-auto"));
    assert.deepEqual([decision.verdict, decision.regle, decision.par, decision.relais], ["refus-auto", "D6", "cockpit", "ok"]);
    assert.deepEqual(
      decisions(h).filter((row) => row.permission_id === request.id).map((row) => row.verdict),
      ["attente", "refus-auto"],
      "l'attente d'abord, le refus une fois parti",
    );
    assert.deepEqual(repliesTo(h, request.id), [], "le refus appartient à L1d et L10e, jamais à ce module");
    await until(() => requestRow(h, conv.id).refus === 1 && requestRow(h, conv.id).attentes === 0);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("politique de délégation « refus » retenu par le portillon : la ligne reste « attente », le compteur de refus ne bouge pas", async (t) => {
    const delegationPolicy: DelegationPolicyPort = {
      decide: async (input) => {
        queueMicrotask(() => input.onRefusalSettled?.("retenu", "D6"));
        return { verdict: "refus", regle: "D6" };
      },
    };
    const { h, choices } = await startCycle(t, { ports: { delegationPolicy } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const request = await ask(h, conv, taskTool("explore"));
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["attente", "D6", null]);
    await flush();
    assert.deepEqual(
      decisions(h).filter((row) => row.permission_id === request.id).map((row) => row.verdict),
      ["attente"],
      "aucune ligne « Refusé automatiquement » pour un refus qui n'est pas parti",
    );
    assert.deepEqual([requestRow(h, conv.id).refus, requestRow(h, conv.id).attentes], [0, 1]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("politique « auto » : « once » relayé et délégation comptée ; politique « attente » : rien de relayé", async (t) => {
    let verdict: "auto" | "attente" = "auto";
    const delegationPolicy: DelegationPolicyPort = { decide: async () => ({ verdict, regle: verdict === "auto" ? "A-task" : "D7" }) };
    const { h, choices } = await startCycle(t, { ports: { delegationPolicy } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    const first = await ask(h, conv, taskTool("explore"));
    const auto = await decisionOf(h, first.id);
    assert.deepEqual([auto.verdict, auto.regle, auto.relais], ["auto", "A-task", "ok"]);
    assert.deepEqual(repliesTo(h, first.id), [{ reply: "once" }]);
    await until(() => requestRow(h, conv.id).delegations === 1);

    verdict = "attente";
    const second = await ask(h, conv, taskTool("explore"));
    const attente = await decisionOf(h, second.id);
    assert.deepEqual([attente.verdict, attente.regle, attente.relais], ["attente", "D7", null]);
    assert.deepEqual(repliesTo(h, second.id), []);
    assertNeverForbidden(h);
  });

  it("`task` hors Autonome : aucun examen (la garde des délégations décide, L1d)", async (t) => {
    const delegationPolicy: DelegationPolicyPort = { decide: async () => ({ verdict: "auto", regle: "A-task" }) };
    const { h, choices } = await startCycle(t, { ports: { delegationPolicy } });
    const conv = await conversation(h, "Modifications");
    choices.set(conv.id, "modifications");
    const request = await ask(h, conv, taskTool("explore"));
    await until(() => h.fake.pendingPermissions().some((p) => p.id === request.id));
    assert.deepEqual(decisions(h), []);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });
});

// --- 6. Refus de l'assistant : l'autonomie ne le voit jamais (F-b, §4.11) ------------------------------------------------------------

describe("L10a : refus de l'assistant", () => {
  it("assistant « Lecture seule » en Autonome : aucun outil `edit` visible, aucune demande `edit`, aucune décision", async (t) => {
    const { h, choices } = await startCycle(t);
    const lectureSeule = {
      name: "lecture-seule",
      mode: "primary",
      hidden: false,
      native: false,
      options: {},
      permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      prompt: "Lis seulement.",
    } as unknown as FakeAgent;
    h.fake.setAgents([...h.fake.agents(), lectureSeule]);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");

    const tools = h.fake.toolsFor(conv.id, { agent: "lecture-seule" });
    for (const tool of ["edit", "write", "apply_patch"]) assert.ok(!tools.includes(tool), `${tool} ne doit pas être proposé`);

    const since = h.fake.emitted.length;
    await send(h, conv, [
      editTool("src/a.ts", "export {};", "export const a = 1;", {
        directory: DOSSIER,
        worktree: DOSSIER,
        agentRules: [{ permission: "edit", pattern: "*", action: "deny" }],
      }),
    ]);
    await h.fake.settled(conv.id);
    const asked = h.fake.emitted.slice(since).filter((wire) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "permission.asked");
    assert.deepEqual(asked, [], "un refus de l'assistant ne produit aucune demande (F-b)");
    assert.deepEqual(decisions(h), []);
    assert.deepEqual(replies(h), []);
    assertNeverForbidden(h);
  });
});

// --- 7. Relecture de GET /permission (arbre de la racine seulement) --------------------------------------------------------------

describe("L10a : relecture des demandes en attente", () => {
  it("demande posée pendant que le choix était « Demander », puis reconnexion d'opencode : relue et décidée, jamais celle d'une autre conversation", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    const autre = await conversation(h, "Autre conversation");
    choices.set(conv.id, "autonome");
    choices.set(autre.id, "demander");

    // La demande de l'autre conversation (même dossier, donc même liste GET /permission) attend, sans aucun examen ; son choix
    // passe ensuite à « Autonome » SANS demande en cours : si la relecture la reprenait, elle écrirait une ligne de journal.
    const other = await ask(h, autre, bash("grep -rn 'TODO' src"));
    await flush();
    assert.deepEqual(decisions(h), []);
    choices.set(autre.id, "autonome");

    // Le choix revient à « Demander » juste avant la demande : aucune décision n'est prise.
    const since = h.fake.emitted.length;
    await send(h, conv, [
      bash("grep -rn 'TODO' src", {
        beforeAsk: async () => {
          choices.set(conv.id, "demander");
        },
      }),
    ]);
    const request = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === conv.id, { since })).properties as unknown as FakePermissionRequest;
    await until(() => h.fake.pendingPermissions().some((p) => p.id === request.id));
    // L'examen a eu lieu avec « Demander à chaque fois » : aucune décision, aucune ligne de journal.
    await flush();
    assert.deepEqual(decisions(h), []);

    // Choix relâché puis reconnexion d'opencode : seule cette conversation est relue.
    choices.set(conv.id, "autonome");
    h.hub.cockpit("opencode.connection", { connected: true, error: null });
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["auto", "A-grep", "ok"]);
    await flush();
    assert.deepEqual(repliesTo(h, other.id), [], "jamais les conversations des autres");
    assert.deepEqual(
      decisions(h).map((d) => d.root_id),
      [conv.id],
    );
    assertNeverForbidden(h);
  });

  it("demande mise en attente faute de demande autonome : relue et décidée dès qu'une demande s'ouvre", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    // Envoi direct à opencode : aucune demande autonome n'est ouverte (« X-hors-demande »).
    h.fake.script(conv.id, { tools: [bash("grep -rn 'TODO' src")], followUp: { text: FIN } });
    const since = h.fake.emitted.length;
    await h.deps.client.request("POST", `/session/${conv.id}/prompt_async`, {
      directory: conv.directory,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
    });
    const request = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === conv.id, { since })).properties as unknown as FakePermissionRequest;
    assert.equal((await decisionOf(h, request.id)).regle, "X-hors-demande");
    assert.deepEqual(repliesTo(h, request.id), []);

    // Une demande autonome s'ouvre : la relecture reprend la demande restée en attente et la décide.
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('dem-relecture', ?, 'autonome', ?, ?)")
      .run(conv.id, JSON.stringify({ plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());
    h.hub.cockpit("opencode.connection", { connected: true, error: null });
    await until(() => decisions(h).length === 2);
    const derniere = decisions(h).at(-1);
    assert.ok(derniere);
    assert.deepEqual([derniere.verdict, derniere.regle, derniere.relais], ["auto", "A-grep", "ok"]);
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }]);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("attente « R-modifications » puis passage à « Autonome » : la demande est reprise et décidée à la relecture", async (t) => {
    const { h, choices } = await startCycle(t);
    const conv = await conversation(h, "Modifications");
    choices.set(conv.id, "modifications");
    // `bash` en « Modifications automatiques » : attente R-modifications (seul `edit` y est automatique).
    const request = await ask(h, conv, bash("grep -rn 'TODO' src"));
    const attente = await decisionOf(h, request.id);
    assert.deepEqual([attente.verdict, attente.regle, attente.par], ["attente", "R-modifications", "regles"]);
    assert.deepEqual(repliesTo(h, request.id), []);

    // La cause de l'attente est le choix, pas l'action : relâché à « Autonome », la relecture doit reprendre la demande.
    choices.set(conv.id, "autonome");
    h.hub.cockpit("opencode.connection", { connected: true, error: null });
    await until(() => decisions(h).length === 2, 8_000);
    const reprise = decisions(h).at(-1);
    assert.ok(reprise);
    assert.deepEqual([reprise.verdict, reprise.regle, reprise.relais], ["auto", "A-grep", "ok"]);
    assert.equal(reprise.permission_id, request.id);
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }]);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("attente « plafond-actions » puis nouvelle demande autonome : la demande restée en attente est reprise", async (t) => {
    const { h, choices } = await startCycle(t, { caps: { actionsMax: 1 } });
    const conv = await conversation(h, "Autonome");
    choices.set(conv.id, "autonome");
    // Un envoi = une demande : la seconde commande du même tour dépasse le plafond d'actions.
    await send(h, conv, [bash("grep -rn 'TODO' src"), bash("pwd")]);
    await until(() => decisions(h).length === 2, 8_000);
    const bloquee = decisions(h).find((row) => row.regle === "plafond-actions");
    assert.ok(bloquee?.permission_id, "une décision « plafond-actions »");
    assert.deepEqual(repliesTo(h, bloquee.permission_id), []);

    // Une nouvelle demande autonome s'ouvre (compteurs repartis à zéro) : la relecture reprend la demande restée en attente.
    h.db.prepare("UPDATE autonomy_requests SET ended_at = ?, fin = 'terminee' WHERE root_id = ? AND ended_at IS NULL").run(Date.now(), conv.id);
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('dem-plafond', ?, 'autonome', ?, ?)")
      .run(conv.id, JSON.stringify({ plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());
    h.hub.cockpit("opencode.connection", { connected: true, error: null });
    await until(() => decisions(h).length === 3, 8_000);
    const reprise = decisions(h).at(-1);
    assert.ok(reprise);
    assert.deepEqual([reprise.verdict, reprise.relais, reprise.permission_id], ["auto", "ok", bloquee.permission_id]);
    assert.ok(["A-grep", "A-pwd"].includes(reprise.regle), reprise.regle);
    assert.deepEqual(repliesTo(h, bloquee.permission_id), [{ reply: "once" }]);
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });

  it("relâchement du choix par la route réelle : relecture des demandes en attente ; un resserrement n'en déclenche aucune", async (t) => {
    const root = workspace(t);
    // Câblage complet du choix : module « conversationAutonomy » réel (route L6a), activation ouverte par surcharge de port.
    const h = await startCockpit(t, {
      modules: ["autonomy", "requests", "facts", "floors", "conversationAutonomy"],
      env: { workspaceDir: root },
      settings: { ui: { mode: "simple" }, budget: { autonomie: { controleIa: true } } },
      ports: { activation: PERMIS },
    });
    const conv = await conversation(h, "Autonome");
    const url = `/api/conversations/${conv.id}/autonomie`;
    const put = (choix: AutonomyChoice, confirmed = false) =>
      h.call("PUT", url, { headers: confirmed ? h.headers.confirmed : h.headers.mutating, body: { choix } });

    const ouvert = await put("autonome", true);
    assert.equal(ouvert.status, 200, ouvert.body);

    // Envoi : une demande autonome s'ouvre ; l'utilisateur resserre à « Demander » pendant le tour, avant la demande d'autorisation.
    const since = h.fake.emitted.length;
    await send(h, conv, [
      bash("grep -rn 'TODO' src", {
        beforeAsk: async () => {
          const resserre = await put("demander");
          assert.equal(resserre.status, 200, resserre.body);
        },
      }),
    ]);
    const request = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === conv.id, { since })).properties as unknown as FakePermissionRequest;
    await until(() => h.fake.pendingPermissions().some((p) => p.id === request.id));
    await flush();
    // Route « hors-autonomie » : la demande est laissée à l'utilisateur, aucune ligne de journal.
    assert.deepEqual(decisions(h), []);
    const ouvertes = h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_requests WHERE root_id = ? AND ended_at IS NULL").get(conv.id) as { n: number };
    assert.equal(ouvertes.n, 1, "la demande autonome de l'envoi court toujours");

    // Relâchement : la demande restée en attente est relue et décidée, sans reconnexion d'opencode.
    const relache = await put("autonome", true);
    assert.equal(relache.status, 200, relache.body);
    const decision = await decisionOf(h, request.id);
    assert.deepEqual([decision.verdict, decision.regle, decision.relais], ["auto", "A-grep", "ok"]);
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }]);

    // Contre-épreuve : un resserrement (« Autonome » → « Demander ») ne relit jamais les demandes en attente.
    await flush();
    const avant = permissionReads(h);
    const resserre = await put("demander");
    assert.equal(resserre.status, 200, resserre.body);
    await flush();
    assert.equal(permissionReads(h), avant, "un resserrement ne déclenche aucune relecture");
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });
});

// --- 8. Fixture autonomie-p8 -------------------------------------------------------------------------------------------------------

describe("L10a : fixture autonomie-p8.jsonl", () => {
  const FIXTURE = "autonomie-p8.jsonl";
  const FIXTURE_URL = new URL(`./test-support/fixtures/${FIXTURE}`, import.meta.url);

  it("lisible, sans secret ni chemin d'hôte, et portant les quatre situations attendues", () => {
    const text = fs.readFileSync(FIXTURE_URL, "utf8");
    assert.deepEqual(leaks(text), [], "analyse de secrets de la fixture");
    assert.ok(text.length <= 300_000, `fixture trop lourde : ${text.length} octets`);
    const capture = readCapture(FIXTURE);
    assert.ok(capture.length > 0);
    const types = capture.map(({ wire }) => ("payload" in wire && !("syncEvent" in wire.payload) ? wire.payload.type : ""));
    for (const type of ["session.created", "permission.asked", "permission.replied", "message.part.updated"]) {
      assert.ok(types.includes(type), type);
    }
    const asked = capture.filter(({ wire }) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "permission.asked");
    assert.equal(asked.length, 4, "quatre demandes : attente, contrôle indisponible, automatique, plafond");
    // Heures croissantes : le rejeu « différé = direct » de L12c s'appuie dessus.
    for (const [index, row] of capture.entries()) if (index > 0) assert.ok(row.recv >= (capture[index - 1]?.recv ?? 0), `recv croissant (${index})`);
  });

  it("rejouée sur le faux opencode : attente, contrôle indisponible, décision automatique et plafond", async (t) => {
    // Un rejeu n'a aucune demande d'autorisation vivante chez opencode (seuls les événements sont rejoués) : le relais est
    // remplacé par un portillon d'essai qui répond « ok ». C'est aussi ce que fera le rejeu « différé = direct » de L12c.
    const { h, choices } = await startCycle(t, { caps: { actionsMax: 1 }, gate: wrapGate(() => ({ relayOnce: async () => "ok" })) });
    // La conversation de la capture est rejouée telle quelle : sa racine est celle de la fixture.
    const capture = readCapture(FIXTURE);
    const created = capture.find(({ wire }) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "session.created");
    assert.ok(created && "payload" in created.wire && !("syncEvent" in created.wire.payload));
    const info = (created.wire.payload.properties as { info: { id: string } }).info;
    h.fake.emitRaw(created.wire);
    await until(() => h.sessions.get(info.id));
    choices.set(info.id, "autonome");
    // Demande autonome ouverte à la main : la capture ne rejoue pas l'envoi du proxy.
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('p8', ?, 'autonome', ?, ?)")
      .run(info.id, JSON.stringify({ plafondUsd: 1, actionsMax: 1, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());

    for (const { wire } of capture) h.fake.emitRaw(wire);
    await until(() => decisions(h).length === 4, 8_000);
    const rows = decisions(h);
    assert.deepEqual(
      rows.map((row) => [row.verdict, row.regle]),
      [
        ["attente", "E2"],
        ["attente", "S7"],
        ["auto", "A-pwd"],
        ["attente", "plafond-actions"],
      ],
    );
    assertOneFactPerDecision(h);
    assertNeverForbidden(h);
  });
});
