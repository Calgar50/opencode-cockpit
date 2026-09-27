// Tests de croisement du train 5b V2 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L42b (exécution de la
// relecture et de l'aiguillage), L42c (cartes du chat et Déroulé d'équipe « Prévu / Réel »), L42d (éditeur guidé) et L45b
// (exemples restants et contexte des méthodes), ENSEMBLE, sur le cockpit COMPLET avec le faux opencode.
//
// Les quatre paquets ont été écrits sans se voir. Chacun a prouvé sa part sur des données fabriquées ou sur un runner monté à la
// main. Ce fichier ne refait aucune de ces preuves : il branche les quatre bout à bout, par les VRAIES routes, sur les VRAIS
// exemples de C §12.1, et vérifie ce qu'aucun paquet ne pouvait vérifier seul (§5.3, colonne « Croisements ») :
//   1. « relecture en 2 tours avec EXACTEMENT 2 `POST /session` pour le bloc » — compté sur l'exemple `postmortem` installé par
//      sa route, lancé par sa route, avec le pré-lancement et l'ordonnanceur réels (D-5-14, confirmée par MC5-2) ;
//   2. « méthode `cinq-pourquoi` de `postmortem` dans le corps envoyé à l'étape de rédaction » — la méthode vient du catalogue
//      de L44a (5a), l'exemple de L45b, la résolution et l'envoi de L42b : trois paquets pour une seule ligne d'en-tête ;
//   3. « aiguillage : aucun `prompt_async` de spécialiste avant `continue` » — sur `tri-alerte`, jusqu'à la synthèse ;
//   4. « refus de pré-lancement `methodes` → ZÉRO requête reçue par le faux » (A4), par la vraie route de lancement ;
//   5. « Déroulé d'équipe : ×2, Prévu : jusqu'à 2 tours · Réel : 1 tour, Non choisi » — le modèle pur de L42c lit ici les lignes
//      RÉELLEMENT enregistrées par l'exécuteur de L42b, et non des lignes écrites par un test ;
//   6. grille propre de la vague : le choix n'est jamais tranché par l'autonomie ni par un crochet (spéc. l.772) ; un `continue`
//      invalide rend 409 `choix-invalide` sans le moindre envoi ; le plancher ETAPE est posé à la CRÉATION de la session et
//      jamais contourné au tour 2 ; les six exemples sont valides en Simple ; l'installation est idempotente et n'écrase aucune
//      fiche.
//
// Ce que ce fichier NE refait PAS : la substance de chaque paquet (team-runner-relecture-aiguillage.test.ts,
// team-choice-view.test.ts, team-deroule-c5.test.ts, team-editor-ops-c5.test.ts, team-examples-c5.test.ts), la grammaire de la
// vague 1 (croisements-c5b-v1.test.ts) ni les contrats de l'entrée (croisements-c5-entree.test.ts).
//
// Aucune exécution facturée, aucun appel à un fournisseur réel : tout passe par le faux opencode (C §17.2).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { METHODS } from "./methods-catalogue.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { Rule } from "./shared/assistant-rules.ts";
import { canonicalRules } from "./shared/session-floors.ts";
import { TEXTES as C5 } from "./shared/construction-texts.ts";
import { METHODE_HEADER } from "./shared/flow.ts";
import { type Method, applyMethodBlocks } from "./shared/methods.ts";
import { validateFlow } from "./shared/flow.ts";
import { FLOW_LIMITS } from "./shared/team-limits.ts";
import type {
  Flow,
  FlowStep,
  TeamEstimateResponse,
  TeamInstallResponse,
  TeamRunStarted,
  TeamRunView,
  TeamsListResponse,
} from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { TEAM_EXAMPLES, exampleFlow } from "./team-examples.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { buildTeamDeroule } from "../web/pages/chat/team/deroule-model.ts";

const DEMANDE = "Le traitement de nuit est tombé deux fois cette semaine.";
const AUTEUR = "rediger-compte-rendu-incident";
const RELECTEUR = "relecteur-critique";
const TRI = C5.partout.exemplesEquipes["tri-alerte"].etapes;

