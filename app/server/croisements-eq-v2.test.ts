// Tests de croisement du train it4 V2 (plan d'exécution it4 §2.4, §5.2 ; propriété de l'intégrateur). Les cinq paquets de la
// vague ont été écrits en parallèle, sans se lire, et CHACUN a surchargé les ports de ses voisins : L37a (service, exemples,
// routes) surcharge `preflight` ; L37p (pré-lancement) est testé port par port ; L37b (runner) surcharge `preflight`, `teams`
// et `guards` ; L37c (incidents) surcharge `runner` et `preflight` ; L39b (carte) ne monte que des routes de lecture.
// Ce qu'aucun d'eux ne peut donc prouver seul, et que ces tests tiennent sur le câblage RÉEL (les cinq modules, AUCUN
// `eqPorts`), avec le faux opencode :
//   1. AVIS DE BOUT EN BOUT : installation d'un exemple (L37a, assistant du catalogue réellement posé) → estimation (L37p,
//      lectures et empreinte réelles) → lancement (L37b) → quatre sessions d'étape filles de la racine, marquées ETAPE → la
//      synthèse reçoit les trois avis, aucun avis ne voit le travail des autres → résultat injecté en `noReply`,
//      `prompts.kind` posés, aucune ligne `usage` dans la racine → archive rafraîchie ;
//   2. VERROUS RÉELS pendant une équipe qui travaille (L37c × L37b × L37a) : envoi vers la racine, envoi et suppression d'une
//      session d'étape, suppression de la racine et `DELETE /api/archive/:id` → 409 avec les phrases de T4t, consignes
//      gardées, aucune purge ; réalignement, redémarrage d'opencode et installation d'un exemple refusés par la garde de
//      rechargement composée (D-eq-06), aucun fichier d'agent écrit ; « Arrêter » de la 1.1 → équipe `arretee`, plus aucun
//      envoi, et le verrou des Archives rouvre ensuite ;
//   3. ZÉRO REQUÊTE POUR TOUT REFUS (A4, D-eq-17) : le vrai pré-lancement, appelé par le vrai runner, ne laisse partir aucune
//      requête vers opencode pendant `POST …/run` et `POST …/relancer`, pour chaque code (le sondage `GET /session/status` de
//      la 1.1 est hors de compte : il tourne sans qu'aucune route d'équipe le déclenche) ;
//   4. FRAÎCHEUR : une extension configurée ENTRE l'estimation et le lancement donne 202 puis la pause « À vérifier », sans
//      aucune session d'étape, aucun `prompt_async` et aucune injection ;
//   5. MODE SIMPLE : `EQUIPES_SIMPLE_OUVERTES` fausse → les routes d'écriture répondent 403 `equipes-simple-fermees` (ou 404
//      pour une équipe absente), sans aucune requête vers opencode ni aucun fichier d'agent écrit ;
//   6. CARTE (L39b) ↔ ÉQUIPE INSTALLÉE (L37a) : l'équipe est un nœud de la carte, avec l'arête « Vous → équipe » et une arête
//      `etape` par étape, numérotées dans l'ordre de `planSteps` (T4) ;
//   7. P4 et P6 : aucune règle permissive envoyée hors d'une session d'étape ; `assertNoGlobalRestart()` sur tous les
//      scénarios.
// Hors de ce fichier, tenus par les suites des paquets : plafond d'arrêt et `global.disposed` (team-guards.test.ts), reprise
// au démarrage et relance (team-runner.test.ts), parité carte / `deriveAgentMap` (agent-map-service.test.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Hono } from "hono";
import { AssistantService } from "./assistants.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { type AgentMapResult, MAP_VOUS_ID, type MapEdge } from "./shared/agent-map.ts";
import { parseFloorMark } from "./shared/session-floors.ts";
import { planSteps } from "./shared/team-limits.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  TeamEstimateResponse,
  TeamInstallResponse,
  TeamRunStarted,
  TeamRunView,
  TeamsListResponse,
} from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { exampleById, exampleFlow } from "./team-examples.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";

const E = TEXTES.partout;

// --- Banc : tout le cockpit, tous les modules d'équipes, aucun port surchargé ---------------------------------------------------

