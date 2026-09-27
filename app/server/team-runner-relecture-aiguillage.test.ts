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
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type {
  EqModule,
  PlannedStep,
  PreflightInput,
  PreflightOutcome,
  RecheckOutcome,
  RunPlan,
  TeamGuardsPort,
  TeamPreflightPort,
  TeamRow,
  TeamsPort,
} from "./contracts-eq.ts";
import type { Logger } from "./log.ts";
import { METHODS } from "./methods-catalogue.ts";
import { floorHash } from "./session-floor-service.ts";
import { type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import { DELIVERABLE_TEXTS, METHODE_HEADER, STEP_SECTIONS, stepMessage } from "./shared/flow.ts";
import { renderMethodBlock } from "./shared/methods.ts";
import { buildFloor, canonicalRules } from "./shared/session-floors.ts";
import { remplir, TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowBlock, FlowEstimate, FlowStep, TeamEstimateResponse, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
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
  /** Clôture 5b (D-5b-1) : appels de `preflight.estimate` (identifiant du lancement ré-estimé, null pour une équipe). */
  estimations: Array<string | null>;
  /** Clôture 5b (D-5b-1) : entrées de `preflight.check` (lancement et confirmations de relance). */
  verifications: PreflightInput[];
  /** Clôture 5b (D-5b-1) : tant qu'elle n'est pas tenue, `preflight.check` attend (deux confirmations au même moment). */
  retenue: Promise<void> | null;
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
  ctx.estimations = [];
  ctx.verifications = [];
  ctx.retenue = null;

  const preflight: TeamPreflightPort = {
    assistants: async () => new Map(),
    // Clôture 5b (D-5b-1) : la ré-estimation d'une pause qui a survécu à un redémarrage passe par POST …/estimate. Le faux rend
    // l'estimation de l'instantané du test, sans aucune lecture, et garde la trace de chaque appel.
    estimate: async (_team, _body, _mode, relance) => {
      ctx.estimations.push(relance?.runId ?? null);
      return {
        ok: true,
        response: {
          estimate: ctx.plan.estimate,
          estimateSha256: ctx.plan.estimateSha256,
          problems: [],
          plafond: ctx.plan.plafond,
          confirmations: [],
          blocage: null,
          expireA: Date.now() + 600_000,
          deja: relance ? 0 : null,
        },
      };
    },
    check: async (input): Promise<PreflightOutcome> => {
      // Clôture 5b (D-5b-1) : trace de chaque pré-lancement, pour lire le reste qu'une confirmation transmet.
      ctx.verifications.push(input);
      if (ctx.retenue !== null) await ctx.retenue;
      return { ok: true, plan: ctx.plan };
    },
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

  it("coût d'une LIGNE = coût du tour : la somme des lignes fait le coût du lancement, jamais le double", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
      { text: "Version 1.", cost: 0.03, stepMs: 5 },
      { text: "Version 2.", cost: 0.04, stepMs: 5 },
    );
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec",
      { text: "À revoir.\nVERDICT: À REPRENDRE", cost: 0.05, stepMs: 5 },
      { text: "Rien à redire.\nVERDICT: RIEN À REPRENDRE", cost: 0.06, stepMs: 5 },
    );
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "relecture terminée");
    assert.equal(fini.state, "terminee");

    const lignes = h.db.prepare("SELECT step_id, tour, cost FROM team_run_steps WHERE run_id = ? ORDER BY ordre, tour").all(runId) as Array<{
      step_id: string;
      tour: number;
      cost: number;
    }>;
    assert.equal(lignes.length, 4, "une ligne par (étape, tour)");
    const cout = (stepId: string, tour: number) => lignes.find((l) => l.step_id === stepId && l.tour === tour)?.cost ?? -1;
    // La session du tour 2 porte déjà le tour 1 (D-5-14) : la ligne ne doit compter QUE son tour.
    assert.ok(Math.abs(cout("redac", 1) - 0.03) < 1e-9, `redac t1 = ${cout("redac", 1)}`);
    assert.ok(Math.abs(cout("redac", 2) - 0.04) < 1e-9, `redac t2 = ${cout("redac", 2)}`);
    assert.ok(Math.abs(cout("relec", 1) - 0.05) < 1e-9, `relec t1 = ${cout("relec", 1)}`);
    assert.ok(Math.abs(cout("relec", 2) - 0.06) < 1e-9, `relec t2 = ${cout("relec", 2)}`);
    const somme = lignes.reduce((total, ligne) => total + ligne.cost, 0);
    assert.ok(Math.abs(somme - fini.cost) < 1e-9, `somme des lignes ${somme} ≠ bilan du lancement ${fini.cost}`);
    h.assertNoGlobalRestart();
  });

  it("relance après un échec au tour 2 : tout le bloc repart au TOUR 1, tentative 2, avec de nouvelles sessions", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    // Les scripts du faux sont posés à la CRÉATION d'une session : une session neuve repart du premier tour scripté. Le
    // drapeau distingue donc le premier lancement de la relance, et prouve du même coup que les sessions sont bien neuves.
    let relance = false;
    const pourEtape = (session: FakeSession, etape: string) => (session.metadata as { etape?: string } | undefined)?.etape === etape;
    h.fake.scriptWhen(
      (session) => !relance && pourEtape(session, "redac"),
      { text: "Version 1.", cost: 0.01, stepMs: 5 },
      // Tour 2 muet : la révision échoue, le lancement tombe en « echec ».
      { text: "", cost: 0.01, stepMs: 5 },
    );
    h.fake.scriptWhen((session) => !relance && pourEtape(session, "relec"), { text: "À revoir.\nVERDICT: À REPRENDRE", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((session) => relance && pourEtape(session, "redac"), { text: "Version 1 bis.", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((session) => relance && pourEtape(session, "relec"), { text: "Rien à redire.\nVERDICT: RIEN À REPRENDRE", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const tombe = await ctx.waitRun(runId, (v) => v.state === "echec" || v.state === "terminee", "échec du tour 2");
    assert.equal(tombe.state, "echec");
    const avantEnvois = envois(h).length;

    // [Relancer la suite] : le bloc entier repart au tour 1, tentative 2 (fiche L42b). Sans cela, le rédacteur repartait seul
    // et le verdict périmé du relecteur faisait redemander un tour 2 dont la session n'existait plus.
    relance = true;
    const relancee = await ctx.runner.relaunch(runId, ctx.plan);
    assert.equal("ok" in relancee && relancee.ok === false, false, `relance refusée : ${JSON.stringify(relancee)}`);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "relance aboutie");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    assert.ok(envois(h).length > avantEnvois, "au moins un envoi est parti après la relance");

    const lignes = h.db.prepare("SELECT step_id, tour, tentative, state FROM team_run_steps WHERE run_id = ? ORDER BY ordre, tentative, tour").all(runId) as Array<{
      step_id: string;
      tour: number;
      tentative: number;
      state: string;
    }>;
    for (const stepId of ["redac", "relec"]) {
      assert.ok(
        lignes.some((l) => l.step_id === stepId && l.tour === 1 && l.tentative === 2),
        `${stepId} a une ligne neuve au tour 1, tentative 2 : ${JSON.stringify(lignes)}`,
      );
    }
    assert.equal(lignes.filter((l) => l.state === "echec" && l.tentative === 2).length, 0, "aucun échec dans la tentative relancée");
    // Nouvelles sessions des DEUX côtés : deux au premier passage, deux de plus après la relance.
    assert.equal(creationsDEtape(h).length, 4, "une session neuve par étape du bloc relancé");
    assertNoLooseRules(ctx);
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

// <c5:depot-fige>
describe("GF4 (A28 C6) : l'exécuteur fige au dépôt ce qu'il a écrit dans le message de résultat", () => {
  /** Données d'un événement d'audit de dépôt : des codes et des nombres, jamais un texte de message (team_run_events). */
  const donneesDuDepot = (h: CockpitHarness, runId: string, kind: string): Record<string, unknown> => {
    const row = h.db.prepare("SELECT data FROM team_run_events WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(runId, kind) as { data: string } | undefined;
    assert.ok(row, `événement « ${kind} » absent`);
    return JSON.parse(row.data) as Record<string, unknown>;
  };

  it("livraison au plafond de 2 tours non conclus : journal et deux notes figés avec l'identifiant du message, sans aucun texte", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow() });
    const { h } = ctx;
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
      { text: "Version 1.", cost: 0.01, stepMs: 5 },
      { text: "Version 2.", cost: 0.01, stepMs: 5 },
      { text: "Version 3.", cost: 0.01, stepMs: 5 },
    );
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec",
      { text: "Faux.\nVERDICT: À REPRENDRE", cost: 0.01, stepMs: 5 },
      { text: "Encore faux.\nVERDICT: À REPRENDRE", cost: 0.01, stepMs: 5 },
    );
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const vue = await ctx.waitRun(runId, (v) => v.state === "terminee", "relecture au plafond");
    assert.ok(vue.resultMessageId !== null, "livrable injecté");
    assert.deepEqual(vue.depot, { messageId: vue.resultMessageId, genre: "resultat", journal: true, nonRelue: true, nonConclue: 2 });
    const data = donneesDuDepot(h, runId, "livraison");
    assert.deepEqual(Object.keys(data).toSorted(), ["etape", "genre", "journal", "messageId", "nonConclue", "nonRelue"]);
    for (const valeur of Object.values(data)) assert.ok(typeof valeur !== "string" || !/Version|Faux|relecture/i.test(valeur), `texte dans l'événement : ${String(valeur)}`);
  });

  it("résultats ajoutés à la main (équipe interrompue après deux étapes) : le dépôt dit « résultats partiels », sans journal ni note", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow(), guardsReels: true });
    const { h } = ctx;
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "a", { text: "Collecte faite.", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse longue.", cost: 0.01, stepMs: 400 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.steps.some((step) => step.stepId === "b" && step.state === "en-cours"), "seconde étape en cours");
    ctx.runner.interrupt(runId, "rechargement");
    await ctx.waitRun(runId, (v) => v.state === "interrompue", "équipe interrompue");
    const ajout = await h.call("POST", `/api/team-runs/${runId}/ajouter-resultats`, { headers: h.headers.mutating, body: {} });
    assert.equal(ajout.status, 200, ajout.body);
    const vue = ctx.view(runId);
    assert.deepEqual(vue.depot, { messageId: vue.resultMessageId, genre: "resultats-partiels", journal: false, nonRelue: false, nonConclue: null });
    assert.equal(donneesDuDepot(h, runId, "resultats-ajoutes").genre, "resultats-partiels");
  });
});
// </c5:depot-fige>

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
    // Le code sort EN CLAIR depuis le train de la vague 2 (demande de contrat de ce paquet, plan it5 §2.4).
    assert.equal(refus.json<{ error: string }>().error, "choix-invalide");
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

  it("relance d'un aiguillage déjà arbitré : les écartés restent « Non choisi », jamais remis « Pas encore commencée »", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    // Même drapeau que la relance d'une relecture : une session neuve repart du premier tour scripté.
    let relance = false;
    const pourEtape = (session: FakeSession, etape: string) => (session.metadata as { etape?: string } | undefined)?.etape === etape;
    h.fake.scriptWhen((session) => pourEtape(session, "tri"), { text: "Le réseau d'abord.\nCHOIX: Réseau", cost: 0.01, stepMs: 5 });
    // Premier passage muet : le seul spécialiste retenu échoue, le lancement s'arrête.
    h.fake.scriptWhen((session) => !relance && pourEtape(session, "s1"), { text: "", cost: 0.01, stepMs: 5 });
    h.fake.scriptWhen((session) => relance && pourEtape(session, "s1"), { text: "Réseau : pertes de paquets la nuit.", cost: 0.01, stepMs: 5 });
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");
    const reponse = await ctx.continuer(runId, { choix: ["s1"] });
    assert.equal(reponse.status, 200, reponse.body);
    const tombe = await ctx.waitRun(runId, (v) => v.state === "echec" || v.state === "terminee", "échec du spécialiste retenu");
    assert.equal(tombe.state, "echec");
    for (const stepId of ["s2", "s3", "syn"]) {
      assert.equal(tombe.steps.find((step) => step.stepId === stepId)?.state, "non-choisi", `${stepId} écarté avant la relance`);
    }

    relance = true;
    const relancee = await ctx.runner.relaunch(runId, ctx.plan);
    assert.equal("ok" in relancee && relancee.ok === false, false, `relance refusée : ${JSON.stringify(relancee)}`);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "relance aboutie");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    // « Non choisi » est un état FINAL : votre choix tient toujours en base, donc rien ne repasse « prevue ».
    for (const stepId of ["s2", "s3", "syn"]) {
      assert.equal(fini.steps.find((step) => step.stepId === stepId)?.state, "non-choisi", `${stepId} après la relance`);
    }
    const restes = h.db.prepare("SELECT step_id, tour, tentative FROM team_run_steps WHERE run_id = ? AND state = 'prevue'").all(runId) as Array<{ step_id: string }>;
    assert.deepEqual(restes, [], "aucune ligne « Pas encore commencée » ne subsiste sur un lancement fini");
    assert.equal(envois(h).length, 3, "l'aiguilleur, le spécialiste muet, puis le spécialiste relancé — et personne d'autre");
    h.assertNoGlobalRestart();
  });

  it("les bornes déclarées du bloc portent le nombre de spécialistes : le Déroulé n'a plus à deviner la synthèse", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    scripterAiguillage(h);
    const started = await ctx.run();
    const { runId } = started.json<TeamRunStarted>();
    const enChoix = await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");
    assert.deepEqual(enChoix.blocs, [{ index: 0, type: "aiguillage", choixMax: 2, specialistes: 3 }]);
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

  it("redémarrage du cockpit en « attente-choix » : la pause tient, rien n'est lancé, la proposition est rendue — puis VOTRE choix, après une estimation montrée et confirmée", async (t) => {
    // Clôture 5b (D-5b-1) : les routes d'incident (estimate, relancer) sont celles du module teamGuards, monté ici pour de vrai.
    const ctx = await openTeam(t, { flow: aiguillageFlow(), guardsReels: true });
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

    // L'instantané de l'estimation n'a pas survécu au redémarrage : la pause le dit, et porte une issue autre que [Arrêter].
    assert.deepEqual(vue.pause?.reestimation, { aucunLibre: true, possible: true });

    // Un choix de spécialistes lancerait des appels facturés sans estimation à jour : refusé en clair (P3), sans rien écrire.
    const avantRefus = h.fake.requests.length;
    const refus = await ctx.continuer(runId, { choix: ["s1"] });
    assert.equal(refus.status, 409, refus.body);
    assert.deepEqual(refus.json(), { error: "reestimation-requise", message: TEXTES.partout.erreurs["reestimation-requise"] });
    assert.ok(!refus.json<{ message: string }>().message.includes("est affichée"), "la phrase fausse « une nouvelle estimation est affichée » n'est plus rendue");
    assert.equal(h.fake.requests.length, avantRefus, "refus rendu avant toute requête à opencode");
    assert.equal(ctx.view(runId).state, "attente-choix");
    assert.equal(h.db.prepare("SELECT choix FROM team_run_steps WHERE run_id = ? AND step_id = 'tri'").get(runId)?.choix ?? null, null, "aucun choix écrit");

    // Issue : l'estimation est MONTRÉE (POST …/estimate), puis confirmée (POST …/relancer, x-cockpit-confirm: 1).
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    assert.deepEqual(ctx.estimations, [runId], "une estimation du reste de CE lancement");
    const empreinte = estimation.json<{ estimateSha256: string }>().estimateSha256;
    const avantConfirmation = h.fake.requests.length;
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: empreinte } });
    assert.equal(confirme.status, 200, confirme.body);
    const revenue = confirme.json<TeamRunView>();
    // La carte de choix revient : ni l'autonomie, ni un crochet, ni la relance ne tranchent le choix (spéc. l.772).
    assert.equal(revenue.state, "attente-choix");
    assert.equal(revenue.pause?.kind, "choix");
    assert.equal(revenue.pause?.reestimation, undefined, "l'estimation est à jour : plus de ré-estimation demandée");
    assert.deepEqual(
      revenue.pause?.choix?.map((entree) => entree.propose),
      [true, true, false],
      "la proposition de l'aiguilleur, déjà payée, est gardée",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pendantPause = h.fake.requests.slice(avantConfirmation);
    assert.equal(pendantPause.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "la confirmation de l'estimation ne lance rien");
    assert.equal(creationsDEtape(h).length, 0, "aucune session d'étape créée");
    assert.equal(ctx.view(runId).state, "attente-choix");

    // VOTRE choix : un spécialiste, et lui seul, part — l'aiguilleur n'est pas refait.
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "s1", { text: "Réseau : la route vers la base a sauté.", cost: 0.01, stepMs: 5 });
    const reponse = await ctx.continuer(runId, { choix: ["s1"] });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "suite après le choix");
    assert.deepEqual(
      fini.steps.map((step) => `${step.stepId}:${step.tentative}:${step.state}`),
      ["tri:1:terminee", "s1:1:terminee", "s2:1:non-choisi", "s3:1:non-choisi", "syn:1:non-choisi"],
      "aucune tentative neuve : la reprise garde les lignes de la pause",
    );
    assert.deepEqual(
      creationsDEtape(h).map((req) => (req.body as { metadata?: { etape?: string } }).metadata?.etape),
      ["s1"],
      "seul le spécialiste choisi a une session ; l'aiguilleur, déjà payé, n'est pas refait",
    );
    assert.equal(envois(h).length, 1);
    h.assertNoGlobalRestart();
  });

  it("redémarrage du cockpit en « attente-choix » : « Aucun ne convient » ne lance rien, il passe donc sans estimation", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "44444444-5555-6666-7777-888888888888";
    const rootId = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } })).json<FakeSession>().id;
    const etapeSession = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Tri" } })).json<FakeSession>().id;
    seedChoix(h, { runId, rootId, flow: aiguillageFlow(), sessionId: etapeSession });
    await h.cockpit.startup();
    assert.deepEqual(ctx.view(runId).pause?.reestimation, { aucunLibre: true, possible: true });

    const avant = h.fake.requests.length;
    const reponse = await ctx.continuer(runId, { aucun: true });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "chemin « aucun » après le redémarrage");
    assert.equal(fini.steps.find((step) => step.stepId === "tri")?.choix, "aucun", "VOTRE réponse est écrite");
    assert.deepEqual(
      fini.steps.filter((step) => step.stepId !== "tri").map((step) => step.state),
      ["non-choisi", "non-choisi", "non-choisi", "non-choisi"],
    );
    const apres = h.fake.requests.slice(avant);
    assert.equal(apres.filter((req) => req.pathname.endsWith("/prompt_async")).length, 0, "aucun appel d'IA");
    assert.equal(apres.filter((req) => req.method === "POST" && req.pathname === "/session").length, 0, "aucune session");
    assert.deepEqual(ctx.estimations, [], "aucune estimation demandée pour un chemin qui ne coûte rien");
    assert.equal(fini.cost, 0);
    h.assertNoGlobalRestart();
  });

  it("pause vivante (lancée par ce cockpit) : ni estimation ni relance à la place de VOTRE réponse", async (t) => {
    const ctx = await openTeam(t, { flow: aiguillageFlow(), guardsReels: true });
    const { h } = ctx;
    scripterAiguillage(h);
    const { runId } = (await ctx.run()).json<TeamRunStarted>();
    const enChoix = await ctx.waitRun(runId, (v) => v.state === "attente-choix", "pause de choix");
    assert.equal(enChoix.pause?.reestimation, undefined, "l'instantané du lancement est là : rien à ré-estimer");
    const avant = h.fake.requests.length;
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.deepEqual([estimation.status, estimation.json<{ error: string }>().error], [409, "pas-relancable"]);
    const relance = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: ctx.plan.estimateSha256 } });
    assert.deepEqual([relance.status, relance.json<{ error: string }>().error], [409, "pas-relancable"]);
    assert.equal(h.fake.requests.length, avant, "aucune requête");
    assert.deepEqual(ctx.estimations, []);
    assert.equal(ctx.view(runId).state, "attente-choix");
    h.assertNoGlobalRestart();
  });

  it("redémarrage du cockpit pendant une pause « vérifier » : message du bloc gardé, ré-estimation, puis VOTRE [Continuer] reprend", async (t) => {
    const ctx = await openTeam(t, { flow: pauseFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "55555555-6666-7777-8888-999999999999";
    const rootId = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } })).json<FakeSession>().id;
    const collecte = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Collecte" } })).json<FakeSession>().id;
    seedLancement(h, {
      runId,
      rootId,
      flow: pauseFlow(),
      state: "attente-verification",
      cause: "pause",
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte : trois journaux relevés." } },
    });
    await h.cockpit.startup();
    const vue = ctx.view(runId);
    assert.equal(vue.state, "attente-verification");
    assert.equal(vue.pause?.kind, "verification");
    assert.equal(vue.pause?.message, "Vérifiez la collecte avant l'analyse.", "le message du bloc « pause » survit au redémarrage");
    assert.equal(vue.pause?.blocId, "p");
    assert.deepEqual(vue.pause?.reestimation, { aucunLibre: false, possible: true });

    const refus = await ctx.continuer(runId, { precision: "Regarde aussi la table des factures." });
    assert.deepEqual([refus.status, refus.json<{ error: string }>().error], [409, "reestimation-requise"]);

    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 },
    });
    assert.equal(confirme.status, 200, confirme.body);
    const revenue = confirme.json<TeamRunView>();
    assert.deepEqual([revenue.state, revenue.cause, revenue.pause?.kind, revenue.pause?.message], ["attente-verification", "pause", "verification", "Vérifiez la collecte avant l'analyse."]);
    assert.equal(revenue.pause?.reestimation, undefined);
    assert.equal(creationsDEtape(h).length, 0, "la confirmation de l'estimation ne lance rien : la pause attend votre réponse");

    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse : rien d'anormal.", cost: 0.01, stepMs: 5 });
    const reponse = await ctx.continuer(runId, { precision: "Regarde aussi la table des factures." });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "suite après la pause");
    assert.deepEqual(fini.steps.map((step) => `${step.stepId}:${step.tentative}:${step.state}`), ["a:1:terminee", "b:1:terminee"]);
    assert.deepEqual(creationsDEtape(h).map((req) => (req.body as { metadata?: { etape?: string } }).metadata?.etape), ["b"], "l'étape déjà faite n'est pas refaite");
    const corps = texteDe(h.fake.messages(sessionDe(h, "b"))[0]?.parts);
    assert.ok(corps.includes("Regarde aussi la table des factures."), "votre précision part avec l'étape suivante");
    assert.ok(corps.includes("Collecte : trois journaux relevés."), "le résultat de l'étape d'avant le redémarrage est bien transmis (relu en base)");
    h.assertNoGlobalRestart();
  });

  it("redémarrage du cockpit avec une étape en file (nouvel essai perdu) : la reprise confirmée la relance, sans tentative neuve", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const rootId = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Conversation" } })).json<FakeSession>().id;
    const collecte = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Collecte" } })).json<FakeSession>().id;
    seedLancement(h, {
      runId,
      rootId,
      flow: duoFlow(),
      state: "en-cours",
      cause: null,
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte faite." }, b: { state: "en-file", sessionId: null, extrait: null } },
    });
    await h.cockpit.startup();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause du redémarrage");
    assert.equal(vue.pause?.kind, "redemarrage-cockpit");
    assert.deepEqual(vue.pause?.reestimation, { aucunLibre: false, possible: true });
    assert.deepEqual([(await ctx.continuer(runId, {})).status, ctx.view(runId).state], [409, "attente-verification"]);

    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse faite.", cost: 0.01, stepMs: 5 });
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 },
    });
    assert.equal(confirme.status, 200, confirme.body);
    // La pause du redémarrage n'a pas d'autre réponse que « continuer » : votre confirmation relance la suite.
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee", "suite relancée");
    assert.deepEqual(fini.steps.map((step) => `${step.stepId}:${step.tentative}:${step.state}`), ["a:1:terminee", "b:1:terminee"], "l'étape en file repart sur SA ligne");
    assert.equal(envois(h).length, 1);
    h.assertNoGlobalRestart();
  });
});

