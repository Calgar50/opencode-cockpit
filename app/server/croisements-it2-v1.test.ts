// Tests de croisement du train it2 V1 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L9b (matrice, délégation,
// activation et phrases), L8b (faits du disque de la porte shell et corpus de 116 commandes), L10b (faits d'une demande de
// modification) et L11b (IA de contrôle et installation gardée de cockpit-controle). Chaque paquet a testé ses modules seul ; ce
// que la vague doit prouver ensemble :
//   1. corpus 116 (L8b) → porte (L8a) → matrice (L9b) : exactement les 11 consultations automatiques, et seulement quand la
//      matrice mène `bash` à la porte (Autonome) ; « à juger » seulement avec l'IA de contrôle (allowJudge) ; chaque règle rendue
//      a sa phrase (L9b), dans les deux modes et les deux variantes ;
//   2. S4 → aucune session de contrôle (spécification §6, « L'IA de contrôle ne peut pas autoriser une commande interdite ») :
//      la lecture favorable de L11b n'est jamais plus étroite que les faits du disque, et sur le câblage complet seules les deux
//      commandes « à juger » du corpus ouvrent une session de contrôle ;
//   3. variantes controleIa : réglage → porte → IA de contrôle → phrases (S7, confirmation, description du choix) → Diagnostic ;
//      codes de l'IA de contrôle non consultée (contrat T0, rendus par L11b) = phrases de L9b ;
//   4. classifieur + cockpit-controle gardés : un seul nom par agent interne (Studio, module, IA de contrôle) ; installation
//      différée pendant une réponse → aucun contrôle (« agent-non-installe ») ; au repos, fichier installé, lu comme opencode le
//      lit (mesure L11b), puis contrôle lancé ;
//   5. faits de modification (L10b) × règles (L9b) : E5 et plafond de fichiers cohérents ; phrases des codes E.
// Aucun appel facturé : faux opencode seulement (M7, M8 et la barrière des 60 restent des recettes en attente).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { isReservedAgentName } from "./assistants.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import type { ControlAiInput, ControlAiUnavailableCode, ControlAiVerdict } from "./contracts-11.ts";
import { CONTROL_AGENT_PROMPT, favorableShellVerdict } from "./control-ai.ts";
import { collectEditFacts } from "./edit-facts.ts";
import { INSTALLED_AGENTS } from "./internal-agents.ts";
import { ProjectsService } from "./projects.ts";
import { collectShellContext, type ShellFactsProjects } from "./shell-facts.ts";
import { isInternalAgentName } from "./shared/agent-choice.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import { descriptionChoix } from "./shared/autonomy-choice-texts.ts";
import { allowJudge, capReached, classifyEdit, EDIT_AUTO_RULE, isShellConsultationRule, routePermission } from "./shared/autonomy-rules.ts";
import {
  type ControleIaIndisponible,
  confirmationAutonome,
  controleIaIndisponible,
  decisionControleIa,
  phraseRegle,
  phraseRetour,
  regleCarte,
  TEXTES,
} from "./shared/autonomy-texts.ts";
import type { AutonomyCaps, AutonomyChoice, AutonomyRequestView } from "./shared/autonomy-types.ts";
import { CONTROL_AGENT_FILE, CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { classifyCommand, type ShellVerdict } from "./shared/shell-gate.ts";
import { CONTROL_AGENT, INTERNAL_AGENTS, type StudioService } from "./studio.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
import { bash, until, within } from "./test-support/helpers.ts";

// --- Corpus de la sonde (L8b) ---------------------------------------------------------------------------------------------------

interface CorpusRow {
  id: string;
  command: string;
  attendu: { verdict: "auto" | "attente"; regle: string };
}

const CORPUS = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/shell-corpus.json", import.meta.url), "utf8")) as {
  dossier: string;
  commandes: CorpusRow[];
};
const ROWS = CORPUS.commandes;
const DOSSIER = CORPUS.dossier;
const OC_ROOT = "/workspace";