/** Studio simulé complet : l'installation d'un assistant du catalogue va jusqu'au bout et les fichiers écrits sont comptés. */
function studioEspion(): { studio: StudioService; ecrits: string[] } {
  const saved = new Map<string, unknown>();
  const ecrits: string[] = [];
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown> }) => {
      const item = {
        kind,
        name: input.name,
        scope: "global",
        project: null,
        file: `${kind}/${input.name}.md`,
        frontmatter: input.frontmatter,
        body: "x",
        error: null,
        files: [],
        updatedAt: Date.now(),
      };
      saved.set(`${kind}/${input.name}`, item);
      ecrits.push(`${kind}/${input.name}`);
      return item;
    },
    remove: async () => true,
    get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  return { studio, ecrits };
}

interface Banc extends CockpitHarness {
  /** Sous-dossier du workspace : l'équipe ne travaille pas sur tout le workspace (P9, `confirmation-workspace`). */
  directory: string;
  /** Fichiers écrits par le Studio : un refus de garde n'en laisse aucun. */
  ecrits: string[];
  agentsEcrits(): string[];
  /**
   * Requêtes reçues par le faux depuis le repère posé par `repere()`, SAUF le sondage `GET /session/status` de la 1.1, qui
   * tourne de lui-même dès que le cockpit complet est monté et qu'aucune route d'équipe ne déclenche.
   */
  depuis(repere: number): Array<{ method: string; pathname: string }>;
  repere(): number;
}

/**
 * Cockpit de production : modules 1.1 « tous », les CINQ modules d'équipes réels, AUCUN port d'équipe surchargé. Seuls les
 * délais du runner sont raccourcis (option de test de L37b, jamais une variable lue en production), pour tenir la borne de
 * durée du FIN (§2.2).
 */
async function banc(t: TestContext, options: { settings?: Record<string, unknown> } = {}): Promise<Banc> {
  const { studio, ecrits } = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" }, ...(options.settings ?? {}) },
    modules: "tous",
    equipes: [
      EQ_MODULES.agentMap,
      EQ_MODULES.teams,
      EQ_MODULES.teamPreflight,
      createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }),
      EQ_MODULES.teamGuards,
    ],
    deps: (base) => {
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
      // Routes des assistants et des niveaux d'IA, celles de main.ts : la garde de rechargement de la 1.1 est ainsi la vraie.
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return { studio, assistants, routes: [(app: Hono) => registerAssistantRoutes(app, routeDeps), (app: Hono) => registerAiRoutes(app, routeDeps)] };
    },
  });
  ref.h = h;
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
  return Object.assign(h, {
    directory: `${h.fake.directory}/projet`,
    ecrits,
    agentsEcrits: () => ecrits.filter((fichier) => fichier.startsWith("agents/")),
    repere: () => h.fake.requests.length,
    depuis: (repere: number) =>
      h.fake.requests
        .slice(repere)
        .map((req) => ({ method: req.method, pathname: req.pathname }))
        .filter((req) => !(req.method === "GET" && req.pathname === "/session/status")),
  });
}

/** Déroulé de l'exemple « Revue SQL sur réplica » (trois avis et une synthèse), tel que L37a l'installe. */
const revueSql = (): Flow => {
  const example = exampleById("revue-sql");
  assert.ok(example, "exemple « revue-sql » absent du catalogue de L37a");
  return exampleFlow(example, new Map());
};

