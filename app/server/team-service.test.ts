// Tests du TeamService et de ses routes (itération 4, plan d'exécution it4 fiche L37a, tableau §4.1.5) : équipes, aperçu,
// estimation déléguée, exemples et garde de rechargement de leur installation.
// Le port `preflight` est SURCHARGÉ (L37p est écrit en parallèle, plan §2.3) : les assistants lus par le service viennent d'un
// faux, et l'estimation d'un lancement est un faux qui compte ses appels.
// Ce que ces tests tiennent, en plus des routes et des codes :
// - AUCUNE requête d'écriture vers opencode hors de l'installation d'un assistant, toujours derrière la garde (espion sur
//   studio.save : un refus de la garde ne laisse aucun fichier d'agent écrit) ;
// - l'aperçu n'écrit rien (ni équipe, ni assistant) ;
// - l'installation d'un exemple est idempotente (deuxième appel sans effet, équipe modifiée jamais écrasée) ;
// - les équipes sont fermées en mode Simple tant que la constante est fausse, et l'ouverture tient en cette seule ligne (U1) ;
// - les DEUX exemples passent la grammaire du mode Simple avec le catalogue réel (aucun assistant nouveau en itération 4).
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import type { AssistantService } from "./assistants.ts";
import { CATALOGUE } from "./assistants-catalogue.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import type { EstimateOutcome, TeamPreflightPort } from "./contracts-eq.ts";
import { assistantPermission, effectiveAgentRules, type Tier } from "./shared/assistant-rules.ts";
import { validateFlow } from "./shared/flow.ts";
import { planSteps, receivedFrom, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  FlowStep,
  StepAssistant,
  TeamErrorBody,
  TeamEstimateResponse,
  TeamInstallResponse,
  TeamsListResponse,
  TeamView,
} from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { exampleFlow, TEAM_EXAMPLES } from "./team-examples.ts";
import { neutralRunner } from "./team-runner.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";
import { buildEquipes } from "./wiring-eq.ts";

const SQL = "relire-requete-sql";
const SCRIPT = "relire-script";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

// --- Doublures ----------------------------------------------------------------------------------------------------------------

/** Règles effectives d'un assistant du catalogue en lecture seule : ni délégation, ni Internet, ni action sans demander. */
function reglesLecture(fiches: readonly string[] = []): StepAssistant["rules"] {
  return effectiveAgentRules({}, assistantPermission("lecture", false, fiches));
}

function assistant(name: string, over: Partial<StepAssistant> = {}): StepAssistant {
  return {
    name,
    title: `Assistant ${name}`,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: reglesLecture(),
    model: "github-copilot/claude-sonnet-5",
    available: true,
    steps: 20,
    taille: "M",
    ...over,
  };
}

interface PreflightEspion {
  port: TeamPreflightPort;
  /** Appels d'estimate : la route du lancement DÉLÈGUE le calcul à L37p, elle ne l'écrit pas. */
  estimations: number;
}

function preflightEspion(assistants: readonly StepAssistant[], outcome?: EstimateOutcome): PreflightEspion {
  const carte = new Map(assistants.map((a) => [a.name, a]));
  const espion: PreflightEspion = {
    estimations: 0,
    port: {
      assistants: async () => carte,
      estimate: async () => {
        espion.estimations++;
        return outcome ?? { ok: false, status: 502, code: "opencode-injoignable" };
      },
      check: async () => ({ ok: false, status: 409, code: "a-venir" }),
      recheck: async () => ({ ok: false, genre: "changement", code: "a-venir" }),
    },
  };
  return espion;
}

/** Studio simulé complet (lecture des fichiers d'agents) : l'installation d'un assistant du catalogue va jusqu'au bout. */
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
  /** Fichiers écrits par le Studio (agents et fiches) : un refus de la garde n'en laisse aucun. */
  ecrits: string[];
  /** Fichiers d'agents seulement. */
  agentsEcrits(): string[];
}

