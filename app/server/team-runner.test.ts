// Runner des équipes (plan d'exécution it4, fiche L37b ; spéc. §3.13, §6 l.1032-1037) : harnais du cockpit, faux opencode,
// modules `teams`, `teamPreflight` et `teamRunner` déclarés, ports `preflight`, `teams` et `guards` SURCHARGÉS (le pré-lancement
// réel est écrit en parallèle par L37p).
//
// Ce que ces tests tiennent, garde par garde :
// - avis de bout en bout : sessions d'étape sous plancher ETAPE vérifié, `parentID` = racine, simultanéité réelle, synthèse
//   après les avis, résultat injecté en `noReply` (aucune ligne `usage`), `prompts.kind`, identifiants des deux injections,
//   `archive.refresh` puis `classifier.onIdle`, coûts additionnés ;
// - honnêteté l.1037 (A4, D-eq-17) : refus de `POST …/run` sans AUCUNE requête ; contrôle de fraîcheur après l'acceptation,
//   avant toute injection et toute session d'étape ;
// - U2 / D-eq-26 : ni consigne, ni demande, ni précision dans les journaux (espion sur c11.log) ;
// - P6 : `assertNoGlobalRestart` sur tous les scénarios ; aucune règle `allow` ou `ask` envoyée hors du plancher ETAPE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import { createCockpitApp } from "./app-factory.ts";
import type { EqModule, PlannedStep, PreflightOutcome, RecheckOutcome, RunPlan, TeamGuardsPort, TeamPreflightPort, TeamRow, TeamsPort } from "./contracts-eq.ts";
import type { Logger } from "./log.ts";
import { floorHash } from "./session-floor-service.ts";
import { pickRestorableAgent } from "./shared/agent-choice.ts";
import { type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import { buildFloor, canonicalRules, parseFloorMark } from "./shared/session-floors.ts";
import { stepMessage } from "./shared/flow.ts";
import { planSteps } from "./shared/team-limits.ts";
import type { Flow, FlowEstimate, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import { createTeamRunnerModule, type TeamRunner } from "./team-runner.ts";
import { createTeamStore } from "./team-store.ts";

const MODEL = "github-copilot/gpt-5-mini";
const AGENT_SQL = "relire-requete-sql";
const AGENT_SCRIPT = "relire-script";
const CHAT_AGENT = "build";
const DEMANDE = "Relis la requête de facturation du mois dernier.";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Règles d'un assistant en lecture seule du catalogue (refus par défaut, lecture permise). */
const readOnlyRules = (): Rule[] => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const stepAgent = (name: string, steps?: number): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant de test ${name}`,
  options: {},
  permission: readOnlyRules() as FakeAgent["permission"],
  ...(steps === undefined ? {} : { steps }),
});

const etape = (id: string, titre: string, assistant: string, recoit: "demande" | "precedent" | "tous") => ({
  id,
  titre,
  assistant,
  niveau: null,
  taille: "M" as const,
  consigne: `Consigne de ${titre}.`,
  recoit,
});

/** Déroulé « Avis indépendants » : trois avis qui partent de la demande, puis une synthèse (spéc. §6 l.1034). */
const avisFlow = (): Flow => ({
  version: 1,
  blocs: [
    {
      type: "avis",
      id: "avis",
      avis: [etape("exactitude", "Exactitude", AGENT_SQL, "demande"), etape("lisibilite", "Lisibilité", AGENT_SQL, "demande"), etape("perf", "Performance", AGENT_SQL, "demande")],
      synthese: etape("synthese", "Synthèse", AGENT_SCRIPT, "tous"),
    },
  ],
});

/** Déroulé le plus court : une étape, aucune pause (livraison tout de suite). */
const soloFlow = (): Flow => ({
  version: 1,
  blocs: [{ type: "etape", id: "b1", etape: etape("standards", "Standards", AGENT_SCRIPT, "demande") }],
});

/** Déroulé « À la suite » sans pause, les DEUX étapes partant de la demande (reconstitution après un redémarrage, D-eq-27). */
const duoFlow = (): Flow => ({
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: etape("standards", "Standards", AGENT_SCRIPT, "demande") },
    { type: "etape", id: "b2", etape: etape("securite", "Sécurité", AGENT_SCRIPT, "demande") },
  ],
});

/** Déroulé « À la suite » avec une pause pour vérifier entre les deux étapes. */
const suiteFlow = (): Flow => ({
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: etape("standards", "Standards", AGENT_SCRIPT, "demande") },
    { type: "pause", id: "verif", message: "Vérifiez les points bloquants avant la relecture de sécurité." },
    { type: "etape", id: "b2", etape: etape("securite", "Sécurité", AGENT_SCRIPT, "precedent") },
  ],
});

const emptyEstimate = (stepIds: readonly string[]): FlowEstimate => ({
  typique: 0.05 * stepIds.length,
  maximum: 0.2 * stepIds.length,
  plafond: 0.2 * stepIds.length,
  etapesFacturees: stepIds.length,
  depassementUnAppel: 0.02,
  relais: 0,
  parEtape: stepIds.map((stepId) => ({
    stepId,
    titre: stepId,
    assistant: AGENT_SQL,
    model: MODEL,
    modelLabel: "GPT-5 mini",
    niveau: null,
    choisieParEquipe: false,
    typique: 0.05,
    maximum: 0.2,
    source: "profil" as const,
  })),
});

interface Ctx {
  h: CockpitHarness;
  runner: TeamRunner;
  flow: Flow;
  team: TeamRow;
  /** Plan rendu par le faux pré-lancement ; modifiable par un test avant le lancement. */
  plan: RunPlan;
  /** Verdicts successifs du contrôle de fraîcheur ; le dernier est répété. */
  recheck: RecheckOutcome[];
  /** Refus du pré-lancement : non nul, `check` refuse sans rien lire. */
  refus: { status: 403 | 404 | 409 | 422; code: "conversation-occupee" } | null;
  capStops: string[];
  /** Racines passées à `classifier.onIdle` (espion : le classement du harnais ne fait rien). */
  classements: string[];
  warnings: Array<{ message: string; data: unknown }>;
  run(body?: Partial<Record<string, unknown>>, headers?: Record<string, string>): Promise<{ status: number; body: string; json<T>(): T }>;
  waitRun(runId: string, predicate: (view: TeamRunView) => boolean, label?: string): Promise<TeamRunView>;
  view(runId: string): TeamRunView;
}

interface OpenOptions {
  flow: Flow;
  settings?: CockpitHarnessOptions["settings"];
  deps?: CockpitHarnessOptions["deps"];
  agents?: FakeAgent[];
  /** Racine créée par le runner (`null`) ou conversation existante. */
  rootId?: string | null;
  /** IA de la conversation pour les injections (D-eq-14, constat 20). */
  iaConversation?: { model: string; variant: string | null } | null;
  /** Délais raccourcis (TESTS SEULEMENT). */
  runnerOptions?: { pollMs?: number; retryMs?: number; usageWaitMs?: number };
}

/** Harnais complet : faux opencode, modules `floors` (plancher CONVERSATION) et équipes, ports d'équipe surchargés. */
async function openTeam(t: TestContext, options: OpenOptions): Promise<Ctx> {
  const warnings: Array<{ message: string; data: unknown }> = [];
  const capStops: string[] = [];
  const classements: string[] = [];
  const ctx = {} as Ctx;
  ctx.recheck = [{ ok: true }];
  ctx.refus = null;

  const preflight: TeamPreflightPort = {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
    // A4 : `check` n'émet AUCUNE requête ; le faux non plus.
    check: async (): Promise<PreflightOutcome> => (ctx.refus ? { ok: false, ...ctx.refus } : { ok: true, plan: ctx.plan }),
    recheck: async () => (ctx.recheck.length > 1 ? (ctx.recheck.shift() as RecheckOutcome) : (ctx.recheck[0] as RecheckOutcome)),
  };
  const teams: TeamsPort = {
    get: (id) => (id === ctx.team?.id ? ctx.team : null),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
  };
  const guards: TeamGuardsPort = {
    proxyGuard: async () => null,
    stopForCap: async (runId) => void capStops.push(runId),
  };
  const runnerModule: EqModule = createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 1_000, ...options.runnerOptions });

  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" }, ...(options.settings ?? {}) },
    modules: ["floors"],
    equipes: ["teams", "teamPreflight", runnerModule],
    eqPorts: { preflight, teams, guards },
    deps: (base) => {
      // Espion sur TOUTES les lignes de journal (U2, D-eq-26) : aucune consigne, demande, précision ni extrait ne doit y passer.
      const note = (niveau: string) => (message: string, data?: Record<string, unknown>) => void warnings.push({ message: `${niveau} ${message}`, data });
      const log: Logger = { debug: note("debug"), info: note("info"), warn: note("warn"), error: note("error") };
      const classifier = { ...base.classifier, onIdle: (rootId: string) => void classements.push(rootId) } as typeof base.classifier;
      return { log, classifier, ...(options.deps?.(base) ?? {}) };
    },
  });

  h.fake.setAgents([...h.fake.agents(), ...(options.agents ?? [stepAgent(AGENT_SQL), stepAgent(AGENT_SCRIPT)])]);
  const directory = h.fake.directory;
  const snapshot = await h.cockpit.c11.lookup.get(directory);
  const rulesOf = (name: string): Rule[] => snapshot.agents.find((agent) => agent.name === name)?.permission ?? [];
  const stepsOf = (name: string): number | null => snapshot.agents.find((agent) => agent.name === name)?.steps ?? null;

  const flow = options.flow;
  const ordered = planSteps(flow);
  const byId = new Map(
    flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : [])).map((step) => [step.id, step]),
  );
  const etapes: PlannedStep[] = ordered.map((planned) => {
    const step = byId.get(planned.stepId);
    if (!step) throw new Error(`étape absente du déroulé : ${planned.stepId}`);
    const agentRules = rulesOf(step.assistant);
    return {
      stepId: planned.stepId,
      blocIndex: planned.blocIndex,
      ordre: planned.ordre,
      titre: step.titre,
      assistant: step.assistant,
      agentRules,
      rulesSha256: sha256(canonicalRules(agentRules)),
      agentFileSha256: null,
      floor: buildFloor("ETAPE", { agentRules, truncateGlob: truncateGlob() }),
      floorSha256: floorHash("ETAPE", { agentRules, truncateGlob: truncateGlob() }),
      droits: [],
      model: MODEL,
      variant: null,
      steps: stepsOf(step.assistant),
      taille: "M",
    };
  });

  const team: TeamRow = {
    id: "revue-sql",
    titre: "Revue SQL sur réplica",
    description: "",
    flow: JSON.stringify(flow),
    origine: "exemple",
    exemple_id: "revue-sql",
    exemple_version: 1,
    avance: 0,
    created_at: 1,
    updated_at: 1,
  };
  // Le runner retrouve l'équipe par son déroulé (RunPlan ne porte pas son nom) : la ligne doit exister.
  createTeamStore({ db: h.db }).teams.put({
    id: team.id,
    titre: team.titre,
    description: "",
    flow,
    origine: "exemple",
    exempleId: "revue-sql",
    exempleVersion: 1,
    avance: false,
  });

  const estimate = emptyEstimate(ordered.map((planned) => planned.stepId));
  const plan: RunPlan = {
    flow,
    flowSha256: sha256(JSON.stringify(flow)),
    estimate,
    estimateSha256: "a".repeat(64),
    plafond: estimate.plafond,
    rootId: options.rootId ?? null,
    directory,
    modeUi: "avance",
    agentConversation: CHAT_AGENT,
    iaConversation: options.iaConversation === undefined ? { model: MODEL, variant: null } : options.iaConversation,
    etapes,
  };

  Object.assign(ctx, {
    h,
    runner: h.cockpit.equipes.eq.ports.runner as TeamRunner,
    flow,
    team,
    plan,
    capStops,
    classements,
    warnings,
    run: (body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
      h.call("POST", `/api/teams/${team.id}/run`, {
        headers: headers ?? h.headers.mutating,
        body: { directory, rootId: plan.rootId, demande: DEMANDE, fichiers: [], agentConversation: CHAT_AGENT, estimateSha256: plan.estimateSha256, confirmations: {}, ...body },
      }),
    waitRun: async (runId: string, predicate: (view: TeamRunView) => boolean, label = "état attendu") => {
      const found = await until(() => {
        const current = ctx.view(runId);
        return predicate(current) ? current : undefined;
      }, 8_000).catch((err: unknown) => {
        throw new Error(`${label} : ${JSON.stringify(ctx.view(runId).state)} (${String(err)})`);
      });
      return found;
    },
    view: (runId: string) => {
      const found = (h.cockpit.equipes.eq.ports.runner as TeamRunner).view(runId);
      assert.ok(found, "lancement inconnu");
      return found;
    },
  });
  return ctx;
}

/** Sessions d'étape créées par le serveur, dans l'ordre de création. */
const stepSessions = (h: CockpitHarness): FakeSession[] =>
  h.fake.requests
    .filter((req) => req.method === "POST" && req.pathname === "/session" && (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe")
    .map((req) => {
      const metadata = (req.body as { metadata: { etape: string } }).metadata;
      const session = [...h.fake.requests].length >= 0 ? h.fake.session(sessionIdOf(h, metadata.etape)) : undefined;
      return session as FakeSession;
    })
    .filter(Boolean);

const sessionIdOf = (h: CockpitHarness, stepId: string): string => {
  const row = h.db.prepare("SELECT session_id FROM team_run_steps WHERE step_id = ? AND session_id IS NOT NULL ORDER BY tentative DESC LIMIT 1").get(stepId) as
    | { session_id: string }
    | undefined;
  return row?.session_id ?? "";
};

/** Simultanéité maximale observée par les événements `equipe.etape` du hub. */
function maxSimultanees(h: CockpitHarness): number {
  let courant = 0;
  let max = 0;
  for (const event of h.cockpitEvents()) {
    if (event.type !== "equipe.etape") continue;
    const state = (event.data as { state: string }).state;
    if (state === "en-cours") {
      courant++;
      max = Math.max(max, courant);
    } else if (["terminee", "echec", "arretee", "interrompue", "plafond", "non-lancee"].includes(state)) {
      courant = Math.max(0, courant - 1);
    }
  }
  return max;
}

/** P4 : aucune règle « allow » ou « ask » envoyée à opencode hors du plancher ETAPE des sessions d'étape. */
function assertNoLooseRules(ctx: Ctx): void {
  for (const req of ctx.h.fake.requests) {
    const body = req.body as { permission?: unknown; metadata?: { cockpit?: string } } | undefined;
    const rules = body?.permission;
    if (!Array.isArray(rules)) continue;
    const permissives = rules.filter((rule) => (rule as { action?: string }).action !== "deny");
    if (permissives.length === 0) continue;
    assert.equal(body?.metadata?.cockpit, "equipe", `règles permissives hors d'une session d'étape : ${req.method} ${req.pathname}`);
    const etapeId = (body as { metadata: { etape: string } }).metadata.etape;
    const planned = ctx.plan.etapes.find((entry) => entry.stepId === etapeId);
    assert.ok(planned, `étape inconnue : ${etapeId}`);
    assert.equal(canonicalRules(rules as Rule[]), canonicalRules(planned.floor), `plancher envoyé ≠ plancher ETAPE (${etapeId})`);
  }
}

/** U2, D-eq-26 : aucun journal ne cite la consigne, la demande, une précision ou un extrait de résultat. */
function assertNoSecretsInLogs(ctx: Ctx, textes: readonly string[]): void {
  const dump = JSON.stringify(ctx.warnings);
  for (const texte of textes) {
    if (texte.length < 12) continue;
    assert.equal(dump.includes(texte.slice(0, 40)), false, `texte cité dans un journal : ${texte.slice(0, 40)}`);
  }
}

describe("runner d'équipes : avis de bout en bout (spéc. §7.8 l.1189)", () => {
  it("trois avis en même temps puis la synthèse : plancher ETAPE vérifié, résultat injecté noReply, coûts additionnés", async (t) => {
    const ctx = await openTeam(t, { flow: avisFlow() });
    const { h } = ctx;
    for (const [stepId, texte] of [
      ["exactitude", "Avis exactitude : deux jointures à revoir."],
      ["lisibilite", "Avis lisibilité : renommer les alias."],
      ["perf", "Avis performance : ajouter un index."],
      ["synthese", "Synthèse : corriger les jointures puis mesurer."],
    ] as const) {
      h.fake.scriptWhen(
        (session) => (session.metadata as { etape?: string } | undefined)?.etape === stepId,
        { text: texte, cost: 0.01, tokens: { input: 120, output: 40 }, stepMs: 5 },
      );
    }

    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const view = await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");

    // Quatre sessions d'étape, toutes filles de la racine, toutes sous plancher ETAPE vérifié (spéc. §6 l.1032).
    const creations = h.fake.requests.filter((req) => req.method === "POST" && req.pathname === "/session");
    const etapesCreees = creations.filter((req) => (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe");
    assert.equal(etapesCreees.length, 4, "une session par étape");
    for (const step of view.steps) {
      assert.ok(step.sessionId, `étape ${step.stepId} sans session`);
      const session = h.fake.session(step.sessionId as string);
      assert.equal(session?.parentID, rootId, `parentID de ${step.stepId}`);
      const planned = ctx.plan.etapes.find((entry) => entry.stepId === step.stepId);
      assert.equal(canonicalRules((session?.permission ?? []) as Rule[]), canonicalRules(planned?.floor ?? []), `plancher de ${step.stepId}`);
      assert.equal(parseFloorMark(h.sessions.get(step.sessionId as string)?.plancher)?.kind, "ETAPE", `marque de ${step.stepId}`);
      assert.equal(step.state, "terminee", `état de ${step.stepId}`);
      assert.ok(step.cost > 0, `coût de ${step.stepId}`);
    }

    // Simultanéité réelle des avis (ME-4, teams.concurrentSteps = 3) et synthèse après eux.
    assert.equal(maxSimultanees(h), 3, "trois avis lancés en même temps");
    const fins = view.steps.map((step) => [step.stepId, step.endedAt ?? 0] as const);
    const synthese = fins.find(([id]) => id === "synthese")?.[1] ?? 0;
    const dernierAvis = Math.max(...fins.filter(([id]) => id !== "synthese").map(([, at]) => at));
    assert.ok(synthese >= dernierAvis, "la synthèse finit après les avis");
    const messageSynthese = h.fake.messages(sessionIdOf(h, "synthese"))[0];
    const texteSynthese = (messageSynthese?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    for (const avis of ["Avis exactitude", "Avis lisibilité", "Avis performance"]) assert.ok(texteSynthese.includes(avis), `la synthèse reçoit « ${avis} »`);
    for (const avisId of ["exactitude", "lisibilite", "perf"]) {
      const premier = h.fake.messages(sessionIdOf(h, avisId))[0];
      const texte = (premier?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
      assert.equal(texte.includes("Avis "), false, `l'avis ${avisId} ne voit pas le travail des autres (spéc. §6 l.1034)`);
      assert.ok(texte.includes(DEMANDE), `l'avis ${avisId} reçoit la demande`);
    }

    // Deux injections `noReply` dans la racine : aucune ligne `usage`, `prompts.kind` posé (spéc. §6 l.1035).
    const injections = h.fake.requests.filter((req) => req.method === "POST" && req.pathname === `/session/${rootId}/message`);
    assert.equal(injections.length, 2, "demande puis résultat");
    for (const req of injections) assert.equal((req.body as { noReply?: boolean }).noReply, true);
    // ME-3 : les deux identifiants sont ceux des messages RÉELLEMENT enregistrés par opencode, jamais un marqueur.
    const messagesRacine = h.fake.messages(rootId).map((message) => (message as { info: { id: string } }).info.id);
    assert.deepEqual([view.requestMessageId, view.resultMessageId], messagesRacine, "identifiants des deux messages injectés");
    const kinds = h.db
      .prepare("SELECT message_id, kind FROM prompts WHERE session_id = ? ORDER BY created_at, message_id")
      .all(rootId) as unknown as Array<{ message_id: string; kind: string }>;
    assert.deepEqual(
      kinds.filter((row) => row.kind !== "message").map((row) => row.kind),
      ["equipe-demande", "equipe-resultat"],
    );
    assert.equal(kinds.find((row) => row.kind === "equipe-demande")?.message_id, view.requestMessageId);
    assert.equal(kinds.find((row) => row.kind === "equipe-resultat")?.message_id, view.resultMessageId);
    const usageRacine = h.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE session_id = ?").get(rootId) as { n: number };
    assert.equal(usageRacine.n, 0, "aucun appel d'IA dans la racine : le résultat est recopié par le cockpit");

    // Coûts additionnés et résultat de la synthèse injecté.
    const somme = view.steps.reduce((total, step) => total + step.cost, 0);
    assert.ok(Math.abs(view.cost - somme) < 1e-9, `coût du lancement ${view.cost} ≠ somme des étapes ${somme}`);
    const dernierMessage = h.fake.messages(rootId).at(-1);
    const injecte = (dernierMessage?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    assert.ok(injecte.includes("Synthèse : corriger les jointures"), "le résultat de la synthèse est injecté");

    // Archives puis classement prévenus à la main (la racine n'est jamais passée « occupée » : rien ne les déclencherait).
    await until(() => ctx.classements.includes(rootId) || undefined, 4_000).catch(() => assert.fail("classifier.onIdle appelé sur la racine"));
    // `archive.refresh` est attendu AVANT `classifier.onIdle` : la ligne d'archive existe déjà quand le classement est prévenu.
    const archive = h.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?").get(rootId) as { n: number };
    assert.equal(archive.n, 1, "archive.refresh appelé sur la racine avant le classement");
    assert.deepEqual(ctx.classements, [rootId], "un seul classement, celui de la racine");

    // Réouverture : l'assistant de la conversation est restauré, jamais celui d'une étape.
    const restore = pickRestorableAgent({
      choices: null,
      messages: h.fake.messages(rootId) as never,
      agents: [{ name: CHAT_AGENT, mode: "primary" }, { name: AGENT_SQL, mode: "all" }, { name: AGENT_SCRIPT, mode: "all" }],
      defaultAgent: CHAT_AGENT,
      tiers: [],
      chatDefaultTier: "equilibre",
      advanced: true,
      models: [{ key: MODEL }],
    });
    assert.equal(restore.agent, CHAT_AGENT, "assistant de la conversation restauré (pickRestorableAgent)");

    // U2 : la consigne réelle de chaque étape est gardée en base avec son empreinte, et n'apparaît dans AUCUN journal (D-eq-26).
    const consignes = h.db.prepare("SELECT message_text, message_sha256 FROM team_run_steps ORDER BY ordre").all() as unknown as Array<{
      message_text: string | null;
      message_sha256: string | null;
    }>;
    assert.equal(consignes.length, 4);
    for (const ligne of consignes) {
      assert.ok(ligne.message_text && ligne.message_text.length > 0, "consigne gardée en base (U2)");
      assert.equal(ligne.message_sha256, sha256(ligne.message_text as string), "empreinte de la consigne");
    }
    assertNoLooseRules(ctx);
    assertNoSecretsInLogs(ctx, [DEMANDE, "Avis exactitude : deux jointures à revoir.", ...consignes.map((ligne) => ligne.message_text as string)]);
    h.assertNoGlobalRestart();
  });
});