/** Les 11 consultations automatiques de la sonde (T-L8-a), dans l'ordre du corpus. */
const AUTOS = ["ok-ls", "ok-pwd", "ok-status", "ok-cat", "ok-grep", "ok-log", "ok-diff", "ok-show-path", "ok-find", "ok-abs-in-project", "ok-head"];
/** Les deux commandes « à juger » du corpus en Autonome avec l'IA de contrôle (S7 : programme non listé). */
const JUGES = ["sort-o", "uniq-out"];
const CHOICES: readonly AutonomyChoice[] = ["demander", "plan", "modifications", "autonome"];
const MODES: readonly UiMode[] = ["simple", "avance"];

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
/** Dépôt piégé : git status ou git diff lanceraient ce programme (G04). */
const TRAPPED_GIT_CONFIG = `${CLEAN_GIT_CONFIG}[core]${NL}${TAB}fsmonitor = /tmp/temoin${NL}`;

const LINES = `ligne 1${NL}ligne 2${NL}ligne 3${NL}`;

/**
 * Workspace réel (chemin exact : aucun alias 8.3, que L8b refuse) monté en /workspace : proj = dossier de la sonde, avec les
 * fichiers qu'elle cite et un dépôt git dont la configuration est donnée ; a.txt, b.txt et c.txt pour les modifications.
 */