describe("Clôture 5b (D-5b-1) : réponse jouée à blanc, reste compté par passage, une seule confirmation", () => {
  it("redémarrage ENTRE deux tours d'une relecture (le tour 2 n'a pas encore de ligne) : ré-estimation demandée, jamais un échec", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const rootId = await nouvelleSession(h, "Conversation");
    const redac = await nouvelleSession(h, "Rédaction");
    const relec = await nouvelleSession(h, "Relecture");
    seedLancement(h, {
      runId,
      rootId,
      flow: relectureFlow(),
      state: "attente-verification",
      cause: "redemarrage-cockpit",
      lignes: {
        redac: { state: "terminee", sessionId: redac, extrait: "Version 1 du compte rendu." },
        relec: { state: "terminee", sessionId: relec, extrait: "Les causes ne sont pas étayées.\nVERDICT: À REPRENDRE" },
      },
    });
    h.db.prepare("UPDATE team_run_steps SET verdict = 'a-reprendre' WHERE run_id = ? AND step_id = 'relec'").run(runId);
    await h.cockpit.startup();
    const vue = ctx.view(runId);
    assert.equal(vue.pause?.kind, "redemarrage-cockpit");
    // Aucune ligne « prevue » ni « en-file » : c'est l'ordonnanceur, joué à blanc, qui sait que le tour 2 partirait.
    assert.deepEqual(vue.pause?.reestimation, { aucunLibre: false, possible: true });

    const avant = h.fake.requests.length;
    const refus = await ctx.continuer(runId, {});
    assert.deepEqual([refus.status, refus.json<{ error: string }>().error], [409, "reestimation-requise"]);
    assert.equal(h.fake.requests.length, avant, "refus rendu avant toute requête");
    assert.equal(ctx.view(runId).state, "attente-verification", "la réponse n'a pas fait échouer le tour 2 faute d'instantané");

    // Sessions déjà ouvertes avant le redémarrage : leurs réponses sont posées sur elles directement (scriptWhen ne vaut qu'à la
    // création d'une session).
    h.fake.script(redac, { text: "Version 2 du compte rendu.", cost: 0.01, stepMs: 5 });
    h.fake.script(relec, { text: "Rien à redire.\nVERDICT: RIEN À REPRENDRE", cost: 0.01, stepMs: 5 });
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 },
    });
    assert.equal(confirme.status, 200, confirme.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "tour 2 après la reprise");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    assert.equal(creationsDEtape(h).length, 0, "le tour 2 reprend les sessions du tour 1 (D-5-14) : aucune session neuve");
    assert.deepEqual(
      fini.steps.map((step) => `${step.stepId}#${step.tour}:${step.state}`).toSorted(),
      ["redac#1:terminee", "redac#2:terminee", "relec#1:terminee", "relec#2:terminee"],
    );
    h.assertNoGlobalRestart();
  });

  it("redémarrage pendant la pause d'avant la relecture : reste confirmé compté PAR PASSAGE, puis VOTRE [Continuer] lance le relecteur", async (t) => {
    const ctx = await openTeam(t, { flow: relectureFlow(true), guardsReels: true });
    const { h } = ctx;
    const runId = "88888888-9999-aaaa-bbbb-cccccccccccc";
    const rootId = await nouvelleSession(h, "Conversation");
    const redac = await nouvelleSession(h, "Rédaction");
    seedLancement(h, {
      runId,
      rootId,
      flow: relectureFlow(true),
      state: "attente-verification",
      cause: "pause",
      lignes: { redac: { state: "terminee", sessionId: redac, extrait: "Version 1 du compte rendu." } },
    });
    await h.cockpit.startup();
    const vue = ctx.view(runId);
    assert.deepEqual([vue.pause?.kind, vue.pause?.blocId], ["verification", "rel"], "la pause d'avant la relecture est rendue telle quelle");
    assert.deepEqual(vue.pause?.reestimation, { aucunLibre: false, possible: true });

    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 },
    });
    assert.equal(confirme.status, 200, confirme.body);
    // Le reste transmis au pré-lancement est celui que l'estimation montrée a compté : le premier jet, fait, est retiré UNE
    // fois ; les révisions à venir restent. Compté par identifiant, il perdait les révisions et l'empreinte ne tombait plus.
    assert.deepEqual(ctx.verifications.at(-1)?.relance?.restantes, ["relec", "redac", "relec", "redac"]);
    assert.deepEqual([confirme.json<TeamRunView>().state, confirme.json<TeamRunView>().pause?.kind], ["attente-verification", "verification"]);
    assert.equal(creationsDEtape(h).length, 0, "la confirmation de l'estimation ne lance rien : la pause attend votre réponse");

    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec", { text: "Rien à redire.\nVERDICT: RIEN À REPRENDRE", cost: 0.01, stepMs: 5 });
    const reponse = await ctx.continuer(runId, {});
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "relecture après la pause");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    assert.deepEqual(
      creationsDEtape(h).map((req) => (req.body as { metadata?: { etape?: string } }).metadata?.etape),
      ["relec"],
      "le premier jet, déjà payé, n'est pas refait",
    );
    h.assertNoGlobalRestart();
  });

  it("deux confirmations presque simultanées sur une pause « vérifier » reprise : une seule passe, et la pause attend VOTRE réponse", async (t) => {
    const ctx = await openTeam(t, { flow: pauseFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const rootId = await nouvelleSession(h, "Conversation");
    const collecte = await nouvelleSession(h, "Collecte");
    seedLancement(h, {
      runId,
      rootId,
      flow: pauseFlow(),
      state: "attente-verification",
      cause: "pause",
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte : trois journaux relevés." } },
    });
    await h.cockpit.startup();
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const corps = { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 };
    // Les deux confirmations entrent dans le pré-lancement AVANT que l'une n'en sorte : c'est la fenêtre d'un double clic.
    let liberer = (): void => undefined;
    ctx.retenue = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    const envoiUn = h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps });
    const envoiDeux = h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps });
    await until(() => (ctx.verifications.length >= 2 ? true : undefined), 5_000);
    liberer();
    const [un, deux] = await Promise.all([envoiUn, envoiDeux]);
    assert.deepEqual([un.status, deux.status].toSorted(), [200, 409], `${un.body} | ${deux.body}`);
    // Tour 3 : la perdante trouve la pause revenue avec son estimation. « … relancez l'équipe depuis la saisie » (pas-relancable)
    // était faux ici ; la phrase dit que l'état a changé, et que rien n'est parti.
    const perdante = (un.status === 409 ? un : deux).json<{ error: string; message: string }>();
    assert.deepEqual(perdante, { error: "etat-incompatible", message: `${TEXTES.partout.erreurs["etat-incompatible"]} ${TEXTES.partout.honnetete.rienEnvoye}` });
    assert.doesNotMatch(perdante.message, /depuis la saisie/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const vue = ctx.view(runId);
    assert.deepEqual([vue.state, vue.cause, vue.pause?.kind], ["attente-verification", "pause", "verification"], "jamais une relance complète d'une pause");
    const neuves = h.db.prepare("SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ? AND tentative > 1").get(runId) as { n: number };
    assert.equal(neuves.n, 0, "aucune tentative neuve");
    assert.equal(envois(h).length, 0, "rien n'est envoyé avant votre réponse");
    h.assertNoGlobalRestart();
  });

  it("tour 3 : deux confirmations presque simultanées sur la pause « Le cockpit a redémarré » : la perdante trouve l'équipe repartie et le dit", async (t) => {
    const ctx = await openTeam(t, { flow: duoFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "eeeeeeee-ffff-0000-1111-222222222222";
    const rootId = await nouvelleSession(h, "Conversation");
    const collecte = await nouvelleSession(h, "Collecte");
    seedLancement(h, {
      runId,
      rootId,
      flow: duoFlow(),
      state: "attente-verification",
      cause: "redemarrage-cockpit",
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte faite." } },
    });
    await h.cockpit.startup();
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse faite.", cost: 0.01, stepMs: 5 });
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const corps = { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 };
    let liberer = (): void => undefined;
    ctx.retenue = new Promise<void>((resolve) => {
      liberer = resolve;
    });
    const envoiUn = h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps });
    const envoiDeux = h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps });
    await until(() => (ctx.verifications.length >= 2 ? true : undefined), 5_000);
    liberer();
    const [un, deux] = await Promise.all([envoiUn, envoiDeux]);
    assert.deepEqual([un.status, deux.status].toSorted(), [200, 409], `${un.body} | ${deux.body}`);
    const perdante = (un.status === 409 ? un : deux).json<{ error: string; message: string }>();
    assert.deepEqual(perdante, { error: "etat-incompatible", message: `${TEXTES.partout.erreurs["etat-incompatible"]} ${TEXTES.partout.honnetete.rienEnvoye}` });
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.state === "echec", "suite relancée une seule fois");
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    assert.equal(envois(h).length, 1, "l'étape restante part une seule fois");
    h.assertNoGlobalRestart();
  });

  it("redémarrage avec une étape en file APRÈS une pause déjà franchie : la reprise ne redemande pas la pause", async (t) => {
    const ctx = await openTeam(t, { flow: pauseFlow(), guardsReels: true });
    const { h } = ctx;
    const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const rootId = await nouvelleSession(h, "Conversation");
    const collecte = await nouvelleSession(h, "Collecte");
    seedLancement(h, {
      runId,
      rootId,
      flow: pauseFlow(),
      state: "en-cours",
      cause: null,
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte faite." }, b: { state: "en-file", sessionId: null, extrait: null } },
    });
    await h.cockpit.startup();
    const vue = await ctx.waitRun(runId, (v) => v.state === "attente-verification", "pause du redémarrage");
    assert.equal(vue.pause?.kind, "redemarrage-cockpit");

    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse faite.", cost: 0.01, stepMs: 5 });
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: estimation.json<{ estimateSha256: string }>().estimateSha256 },
    });
    assert.equal(confirme.status, 200, confirme.body);
    // L'étape « b » était en file : l'ordonnanceur avait donc déjà passé la pause « p », qui a reçu votre réponse avant le
    // redémarrage. Seules les étapes TERMINÉES comptaient, et « Vérifiez la collecte… » revenait.
    const fini = await ctx.waitRun(runId, (v) => v.state === "terminee" || v.pause?.kind === "verification", "suite relancée");
    assert.equal(fini.state, "terminee", `pause redemandée : ${JSON.stringify(fini.pause?.kind)}`);
    assert.deepEqual(fini.steps.map((step) => `${step.stepId}:${step.tentative}:${step.state}`), ["a:1:terminee", "b:1:terminee"]);
    h.assertNoGlobalRestart();
  });
});

