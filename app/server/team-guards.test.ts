// Tests L37c : incidents des équipes (team-run-guards.ts) sur le harnais du cockpit et le faux opencode — verrous du proxy et
// des Archives (D-eq-04), arrêt décoré (D-eq-05), plafond d'arrêt (§6 l.1036), rechargement d'opencode (§3.11), garde de
// rechargement composée (Studio, redémarrage, RÉALIGNEMENT), routes d'incident (stop, estimate, relancer, fermer,
// ajouter-resultats) et relance sans aucune requête (A4, D-eq-17, D-eq-27).
// Les ports `runner` et `preflight` sont SURCHARGÉS (plan it4 §2.3) : le runner de ces tests est adossé au VRAI magasin (L37s),
// donc les états et les transitions sont ceux de la branche ; le pré-lancement est un espion qui ne lit jamais opencode.
// Aucune écriture de configuration, aucun redémarrage : assertNoGlobalRestart à la fin de chaque scénario qui touche opencode.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { AssistantService } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { StopTreePort } from "./contracts-11.ts";
import type {
  EstimateOutcome,
  PreflightInput,
  PreflightOutcome,
  RunPlan,
  TeamPreflightPort,
  TeamProxyGuardRequest,
  TeamRow,
  TeamRunnerPort,
} from "./contracts-eq.ts";
import type { AppDeps } from "./http.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import type { StudioService } from "./studio.ts";
import { stepMessage } from "./shared/flow.ts";
import { FLOW_VERSION } from "./shared/team-limits.ts";
import { remplir, TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowStep, StepInput, TeamRunState, TeamRunView, TeamStepState } from "./shared/team-types.ts";
import { neutralRunner } from "./team-runner.ts";
import { createTeamStore, type TeamStore } from "./team-store.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const SHA = "a".repeat(64);
const P = TEXTES.partout;

const step = (id: string, titre: string, recoit: StepInput): FlowStep => ({
  id,
  titre,
  assistant: "relire-requete-sql",
  niveau: null,
  taille: "M",
  consigne: `Consigne de ${titre}.`,
  recoit,
});

/** Équipe « à la suite » de trois étapes : la première reçoit la demande (marqueurs de D-eq-27). */
const FLOW: Flow = {
  version: FLOW_VERSION,
  blocs: [
    { type: "etape", id: "b1", etape: step("collecte", "Collecte", "demande") },
    { type: "etape", id: "b2", etape: step("analyse", "Analyse", "precedent") },
    { type: "etape", id: "b3", etape: step("synthese", "Synthèse", "precedent") },
  ],
};
const DEMANDE = "Relis la requête des factures.";
const FICHIERS = ["/workspace/eq/factures.sql"];

/** Texte exact envoyé à la première étape : c'est lui que la relance relit (D-eq-27). */
const messageDeCollecte = (runId: string): string =>
  stepMessage(FLOW, "collecte", {
    runId,
    tour: 1,
    tentative: 1,
    equipe: "Revue SQL",
    total: 3,
    n: 1,
    demande: DEMANDE,
    fichiers: FICHIERS,
    precisions: [],
    resultats: [],
  });

// --- Semis ------------------------------------------------------------------------------------------------------------------------

interface SeedStep {
  stepId: string;
  state: TeamStepState;
  sessionId?: string;
  /** Texte envoyé à l'étape ; « collecte » par défaut pour la première étape. */
  messageText?: string | null;
  cost?: number;
}

interface SeedRun {
  rootId: string;
  state: TeamRunState;
  plafond?: number | null;
  directory?: string;
  steps?: SeedStep[];
  resultMessageId?: string | null;
}

const ORDRE = ["collecte", "analyse", "synthese"];

/** Passe par les transitions réelles (canTransition) : un état est refusé si le magasin le refuse. */
function walkRun(store: TeamStore, runId: string, target: TeamRunState): void {
  if (target === "preparation") return;
  const chemin: TeamRunState[] = target === "terminee" ? ["en-cours", "terminee"] : [target];
  for (const state of chemin) assert.equal(store.runs.setState(runId, state), true, `lancement → ${state}`);
}

function walkStep(store: TeamStore, runId: string, stepId: string, target: TeamStepState): void {
  const key = { runId, stepId, tour: 1, tentative: 1 };
  const chemin: TeamStepState[] =
    target === "prevue"
      ? []
      : target === "en-file" || target === "non-lancee"
        ? [target]
        : target === "en-cours"
          ? ["en-file", "en-cours"]
          : ["en-file", "en-cours", target];
  for (const state of chemin) assert.equal(store.steps.setState(key, state), true, `${stepId} → ${state}`);
}

function seedRun(store: TeamStore, seed: SeedRun): string {
  const runId = randomUUID();
  store.runs.create({
    id: runId,
    teamId: "revue-sql",
    teamTitre: "Revue SQL",
    flow: FLOW,
    flowSha256: "f".repeat(64),
    estimateSha256: SHA,
    modeUi: "avance",
    rootId: seed.rootId,
    directory: seed.directory ?? "/workspace",
    estimate: { typique: 0.2, maximum: 0.6 },
    plafond: seed.plafond === undefined ? 0.6 : seed.plafond,
    confirmations: { plafond: true },
  });
  for (const [index, stepId] of ORDRE.entries()) {
    const seeded = seed.steps?.find((s) => s.stepId === stepId);
    store.steps.create({ runId, stepId, tour: 1, tentative: 1, ordre: index + 1, blocIndex: index, titre: stepId, agent: "relire-requete-sql", state: "prevue" });
    const messageText = seeded?.messageText === undefined ? (stepId === "collecte" ? messageDeCollecte(runId) : null) : seeded.messageText;
    store.steps.patch(
      { runId, stepId, tour: 1, tentative: 1 },
      { messageText, sessionId: seeded?.sessionId ?? null, cost: seeded?.cost ?? 0 },
    );
    if (seeded) walkStep(store, runId, stepId, seeded.state);
  }
  walkRun(store, runId, seed.state);
  if (seed.resultMessageId !== undefined) store.runs.patch(runId, { resultMessageId: seed.resultMessageId });
  return runId;
}

/** Conversation archivée (ligne `conversations`) : la purge des Archives la supprime et vide les textes d'équipe. */
function seedConversation(h: CockpitHarness, rootId: string): void {
  h.db.prepare("INSERT OR IGNORE INTO conversations (session_id, created_at, updated_at) VALUES (?, 1, 1)").run(rootId);
}

