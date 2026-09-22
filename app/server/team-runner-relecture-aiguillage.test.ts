// Relecture, aiguillage, transmissions et méthodes des étapes — EXÉCUTION (plan d'exécution it5, fiche L42b ; spéc. §3.13
// l.414-425, §4.11 l.772, §6 l.1036-1037 ; conception C §6.2, §6.3, §6.5, §6.7, §17.2 « Runner »).
//
// Tout se joue sur le FAUX opencode (C §17.2) : aucune exécution facturée, aucun appel à un fournisseur réel.
//
// Ce que ces tests tiennent, garde par garde :
// - D-5-14 (confirmée par la mesure MC5-2) : un bloc de relecture crée EXACTEMENT deux sessions, quel que soit le nombre de
//   tours — le tour 2 repart de la session existante, avec tout son historique, et son corps est la version encadrée du tour
//   précédent. Un verdict illisible est traité comme « à reprendre », jamais comme une relecture concluante ;
// - spéc. l.772 : aucun spécialiste ne part avant VOTRE confirmation, un choix qui ne tient pas est refusé sans la moindre
//   requête, « aucun ne convient » ne coûte rien, et aucun module ne rappelle `continue` à votre place (espion) ;
// - A4 : la reprise de fraîcheur d'avant chaque étape couvre les méthodes — une méthode posée dans le fichier de l'assistant
//   entre l'estimation et l'étape met l'équipe en pause « À vérifier », sans aucun `prompt_async` ;
// - D-eq-05 : un arrêt pendant le tour 2 clôt tout le lancement, et le plafond l'arrête au tour 2 comme à toute autre étape.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import type { EqModule, PlannedStep, PreflightOutcome, RecheckOutcome, RunPlan, TeamGuardsPort, TeamPreflightPort, TeamRow, TeamsPort } from "./contracts-eq.ts";
import type { Logger } from "./log.ts";
import { METHODS } from "./methods-catalogue.ts";
import { floorHash } from "./session-floor-service.ts";
import { type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import { DELIVERABLE_TEXTS, METHODE_HEADER, STEP_SECTIONS } from "./shared/flow.ts";
import { renderMethodBlock } from "./shared/methods.ts";
import { buildFloor, canonicalRules } from "./shared/session-floors.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowBlock, FlowEstimate, FlowStep, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import { createTeamRunnerModule, type TeamRunner } from "./team-runner.ts";
import { createTeamStore } from "./team-store.ts";

const MODEL = "github-copilot/gpt-5-mini";
const AGENT_SQL = "relire-requete-sql";
const AGENT_SCRIPT = "relire-script";
const CHAT_AGENT = "build";
const DEMANDE = "Le traitement de nuit est tombé deux fois cette semaine.";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const CINQ_POURQUOI = METHODS.find((methode) => methode.id === "cinq-pourquoi");
if (!CINQ_POURQUOI) throw new Error("catalogue des méthodes : « cinq-pourquoi » attendue (L44a)");

/** Règles d'un assistant en lecture seule du catalogue (refus par défaut, lecture permise). */
const readOnlyRules = (): Rule[] => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const stepAgent = (name: string): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant de test ${name}`,
  options: {},
  permission: readOnlyRules() as FakeAgent["permission"],
});

type Recoit = FlowStep["recoit"];

const etape = (id: string, titre: string, assistant: string, recoit: Recoit, methodes?: string[]): FlowStep => ({
  id,
  titre,
  assistant,
  niveau: null,
  taille: "M",
  consigne: `Consigne de ${titre}.`,
  recoit,
  ...(methodes ? { methodes } : {}),
});

/** Étapes déclarées d'un bloc : le test ne peut pas se servir de l'ordre d'ESTIMATION (planSteps) pour bâtir le plan. */
function etapesDuBloc(bloc: FlowBlock): FlowStep[] {
  switch (bloc.type) {
    case "etape":
      return [bloc.etape];
    case "avis":
      return [...bloc.avis, bloc.synthese];
    case "relecture":
      return [bloc.auteur, bloc.relecteur];
    case "aiguillage":
      return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : [])];
    default:
      return [];
  }
}

/**
 * Toutes les étapes déclarées du déroulé, dans l'ordre d'écriture, avec leur place. Le pré-lancement RÉEL (L37p) bâtit son
 * instantané sur `planSteps`, qui ne compte que `choixMax` spécialistes : le faux pré-lancement de ces tests couvre la liste
 * ENTIÈRE, faute de quoi un spécialiste choisi au-delà du `choixMax` n'aurait pas de règles à revérifier (écart consigné).
 */
function etapesDeclarees(flow: Flow): Array<{ step: FlowStep; blocIndex: number; ordre: number }> {
  const out: Array<{ step: FlowStep; blocIndex: number; ordre: number }> = [];
  flow.blocs.forEach((bloc, blocIndex) => {
    for (const step of etapesDuBloc(bloc)) out.push({ step, blocIndex, ordre: out.length + 1 });
  });
  return out;
}

// --- Déroulés ------------------------------------------------------------------------------------------------------------------

/** Trois blocs « etape » : le troisième reçoit le résultat du PREMIER, nommément (`recoit: {etapes}`, mode Avancé). */
const lienFlow = (): Flow => ({
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: etape("a", "Inventaire", AGENT_SCRIPT, "demande") },
    { type: "etape", id: "b2", etape: etape("b", "Journaux", AGENT_SCRIPT, "precedent") },
    { type: "etape", id: "b3", etape: etape("c", "Conclusion", AGENT_SQL, { etapes: ["a"] }) },
  ],
});

/** Une étape unique, avec ou sans méthode attachée. */
const methodeFlow = (methodes?: string[]): Flow => ({
  version: 1,
  blocs: [{ type: "etape", id: "b1", etape: etape("m1", "Compte rendu", AGENT_SCRIPT, "demande", methodes) }],
});

/** Rédaction et relecture, 2 tours au plus, sans pause avant la relecture. */
const relectureFlow = (pauseAvantRelecture = false): Flow => ({
  version: 1,
  blocs: [
    {
      type: "relecture",
      id: "rel",
      auteur: etape("redac", "Rédaction", AGENT_SCRIPT, "demande"),
      relecteur: etape("relec", "Relecture", AGENT_SQL, "precedent"),
      toursMax: 2,
      pauseAvantRelecture,
    },
  ],
});

/** Aiguillage : 3 spécialistes, 2 retenus au plus, synthèse, repli nommé (D-5-13). */
const aiguillageFlow = (): Flow => ({
  version: 1,
  blocs: [
    {
      type: "aiguillage",
      id: "aig",
      aiguilleur: etape("tri", "Tri", AGENT_SQL, "demande"),
      specialistes: [
        etape("s1", "Réseau", AGENT_SCRIPT, "demande"),
        etape("s2", "Base", AGENT_SCRIPT, "demande"),
        etape("s3", "Applicatif", AGENT_SCRIPT, "demande"),
      ],
      choixMax: 2,
      synthese: etape("syn", "Synthèse", AGENT_SQL, "tous"),
      repli: "expliquer-alerte",
    },
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

// --- Harnais -------------------------------------------------------------------------------------------------------------------

interface Ctx {
  h: CockpitHarness;
  runner: TeamRunner;
  flow: Flow;
  team: TeamRow;
  plan: RunPlan;
  recheck: RecheckOutcome[];
  capStops: string[];
  warnings: Array<{ message: string; data: unknown }>;
  /** Corps du fichier d'agent rendu par le Studio (lecture LOCALE du contrôle de fraîcheur des méthodes). */
  corpsAgent: Map<string, string>;
  run(body?: Record<string, unknown>): Promise<{ status: number; body: string; json<T>(): T }>;
  continuer(runId: string, body: Record<string, unknown>): Promise<{ status: number; body: string; json<T>(): T }>;
  waitRun(runId: string, predicate: (view: TeamRunView) => boolean, label?: string): Promise<TeamRunView>;
  view(runId: string): TeamRunView;
}

interface OpenOptions {
  flow: Flow;
  settings?: CockpitHarnessOptions["settings"];
  guardsReels?: boolean;
  runnerOptions?: { pollMs?: number; retryMs?: number; usageWaitMs?: number };
}

async function openTeam(t: TestContext, options: OpenOptions): Promise<Ctx> {
  const warnings: Array<{ message: string; data: unknown }> = [];
  const capStops: string[] = [];
  const corpsAgent = new Map<string, string>();
  const ctx = {} as Ctx;
  ctx.recheck = [{ ok: true }];
  ctx.corpsAgent = corpsAgent;

  const preflight: TeamPreflightPort = {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
    check: async (): Promise<PreflightOutcome> => ({ ok: true, plan: ctx.plan }),
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
    modules: options.guardsReels ? ["floors", "stopTree"] : ["floors"],
    equipes: options.guardsReels ? ["teams", "teamPreflight", runnerModule, "teamGuards"] : ["teams", "teamPreflight", runnerModule],
    eqPorts: options.guardsReels ? { preflight, teams } : { preflight, teams, guards },
    deps: (base) => {
      const note = (niveau: string) => (message: string, data?: Record<string, unknown>) => void warnings.push({ message: `${niveau} ${message}`, data });
      const log: Logger = { debug: note("debug"), info: note("info"), warn: note("warn"), error: note("error") };
      // Studio simulé : le contrôle de fraîcheur des méthodes relit le fichier d'agent EN LOCAL, jamais par opencode (A4).
      const studio = {
        ...base.studio,
        get: async (kind: string, name: string) =>
          kind === "agents" && corpsAgent.has(name)
            ? { kind, name, scope: "global", project: null, file: `agents/${name}.md`, frontmatter: {}, body: corpsAgent.get(name), error: null, files: [], updatedAt: 1 }
            : null,
      } as unknown as typeof base.studio;
      return { log, studio };
    },
  });

  h.fake.setAgents([...h.fake.agents(), stepAgent(AGENT_SQL), stepAgent(AGENT_SCRIPT)]);
  const directory = h.fake.directory;
  const snapshot = await h.cockpit.c11.lookup.get(directory);
  const rulesOf = (name: string): Rule[] => snapshot.agents.find((agent) => agent.name === name)?.permission ?? [];

  const flow = options.flow;
  const declarees = etapesDeclarees(flow);
  const etapes: PlannedStep[] = declarees.map(({ step, blocIndex, ordre }) => {
    const agentRules = rulesOf(step.assistant);
    return {
      stepId: step.id,
      blocIndex,
      ordre,
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
      steps: null,
      taille: "M",
    };
  });

  const team: TeamRow = {
    id: "equipe-5b",
    titre: "Enquête d'incident",
    description: "",
    flow: JSON.stringify(flow),
    origine: "exemple",
    exemple_id: "enquete-incident",
    exemple_version: 1,
    avance: 0,
    created_at: 1,
    updated_at: 1,
  };
  createTeamStore({ db: h.db }).teams.put({
    id: team.id,
    titre: team.titre,
    description: "",
    flow,
    origine: "exemple",
    exempleId: "enquete-incident",
    exempleVersion: 1,
    avance: false,
  });

  const estimate = emptyEstimate(declarees.map(({ step }) => step.id));
  const plan: RunPlan = {
    flow,
    flowSha256: sha256(JSON.stringify(flow)),
    estimate,
    estimateSha256: "a".repeat(64),
    plafond: estimate.plafond,
    rootId: null,
    directory,
    modeUi: "avance",
    agentConversation: CHAT_AGENT,
    iaConversation: { model: MODEL, variant: null },
    etapes,
  };

  Object.assign(ctx, {
    h,
    runner: h.cockpit.equipes.eq.ports.runner as TeamRunner,
    flow,
    team,
    plan,
    capStops,
    warnings,
    run: (body: Record<string, unknown> = {}) =>
      h.call("POST", `/api/teams/${team.id}/run`, {
        headers: h.headers.mutating,
        body: { directory, rootId: null, demande: DEMANDE, fichiers: [], agentConversation: CHAT_AGENT, estimateSha256: plan.estimateSha256, confirmations: {}, ...body },
      }),
    continuer: (runId: string, body: Record<string, unknown>) => h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body }),
    waitRun: async (runId: string, predicate: (view: TeamRunView) => boolean, label = "état attendu") => {
      return await until(() => {
        const current = ctx.view(runId);
        return predicate(current) ? current : undefined;
      }, 8_000).catch((err: unknown) => {
        throw new Error(`${label} : ${JSON.stringify(ctx.view(runId).state)} (${String(err)})`);
      });
    },
    view: (runId: string) => {
      const found = (h.cockpit.equipes.eq.ports.runner as TeamRunner).view(runId);
      assert.ok(found, "lancement inconnu");
      return found;
    },
  });
  return ctx;
}

// --- Lectures du faux ------------------------------------------------------------------------------------------------------------

/** Sessions d'étape créées par le serveur (POST /session avec la marque « equipe »). */
const creationsDEtape = (h: CockpitHarness) =>
  h.fake.requests.filter((req) => req.method === "POST" && req.pathname === "/session" && (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe");

const envois = (h: CockpitHarness) => h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async"));

/** Session de l'étape (toutes ses lignes en partagent une seule : les tours reprennent la même, D-5-14). */
const sessionDe = (h: CockpitHarness, stepId: string): string => {
  const row = h.db.prepare("SELECT session_id FROM team_run_steps WHERE step_id = ? AND session_id IS NOT NULL ORDER BY tentative DESC, tour DESC LIMIT 1").get(stepId) as
    | { session_id: string }
    | undefined;
  return row?.session_id ?? "";
};

const texteDe = (parts: unknown): string => (Array.isArray(parts) ? parts.map((part) => (part as { text?: string }).text ?? "").join("") : "");

/** Corps successivement ENVOYÉS à une session (messages « user »), dans l'ordre des tours. */
const corpsEnvoyes = (h: CockpitHarness, sessionId: string): string[] =>
  h.fake
    .messages(sessionId)
    .filter((message) => (message as { info: { role: string } }).info.role === "user")
    .map((message) => texteDe((message as { parts: unknown }).parts));

/** Texte du dernier message injecté dans la racine (le livrable). */
const livraison = (h: CockpitHarness, rootId: string): string => {
  const messages = h.fake.messages(rootId).filter((message) => (message as { info: { role: string } }).info.role === "user");
  return texteDe((messages.at(-1) as { parts: unknown } | undefined)?.parts);
};

/** P4 : aucune règle « allow » ou « ask » envoyée hors du plancher ETAPE des sessions d'étape. */
function assertNoLooseRules(ctx: Ctx): void {
  for (const req of ctx.h.fake.requests) {
    const body = req.body as { permission?: unknown; metadata?: { cockpit?: string } } | undefined;
    const rules = body?.permission;
    if (!Array.isArray(rules)) continue;
    if (rules.filter((rule) => (rule as { action?: string }).action !== "deny").length === 0) continue;
    assert.equal(body?.metadata?.cockpit, "equipe", `règles permissives hors d'une session d'étape : ${req.method} ${req.pathname}`);
    const etapeId = (body as { metadata: { etape: string } }).metadata.etape;
    const planned = ctx.plan.etapes.find((entry) => entry.stepId === etapeId);
    assert.ok(planned, `étape inconnue : ${etapeId}`);
    assert.equal(canonicalRules(rules as Rule[]), canonicalRules(planned.floor), `plancher envoyé ≠ plancher ETAPE (${etapeId})`);
  }
}

// --- Transmissions et méthodes ---------------------------------------------------------------------------------------------------

describe("exécution 5b : transmissions nommées (recoit: {etapes})", () => {
  it("une étape du troisième bloc reçoit le résultat de la PREMIÈRE, et pas celui du deuxième", async (t) => {
    const ctx = await openTeam(t, { flow: lienFlow() });
    const { h } = ctx;
    for (const [stepId, texte] of [
      ["a", "Résultat A : trois serveurs concernés."],
      ["b", "Résultat B : les journaux sont muets."],
      ["c", "Résultat C : conclusion."],
    ] as const) {
      h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === stepId, { text: texte, cost: 0.01, stepMs: 5 });
    }

    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");

    const corpsC = corpsEnvoyes(h, sessionDe(h, "c"))[0] ?? "";
    assert.ok(corpsC.includes("Résultat A"), "le résultat nommé est transmis");
    assert.equal(corpsC.includes("Résultat B"), false, "le résultat du bloc précédent, non nommé, ne l'est pas");
    assert.ok(corpsC.includes(`## ${STEP_SECTIONS.resultats}`), "la section des résultats est écrite");
    // Contre-épreuve : « precedent » continue de transmettre le bloc juste au-dessus (non-régression de l'itération 4).
    assert.ok((corpsEnvoyes(h, sessionDe(h, "b"))[0] ?? "").includes("Résultat A"));
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});