/** Conversation ou session d'étape déjà créée chez opencode avant le redémarrage (par le proxy, sans marque d'équipe). */
async function nouvelleSession(h: CockpitHarness, titre: string): Promise<string> {
  const reponse = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: titre } });
  assert.equal(reponse.status, 200, reponse.body);
  return reponse.json<FakeSession>().id;
}

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
        `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, state, session_id, result_excerpt, message_text, model, cost)
         VALUES (:run, :step, 1, 1, :ordre, :bloc, :titre, :agent, :state, :session, :extrait, :texte, :model, 0)`,
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
        // Clôture 5b (D-5b-1) : la consigne réellement envoyée à l'aiguilleur, qui porte la demande entre les marqueurs de
        // D-eq-27. C'est d'elle que la relance reconstitue la demande, sans aucune colonne dédiée.
        texte: premier ? consigneEnvoyee(options.flow, step.id, options.runId) : null,
        model: MODEL,
      });
  });
  h.db
    .prepare("INSERT INTO team_run_events (run_id, kind, par, data, at) VALUES (?, 'aiguillage-propose', 'cockpit', ?, 1)")
    .run(options.runId, JSON.stringify({ bloc: "aig", ids: "s1,s2" }));
}

// --- Clôture 5b (D-5b-1) : pauses qui survivent à un redémarrage du cockpit ------------------------------------------------------