const teamTexts = (h: CockpitHarness, runId: string) => ({
  conversations: (h.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n,
  message: (h.db.prepare("SELECT message_text FROM team_run_steps WHERE run_id = ? AND step_id = 'collecte'").get(runId) as { message_text: string | null }).message_text,
  extrait: (h.db.prepare("SELECT result_excerpt FROM team_run_steps WHERE run_id = ? AND step_id = 'collecte'").get(runId) as { result_excerpt: string | null })
    .result_excerpt,
  precisions: (h.db.prepare("SELECT precisions FROM team_runs WHERE id = ?").get(runId) as { precisions: string }).precisions,
});

// --- Banc : harnais, magasin réel, runner et pré-lancement surchargés -------------------------------------------------------------

interface PreflightSpy extends TeamPreflightPort {
  estimateCalls: Array<{ team: TeamRow; directory: string; rootId: string | null; mode: string; relance?: { runId: string } }>;
  checkCalls: PreflightInput[];
  nextEstimate: EstimateOutcome;
  nextCheck: PreflightOutcome;
}

const PLAN: RunPlan = {
  flow: FLOW,
  flowSha256: "f".repeat(64),
  estimate: { typique: 0.2, maximum: 0.6, plafond: 0.6, etapesFacturees: 3, depassementUnAppel: 0.05, relais: 0.01, parEtape: [] },
  estimateSha256: SHA,
  plafond: 0.6,
  rootId: null,
  directory: "/workspace",
  modeUi: "avance",
  agentConversation: "build",
  iaConversation: null,
  etapes: [],
};

function preflightSpy(): PreflightSpy {
  const spy: PreflightSpy = {
    estimateCalls: [],
    checkCalls: [],
    nextEstimate: {
      ok: true,
      response: {
        estimate: PLAN.estimate,
        estimateSha256: SHA,
        problems: [],
        plafond: 0.6,
        confirmations: [],
        blocage: null,
        expireA: 0,
        deja: null,
      },
    },
    nextCheck: { ok: true, plan: PLAN },
    assistants: async () => new Map(),
    estimate: async (team, body, mode, relance) => {
      spy.estimateCalls.push({ team, directory: body.directory, rootId: body.rootId, mode, ...(relance ? { relance } : {}) });
      return spy.nextEstimate;
    },
    check: async (input) => {
      spy.checkCalls.push(input);
      return spy.nextCheck;
    },
    recheck: async () => ({ ok: true }),
  };
  return spy;
}

interface RunnerState {
  store: TeamStore | null;
  db: DatabaseSync | null;
  /** Étapes que l'ordonnanceur lancerait au prochain tour (file du runner). */
  file: string[];
  stopping: boolean;
  stepsBusy: boolean;
}

interface Bench {
  h: CockpitHarness;
  store: TeamStore;
  trace: string[];
  runner: RunnerState;
  preflight: PreflightSpy;
  /** Tour d'ordonnanceur : lance la première étape de la file, sauf si l'arrêt a déjà été annoncé (D-eq-05). */
  pump(runId: string, rootId: string): Promise<void>;
}

/**
 * Runner de test adossé au VRAI magasin : `activeRunOf` et `stepOf` lisent la base, `stopRequested` annule les étapes non
 * lancées, `stopped` enregistre l'état final (« plafond » si la cause est mémorisée en base, sinon « arretee »), `interrupt`
 * passe les étapes qui travaillent en « interrompue ».
 */
async function bench(t: TestContext, options: CockpitHarnessOptions & { extraRunner?: Partial<TeamRunnerPort> } = {}): Promise<Bench> {
  const state: RunnerState = { store: null, db: null, file: [], stopping: false, stepsBusy: false };
  const trace: string[] = [];
  const preflight = preflightSpy();
  const storeOf = (): TeamStore => {
    assert.ok(state.store, "magasin non prêt");
    return state.store;
  };
  const runOfRoot = (rootId: string) => storeOf().runs.activeOfRoot(rootId)[0] ?? null;
  const runner: TeamRunnerPort = {
    ...neutralRunner(),
    activeRunOf: (rootId) => {
      const row = runOfRoot(rootId);
      return row === null ? null : { runId: row.id, state: row.state };
    },
    stepOf: (sessionId) => stepBySession(state, sessionId),
    view: (runId) => storeOf().runs.view(runId),
    stepsBusy: () => state.stepsBusy,
    stopRequested: (rootId, cause) => {
      trace.push(`stopRequested ${cause}`);
      state.stopping = true;
      const row = runOfRoot(rootId);
      if (row === null) return;
      for (const s of storeOf().steps.ofRun(row.id)) {
        if (s.state === "prevue" || s.state === "en-file") storeOf().steps.setState({ runId: row.id, stepId: s.step_id, tour: s.tour, tentative: s.tentative }, "non-lancee");
      }
    },
    stopped: (rootId, cause, result) => {
      trace.push(`stopped ${cause} ${result === null ? "échec" : "fait"}`);
      const row = runOfRoot(rootId);
      if (row === null) return;
      for (const s of storeOf().steps.ofRun(row.id)) {
        if (s.state === "en-cours" || s.state === "attente-accord") storeOf().steps.setState({ runId: row.id, stepId: s.step_id, tour: s.tour, tentative: s.tentative }, "arretee");
      }
      // Cause mémorisée par stopForCap avant l'arrêt (team_runs.cause) : l'équipe est « arrêtée au plafond », pas « arrêtée par vous ».
      const plafond = row.cause === "plafond";
      storeOf().runs.setState(row.id, plafond ? "plafond" : "arretee", { cause: plafond ? "plafond" : cause === "vous" ? "vous" : "equipe" });
    },
    interrupt: (runId, cause) => {
      trace.push(`interrupt ${runId} ${cause}`);
      const store = storeOf();
      for (const s of store.steps.ofRun(runId)) {
        if (s.state === "en-cours" || s.state === "attente-accord") store.steps.setState({ runId, stepId: s.step_id, tour: s.tour, tentative: s.tentative }, "interrompue");
      }
      store.runs.setState(runId, "interrompue", { cause });
    },
    relaunch: async (runId, plan) => {
      trace.push(`relaunch ${plan.estimateSha256}`);
      storeOf().runs.setState(runId, "preparation");
      return storeOf().runs.view(runId) as TeamRunView;
    },
    close: (runId) => {
      trace.push("close");
      storeOf().runs.setState(runId, "arretee", { cause: "vous" });
      return storeOf().runs.view(runId) as TeamRunView;
    },
    addResults: async (runId) => {
      trace.push("addResults");
      storeOf().runs.patch(runId, { resultMessageId: "msg_resultats" });
      return { messageId: "msg_resultats" };
    },
    ...options.extraRunner,
  };
  const h = await startCockpit(t, {
    ...options,
    equipes: options.equipes ?? ["teamRunner", "teamGuards"],
    // `guards` n'est JAMAIS surchargé : c'est le module réel (L37c) qui est éprouvé ici.
    eqPorts: { runner, preflight, ...options.eqPorts },
  });
  state.store = createTeamStore({ db: h.db });
  state.db = h.db;
  const pump = async (runId: string, rootId: string): Promise<void> => {
    const stepId = state.file[0];
    if (stepId === undefined) return;
    if (state.stopping) {
      trace.push(`file refusée (${stepId})`);
      return;
    }
    state.file.shift();
    trace.push(`prompt_async ${stepId}`);
    await h.deps.client.request("POST", `/session/${rootId}/prompt_async`, { body: { agent: "build", model: MODEL, parts: [{ type: "text", text: stepId }] } });
    state.store?.steps.setState({ runId, stepId, tour: 1, tentative: 1 }, "en-cours");
  };
  return { h, store: state.store, trace, runner: state, preflight, pump };
}

/** Étape d'équipe d'une session : le runner de test tient lieu de L37b et lit la colonne session_id (migration 4). */
function stepBySession(state: RunnerState, sessionId: string): { runId: string; stepId: string } | null {
  const row = state.db?.prepare("SELECT run_id, step_id FROM team_run_steps WHERE session_id = ? LIMIT 1").get(sessionId) as
    | { run_id: string; step_id: string }
    | undefined;
  return row ? { runId: row.run_id, stepId: row.step_id } : null;
}

// --- Sessions ---------------------------------------------------------------------------------------------------------------------

async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Session d'étape créée par le serveur (hors proxy, comme le fera le runner) : un arrêt de la racine ne l'arrête pas (ME-6). */
async function stepSession(h: CockpitHarness, rootId: string, titre: string): Promise<FakeSession> {
  const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: rootId, title: titre } });
  await until(() => h.sessions.get(child.id)?.root_id === rootId);
  return child;
}