interface BancOptions {
  preflight?: TeamPreflightPort;
  equipes?: CockpitHarnessOptions["equipes"];
  eqPorts?: CockpitHarnessOptions["eqPorts"];
  settings?: Record<string, unknown>;
}

/** Harnais du module « teams » : Studio complet, AssistantService réel (install), port preflight surchargé. */
async function banc(t: TestContext, options: BancOptions = {}): Promise<Banc> {
  const { studio, ecrits } = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    ...(options.settings ? { settings: options.settings } : {}),
    equipes: options.equipes ?? ["teams"],
    eqPorts: { ...(options.preflight ? { preflight: options.preflight } : {}), ...options.eqPorts },
    deps: (base) => ({
      studio,
      assistants: new AssistantServiceClass({
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
      }),
    }),
  });
  ref.h = h;
  return Object.assign(h, { ecrits, agentsEcrits: () => ecrits.filter((fichier) => fichier.startsWith("agents/")) });
}

// --- Déroulés d'essai ---------------------------------------------------------------------------------------------------------

function etape(id: string, over: Partial<FlowStep> = {}): FlowStep {
  return { id, titre: `Étape ${id}`, assistant: SCRIPT, niveau: null, taille: "S", consigne: "", recoit: "demande", ...over };
}

function flowUneEtape(over: Partial<FlowStep> = {}): Flow {
  return { version: 1, blocs: [{ type: "etape", id: "bloc", etape: etape("a", over) }] };
}

const corpsPut = (flow: Flow, titre = "Relecture maison") => ({ titre, description: "Deux avis sur un script.", flow });

async function creer(h: CockpitHarness, id: string, flow: Flow, titre?: string): Promise<TeamView> {
  const res = await h.call("PUT", `/api/teams/${id}`, { headers: h.headers.mutating, body: corpsPut(flow, titre) });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamView>();
}