/** Deux étapes à la suite, séparées par une pause pour vérifier (message écrit dans le bloc). */
const pauseFlow = (): Flow => ({
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: etape("a", "Collecte", AGENT_SCRIPT, "demande") },
    { type: "pause", id: "p", message: "Vérifiez la collecte avant l'analyse." },
    { type: "etape", id: "b2", etape: etape("b", "Analyse", AGENT_SQL, "precedent") },
  ],
});

/** Deux étapes à la suite, sans pause. */
const duoFlow = (): Flow => ({
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: etape("a", "Collecte", AGENT_SCRIPT, "demande") },
    { type: "etape", id: "b2", etape: etape("b", "Analyse", AGENT_SQL, "precedent") },
  ],
});

/** Consigne réelle d'une étape qui a reçu la demande : les marqueurs de D-eq-27 bornés par l'identifiant du lancement. */
function consigneEnvoyee(flow: Flow, stepId: string, runId: string): string {
  return stepMessage(flow, stepId, {
    runId,
    tour: 1,
    tentative: 1,
    equipe: "Enquête d'incident",
    total: etapesDeclarees(flow).length,
    n: 1,
    demande: DEMANDE,
    fichiers: [],
    precisions: [],
    resultats: [],
  });
}

/**
 * Lancement écrit comme avant un redémarrage du cockpit, étape par étape. La première étape terminée porte la consigne réelle
 * (demande reconstituable) ; une étape absente de `lignes` est « prevue ».
 */