function workspace(t: TestContext, gitConfig = CLEAN_GIT_CONFIG): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-it2-v1-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "package.json": `{}${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    "a.txt": LINES,
    "b.txt": LINES,
    "c.txt": LINES,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": gitConfig,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

const projectsOf = (root: string) => new ProjectsService({ workspaceDir: root, opencodeWorkspaceDir: OC_ROOT });

/** Verdict de la porte avec les faits du disque (L8b), comme L10a l'appellera : dossier de travail = celui de la conversation. */
async function diskVerdict(projects: ShellFactsProjects, command: string, judge: boolean): Promise<ShellVerdict> {
  const facts = await collectShellContext(command, DOSSIER, projects);
  return classifyCommand(command, { ...facts, workdir: null, allowJudge: judge });
}

// --- Câblage complet, Autonome avec contrôle (L11b) -----------------------------------------------------------------------------

const REQUEST_ID = "req-it2-v1";
const ALLOW_REASON = "Trie ou dédoublonne des lignes dans le dossier, sans rien envoyer ailleurs.";
const ALLOW_TEXT = `RAISON: ${ALLOW_REASON}${NL}DÉCISION: AUTORISER`;
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const CAPS: AutonomyCaps = { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 };

function requestView(rootId: string): AutonomyRequestView {
  return {
    id: REQUEST_ID,
    rootId,
    choix: "autonome",
    plafonds: CAPS,
    startedAt: Date.now() - 1_000,
    endedAt: null,
    spent: 0,
    auto: 0,
    attentes: 0,
    refus: 0,
    controles: 0,
    fichiers: 0,
    delegations: 0,
    fin: null,
  };
}

/**
 * Fichier d'agent lu comme opencode 1.18.30 le lit (mesure L11b, mesures/L11b.md) : en-tête entre deux lignes « --- », consignes
 * = corps sans les espaces de bord. Écrit ici indépendamment de control-ai.ts, pour que la chaîne fichier → opencode → contrôle
 * soit vérifiée et non recopiée.
 */
function readAgentFile(content: string): { mode: string | null; hidden: string | null; prompt: string } {
  const lines = content.split(NL);
  assert.equal(lines[0], "---", "en-tête d'agent");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "fin de l'en-tête");
  const header = lines.slice(1, end);
  const value = (key: string) => header.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;
  return { mode: value("mode"), hidden: value("hidden"), prompt: lines.slice(end + 1).join(NL).trim() };
}

/** Agent tel qu'opencode le rend dans GET /agent une fois le fichier installé. */
function agentFromFile(name: string, content: string): FakeAgent {
  const read = readAgentFile(content);
  return {
    name,
    mode: read.mode === "primary" ? "primary" : "subagent",
    hidden: read.hidden === "true",
    native: false,
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
    prompt: read.prompt,
  } as FakeAgent;
}

/** Conversation créée par le proxy dans `directory` (plancher posé par L3), suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string, directory: string): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  assert.equal(session.directory, directory);
  await until(() => h.sessions.get(session.id));
  return session;
}

const controlCreations = (h: CockpitHarness) =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session" && isRecord(r.body) && isRecord(r.body.metadata) && r.body.metadata.cockpit === "controle");
const controlMessages = (h: CockpitHarness) =>
  h.fake.requests.filter((r) => r.method === "POST" && /^[/]session[/][^/]+[/]message$/.test(r.pathname) && isRecord(r.body) && r.body.agent === CONTROL_AGENT_NAME);
const permissionReplies = (h: CockpitHarness) => h.fake.requests.filter((r) => r.pathname.startsWith("/permission/"));
const controlIds = (h: CockpitHarness): string[] =>
  (h.db.prepare("SELECT id FROM sessions WHERE purpose = 'controle' ORDER BY rowid").all() as Array<{ id: string }>).map((r) => r.id);

interface AutonomousOptions {
  controleIa: boolean;
  /** Agent cockpit-controle déjà vu par opencode (défaut : oui). */
  agent?: boolean;
  deps?: CockpitHarnessOptions["deps"];
}

/**
 * Câblage complet (modules « tous ») sur un workspace réel ; choix d'autonomie (L6a) et demande en cours (L10a, vague suivante) par
 * surcharge de ports, seul moyen de tenir « Autonome » tant qu'ACTIVATION_OUVERTE est fausse (plan §2.2, §2.6).
 */
async function autonomousCockpit(t: TestContext, options: AutonomousOptions) {
  const root = workspace(t);
  const choices = new Map<string, AutonomyChoice>();
  const requests = new Map<string, AutonomyRequestView>();
  const h = await startCockpit(t, {
    modules: "tous",
    env: { workspaceDir: root },
    settings: { budget: { autonomie: { controleIa: options.controleIa } } },
    ports: {
      conversationAutonomy: {
        get: async () => null,
        choiceOf: (rootId) => choices.get(rootId) ?? "demander",
        put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
      },
      requests: {
        current: (rootId) => requests.get(rootId) ?? null,
        spent: () => 0,
        interrupt: () => undefined,
      },
    },
    ...(options.deps ? { deps: options.deps } : {}),
  });
  if (options.agent !== false) h.fake.setAgents([...h.fake.agents(), agentFromFile(CONTROL_AGENT_NAME, CONTROL_AGENT_FILE)]);
  h.fake.defaultTurn = { text: ALLOW_TEXT, cost: 0.003, tokens: { input: 40, output: 12 } };
  const conv = await trackedRoot(h, "Autonome avec contrôle", DOSSIER);
  const autonomous = () => {
    choices.set(conv.id, "autonome");
    requests.set(conv.id, requestView(conv.id));
  };
  const input = (command: string): ControlAiInput => ({
    rootId: conv.id,
    sessionId: conv.id,
    requestId: REQUEST_ID,
    command,
    head: command.trim().split(" ")[0] ?? "",
    relativeDir: "",
    directory: conv.directory,
  });
  const judge = (command: string): Promise<ControlAiVerdict> => h.cockpit.c11.ports.controlAi.judge(input(command));
  return { h, conv, autonomous, judge };
}

// --- 1. Corpus × porte × matrice ------------------------------------------------------------------------------------------------

describe("croisements it2 V1 : corpus de la sonde (L8b) × porte (L8a) × matrice et phrases (L9b)", () => {
  it("116 commandes sur un vrai dossier : exactement les 11 consultations automatiques, seulement quand la matrice mène `bash` à la porte (Autonome) ; « à juger » seulement avec l'IA de contrôle", async (t) => {
    const projects = projectsOf(workspace(t));
    const facts = new Map<string, Awaited<ReturnType<typeof collectShellContext>>>();
    for (const row of ROWS) facts.set(row.id, await collectShellContext(row.command, DOSSIER, projects));
    assert.equal(facts.size, 116);

    for (const choice of CHOICES) {
      for (const controleIa of [true, false]) {
        const label = `${choice}, controleIa ${controleIa}`;
        const route = routePermission(choice, "bash");
        const autos: string[] = [];
        const judged: string[] = [];
        if (route.route === "bash") {
          for (const row of ROWS) {
            const context = facts.get(row.id);
            assert.ok(context, row.id);
            const verdict = classifyCommand(row.command, { ...context, workdir: null, allowJudge: allowJudge(choice, controleIa) });
            if (verdict.verdict === "auto") autos.push(row.id);
            if (verdict.verdict === "a-juger") judged.push(row.id);
            if (!controleIa && JUGES.includes(row.id)) assert.deepEqual([verdict.verdict, verdict.regle], ["attente", "S7"], `${label} : ${row.id}`);
          }
        }
        assert.deepEqual(autos, choice === "autonome" ? AUTOS : [], label);
        assert.deepEqual(judged, choice === "autonome" && controleIa ? JUGES : [], label);
      }
    }
    // Hors Autonome, `bash` n'atteint jamais la porte : « Modifications automatiques » attend avec sa règle, « Demander » et
    // « Plan d'abord » ne sont pas examinés.
    assert.deepEqual(routePermission("modifications", "bash"), { route: "attente", regle: "R-modifications" });
    assert.deepEqual(routePermission("demander", "bash"), { route: "hors-autonomie" });
    assert.deepEqual(routePermission("plan", "bash"), { route: "hors-autonomie" });
    assert.deepEqual(routePermission("autonome", "bash"), { route: "bash" });
  });

  it("chaque règle rendue par la porte sur le corpus (dépôt sain et piégé, avec et sans IA de contrôle) a sa phrase (L9b) dans les deux modes et les deux variantes ; consultations, S4 et S7 comme le §4 les écrit", async (t) => {
    const codes = new Set<string>();
    const autos = new Set<string>();
    for (const gitConfig of [CLEAN_GIT_CONFIG, TRAPPED_GIT_CONFIG]) {
      const projects = projectsOf(workspace(t, gitConfig));
      for (const row of ROWS) {
        for (const judge of [true, false]) {
          const verdict = await diskVerdict(projects, row.command, judge);
          codes.add(verdict.regle);
          if (verdict.verdict === "auto") autos.add(verdict.regle);
        }
      }
    }
    // Le dépôt piégé donne G04 ; les deux variantes donnent S7 ; toutes les catégories S4 du corpus sont là.
    for (const code of ["G04", "S7", "S4-enveloppes", "S4-declarations", "S4-git", "S4-editeurs", "S4-code", "S4-reseau", "S4-production", "S4-suppression"]) {
      assert.ok(codes.has(code), code);
    }
    for (const code of ["R-modifications"]) codes.add(code);
    assert.equal(autos.size, 10, "10 codes pour les 11 consultations (A-cat deux fois)");
    for (const code of autos) assert.equal(isShellConsultationRule(code), true, code);

    const inconnue = TEXTES.partout.regles.inconnue;
    for (const code of codes) {
      assert.equal(isShellConsultationRule(code), autos.has(code), `consultation seulement pour un code automatique : ${code}`);
      for (const mode of MODES) {
        for (const controleIa of [true, false]) {
          const options = { mode, controleIa };
          const phrase = phraseRegle(code, options);
          const label = `${code} (${mode}, controleIa ${controleIa})`;
          assert.notEqual(phrase, inconnue, label);
          assert.doesNotMatch(phrase, /[{}]/, `gabarit rempli : ${label}`);
          assert.equal(regleCarte(code, options), `Règle : ${phrase}`, label);
          if (autos.has(code)) assert.equal(phrase, TEXTES.partout.consultation, label);
          if (code.startsWith("S4-")) assert.ok(phrase.endsWith("(l'IA de contrôle n'est pas consultée)"), label);
        }
      }
    }
    // S7 suit la variante : jugé par l'IA de contrôle, ou en attente parce qu'elle est coupée.
    assert.match(phraseRegle("S7", { mode: "simple", controleIa: true }), /jugé par l'IA de contrôle/);
    assert.match(phraseRegle("S7", { mode: "simple", controleIa: false }), /contrôle par IA est coupé/);
    assert.match(phraseRegle("R-modifications", { mode: "simple", controleIa: true }), /« Modifications automatiques »/);
  });
});

// --- 2. S4 → aucune session de contrôle -----------------------------------------------------------------------------------------

describe("croisements it2 V1 : IA de contrôle (L11b) × faits du disque (L8b) : S4 → aucune session de contrôle", () => {
  it("lecture favorable de l'IA de contrôle : dépôt sain, même verdict que le disque pour les 116 ; dépôt piégé, seul G04 diffère et la lecture favorable n'y voit jamais « à juger »", async (t) => {
    const clean = projectsOf(workspace(t));
    const trapped = projectsOf(workspace(t, TRAPPED_GIT_CONFIG));
    const g04: string[] = [];
    for (const row of ROWS) {
      const favorable = favorableShellVerdict(row.command, DOSSIER);
      const sain = await diskVerdict(clean, row.command, true);
      assert.deepEqual([favorable.verdict, favorable.regle], [sain.verdict, sain.regle], `dépôt sain : ${row.id}`);
      const piege = await diskVerdict(trapped, row.command, true);
      if (piege.regle === "G04") {
        g04.push(row.id);
        assert.equal(piege.verdict, "attente", row.id);
        assert.equal(favorable.verdict, "auto", `consultation git, jamais « à juger » : ${row.id}`);
      } else {
        assert.deepEqual([favorable.verdict, favorable.regle], [piege.verdict, piege.regle], `dépôt piégé : ${row.id}`);
      }
      // Toute commande « à juger » du disque l'est aussi en lecture favorable : judge ne refuse jamais ce que L10a lui confiera.
      if (sain.verdict === "a-juger" || piege.verdict === "a-juger") assert.equal(favorable.verdict, "a-juger", row.id);
      // S4 ne dépend pas du disque : la lecture favorable le voit, donc aucune session de contrôle.
      if (row.attendu.regle.startsWith("S4-")) assert.deepEqual([favorable.verdict, favorable.regle], ["attente", row.attendu.regle], row.id);
    }
    assert.deepEqual(g04, ["ok-status", "ok-log", "ok-diff", "ok-show-path"]);
  });

  it("câblage complet, Autonome avec contrôle et demande en cours : les 116 commandes passent par judge ; seules sort -o et uniq ouvrent une session de contrôle, aucune pour S4 (34 commandes), une consultation ou une attente ; sessions supprimées, aucune réponse d'autorisation ; P6", async (t) => {
    const { h, autonomous, judge } = await autonomousCockpit(t, { controleIa: true });
    autonomous();
    const s4 = ROWS.filter((row) => row.attendu.regle.startsWith("S4-"));
    assert.equal(s4.length, 34);

    const consulted: string[] = [];
    for (const row of ROWS) {
      const before = controlCreations(h).length;
      const verdict = await within(judge(row.command), `contrôle de ${row.id}`, 5_000);
      if (verdict.decision === "indisponible") {
        assert.equal(verdict.raison, "desactive", row.id);
        assert.equal(controlCreations(h).length, before, `aucune session de contrôle : ${row.id}`);
      } else {
        consulted.push(row.id);
        assert.deepEqual([verdict.decision, verdict.raison], ["autoriser", ALLOW_REASON], row.id);
        assert.equal(controlCreations(h).length, before + 1, row.id);
      }
    }
    assert.deepEqual(consulted, JUGES);
    assert.equal(controlCreations(h).length, 2);
    assert.equal(controlMessages(h).length, 2);
    const ids = controlIds(h);
    assert.equal(ids.length, 2);
    for (const id of ids) assert.equal(h.fake.session(id), undefined, "session de contrôle supprimée");
    assert.equal(permissionReplies(h).length, 0, "aucune réponse d'autorisation (ni « once » ni refus)");
    assert.equal(h.cockpit.c11.configQueue.billedInFlight, 0);
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });
});

// --- 3. Variantes controleIa ----------------------------------------------------------------------------------------------------

describe("croisements it2 V1 : variantes du contrôle par IA (réglage → porte → IA de contrôle → phrases → Diagnostic)", () => {
  for (const controleIa of [true, false]) {
    it(`controleIa ${controleIa} : sort -o ${controleIa ? "jugé puis autorisé" : "en attente (S7), aucune session"} ; phrases de la variante (S7, confirmation d'Autonome, description du choix) ; Diagnostic`, async (t) => {
      const { h, autonomous, judge } = await autonomousCockpit(t, { controleIa });
      autonomous();
      const reglage = h.settings.get().budget.autonomie.controleIa;
      assert.equal(reglage, controleIa);
      const row = ROWS.find((r) => r.id === "sort-o");
      assert.ok(row);

      // Porte avec les faits du disque, allowJudge selon le réglage (ce que L10a fera).
      const verdict = await diskVerdict(h.deps.projects, row.command, allowJudge("autonome", reglage));
      assert.deepEqual([verdict.verdict, verdict.regle], [controleIa ? "a-juger" : "attente", "S7"]);

      // IA de contrôle réelle (L11b) sur le câblage complet.
      const judged = await within(judge(row.command), "contrôle", 5_000);
      if (controleIa) {
        assert.equal(judged.decision, "autoriser");
        assert.equal(decisionControleIa({ decision: "autoriser", raison: judged.raison }), `Autorisé par l'IA de contrôle : ${ALLOW_REASON}`);
        assert.equal(controlCreations(h).length, 1);
      } else {
        assert.deepEqual(judged, { decision: "indisponible", raison: "desactive" });
        assert.equal(controlCreations(h).length, 0);
        assert.equal(controleIaIndisponible("desactive"), "Contrôle par IA coupé dans les réglages : en attente de votre accord.");
      }

      // Phrases de la variante (L9b) et description du choix (autonomy-choice-texts.ts, variantes de L9b).
      const mode = h.settings.get().ui.mode;
      assert.equal(mode, "simple", "mode Simple par défaut");
      assert.match(phraseRegle("S7", { mode, controleIa: reglage }), controleIa ? /jugé par l'IA de contrôle/ : /contrôle par IA est coupé/);
      const [sansDemander] = confirmationAutonome({ controleIa: reglage, dossier: DOSSIER, plafondUsd: CAPS.plafondUsd }).lignes;
      assert.ok(sansDemander?.includes(DOSSIER));
      assert.equal(sansDemander?.includes("faire juger les autres commandes simples par l'IA de contrôle (chaque contrôle est facturé)"), controleIa);
      assert.equal(sansDemander?.endsWith("Les autres commandes attendent votre accord."), !controleIa);
      assert.equal(descriptionChoix("autonome", reglage).includes("dont les commandes qu'il ne connaît pas"), !controleIa);

      // Diagnostic : le même réglage.
      const diag = await h.call("GET", "/api/diagnostic/activite", { headers: h.headers.authed });
      assert.equal(diag.status, 200, diag.body);
      assert.equal(diag.json<{ controleIa: boolean }>().controleIa, controleIa);
      assert.equal(permissionReplies(h).length, 0);
      h.assertNoGlobalRestart();
    });
  }

  it("codes de l'IA de contrôle non consultée (contrat T0, rendus par L11b) : même liste que les phrases de L9b, chacune écrite", () => {
    type Egal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const memeListe: Egal<ControlAiUnavailableCode, ControleIaIndisponible> = true;
    assert.equal(memeListe, true);
    const codes = Object.keys({
      "a-venir": true,
      desactive: true,
      "ia-rapide-absente": true,
      "budget-refuse": true,
      "plafond-controles": true,
      "facturation-suspendue": true,
      "agent-non-installe": true,
    } satisfies Record<ControlAiUnavailableCode, true>) as ControlAiUnavailableCode[];
    assert.deepEqual([...codes].sort(), Object.keys(TEXTES.partout.controleIa.indisponible).sort());
    const phrases = new Set<string>();
    for (const code of codes) {
      const phrase = controleIaIndisponible(code);
      assert.notEqual(phrase, TEXTES.partout.controleIa.illisible, code);
      assert.doesNotMatch(phrase, /[{}]/, code);
      phrases.add(phrase);
    }
    assert.equal(phrases.size, codes.length, "une phrase distincte par code");
  });
});

