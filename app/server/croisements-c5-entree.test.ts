// Tests de croisement de la FUSION D'ENTRÉE FE4 (plan d'exécution it5 §2.4, §5.3 ligne « 5b V0 », fiche FE4 ; propriété de
// l'intégrateur). Ils portent sur la rencontre de DEUX branches qui ne se sont jamais lues : la construction (itération 5a,
// méthodes, Seconde lecture, chronologie, coûts et archives par équipe) et les équipes (itération 4, relue à H4).
//
// Ce qu'aucune des deux branches ne pouvait prouver seule, et que ce fichier établit sur le cockpit COMPLET (les quatre
// modules de la construction ET les cinq modules d'équipes, avec le faux opencode) :
//   1. les deux exemples d'équipe de l'it4 passent la grammaire de l'it4 (`validateFlow`) avec les assistants que leur
//      installation pose : la construction n'a rien cassé de la grammaire ;
//   2. chacun des QUATRE assistants d'équipe du catalogue de la construction (L45a, `role: "equipier"`) est accepté comme
//      étape par cette même grammaire — aucun problème `delegue`, `internet` ni `autorise-sans-demander`. Les deux branches
//      l'ignoraient : l'it4 ne connaît pas ces quatre entrées, et la construction ne connaît pas `validateFlow` ;
//   3. un lancement RÉEL de l'it4 sur le faux opencode produit des lignes `usage` de genre `equipe`, et ce sont celles-là que
//      les routes de la construction (L46a) rendent : `GET /api/usage/equipes` et `GET /api/archives/:rootId/equipes`. La
//      construction avait écrit ces deux routes en lisant les tables de l'it4 SANS le code de l'it4 ;
//   4. après un lancement d'équipe dans une conversation, la réouverture (`pickRestorableAgent`, it1 L5t) rend l'assistant de
//      la conversation, pas un assistant d'étape ; et une Seconde lecture (L44c) ne le change pas non plus ;
//   5. la puce de méthode (L44e) et l'emplacement `team` du composeur (T4w) coexistent dans la même barre ;
//   6. `EQUIPES_SIMPLE_OUVERTES` vaut toujours `false` (U1, D-5-24), et `MIGRATIONS` est intact : l'it4 n'apporte aucune
//      migration 7, les numéros 6, 7, 8 et 9 restent réservés et inutilisés dans cette branche (A2, A2 bis, D-5-03) ;
//   7. le périmètre de `web-animations.test.ts` couvre les trois dossiers web de l'it4 (T4w), réunis à ceux de la
//      construction ; et le crochet `useTeamRuns` garde ses DEUX `useCallback` sur `[rootId]` (défaut D1 de l'it4, A13).
//
// Ce que ce fichier NE refait PAS : la substance de la grammaire, de l'ordonnanceur et de l'exécuteur (suites de l'it4), celle
// des modules purs de la construction (suites de 5a), ni les croisements de chaque vague, tous gardés tels quels.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import { CATALOGUE } from "./assistants-catalogue.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { MIGRATIONS } from "./db.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { pickRestorableAgent } from "./shared/agent-choice.ts";
import {
  assistantPermission,
  effectiveAgentRules,
  opencodeDefaultPermission,
  type Rule,
  type Tier,
  type UiMode,
} from "./shared/assistant-rules.ts";
import { estDemandeDeSecondeLecture, secondReadingMessage } from "./shared/chat-methods-view.ts";
import {
  CONSTRUCTION_ROUTE_PATHS as CHEMINS,
  constructionPath,
  SECOND_READING_CATALOG_ID,
  SECOND_READING_TURN_KIND,
} from "./shared/construction-constants.ts";
import type { ArchiveTeamsResponse, TeamCostsResponse } from "./shared/construction-types.ts";
import { type FlowValidationContext, validateFlow } from "./shared/flow.ts";
import type { Flow, FlowProblemCode, FlowStep, StepAssistant, TeamEstimateResponse, TeamInstallResponse, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { TEAM_EXAMPLES } from "./team-examples.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const WEB_DIR = path.join(APP_DIR, "web");
const lireServeur = (rel: string) => fs.readFileSync(path.join(APP_DIR, "server", rel), "utf8");
const lireWeb = (rel: string) => fs.readFileSync(path.join(WEB_DIR, rel), "utf8");

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const RELECTEUR = "relecteur-critique";
const DEMANDE = "Relis la requête de facturation du mois dernier.";

// --- Banc : le cockpit COMPLET, les deux branches installées ---------------------------------------------------------------

/** Studio simulé : l'installation d'un assistant du catalogue va jusqu'au bout, sans rien écrire dans le dépôt. */
function studioEspion(): StudioService {
  const saved = new Map<string, unknown>();
  return {
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
      return item;
    },
    remove: async () => true,
    get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
}

interface Banc extends CockpitHarness {
  /** Sous-dossier du workspace : une équipe ne travaille jamais sur tout le workspace (P9). */
  directory: string;
}

/**
 * `modules: "tous"` (les quatre modules de la construction) ET les CINQ modules d'équipes réels. Le seul écart au « tous »
 * d'`equipes` est l'horloge de l'exécuteur : `createTeamRunnerModule` reçoit les délais raccourcis que TOUTES les suites de
 * l'it4 emploient (`pollMs`, `retryMs`, `usageWaitMs` : options de test, jamais lues d'une variable d'environnement). Sans
 * elle, le sondage du dépôt est de 15 s et un lancement ne tiendrait pas dans une suite.
 */
async function banc(t: TestContext): Promise<Banc> {
  const studio = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" } },
    modules: "tous",
    equipes: [
      EQ_MODULES.agentMap,
      EQ_MODULES.teams,
      EQ_MODULES.teamPreflight,
      createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }),
      EQ_MODULES.teamGuards,
    ],
    deps: (base) => {
      const assistants = new AssistantServiceClass({
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
      return {
        studio,
        assistants,
        routes: [(app: Hono) => registerAssistantRoutes(app, routeDeps), (app: Hono) => registerAiRoutes(app, routeDeps)],
      };
    },
  });
  ref.h = h;
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
  return Object.assign(h, { directory: `${h.fake.directory}/projet` });
}