function seedLancement(
  h: CockpitHarness,
  options: {
    runId: string;
    rootId: string;
    flow: Flow;
    state: string;
    cause: string | null;
    lignes: Record<string, { state: string; sessionId: string | null; extrait: string | null }>;
    /** Dossier du lancement ; défaut : la racine du faux (tour 3 : un sous-dossier, pour le pré-lancement RÉEL, P9). */
    directory?: string;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, cause, facultatifs, plafond, cost, confirmations, precisions, created_at, started_at)
       VALUES (:id, 'Enquête d''incident', :flow, 'f0', :root, :dir, :state, :cause, '[]', 1, 0, '{}', '[]', 1, 1)`,
    )
    .run({ id: options.runId, flow: JSON.stringify(options.flow), root: options.rootId, dir: options.directory ?? h.fake.directory, state: options.state, cause: options.cause });
  etapesDeclarees(options.flow).forEach(({ step, blocIndex, ordre }, index) => {
    const ligne = options.lignes[step.id] ?? { state: "prevue", sessionId: null, extrait: null };
    h.db
      .prepare(
        `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, state, session_id, result_excerpt, message_text, model, cost)
         VALUES (:run, :step, 1, 1, :ordre, :bloc, :titre, :agent, :state, :session, :extrait, :texte, :model, 0)`,
      )
      .run({
        run: options.runId,
        step: step.id,
        ordre,
        bloc: blocIndex,
        titre: step.titre,
        agent: step.assistant,
        state: ligne.state,
        session: ligne.sessionId,
        extrait: ligne.extrait,
        texte: index === 0 && ligne.sessionId !== null ? consigneEnvoyee(options.flow, step.id, options.runId) : null,
        model: MODEL,
      });
  });
}

// --- Clôture 5b, tour 3 (D-5b-1) : accords de la reprise, sur le pré-lancement RÉEL ---------------------------------------------

/** Assistant d'étape avec son IA propre : le pré-lancement RÉEL (L37p) estime et juge chaque étape sur l'IA de l'assistant. */
const agentAvecIa = (name: string): FakeAgent => ({ ...stepAgent(name), model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, steps: 40 });

/**
 * Cockpit avec les modules d'équipes RÉELS — pré-lancement (L37p), exécuteur, verrous et routes d'incident — et AUCUN port
 * surchargé : la reprise passe par les vraies règles du garde-fou (P6), du budget du mois (P7), du plafond (P8) et de l'empreinte.
 * Le lancement travaille dans un sous-dossier du workspace, pour ne pas demander la confirmation « workspace » (P9).
 */
async function bancReel(t: TestContext, settings: Record<string, unknown> = {}): Promise<{ h: CockpitHarness; runner: TeamRunner; directory: string }> {
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" }, ...settings },
    modules: ["floors", "stopTree"],
    equipes: ["teams", "teamPreflight", createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }), "teamGuards"],
  });
  h.fake.setAgents([...h.fake.agents(), agentAvecIa(AGENT_SQL), agentAvecIa(AGENT_SCRIPT)]);
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
  return { h, runner: h.cockpit.equipes.eq.ports.runner as TeamRunner, directory: `${h.fake.directory}/projet` };
}

/** Budget du mois ÉPUISÉ par une dépense d'une autre conversation (réglages par défaut : 150 $, blockAtLimit). */
function epuiserLeBudget(h: CockpitHarness, usd: number): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost_reported, cost, cost_source)
       VALUES ('msg_budget', 'ses_autre', 'ses_autre', 'github-copilot', 'gpt-5-mini', ?, ?, ?, ?, 'reported')`,
    )
    .run(maintenant, maintenant, usd, usd);
  h.deps.ledger.recompute();
  assert.ok(h.deps.ledger.percentUsed() >= 100, `budget du mois épuisé : ${h.deps.ledger.percentUsed()} %`);
}