describe("exécution 5b : méthodes des étapes (C §6.3, A4)", () => {
  it("une étape qui déclare « cinq-pourquoi » reçoit son en-tête et son bloc, après la consigne", async (t) => {
    const ctx = await openTeam(t, { flow: methodeFlow(["cinq-pourquoi"]) });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Compte rendu.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");

    const corps = corpsEnvoyes(h, sessionDe(h, "m1"))[0] ?? "";
    const enTete = METHODE_HEADER.replace("{titre}", CINQ_POURQUOI.titre);
    assert.equal(enTete, "## Méthode : 5 pourquoi");
    assert.ok(corps.includes(enTete), "l'en-tête de la méthode est écrit");
    assert.ok(corps.includes(CINQ_POURQUOI.bloc), "le bloc de la méthode est écrit tel quel");
    assert.ok(corps.indexOf(`## ${STEP_SECTIONS.consigne}`) < corps.indexOf(enTete), "la méthode vient après la consigne");
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("une étape sans méthode n'en reçoit aucune : le cockpit n'en ajoute jamais", async (t) => {
    const ctx = await openTeam(t, { flow: methodeFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Compte rendu.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe terminée");

    const corps = corpsEnvoyes(h, sessionDe(h, "m1"))[0] ?? "";
    assert.equal(corps.includes("## Méthode : "), false, "aucun en-tête de méthode");
    h.assertNoGlobalRestart();
  });

  it("méthode ajoutée au fichier de l'assistant après l'estimation : pause « À vérifier », AUCUN prompt_async (A4)", async (t) => {
    const ctx = await openTeam(t, { flow: methodeFlow(["cinq-pourquoi"]) });
    const { h } = ctx;
    h.fake.scriptWhen(() => true, { text: "Compte rendu.", cost: 0.01, stepMs: 5 });
    // Le Studio rend maintenant un fichier d'agent qui PORTE déjà la méthode : l'étape la recevrait deux fois.
    ctx.corpsAgent.set(AGENT_SCRIPT, `Consignes de l'assistant.\n\n${renderMethodBlock(CINQ_POURQUOI)}`);

    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause de fraîcheur");

    assert.equal(vue.pause?.kind, "changement");
    assert.equal(vue.pause?.changement?.code, "equipe-invalide");
    assert.equal(vue.pause?.changement?.details?.raison, "methode-deja-posee");
    assert.equal(vue.pause?.changement?.details?.methode, "cinq-pourquoi");
    assert.equal(envois(h).length, 0, "aucun envoi : rien n'a été envoyé ni facturé");
    assert.equal(creationsDEtape(h).length, 0, "aucune session d'étape créée");
    assert.equal(vue.steps[0]?.state, "prevue", "l'étape n'a pas échoué : elle attend");
    assert.equal(vue.cost, 0);

    // Le fichier corrigé, [Continuer] repart : pas de refus tardif, l'étape part enfin.
    ctx.corpsAgent.delete(AGENT_SCRIPT);
    const reprise = await ctx.continuer(runId, {});
    assert.equal(reprise.status, 200, reprise.body);
    await ctx.waitRun(runId, (v) => v.state === "terminee", "équipe reprise");
    assert.equal(envois(h).length, 1);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });
});

// --- Relecture ---------------------------------------------------------------------------------------------------------------------

describe("exécution 5b : relecture en deux tours (D-5-14, MC5-2)", () => {
  /** Rédaction ×3 (deux révisions) et relecture ×2 : le second verdict est ILLISIBLE, donc traité comme « à reprendre ». */
  function scripterRelecture(h: CockpitHarness): void {
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
      { text: "Version 1 du compte rendu.", cost: 0.01, stepMs: 5 },
      { text: "Version 2 du compte rendu.", cost: 0.01, stepMs: 5 },
      { text: "Version 3 du compte rendu.", cost: 0.01, stepMs: 5 },
    );
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec",
      { text: "Les causes ne sont pas étayées.\nVERDICT: À REPRENDRE", cost: 0.01, stepMs: 5 },
      { text: "Il reste un point.\nVERDICT: peut-être", cost: 0.01, stepMs: 5 },
    );
  }

  it("deux tours, DEUX sessions en tout : le tour 2 reprend la même, corps encadré, verdict illisible, notes d'honnêteté", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    scripterRelecture(h);

    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "terminee", "relecture terminée");

    // D-5-14 : EXACTEMENT deux sessions pour le bloc, une par étape, quels que soient les tours.
    assert.equal(creationsDEtape(h).length, 2, "aucun POST /session au tour 2");
    const sessionRedac = sessionDe(h, "redac");
    const sessionRelec = sessionDe(h, "relec");
    assert.notEqual(sessionRedac, sessionRelec);
    const lignes = h.db.prepare("SELECT step_id, tour, session_id, verdict, state FROM team_run_steps WHERE run_id = ? ORDER BY ordre, tour").all(runId) as Array<{
      step_id: string;
      tour: number;
      session_id: string | null;
      verdict: string | null;
      state: string;
    }>;
    // Une ligne par (étape, tour), toutes sur la MÊME session.
    assert.deepEqual(
      lignes.map((ligne) => `${ligne.step_id}#${ligne.tour}`).toSorted(),
      ["redac#1", "redac#2", "redac#3", "relec#1", "relec#2"],
      "une ligne par (étape, tour)",
    );
    for (const ligne of lignes.filter((entry) => entry.step_id === "redac")) assert.equal(ligne.session_id, sessionRedac, "même session à chaque tour");
    for (const ligne of lignes.filter((entry) => entry.step_id === "relec")) assert.equal(ligne.session_id, sessionRelec, "même session à chaque tour");
    assert.equal(lignes.find((ligne) => ligne.step_id === "relec" && ligne.tour === 1)?.verdict, "a-reprendre", "verdict du tour 1 enregistré");
    assert.equal(lignes.find((ligne) => ligne.step_id === "relec" && ligne.tour === 2)?.verdict, null, "verdict illisible : colonne vide");

    // Corps du tour 2 : la version courante de l'auteur, ENCADRÉE comme tout résultat relayé.
    const corpsRelec = corpsEnvoyes(h, sessionRelec);
    assert.equal(corpsRelec.length, 2, "deux envois dans la session du relecteur");
    assert.ok(corpsRelec[1]?.includes("Version 2 du compte rendu."), "le tour 2 relit la version 2");
    assert.ok(corpsRelec[1]?.includes("<<<résultat de l'étape « Rédaction »"), "le texte relayé est encadré");
    assert.equal(corpsRelec[1]?.includes("Version 1 du compte rendu."), false, "la version 1 n'est pas renvoyée : la session la porte déjà");
    // La révision reçoit la relecture qui vient d'être rendue, encadrée elle aussi.
    const corpsRedac = corpsEnvoyes(h, sessionRedac);
    assert.equal(corpsRedac.length, 3, "trois envois dans la session de l'auteur (deux révisions)");
    assert.ok(corpsRedac[1]?.includes("Les causes ne sont pas étayées."), "la révision reçoit la relecture du tour 1");
    assert.ok(corpsRedac[1]?.includes("<<<résultat de l'étape « Relecture »"));

    // Livrable : dernière version, journal des deux tours, verdict illisible dit, notes d'honnêteté.
    const texte = livraison(h, rootId);
    assert.ok(texte.includes("Version 3 du compte rendu."), "le livrable porte la dernière version");
    assert.ok(texte.includes(`## ${DELIVERABLE_TEXTS.journal}`));
    assert.ok(texte.includes(DELIVERABLE_TEXTS.verdictIllisible), "un verdict illisible est dit, jamais supposé concluant");
    assert.ok(texte.includes(DELIVERABLE_TEXTS.nonRelue), "« Non relue après la dernière correction. »");
    assert.ok(texte.includes(DELIVERABLE_TEXTS.nonConclue.replace("{n}", "2")));
    assert.ok(vue.cost > 0);
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("« rien à reprendre » au tour 1 : le bloc s'arrête là, un seul tour de relecture", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac", { text: "Version unique.", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec", {
      text: "Rien à signaler.\nVERDICT: RIEN À REPRENDRE",
      cost: 0.01,
      stepMs: 5,
    });
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "terminee", "relecture terminée");

    assert.equal(creationsDEtape(h).length, 2);
    assert.equal(corpsEnvoyes(h, sessionDe(h, "redac")).length, 1, "aucune révision");
    assert.equal(corpsEnvoyes(h, sessionDe(h, "relec")).length, 1, "un seul tour");
    const texte = livraison(h, rootId);
    assert.ok(texte.includes(DELIVERABLE_TEXTS.rienAReprendre));
    assert.equal(texte.includes(DELIVERABLE_TEXTS.nonRelue), false, "rien à reprendre : aucune note de non-relecture");
    h.assertNoGlobalRestart();
  });

  it("pause avant la première relecture : elle est franchie une seule fois, les tours suivants enchaînent", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow(true) });
    const { h } = ctx;
    scripterRelecture(h);
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const enPause = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause avant relecture");
    assert.equal(enPause.pause?.kind, "verification");
    assert.equal(envois(h).length, 1, "le relecteur n'a rien reçu avant votre vérification");

    const reprise = await ctx.continuer(runId, {});
    assert.equal(reprise.status, 200, reprise.body);
    await ctx.waitRun(runId, (v) => v.state === "terminee", "relecture terminée");
    assert.equal(creationsDEtape(h).length, 2, "toujours deux sessions");
    assert.equal(corpsEnvoyes(h, sessionDe(h, "relec")).length, 2, "les deux tours ont eu lieu, sans nouvelle pause");
    h.assertNoGlobalRestart();
  });

  it("échec au tour 2 : c'est la ligne du TOUR COURANT qui fait foi, le lancement s'arrête au lieu de boucler", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
      { text: "Version 1.", cost: 0.01, stepMs: 5 },
      { text: "Version 2.", cost: 0.01, stepMs: 5 },
    );
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec",
      { text: "À revoir.\nVERDICT: À REPRENDRE", cost: 0.01, stepMs: 5 },
      // Tour 2 sans réponse : sans la ligne du tour courant, l'ordonnanceur relirait la ligne « terminee » du tour 1 et
      // relancerait le relecteur sans fin (D-eq-20 : un échec arrête l'équipe).
      { text: "", cost: 0.01, stepMs: 5 },
    );
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "echec" || v.state === "terminee", "échec du tour 2");
    assert.equal(vue.state, "echec");
    assert.ok(
      vue.steps.some((step) => step.stepId === "relec" && step.tour === 2 && step.state === "echec"),
      "la ligne du tour 2 porte l'échec",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(corpsEnvoyes(h, sessionDe(h, "relec")).length, 2, "aucune relance sans fin du relecteur");
    h.assertNoGlobalRestart();
  });

  it("arrêt pendant le tour 2 : la session reprise est arrêtée, plus aucune étape ne part, le lancement est clos", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow(), guardsReels: true });
    const { h } = ctx;
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
      { text: "Version 1.", cost: 0.01, stepMs: 5 },
      { text: "Version 2.", cost: 0.01, stepMs: 600 },
    );
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec", {
      text: "À revoir.\nVERDICT: À REPRENDRE",
      cost: 0.01,
      stepMs: 5,
    });

    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    // Attendre que le tour 2 de l'auteur soit EN VOL : deuxième envoi dans sa session, puis session réellement occupée.
    await until(() => (corpsEnvoyes(h, sessionDe(h, "redac")).length >= 2 ? true : undefined), 8_000);
    await until(() => (h.fake.statusOf(sessionDe(h, "redac")).type === "busy" ? true : undefined), 8_000);
    const avant = h.fake.requests.length;
    await h.cockpit.c11.ports.stopTree.run(rootId, "vous");
    const vue = await ctx.waitRun(runId, (v) => v.state === "arretee" || v.state === "plafond", "lancement arrêté");

    assert.equal(vue.state, "arretee");
    const abandons = h.fake.requests.filter((req) => req.method === "POST" && req.pathname.endsWith("/abort"));
    assert.ok(
      abandons.some((req) => req.pathname === `/session/${sessionDe(h, "redac")}/abort`),
      `la session reprise du tour 2 a reçu son arrêt : ${JSON.stringify(abandons.map((req) => req.pathname))}`,
    );
    assert.equal(envois(h).slice(avant).length, 0, "aucun envoi après l'arrêt");
    for (const step of vue.steps) assert.notEqual(step.state, "en-cours", `étape ${step.stepId} encore en cours`);
    assert.ok(
      vue.steps.some((step) => step.stepId === "redac" && step.tour === 2 && step.state === "arretee"),
      "le tour 2 est arrêté",
    );
    h.assertNoGlobalRestart();
  });

  it("plafond atteint au tour 2 : le lancement passe « plafond », le tour ne part jamais", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow(), guardsReels: true });
    const { h } = ctx;
    // 0 + 0,20 ≤ 0,28 (rédaction) ; 0,05 + 0,20 ≤ 0,28 (relecture) ; 0,10 + 0,20 > 0,28 → arrêt AVANT le tour 2.
    ctx.plan.plafond = 0.28;
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac", { text: "Version 1.", cost: 0.05, stepMs: 5 });
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec", {
      text: "À revoir.\nVERDICT: À REPRENDRE",
      cost: 0.05,
      stepMs: 5,
    });

    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "plafond" || v.state === "arretee", "arrêt au plafond");

    assert.equal(vue.state, "plafond");
    assert.equal(vue.cause, "plafond");
    assert.ok(vue.cost < 0.28, `l'arrêt a eu lieu sous le plafond (${vue.cost})`);
    assert.equal(corpsEnvoyes(h, sessionDe(h, "redac")).length, 1, "le tour 2 n'est jamais parti");
    assert.equal(creationsDEtape(h).length, 2, "aucune session de plus");
    h.assertNoGlobalRestart();
  });
});