async function liste(h: CockpitHarness): Promise<TeamsListResponse> {
  const res = await h.call("GET", "/api/teams", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamsListResponse>();
}

// --- 1. Routes et codes du tableau 4.1.5 ---------------------------------------------------------------------------------------

describe("L37a : routes du groupe « teams »", () => {
  it("CSRF, identifiants invalides, 404 et corps illisible", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });

    // Toute mutation exige l'en-tête anti-CSRF (garde globale de http.ts, avant ces routes).
    for (const [method, chemin] of [
      ["PUT", "/api/teams/essai"],
      ["DELETE", "/api/teams/essai"],
      ["POST", "/api/teams/preview"],
      ["POST", "/api/teams/examples/revue-sql/install"],
      ["POST", "/api/teams/essai/estimate"],
    ] as const) {
      const res = await h.call(method, chemin, { headers: h.headers.authed, ...(method === "DELETE" ? {} : { body: {} }) });
      assert.equal(res.status, 403, `${method} ${chemin} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "csrf");
    }

    // Identifiant hors de TEAM_ID_RE : 400 sur PUT (qui crée), 404 sur les routes qui désignent une équipe existante.
    const invalide = await h.call("PUT", "/api/teams/Majuscule", { headers: h.headers.mutating, body: corpsPut(flowUneEtape()) });
    assert.equal(invalide.status, 400, invalide.body);
    assert.equal(invalide.json<TeamErrorBody>().error, "invalid");
    assert.equal((await h.call("DELETE", "/api/teams/Majuscule", { headers: h.headers.mutating })).status, 404);
    const estimateInvalide = await h.call("POST", "/api/teams/Majuscule/estimate", { headers: h.headers.mutating, body: { directory: "/w", rootId: null } });
    assert.equal(estimateInvalide.status, 404, estimateInvalide.body);

    // Introuvables : équipe, exemple.
    assert.equal((await h.call("DELETE", "/api/teams/inconnue", { headers: h.headers.mutating })).status, 404);
    const exemple = await h.call("POST", "/api/teams/examples/inconnu/install", { headers: h.headers.mutating, body: {} });
    assert.equal(exemple.status, 404, exemple.body);
    assert.equal(exemple.json<TeamErrorBody>().error, "not-found");

    // Corps illisible et corps sans déroulé.
    const casse = await h.call("POST", "/api/teams/preview", { headers: { ...h.headers.mutating, "content-type": "application/json" }, body: "{" });
    assert.equal(casse.status, 400, casse.body);
    const sansFlow = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: { version: 2, blocs: [] } } });
    assert.equal(sansFlow.status, 400, sansFlow.body);
    h.assertNoGlobalRestart();
  });

  it("l'aperçu borne son corps à 64 Kio et n'écrit RIEN (ni équipe, ni fichier d'agent)", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });
    const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: flowUneEtape() } });
    assert.equal(apercu.status, 200, apercu.body);
    const vue = apercu.json<{ problems: unknown[]; estimate: unknown; layout: unknown[]; liste: string[]; droits: unknown[] }>();
    assert.deepEqual(vue.problems, []);
    assert.equal(vue.layout.length, 1);
    assert.equal(vue.liste.length, 1);
    assert.ok(vue.droits.length > 0, "« Ce que cette équipe peut faire » est calculé");
    assert.notEqual(vue.estimate, null);
    assert.deepEqual((await liste(h)).teams, [], "aucune équipe enregistrée par un aperçu");
    assert.deepEqual(h.ecrits, [], "aucun fichier écrit par un aperçu");

    const trop = "x".repeat(TEAM_TEXT_LIMITS.apercuOctets + 1);
    const refus = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: flowUneEtape({ consigne: trop }) } });
    assert.equal(refus.status, 413, refus.body);
    h.assertNoGlobalRestart();
  });

  it("422 equipe-invalide porte la liste des problèmes bloquants", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });
    // Assistant inconnu du cockpit et titre trop court : deux problèmes bloquants sur la même étape.
    const res = await h.call("PUT", "/api/teams/essai", { headers: h.headers.mutating, body: corpsPut(flowUneEtape({ assistant: "fantome", titre: "x" })) });
    assert.equal(res.status, 422, res.body);
    const body = res.json<TeamErrorBody>();
    assert.equal(body.error, "equipe-invalide");
    assert.equal(body.message, TEXTES.partout.erreurs["equipe-invalide"]);
    assert.deepEqual((body.problems ?? []).map((probleme) => probleme.code).toSorted(), ["assistant-absent", "titre"]);
    assert.ok((body.problems ?? []).every((probleme) => probleme.bloquant));
    assert.deepEqual((await liste(h)).teams, [], "rien n'est enregistré quand la grammaire refuse");
  });

  it("GET /api/teams : état ok, « À compléter » quand un assistant manque (D-eq-21), « Réglée en mode Avancé » pour un niveau", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT), assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });

    const ok = await creer(h, "simple-ok", flowUneEtape(), "Équipe simple");
    assert.equal(ok.etat, "ok");
    assert.equal(ok.forme, "a-la-suite");
    assert.equal(ok.origine, "creee");
    assert.notEqual(ok.estimate, null);
    assert.equal(ok.dernierLancement, null);

    const avancee = await creer(h, "avec-niveau", flowUneEtape({ niveau: "expert" as Tier }), "Équipe Avancé");
    assert.equal(avancee.etat, "avance");

    // D-eq-21 : la suppression d'un assistant utilisé n'est PAS refusée ; l'équipe passe « À compléter » et n'annonce aucun montant.
    const h2 = await banc(t, { preflight: preflightEspion([assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });
    h2.db
      .prepare("INSERT INTO teams (id, titre, description, flow, origine, avance, created_at, updated_at) VALUES (?, ?, '', ?, 'creee', 0, 1, 1)")
      .run("orpheline", "Équipe orpheline", JSON.stringify(flowUneEtape()));
    const vue = (await liste(h2)).teams.find((team) => team.id === "orpheline");
    assert.equal(vue?.etat, "a-completer");
    assert.equal(vue?.estimate, null, "aucun montant annoncé quand une étape manque (P3)");
  });

  it("colonne teams.avance tenue à jour par chaque enregistrement", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });
    const avance = (id: string): number =>
      (h.db.prepare("SELECT avance FROM teams WHERE id = ?").get(id) as { avance: number }).avance;

    await creer(h, "bascule", flowUneEtape({ niveau: "expert" as Tier }));
    assert.equal(avance("bascule"), 1, "un niveau choisi par l'équipe est un réglage du mode Avancé");

    // Le même enregistrement sans niveau repasse la colonne à 0 : l'équipe redevient lisible en mode Simple.
    await creer(h, "bascule", flowUneEtape());
    assert.equal(avance("bascule"), 0);
  });

  it("AUCUNE requête d'écriture vers opencode hors de l'installation d'un assistant", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });
    await creer(h, "sans-ecriture", flowUneEtape());
    const depart = h.fake.requests.length;

    await liste(h);
    await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: flowUneEtape() } });
    await h.call("PUT", "/api/teams/sans-ecriture", { headers: h.headers.mutating, body: corpsPut(flowUneEtape(), "Deuxième titre") });
    await h.call("POST", "/api/teams/sans-ecriture/estimate", { headers: h.headers.mutating, body: { directory: "/workspace", rootId: null } });
    await h.call("DELETE", "/api/teams/sans-ecriture", { headers: h.headers.mutating });

    const ecritures = h.fake.requests.slice(depart).filter((requete) => requete.method !== "GET");
    assert.deepEqual(ecritures, [], "seule l'installation d'un assistant écrit vers opencode, et elle est derrière la garde");
    assert.deepEqual(h.agentsEcrits(), []);
  });
});

// --- 2. Mode Simple fermé (U1, D-eq-13) ------------------------------------------------------------------------------------------

describe("L37a : mode Simple", () => {
  it("403 equipes-simple-fermees sur PUT, install et estimate tant que la constante est fausse", async (t) => {
    const preflight = preflightEspion([assistant(SCRIPT)]);
    const ferme = await banc(t, { preflight: preflight.port });
    assert.equal((await liste(ferme)).ouvertesEnSimple, false);

    const routes: Array<[string, string, unknown]> = [
      ["PUT", "/api/teams/essai", corpsPut(flowUneEtape())],
      ["POST", "/api/teams/examples/revue-sql/install", {}],
      ["POST", "/api/teams/essai/estimate", { directory: "/workspace", rootId: null }],
    ];
    for (const [method, chemin, body] of routes) {
      const res = await ferme.call(method, chemin, { headers: ferme.headers.mutating, body });
      assert.equal(res.status, 403, `${method} ${chemin} : ${res.body}`);
      const refus = res.json<TeamErrorBody>();
      assert.equal(refus.error, "equipes-simple-fermees");
      assert.equal(refus.message, TEXTES.simple.fermees);
    }
    assert.equal(preflight.estimations, 0, "une route fermée n'appelle pas le pré-lancement");
    assert.deepEqual(ferme.agentsEcrits(), [], "aucun assistant installé par une route fermée");
    assert.deepEqual((await liste(ferme)).teams, []);
    ferme.assertNoGlobalRestart();
  });

  it("ouverture en UNE ligne (simpleOuvertes) : les mêmes routes sont acceptées, un niveau ou un assistant Personnalisé donne 403 mode-avance", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, equipes: [] });
    const perso = assistant("agent-maison", { origin: "studio", rights: "personnalise" });
    // Le SEUL levier de l'ouverture : la constante EQUIPES_SIMPLE_OUVERTES, que les tests surchargent par `simpleOuvertes`.
    const wiring = buildEquipes(
      { c11: h.cockpit.c11, classifier: h.deps.classifier, assistants: h.deps.assistants as unknown as Pick<AssistantService, "install"> },
      { modules: ["teams"], ports: { preflight: preflightEspion([assistant(SCRIPT), perso]).port }, simpleOuvertes: true },
    );
    const app = new Hono();
    for (const register of wiring.routes) register(app);
    const appel = async (method: string, chemin: string, body?: unknown) =>
      app.request(chemin, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });

    const vue = await (await appel("GET", "/api/teams")).json();
    assert.equal((vue as TeamsListResponse).ouvertesEnSimple, true);

    // En Simple, un niveau choisi par l'équipe est un contenu du mode Avancé : 403 mode-avance, rien n'est enregistré.
    const niveau = await appel("PUT", "/api/teams/essai", corpsPut(flowUneEtape({ niveau: "rapide" as Tier })));
    assert.equal(niveau.status, 403);
    assert.equal(((await niveau.json()) as TeamErrorBody).error, "mode-avance");

    // Un assistant « Personnalisé » (agent du Studio) est lui aussi un contenu du mode Avancé (D-eq-11).
    const personnalise = await appel("PUT", "/api/teams/essai", corpsPut(flowUneEtape({ assistant: perso.name })));
    assert.equal(personnalise.status, 403);
    assert.equal(((await personnalise.json()) as TeamErrorBody).error, "mode-avance");

    // Le même déroulé sans niveau est accepté : l'ouverture ne tient qu'à cette ligne.
    const accepte = await appel("PUT", "/api/teams/essai", corpsPut(flowUneEtape()));
    assert.equal(accepte.status, 200);
    assert.equal(((await accepte.json()) as TeamView).etat, "ok");
    const apres = (await (await appel("GET", "/api/teams")).json()) as TeamsListResponse;
    assert.deepEqual(apres.teams.map((team) => team.id), ["essai"]);
    h.assertNoGlobalRestart();
  });
});

// --- 3. Estimation déléguée ------------------------------------------------------------------------------------------------------

describe("L37a : POST /api/teams/:id/estimate", () => {
  it("délègue à preflight.estimate (calcul de L37p) et rend sa réponse telle quelle", async (t) => {
    const reponse: TeamEstimateResponse = {
      estimate: { typique: 0.2, maximum: 0.5, plafond: 0.5, etapesFacturees: 1, depassementUnAppel: 0.1, relais: 0, parEtape: [] },
      estimateSha256: "a".repeat(64),
      problems: [],
      plafond: 0.5,
      confirmations: [],
      blocage: null,
      expireA: 1_800_000_000_000,
      deja: null,
    };
    const preflight = preflightEspion([assistant(SCRIPT)], { ok: true, response: reponse });
    const h = await banc(t, { preflight: preflight.port, settings: { ui: { mode: "avance" } } });
    await creer(h, "estimee", flowUneEtape());

    const res = await h.call("POST", "/api/teams/estimee/estimate", { headers: h.headers.mutating, body: { directory: "/workspace", rootId: null } });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json<TeamEstimateResponse>(), reponse);
    assert.equal(preflight.estimations, 1);

    // Corps invalide : refus local, sans appeler le pré-lancement ; équipe inconnue : 404.
    assert.equal((await h.call("POST", "/api/teams/estimee/estimate", { headers: h.headers.mutating, body: { rootId: null } })).status, 400);
    assert.equal((await h.call("POST", "/api/teams/inconnue/estimate", { headers: h.headers.mutating, body: { directory: "/w", rootId: null } })).status, 404);
    assert.equal(preflight.estimations, 1);
  });

  it("le refus du pré-lancement est rendu tel quel (502 opencode-injoignable)", async (t) => {
    const preflight = preflightEspion([assistant(SCRIPT)]);
    const h = await banc(t, { preflight: preflight.port, settings: { ui: { mode: "avance" } } });
    await creer(h, "injoignable", flowUneEtape());
    const res = await h.call("POST", "/api/teams/injoignable/estimate", { headers: h.headers.mutating, body: { directory: "/workspace", rootId: null } });
    assert.equal(res.status, 502, res.body);
    assert.equal(res.json<TeamErrorBody>().error, "opencode-injoignable");
    assert.equal(preflight.estimations, 1);
  });
});

// --- 4. Exemples et leur installation ----------------------------------------------------------------------------------------------

describe("L37a : exemples (Q3, réponse a)", () => {
  it("les deux exemples passent la grammaire du mode Simple avec le catalogue réel", () => {
    assert.deepEqual(
      TEAM_EXAMPLES.map((example) => example.id),
      ["revue-sql", "relecture-script"],
    );
    // Assistants tels que le catalogue les installe : profil « lecture », consignes propres, aucun assistant nouveau.
    const assistants = CATALOGUE.filter((entry) => entry.id === SQL || entry.id === SCRIPT).map((entry) =>
      assistant(entry.id, { title: entry.title, rights: entry.rights, rules: reglesLecture(entry.fiches), taille: entry.taskSize }),
    );
    assert.equal(assistants.length, 2, "les deux assistants des exemples sont déjà au catalogue");
    for (const example of TEAM_EXAMPLES) {
      const problems = validateFlow(exampleFlow(example, new Map()), { assistants, mode: "simple", niveauDisponible: () => true });
      assert.deepEqual(problems, [], `${example.id} : ${JSON.stringify(problems)}`);
      assert.ok(example.catalogIds.every((id) => id === SQL || id === SCRIPT));
    }

    // Ordre et relais tels que planSteps et receivedFrom (T4) les lisent : trois avis indépendants puis leur synthèse ;
    // une chaîne à la suite dont la consolidation reçoit tout ce qui précède.
    const sql = exampleFlow(TEAM_EXAMPLES[0] as (typeof TEAM_EXAMPLES)[number], new Map());
    assert.deepEqual(
      planSteps(sql).map((planned) => [planned.stepId, planned.role]),
      [
        ["exactitude", "avis"],
        ["performance", "avis"],
        ["donnees-sensibles", "avis"],
        ["synthese", "synthese"],
      ],
    );
    for (const avis of ["exactitude", "performance", "donnees-sensibles"]) assert.deepEqual(receivedFrom(sql, avis), [], avis);
    assert.deepEqual(receivedFrom(sql, "synthese"), ["exactitude", "performance", "donnees-sensibles"]);

    const script = exampleFlow(TEAM_EXAMPLES[1] as (typeof TEAM_EXAMPLES)[number], new Map());
    assert.deepEqual(
      planSteps(script).map((planned) => planned.stepId),
      ["standards", "securite", "exploitation-nuit", "consolidation"],
    );
    assert.deepEqual(receivedFrom(script, "securite"), ["standards"]);
    assert.deepEqual(receivedFrom(script, "consolidation"), ["standards", "securite", "exploitation-nuit"]);
    assert.ok(script.blocs.some((bloc) => bloc.type === "pause" && bloc.message === TEXTES.partout.exemples["relecture-script"].pause));
  });

  it("installation idempotente : assistant installé UNE FOIS, deuxième appel sans effet, équipe modifiée jamais écrasée", async (t) => {
    const titreScript = CATALOGUE.find((entry) => entry.id === SCRIPT)?.title ?? SCRIPT;
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT, { title: titreScript })]).port, settings: { ui: { mode: "avance" } } });

    const avant = await liste(h);
    assert.deepEqual(
      avant.exemples.map((exemple) => [exemple.id, exemple.installee]),
      [
        ["revue-sql", false],
        ["relecture-script", false],
      ],
    );
    const galerie = avant.exemples.find((exemple) => exemple.id === "relecture-script");
    assert.deepEqual(galerie?.assistantsManquants, [titreScript]);
    assert.ok((galerie?.liste.length ?? 0) >= 5, "la liste lue par un lecteur d'écran décrit tout le déroulé");

    const premier = await h.call("POST", "/api/teams/examples/relecture-script/install", { headers: h.headers.mutating, body: {} });
    assert.equal(premier.status, 200, premier.body);
    const installee = premier.json<TeamInstallResponse>();
    assert.deepEqual(installee.assistantsInstalles, [titreScript]);
    assert.equal(installee.team.origine, "exemple");
    assert.equal(installee.team.exempleId, "relecture-script");
    assert.equal(installee.team.titre, TEXTES.partout.exemples["relecture-script"].titre);
    assert.deepEqual(h.agentsEcrits(), [`agents/${SCRIPT}`], "un seul fichier d'agent écrit");

    // Deuxième appel : aucune écriture, aucune installation, une seule équipe.
    const ecritsApres = [...h.ecrits];
    const second = await h.call("POST", "/api/teams/examples/relecture-script/install", { headers: h.headers.mutating, body: {} });
    assert.equal(second.status, 200, second.body);
    assert.deepEqual(second.json<TeamInstallResponse>().assistantsInstalles, []);
    assert.deepEqual(h.ecrits, ecritsApres, "aucun fichier réécrit au second appel");
    assert.equal((await liste(h)).teams.length, 1);
    assert.equal((await liste(h)).exemples.find((exemple) => exemple.id === "relecture-script")?.installee, true);

    // Équipe modifiée : l'installation ne l'écrase jamais.
    const modifiee = await h.call("PUT", `/api/teams/${installee.team.id}`, { headers: h.headers.mutating, body: corpsPut(flowUneEtape(), "Ma relecture à moi") });
    assert.equal(modifiee.status, 200, modifiee.body);
    const troisieme = await h.call("POST", "/api/teams/examples/relecture-script/install", { headers: h.headers.mutating, body: {} });
    assert.equal(troisieme.status, 200, troisieme.body);
    assert.equal(troisieme.json<TeamInstallResponse>().team.titre, "Ma relecture à moi");
    assert.equal((await liste(h)).teams.length, 1);
    h.assertNoGlobalRestart();
  });

  it("assistant déjà installé : l'exemple s'installe sans réinstaller quoi que ce soit", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });
    // L'assistant du catalogue est posé avant l'exemple (comme s'il avait été installé depuis l'onglet Assistants).
    await (h.deps.assistants as unknown as Pick<AssistantService, "install">).install(SQL);
    const ecritsAvant = [...h.ecrits];
    assert.deepEqual(h.agentsEcrits(), [`agents/${SQL}`]);

    const res = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json<TeamInstallResponse>().assistantsInstalles, [], "aucun assistant posé : il était déjà là");
    assert.deepEqual(h.ecrits, ecritsAvant, "aucun fichier réécrit");
    assert.equal((await liste(h)).exemples.find((exemple) => exemple.id === "revue-sql")?.installee, true);
  });
});

// --- 5. Garde de rechargement sur l'installation d'un exemple ----------------------------------------------------------------------

describe("L37a : garde de rechargement de l'installation d'un exemple (§3.11)", () => {
  it("réponse en cours sur une conversation → 409 sessions-busy et AUCUN fichier d'agent écrit ; dérogation Avancé confirmée", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Réponse en cours" } });
    assert.equal(created.status, 200, created.body);
    const root = created.json<{ id: string }>();
    await until(() => h.sessions.get(root.id));
    h.fake.script(root.id, { tools: [{ tool: "bash", input: { command: "ls" }, ask: { permission: "bash", patterns: ["ls"] } }], followUp: { text: "fin" } });
    const envoi = await h.call("POST", `/api/oc/session/${root.id}/prompt_async`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Liste." }] },
    });
    assert.equal(envoi.status, 204, envoi.body);
    await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id);

    const refus = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "sessions-busy");
    assert.deepEqual(h.agentsEcrits(), [], "aucun fichier d'agent écrit pendant une réponse");
    assert.deepEqual((await liste(h)).teams, [], "aucune équipe enregistrée non plus");

    // Mode Avancé et x-cockpit-confirm: 1 : dérogation explicite, l'installation passe.
    const confirme = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.confirmed, body: {} });
    assert.equal(confirme.status, 200, confirme.body);
    assert.deepEqual(h.agentsEcrits(), [`agents/${SQL}`]);
    h.assertNoGlobalRestart();
  });

  it("étape d'équipe en cours (reloadBusy, D-eq-06) → 409, sans écriture", async (t) => {
    const h = await banc(t, {
      preflight: preflightEspion([assistant(SQL)]).port,
      equipes: ["teams", "teamRunner"],
      eqPorts: { runner: { ...neutralRunner(), stepsBusy: () => true } },
      settings: { ui: { mode: "avance" } },
    });
    assert.equal(h.cockpit.c11.reloadBusy(), true, "une étape d'équipe occupe le cockpit");
    const refus = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "sessions-busy");
    assert.deepEqual(h.agentsEcrits(), []);
    h.assertNoGlobalRestart();
  });

  it("demande facturée en vol → 409 ; au repos, la même installation passe", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });
    const finFacturee = h.deps.configQueue?.beginBilled();
    try {
      const enVol = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
      assert.equal(enVol.status, 409, enVol.body);
      assert.equal(enVol.json<{ error: string }>().error, "sessions-busy");
      assert.deepEqual(h.agentsEcrits(), []);
    } finally {
      finFacturee?.();
    }
    const apres = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(apres.status, 200, apres.body);
    assert.deepEqual(h.agentsEcrits(), [`agents/${SQL}`]);
    h.assertNoGlobalRestart();
  });

  it("garde TENUE : une demande facturée qui commence pendant l'attente dans la file refuse encore l'installation", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SQL)]).port, settings: { ui: { mode: "avance" } } });
    const queue = h.deps.configQueue;
    assert.ok(queue, "file d'écriture de la configuration partagée par le harnais");

    // Une application de la configuration occupe la file : l'installation attendra derrière elle.
    const barriere = Promise.withResolvers<void>();
    const occupation = queue.run(() => barriere.promise);
    const avant = h.fake.requests.length;
    const envoi = h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    // La PREMIÈRE vérification est faite dès que la sonde des conversations a interrogé le faux : le cockpit était au repos.
    await until(() => h.fake.requests.slice(avant).some((requete) => requete.pathname.includes("/session/status")));
    const finFacturee = queue.beginBilled();
    barriere.resolve();
    await occupation;

    const res = await envoi;
    finFacturee();
    assert.equal(res.status, 409, res.body);
    assert.equal(res.json<{ error: string }>().error, "sessions-busy");
    assert.deepEqual(h.agentsEcrits(), [], "aucune réponse coupée : rien n'a été écrit");
    h.assertNoGlobalRestart();
  });
});

// --- 6. Suppression ---------------------------------------------------------------------------------------------------------------

describe("L37a : DELETE /api/teams/:id", () => {
  it("409 equipe-en-cours pendant un lancement, 204 quand il est fini", async (t) => {
    const h = await banc(t, { preflight: preflightEspion([assistant(SCRIPT)]).port, settings: { ui: { mode: "avance" } } });
    await creer(h, "a-supprimer", flowUneEtape());
    h.db
      .prepare(
        `INSERT INTO team_runs (id, team_id, team_titre, flow, flow_sha256, root_session_id, directory, state, facultatifs, cost, confirmations, precisions, created_at)
         VALUES ('run-1', 'a-supprimer', 'Relecture maison', '{"version":1,"blocs":[]}', 'f0', 'ses_x', '/workspace', 'en-cours', '[]', 0, '{}', '[]', 1)`,
      )
      .run();
    const refus = await h.call("DELETE", "/api/teams/a-supprimer", { headers: h.headers.mutating });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<TeamErrorBody>().error, "equipe-en-cours");
    assert.equal((await liste(h)).teams.length, 1, "rien n'est supprimé");

    h.db.prepare("UPDATE team_runs SET state = 'terminee' WHERE id = 'run-1'").run();
    const supprime = await h.call("DELETE", "/api/teams/a-supprimer", { headers: h.headers.mutating });
    assert.equal(supprime.status, 204, supprime.body);
    assert.deepEqual((await liste(h)).teams, []);
  });
});