const confirmationsDe = (h: CockpitHarness, runId: string): unknown =>
  JSON.parse((h.db.prepare("SELECT confirmations FROM team_runs WHERE id = ?").get(runId) as { confirmations: string }).confirmations);

describe("Clôture 5b, tour 3 (D-5b-1) : les accords montrés par la boîte de la reprise, sur le pré-lancement RÉEL", () => {
  it("pause « garde-fou budgétaire » reprise avec le budget du mois épuisé (réglages par défaut) : l'accord « budget » écrit dans la boîte la rend, puis VOTRE [Continuer] confirmé fait partir l'étape", async (t) => {
    const { h, runner, directory } = await bancReel(t);
    const runId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const rootId = await nouvelleSession(h, "Conversation");
    const collecte = await nouvelleSession(h, "Collecte");
    seedLancement(h, {
      runId,
      rootId,
      flow: duoFlow(),
      state: "attente-budget",
      cause: "budget",
      directory,
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte faite." } },
    });
    epuiserLeBudget(h, 150);
    await h.cockpit.startup();

    const vue = runner.view(runId);
    assert.deepEqual([vue?.state, vue?.pause?.kind], ["attente-budget", "budget"], "la pause du garde-fou survit au redémarrage");
    assert.deepEqual(vue?.pause?.reestimation, { aucunLibre: false, possible: true });

    // L'estimation, seule route qui lit opencode, annonce l'accord « budget » : la suite peut coûter plus que ce qui reste.
    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const montree = estimation.json<TeamEstimateResponse>();
    assert.equal(montree.blocage, null);
    assert.deepEqual(montree.confirmations, ["budget"]);

    // Sans l'accord, refus comme avant (P7) ; toute autre forme d'accord est refusée en 400. Aucun refus n'émet de requête (A4).
    const avant = h.fake.requests.length;
    const sansAccord = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: { estimateSha256: montree.estimateSha256 } });
    assert.deepEqual([sansAccord.status, sansAccord.json<{ error: string }>().error], [409, "budget-insuffisant"]);
    for (const confirmations of [{ budget: "oui" }, { workspace: true }, { budget: true, secret: true }, ["budget"], "budget", null]) {
      const invalide = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
        headers: h.headers.confirmed,
        body: { estimateSha256: montree.estimateSha256, confirmations },
      });
      assert.deepEqual([invalide.status, invalide.json<{ error: string }>().error], [400, "invalid"], JSON.stringify(confirmations));
    }
    assert.equal(h.fake.requests.length, avant, "aucun refus n'a émis de requête");
    assert.equal(runner.view(runId)?.pause?.reestimation !== undefined, true, "la pause attend toujours son estimation");

    // La boîte a ÉCRIT l'accord, votre confirmation le vaut : la pause revient avec son estimation, et rien ne part.
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, {
      headers: h.headers.confirmed,
      body: { estimateSha256: montree.estimateSha256, confirmations: { budget: true } },
    });
    assert.equal(confirme.status, 200, confirme.body);
    const revenue = confirme.json<TeamRunView>();
    assert.deepEqual([revenue.state, revenue.pause?.kind, revenue.pause?.reestimation], ["attente-budget", "budget", undefined]);
    assert.equal(revenue.plafond, montree.plafond, "le plafond d'arrêt est celui de l'estimation montrée");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(envois(h).length, 0, "la confirmation de l'estimation ne lance rien : la pause attend votre réponse");
    assert.deepEqual(confirmationsDe(h, runId), {}, "l'accord de la reprise n'est jamais écrit dans le lancement");

    // Garde-fou budgétaire (P6), inchangé : [Continuer] sans confirmation est refusé, VOTRE [Continuer] confirmé fait partir l'étape.
    const sansConfirmation = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.deepEqual([sansConfirmation.status, sansConfirmation.json<{ error: string }>().error], [409, "budget-guard"]);
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "b", { text: "Analyse faite.", cost: 0.01, stepMs: 5 });
    const reponse = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.confirmed, body: {} });
    assert.equal(reponse.status, 200, reponse.body);
    const fini = await until(() => {
      const courante = runner.view(runId);
      return courante && (courante.state === "terminee" || courante.state === "echec" || courante.state === "plafond") ? courante : undefined;
    }, 8_000);
    assert.equal(fini.state, "terminee", `cause : ${String(fini.cause)}`);
    assert.deepEqual(fini.steps.map((step) => `${step.stepId}:${step.tentative}:${step.state}`), ["a:1:terminee", "b:1:terminee"], "rien de déjà fait n'est refait");
    assert.deepEqual(creationsDEtape(h).map((req) => (req.body as { metadata?: { etape?: string } }).metadata?.etape), ["b"]);
    assert.equal(envois(h).length, 1);
    h.assertNoGlobalRestart();
  });

  it("pause « vérifier » reprise en mode Avancé avec un plafond maximum dépassé : l'accord « plafond » est exigé tel que la boîte l'a écrit", async (t) => {
    const { h, runner, directory } = await bancReel(t, { teams: { maxCapUsd: 0.001 } });
    const runId = "cccccccc-dddd-eeee-ffff-000000000000";
    const rootId = await nouvelleSession(h, "Conversation");
    const collecte = await nouvelleSession(h, "Collecte");
    seedLancement(h, {
      runId,
      rootId,
      flow: pauseFlow(),
      state: "attente-verification",
      cause: "pause",
      directory,
      lignes: { a: { state: "terminee", sessionId: collecte, extrait: "Collecte : trois journaux relevés." } },
    });
    await h.cockpit.startup();
    assert.deepEqual(runner.view(runId)?.pause?.reestimation, { aucunLibre: false, possible: true });

    const estimation = await h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    const montree = estimation.json<TeamEstimateResponse>();
    assert.deepEqual(montree.confirmations, ["plafond"]);
    const corps = (confirmations?: Record<string, true>) => ({ estimateSha256: montree.estimateSha256, ...(confirmations ? { confirmations } : {}) });
    const sans = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps() });
    assert.deepEqual([sans.status, sans.json<{ error: string }>().error], [409, "plafond-a-confirmer"]);
    // Un accord que la boîte n'a pas écrit ne remplace pas celui qu'elle a écrit.
    const autre = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps({ budget: true }) });
    assert.deepEqual([autre.status, autre.json<{ error: string }>().error], [409, "plafond-a-confirmer"]);
    const confirme = await h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: h.headers.confirmed, body: corps({ plafond: true }) });
    assert.equal(confirme.status, 200, confirme.body);
    const revenue = confirme.json<TeamRunView>();
    assert.deepEqual([revenue.state, revenue.cause, revenue.pause?.kind, revenue.pause?.reestimation], ["attente-verification", "pause", "verification", undefined]);
    assert.equal(envois(h).length, 0, "rien ne part avant votre réponse");
    assert.deepEqual(confirmationsDe(h, runId), {}, "l'accord de la reprise n'est jamais écrit dans le lancement");
    h.assertNoGlobalRestart();
  });
});