const send = (h: CockpitHarness, sessionId: string, text = "Bonjour") =>
  h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, { headers: h.headers.mutating, body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] } });

const erreur = (res: { json<T>(): T }) => res.json<{ error: string; message: string }>();

/**
 * Routes des assistants, des niveaux d'IA et du Studio (celles de main.ts), avec un Studio simulé complet : le réalignement et
 * l'installation vont jusqu'au bout. Même prédicat de garde que main.ts (`cockpit.c11.reloadBusy()` lu à l'appel) : c'est lui qui
 * lit le prédicat composé par les équipes (constat 13, D-eq-06). `ready(h)` est appelé juste après le démarrage du harnais.
 */
function studioHarness(): { deps: CockpitHarnessOptions["deps"]; ready(h: CockpitHarness): void } {
  const ref: { h?: CockpitHarness } = {};
  const saved = new Map<string, unknown>();
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown> }) => {
      const item = { kind, name: input.name, scope: "global", project: null, file: `${kind}/${input.name}.md`, frontmatter: input.frontmatter, body: "x", error: null, files: [], updatedAt: Date.now() };
      saved.set(`${kind}/${input.name}`, item);
      return item;
    },
    remove: async () => true,
    get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  const deps: CockpitHarnessOptions["deps"] = (base: AppDeps) => {
    const assistants = new AssistantService({
      db: base.db,
      env: base.env,
      client: base.client,
      studio,
      lookup: base.lookup,
      tiers: base.tiers as TierService,
      ledger: base.ledger,
      settings: base.settings,
      catalog: base.catalog,
      projects: base.projects,
      hub: base.hub,
      log: base.log,
      queue: base.configQueue as ConfigWriteQueue,
      reloadBusy: () => ref.h?.cockpit.c11.reloadBusy() ?? false,
    });
    const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
    return { studio, assistants, routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)] };
  };
  return {
    deps,
    ready: (h) => {
      ref.h = h;
    },
  };
}

// --- 1. Verrous du proxy (D-eq-04) -------------------------------------------------------------------------------------------