/** Règles d'un assistant de lecture telles que le faux opencode les rend à `GET /agent`. */
const REGLES_LECTURE: Rule[] = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const agentDuFaux = (name: string): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant ${name}`,
  model: MODEL,
  options: {},
  permission: REGLES_LECTURE as FakeAgent["permission"],
  steps: 20,
});

/** Étapes déclarées d'un déroulé, dans l'ordre d'écriture. */
const etapesDe = (flow: Flow): FlowStep[] =>
  flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : []));

/** Installe un exemple de l'it4 et déclare ses assistants au faux, pour que le vrai pré-lancement les retrouve. */
async function installerExemple(h: Banc, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = [...new Set(etapesDe(body.team.flow).map((etape) => etape.assistant))].filter((nom) => !connus.has(nom));
  if (manquants.length > 0) {
    h.fake.setAgents([...h.fake.agents(), ...manquants.map(agentDuFaux)]);
    h.deps.lookup.invalidate();
  }
  return body;
}

/** Assistants d'étape tels que le pré-lancement de l'it4 les voit, lus dans le faux (`GET /agent`). */
function assistantsDuFaux(h: Banc): StepAssistant[] {
  return h.fake.agents().map((agent) => ({
    name: agent.name,
    title: agent.name,
    origin: "catalogue" as const,
    rights: "lecture" as const,
    mode: agent.mode === "subagent" ? ("subagent" as const) : agent.mode === "primary" ? ("primary" as const) : ("all" as const),
    hidden: false,
    rules: (agent.permission ?? []) as Rule[],
    model: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : null,
    available: true,
    steps: agent.steps ?? null,
    taille: null,
  }));
}

const contexte = (assistants: readonly StepAssistant[], mode: UiMode): FlowValidationContext => ({
  assistants,
  mode,
  niveauDisponible: () => true,
});

const codes = (flow: Flow, ctx: FlowValidationContext): FlowProblemCode[] => validateFlow(flow, ctx).map((probleme) => probleme.code);

// --- 1 et 2. La grammaire de l'it4 et les assistants d'équipe de la construction ---------------------------------------------

describe("croisement d'entrée (FE4) : la grammaire de l'it4 accepte ce que la construction pose", () => {
  it("les deux exemples de l'it4, installés par leur vraie route, passent validateFlow dans les deux modes", async (t) => {
    const h = await banc(t);
    assert.deepEqual(TEAM_EXAMPLES.map((exemple) => exemple.id), ["revue-sql", "relecture-script"], "exemples livrés par l'it4 (réponse (a) à sa Q3)");

    for (const exemple of TEAM_EXAMPLES) {
      const installe = await installerExemple(h, exemple.id);
      const assistants = assistantsDuFaux(h);
      for (const mode of ["simple", "avance"] as UiMode[]) {
        const problemes = validateFlow(installe.team.flow, contexte(assistants, mode));
        assert.deepEqual(
          problemes.filter((probleme) => probleme.bloquant).map((probleme) => `${probleme.code}/${probleme.etape ?? "-"}`),
          [],
          `exemple « ${exemple.id} » refusé en mode ${mode}`,
        );
      }
    }
    h.assertNoGlobalRestart();
  });

  it("les quatre assistants d'équipe du catalogue (L45a) sont acceptés comme étape : ni delegue, ni internet, ni autorise-sans-demander", () => {
    // Les quatre entrées `role: "equipier"` de la construction. Leurs règles effectives sont celles qu'opencode résoudrait à
    // partir du fichier d'agent que le cockpit écrit : `assistantPermission` (ce qui est écrit) vu à travers
    // `effectiveAgentRules` (ce que `GET /agent` rend). Aucune n'est recopiée à la main.
    const equipiers = CATALOGUE.filter((entree) => entree.role === "equipier");
    assert.equal(equipiers.length, 4, "les quatre assistants d'équipe de L45a");
    assert.deepEqual(
      equipiers.map((entree) => entree.id),
      ["relecteur-critique", "synthese-rapport", "aiguilleur", "rediger-compte-rendu-incident"],
    );

    for (const entree of equipiers) {
      assert.equal(entree.rights, "lecture", `${entree.id} : profil de droits`);
      assert.equal(entree.web, false, `${entree.id} : Internet`);
      const regles = effectiveAgentRules(opencodeDefaultPermission(), assistantPermission(entree.rights, entree.web, entree.fiches));
      const assistant: StepAssistant = {
        name: entree.id,
        title: entree.title,
        origin: "catalogue",
        rights: entree.rights,
        mode: "primary",
        hidden: false,
        rules: regles,
        // Un assistant du catalogue est installé avec l'IA de son niveau : sans IA propre, la grammaire rend
        // « niveau-indisponible » pour une étape qui ne choisit pas de niveau (mode Simple, décision n° 3 de l'it4).
        model: `${MODEL.providerID}/${MODEL.modelID}`,
        available: true,
        steps: 20,
        taille: entree.taskSize,
      };
      const flow: Flow = {
        version: 1,
        blocs: [
          {
            type: "etape",
            id: "un",
            etape: { id: "un", titre: "Étape", assistant: entree.id, niveau: null, taille: entree.taskSize, consigne: "Relis ce travail.", recoit: "demande" },
          },
        ],
      };
      for (const mode of ["simple", "avance"] as UiMode[]) {
        const vus = codes(flow, contexte([assistant], mode));
        for (const interdit of ["delegue", "internet", "autorise-sans-demander"] as FlowProblemCode[]) {
          assert.ok(!vus.includes(interdit), `${entree.id} : problème « ${interdit} » en mode ${mode} (${vus.join(", ")})`);
        }
        assert.deepEqual(
          validateFlow(flow, contexte([assistant], mode)).filter((probleme) => probleme.bloquant).map((probleme) => probleme.code),
          [],
          `${entree.id} : refusé comme étape en mode ${mode}`,
        );
      }
    }
  });

  it("contrôle discriminant : un assistant qui peut déléguer ou aller sur Internet est bien refusé", () => {
    const base = (regles: Rule[]): StepAssistant => ({
      name: "relecteur-critique",
      title: "Relecteur critique",
      origin: "catalogue",
      rights: "lecture",
      mode: "primary",
      hidden: false,
      rules: regles,
      model: `${MODEL.providerID}/${MODEL.modelID}`,
      available: true,
      steps: 20,
      taille: "S",
    });
    const flow: Flow = {
      version: 1,
      blocs: [
        {
          type: "etape",
          id: "un",
          etape: { id: "un", titre: "Étape", assistant: "relecteur-critique", niveau: null, taille: "S", consigne: "Relis.", recoit: "demande" },
        },
      ],
    };
    const propres = effectiveAgentRules(opencodeDefaultPermission(), assistantPermission("lecture", false, []));
    assert.ok(codes(flow, contexte([base([...propres, { permission: "task", pattern: "*", action: "allow" }])], "avance")).includes("delegue"));
    assert.ok(codes(flow, contexte([base([...propres, { permission: "webfetch", pattern: "*", action: "allow" }])], "avance")).includes("internet"));
    assert.ok(codes(flow, contexte([base([...propres, { permission: "edit", pattern: "*", action: "allow" }])], "avance")).includes("autorise-sans-demander"));
  });
});

// --- 3, 4. Un lancement réel de l'it4, lu par les routes de la construction --------------------------------------------------

async function estimer(h: Banc, teamId: string, rootId: string | null): Promise<TeamEstimateResponse> {
  const res = await h.call("POST", `/api/teams/${teamId}/estimate`, { headers: h.headers.mutating, body: { directory: h.directory, rootId } });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamEstimateResponse>();
}

async function lancer(h: Banc, teamId: string, rootId: string | null, estimateSha256: string): Promise<TeamRunStarted> {
  const res = await h.call("POST", `/api/teams/${teamId}/run`, {
    headers: h.headers.mutating,
    body: { directory: h.directory, rootId, demande: DEMANDE, fichiers: [], agentConversation: "build", estimateSha256, confirmations: {} },
  });
  assert.equal(res.status, 202, res.body);
  return res.json<TeamRunStarted>();
}

async function attendreEtat(h: Banc, runId: string, etat: string, timeoutMs = 10_000): Promise<TeamRunView> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const vue = res.json<TeamRunView>();
    if (vue.state === etat) return vue;
    if (Date.now() > limite) {
      throw new Error(`lancement « ${etat} » attendu : état ${vue.state}, étapes ${vue.steps.map((s) => `${s.stepId}=${s.state}`).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Lignes `usage` de genre `equipe` écrites par le cockpit (colonne `purpose`, sessions.ts). */
const lignesUsageEquipe = (h: Banc): Array<{ session_id: string; cost: number }> =>
  h.db.prepare("SELECT session_id, cost FROM usage WHERE purpose = 'equipe' ORDER BY created_at").all() as Array<{ session_id: string; cost: number }>;

describe("croisement d'entrée (FE4) : un lancement de l'it4 est lu par les routes de la construction (L46a)", () => {
  it("les lignes usage « equipe » du lancement se retrouvent dans GET /api/usage/equipes et GET /api/archives/:rootId/equipes", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    h.fake.scriptWhen(() => true, { text: "Avis rendu.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });

    const estimation = await estimer(h, "revue-sql", null);
    const started = await lancer(h, "revue-sql", null, estimation.estimateSha256);
    const vue = await attendreEtat(h, started.runId, "terminee");
    assert.ok(vue.steps.length > 0, "aucune étape : rien n'aurait été envoyé");
    const sessionsDEtape = new Set(vue.steps.map((step) => step.sessionId).filter((id): id is string => !!id));
    assert.ok(sessionsDEtape.size > 0, "aucune session d'étape");

    // 1. Le cockpit a bien marqué les appels des étapes : genre `equipe`, jamais `chat`.
    const lignes = lignesUsageEquipe(h);
    assert.ok(lignes.length > 0, "aucune ligne usage de genre « equipe » après un lancement");
    for (const ligne of lignes) {
      assert.ok(sessionsDEtape.has(ligne.session_id), `ligne usage « equipe » hors des sessions d'étape : ${ligne.session_id}`);
    }

    // 2. Route des coûts par équipe : elle voit le lancement, et son coût est celui des lignes `usage` des étapes.
    const couts = await h.call("GET", CHEMINS.coutsEquipes, { headers: h.headers.authed });
    assert.equal(couts.status, 200, couts.body);
    const corpsCouts = couts.json<TeamCostsResponse>();
    assert.ok(corpsCouts.parEquipe.length > 0, "aucune équipe dans GET /api/usage/equipes après un lancement");
    const total = corpsCouts.parEquipe.reduce((somme, equipe) => somme + equipe.cout, 0);
    assert.ok(total > 0, `coût nul alors que les lignes usage valent ${lignes.reduce((s, l) => s + l.cost, 0)}`);
    assert.ok(
      corpsCouts.lancements.some((ligne) => ligne.runId === started.runId),
      "le lancement ne figure pas parmi les plus coûteux de GET /api/usage/equipes",
    );

    // 3. Route des archives d'équipe de la conversation : la racine est celle que le lancement a créée (D-eq-23).
    assert.ok(vue.rootId, "le lancement n'a pas de conversation racine");
    const archives = await h.call("GET", constructionPath(CHEMINS.archivesEquipes, vue.rootId), { headers: h.headers.authed });
    assert.equal(archives.status, 200, archives.body);
    const corpsArchives = archives.json<ArchiveTeamsResponse>();
    assert.equal(corpsArchives.lancements.length, 1, "le lancement n'apparaît pas dans les archives d'équipe de sa conversation");
    const lancement = corpsArchives.lancements[0];
    assert.ok(lancement);
    assert.equal(lancement.runId, started.runId);
    assert.equal(lancement.etapes.length, vue.steps.length, "les étapes archivées ne sont pas celles du lancement");
    h.assertNoGlobalRestart();
  });

  it("après un lancement, la réouverture rend l'assistant de la conversation ; une Seconde lecture ne le change pas", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    h.fake.scriptWhen(() => true, { text: "Avis rendu.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });

    // Conversation ordinaire, avec l'assistant « build » : c'est celui qu'on doit retrouver à la réouverture.
    const creee = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Facturation" } });
    assert.equal(creee.status, 200, creee.body);
    const rootId = creee.json<{ id: string }>().id;
    assert.equal(
      (await h.call("POST", `/api/oc/session/${rootId}/prompt_async`, {
        headers: h.headers.mutating,
        body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Analyse cette requête." }] },
      })).status,
      204,
    );

    const estimation = await estimer(h, "revue-sql", rootId);
    const started = await lancer(h, "revue-sql", rootId, estimation.estimateSha256);
    await attendreEtat(h, started.runId, "terminee");

    const reouverture = async (): Promise<string | undefined> => {
      const res = await h.call("GET", `/api/chat/choices/${rootId}`, { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      const choix = res.json<{ agent: string; tier: Tier | null; model: string | null; variant: string | null; createdAt: number } | null>();
      return pickRestorableAgent({
        choices: choix,
        messages: [],
        agents: h.fake.agents().map((agent) => ({ name: agent.name, mode: agent.mode, hidden: false, model: null })),
        defaultAgent: "build",
        tiers: [{ id: "rapide", model: null }, { id: "equilibre", model: null }, { id: "expert", model: null }],
        chatDefaultTier: "equilibre",
        advanced: true,
        models: [{ key: `${MODEL.providerID}/${MODEL.modelID}` }],
      }).agent;
    };

    // Les messages que l'équipe recopie dans la racine (demande et résultat, `noReply`) ne doivent pas faire basculer le
    // composeur sur un assistant d'étape : ce sont des recopies du cockpit, pas des choix de la personne.
    assert.equal(await reouverture(), "build", "la réouverture après un lancement d'équipe a changé d'assistant");

    // Seconde lecture (L44c) : la ligne `chat_turns` est requalifiée, et la réouverture reste sur l'assistant d'avant.
    const now = Date.now();
    h.db
      .prepare(
        `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
         VALUES ('agents', ?, 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
      )
      .run(RELECTEUR, SECOND_READING_CATALOG_ID, now, now);
    h.fake.setAgents([...h.fake.agents(), agentDuFaux(RELECTEUR)]);
    h.deps.lookup.invalidate();

    const texte = secondReadingMessage("Analyser un incident");
    assert.equal(estDemandeDeSecondeLecture(texte), true);
    assert.equal(
      (await h.call("POST", `/api/oc/session/${rootId}/prompt_async`, {
        headers: h.headers.mutating,
        body: { agent: RELECTEUR, model: MODEL, parts: [{ type: "text", text: texte }] },
      })).status,
      204,
    );

    const genres = (h.db.prepare("SELECT kind FROM chat_turns WHERE session_id = ? ORDER BY created_at, id").all(rootId) as Array<{ kind: string }>).map(
      (row) => row.kind,
    );
    assert.ok(genres.includes(SECOND_READING_TURN_KIND), `la ligne de seconde lecture n'a pas été requalifiée : ${genres.join(", ")}`);
    assert.equal(await reouverture(), "build", "le composeur a basculé sur le Relecteur après la seconde lecture");
    h.assertNoGlobalRestart();
  });
});

// --- 5, 6, 7. Ce que la fusion doit garder ----------------------------------------------------------------------------------

describe("croisement d'entrée (FE4) : ce que la fusion garde des deux branches", () => {
  it("le composeur porte à la fois l'emplacement « team » (T4w) et la puce de méthode (L44e)", () => {
    const composeur = lireWeb("pages/chat/Composer.tsx");
    assert.match(composeur, /\{team\}/, "l'emplacement team de l'it4 a disparu du composeur");
    assert.match(composeur, /<MethodChip\b/, "la puce de méthode de la construction a disparu du composeur");
    // Les deux sont dans la MÊME barre d'outils, l'emplacement d'équipe avant la puce (C §9.4).
    const barre = composeur.slice(composeur.indexOf("composer-toolbar"));
    const iTeam = barre.indexOf("{team}");
    const iPuce = barre.indexOf("<MethodChip");
    assert.ok(iTeam > 0 && iPuce > 0, "l'un des deux n'est pas dans la barre du composeur");
    assert.ok(iTeam < iPuce, "la puce de méthode passe avant l'emplacement d'équipe");
    // Les deux balisages sont gardés, sans imbrication (§2.6). Le nom de la section est composé ici, jamais écrit en toutes
    // lettres : une balise `c5:` littérale dans ce fichier serait comptée ouverte et non fermée par construction-balises.
    assert.match(composeur, /\{\/\* --- équipes \(it4\) : début --- \*\/\}/);
    const baliseC5 = (nom: string) => `{/* <${"c5"}:${nom}> */}`;
    assert.ok(composeur.includes(baliseC5("methodes-puce")), "la section c5 de la puce a disparu du composeur");
  });

  it("EQUIPES_SIMPLE_OUVERTES reste false (U1, D-5-24) et MIGRATIONS est intact (A2, A2 bis, D-5-03)", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.match(lireServeur("wiring-eq.ts"), /export const EQUIPES_SIMPLE_OUVERTES = false;/);
    // L'it4 n'apporte aucune migration : le tableau garde les cinq migrations de la 1.0, et les numéros 6 à 9 restent
    // réservés et inutilisés dans cette branche. La règle d'assertion unique (A2 bis) reste vraie.
    assert.equal(MIGRATIONS.length, 5, `MIGRATIONS a changé : ${MIGRATIONS.length} entrées`);
  });

  it("le périmètre de web-animations réunit les dossiers des deux branches (T4w et T5a)", () => {
    const source = lireServeur("web-animations.test.ts");
    for (const dossier of ["pages/chat/team", "pages/assistants/teams", "pages/assistants/carte"]) {
      assert.ok(source.includes(`"${dossier}"`), `périmètre de l'it4 perdu : ${dossier}`);
      assert.ok(fs.existsSync(path.join(WEB_DIR, dossier)), `dossier annoncé absent : ${dossier}`);
    }
    for (const dossier of ["pages/costs", "pages/archives", "pages/assistants/methods", "pages/chat/methods"]) {
      assert.ok(source.includes(`"${dossier}"`), `périmètre de la construction perdu : ${dossier}`);
    }
  });

  it("useTeamRuns garde ses deux useCallback sur [rootId] (défaut D1 de l'it4, A13)", () => {
    const crochet = lireWeb("pages/chat/team/useTeamRuns.ts");
    const rappels = crochet.match(/useCallback\([\s\S]*?\), \[rootId\]\)/g) ?? [];
    assert.equal(rappels.length, 2, `deux useCallback sur [rootId] attendus, ${rappels.length} trouvés`);
    assert.match(crochet, /import \{ useCallback, useSyncExternalStore \} from "react";/);
  });

  it("l'émulation de média du banc passe par la seule aide de l'it4 (onglet.medias), et cdp.mjs n'est pas écrit par la construction", () => {
    const a11y = fs.readFileSync(path.join(APP_DIR, "..", "e2e", "lib", "a11y.mjs"), "utf8");
    assert.match(a11y, /onglet\.medias\(\{/, "a11y.mjs n'appelle pas onglet.medias de l'it4");
    assert.ok(
      !/envoyer\(\s*"Emulation\.setEmulatedMedia"/.test(a11y),
      "a11y.mjs envoie encore setEmulatedMedia lui-même : deux aides pour la même commande CDP",
    );
    assert.match(a11y, /Emulation\.setEmulatedVisionDeficiency/, "setEmulatedVisionDeficiency doit rester dans a11y.mjs");
    const cdp = fs.readFileSync(path.join(APP_DIR, "..", "e2e", "lib", "cdp.mjs"), "utf8");
    assert.match(cdp, /async medias\(\{/, "cdp.mjs n'expose plus l'aide de média de l'it4");
  });
});