const CINQ_POURQUOI = METHODS.find((methode) => methode.id === "cinq-pourquoi") as Method;
if (!CINQ_POURQUOI) throw new Error("catalogue des méthodes : « cinq-pourquoi » attendue (L44a)");

// --- Banc : tout le cockpit, les cinq modules d'équipes, aucun port surchargé --------------------------------------------------

/**
 * Studio simulé qui GARDE le corps des fichiers d'agent : le contexte `methods` de L45b lit ces corps (`methodIdsIn`), et le
 * test doit pouvoir y poser une méthode pour éprouver le refus A4. L'espion de l'itération 4 écrasait le corps par « x ».
 */
function studioEspion(): { studio: StudioService; ecrits: string[]; poser(kind: string, name: string, body: string): void } {
  const saved = new Map<string, { kind: string; name: string; body: string; frontmatter: Record<string, unknown> }>();
  const ecrits: string[] = [];
  const item = (entry: { kind: string; name: string; body: string; frontmatter: Record<string, unknown> }) => ({
    kind: entry.kind,
    name: entry.name,
    scope: "global",
    project: null,
    file: `${entry.kind}/${entry.name}.md`,
    frontmatter: entry.frontmatter,
    body: entry.body,
    error: null,
    files: [],
    updatedAt: Date.now(),
  });
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown>; body?: string; createOnly?: boolean }) => {
      const cle = `${kind}/${input.name}`;
      // `createOnly` : une fiche déjà posée n'est JAMAIS réécrite (installation idempotente, L45b).
      if (input.createOnly === true && saved.has(cle)) return item(saved.get(cle) as never);
      const entry = { kind, name: input.name, body: input.body ?? "", frontmatter: input.frontmatter };
      saved.set(cle, entry);
      ecrits.push(cle);
      return item(entry);
    },
    remove: async () => true,
    get: async (kind: string, name: string) => {
      const entry = saved.get(`${kind}/${name}`);
      return entry ? item(entry) : null;
    },
    list: async (kind: string) => [...saved.values()].filter((entry) => entry.kind === kind).map(item),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  return {
    studio,
    ecrits,
    poser: (kind, name, body) => {
      const cle = `${kind}/${name}`;
      const entry = saved.get(cle);
      saved.set(cle, { kind, name, body, frontmatter: entry?.frontmatter ?? {} });
    },
  };
}

interface Banc extends CockpitHarness {
  /** Sous-dossier du workspace : l'équipe ne travaille pas sur tout le workspace (P9, `confirmation-workspace`). */
  directory: string;
  ecrits: string[];
  poser(kind: string, name: string, body: string): void;
  repere(): number;
  /** Requêtes reçues par le faux depuis un repère, SAUF le sondage `GET /session/status` de la 1.1. */
  depuis(repere: number): string[];
}

/** Cockpit de production : modules 1.1 « tous », les CINQ modules d'équipes réels, AUCUN port d'équipe surchargé. */
async function banc(t: TestContext, options: { settings?: Record<string, unknown> } = {}): Promise<Banc> {
  const { studio, ecrits, poser } = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: {
      ui: { mode: "avance" },
      // Les trois niveaux sont résolus sur les DEUX modèles du faux : « Préparer une revue CAB » est un assistant de niveau
      // Expert, et sans cela son installation serait refusée en 422 `ia-indisponible`, pour une raison étrangère à la vague.
      ai: {
        tiers: {
          rapide: { candidates: ["github-copilot/gpt-5-mini"], variant: null },
          equilibre: { candidates: ["github-copilot/gpt-5-mini"], variant: null },
          expert: { candidates: ["github-copilot/claude-sonnet-5"], variant: null },
        },
      },
      ...(options.settings ?? {}),
    },
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
  return Object.assign(h, {
    directory: `${h.fake.directory}/projet`,
    ecrits,
    poser,
    repere: () => h.fake.requests.length,
    depuis: (repere: number) =>
      h.fake.requests
        .slice(repere)
        .filter((req) => !(req.method === "GET" && req.pathname === "/session/status"))
        .map((req) => `${req.method} ${req.pathname}`),
  });
}

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
  steps: 40,
});