// --- 4. Agents internes gardés --------------------------------------------------------------------------------------------------

describe("croisements it2 V1 : classifieur et cockpit-controle gardés (L1g, L11b, Studio)", () => {
  it("un seul nom par agent interne : Studio (INTERNAL_AGENTS, noms réservés), module des agents internes (INSTALLED_AGENTS), IA de contrôle, choix d'agent ; fichier installé = consignes attendues par le contrôle", () => {
    assert.deepEqual(
      INSTALLED_AGENTS.map((agent) => agent.name),
      [...INTERNAL_AGENTS],
    );
    assert.deepEqual([...INTERNAL_AGENTS], [CLASSIFIER_AGENT, CONTROL_AGENT_NAME]);
    assert.equal(CONTROL_AGENT, CONTROL_AGENT_NAME);
    for (const name of INTERNAL_AGENTS) {
      assert.equal(isReservedAgentName(name), true, name);
      assert.equal(isInternalAgentName(name), true, name);
    }
    assert.equal(INSTALLED_AGENTS.find((agent) => agent.name === CONTROL_AGENT_NAME)?.content, CONTROL_AGENT_FILE);
    const read = readAgentFile(CONTROL_AGENT_FILE);
    assert.deepEqual([read.mode, read.hidden], ["primary", "true"], "exclu des délégations et des choix");
    assert.equal(read.prompt, CONTROL_AGENT_PROMPT, "consignes vues par opencode = consignes vérifiées par le contrôle");
  });

  it("câblage complet : pendant une réponse, rien d'installé → « agent-non-installe », aucune session de contrôle ; au repos, les deux agents installés (classement puis contrôle), cockpit-controle vu par opencode → contrôle lancé", async (t) => {
    const installs: string[] = [];
    const upToDate = new Set<string>();
    let harness: CockpitHarness | null = null;
    const { h, conv, autonomous, judge } = await autonomousCockpit(t, {
      controleIa: true,
      agent: false,
      deps: (base) => ({
        studio: {
          ...(base.studio as object),
          internalAgentUpToDate: async (name: string) => upToDate.has(name),
          // Studio simulé : fichier « écrit », puis relu par opencode comme la mesure L11b l'a relevé (GET /agent), et cache des
          // agents du cockpit invalidé comme après le rechargement réel.
          ensureInternalAgent: async (name: string, content: string) => {
            installs.push(name);
            upToDate.add(name);
            if (harness) {
              harness.fake.setAgents([...harness.fake.agents(), agentFromFile(name, content)]);
              harness.deps.lookup.invalidate();
            }
            return true;
          },
        } as unknown as StudioService,
      }),
    });
    harness = h;
    const sort = ROWS.find((r) => r.id === "sort-o")?.command;
    assert.ok(sort);

    // Réponse en cours dans la conversation (autorisation bash en attente), envoyée avant de passer en Autonome.
    h.fake.script(conv.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    const sent = await h.call("POST", `/api/oc/session/${conv.id}/prompt_async`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Liste." }] },
    });
    assert.equal(sent.status, 204, sent.body);
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === conv.id)).properties as unknown as FakePermissionRequest;
    autonomous();

    // Démarrage 1.1 pendant la réponse : installation différée ; aucun contrôle sans l'agent vu par opencode.
    await h.cockpit.startup();
    assert.deepEqual(installs, [], "aucune installation pendant une réponse");
    assert.deepEqual(await within(judge(sort), "contrôle différé"), { decision: "indisponible", raison: "agent-non-installe" });
    assert.equal(controlCreations(h).length, 0);

    // Au repos : réponse de l'utilisateur, puis redémarrage → installation dans l'ordre, puis contrôle.
    const once = await h.call("POST", `/api/oc/permission/${asked.id}/reply?directory=${encodeURIComponent(DOSSIER)}`, {
      headers: h.headers.mutating,
      body: { reply: "once" },
    });
    assert.equal(once.status, 200, once.body);
    await within(h.fake.settled(conv.id), "réponse terminée");
    await until(() => h.fake.statusOf(conv.id).type === "idle");
    const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(restart.status, 200, restart.body);
    assert.deepEqual(installs, [CLASSIFIER_AGENT, CONTROL_AGENT_NAME], "installés au repos, dans l'ordre");
    const verdict = await within(judge(sort), "contrôle", 5_000);
    assert.deepEqual([verdict.decision, verdict.raison], ["autoriser", ALLOW_REASON]);
    assert.equal(controlCreations(h).length, 1);
    assert.equal(permissionReplies(h).length, 1, "seule la réponse de l'utilisateur au bash");
    assert.equal(h.fake.requests.some((r) => r.method === "POST" && (r.pathname === "/global/dispose" || r.pathname === "/instance/dispose")), false);
  });
});