const liste = async (h: CockpitHarness): Promise<TeamsListResponse> => {
  const res = await h.call("GET", "/api/teams", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamsListResponse>();
};

/** Règles d'un assistant du catalogue en lecture seule, telles que le faux les rend à `GET /agent`. */
const readOnlyRules = () => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const fakeAgent = (name: string): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant ${name}`,
  model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
  options: {},
  permission: readOnlyRules() as FakeAgent["permission"],
  steps: 20,
});

/** Étapes d'un déroulé, dans l'ordre de `planSteps`. */
function etapesDe(flow: Flow): Array<{ id: string; assistant: string; recoit: string }> {
  const byId = new Map(
    flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : [])).map((step) => [step.id, step]),
  );
  return planSteps(flow).map((planned) => {
    const step = byId.get(planned.stepId);
    assert.ok(step, `étape absente : ${planned.stepId}`);
    return { id: step.id, assistant: step.assistant, recoit: step.recoit };
  });
}

/**
 * Installe l'exemple (L37a écrit les fichiers d'agents par le Studio) et déclare les mêmes assistants au faux opencode, pour
 * que le pré-lancement réel (L37p) les retrouve par `GET /agent` comme sur une vraie installation.
 */
async function installerExemple(h: Banc, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = [...new Set(etapesDe(body.team.flow).map((etape) => etape.assistant))].filter((nom) => !connus.has(nom));
  if (manquants.length > 0) h.fake.setAgents([...h.fake.agents(), ...manquants.map(fakeAgent)]);
  return body;
}

async function estimer(h: Banc, teamId: string, rootId: string | null = null): Promise<TeamEstimateResponse> {
  const res = await h.call("POST", `/api/teams/${teamId}/estimate`, { headers: h.headers.mutating, body: { directory: h.directory, rootId } });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamEstimateResponse>();
}

const DEMANDE = "Relis la requête de facturation du mois dernier.";

/** Vue d'un lancement, lue par la route de L37b (jamais par le port : le croisement passe par l'application). */
async function vue(h: Banc, runId: string): Promise<TeamRunView> {
  const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamRunView>();
}

async function attendre(h: Banc, runId: string, predicat: (view: TeamRunView) => boolean, libelle: string, timeoutMs = 8_000): Promise<TeamRunView> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const courante = await vue(h, runId);
    if (predicat(courante)) return courante;
    if (Date.now() > limite) throw new Error(`${libelle} : état ${courante.state}, étapes ${courante.steps.map((step) => `${step.stepId}=${step.state}`).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** P4 : aucune règle « allow » ou « ask » envoyée à opencode hors du plancher ETAPE d'une session d'étape. */
function assertNoLooseRules(h: Banc): void {
  for (const req of h.fake.requests) {
    const body = req.body as { permission?: unknown; metadata?: { cockpit?: string } } | undefined;
    const rules = body?.permission;
    if (!Array.isArray(rules)) continue;
    if (rules.every((rule) => (rule as { action?: string }).action === "deny")) continue;
    assert.equal(body?.metadata?.cockpit, "equipe", `règles permissives hors d'une session d'étape : ${req.method} ${req.pathname}`);
  }
}

describe("croisement it4 V2 : montage réel des cinq modules", () => {
  it("les cinq modules réels sont installés et leurs routes répondent (aucun port surchargé)", async (t) => {
    const h = await banc(t);
    assert.deepEqual(h.cockpit.equipes.modules, ["agentMap", "teams", "teamPreflight", "teamRunner", "teamGuards"]);
    const vide = await liste(h);
    assert.deepEqual(vide.teams, []);
    assert.equal(vide.ouvertesEnSimple, false);
    assert.deepEqual(
      vide.exemples.map((exemple) => exemple.id),
      ["revue-sql", "relecture-script"],
    );
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    h.assertNoGlobalRestart();
  });

  it("exemple installé par L37a, estimé par L37p : mêmes étapes, empreinte rendue, aucune 409 « à venir »", async (t) => {
    const h = await banc(t);
    const installe = await installerExemple(h, "revue-sql");
    assert.equal(installe.assistantsInstalles.length, 1, "un seul assistant du catalogue posé");
    assert.deepEqual(h.agentsEcrits(), ["agents/relire-requete-sql"]);
    assert.equal(installe.team.id, "revue-sql");
    // L'équipe installée porte EXACTEMENT le déroulé de l'exemple de L37a, dans l'ordre de planSteps (T4).
    assert.deepEqual(
      etapesDe(installe.team.flow).map((etape) => etape.id),
      etapesDe(revueSql()).map((etape) => etape.id),
    );

    const estimation = await estimer(h, "revue-sql");
    assert.equal(estimation.estimateSha256.length, 64);
    assert.deepEqual(estimation.problems, []);
    assert.ok(estimation.expireA > Date.now(), "instantané encore valide");
    h.assertNoGlobalRestart();
  });

  it("avis de bout en bout : estimation de L37p acceptée par L37b, quatre sessions ETAPE filles de la racine, résultat injecté noReply", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    for (const [stepId, texte] of [
      ["exactitude", "Avis exactitude : deux jointures à revoir."],
      ["performance", "Avis performance : ajouter un index."],
      ["donnees-sensibles", "Avis données sensibles : masquer la colonne e-mail."],
      ["synthese", "Synthèse : corriger les jointures puis mesurer."],
    ] as const) {
      h.fake.scriptWhen(
        (session) => (session.metadata as { etape?: string } | undefined)?.etape === stepId,
        { text: texte, cost: 0.01, tokens: { input: 120, output: 40 }, stepMs: 5 },
      );
    }

    const estimation = await estimer(h, "revue-sql");
    assert.equal(estimation.blocage, null, "aucun refus prévisible sur ce banc");
    const started = await h.call("POST", "/api/teams/revue-sql/run", {
      headers: h.headers.mutating,
      body: {
        directory: h.directory,
        rootId: null,
        demande: DEMANDE,
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.estimateSha256,
        confirmations: {},
      },
    });
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const view = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");

    // Une session d'étape par étape du déroulé, toutes filles de la racine et marquées ETAPE (le plancher est calculé par le
    // VRAI pré-lancement, sur les règles réellement lues par `GET /agent`).
    assert.equal(view.steps.length, 4);
    for (const step of view.steps) {
      assert.ok(step.sessionId, `étape ${step.stepId} sans session`);
      const session = h.fake.session(step.sessionId as string);
      assert.equal(session?.parentID, rootId, `parentID de ${step.stepId}`);
      assert.equal(parseFloorMark(h.sessions.get(step.sessionId as string)?.plancher)?.kind, "ETAPE", `marque de ${step.stepId}`);
      assert.equal(step.state, "terminee", `état de ${step.stepId}`);
    }

    // Deux injections `noReply` dans la racine, avec les genres de la 1.1 ; aucune ligne `usage` : rien n'est facturé là.
    const injections = h.fake.requests.filter((req) => req.method === "POST" && req.pathname === `/session/${rootId}/message`);
    assert.equal(injections.length, 2, "demande puis résultat");
    for (const req of injections) assert.equal((req.body as { noReply?: boolean }).noReply, true);
    const kinds = h.db.prepare("SELECT kind FROM prompts WHERE session_id = ? AND kind != 'message' ORDER BY created_at, message_id").all(rootId) as unknown as Array<{
      kind: string;
    }>;
    assert.deepEqual(
      kinds.map((row) => row.kind),
      ["equipe-demande", "equipe-resultat"],
    );
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM usage WHERE session_id = ?").get(rootId) as { n: number }).n, 0);
    const dernier = h.fake.messages(rootId).at(-1);
    const injecte = (dernier?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    assert.ok(injecte.includes("Synthèse : corriger les jointures"), "le résultat de la synthèse est injecté");

    // La synthèse a bien reçu les trois avis, aucun avis n'a vu le travail des autres (spéc. §6 l.1034).
    const texteDe = (stepId: string): string => {
      const step = view.steps.find((candidate) => candidate.stepId === stepId);
      const premier = h.fake.messages(step?.sessionId ?? "")[0];
      return (premier?.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("");
    };
    for (const avis of ["Avis exactitude", "Avis performance", "Avis données sensibles"]) {
      assert.ok(texteDe("synthese").includes(avis), `la synthèse reçoit « ${avis} »`);
    }
    for (const avisId of ["exactitude", "performance", "donnees-sensibles"]) {
      assert.equal(texteDe(avisId).includes("Avis "), false, `l'avis ${avisId} ne voit pas le travail des autres`);
      assert.ok(texteDe(avisId).includes(DEMANDE), `l'avis ${avisId} reçoit la demande`);
    }

    // Archives rafraîchies (la ligne existe) puis classement prévenu sur la racine.
    await until(() => ((h.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?").get(rootId) as { n: number }).n === 1 ? true : undefined), 4_000);
    h.assertNoGlobalRestart();
    assertNoLooseRules(h);
  });
});

// --- 2. Verrous réels pendant une équipe qui travaille (L37c × L37b × L37a) ----------------------------------------------------

describe("croisement it4 V2 : verrous réels, garde de rechargement et arrêt", () => {
  it("équipe en cours : envoi racine, session d'étape, Archives, réalignement, redémarrage et installation refusés ; « Arrêter » de la 1.1 arrête l'équipe", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    // Chaque étape ouvre un outil qui ne rend jamais la main : l'équipe reste « en cours » tant que le test ne l'arrête pas.
    h.fake.scriptWhen((session) => (session.metadata as { cockpit?: string } | undefined)?.cockpit === "equipe", {
      tools: [{ tool: "read", input: { filePath: "/workspace/projet/note.md" }, beforeAsk: () => new Promise<void>(() => undefined) }],
      stepMs: 1,
    });

    const estimation = await estimer(h, "revue-sql");
    const started = await h.call("POST", "/api/teams/revue-sql/run", {
      headers: h.headers.mutating,
      body: {
        directory: h.directory,
        rootId: null,
        demande: DEMANDE,
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.estimateSha256,
        confirmations: {},
      },
    });
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const enCours = await attendre(h, runId, (v) => v.steps.some((step) => step.state === "en-cours" && step.sessionId !== null), "une étape en cours");
    const etape = enCours.steps.find((step) => step.state === "en-cours" && step.sessionId !== null)?.sessionId as string;

    // Verrou du proxy : la racine est verrouillée, la session d'étape est consultable mais jamais pilotable.
    const envoi = { agent: "build", model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "Bonjour" }] };
    const versRacine = await h.call("POST", `/api/oc/session/${rootId}/prompt_async`, { headers: h.headers.mutating, body: envoi });
    assert.deepEqual([versRacine.status, versRacine.json<{ error: string; message: string }>()], [409, { error: "equipe-en-cours", message: E.verrous.envoi }]);
    const versEtape = await h.call("POST", `/api/oc/session/${etape}/prompt_async`, { headers: h.headers.mutating, body: envoi });
    assert.deepEqual([versEtape.status, versEtape.json<{ error: string; message: string }>()], [409, { error: "etape-consultable", message: E.verrous.consultable }]);
    assert.equal((await h.call("DELETE", `/api/oc/session/${etape}`, { headers: h.headers.mutating })).status, 409);
    assert.equal((await h.call("DELETE", `/api/oc/session/${rootId}`, { headers: h.headers.mutating })).status, 409);
    // Lecture toujours permise : le verrou ne ferme que les écritures.
    assert.equal((await h.call("GET", `/api/oc/session/${etape}/message`, { headers: h.headers.authed })).status, 200);

    // Verrou des Archives, AVANT la purge : la conversation et les textes de l'étape restent intacts.
    const archive = await h.call("DELETE", `/api/archive/${rootId}`, { headers: h.headers.mutating });
    assert.deepEqual([archive.status, archive.json<{ error: string; message: string }>()], [409, { error: "equipe-en-cours", message: E.verrous.suppression }]);
    const textes = h.db.prepare("SELECT message_text FROM team_run_steps WHERE run_id = ? AND message_text IS NOT NULL").all(runId) as unknown as Array<{
      message_text: string;
    }>;
    assert.ok(textes.length > 0, "les consignes envoyées sont gardées en base (U2)");
    assert.equal(h.cockpitEvents().some((event) => event.type === "conversation.deleted"), false, "aucune purge derrière le verrou");

    // Garde de rechargement composée (D-eq-06) : réalignement, redémarrage d'opencode et installation d'un exemple refusés.
    const ecritsAvant = [...h.ecrits];
    assert.equal(h.cockpit.c11.reloadBusy(), true, "une étape travaille : le cockpit est occupé");
    assert.equal((await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} })).status, 409);
    assert.equal((await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.mutating })).status, 409);
    const install = await h.call("POST", "/api/teams/examples/relecture-script/install", { headers: h.headers.mutating, body: {} });
    assert.equal(install.status, 409, install.body);
    assert.deepEqual(h.ecrits, ecritsAvant, "aucun fichier d'agent écrit derrière un refus de la garde");

    // « Arrêter » de la 1.1 (route des conversations) : l'équipe passe « arretee » et plus aucune étape ne part.
    const envoisAvant = h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length;
    const stop = await h.call("POST", `/api/conversations/${rootId}/stop`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    const arretee = await attendre(h, runId, (v) => v.state === "arretee", "équipe arrêtée");
    assert.equal(
      arretee.steps.some((step) => step.state === "en-cours"),
      false,
      "aucune étape ne travaille plus",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async")).length, envoisAvant, "aucune étape lancée après l'arrêt");

    // L'équipe finie, le verrou des Archives rouvre : la suppression passe (elle ne rend plus 409).
    const purge = await h.call("DELETE", `/api/archive/${rootId}`, { headers: h.headers.mutating });
    assert.equal(purge.status, 200, purge.body);
    h.assertNoGlobalRestart();
    assertNoLooseRules(h);
  });
});