describe("L37c : verrou du proxy (D-eq-04, D-eq-16)", () => {
  it("envoi vers la racine refusé pendant l'équipe, permis dès qu'elle est terminée, interrompue ou au plafond", async (t) => {
    const b = await bench(t);
    const root = await trackedRoot(b.h, "Revue SQL");
    const enCours = seedRun(b.store, { rootId: root.id, state: "en-cours" });

    for (const sub of ["prompt_async", "command", "summarize"]) {
      const before = b.h.fake.requests.length;
      const res = await b.h.call("POST", `/api/oc/session/${root.id}/${sub}`, { headers: b.h.headers.mutating, body: { parts: [] } });
      assert.equal(res.status, 409, `${sub} : ${res.body}`);
      assert.deepEqual(erreur(res), { error: "equipe-en-cours", message: P.verrous.envoi });
      assert.deepEqual(b.h.fake.requests.slice(before), [], `${sub} : rien n'est relayé`);
    }
    assert.equal(P.verrous.envoi, "Une équipe travaille dans cette conversation : attendez sa fin ou arrêtez-la.");

    // Une pause verrouille aussi (attente-*), puis l'équipe finit : les états finaux et arrêtés en chemin ne verrouillent plus.
    assert.equal(b.store.runs.setState(enCours, "attente-verification"), true);
    assert.equal((await send(b.h, root.id)).status, 409);
    assert.equal(b.store.runs.setState(enCours, "arretee", { cause: "vous" }), true);
    for (const state of ["terminee", "interrompue", "plafond"] as const) {
      const runId = seedRun(b.store, { rootId: root.id, state });
      assert.equal(b.store.runs.get(runId)?.state, state);
      const res = await send(b.h, root.id, state);
      assert.equal(res.status, 204, `${state} : ${res.body}`);
    }
    b.h.assertNoGlobalRestart();
  });

  it("session d'étape : envoi, abort, PATCH et DELETE refusés « etape-consultable » ; la lecture reste permise", async (t) => {
    const b = await bench(t);
    const root = await trackedRoot(b.h, "Revue SQL");
    const etape = await stepSession(b.h, root.id, "Collecte");
    seedRun(b.store, { rootId: root.id, state: "en-cours", steps: [{ stepId: "collecte", state: "en-cours", sessionId: etape.id }] });

    const refus: Array<[string, string]> = [
      ["POST", `/api/oc/session/${etape.id}/prompt_async`],
      ["POST", `/api/oc/session/${etape.id}/command`],
      ["POST", `/api/oc/session/${etape.id}/summarize`],
      ["POST", `/api/oc/session/${etape.id}/abort`],
      ["PATCH", `/api/oc/session/${etape.id}`],
      ["DELETE", `/api/oc/session/${etape.id}`],
    ];
    for (const [method, url] of refus) {
      const before = b.h.fake.requests.length;
      const res = await b.h.call(method, url, { headers: b.h.headers.mutating, ...(method === "DELETE" ? {} : { body: { parts: [] } }) });
      assert.equal(res.status, 409, `${method} ${url} : ${res.body}`);
      assert.deepEqual(erreur(res), { error: "etape-consultable", message: P.verrous.consultable });
      assert.deepEqual(b.h.fake.requests.slice(before), [], `${method} ${url} : rien n'est relayé`);
    }
    assert.equal(P.verrous.consultable, "Cette partie du travail d'une équipe se consulte seulement.");

    // Consultation : la transcription d'une étape reste lisible (tiroir de lecture).
    for (const url of [`/api/oc/session/${etape.id}`, `/api/oc/session/${etape.id}/message`]) {
      assert.equal((await b.h.call("GET", url, { headers: b.h.headers.authed })).status, 200, url);
    }
    // « Arrêter » la conversation reste permis pendant l'équipe (c'est le remède), le renommage aussi.
    assert.equal((await b.h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: b.h.headers.mutating })).status, 200);
    assert.equal((await b.h.call("PATCH", `/api/oc/session/${root.id}`, { headers: b.h.headers.mutating, body: { title: "Revue" } })).status, 200);
    b.h.assertNoGlobalRestart();
  });

  it("DELETE de la racine refusé pendant l'équipe (« arrêtez-la avant de la supprimer »), permis ensuite", async (t) => {
    const b = await bench(t);
    const root = await trackedRoot(b.h, "Revue SQL");
    const runId = seedRun(b.store, { rootId: root.id, state: "preparation" });
    const before = b.h.fake.requests.length;
    const refus = await b.h.call("DELETE", `/api/oc/session/${root.id}`, { headers: b.h.headers.mutating });
    assert.equal(refus.status, 409, refus.body);
    assert.deepEqual(erreur(refus), { error: "equipe-en-cours", message: P.verrous.suppression });
    assert.equal(P.verrous.suppression, "Une équipe travaille dans cette conversation : arrêtez-la avant de la supprimer.");
    assert.deepEqual(b.h.fake.requests.slice(before), []);
    assert.equal(b.store.runs.setState(runId, "arretee", { cause: "vous" }), true);
    assert.equal((await b.h.call("DELETE", `/api/oc/session/${root.id}`, { headers: b.h.headers.mutating })).status, 200);
    b.h.assertNoGlobalRestart();
  });

  it("réponse d'autorisation d'une session d'étape : « doom_loop » relayée, toute autre permission refusée", async (t) => {
    const b = await bench(t);
    const root = await trackedRoot(b.h, "Revue SQL");
    const etape = await stepSession(b.h, root.id, "Collecte");
    seedRun(b.store, { rootId: root.id, state: "en-cours", steps: [{ stepId: "collecte", state: "en-cours", sessionId: etape.id }] });
    const wait = b.h.db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at) VALUES (?, ?, ?, ?, 1)");
    wait.run("per_doom", etape.id, root.id, "doom_loop");
    wait.run("per_read", etape.id, root.id, "read");
    wait.run("per_racine", root.id, root.id, "bash");

    const refus = await b.h.call("POST", "/api/oc/permission/per_read/reply", { headers: b.h.headers.mutating, body: { reply: "once" } });
    assert.equal(refus.status, 409, refus.body);
    assert.deepEqual(erreur(refus), { error: "etape-consultable", message: P.verrous.consultable });
    // doom_loop d'une étape et demande de la racine : le verrou laisse passer, la vérification « once » de la 1.1 reprend la main.
    for (const id of ["per_doom", "per_racine"]) {
      const res = await b.h.call("POST", `/api/oc/permission/${id}/reply`, { headers: b.h.headers.mutating, body: { reply: "once" } });
      assert.notEqual(erreur(res).error, "etape-consultable", `${id} : ${res.body}`);
    }
    b.h.assertNoGlobalRestart();
  });

  it("port du verrou appelé directement : seule la suppression des Archives est gardée, les autres entrées passent", async (t) => {
    const b = await bench(t);
    seedRun(b.store, { rootId: "ses_archive", state: "en-cours" });
    const guard = b.h.cockpit.equipes.eq.ports.guards.proxyGuard;
    const requete = (patch: Partial<TeamProxyGuardRequest>): TeamProxyGuardRequest => ({
      entree: "archive",
      method: "DELETE",
      sub: "",
      directory: null,
      sessionId: "ses_archive",
      permissionId: null,
      ...patch,
    });
    assert.equal((await guard(requete({})))?.status, 409);
    // Le middleware de T4 ne garde que DELETE ; le verrou le redit, pour qu'une autre méthode ne bloque jamais une lecture.
    for (const method of ["GET", "POST", "PATCH"]) assert.equal(await guard(requete({ method })), null, method);
    assert.equal(await guard(requete({ sessionId: null })), null, "identifiant absent");
    assert.equal(await guard(requete({ sessionId: "ses_libre" })), null, "racine sans équipe");
  });

  it("racine sans équipe : aucune différence avec la 1.1 (envoi, abort, suppression, réponse)", async (t) => {
    const scenario = async (h: CockpitHarness): Promise<unknown[]> => {
      const out: unknown[] = [];
      const root = await trackedRoot(h, "Sans équipe");
      const sent = await send(h, root.id);
      out.push(["envoi", sent.status]);
      out.push(["abort", (await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating })).status]);
      const reply = await h.call("POST", "/api/oc/permission/per_inconnue/reply", { headers: h.headers.mutating, body: { reply: "once" } });
      out.push(["réponse", reply.status, erreur(reply).error]);
      out.push(["suppression", (await h.call("DELETE", `/api/oc/session/${root.id}`, { headers: h.headers.mutating })).status]);
      return out;
    };
    const avec = await bench(t);
    const sans = await startCockpit(t, { equipes: [] });
    assert.deepEqual(await scenario(avec.h), await scenario(sans));
    assert.deepEqual((await scenario(sans))[0], ["envoi", 204]);
    avec.h.assertNoGlobalRestart();
  });
});

// --- 2. Verrou des Archives (D-eq-04, spéc. §3.13 l.425 et §3.5) ---------------------------------------------------------------

describe("L37c : verrou des Archives, aucune purge pendant une équipe", () => {
  it("DELETE /api/archive/:racine pendant « en-cours » et « attente-verification » : 409, ligne d'archive et textes intacts ; après « terminee » : 200 et purge", async (t) => {
    const b = await bench(t);
    const rootId = "ses_archivee";
    seedConversation(b.h, rootId);
    const runId = seedRun(b.store, { rootId, state: "en-cours" });
    b.store.runs.patch(runId, { precisions: ["Voir la table des factures"] });
    b.store.steps.patch({ runId, stepId: "collecte", tour: 1, tentative: 1 }, { resultExcerpt: "Deux jointures à revoir" });
    const intacts = teamTexts(b.h, runId);
    assert.ok(intacts.message?.includes(DEMANDE));

    for (const state of ["en-cours", "attente-verification"] as const) {
      if (state !== "en-cours") assert.equal(b.store.runs.setState(runId, state), true);
      const res = await b.h.call("DELETE", `/api/archive/${rootId}`, { headers: b.h.headers.mutating });
      assert.equal(res.status, 409, `${state} : ${res.body}`);
      assert.deepEqual(erreur(res), { error: "equipe-en-cours", message: P.verrous.suppression });
      assert.deepEqual(teamTexts(b.h, runId), intacts, `${state} : aucune purge`);
      assert.equal(b.h.cockpitEvents().some((e) => e.type === "conversation.deleted"), false);
    }

    assert.equal(b.store.runs.setState(runId, "en-cours"), true);
    assert.equal(b.store.runs.setState(runId, "terminee"), true);
    const supprime = await b.h.call("DELETE", `/api/archive/${rootId}`, { headers: b.h.headers.mutating });
    assert.deepEqual([supprime.status, supprime.json()], [200, { deleted: true }]);
    assert.deepEqual(teamTexts(b.h, runId), { conversations: 0, message: null, extrait: null, precisions: "[]" });
    b.h.assertNoGlobalRestart();
  });
});