// --- 5. Faits de modification × règles ------------------------------------------------------------------------------------------

describe("croisements it2 V1 : faits de modification (L10b) × règles (L9b)", () => {
  /** Demande `edit` mesurée par MX1 : motif relatif au worktree (dépôt git : le dossier), metadata {filepath absolu, diff}. */
  const editRequest = (name: string) => {
    const filepath = `${DOSSIER}/${name}`;
    const diff = [`Index: ${filepath}`, "=".repeat(67), `--- ${filepath}`, `+++ ${filepath}`, "@@ -1,3 +1,3 @@", " ligne 1", "-ligne 2", "+ligne deux", " ligne 3", ""].join(NL);
    return { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: [name], always: ["*"], metadata: { filepath, diff } };
  };

  it("fichiersMax = 2 : deux fichiers automatiques, le même fichier encore automatique (déjà compté), le troisième → retour E5 ; capReached ne s'arrête pas avant E5 et rend le même effet au-delà ; phrases des codes E et du retour", async (t) => {
    const projects = projectsOf(workspace(t));
    const caps: AutonomyCaps = { ...CAPS, fichiersMax: 2 };
    const counted = new Set<string>();
    const counters = { startedAt: 0, spentUsd: 0, auto: 0, fichiers: 0 };
    const decide = async (name: string) => {
      const facts = await collectEditFacts(editRequest(name), DOSSIER, projects, counted);
      const verdict = classifyEdit(facts, caps.fichiersMax);
      if (verdict.verdict === "auto") {
        for (const file of facts.touchedFiles) counted.add(file);
        counters.auto += 1;
        counters.fichiers = counted.size;
      }
      return verdict;
    };
    const auto = { verdict: "auto", regle: EDIT_AUTO_RULE };
    assert.deepEqual(await decide("a.txt"), auto);
    assert.equal(capReached(counters, caps, 1), null);
    assert.deepEqual(await decide("b.txt"), auto);
    assert.equal(capReached(counters, caps, 1), null, "fichiers comptés = plafond : pas encore atteint");
    assert.deepEqual(await decide("a.txt"), auto, "fichier déjà compté : toujours modifiable");
    assert.deepEqual([...counted], [`${DOSSIER}/a.txt`, `${DOSSIER}/b.txt`]);
    assert.deepEqual(await decide("c.txt"), { verdict: "retour", regle: "E5" });
    assert.equal(counters.fichiers, 2);
    // Sans la liste des fichiers comptés (leur seul nombre) : prudent, tout fichier compte comme nouveau.
    const prudent = await collectEditFacts(editRequest("a.txt"), DOSSIER, projects, counted.size);
    assert.deepEqual(classifyEdit(prudent, caps.fichiersMax), { verdict: "retour", regle: "E5" });
    // Au-delà du plafond (compte illisible ou dépassé), capReached rend le même effet que E5 : retour à « Demander ».
    assert.deepEqual(capReached({ ...counters, fichiers: 3 }, caps, 1), { plafond: "fichiers", effet: "retour", fin: "plafond-fichiers", cause: "plafond-fichiers" });

    for (const code of ["E1", "E2", "E3", "E4", "E5", "E6", EDIT_AUTO_RULE]) {
      for (const mode of MODES) {
        for (const controleIa of [true, false]) {
          const phrase = phraseRegle(code, { mode, controleIa });
          assert.notEqual(phrase, TEXTES.partout.regles.inconnue, code);
          assert.doesNotMatch(phrase, /[{}]/, code);
        }
      }
    }
    assert.match(phraseRegle("E5", { mode: "simple", controleIa: true }), /retour à « Demander à chaque fois »/);
    assert.match(phraseRetour("plafond-fichiers") ?? "", /plafond de fichiers modifiés atteint/);
  });
});