// --- 3. Zéro requête pour tout refus de lancement et de relance (A4, D-eq-17) ---------------------------------------------------

describe("croisement it4 V2 : aucun refus ne touche opencode", () => {
  it("POST /api/teams/:id/run et POST /api/team-runs/:id/relancer : chaque refus laisse le faux sans la moindre requête", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    const estimation = await estimer(h, "revue-sql");
    const corps = (patch: Record<string, unknown> = {}) => ({
      directory: h.directory,
      rootId: null,
      demande: DEMANDE,
      fichiers: [],
      agentConversation: "build",
      estimateSha256: estimation.estimateSha256,
      confirmations: {},
      ...patch,
    });

    /** Exécute l'appel et échoue si le faux reçoit la moindre requête pendant (A4 : `check` ne lit ni `lookup` ni `client`). */
    const sansRequete = async (libelle: string, appel: () => Promise<{ status: number; body: string }>): Promise<{ status: number; body: string }> => {
      const repere = h.repere();
      const res = await appel();
      assert.deepEqual(h.depuis(repere), [], `${libelle} : requêtes émises pendant un refus`);
      return res;
    };

    const refus = async (libelle: string, patch: Record<string, unknown>, statut: number, code: string) => {
      const res = await sansRequete(libelle, () => h.call("POST", "/api/teams/revue-sql/run", { headers: h.headers.mutating, body: corps(patch) }));
      assert.equal(res.status, statut, `${libelle} : ${res.body}`);
      assert.equal(JSON.parse(res.body).error, code, `${libelle} : ${res.body}`);
    };

    await refus("empreinte inconnue", { estimateSha256: "b".repeat(64) }, 409, "estimation-perimee");
    await refus("corps invalide", { fichiers: "pas un tableau" }, 400, "invalid");
    await refus("dossier hors du workspace", { directory: "/etc" }, 403, "forbidden-directory");
    await refus("assistant de conversation interne", { agentConversation: "cockpit-classifier" }, 400, "invalid");
    await refus("pièce jointe hors du dossier", { fichiers: ["../secret.md"] }, 403, "fichier-refuse");
    const inconnue = await sansRequete("équipe inconnue", () => h.call("POST", "/api/teams/inconnue/run", { headers: h.headers.mutating, body: corps() }));
    assert.equal(inconnue.status, 404, inconnue.body);

    // Relance d'un lancement inconnu : refus local, rien ne part vers opencode.
    const relance = await sansRequete("relance d'un lancement inconnu", () =>
      h.call("POST", "/api/team-runs/00000000-0000-4000-8000-000000000000/relancer", {
        headers: h.headers.mutating,
        body: { estimateSha256: estimation.estimateSha256 },
      }),
    );
    assert.ok([404, 409, 428].includes(relance.status), relance.body);
    h.assertNoGlobalRestart();
  });
});