describe("Clôture 5b, tour 3 : la pause « garde-fou budgétaire » nomme l'étape qui attend vraiment", () => {
  it("pause « garde-fou budgétaire » après votre choix d'aiguillage : le message nomme l'étape retenue qui attend, jamais un spécialiste « Non choisi »", async (t) => {
    // Sonde K2b de la contre-vérification : « L'étape « Supervision et seuils » attend votre confirmation… » alors que seul le
    // spécialiste « reseau » était retenu. `prochaineEtape` rendait la première étape non « terminee », « non-choisi » compris.
    const ctx = await openTeam(t, { flow: aiguillageFlow() });
    const { h } = ctx;
    const runId = "dddddddd-eeee-ffff-0000-111111111111";
    const rootId = await nouvelleSession(h, "Conversation");
    const tri = await nouvelleSession(h, "Tri");
    seedLancement(h, {
      runId,
      rootId,
      flow: aiguillageFlow(),
      state: "attente-budget",
      cause: "budget",
      lignes: {
        tri: { state: "terminee", sessionId: tri, extrait: "Le code applicatif d'abord.\nCHOIX: Applicatif" },
        s1: { state: "non-choisi", sessionId: null, extrait: null },
        s2: { state: "non-choisi", sessionId: null, extrait: null },
        syn: { state: "non-choisi", sessionId: null, extrait: null },
      },
    });
    h.db.prepare("UPDATE team_run_steps SET choix = ? WHERE run_id = ? AND step_id = 'tri'").run(JSON.stringify(["s3"]), runId);
    const vue = ctx.view(runId);
    assert.equal(vue.pause?.kind, "budget");
    assert.equal(vue.pause?.message, remplir(TEXTES.partout.pauses.budget.message, { titre: "Applicatif" }));
    assert.doesNotMatch(vue.pause?.message ?? "", /Réseau|Base|Synthèse/, "aucun spécialiste écarté ni la synthèse écartée");
  });
});