// --- Aiguillage ---------------------------------------------------------------------------------------------------------------------

describe("exécution 5b : aiguillage, votre choix seul (spéc. §4.11 l.772)", () => {
  function scripterAiguillage(h: CockpitHarness): void {
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "tri", {
      text: "Les indices pointent le réseau et la base.\nCHOIX: Réseau, Base",
      cost: 0.01,
      stepMs: 5,
    });
    for (const [stepId, texte] of [
      ["s1", "Réseau : pertes de paquets la nuit."],
      ["s2", "Base : verrous longs sur la table des lots."],
      ["s3", "Applicatif : rien à signaler."],
      ["syn", "Synthèse : commencer par les verrous."],
    ] as const) {
      h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === stepId, { text: texte, cost: 0.01, stepMs: 5 });
    }
  }

  it("aucun spécialiste avant votre réponse ; choix invalide refusé SANS requête ; deux choix puis la synthèse", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    scripterAiguillage(h);
    // Espion : personne d'autre que vous n'appelle `continue` (ni l'autonomie, ni un crochet du navigateur).
    const port = h.cockpit.equipes.eq.ports.runner;
    const vrai = port.continue.bind(port);
    let appels = 0;
    port.continue = async (runId: string, body, confirmed: boolean) => {
      appels++;
      return vrai(runId, body, confirmed);
    };

    const started = await ctx.run();
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const enChoix = await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");

    assert.equal(envois(h).length, 1, "seul l'aiguilleur a travaillé");
    assert.equal(creationsDEtape(h).length, 1, "aucune session de spécialiste");
    assert.equal(enChoix.pause?.kind, "choix");
    assert.equal(enChoix.pause?.message, TEXTES.partout.pauses.choix.titre);
    assert.deepEqual(
      enChoix.pause?.choix,
      [
        { stepId: "s1", titre: "Réseau", propose: true },
        { stepId: "s2", titre: "Base", propose: true },
        { stepId: "s3", titre: "Applicatif", propose: false },
      ],
      "la proposition lue est présélectionnée, la liste reste entière",
    );
    assert.equal(enChoix.pause?.choixMax, 2);
    assert.ok(enChoix.pause?.raison?.includes("Les indices pointent le réseau et la base."), "la raison est rendue, la ligne CHOIX en est retirée");
    assert.equal(enChoix.pause?.raison?.includes("CHOIX:"), false);

    // Rien ne se lance tout seul : l'attente dure, et personne n'a appelé `continue`.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ctx.view(runId).state, "attente-choix");
    assert.equal(appels, 0, "aucun module ne répond à votre place");

    // Choix invalide (identifiant hors de la liste) : 409, aucune requête, rien n'est écrit.
    const avant = h.fake.requests.length;
    const refus = await ctx.continuer(runId, { choix: ["s9"] });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<{ error: string; details?: { raison?: string } }>().details?.raison, "choix-invalide");
    assert.equal(h.fake.requests.length, avant, "rien n'a été envoyé ni facturé");
    assert.equal(ctx.view(runId).state, "attente-choix", "la pause tient");

    // Trop de choix pour ce bloc : refusé par la route sur la borne générale (400), sans atteindre le runner.
    const trop = await ctx.continuer(runId, { choix: ["s1", "s2", "s3"] });
    assert.equal(trop.status, 400, trop.body);
    assert.equal(ctx.view(runId).state, "attente-choix");

    // Votre choix : les deux spécialistes partent, le troisième est « Non choisi », la synthèse rassemble.
    const reponse = await ctx.continuer(runId, { choix: ["s2", "s1"] });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "aiguillage terminé");
    // Deux appels seulement, et les deux viennent de VOS requêtes : le choix invalide et le choix retenu (le corps hors bornes
    // n'a pas passé la route). Aucun module, aucun crochet, aucune autonomie n'a rappelé `continue` entre-temps.
    assert.equal(appels, 2, "seules vos requêtes ont atteint l'exécuteur");

    assert.equal(fini.steps.find((step) => step.stepId === "s3")?.state, "non-choisi");
    assert.equal(fini.steps.find((step) => step.stepId === "s3")?.cost, 0, "un spécialiste écarté ne coûte rien");
    assert.equal(fini.steps.find((step) => step.stepId === "s1")?.state, "terminee");
    assert.equal(fini.steps.find((step) => step.stepId === "s2")?.state, "terminee");
    assert.equal(fini.steps.find((step) => step.stepId === "syn")?.state, "terminee");
    // L'ordre du déroulé, jamais celui du corps reçu.
    assert.deepEqual(fini.steps.find((step) => step.stepId === "tri")?.choix, ["s1", "s2"]);
    const corpsSynthese = corpsEnvoyes(h, sessionDe(h, "syn"))[0] ?? "";
    assert.ok(corpsSynthese.includes("Réseau : pertes de paquets la nuit."));
    assert.ok(corpsSynthese.includes("Base : verrous longs sur la table des lots."));
    assert.equal(corpsSynthese.includes("Applicatif : rien à signaler."), false, "l'écarté n'a rien produit");
    assert.ok(livraison(h, rootId).includes("Synthèse : commencer par les verrous."));
    assertNoLooseRules(ctx);
    h.assertNoGlobalRestart();
  });

  it("« aucun ne convient » : rien n'est lancé, tout est « Non choisi », le repli est proposé", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    scripterAiguillage(h);
    const started = await ctx.run();
    const { runId, rootId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");

    const reponse = await ctx.continuer(runId, { aucun: true });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "aiguillage clos");

    for (const stepId of ["s1", "s2", "s3", "syn"]) {
      assert.equal(fini.steps.find((step) => step.stepId === stepId)?.state, "non-choisi", `${stepId} écarté`);
    }
    assert.equal(envois(h).length, 1, "aucun appel de plus : « aucun » ne coûte rien");
    assert.equal(creationsDEtape(h).length, 1);
    assert.deepEqual(fini.steps.find((step) => step.stepId === "tri")?.choix, "aucun");
    const texte = livraison(h, rootId);
    assert.ok(texte.includes(DELIVERABLE_TEXTS.aucun));
    assert.ok(texte.includes(DELIVERABLE_TEXTS.aucunRepli.replace("{assistant}", "expliquer-alerte")));
    h.assertNoGlobalRestart();
  });

  it("choix illisible : rien n'est présélectionné, et c'est vous qui choisissez", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "tri", {
      text: "Je ne sais pas trancher.\nCHOIX: Stockage",
      cost: 0.01,
      stepMs: 5,
    });
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "s1", { text: "Réseau : rien.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const enChoix = await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");
    assert.deepEqual(
      enChoix.pause?.choix?.map((entree) => entree.propose),
      [false, false, false],
      "un choix illisible ne présélectionne rien",
    );

    const reponse = await ctx.continuer(runId, { choix: ["s1"] });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "un seul spécialiste");
    assert.equal(fini.steps.find((step) => step.stepId === "syn")?.state, "non-choisi", "la synthèse ne travaille pas à un seul choix");
    assert.equal(envois(h).length, 2, "l'aiguilleur puis le seul spécialiste retenu");
    h.assertNoGlobalRestart();
  });

  it("redémarrage du cockpit en « attente-choix » : la pause tient, rien n'est lancé, la proposition est rendue", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    const runId = "33333333-4444-5555-6666-777777777777";
    const racine = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } });
    const rootId = racine.json<FakeSession>().id;
    const etapeSession = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Tri" } })).json<FakeSession>().id;
    seedChoix(h, { runId, rootId, flow: aiguillageFlow(), sessionId: etapeSession });

    const avant = h.fake.requests.length;
    await h.cockpit.startup();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const vue = ctx.view(runId);
    assert.equal(vue.state, "attente-choix", "la pause de choix survit au redémarrage");
    assert.equal(vue.pause?.kind, "choix");
    assert.deepEqual(
      vue.pause?.choix?.map((entree) => entree.propose),
      [true, true, false],
      "la proposition est relue en base",
    );
    assert.ok(vue.pause?.raison?.includes("Les indices pointent le réseau et la base."));
    const apres = h.fake.requests.slice(avant);
    assert.equal(apres.filter((req) => req.method === "POST" && req.pathname === "/session").length, 0, "aucune session créée");
    assert.equal(apres.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun envoi");
    h.assertNoGlobalRestart();
  });
});