describe("runner d'équipes : pause, précision et correction", () => {
  it("« À la suite » : pause pour vérifier, aucun prompt_async pendant la pause, précision et correction dans l'étape suivante", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", { text: "Résumé standards : trois écarts.", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "securite", { text: "Sécurité : rien de bloquant.", cost: 0.01, stepMs: 5 });

    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const enPause = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause pour vérifier");
    assert.equal(enPause.pause?.kind, "verification");
    assert.equal(enPause.pause?.blocId, "verif");
    assert.ok(enPause.pause?.message.includes("Vérifiez les points bloquants"));
    assert.equal(enPause.pause?.resultat?.etape, "standards");
    assert.ok((enPause.pause?.suite.maximum ?? 0) > 0, "coût du reste du chemin");
    assert.equal(ctx.runner.stepsBusy(), false, "stepsBusy faux pendant une pause (D-eq-06)");

    const envoisAvant = h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length;
    assert.equal(envoisAvant, 1, "un seul envoi avant la pause");

    const reprise = await h.call("POST", `/api/team-runs/${runId}/continue`, {
      headers: h.headers.mutating,
      body: { precision: "Ne regarde que les scripts de nuit.", correction: "Résumé corrigé : un seul écart." },
    });
    assert.equal(reprise.status, 200, reprise.body);
    const fin = await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");
    assert.equal(fin.steps.length, 2);

    const corps = (h.fake.messages(sessionIdOf(h, "securite"))[0]?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    assert.ok(corps.includes("Ne regarde que les scripts de nuit."), "la précision est dans le corps de l'étape suivante");
    assert.ok(corps.includes("Résumé corrigé : un seul écart."), "la correction remplace le résultat transmis");
    assert.ok(corps.includes("corrigé par vous"), "le résultat corrigé est marqué");
    assert.equal(corps.includes("Résumé standards : trois écarts."), false, "le résultat d'origine n'est plus transmis");
    const correction = h.db.prepare("SELECT correction_sha256 FROM team_run_steps WHERE step_id = 'standards'").get() as { correction_sha256: string | null };
    assert.equal(correction.correction_sha256, sha256("Résumé corrigé : un seul écart."));

    assertNoLooseRules(ctx);
    assertNoSecretsInLogs(ctx, [DEMANDE, "Ne regarde que les scripts de nuit.", "Résumé corrigé : un seul écart."]);
    h.assertNoGlobalRestart();
  });
});