// --- 3. Arrêt (D-eq-05, spéc. §3.12, honnêteté l.1047) -------------------------------------------------------------------------

describe("L37c : arrêt d'une équipe", () => {
  it("« Arrêter l'équipe » et « Arrêter » : stopRequested AVANT l'arrêt interne, aucune étape lancée ensuite, étapes en file « non-lancee »", async (t) => {
    const trace: string[] = [];
    let pumpPendantArret: (() => Promise<void>) | null = null;
    const inner: StopTreePort = {
      run: async (rootId, cause: StopCause) => {
        trace.push(`arrêt interne ${cause}`);
        // L'ordonnanceur du runner tourne encore pendant l'arrêt : il doit déjà refuser, prévenu par stopRequested (D-eq-05).
        await pumpPendantArret?.();
        return { rootId, rejected: 1, aborted: [rootId], unconfirmed: [], durationMs: 1 };
      },
    };
    const b = await bench(t, { modules: ["stopTree"], ports: { stopTree: inner } });
    b.trace.length = 0;
    const root = await trackedRoot(b.h, "Revue SQL");
    const runId = seedRun(b.store, {
      rootId: root.id,
      state: "en-cours",
      steps: [
        { stepId: "collecte", state: "terminee" },
        { stepId: "analyse", state: "en-cours", sessionId: "ses_etape2" },
        { stepId: "synthese", state: "en-file" },
      ],
    });
    b.runner.file = ["synthese"];
    const before = b.h.fake.requests.length;
    pumpPendantArret = () => b.pump(runId, root.id);
    // Les deux chemins mènent au même arrêt : la route d'équipe et « Arrêter » de la 1.1.
    const stop = await b.h.call("POST", `/api/team-runs/${runId}/stop`, { headers: b.h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.deepEqual([...b.trace, ...trace].sort(), ["arrêt interne equipe", "file refusée (synthese)", "stopRequested equipe", "stopped equipe fait"].sort());
    assert.deepEqual(b.trace, ["stopRequested equipe", "file refusée (synthese)", "stopped equipe fait"]);
    assert.deepEqual(trace, ["arrêt interne equipe"]);
    assert.equal(b.trace.indexOf("stopRequested equipe") < b.trace.indexOf("stopped equipe fait"), true);
    assert.deepEqual(
      b.h.fake.requests.slice(before).filter((r) => r.pathname.endsWith("/prompt_async")),
      [],
      "aucun prompt_async après l'arrêt, même pour une étape en file",
    );
    const vue = stop.json<TeamRunView>();
    assert.deepEqual(
      [vue.state, vue.cause, ...vue.steps.map((s) => `${s.stepId}:${s.state}`)],
      ["arretee", "equipe", "collecte:terminee", "analyse:arretee", "synthese:non-lancee"],
    );
    // Deuxième arrêt : le lancement n'est plus actif (état final), la route le dit sans rien arrêter.
    const encore = await b.h.call("POST", `/api/team-runs/${runId}/stop`, { headers: b.h.headers.mutating });
    assert.deepEqual([encore.status, erreur(encore).error], [409, "etat-incompatible"]);
    b.h.assertNoGlobalRestart();
  });

  it("arrêt réel sur le faux : la racine et la session d'étape sont arrêtées, aucune session occupée (GET /session/status)", async (t) => {
    const b = await bench(t, { modules: ["stopTree"] });
    const root = await trackedRoot(b.h, "Revue SQL");
    const etape = await stepSession(b.h, root.id, "Analyse");
    b.h.fake.script(etape.id, { tools: [{ tool: "read", input: { filePath: "/workspace/eq/factures.sql" }, beforeAsk: () => new Promise(() => undefined) }], stepMs: 1 });
    await b.h.deps.client.request("POST", `/session/${etape.id}/prompt_async`, { body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Analyse" }] } });
    await until(() => b.h.fake.statusOf(etape.id).type === "busy");
    const runId = seedRun(b.store, {
      rootId: root.id,
      state: "en-cours",
      steps: [
        { stepId: "collecte", state: "terminee" },
        { stepId: "analyse", state: "en-cours", sessionId: etape.id },
        { stepId: "synthese", state: "prevue" },
      ],
    });

    const stop = await b.h.call("POST", `/api/team-runs/${runId}/stop`, { headers: b.h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    // ME-6 : un arrêt de la racine n'arrête pas les sessions créées par le serveur — stopTree (L1c) les arrête toutes.
    assert.deepEqual(await b.h.deps.client.request("GET", "/session/status"), {});
    assert.deepEqual(stop.json<TeamRunView>().steps.map((s) => `${s.stepId}:${s.state}`), ["collecte:terminee", "analyse:arretee", "synthese:non-lancee"]);
    b.h.assertNoGlobalRestart();
  });
});

// --- 4. Plafond d'arrêt (§6 l.1036) --------------------------------------------------------------------------------------------

describe("L37c : plafond d'arrêt", () => {
  it("usage.updated au-dessus du plafond : demande en attente refusée puis arrêts, état « plafond », cause mémorisée avant l'arrêt", async (t) => {
    const b = await bench(t, { modules: ["stopTree"] });
    const root = await trackedRoot(b.h, "Revue SQL");
    const etape = await stepSession(b.h, root.id, "Analyse");
    b.h.fake.script(etape.id, {
      tools: [{ tool: "read", input: { filePath: "/workspace/eq/factures.sql" }, ask: { permission: "read", patterns: ["*"] } }],
      stepMs: 1,
    });
    await b.h.deps.client.request("POST", `/session/${etape.id}/prompt_async`, { body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Analyse" }] } });
    const asked = (await b.h.fake.waitForEvent("permission.asked", (p) => p.sessionID === etape.id)).properties as unknown as FakePermissionRequest;

    const runId = seedRun(b.store, {
      rootId: root.id,
      state: "en-cours",
      plafond: 0.5,
      steps: [
        { stepId: "collecte", state: "terminee" },
        { stepId: "analyse", state: "attente-accord", sessionId: etape.id },
      ],
    });
    b.h.db
      .prepare("INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?)")
      .run("msg_1", etape.id, root.id, Date.now(), 0.52);
    assert.ok(b.store.spentOfRun(runId) >= 0.5);

    b.h.hub.cockpit("usage.updated", { sessionId: etape.id, rootId: root.id, monthSpentUsd: 3, percent: 12 });
    await until(() => b.store.runs.get(runId)?.state === "plafond");
    // Séquence de l'arrêt unique : la demande en attente est refusée, puis les sessions sont arrêtées (spéc. §6 l.1036).
    assert.deepEqual(await b.h.deps.client.request("GET", "/permission"), [], `demande ${asked.id} laissée en attente`);
    assert.deepEqual(await b.h.deps.client.request("GET", "/session/status"), {});
    const run = b.store.runs.get(runId);
    assert.deepEqual([run?.state, run?.cause], ["plafond", "plafond"]);
    // Cause mémorisée AVANT l'arrêt (team_runs.cause) et événement d'audit, sans aucun texte de message.
    const evenements = b.store.events.ofRun(runId).map((e) => [e.kind, e.par, JSON.parse(e.data) as Record<string, unknown>]);
    assert.deepEqual(evenements, [["plafond", "cockpit", { depense: 0.52, plafond: 0.5 }]]);
    assert.equal(
      remplir(P.cartes.plafond, { depense: 0.52, plafond: 0.5 }),
      "Équipe arrêtée : plafond d'arrêt atteint (0,52 $ sur 0,50 $). Un appel en cours peut l'avoir dépassé ; GitHub Copilot peut facturer un appel interrompu.",
    );

    // Un second usage.updated n'arrête pas deux fois (le lancement n'est plus actif) ; sans plafond, rien ne se déclenche.
    const avant = b.h.fake.requests.length;
    b.h.hub.cockpit("usage.updated", { sessionId: etape.id, rootId: root.id, monthSpentUsd: 3, percent: 12 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(b.h.fake.requests.slice(avant), []);
    b.h.assertNoGlobalRestart();
  });

  it("au-dessus du plafond : l'arrêt est demandé au nom de l'équipe ; un lancement déjà fini n'est jamais arrêté", async (t) => {
    const arrets: Array<[string, StopCause]> = [];
    const spy: StopTreePort = {
      run: async (rootId, cause) => {
        arrets.push([rootId, cause]);
        return { rootId, rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };
      },
    };
    const b = await bench(t, { modules: [], ports: { stopTree: spy } });
    const runId = seedRun(b.store, { rootId: "ses_cap", state: "en-cours", plafond: 0.3, steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_e1" }] });
    b.h.db
      .prepare("INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?)")
      .run("msg_cap", "ses_e1", "ses_cap", Date.now(), 0.31);
    b.h.hub.cockpit("usage.updated", { sessionId: "ses_e1", rootId: "ses_cap", monthSpentUsd: 2, percent: 8 });
    await until(() => arrets.length > 0);
    assert.deepEqual(arrets, [["ses_cap", "equipe"]], "l'arrêt vient du cockpit, pas de vous");
    await until(() => b.store.runs.get(runId)?.state === "plafond");

    // Le port est aussi appelable par le runner : sur un lancement fini, il n'arrête rien et n'écrit rien.
    arrets.length = 0;
    const evenements = b.store.events.ofRun(runId).length;
    await b.h.cockpit.equipes.eq.ports.guards.stopForCap(runId);
    await b.h.cockpit.equipes.eq.ports.guards.stopForCap(randomUUID());
    assert.deepEqual(arrets, []);
    assert.equal(b.store.events.ofRun(runId).length, evenements);
  });

  it("sous le plafond, sans plafond, ou sans équipe active : aucun arrêt", async (t) => {
    const arrets: Array<[string, StopCause]> = [];
    const spy: StopTreePort = {
      run: async (rootId, cause) => {
        arrets.push([rootId, cause]);
        return { rootId, rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };
      },
    };
    const b = await bench(t, { modules: [], ports: { stopTree: spy } });
    const root = await trackedRoot(b.h, "Revue SQL");
    const usage = b.h.db.prepare(
      "INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?)",
    );
    const sous = seedRun(b.store, { rootId: root.id, state: "en-cours", plafond: 5, steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_e1" }] });
    usage.run("msg_sous", "ses_e1", root.id, Date.now(), 0.2);
    b.h.hub.cockpit("usage.updated", { sessionId: "ses_e1", rootId: root.id, monthSpentUsd: 1, percent: 4 });
    // Sans rootId (rattrapage) : rien n'est décidé ; sans équipe active non plus.
    b.h.hub.cockpit("usage.updated", { monthSpentUsd: 1, percent: 4 });
    b.h.hub.cockpit("usage.updated", { sessionId: "ses_e1", rootId: "ses_inconnue", monthSpentUsd: 1, percent: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(arrets, []);
    assert.equal(b.store.runs.get(sous)?.state, "en-cours");

    // Plafond absent (colonne nulle) : le cockpit n'invente aucun arrêt.
    b.store.runs.patch(sous, { plafond: null });
    usage.run("msg_gros", "ses_e1", root.id, Date.now(), 9);
    b.h.hub.cockpit("usage.updated", { sessionId: "ses_e1", rootId: root.id, monthSpentUsd: 10, percent: 40 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(arrets, []);
    b.h.assertNoGlobalRestart();
  });
});

// --- 5. Rechargement d'opencode (§3.11) ----------------------------------------------------------------------------------------

describe("L37c : rechargement d'opencode", () => {
  it("global.disposed pendant une étape : équipe « interrompue » ; une équipe en pause n'est jamais interrompue", async (t) => {
    const b = await bench(t);
    const travaille = seedRun(b.store, { rootId: "ses_r1", state: "en-cours", steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_e1" }] });
    const accord = seedRun(b.store, { rootId: "ses_r2", state: "en-cours", steps: [{ stepId: "collecte", state: "attente-accord", sessionId: "ses_e2" }] });
    const pause = seedRun(b.store, { rootId: "ses_r3", state: "attente-verification", steps: [{ stepId: "collecte", state: "terminee" }] });
    const file = seedRun(b.store, { rootId: "ses_r4", state: "en-cours", steps: [{ stepId: "collecte", state: "en-file" }] });

    b.h.fake.emitGlobalDisposed();
    await until(() => b.store.runs.get(travaille)?.state === "interrompue");
    await until(() => b.store.runs.get(accord)?.state === "interrompue");
    assert.deepEqual(
      [b.store.runs.get(travaille)?.cause, b.store.runs.get(pause)?.state, b.store.runs.get(file)?.state],
      ["rechargement", "attente-verification", "en-cours"],
      "jamais « interrompue » pour une équipe en pause ni pour une étape jamais envoyée",
    );
    assert.deepEqual(b.store.steps.ofRun(travaille).map((s) => s.state), ["interrompue", "prevue", "prevue"]);
    b.h.assertNoGlobalRestart();
  });

  it("server.instance.disposed : seules les équipes du dossier libéré sont interrompues", async (t) => {
    const b = await bench(t);
    const ici = seedRun(b.store, { rootId: "ses_ici", state: "en-cours", directory: "/workspace/a", steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_a" }] });
    const ailleurs = seedRun(b.store, {
      rootId: "ses_ailleurs",
      state: "en-cours",
      directory: "/workspace/b",
      steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_b" }],
    });
    b.h.fake.emitInstanceDisposed("/workspace/a");
    await until(() => b.store.runs.get(ici)?.state === "interrompue");
    assert.equal(b.store.runs.get(ailleurs)?.state, "en-cours");
    b.h.assertNoGlobalRestart();
  });

  it("dérogation Avancé du Studio : 200 malgré l'étape, puis équipe « interrompue » et [Relancer la suite] ré-estimée", async (t) => {
    const studio = studioHarness();
    const b = await bench(t, { settings: { ui: { mode: "avance" } }, deps: studio.deps });
    studio.ready(b.h);
    b.runner.stepsBusy = true;
    const runId = seedRun(b.store, { rootId: "ses_studio", state: "en-cours", steps: [{ stepId: "collecte", state: "en-cours", sessionId: "ses_e1" }] });
    // Sans confirmation la garde refuse ; avec x-cockpit-confirm en Avancé, le Studio passe (décision existante de la 1.1).
    assert.equal((await b.h.call("DELETE", "/api/studio/agents/essai", { headers: b.h.headers.mutating })).status, 409);
    assert.equal((await b.h.call("DELETE", "/api/studio/agents/essai", { headers: b.h.headers.confirmed })).status, 200);

    b.h.fake.emitGlobalDisposed();
    await until(() => b.store.runs.get(runId)?.state === "interrompue");
    assert.deepEqual(b.store.steps.ofRun(runId).map((s) => `${s.step_id}:${s.state}`), ["collecte:interrompue", "analyse:prevue", "synthese:prevue"]);
    const estimation = await b.h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: b.h.headers.mutating, body: {} });
    assert.equal(estimation.status, 200, estimation.body);
    assert.deepEqual(b.preflight.estimateCalls.map((call) => [call.directory, call.rootId, call.mode, call.relance?.runId]), [["/workspace", "ses_studio", "avance", runId]]);
    b.h.assertNoGlobalRestart();
  });
});

// --- 6. Garde de rechargement composée (§3.11, constat 13) ---------------------------------------------------------------------

describe("L37c : garde de rechargement (Studio, redémarrage, réalignement)", () => {
  it("409 pendant une étape et entre deux étapes, 200 une fois l'équipe finie ou en pause", async (t) => {
    const studio = studioHarness();
    const b = await bench(t, { settings: { ui: { mode: "avance" } }, deps: studio.deps });
    studio.ready(b.h);
    // Le réalignement passe par la garde propre d'AssistantService, lue par le prédicat du harnais comme par main.ts (constat 13).
    const etats = async () => [
      (await b.h.call("POST", "/api/ai/realign", { headers: b.h.headers.confirmed, body: {} })).status,
      (await b.h.call("POST", "/api/system/restart-opencode", { headers: b.h.headers.mutating })).status,
      (await b.h.call("DELETE", "/api/studio/agents/essai", { headers: b.h.headers.mutating })).status,
    ];
    // Étape « en-cours » ou « en-file », puis intervalle entre deux étapes : le prédicat du runner reste vrai (D-eq-06).
    b.runner.stepsBusy = true;
    assert.deepEqual(await etats(), [409, 409, 409]);
    const refus = await b.h.call("POST", "/api/ai/realign", { headers: b.h.headers.confirmed, body: {} });
    assert.equal(erreur(refus).error, "sessions-busy", refus.body);
    // Équipe finie ou en pause : le prédicat retombe, les trois routes repassent.
    b.runner.stepsBusy = false;
    assert.deepEqual(await etats(), [200, 200, 200]);
  });
});

// --- 7. Relance, fermeture et ajout des résultats (A4, D-eq-17, D-eq-27) --------------------------------------------------------

/** Lancement interrompu en chemin : une étape terminée, une interrompue, une jamais lancée. */
function seedInterrompu(b: Bench, rootId = "ses_relance"): string {
  const runId = seedRun(b.store, {
    rootId,
    state: "en-cours",
    steps: [
      { stepId: "collecte", state: "terminee", sessionId: "ses_e1", cost: 0.12 },
      { stepId: "analyse", state: "en-cours", sessionId: "ses_e2" },
    ],
  });
  b.h.db
    .prepare("INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?)")
    .run(`msg_${runId}`, "ses_e1", rootId, Date.now(), 0.12);
  b.runner.store?.runs.setState(runId, "interrompue", { cause: "rechargement" });
  b.store.steps.setState({ runId, stepId: "analyse", tour: 1, tentative: 1 }, "interrompue");
  b.store.steps.setState({ runId, stepId: "synthese", tour: 1, tentative: 1 }, "non-lancee");
  return runId;
}

describe("L37c : estimation de la relance", () => {
  it("estime le chemin restant et rend `deja` ; refusée hors des états relançables et en mode Simple", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const runId = seedInterrompu(b);
    const res = await b.h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: b.h.headers.mutating, body: {} });
    assert.equal(res.status, 200, res.body);
    const corps = res.json<{ deja: number; plafond: number; estimate: { typique: number; maximum: number } }>();
    assert.equal(corps.deja, 0.12, "dépense déjà faite par ce lancement (sessions d'étape seulement)");
    assert.deepEqual(b.preflight.estimateCalls.map((call) => [call.team.id, call.team.flow.includes("collecte"), call.directory, call.relance?.runId]), [
      ["revue-sql", true, "/workspace", runId],
    ]);
    assert.equal(
      remplir(P.relance.message, { deja: corps.deja, suite: corps.estimate.typique, plafond: corps.plafond }),
      "Déjà dépensé : 0,12 $. Suite : ≈ 0,20 $, plafond 0,60 $.",
    );

    // État non relançable (une équipe qui travaille) et identifiant inconnu.
    const actif = seedRun(b.store, { rootId: "ses_actif", state: "en-cours" });
    const refus = await b.h.call("POST", `/api/team-runs/${actif}/estimate`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([refus.status, erreur(refus).error], [409, "pas-relancable"]);
    const inconnu = await b.h.call("POST", `/api/team-runs/${randomUUID()}/estimate`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([inconnu.status, erreur(inconnu).error], [404, "not-found"]);
    const invalide = await b.h.call("POST", "/api/team-runs/pas-un-uuid/estimate", { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([invalide.status, erreur(invalide).error], [400, "invalid"]);

    // Mode Simple : les équipes restent fermées tant qu'EQUIPES_SIMPLE_OUVERTES est faux (U1).
    b.h.settings.update({ ui: { mode: "simple" } });
    const ferme = await b.h.call("POST", `/api/team-runs/${runId}/estimate`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([ferme.status, erreur(ferme).error], [403, "equipes-simple-fermees"]);
    b.h.assertNoGlobalRestart();
  });
});

describe("L37c : relance de la suite (zéro requête pour tout refus, A4)", () => {
  it("428 sans confirmation, 409 hors état, 409 estimation périmée, 409 textes purgés : le faux ne reçoit RIEN", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const runId = seedInterrompu(b);
    const corps = { estimateSha256: SHA };
    const requetes = () => b.h.fake.requests.length;

    // 1. Sans x-cockpit-confirm : 428, avant toute décision.
    let avant = requetes();
    const sansConfirmation = await b.h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: b.h.headers.mutating, body: corps });
    assert.deepEqual([sansConfirmation.status, erreur(sansConfirmation).error], [428, "confirmation-requise"]);
    assert.equal(requetes(), avant, "428 : aucune requête à opencode");
    assert.deepEqual(b.preflight.checkCalls, []);

    // 2. Corps invalide (empreinte absente) : 400 sans requête.
    avant = requetes();
    const invalide = await b.h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: b.h.headers.confirmed, body: {} });
    assert.deepEqual([invalide.status, erreur(invalide).error], [400, "invalid"]);
    assert.equal(requetes(), avant);

    // 3. État non relançable : 409 pas-relancable, avec « Rien n'a été envoyé ni facturé. ».
    const actif = seedRun(b.store, { rootId: "ses_actif", state: "en-cours" });
    avant = requetes();
    const horsEtat = await b.h.call("POST", `/api/team-runs/${actif}/relancer`, { headers: b.h.headers.confirmed, body: corps });
    assert.deepEqual([horsEtat.status, erreur(horsEtat).error], [409, "pas-relancable"]);
    assert.equal(erreur(horsEtat).message, `${P.erreurs["pas-relancable"]} ${P.honnetete.rienEnvoye}`);
    assert.equal(requetes(), avant, "pas-relancable : aucune requête à opencode");
    assert.deepEqual(b.preflight.checkCalls, [], "le pré-lancement n'est même pas appelé");

    // 4. Estimation périmée : le refus vient du pré-lancement, qui ne lit rien (check, D-eq-17).
    b.preflight.nextCheck = { ok: false, status: 409, code: "estimation-perimee" };
    avant = requetes();
    const perimee = await b.h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: b.h.headers.confirmed, body: corps });
    assert.deepEqual([perimee.status, erreur(perimee).error], [409, "estimation-perimee"]);
    assert.equal(requetes(), avant, "estimation-perimee : aucune requête à opencode");

    // 5. Textes purgés avec la conversation (D-eq-27) : la demande n'est plus reconstituable.
    b.preflight.nextCheck = { ok: true, plan: PLAN };
    b.preflight.checkCalls.length = 0;
    for (const stepId of ORDRE) b.store.steps.patch({ runId, stepId, tour: 1, tentative: 1 }, { messageText: null });
    avant = requetes();
    const purge = await b.h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: b.h.headers.confirmed, body: corps });
    assert.deepEqual([purge.status, erreur(purge).error], [409, "pas-relancable"]);
    assert.deepEqual(b.preflight.checkCalls, []);
    assert.equal(requetes(), avant, "textes purgés : aucune requête à opencode");
    b.h.assertNoGlobalRestart();
  });

  it("nouvelle tentative acceptée : demande reconstituée, chemin restant et dépense transmis, puis runner.relaunch", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const runId = seedInterrompu(b);
    const res = await b.h.call("POST", `/api/team-runs/${runId}/relancer`, { headers: b.h.headers.confirmed, body: { estimateSha256: SHA } });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json<TeamRunView>().state, "preparation");
    assert.equal(b.preflight.checkCalls.length, 1);
    const input = b.preflight.checkCalls[0] as PreflightInput;
    assert.deepEqual(
      [input.body.demande, input.body.fichiers, input.body.directory, input.body.rootId, input.body.estimateSha256, input.confirmed, input.mode],
      [DEMANDE, FICHIERS, "/workspace", "ses_relance", SHA, true, "avance"],
    );
    assert.deepEqual(input.body.confirmations, { plafond: true }, "confirmations d'origine relues en base");
    assert.deepEqual(input.relance, { runId, restantes: ["analyse", "synthese"], depense: 0.12 });
    assert.deepEqual(b.trace, [`relaunch ${SHA}`]);
    b.h.assertNoGlobalRestart();
  });
});

describe("L37c : fermeture et ajout des résultats", () => {
  it("fermer : permis pour interrompue, echec et plafond ; refusé ensuite", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const runId = seedInterrompu(b);
    const ferme = await b.h.call("POST", `/api/team-runs/${runId}/fermer`, { headers: b.h.headers.mutating, body: {} });
    assert.equal(ferme.status, 200, ferme.body);
    assert.deepEqual([ferme.json<TeamRunView>().state, ferme.json<TeamRunView>().cause], ["arretee", "vous"]);
    const encore = await b.h.call("POST", `/api/team-runs/${runId}/fermer`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([encore.status, erreur(encore).error], [409, "etat-incompatible"]);
    const actif = seedRun(b.store, { rootId: "ses_actif", state: "en-cours" });
    const refus = await b.h.call("POST", `/api/team-runs/${actif}/fermer`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([refus.status, erreur(refus).error], [409, "etat-incompatible"]);
  });

  it("ajouter-resultats : une seule fois, jamais pendant que l'équipe travaille", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const actif = seedRun(b.store, { rootId: "ses_actif", state: "en-cours" });
    const pendant = await b.h.call("POST", `/api/team-runs/${actif}/ajouter-resultats`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([pendant.status, erreur(pendant).error], [409, "etat-incompatible"]);

    const runId = seedInterrompu(b);
    const ajout = await b.h.call("POST", `/api/team-runs/${runId}/ajouter-resultats`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([ajout.status, ajout.json()], [200, { messageId: "msg_resultats" }]);
    assert.equal(b.store.runs.view(runId)?.resultatsAjoutes, true);
    const encore = await b.h.call("POST", `/api/team-runs/${runId}/ajouter-resultats`, { headers: b.h.headers.mutating, body: {} });
    assert.deepEqual([encore.status, erreur(encore).error], [409, "deja-ajoute"]);
    assert.deepEqual(b.trace, ["addResults"]);
    b.h.assertNoGlobalRestart();
  });

  it("toutes les routes d'incident exigent l'anti-CSRF et une session (gardes globales de createApp)", async (t) => {
    const b = await bench(t, { settings: { ui: { mode: "avance" } } });
    const runId = seedInterrompu(b);
    for (const route of ["stop", "estimate", "relancer", "fermer", "ajouter-resultats"]) {
      const url = `/api/team-runs/${runId}/${route}`;
      assert.equal((await b.h.call("POST", url, { headers: b.h.headers.authed, body: {} })).status, 403, `${route} : sans anti-CSRF`);
      assert.equal((await b.h.call("POST", url, { body: {} })).status, 401, `${route} : sans session`);
    }
    assert.deepEqual(b.preflight.checkCalls, []);
    assert.deepEqual(b.trace, []);
  });
});