/** Étapes déclarées d'un déroulé, toutes formes confondues (les quatre blocs de la 5b compris). */
function etapesDe(flow: Flow): FlowStep[] {
  return flow.blocs.flatMap((bloc) => {
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
  });
}

/** Installe un exemple par sa VRAIE route et déclare ses assistants au faux, pour que le pré-lancement les retrouve. */
async function installerExemple(h: Banc, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = [...new Set(etapesDe(body.team.flow).map((etape) => etape.assistant))].filter((nom) => !connus.has(nom));
  if (manquants.length > 0) {
    h.fake.setAgents([...h.fake.agents(), ...manquants.map(fakeAgent)]);
    h.deps.lookup.invalidate();
  }
  return body;
}

async function estimer(h: Banc, teamId: string): Promise<TeamEstimateResponse> {
  const res = await h.call("POST", `/api/teams/${teamId}/estimate`, { headers: h.headers.mutating, body: { directory: h.directory, rootId: null } });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamEstimateResponse>();
}

const corpsLancement = (h: Banc, estimateSha256: string) => ({
  directory: h.directory,
  rootId: null,
  demande: DEMANDE,
  fichiers: [],
  agentConversation: "build",
  estimateSha256,
  confirmations: {},
});

async function lancer(h: Banc, teamId: string, estimateSha256: string): Promise<TeamRunStarted> {
  const res = await h.call("POST", `/api/teams/${teamId}/run`, { headers: h.headers.mutating, body: corpsLancement(h, estimateSha256) });
  assert.equal(res.status, 202, res.body);
  return res.json<TeamRunStarted>();
}

async function vue(h: Banc, runId: string): Promise<TeamRunView> {
  const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamRunView>();
}