/** Lancement écrit comme avant un redémarrage du cockpit : aiguilleur terminé, choix NON confirmé. */
function seedChoix(h: CockpitHarness, options: { runId: string; rootId: string; flow: Flow; sessionId: string }): void {
  h.db
    .prepare(
      `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, cause, facultatifs, plafond, cost, confirmations, precisions, created_at, started_at)
       VALUES (:id, 'Enquête d''incident', :flow, 'f0', :root, :dir, 'attente-choix', NULL, '[]', 1, 0, '{}', '[]', 1, 1)`,
    )
    .run({ id: options.runId, flow: JSON.stringify(options.flow), root: options.rootId, dir: h.fake.directory });
  etapesDeclarees(options.flow).forEach(({ step, blocIndex, ordre }) => {
    const premier = step.id === "tri";
    h.db
      .prepare(
        `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, state, session_id, result_excerpt, model, cost)
         VALUES (:run, :step, 1, 1, :ordre, :bloc, :titre, :agent, :state, :session, :extrait, :model, 0)`,
      )
      .run({
        run: options.runId,
        step: step.id,
        ordre,
        bloc: blocIndex,
        titre: step.titre,
        agent: step.assistant,
        state: premier ? "terminee" : "prevue",
        session: premier ? options.sessionId : null,
        extrait: premier ? "Les indices pointent le réseau et la base.\nCHOIX: Réseau, Base" : null,
        model: MODEL,
      });
  });
  h.db
    .prepare("INSERT INTO team_run_events (run_id, kind, par, data, at) VALUES (?, 'aiguillage-propose', 'cockpit', ?, 1)")
    .run(options.runId, JSON.stringify({ bloc: "aig", ids: "s1,s2" }));
}