// --- 3 bis. Contrôle de fraîcheur entre l'estimation et le lancement (D-eq-17) --------------------------------------------------

describe("croisement it4 V2 : changement survenu après l'estimation", () => {
  it("extension configurée entre l'estimation et le lancement : 202 puis pause « À vérifier », aucune injection, aucun envoi d'étape", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    const estimation = await estimer(h, "revue-sql");
    assert.equal(estimation.blocage, null);
    // L'instantané est pris : la configuration change ENSUITE (un serveur MCP apparaît, report MX-EQ, décision n° 14).
    h.fake.globalConfig = { ...h.fake.globalConfig, mcp: { local: { type: "local", command: ["outil"], enabled: true } } };

    const repere = h.repere();
    const started = await h.call("POST", "/api/teams/revue-sql/run", {
      headers: h.headers.mutating,
      body: {
        directory: h.directory,
        rootId: null,
        demande: DEMANDE,
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.estimateSha256,
        confirmations: {},
      },
    });
    // A4 : le lancement est accepté sur l'instantané (202), le changement est vu par le contrôle de fraîcheur, pas par `check`.
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();
    const pause = await attendre(h, runId, (v) => v.state.startsWith("attente-"), "pause après le contrôle de fraîcheur");
    assert.equal(pause.state, "attente-verification", `état de pause : ${pause.state}`);

    // Rien n'est parti : aucune session d'étape, aucun envoi, aucune injection dans la racine.
    const emises = h.depuis(repere);
    assert.equal(
      emises.some((req) => req.pathname.endsWith("/prompt_async")),
      false,
      `envoi malgré le changement : ${emises.map((req) => `${req.method} ${req.pathname}`).join(", ")}`,
    );
    assert.equal(
      emises.some((req) => req.method === "POST" && req.pathname === `/session/${rootId}/message`),
      false,
      "aucune injection dans la racine",
    );
    assert.equal(
      h.fake.requests.some((req) => req.method === "POST" && req.pathname === "/session" && (req.body as { metadata?: { cockpit?: string } })?.metadata?.cockpit === "equipe"),
      false,
      "aucune session d'étape créée",
    );
    assert.equal(
      pause.steps.every((step) => step.state === "prevue" || step.state === "non-lancee"),
      true,
      `étapes : ${pause.steps.map((step) => `${step.stepId}=${step.state}`).join(", ")}`,
    );
    h.assertNoGlobalRestart();
  });
});