describe("runner d'équipes : gardes d'une étape", () => {
  it("écho de plancher faux : session supprimée, étape en échec, aucune étape suivante, aucun envoi", async (t) => {
    const ctx = await openTeam(t, {
      flow: suiteFlow(),
      deps: (base) => ({
        // Écho amputé du plancher : le serveur doit refuser d'envoyer quoi que ce soit à cette session.
        client: new Proxy(base.client, {
          get(target, prop, receiver) {
            if (prop !== "request") {
              const value = Reflect.get(target, prop, receiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }
            return async (method: string, pathname: string, opts?: Record<string, unknown>) => {
              const response = await target.request<unknown>(method, pathname, opts as never);
              const body = opts?.body as { metadata?: { cockpit?: string } } | undefined;
              if (method === "POST" && pathname === "/session" && body?.metadata?.cockpit === "equipe") {
                return { ...(response as Record<string, unknown>), permission: [{ permission: "*", pattern: "*", action: "allow" }] };
              }
              return response;
            };
          },
        }),
      }),
    });
    const { h } = ctx;
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "echec", "équipe en échec");
    assert.equal(vue.steps[0]?.state, "echec");
    assert.equal(vue.steps[0]?.cause, "plancher-etape");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi à l'IA");
    const suppressions = h.fake.requests.filter((req) => req.method === "DELETE" && req.pathname.startsWith("/session/"));
    assert.equal(suppressions.length, 1, "la session sans plancher vérifié est supprimée");
    // D-eq-20 : l'échec arrête l'équipe ; l'étape suivante reste prévue, sans session et sans envoi.
    const suivante = vue.steps.find((step) => step.stepId === "securite");
    assert.equal(suivante?.state, "prevue", "aucune étape suivante lancée");
    assert.equal(suivante?.sessionId, null);
    assert.equal(
      h.fake.requests.filter((req) => (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe").length,
      1,
      "une seule session d'étape créée",
    );
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("écho de plancher : un parent qui n'est pas la racine est refusé comme un plancher manquant", async (t) => {
    const ctx = await openTeam(t, {
      flow: suiteFlow(),
      deps: (base) => ({
        client: new Proxy(base.client, {
          get(target, prop, receiver) {
            if (prop !== "request") {
              const value = Reflect.get(target, prop, receiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }
            return async (method: string, pathname: string, opts?: Record<string, unknown>) => {
              const response = await target.request<unknown>(method, pathname, opts as never);
              const body = opts?.body as { metadata?: { cockpit?: string } } | undefined;
              // Session rendue rattachée à une AUTRE conversation : elle ne doit jamais recevoir la consigne de l'étape.
              if (method === "POST" && pathname === "/session" && body?.metadata?.cockpit === "equipe") {
                return { ...(response as Record<string, unknown>), parentID: "ses_autre_racine" };
              }
              return response;
            };
          },
        }),
      }),
    });
    const { h } = ctx;
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "echec", "équipe en échec");
    assert.equal(vue.steps[0]?.cause, "plancher-etape");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi à l'IA");
    assert.equal(h.fake.requests.filter((req) => req.method === "DELETE" && req.pathname.startsWith("/session/")).length, 1, "session supprimée");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("règles de l'assistant changées avant une étape : pause « attente-modification », aucun envoi", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    // Les règles du plan ne sont plus celles d'opencode : l'étape suivante attend votre choix.
    ctx.plan.etapes[0] = { ...(ctx.plan.etapes[0] as PlannedStep), agentRules: [{ permission: "*", pattern: "*", action: "ask" }] };
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-modification", "pause modification");
    assert.equal(vue.pause?.kind, "modification");
    assert.ok(vue.pause?.message.includes(AGENT_SCRIPT), "l'assistant changé est nommé");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi");
    assert.equal(h.fake.requests.filter((req) => (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe").length, 0, "aucune session d'étape");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("IA de l'étape indisponible : étape en échec, aucun repli sur une autre IA", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    ctx.plan.etapes[0] = { ...(ctx.plan.etapes[0] as PlannedStep), model: "github-copilot/modele-retire" };
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "echec", "équipe en échec");
    assert.equal(vue.steps[0]?.cause, "ia-indisponible");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("garde-fou budgétaire non confirmé : pause « attente-budget », puis reprise confirmée", async (t) => {
    const ctx = await openTeam(t, {
      flow: suiteFlow(),
      settings: { ui: { mode: "avance" }, budget: { guard: { enabled: true, fromPercent: 0, maxOutputPricePerM: 0, blockAtLimit: false } } },
    });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", { text: "Standards : rien à dire.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-budget", "pause budget");
    assert.equal(vue.pause?.kind, "budget");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "rien n'est facturé pendant la pause");

    const sansConfirmation = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.equal(sansConfirmation.status, 409, sansConfirmation.body);
    assert.equal(sansConfirmation.json<{ error: string }>().error, "budget-guard");

    const confirmee = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.confirmed, body: {} });
    assert.equal(confirmee.status, 200, confirmee.body);
    await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "terminee", "étape lancée après confirmation");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("demande facturée refusée par le cockpit : étape « en-file » puis reprise", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", { text: "Standards : rien à dire.", cost: 0.01, stepMs: 5 });
    // Application de la configuration en cours : la demande facturée est différée, jamais perdue.
    const queue = h.deps.configQueue;
    assert.ok(queue, "file de configuration du harnais");
    let release = (): void => undefined;
    const applying = new Promise<void>((resolve) => {
      release = resolve;
    });
    void queue.applyingWhile(() => applying);
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "en-file", "étape en file");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0);
    release();
    await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "terminee", "étape reprise");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("réponse « peut-être incomplète » (ME-7) : comptée sur TOUS les messages d'assistant, pas sur les vingt derniers", async (t) => {
    // Avis : `steps: 40` (au-delà de la lecture par défaut) ; synthèse : `steps: 1`, atteint dès la première réponse.
    const ctx = await openTeam(t, { flow: avisFlow(), agents: [stepAgent(AGENT_SQL, 40), stepAgent(AGENT_SCRIPT, 1)] });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Réponse d'étape.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");
    assert.equal(vue.steps.find((step) => step.stepId === "synthese")?.tronquee, true, "la synthèse a atteint sa limite d'actions");
    for (const stepId of ["exactitude", "lisibilite", "perf"]) {
      assert.equal(vue.steps.find((step) => step.stepId === stepId)?.tronquee, false, `${stepId} : une réponse sur 40 actions possibles`);
    }
    // Avec `limit=20`, la règle ne se déclencherait jamais pour `steps` 40 : la lecture en demande toujours au moins steps + 1.
    const limites = h.fake.requests
      .filter((req) => req.method === "GET" && req.pathname.endsWith("/message") && req.pathname !== `/session/${vue.rootId}/message`)
      .map((req) => Number(req.query?.limit ?? 0));
    assert.ok(limites.length >= 4, `une lecture par étape : ${limites.length}`);
    assert.ok(
      limites.filter((limite) => limite >= 41).length >= 3,
      `lecture bornée à ${JSON.stringify(limites)} : les messages d'assistant ne seraient pas tous comptés`,
    );
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("étape abandonnée hors du cockpit (ME-6) : « interrompue », lue AVANT le test « texte vide », équipe arrêtée", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    // Tour lent : l'abandon arrive PENDANT la réponse de l'étape ; le message d'assistant porte alors MessageAbortedError (ME-6),
    // lu AVANT le test « texte vide » — sans cet ordre, l'étape finirait en « echec » (« L'étape n'a rien rendu. »).
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", {
      text: "Début de réponse, interrompu.",
      cost: 0.01,
      stepMs: 500,
    });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const session = await until(() => sessionIdOf(h, "standards") || undefined, 8_000);
    await until(() => (h.fake.messages(session).some((message) => (message as { info: { role: string } }).info.role === "assistant") ? true : undefined), 8_000);
    const abandon = await h.call("POST", `/api/oc/session/${session}/abort`, { headers: h.headers.mutating, body: {} });
    assert.ok(abandon.status < 400, abandon.body);
    const vue = await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "interrompue", "étape interrompue");
    assert.equal(vue.steps[0]?.cause, "rechargement", "abandon qui ne vient pas du cockpit");
    assert.equal(vue.steps.find((step) => step.stepId === "securite")?.state, "prevue", "aucune étape suivante");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("doom_loop sous plancher ETAPE : étape « attente-accord », puis reprise après la réponse", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", {
      text: "Standards : rien à dire.",
      cost: 0.01,
      stepMs: 5,
      tools: [{ tool: "doom_loop", input: {}, ask: { permission: "doom_loop", patterns: ["*"], scope: "agent" }, askAfterMs: 2 }],
    });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "attente-accord", "étape en attente d'accord");
    const demande = h.fake.pendingPermissions()[0];
    assert.ok(demande, "une demande d'autorisation est posée");
    const reponse = await h.call("POST", `/api/oc/permission/${demande.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(reponse.status < 400, true, reponse.body);
    await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "terminee", "étape terminée après la réponse");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});

describe("runner d'équipes : contrôle de fraîcheur (A4, D-eq-17)", () => {
  it("changement depuis l'estimation : 202, pause « À vérifier », aucune injection ni session d'étape ; [Continuer] rejoue le contrôle", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", { text: "Standards : rien à dire.", cost: 0.01, stepMs: 5 });
    ctx.recheck = [
      { ok: false, genre: "changement", code: "extension-configuree" },
      { ok: false, genre: "changement", code: "conversation-occupee" },
      { ok: true },
    ];
    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const pause = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause de fraîcheur");
    assert.equal(pause.pause?.kind, "changement");
    assert.equal(pause.pause?.changement?.code, "extension-configuree");
    assert.ok(pause.pause?.message.includes("Rien n'a été envoyé ni facturé."));
    assert.equal(pause.requestMessageId, null, "aucune injection");
    assert.equal(h.fake.requests.filter((req) => req.pathname === `/session/${rootId}/message`).length, 0, "aucun message injecté");
    assert.equal(h.fake.requests.filter((req) => (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe").length, 0, "aucune session d'étape");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi");

    // [Continuer l'équipe] avec un contrôle toujours en échec : pause gardée, raison mise à jour.
    const encore = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.equal(encore.status, 200, encore.body);
    const misAJour = await ctx.waitRun(runId, (v) => v.pause?.changement?.code === "conversation-occupee", "raison mise à jour");
    assert.equal(misAJour.state, "attente-verification");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0);

    // Contrôle qui passe : injection de la demande puis première étape.
    const reprise = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.equal(reprise.status, 200, reprise.body);
    const vue = await ctx.waitRun(runId, (v) => (v.steps[0]?.state ?? "") === "terminee", "première étape faite");
    assert.ok(vue.requestMessageId, "la demande est injectée après le contrôle");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("règles changées au contrôle de fraîcheur : « attente-modification » sans rien envoyer", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    ctx.recheck = [{ ok: false, genre: "modification" }];
    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-modification", "pause modification");
    assert.equal(vue.pause?.kind, "modification");
    assert.equal(h.fake.requests.filter((req) => req.pathname === `/session/${rootId}/message`).length, 0);
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("mode Simple tant que les équipes y sont fermées (U1) : 403 equipes-simple-fermees, aucune requête, aucun lancement", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow(), settings: { ui: { mode: "simple" } } });
    const { h } = ctx;
    const avant = h.fake.requests.length;
    const refuse = await ctx.run();
    assert.equal(refuse.status, 403, refuse.body);
    assert.equal(refuse.json<{ error: string }>().error, "equipes-simple-fermees");
    assert.deepEqual(h.fake.requests.slice(avant), [], "aucune requête à opencode");
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n, 0);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("corps de lancement invalide : 400 sans requête ; équipe inconnue : 404", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    const avant = h.fake.requests.length;
    for (const corps of [{ demande: 42 }, { estimateSha256: "court" }, { directory: "" }, { fichiers: "non" }, { agentConversation: "" }]) {
      const reponse = await ctx.run(corps as Record<string, unknown>);
      assert.equal(reponse.status, 400, `${JSON.stringify(corps)} : ${reponse.body}`);
    }
    const inconnue = await h.call("POST", "/api/teams/equipe-inconnue/run", {
      headers: h.headers.mutating,
      body: { directory: h.fake.directory, rootId: null, demande: DEMANDE, fichiers: [], agentConversation: CHAT_AGENT, estimateSha256: "a".repeat(64) },
    });
    assert.equal(inconnue.status, 404, inconnue.body);
    assert.deepEqual(h.fake.requests.slice(avant), [], "aucune requête à opencode pour un refus de forme");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("refus du pré-lancement : réponse telle quelle et ZÉRO requête émise par le runner (spéc. §3.13 l.419)", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    ctx.refus = { status: 409, code: "conversation-occupee" };
    const avant = h.fake.requests.length;
    const refuse = await ctx.run();
    assert.equal(refuse.status, 409, refuse.body);
    const corps = refuse.json<{ error: string; message: string }>();
    assert.equal(corps.error, "conversation-occupee");
    assert.ok(corps.message.includes("Rien n'a été envoyé ni facturé."), corps.message);
    assert.deepEqual(h.fake.requests.slice(avant), [], "aucune requête à opencode pour un refus");
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n, 0, "aucun lancement enregistré");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});

describe("runner d'équipes : injection, résultats ajoutés et IA de la conversation", () => {
  it("IA de la conversation : agent et modèle du plan ; champ `model` absent quand l'IA est nulle", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow(), iaConversation: null });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.requestMessageId !== null, "demande injectée");
    const injection = h.fake.requests.find((req) => req.pathname === `/session/${rootId}/message`);
    assert.equal((injection?.body as { agent?: string })?.agent, CHAT_AGENT);
    assert.equal(Object.hasOwn(injection?.body as object, "model"), false, "aucun champ model quand l'IA de la conversation est nulle");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("injection du résultat refusée par opencode : carte seule, puis [Ajouter à la conversation] une seule fois", async (t) => {
    let refuser = true;
    const ctx = await openTeam(t, {
      flow: soloFlow(),
      deps: (base) => ({
        client: new Proxy(base.client, {
          get(target, prop, receiver) {
            if (prop !== "request") {
              const value = Reflect.get(target, prop, receiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }
            return async (method: string, pathname: string, opts?: Record<string, unknown>) => {
              const body = opts?.body as { noReply?: boolean; parts?: Array<{ text?: string }> } | undefined;
              const estResultat = body?.noReply === true && (body.parts?.[0]?.text ?? "").includes("equipe-resultat");
              if (refuser && method === "POST" && pathname.endsWith("/message") && estResultat) throw new Error("two consecutive user messages");
              return target.request<unknown>(method, pathname, opts as never);
            };
          },
        }),
      }),
    });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");
    assert.equal(fini.resultMessageId, null, "carte seule : aucun message injecté");
    assert.equal(fini.resultatsAjoutes, false);
    const refus = createTeamStore({ db: h.db }).events.ofRun(runId).filter((row) => row.kind === "injection-refusee");
    assert.equal(refus.length, 1, "événement injection-refusee");

    refuser = false;
    const ajout = await ctx.runner.addResults(runId);
    assert.ok("messageId" in ajout, JSON.stringify(ajout));
    assert.equal(ctx.view(runId).resultatsAjoutes, true);
    const second = await ctx.runner.addResults(runId);
    assert.deepEqual(second, { ok: false, status: 409, code: "deja-ajoute" }, "une seule injection (D-eq-22)");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});

describe("runner d'équipes : redémarrage, relance et lectures", () => {
  /** Lancement et étapes écrits comme avant un redémarrage du cockpit (la reprise est faite par cockpit.startup()). */
  function seedRun(h: CockpitHarness, options: { runId: string; rootId: string; flow: Flow; state: string; cause?: string | null; sessionId?: string | null; messageText?: string }) {
    h.db
      .prepare(
        `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, cause, facultatifs, plafond, cost, confirmations, precisions, created_at, started_at)
         VALUES (:id, 'Revue SQL sur réplica', :flow, 'f0', :root, :dir, :state, :cause, '[]', 1, 0, '{}', '[]', 1, 1)`,
      )
      .run({ id: options.runId, flow: JSON.stringify(options.flow), root: options.rootId, dir: h.fake.directory, state: options.state, cause: options.cause ?? null });
    planSteps(options.flow).forEach((planned, index) => {
      h.db
        .prepare(
          `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, state, session_id, message_text, model, cost)
           VALUES (:run, :step, 1, 1, :ordre, :bloc, :titre, :agent, :state, :session, :texte, :model, 0)`,
        )
        .run({
          run: options.runId,
          step: planned.stepId,
          ordre: planned.ordre,
          bloc: planned.blocIndex,
          titre: planned.stepId,
          agent: AGENT_SCRIPT,
          state: index === 0 ? (options.sessionId ? "en-cours" : "prevue") : "prevue",
          session: index === 0 ? (options.sessionId ?? null) : null,
          texte: index === 0 ? (options.messageText ?? null) : null,
          model: MODEL,
        });
    });
  }

  it("recover : étape occupée rattachée, aucune nouvelle étape, pause « redemarrage-cockpit », demande reconstituée", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow() });
    const { h } = ctx;
    const runId = "11111111-2222-3333-4444-555555555555";
    // Racine et session d'étape déjà créées, comme avant le redémarrage ; la session travaille encore.
    const racine = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } });
    const rootId = racine.json<FakeSession>().id;
    const enfant = h.fake.session(
      (
        await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Étape" } })
      ).json<FakeSession>().id,
    ) as FakeSession;
    h.fake.script(enfant.id, { text: "Standards : rien à dire.", cost: 0.01, stepMs: 40 });
    // Consigne réellement envoyée avant le redémarrage : la demande y est encadrée par les marqueurs de D-eq-27.
    const texte = stepMessage(duoFlow(), "standards", {
      runId,
      tour: 1,
      tentative: 1,
      equipe: "Revue SQL sur réplica",
      total: 2,
      n: 1,
      demande: DEMANDE,
      fichiers: ["notes/requete.sql"],
      precisions: [],
      resultats: [],
    });
    seedRun(h, { runId, rootId, flow: duoFlow(), state: "en-cours", sessionId: enfant.id, messageText: texte });
    await h.call("POST", `/api/oc/session/${enfant.id}/prompt_async`, { headers: h.headers.mutating, body: { agent: AGENT_SCRIPT, model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "Travaille." }] } });

    const avant = h.fake.requests.length;
    await h.cockpit.startup();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause de redémarrage");
    assert.equal(vue.pause?.kind, "redemarrage-cockpit");
    assert.equal(vue.steps[0]?.state, "terminee", "l'étape rattachée a été lue et enregistrée");
    const apres = h.fake.requests.slice(avant);
    assert.equal(apres.filter((req) => req.method === "POST" && req.pathname === "/session").length, 0, "aucune session créée après le redémarrage");
    assert.equal(apres.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi après le redémarrage");

    // Instantané perdu avec la mémoire : [Continuer] ne lance rien et demande une nouvelle estimation (rien n'est facturé).
    const continuer = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.equal(continuer.status, 409, continuer.body);
    assert.equal(continuer.json<{ error: string }>().error, "estimation-perimee");
    assert.equal(h.fake.requests.slice(avant).filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "toujours aucun envoi");

    // D-eq-27 : la relance reconstitue la demande depuis `message_text`, sans aucune colonne dédiée ni requête de lecture.
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "securite", { text: "Sécurité : rien de bloquant.", cost: 0.01, stepMs: 5 });
    const relance = await ctx.runner.relaunch(runId, { ...ctx.plan, rootId });
    assert.ok(!("ok" in relance), JSON.stringify(relance));
    await ctx.waitRun(runId, (v) => v.state === "terminee", "suite relancée");
    const corps = (h.fake.messages(sessionIdOf(h, "securite"))[0]?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    assert.ok(corps.includes(DEMANDE), "la demande est reconstituée depuis le message de l'étape déjà envoyée");
    assert.ok(corps.includes("notes/requete.sql"), "les pièces jointes sont reconstituées elles aussi");
    assertNoSecretsInLogs(ctx, [DEMANDE]);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("recover : équipe en pause « changement » sans étape envoyée → interrompue et non relançable", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    const runId = "22222222-3333-4444-5555-666666666666";
    const racine = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } });
    seedRun(h, { runId, rootId: racine.json<FakeSession>().id, flow: suiteFlow(), state: "attente-verification", cause: "changement" });
    const avant = h.fake.requests.length;
    await h.cockpit.startup();
    const vue = ctx.view(runId);
    assert.equal(vue.state, "interrompue");
    assert.equal(vue.cause, "redemarrage-cockpit");
    assert.equal(vue.relancable, false, "rien n'a été envoyé : la relance passe par la saisie (D-eq-27)");
    assert.deepEqual(h.fake.requests.slice(avant), [], "aucune requête pendant la reprise");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("relaunch : demande non reconstituable (textes purgés) → « pas-relancable », aucune requête (D-eq-27)", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow() });
    const { h } = ctx;
    const runId = "33333333-4444-5555-6666-777777777777";
    const racine = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } });
    // Lancement en échec dont aucune étape ne garde sa consigne : la demande n'existe plus nulle part (purge, D-eq-27).
    seedRun(h, { runId, rootId: racine.json<FakeSession>().id, flow: duoFlow(), state: "echec", cause: "echec" });
    const avant = h.fake.requests.length;
    const refus = await ctx.runner.relaunch(runId, ctx.plan);
    assert.deepEqual(refus, { ok: false, status: 409, code: "pas-relancable" });
    assert.equal(ctx.view(runId).state, "echec", "l'état n'a pas bougé");
    assert.equal(ctx.view(runId).relancable, false, "la vue le dit aussi");
    assert.deepEqual(h.fake.requests.slice(avant), [], "aucune requête à opencode");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("relaunch : nouvelle tentative et nouvelle session pour l'étape restante, étape terminée non refacturée", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === "standards", { text: "Standards : rien à dire.", cost: 0.01, stepMs: 5 });
    // La seconde étape échoue à la première tentative (réponse vide), puis réussit à la seconde (relance).
    const tentative = (s: FakeSession, n: number) => {
      const md = s.metadata as { etape?: string; tentative?: number } | undefined;
      return md?.etape === "securite" && md.tentative === n;
    };
    h.fake.scriptWhen((s) => tentative(s, 1), { text: "", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((s) => tentative(s, 2), { text: "Sécurité : rien de bloquant.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause");
    await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    const echoue = await ctx.waitRun(runId, (v) => v.state === "echec", "équipe en échec");
    assert.equal(echoue.steps.find((step) => step.stepId === "securite")?.state, "echec");
    const coutAvant = echoue.cost;
    const sessionsAvant = new Set(echoue.steps.map((step) => step.sessionId));

    const relance = await ctx.runner.relaunch(runId, ctx.plan);
    assert.ok(!("ok" in relance), JSON.stringify(relance));
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe relancée terminée");
    const tentatives = fini.steps.filter((step) => step.stepId === "securite");
    assert.deepEqual(tentatives.map((step) => step.tentative), [1, 2], "une nouvelle tentative");
    assert.equal(tentatives[1]?.state, "terminee");
    assert.equal(sessionsAvant.has(tentatives[1]?.sessionId ?? ""), false, "nouvelle session pour la nouvelle tentative");
    const standards = fini.steps.filter((step) => step.stepId === "standards");
    assert.equal(standards.length, 1, "l'étape terminée n'est pas refaite");
    assert.ok(fini.cost >= coutAvant, "le coût déjà engagé reste compté");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("pause pendant que des avis travaillent : stepsBusy reste vrai tant qu'une étape n'a pas fini (D-eq-06)", async (t) => {
    const ctx = await openTeam(t, { flow: avisFlow() });
    const { h } = ctx;
    // Deux avis répondent lentement ; le troisième met l'équipe en pause (ses règles ne sont plus celles de l'instantané).
    for (const stepId of ["exactitude", "perf", "synthese"]) {
      h.fake.scriptWhen((s) => (s.metadata as { etape?: string } | undefined)?.etape === stepId, { text: `Avis ${stepId}.`, cost: 0.01, stepMs: 1_200 });
    }
    const index = ctx.plan.etapes.findIndex((step) => step.stepId === "lisibilite");
    ctx.plan.etapes[index] = { ...(ctx.plan.etapes[index] as PlannedStep), agentRules: [{ permission: "*", pattern: "*", action: "ask" }] };
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-modification", "pause de modification");
    // La garde de rechargement ne doit pas dire « au repos » pendant qu'une étape travaille encore.
    assert.equal(ctx.runner.stepsBusy(), true, "une étape lancée avant la pause travaille encore");
    // Puis les avis finissent : la pause rend la main (aucune étape n'est reprise, l'équipe reste en attente).
    await until(() => (ctx.runner.stepsBusy() ? undefined : true), 8_000).catch(() => assert.fail("la pause ne rend jamais la main"));
    assert.equal(ctx.view(runId).state, "attente-modification", "l'équipe est toujours en pause");
    assert.equal(ctx.view(runId).steps.filter((step) => step.state === "terminee").length, 2, "les deux avis lancés ont fini");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("arrêt au plafond (guards.stopForCap) : lancement « plafond », relançable", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause");
    // Le décorateur de L37c transmet la cause de l'arrêt : le lancement finit « plafond », pas « arretee ».
    ctx.runner.stopRequested(rootId, "plafond-cout");
    ctx.runner.stopped(rootId, "plafond-cout", { rootId, rejected: 0, aborted: [], unconfirmed: [], durationMs: 1 });
    const vue = ctx.view(runId);
    assert.equal(vue.state, "plafond");
    assert.equal(vue.cause, "plafond");
    assert.equal(vue.relancable, true, "une équipe arrêtée au plafond se relance");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("interruption puis fermeture : étapes « interrompue », lancement relançable, puis « arretee » par [Fermer]", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause");
    ctx.runner.interrupt(runId, "rechargement");
    const interrompu = ctx.view(runId);
    assert.equal(interrompu.state, "interrompue");
    assert.equal(interrompu.cause, "rechargement");
    assert.equal(interrompu.steps.find((step) => step.stepId === "securite")?.state, "non-lancee");
    assert.equal(interrompu.relancable, true, "une équipe interrompue se relance");
    const ferme = ctx.runner.close(runId);
    assert.ok(!("ok" in ferme), JSON.stringify(ferme));
    assert.equal(ctx.view(runId).state, "arretee");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("arrêt demandé pendant une étape : la suite n'est plus lancée, même avant l'arrêt interne (D-eq-05)", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 300 });
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await until(() => (ctx.view(runId).steps[0]?.state === "en-cours" ? true : undefined), 8_000);
    // `stopRequested` est appelé par le décorateur AVANT stopTree : la première étape finit, la seconde ne part jamais.
    ctx.runner.stopRequested(rootId, "vous");
    await until(() => (ctx.view(runId).steps[0]?.state === "terminee" ? true : undefined), 8_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sessions = h.fake.requests.filter((req) => (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe");
    assert.equal(sessions.length, 1, "aucune session pour l'étape suivante");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, 1, "aucun envoi pour l'étape suivante");
    assert.equal(ctx.view(runId).steps.find((step) => step.stepId === "securite")?.state, "prevue");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("stepsBusy, GET /api/team-runs?sessionId= et ?rootId=", async (t) => {
    // D-eq-06 : la garde de rechargement lit `stepsBusy` ENTRE POST /session et prompt_async, l'intervalle où la session
    // d'étape existe sans rien envoyer encore. L'espion le relève au moment même de l'envoi.
    const entreDeux: boolean[] = [];
    const factures: number[] = [];
    const ctx = await openTeam(t, {
      flow: suiteFlow(),
      deps: (base) => ({
        client: new Proxy(base.client, {
          get(target, prop, receiver) {
            if (prop !== "request") {
              const value = Reflect.get(target, prop, receiver) as unknown;
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }
            return async (method: string, pathname: string, opts?: Record<string, unknown>) => {
              if (pathname.endsWith("/prompt_async")) {
                entreDeux.push(runnerOf().stepsBusy());
                // L'envoi d'une étape est une demande FACTURÉE : elle est comptée par configQueue le temps de la requête.
                factures.push(queueOf().billedInFlight);
              }
              return target.request<unknown>(method, pathname, opts as never);
            };
          },
        }),
      }),
    });
    const { h } = ctx;
    const runnerOf = (): TeamRunner => ctx.runner;
    const queueOf = () => {
      const queue = h.deps.configQueue;
      assert.ok(queue, "file de configuration du harnais");
      return queue;
    };
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 30 });
    assert.equal(ctx.runner.stepsBusy(), false, "aucune équipe : faux");
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    assert.equal(ctx.runner.stepsBusy(), true, "équipe en préparation ou en cours : vrai");
    await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause");
    assert.deepEqual(entreDeux, [true], "vrai entre POST /session et prompt_async");
    assert.deepEqual(factures, [1], "l'envoi de l'étape est compté comme demande facturée (configQueue.beginBilled)");
    assert.equal(queueOf().billedInFlight, 0, "compteur rendu après l'envoi");
    assert.equal(ctx.runner.stepsBusy(), false, "faux pendant la pause");

    const etape = sessionIdOf(h, "standards");
    const parSession = await h.call("GET", `/api/team-runs?sessionId=${etape}`, { headers: h.headers.authed });
    assert.equal(parSession.status, 200, parSession.body);
    assert.deepEqual(parSession.json<{ runs: TeamRunView[] }>().runs.map((run) => run.id), [runId]);
    const parRacine = await h.call("GET", `/api/team-runs?rootId=${rootId}`, { headers: h.headers.authed });
    assert.deepEqual(parRacine.json<{ runs: TeamRunView[] }>().runs.map((run) => run.id), [runId]);
    const inconnue = await h.call("GET", `/api/team-runs?sessionId=${rootId}`, { headers: h.headers.authed });
    assert.deepEqual(inconnue.json<{ runs: TeamRunView[] }>().runs, [], "une racine n'est pas une session d'étape");
    const parRun = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
    assert.equal(parRun.json<TeamRunView>().id, runId);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("arrêt demandé : étapes non lancées « non-lancee », lancement « arretee », plus aucun envoi", async (t) => {
    const ctx = await openTeam(t, { flow: suiteFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Fait.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause");
    const envois = h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length;
    assert.deepEqual(ctx.runner.activeRunOf(rootId), { runId, state: "attente-verification" }, "lancement actif de la racine");
    ctx.runner.stopRequested(rootId, "vous");
    ctx.runner.stopped(rootId, "vous", { rootId, rejected: 0, aborted: [], unconfirmed: [], durationMs: 1 });
    const vue = ctx.view(runId);
    assert.equal(vue.state, "arretee");
    assert.equal(vue.cause, "vous");
    assert.equal(vue.steps.find((step) => step.stepId === "securite")?.state, "non-lancee");
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, envois, "aucun envoi après l'arrêt");
    assert.equal(ctx.runner.activeRunOf(rootId), null, "plus aucun lancement actif après l'arrêt");
    // « arretee » est final (transitions de T4) : ni reprise, ni relance, ni fermeture.
    assert.deepEqual(await ctx.runner.continue(runId, {}, false), { ok: false, status: 409, code: "etat-incompatible" });
    assert.deepEqual(await ctx.runner.relaunch(runId, ctx.plan), { ok: false, status: 409, code: "pas-relancable" });
    assert.deepEqual(ctx.runner.close(runId), { ok: false, status: 409, code: "etat-incompatible" });
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});