async function attendre(h: Banc, runId: string, predicat: (view: TeamRunView) => boolean, libelle: string, timeoutMs = 10_000): Promise<TeamRunView> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const courante = await vue(h, runId);
    if (predicat(courante)) return courante;
    if (Date.now() > limite) {
      const erreurs = (h.db.prepare("SELECT step_id, tour, state, cause FROM team_run_steps WHERE run_id = ? AND cause IS NOT NULL").all(runId) as Array<{
        step_id: string;
        tour: number;
        state: string;
        cause: string;
      }>).map((row) => `${row.step_id}/t${row.tour}=${row.state} (${row.cause})`);
      throw new Error(
        `${libelle} : état ${courante.state}, étapes ${courante.steps.map((step) => `${step.stepId}=${step.state}`).join(", ")}${
          erreurs.length === 0 ? "" : ` — erreurs : ${erreurs.join(" ; ")}`
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const continuer = (h: Banc, runId: string, body: Record<string, unknown>) =>
  h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body });

/** Sessions d'étape créées par le serveur pour CE lancement (`POST /session`, marque « equipe »). */
const creationsDEtape = (h: Banc, runId: string) =>
  h.fake.requests.filter(
    (req) => req.method === "POST" && req.pathname === "/session" && (req.body as { metadata?: { cockpit?: string; run?: string } })?.metadata?.run === runId,
  );

const envois = (h: Banc) => h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async"));

const texteDe = (parts: unknown): string => (Array.isArray(parts) ? parts.map((part) => (part as { text?: string }).text ?? "").join("") : "");

/** Corps successivement ENVOYÉS à une session (messages « user »), dans l'ordre des tours. */
const corpsEnvoyes = (h: Banc, sessionId: string): string[] =>
  h.fake
    .messages(sessionId)
    .filter((message) => (message as { info: { role: string } }).info.role === "user")
    .map((message) => texteDe((message as { parts: unknown }).parts));

/** Session enregistrée pour une étape : les tours d'une relecture en partagent une seule (D-5-14). */
const sessionDe = (h: Banc, stepId: string): string => {
  const row = h.db
    .prepare("SELECT session_id FROM team_run_steps WHERE step_id = ? AND session_id IS NOT NULL ORDER BY tentative DESC, tour DESC LIMIT 1")
    .get(stepId) as { session_id: string } | undefined;
  return row?.session_id ?? "";
};

/** P4 : aucune règle permissive envoyée hors du plancher ETAPE d'une session d'étape. */
function assertNoLooseRules(h: Banc): void {
  for (const req of h.fake.requests) {
    const body = req.body as { permission?: unknown; metadata?: { cockpit?: string } } | undefined;
    const rules = body?.permission;
    if (!Array.isArray(rules)) continue;
    if (rules.every((rule) => (rule as { action?: string }).action === "deny")) continue;
    assert.equal(body?.metadata?.cockpit, "equipe", `règles permissives hors d'une session d'étape : ${req.method} ${req.pathname}`);
  }
}

// --- 1. Relecture : exemple installé, lancé, deux tours, deux sessions ---------------------------------------------------------

describe("croisement V2 : « Compte rendu d'incident relu » installé puis lancé, deux tours", () => {
  it("deux tours de relecture : EXACTEMENT 2 `POST /session` pour le bloc, méthode « 5 pourquoi » dans le corps de la rédaction", async (t) => {
    const h = await banc(t);
    const exemple = await installerExemple(h, "postmortem");
    assert.equal(exemple.team.id, "postmortem");

    // Tour 1 : premier jet, verdict « à reprendre » ; tour 2 : version corrigée, verdict concluant.
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redaction",
      { text: "Compte rendu, premier jet.", cost: 0.01, tokens: { input: 80, output: 30 }, stepMs: 5 },
      { text: "Compte rendu, version corrigée.", cost: 0.01, tokens: { input: 80, output: 30 }, stepMs: 5 },
    );
    h.fake.scriptWhen(
      (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relecture",
      { text: "Les causes ne sont pas étayées.\nVERDICT: À REPRENDRE", cost: 0.01, tokens: { input: 60, output: 20 }, stepMs: 5 },
      { text: "Tout est étayé.\nVERDICT: RIEN À REPRENDRE", cost: 0.01, tokens: { input: 60, output: 20 }, stepMs: 5 },
    );

    const estimation = await estimer(h, "postmortem");
    assert.equal(estimation.blocage, null, JSON.stringify(estimation.blocage));
    const lancement = await lancer(h, "postmortem", estimation.estimateSha256);

    // L'exemple pose une pause pour vérifier le premier jet (pauseAvantRelecture) : elle est franchie UNE fois.
    const enPause = await attendre(h, lancement.runId, (view) => view.state === "attente-verification", "pause avant la relecture");
    assert.equal(enPause.pause?.kind, "verification");
    const reprise = await continuer(h, lancement.runId, {});
    assert.equal(reprise.status, 200, reprise.body);

    const finie = await attendre(h, lancement.runId, (view) => view.state === "terminee", "fin du lancement");

    // (1) D-5-14 : deux sessions pour tout le bloc, quel que soit le nombre de tours.
    assert.equal(creationsDEtape(h, lancement.runId).length, 2, "une session par étape du bloc, jamais une de plus au tour 2");
    // (2) Deux tours ont bien eu lieu : deux envois dans CHAQUE session, et la seconde ligne porte le verdict concluant.
    const sessionAuteur = sessionDe(h, "redaction");
    const sessionRelecteur = sessionDe(h, "relecture");
    assert.equal(corpsEnvoyes(h, sessionAuteur).length, 2, "l'auteur reçoit la correction dans SA session");
    assert.equal(corpsEnvoyes(h, sessionRelecteur).length, 2, "le relecteur relit dans SA session");
    const verdicts = h.db.prepare("SELECT tour, verdict FROM team_run_steps WHERE step_id = 'relecture' ORDER BY tour").all() as Array<{
      tour: number;
      verdict: string | null;
    }>;
    assert.deepEqual(
      verdicts.map((row) => [row.tour, row.verdict]),
      [
        [1, "a-reprendre"],
        [2, "rien-a-reprendre"],
      ],
    );

    // (3) La méthode « 5 pourquoi » du catalogue (L44a) est arrivée dans le corps du PREMIER envoi à l'étape de rédaction.
    const premierEnvoi = corpsEnvoyes(h, sessionAuteur)[0] ?? "";
    assert.ok(premierEnvoi.includes(METHODE_HEADER.replace("{titre}", CINQ_POURQUOI.titre)), "en-tête de la méthode absent du corps envoyé");
    assert.ok(premierEnvoi.includes(CINQ_POURQUOI.bloc), "bloc de la méthode absent du corps envoyé");
    // Le relecteur, lui, n'en déclare aucune : le cockpit n'en ajoute jamais de lui-même.
    assert.ok(!(corpsEnvoyes(h, sessionRelecteur)[0] ?? "").includes("## Méthode : "), "aucune méthode n'est ajoutée à une étape qui n'en déclare pas");

    // (4) Plancher ETAPE : posé à la CRÉATION de la session, identique pour les deux étapes, jamais renvoyé au tour 2.
    const planchers = creationsDEtape(h, lancement.runId).map((req) => canonicalRules((req.body as { permission: Rule[] }).permission));
    assert.equal(planchers.length, 2);
    for (const plancher of planchers) assert.ok(plancher.length > 0, "plancher ETAPE vide");
    const planchersApres = h.fake.requests.filter((req) => req.pathname.endsWith("/prompt_async") && (req.body as { permission?: unknown }).permission !== undefined);
    assert.deepEqual(planchersApres, [], "aucune règle envoyée avec un `prompt_async` : le plancher tient de la création");
    assertNoLooseRules(h);

    // (5) Déroulé d'équipe (L42c) sur les lignes RÉELLEMENT enregistrées : « ×2 » et l'écart des tours.
    const deroule = buildTeamDeroule(finie, true, Date.now());
    assert.ok(
      deroule.lignes.some((ligne) => ligne.repetition === "×2"),
      `aucune ligne « ×2 » : ${JSON.stringify(deroule.lignes.map((ligne) => [ligne.cle, ligne.repetition]))}`,
    );
    assert.ok(deroule.ecarts.includes("Prévu : jusqu'à 2 tours · Réel : 2 tours"), JSON.stringify(deroule.ecarts));
    assert.deepEqual(
      deroule.lignes.filter((ligne) => ligne.tour !== null).map((ligne) => ligne.tour),
      ["tour 2", "tour 2"],
      "« tour {n} » à partir du deuxième tour seulement",
    );
    h.assertNoGlobalRestart();
  });

  it("verdict concluant au tour 1 : un seul tour, et le Déroulé dit « Prévu : jusqu'à 2 tours · Réel : 1 tour »", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "postmortem");
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "redaction", {
      text: "Compte rendu, version unique.",
      cost: 0.01,
      stepMs: 5,
    });
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "relecture", {
      text: "Rien à signaler.\nVERDICT: RIEN À REPRENDRE",
      cost: 0.01,
      stepMs: 5,
    });

    const estimation = await estimer(h, "postmortem");
    const lancement = await lancer(h, "postmortem", estimation.estimateSha256);
    await attendre(h, lancement.runId, (view) => view.state === "attente-verification", "pause avant la relecture");
    assert.equal((await continuer(h, lancement.runId, {})).status, 200);
    const finie = await attendre(h, lancement.runId, (view) => view.state === "terminee", "fin du lancement");

    assert.equal(creationsDEtape(h, lancement.runId).length, 2, "deux étapes, deux sessions");
    assert.equal(corpsEnvoyes(h, sessionDe(h, "relecture")).length, 1, "un seul tour de relecture");
    const deroule = buildTeamDeroule(finie, true, Date.now());
    assert.ok(deroule.ecarts.includes("Prévu : jusqu'à 2 tours · Réel : 1 tour"), JSON.stringify(deroule.ecarts));
    assert.deepEqual(
      deroule.lignes.map((ligne) => ligne.repetition),
      deroule.lignes.map(() => null),
      "aucun « ×n » quand le bloc n'a fait qu'un tour",
    );
    h.assertNoGlobalRestart();
  });
});

// --- 2. Aiguillage : rien ne part avant votre confirmation ----------------------------------------------------------------------

describe("croisement V2 : « Tri d'une alerte » installé puis lancé, votre choix seul (spéc. §4.11 l.772)", () => {
  it("aucun `prompt_async` de spécialiste avant `continue` ; choix invalide → 409 sans envoi ; deux choix, puis la synthèse", async (t) => {
    const h = await banc(t);
    const exemple = await installerExemple(h, "tri-alerte");
    const flow = exemple.team.flow;
    const specialistes = etapesDe(flow).filter((etape) => !["aiguilleur", "synthese"].includes(etape.id));
    assert.equal(specialistes.length, 5, "cinq spécialistes au déroulé (C §12.1)");

    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "aiguilleur", {
      text: `Les temps de réponse pointent le lien.\nCHOIX: ${TRI.reseau.titre}, ${TRI["base-de-donnees"].titre}`,
      cost: 0.01,
      stepMs: 5,
    });
    for (const etape of etapesDe(flow)) {
      if (etape.id === "aiguilleur") continue;
      h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === etape.id, {
        text: `Avis de ${etape.titre}.`,
        cost: 0.01,
        stepMs: 5,
      });
    }

    const estimation = await estimer(h, "tri-alerte");
    const lancement = await lancer(h, "tri-alerte", estimation.estimateSha256);
    const enChoix = await attendre(h, lancement.runId, (view) => view.state === "attente-choix", "pause de choix");

    // (1) Rien n'est parti au-delà de l'aiguilleur : un seul envoi, celui de l'aiguilleur.
    assert.equal(envois(h).length, 1, "aucun spécialiste n'est parti avant votre réponse");
    assert.equal(creationsDEtape(h, lancement.runId).length, 1, "aucune session de spécialiste ouverte avant votre réponse");
    assert.equal(enChoix.pause?.kind, "choix");
    assert.deepEqual(
      enChoix.pause?.choix?.filter((entree) => entree.propose).map((entree) => entree.stepId),
      ["reseau", "base-de-donnees"],
      "la proposition de l'aiguilleur est rendue, cochée, mais jamais confirmée d'elle-même",
    );
    assert.equal(enChoix.pause?.choixMax, 2);
    // La PROPOSITION n'est pas un choix confirmé : la colonne `choix` de l'aiguilleur reste vide tant que vous n'avez pas répondu.
    const avantReponse = h.db.prepare("SELECT choix FROM team_run_steps WHERE step_id = 'aiguilleur' ORDER BY tour DESC LIMIT 1").get() as
      | { choix: string | null }
      | undefined;
    assert.equal(avantReponse?.choix ?? null, null, "une proposition ne vaut jamais confirmation");

    // (2) Un choix hors de la liste : 409 `choix-invalide`, AVANT toute écriture, sans la moindre requête.
    const repere = h.repere();
    const refus = await continuer(h, lancement.runId, { choix: ["pas-un-specialiste"] });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "choix-invalide");
    assert.deepEqual(h.depuis(repere), [], "rien n'a été envoyé ni facturé pendant le refus");
    assert.equal((await vue(h, lancement.runId)).state, "attente-choix", "la pause tient");

    // (3) Votre choix : les deux spécialistes retenus partent, les trois autres passent « non-choisi », la synthèse rassemble.
    // « base-de-donnees » est le TROISIÈME de la liste, donc HORS du chemin d'estimation (qui ne compte que `choixMax` = 2
    // spécialistes) : c'est exactement le cas que le train de la vague 2 a corrigé au pré-lancement, faute de quoi l'étape
    // échouait avec « étape inconnue de l'instantané du lancement ».
    const accepte = await continuer(h, lancement.runId, { choix: ["reseau", "base-de-donnees"] });
    assert.equal(accepte.status, 200, accepte.body);
    const finie = await attendre(h, lancement.runId, (view) => view.state === "terminee", "fin du lancement");

    const etats = new Map(finie.steps.map((step) => [step.stepId, step.state]));
    assert.equal(etats.get("reseau"), "terminee");
    assert.equal(etats.get("base-de-donnees"), "terminee");
    for (const stepId of ["supervision", "application", "stockage"]) assert.equal(etats.get(stepId), "non-choisi", stepId);
    assert.equal(etats.get("synthese"), "terminee", "la synthèse travaille dès que deux avis sont choisis");
    for (const step of finie.steps) if (step.state === "non-choisi") assert.equal(step.cost, 0, `${step.stepId} : un écarté ne coûte rien`);

    // (4) Déroulé d'équipe (L42c) : « Non choisi » et l'écart des spécialistes, lus sur le lancement RÉEL.
    const deroule = buildTeamDeroule(finie, true, Date.now());
    const nonChoisis = deroule.lignes.filter((ligne) => ligne.reel === "Non choisi");
    assert.equal(nonChoisis.length, 3, JSON.stringify(deroule.lignes.map((ligne) => [ligne.cle, ligne.reel])));
    for (const ligne of nonChoisis) {
      assert.equal(ligne.icone, "minus");
      assert.equal(ligne.bars.length, 0, "un écarté n'a ni barre…");
      assert.equal(ligne.cost, 0, "…ni coût");
    }
    assert.ok(deroule.ecarts.includes("Prévu : jusqu'à 2 spécialistes · Réel : 2"), JSON.stringify(deroule.ecarts));
    assertNoLooseRules(h);
    h.assertNoGlobalRestart();
  });

  it("« aucun ne convient » : aucun spécialiste ne part, rien n'est facturé, tout le bloc est « Non choisi »", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "tri-alerte");
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === "aiguilleur", {
      text: "Aucun de ces spécialistes ne couvre l'alerte.\nCHOIX: aucun",
      cost: 0.01,
      stepMs: 5,
    });

    const estimation = await estimer(h, "tri-alerte");
    const lancement = await lancer(h, "tri-alerte", estimation.estimateSha256);
    await attendre(h, lancement.runId, (view) => view.state === "attente-choix", "pause de choix");

    const repere = h.repere();
    const reponse = await continuer(h, lancement.runId, { aucun: true });
    assert.equal(reponse.status, 200, reponse.body);
    const finie = await attendre(h, lancement.runId, (view) => view.state === "terminee", "fin du lancement");

    assert.deepEqual(h.depuis(repere).filter((ligne) => ligne.endsWith("/prompt_async")), [], "aucun envoi après « aucun ne convient »");
    const ecartes = finie.steps.filter((step) => step.state === "non-choisi");
    assert.equal(ecartes.length, 6, "les cinq spécialistes ET la synthèse sont écartés");
    assert.equal(
      ecartes.reduce((somme, step) => somme + step.cost, 0),
      0,
    );
    const deroule = buildTeamDeroule(finie, true, Date.now());
    assert.ok(deroule.ecarts.includes("Prévu : jusqu'à 2 spécialistes · Réel : 0"), JSON.stringify(deroule.ecarts));
    h.assertNoGlobalRestart();
  });
});

// --- 3. Refus de pré-lancement « methodes » : zéro requête (A4) -----------------------------------------------------------------

describe("croisement V2 : refus de pré-lancement `methodes` par la VRAIE route (A4)", () => {
  it("méthode déjà posée dans le fichier de l'assistant : 422 `equipe-invalide`, ZÉRO requête reçue par le faux", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "postmortem");

    // La méthode de l'étape est posée APRÈS coup dans le fichier de l'auteur : le contexte `methods` de L45b la voit.
    const fichier = await h.deps.studio.get("agents", AUTEUR, { scope: "global", project: null } as never);
    h.poser("agents", AUTEUR, applyMethodBlocks((fichier as { body?: string } | null)?.body ?? "Tu rédiges.", [CINQ_POURQUOI]));

    // L'estimation, seule à lire, voit déjà le blocage et le dit.
    const estimation = await estimer(h, "postmortem");
    assert.equal(estimation.blocage?.code, "equipe-invalide", JSON.stringify(estimation.blocage));
    assert.ok(estimation.problems.some((probleme) => probleme.code === "methodes" && probleme.bloquant), JSON.stringify(estimation.problems));

    // Le lancement, lui, n'émet RIEN : le refus est rendu sans la moindre requête.
    const repere = h.repere();
    const refus = await h.call("POST", "/api/teams/postmortem/run", { headers: h.headers.mutating, body: corpsLancement(h, estimation.estimateSha256) });
    assert.equal(refus.status, 422, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "equipe-invalide");
    assert.deepEqual(h.depuis(repere), [], "aucune requête pendant un refus de pré-lancement (A4)");
    assert.equal(envois(h).length, 0, "aucun `prompt_async` n'est jamais parti");
    h.assertNoGlobalRestart();
  });
});

// --- 4. Exemples : les six, en Simple, et l'installation idempotente ------------------------------------------------------------

describe("croisement V2 : les six exemples de C §12.1, installés par leur route", () => {
  it("les six sont valides en Simple avec le catalogue réel, et `EQUIPES_SIMPLE_OUVERTES` reste false (U1)", async (t) => {
    const h = await banc(t);
    const attendus = ["revue-sql", "relecture-script", "enquete-incident", "revue-changement-cab", "postmortem", "tri-alerte"];
    const listeAvant = await h.call("GET", "/api/teams", { headers: h.headers.authed });
    assert.equal(listeAvant.status, 200, listeAvant.body);
    assert.deepEqual(
      listeAvant.json<TeamsListResponse>().exemples.map((exemple) => exemple.id),
      attendus,
    );
    assert.equal(listeAvant.json<TeamsListResponse>().ouvertesEnSimple, false);
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false, "l'ouverture en Simple tient en UNE ligne, qui reste fausse dans la branche");

    for (const id of attendus) {
      const installe = await installerExemple(h, id);
      const assistants = etapesDe(installe.team.flow).map((etape) => ({
        name: etape.assistant,
        title: etape.assistant,
        origin: "catalogue" as const,
        rights: "lecture" as const,
        mode: "primary" as const,
        hidden: false,
        rules: readOnlyRules() as Rule[],
        model: "github-copilot/gpt-5-mini",
        available: true,
        steps: 40,
        taille: "M" as const,
      }));
      for (const mode of ["simple", "avance"] as const) {
        const problemes = validateFlow(installe.team.flow, {
          assistants,
          mode,
          niveauDisponible: () => true,
          // Contexte des méthodes tel que le service le bâtit (L45b, C §5.2) : catalogue des méthodes « consigne », et aucune
          // méthode déjà posée dans le fichier de l'assistant.
          methods: { consigne: new Set(METHODS.filter((methode) => methode.kind === "consigne").map((methode) => methode.id)), parAssistant: () => new Set<string>() },
        }).filter((probleme) => probleme.bloquant);
        assert.deepEqual(problemes, [], `${id} refusé en mode ${mode} : ${JSON.stringify(problemes)}`);
      }
    }
    assert.ok(FLOW_LIMITS.choixMax >= 2 && FLOW_LIMITS.toursMax >= 2, "bornes de la 5b présentes");
    h.assertNoGlobalRestart();
  });

  it("installation idempotente : le second appel n'écrit plus rien, et une fiche modifiée à la main n'est jamais écrasée", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "postmortem");
    const apresPremier = [...h.ecrits];
    assert.ok(apresPremier.length > 0, "le premier appel installe les assistants manquants");

    // Une fiche est modifiée à la main entre les deux installations : elle doit rester telle quelle.
    const marque = "Texte écrit à la main, à ne jamais écraser.";
    h.poser("agents", RELECTEUR, marque);

    await installerExemple(h, "postmortem");
    assert.deepEqual(h.ecrits, apresPremier, "le second appel n'écrit rien de plus");
    const fiche = await h.deps.studio.get("agents", RELECTEUR, { scope: "global", project: null } as never);
    assert.equal((fiche as { body?: string } | null)?.body, marque);
    h.assertNoGlobalRestart();
  });

  it("`exampleFlow` renomme les étapes des deux formes de la 5b : aucun identifiant de catalogue n'arrive à l'exécution", () => {
    const noms = new Map([
      [AUTEUR, "auteur-2"],
      [RELECTEUR, "relecteur-2"],
    ]);
    const exemple = TEAM_EXAMPLES.find((candidat) => candidat.id === "postmortem");
    assert.ok(exemple);
    const flow = exampleFlow(exemple, noms);
    const assistants = etapesDe(flow).map((etape) => etape.assistant);
    assert.deepEqual(assistants, ["auteur-2", "relecteur-2"]);
  });
});