// --- 4. Mode Simple fermé (U1, D-eq-13) ----------------------------------------------------------------------------------------

describe("croisement it4 V2 : équipes fermées en mode Simple", () => {
  it("les routes d'écriture répondent 403 « equipes-simple-fermees », sans requête ni fichier d'agent", async (t) => {
    const h = await banc(t, { settings: { ui: { mode: "simple" } } });
    const repere = h.repere();
    const ecrits = [...h.ecrits];
    const appels: Array<[string, string, unknown]> = [
      ["PUT", "/api/teams/essai", { titre: "Essai", description: "", flow: revueSql() }],
      ["POST", "/api/teams/examples/revue-sql/install", {}],
      ["POST", "/api/teams/revue-sql/estimate", { directory: h.directory, rootId: null }],
      [
        "POST",
        "/api/teams/revue-sql/run",
        {
          directory: h.directory,
          rootId: null,
          demande: DEMANDE,
          fichiers: [],
          agentConversation: "build",
          estimateSha256: "0".repeat(64),
          confirmations: {},
        },
      ],
      ["POST", "/api/team-runs/00000000-0000-4000-8000-000000000000/estimate", { directory: h.directory }],
      ["POST", "/api/team-runs/00000000-0000-4000-8000-000000000000/relancer", { estimateSha256: "0".repeat(64) }],
    ];
    const codes: string[] = [];
    for (const [method, url, body] of appels) {
      const res = await h.call(method ?? "", url ?? "", { headers: h.headers.confirmed, body });
      codes.push(`${url} ${res.status} ${(JSON.parse(res.body) as { error?: string }).error ?? ""}`);
    }
    // Les routes qui désignent une équipe ou un lancement inexistant répondent 404 avant le mode ; toutes les autres sont fermées.
    for (const ligne of codes) assert.match(ligne, /40[34] (equipes-simple-fermees|not-found)/, ligne);
    assert.ok(
      codes.filter((ligne) => ligne.includes("equipes-simple-fermees")).length >= 2,
      `les routes accessibles en Simple sont fermées : ${codes.join(" | ")}`,
    );
    assert.deepEqual(h.depuis(repere), [], "aucune requête vers opencode derrière un refus");
    assert.deepEqual(h.ecrits, ecrits, "aucun fichier d'agent écrit derrière un refus");
    assert.equal((await liste(h)).ouvertesEnSimple, false);
    h.assertNoGlobalRestart();
  });
});

// --- 5. Carte des assistants (L39b) ↔ équipe installée (L37a) -------------------------------------------------------------------

describe("croisement it4 V2 : carte des assistants et équipe installée", () => {
  it("l'équipe installée apparaît dans la carte, une arête par étape, et la carte est exactement celle du module pur", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    const res = await h.call("GET", `/api/agent-map?directory=${encodeURIComponent(h.directory)}`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const carte = res.json<AgentMapResult>();

    // Une arête « étape » par étape du déroulé installé, numérotées dans l'ordre de planSteps (T4).
    const etapes = carte.edges.filter((edge: MapEdge) => edge.etape !== undefined);
    assert.equal(etapes.length, etapesDe(revueSql()).length, "une arête par étape");
    assert.deepEqual(
      etapes.map((edge) => edge.etape?.numero),
      etapesDe(revueSql()).map((_, index) => index + 1),
    );

    // Le nœud de l'équipe installée est bien dans la carte, avec l'arête « Vous → équipe ».
    const equipe = carte.nodes.find((node) => node.kind === "equipe");
    assert.ok(equipe, `aucun nœud d'équipe : ${carte.nodes.map((node) => node.kind).join(", ")}`);
    assert.ok(
      carte.edges.some((edge) => edge.from === MAP_VOUS_ID && edge.to === equipe.id),
      "arête « Vous → équipe »",
    );
    h.assertNoGlobalRestart();
  });
});
