// Tests de croisement du train it4 V3 (plan d'exécution it4 §2.4, §5.2 ligne V3 ; propriété de l'intégrateur). Les deux paquets
// de la vague ont été écrits en parallèle, sans se lire : L40b (éditeur guidé et son module pur `shared/flow-edit.ts`) et L38c
// (Déroulé « Prévu / Réel », transcription, tiroir de lecture d'une étape, réglages d'équipe, avis Simple de délégation). Chacun
// a testé son modèle pur sur des données FABRIQUÉES à la main.
// Ce que ces tests ajoutent, et qu'aucun des deux ne peut prouver seul : les modèles purs sont nourris par les VRAIES réponses du
// cockpit complet (les cinq modules d'équipes, aucun `eqPorts`), avec le faux opencode :
//   1. ÉDITEUR → APERÇU → PUT → LANCEMENT : un déroulé construit pièce à pièce par `flow-edit.ts` passe `POST /api/teams/preview`
//      (aucun problème), son écran 4 devient enregistrable, `identifiantEquipe` et `corpsEnregistrement` composent le `PUT`, et
//      l'équipe ainsi enregistrée se lance vraiment, avec EXACTEMENT les étapes du brouillon ;
//   2. DÉROULÉ « PRÉVU / RÉEL » = ÉTAT DES ÉTAPES : sur un lancement réel (exemple à la suite, avec une pause pour vérifier),
//      chaque ligne porte le mot de l'état réellement enregistré, une étape jamais commencée n'a NI barre NI durée, la pause
//      prévue par le déroulé est « prévue » et la pause d'un incident (contrôle de fraîcheur) ne l'est pas ;
//   3. TRANSCRIPTION : les messages RÉELLEMENT injectés par le runner dans la racine (`injectionText` de L37b) sont reconnus par
//      leur IDENTIFIANT seul ; la demande est rendue sans marqueur ni encadrement avec la puce « Envoyé à l'équipe », le résultat
//      n'apparaît qu'une fois (carte de la transcription, et `buildTeamRunCard` n'en rend aucune puisque `resultMessageId` est
//      rempli), et un marqueur `cockpit:equipe-*` tapé par l'utilisateur reste une bulle ordinaire ;
//   4. TIROIR DE LECTURE : la consigne réellement envoyée à une session d'étape est rendue sans aucune ligne `cockpit:`, sous la
//      puce « Consigne envoyée par le cockpit » ;
//   5. AVIS SIMPLE = CONSTANTE, et RÉGLAGES D'ÉQUIPE EN AVANCÉ SEULEMENT : `avisDelegationSimple` suit `ouvertesEnSimple` de
//      `GET /api/teams`, et le vrai `PUT /api/settings` refuse les chemins `teams.*` en mode Simple ;
//   6. OUVERTURE EN UNE LIGNE (U1) : avec `simpleOuvertes: true` SEULEMENT (surcharge de test de `buildEquipes`), en mode Simple,
//      les six routes fermées sont acceptées, le lanceur et l'onglet Équipes s'ouvrent, l'éditeur se monte et l'avis de délégation
//      passe au texte complet avec [Voir les équipes]. Sans elle, tout reste fermé.
// Hors de ce fichier, tenus par les suites des paquets : opérations d'édition et historique (flow-edit.test.ts), contrats statiques
// des composants (web-team-deroule.test.ts, web-team-transcript.test.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import type { AssistantService } from "./assistants.ts";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { AssistantView } from "./shared/api-types.ts";
import { avisDelegationSimple, TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import {
  brouillonDeForme,
  buildEditor,
  corpsEnregistrement,
  type EditorAssistantView,
  type EditorInput,
  historiqueDe,
  identifiantEquipe,
  modifierEtape,
} from "./shared/flow-edit.ts";
import { flowAsList } from "./shared/flow-layout.ts";
import { planSteps } from "./shared/team-limits.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  FlowStep,
  TeamEstimateResponse,
  TeamInstallResponse,
  TeamPreviewResponse,
  TeamRunStarted,
  TeamRunView,
  TeamsListResponse,
  TeamView,
} from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import type { TierService } from "./tiers.ts";
import { buildEquipes, EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { buildTeamDeroule } from "../web/pages/chat/team/deroule-model.ts";
import { vueLanceur } from "../web/pages/chat/team/launch-sheet-model.ts";
import {
  messageText,
  puceConsigne,
  puceInjection,
  stepOpeningOf,
  teamInjectionOf,
  type TranscriptMessageLike,
} from "../web/pages/chat/team/team-transcript.ts";
import { buildTeamRunCard } from "../web/pages/chat/team/team-view-model.ts";
import { buildTeamsTab } from "../web/pages/assistants/teams/teams-tab-model.ts";

const E = TEXTES.partout;
/** Textes de l'éditeur guidé (L40b, T4t) : `partout.editeur`. */
const ED = TEXTES.partout.editeur;
const SCRIPT = "relire-script";
const DEMANDE = "Relis le script de sauvegarde de la nuit.";

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
  repere(): number;
  /** Requêtes reçues par le faux depuis un repère, SAUF le sondage `GET /session/status` de la 1.1. */
  depuis(repere: number): Array<{ method: string; pathname: string }>;
}

/** Cockpit de production : modules 1.1 « tous », les CINQ modules d'équipes réels, AUCUN port d'équipe surchargé. */
async function banc(t: TestContext, options: { settings?: Record<string, unknown>; equipes?: "aucun" } = {}): Promise<Banc> {
  const { studio, ecrits } = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" }, ...(options.settings ?? {}) },
    modules: "tous",
    equipes:
      options.equipes === "aucun"
        ? []
        : [
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
    repere: () => h.fake.requests.length,
    depuis: (repere: number) =>
      h.fake.requests
        .slice(repere)
        .map((req) => ({ method: req.method, pathname: req.pathname }))
        .filter((req) => !(req.method === "GET" && req.pathname === "/session/status")),
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
  steps: 20,
});

const liste = async (h: CockpitHarness): Promise<TeamsListResponse> => {
  const res = await h.call("GET", "/api/teams", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamsListResponse>();
};

/** Installe un exemple et déclare ses assistants au faux opencode, pour que le pré-lancement réel les retrouve par `GET /agent`. */
async function installerExemple(h: Banc, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = [...new Set(etapesDe(body.team.flow).map((etape) => etape.assistant))].filter((nom) => !connus.has(nom));
  if (manquants.length > 0) {
    h.fake.setAgents([...h.fake.agents(), ...manquants.map(fakeAgent)]);
    // Le cockpit invalide son instantané d'agents sur les événements d'opencode ; ici, le faux change sans en publier.
    h.deps.lookup.invalidate();
  }
  return body;
}

/** Étapes déclarées d'un déroulé, dans l'ordre d'écriture. */
function etapesDe(flow: Flow): FlowStep[] {
  return flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : []));
}

async function estimer(h: Banc, teamId: string): Promise<TeamEstimateResponse> {
  const res = await h.call("POST", `/api/teams/${teamId}/estimate`, { headers: h.headers.mutating, body: { directory: h.directory, rootId: null } });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamEstimateResponse>();
}

async function lancer(h: Banc, teamId: string, estimateSha256: string): Promise<TeamRunStarted> {
  const res = await h.call("POST", `/api/teams/${teamId}/run`, {
    headers: h.headers.mutating,
    body: { directory: h.directory, rootId: null, demande: DEMANDE, fichiers: [], agentConversation: "build", estimateSha256, confirmations: {} },
  });
  assert.equal(res.status, 202, res.body);
  return res.json<TeamRunStarted>();
}

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
    if (Date.now() > limite) {
      throw new Error(`${libelle} : état ${courante.state}, étapes ${courante.steps.map((step) => `${step.stepId}=${step.state}`).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Chaque étape répond son texte, sans outil : le lancement va au bout sans attendre. */
function scripterEtapes(h: Banc, texte = "Constat de l'étape."): void {
  h.fake.scriptWhen((session) => (session.metadata as { cockpit?: string } | undefined)?.cockpit === "equipe", {
    text: texte,
    cost: 0.01,
    tokens: { input: 100, output: 30 },
    stepMs: 5,
  });
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

/** Assistants tels que l'éditeur les lit (GET /api/assistants) : la vue du serveur, sans transformation. */
async function assistantsDe(h: Banc): Promise<EditorAssistantView[]> {
  const res = await h.call("GET", "/api/assistants", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<{ assistants: AssistantView[] }>().assistants;
}

/** Entrée de `buildEditor` : les valeurs par défaut de l'éditeur, complétées par le test. */
function entree(over: Partial<EditorInput> = {}): EditorInput {
  return {
    mode: "nouvelle",
    advanced: true,
    ouvertesEnSimple: false,
    ecran: 1,
    historique: historiqueDe(brouillonDeForme("a-la-suite")),
    titre: "",
    description: "",
    apercu: null,
    liste: [],
    exemples: [],
    assistants: [],
    niveaux: [],
    nomsPris: [],
    chargement: false,
    erreur: null,
    ...over,
  };
}

// --- 1. Éditeur guidé (L40b) → aperçu → PUT → lancement -------------------------------------------------------------------------

describe("croisement it4 V3 : l'éditeur guidé produit une équipe que le cockpit lance vraiment", () => {
  it("brouillon de flow-edit → POST /api/teams/preview sans problème → PUT → run : les étapes lancées sont celles du brouillon", async (t) => {
    const h = await banc(t);
    // L'exemple installe l'assistant du catalogue `relire-script` : l'éditeur choisit ensuite un assistant RÉELLEMENT installé.
    const exemple = await installerExemple(h, "relecture-script");
    const assistants = await assistantsDe(h);
    const choisi = assistants.find((assistant) => assistant.name === SCRIPT);
    assert.ok(choisi, `assistant ${SCRIPT} absent de GET /api/assistants : ${assistants.map((a) => a.name).join(", ")}`);

    // Écran 1 puis écran 2 : la forme « À la suite », deux étapes que l'on règle une à une (modules purs de L40b).
    let historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const ids = etapesDe(historique.present.flow).map((etape) => etape.id);
    assert.equal(ids.length, 2, "la forme « À la suite » pose deux étapes");
    for (const [index, stepId] of ids.entries()) {
      historique = {
        ...historique,
        present: modifierEtape(
          historique.present,
          stepId as string,
          { assistant: SCRIPT, titre: index === 0 ? "Relecture des standards" : "Relecture de sécurité", taille: "S", consigne: "" },
          { simple: false },
        ),
      };
    }
    const brouillon = historique.present;

    // Aperçu par la VRAIE route : la grammaire du serveur ne trouve aucun problème sur ce brouillon.
    const apercuRes = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: brouillon.flow } });
    assert.equal(apercuRes.status, 200, apercuRes.body);
    const apercu = apercuRes.json<TeamPreviewResponse>();
    assert.deepEqual(apercu.problems, [], JSON.stringify(apercu.problems));
    assert.ok(apercu.estimate !== null, "l'aperçu chiffre le déroulé");
    assert.ok(apercu.liste.length > 0, "l'aperçu rend la vue liste (lecteur d'écran)");

    // Écran 4 nourri par cet aperçu : enregistrable, aucun problème bloquant, nom accepté.
    const nomsPris = (await liste(h)).teams.map((team) => team.titre);
    const commun = { historique, titre: "Relecture maison", apercu, assistants, liste: flowAsList(brouillon.flow, new Map()), nomsPris };
    const editeur = buildEditor(entree({ ...commun, ecran: 4 }));
    assert.equal(editeur.affichage, "editeur");
    assert.equal(editeur.apercuDemande, true, "un brouillon non vide demande son aperçu");
    assert.deepEqual(editeur.problemes, []);
    assert.equal(editeur.ecran4?.nom.erreur, null);
    assert.equal(editeur.ecran4?.refus, null);
    assert.equal(editeur.ecran4?.enregistrable, true, "écran 4 enregistrable après un aperçu sans problème");
    assert.deepEqual([...(editeur.ecran4?.liste ?? [])], apercu.liste, "la liste montrée est celle du serveur");

    // Un nom déjà pris (celui de l'exemple installé) est refusé AVANT l'envoi : rien n'est enregistré.
    const repris = buildEditor(entree({ ...commun, ecran: 4, titre: exemple.team.titre }));
    assert.equal(repris.ecran4?.nom.erreur, ED.verifier.nomPris);
    assert.equal(repris.ecran4?.enregistrable, false);

    // Écran 4 → PUT : l'identifiant et le corps viennent tous deux du module pur.
    const equipeId = identifiantEquipe("Relecture maison", (await liste(h)).teams.map((team) => team.id));
    const corps = corpsEnregistrement({ titre: "Relecture maison", description: "Deux relectures à la suite.", draft: brouillon });
    const put = await h.call("PUT", `/api/teams/${equipeId}`, { headers: h.headers.mutating, body: corps });
    assert.equal(put.status, 200, put.body);
    const enregistree = put.json<TeamView>();
    assert.equal(enregistree.etat, "ok");
    assert.deepEqual(enregistree.flow, brouillon.flow, "le déroulé enregistré est EXACTEMENT celui du brouillon");

    // …et cette équipe se lance : les étapes réellement exécutées sont celles du brouillon, dans l'ordre de planSteps.
    scripterEtapes(h);
    const estimation = await estimer(h, equipeId);
    assert.equal(estimation.blocage, null, "aucun refus prévisible sur ce banc");
    const { runId } = await lancer(h, equipeId, estimation.estimateSha256);
    const finie = await attendre(h, runId, (v) => v.state === "terminee", "équipe de l'éditeur terminée");
    assert.deepEqual(
      finie.steps.map((step) => step.stepId),
      planSteps(brouillon.flow).map((planned) => planned.stepId),
    );
    for (const step of finie.steps) assert.equal(step.state, "terminee", `état de ${step.stepId}`);
    h.assertNoGlobalRestart();
    assertNoLooseRules(h);
  });
});

// --- 2. Déroulé « Prévu / Réel » (L38c) sur un lancement réel --------------------------------------------------------------------

describe("croisement it4 V3 : le Déroulé « Prévu / Réel » dit l'état réel des étapes", () => {
  it("pause pour vérifier : ligne de pause prévue, étapes non lancées sans barre ni durée, puis mots des états réels", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "relecture-script");
    scripterEtapes(h);
    const estimation = await estimer(h, "relecture-script");
    const { runId } = await lancer(h, "relecture-script", estimation.estimateSha256);

    // L'exemple « Chaîne de relecture de script » porte une pause pour vérifier après la première étape.
    const enPause = await attendre(h, runId, (v) => v.pause !== null && v.state === "attente-verification", "pause pour vérifier");
    assert.equal(enPause.pause?.kind, "verification");
    const modele = buildTeamDeroule(enPause, true, Date.now());
    const pause = modele.lignes.find((ligne) => ligne.kind === "pause");
    assert.ok(pause, `aucune ligne de pause : ${modele.lignes.map((l) => l.kind).join(", ")}`);
    assert.equal(pause.prevu, true, "la pause pour vérifier est prévue par le déroulé");
    assert.equal(pause.reel, E.etatsEquipe["attente-verification"]);
    assert.deepEqual(pause.bars.map((barre) => barre.kind), ["verification"]);

    // Chaque ligne d'étape porte le mot de l'état RÉELLEMENT enregistré ; aucune barre ni durée sans début enregistré.
    const lignesEtapes = modele.lignes.filter((ligne) => ligne.kind === "etape");
    assert.equal(lignesEtapes.length, enPause.steps.length);
    for (const [index, ligne] of lignesEtapes.entries()) {
      const step = enPause.steps[index];
      assert.ok(step);
      assert.equal(ligne.reel, E.etatsEtape[step.state], `mot de ${step.stepId}`);
      assert.equal(ligne.prevu, true);
      if (step.startedAt === null) {
        assert.deepEqual(ligne.bars, [], `barre inventée pour ${step.stepId}, jamais commencée`);
        assert.equal(ligne.start, null);
        assert.equal(ligne.durationMs, null);
      } else {
        assert.equal(ligne.bars.length, 1, `barre unique pour ${step.stepId}`);
        assert.equal(ligne.start, step.startedAt);
      }
    }
    assert.ok(
      lignesEtapes.some((ligne) => ligne.bars.length === 0),
      "au moins une étape n'a pas encore commencé au moment de la pause",
    );

    // Reprise : le Déroulé suit jusqu'au bout, sans ligne de pause et avec les mots des états finaux.
    const reprise = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: {} });
    assert.equal(reprise.status, 200, reprise.body);
    const finie = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée après la pause");
    const apres = buildTeamDeroule(finie, true, Date.now());
    assert.equal(apres.lignes.some((ligne) => ligne.kind === "pause"), false, "aucune pause quand l'équipe ne l'attend plus");
    assert.equal(apres.etatMot, E.etatsEquipe.terminee);
    for (const [index, ligne] of apres.lignes.entries()) {
      const step = finie.steps[index];
      assert.ok(step);
      assert.equal(ligne.reel, E.etatsEtape[step.state], `mot final de ${step.stepId}`);
      assert.equal(ligne.cost, step.cost, `coût de ${step.stepId}`);
    }
    h.assertNoGlobalRestart();
  });

  it("pause d'un incident (contrôle de fraîcheur) : « Prévu » à faux, barre d'attente de vous", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    scripterEtapes(h);
    const estimation = await estimer(h, "revue-sql");
    // L'instantané est pris : la configuration d'opencode change ENSUITE (D-eq-17, contrôle de fraîcheur).
    h.fake.globalConfig = { ...h.fake.globalConfig, mcp: { local: { type: "local", command: ["outil"], enabled: true } } };
    const { runId } = await lancer(h, "revue-sql", estimation.estimateSha256);
    const pause = await attendre(h, runId, (v) => v.pause !== null && v.state.startsWith("attente-"), "pause du contrôle de fraîcheur");
    assert.equal(pause.pause?.kind, "changement", `genre de pause : ${pause.pause?.kind}`);

    const ligne = buildTeamDeroule(pause, true, Date.now()).lignes.find((candidate) => candidate.kind === "pause");
    assert.ok(ligne, "ligne de pause absente");
    assert.equal(ligne.prevu, false, "une pause d'incident n'est JAMAIS présentée comme prévue par l'équipe");
    assert.deepEqual(ligne.bars.map((barre) => barre.kind), ["attente-vous"]);
    // Aucune étape n'a commencé : aucune barre, aucune durée.
    for (const etape of buildTeamDeroule(pause, true, Date.now()).lignes.filter((candidate) => candidate.kind === "etape")) {
      assert.deepEqual(etape.bars, [], "barre dessinée alors qu'aucune étape n'a commencé");
      assert.equal(etape.durationMs, null);
    }
    h.assertNoGlobalRestart();
  });
});

// --- 3 et 4. Transcription et tiroir de lecture (L38c) sur des messages réellement injectés ---------------------------------------

describe("croisement it4 V3 : transcription des messages réellement injectés", () => {
  it("demande sans marqueur avec sa puce, résultat une seule fois, marqueur tapé = bulle ordinaire, tiroir d'une étape sans marqueur", async (t) => {
    const h = await banc(t);
    await installerExemple(h, "revue-sql");
    scripterEtapes(h, "Deux jointures à revoir, et une colonne sensible à masquer.");
    const estimation = await estimer(h, "revue-sql");
    const { runId, rootId } = await lancer(h, "revue-sql", estimation.estimateSha256);
    const run = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");

    // Le runner a bien injecté les deux messages dans la racine, et retenu leurs identifiants (seule preuve admise, risque 19).
    assert.ok(run.requestMessageId, "identifiant du message de demande");
    assert.ok(run.resultMessageId, "identifiant du message de résultat");
    const messages = h.fake.messages(rootId) as unknown as TranscriptMessageLike[];
    const parId = new Map(messages.map((message) => [String(message.info.id), message]));
    const demande = parId.get(run.requestMessageId as string);
    const resultat = parId.get(run.resultMessageId as string);
    assert.ok(demande && resultat, "messages injectés absents de la racine");

    // Demande : bulle « Vous » SANS marqueur ni encadrement, sous la puce « Envoyé à l'équipe « … » ».
    const injectionDemande = teamInjectionOf(demande, [run]);
    assert.ok(injectionDemande, "la demande injectée n'est pas reconnue");
    assert.equal(injectionDemande.kind, "demande");
    assert.ok(injectionDemande.texte.includes(DEMANDE), "la demande recopiée est rendue");
    assert.equal(injectionDemande.texte.includes("cockpit:"), false, `marqueur visible : ${injectionDemande.texte}`);
    assert.equal(injectionDemande.texte.includes("<<<"), false, "ligne d'encadrement visible");
    assert.equal(puceInjection(injectionDemande), E.transcription.envoye.replace("{equipe}", run.titre));

    // Résultat : rendu par la carte de la transcription, jamais en bulle ; et L38b n'en rend AUCUNE de son côté.
    const injectionResultat = teamInjectionOf(resultat, [run]);
    assert.ok(injectionResultat, "le résultat injecté n'est pas reconnu");
    assert.equal(injectionResultat.kind, "resultat");
    assert.equal(injectionResultat.texte.includes("cockpit:"), false, "marqueur visible dans le résultat");
    assert.equal(injectionResultat.texte.includes(E.injection.donnees.split("{equipe}")[0] as string), false, "en-tête laissé visible");
    assert.ok(injectionResultat.texte.includes("Deux jointures à revoir"), "le texte du résultat est rendu");
    assert.equal(buildTeamRunCard(run, true).resultat, null, "une seconde carte de résultat serait un doublon (resultMessageId rempli)");

    // Marqueur RECOPIÉ par vous dans un message ordinaire : identifiant inconnu des lancements → bulle ordinaire.
    const faux: TranscriptMessageLike = {
      info: { id: "msg_tape_par_vous", sessionID: rootId, role: "user" },
      parts: [{ type: "text", text: `<!-- cockpit:equipe-resultat run=${run.id} -->\nJ'ai recopié ce marqueur moi-même.` }],
    };
    assert.equal(teamInjectionOf(faux, [run]), null, "un marqueur tapé ne doit jamais faire passer un message pour une injection");
    assert.ok(messageText(faux).includes("cockpit:equipe-resultat"), "le message tapé garde son texte, rendu en bulle ordinaire");

    // Tiroir de lecture d'une session d'étape : la consigne réellement envoyée, sans aucune ligne `cockpit:`.
    const etape = run.steps.find((step) => step.sessionId !== null);
    assert.ok(etape?.sessionId, "aucune session d'étape");
    const parSession = await h.call("GET", `/api/team-runs?sessionId=${encodeURIComponent(etape.sessionId)}`, { headers: h.headers.authed });
    assert.equal(parSession.status, 200, parSession.body);
    const lu = parSession.json<{ runs: TeamRunView[] }>().runs[0];
    assert.ok(lu, "GET /api/team-runs?sessionId= ne retrouve pas le lancement de l'étape");
    const premier = (h.fake.messages(etape.sessionId) as unknown as TranscriptMessageLike[]).find((message) => message.info.role === "user");
    assert.ok(premier, "la session d'étape n'a aucun message du cockpit");
    const ouverture = stepOpeningOf(premier, lu);
    assert.ok(ouverture, "la consigne de l'étape n'est pas reconnue");
    assert.equal(ouverture.titre, etape.titre);
    assert.equal(ouverture.texte.includes("cockpit:"), false, `marqueur visible dans le tiroir : ${ouverture.texte}`);
    assert.ok(ouverture.texte.includes(DEMANDE), "la consigne montrée est celle qui est partie");
    assert.equal(puceConsigne(ouverture.titre), E.transcription.consigne.replace("{titre}", etape.titre));

    // Une session qui n'est pas une étape (la racine) ne change rien au tiroir.
    assert.equal(stepOpeningOf({ info: { id: "m1", sessionID: rootId, role: "user" }, parts: [] }, lu), null);
    h.assertNoGlobalRestart();
    assertNoLooseRules(h);
  });
});

// --- 5. Avis Simple de délégation et réglages d'équipe ----------------------------------------------------------------------------

describe("croisement it4 V3 : avis Simple de délégation et réglages d'équipe", () => {
  it("l'avis suit `ouvertesEnSimple` de GET /api/teams, et les réglages `teams.*` sont refusés en mode Simple", async (t) => {
    const h = await banc(t, { settings: { ui: { mode: "simple" } } });
    const vueListe = await liste(h);
    assert.equal(vueListe.ouvertesEnSimple, false, "équipes fermées en Simple tant que la constante est fausse");
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);

    // Texte COURT et aucun bouton tant que les équipes sont fermées (U1, P3 : rien n'invite à une fonction refusée).
    const avis = avisDelegationSimple(vueListe.ouvertesEnSimple);
    assert.equal(avis.texte, DELEGATION.simple.avis);
    assert.equal(avis.bouton, null);
    assert.equal(avis.texte.includes("équipe"), false, `l'avis fermé ne parle pas des équipes : ${avis.texte}`);
    // La même fonction, ouverte, rend le texte complet et [Voir les équipes] : l'ouverture tient à cette seule valeur.
    const ouvert = avisDelegationSimple(true);
    assert.equal(ouvert.texte, DELEGATION.simple.avisEquipes);
    assert.deepEqual(ouvert.bouton, { libelle: DELEGATION.simple.voirEquipes, href: "#/assistants/equipes" });

    // Réglages d'équipe : chemins `teams.*`, hors SIMPLE_SETTINGS_PATHS → le vrai PUT /api/settings les refuse en Simple.
    const refus = await h.call("PUT", "/api/settings", { headers: h.headers.mutating, body: { teams: { concurrentSteps: 2 } } });
    assert.equal(refus.status, 403, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "mode-avance");
    h.assertNoGlobalRestart();
  });

  it("en mode Avancé, les mêmes réglages sont acceptés par le PUT /api/settings existant", async (t) => {
    const h = await banc(t);
    const res = await h.call("PUT", "/api/settings", { headers: h.headers.mutating, body: { teams: { concurrentSteps: 2, maxCapUsd: null } } });
    assert.equal(res.status, 200, res.body);
    const teams = h.settings.get().teams as { concurrentSteps: number; maxCapUsd: number | null };
    assert.equal(teams.concurrentSteps, 2);
    assert.equal(teams.maxCapUsd, null, "plafond vide = les 5 % calculés par le serveur, jamais un montant inventé");
    h.assertNoGlobalRestart();
  });
});

// --- 6. Ouverture en UNE ligne (U1, §2.6) -----------------------------------------------------------------------------------------

describe("croisement it4 V3 : l'ouverture des équipes en Simple tient en une ligne", () => {
  it("avec `simpleOuvertes: true` seulement : six routes acceptées, lanceur, onglet, éditeur et avis complet", async (t) => {
    // Aucun module d'équipe dans l'application du harnais : le câblage d'essai est monté à part, sur le même cockpit 1.1.
    const h = await banc(t, { settings: { ui: { mode: "simple" } }, equipes: "aucun" });
    const wiring = buildEquipes(
      {
        c11: h.cockpit.c11,
        classifier: h.deps.classifier,
        assistants: h.deps.assistants as unknown as Pick<AssistantService, "install">,
      },
      { simpleOuvertes: true },
    );
    const app = new Hono();
    for (const register of wiring.routes) register(app);
    const appel = async (method: string, chemin: string, body?: unknown, confirme = false) =>
      app.request(chemin, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...(confirme ? { "x-cockpit-confirm": "1" } : {}) } }),
      });

    // GET /api/teams : la seule valeur que l'interface lit passe à vrai.
    const vueListe = (await (await appel("GET", "/api/teams")).json()) as TeamsListResponse;
    assert.equal(vueListe.ouvertesEnSimple, true);

    // Les SIX routes fermées par le §2.6 ne répondent plus « equipes-simple-fermees » (elles refusent pour d'autres raisons
    // seulement : équipe inconnue, lancement inconnu, confirmation manquante).
    const faux = "00000000-0000-4000-8000-000000000000";
    const routes: Array<[string, string, unknown, boolean]> = [
      ["PUT", "/api/teams/essai", { titre: "Essai d'ouverture", description: "", flow: brouillonDeForme("a-la-suite").flow }, false],
      ["POST", "/api/teams/examples/revue-sql/install", {}, false],
      ["POST", "/api/teams/essai/estimate", { directory: "/workspace", rootId: null }, false],
      [
        "POST",
        "/api/teams/essai/run",
        { directory: "/workspace", rootId: null, demande: DEMANDE, fichiers: [], agentConversation: "build", estimateSha256: "0".repeat(64), confirmations: {} },
        false,
      ],
      ["POST", `/api/team-runs/${faux}/estimate`, { directory: "/workspace" }, false],
      ["POST", `/api/team-runs/${faux}/relancer`, { estimateSha256: "0".repeat(64) }, true],
    ];
    for (const [method, chemin, body, confirme] of routes) {
      const res = await appel(method as string, chemin as string, body, confirme);
      const lu = (await res.json()) as { error?: string };
      assert.notEqual(lu.error, "equipes-simple-fermees", `${method} ${chemin} reste fermée malgré l'ouverture : ${res.status}`);
      assert.notEqual(res.status, 403, `${method} ${chemin} : ${res.status} ${JSON.stringify(lu)}`);
    }

    // Lanceur du chat et onglet Équipes : visibles et ouverts avec la MÊME réponse de GET /api/teams.
    assert.equal(vueLanceur({ liste: vueListe, advanced: false, busy: false, demandeVide: false }).visible, true);
    const onglet = buildTeamsTab({ advanced: false, donnees: vueListe, chargement: false, erreur: null, dateDe: () => "" });
    assert.notEqual(onglet.affichage, "ferme", "l'onglet Équipes reste fermé malgré l'ouverture");
    assert.equal(onglet.lectureSeule, false);

    // Éditeur guidé : monté en Simple avec la seule valeur `ouvertesEnSimple`, ses quatre écrans accessibles.
    for (const ecran of [1, 2, 3, 4] as const) {
      const editeur = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, ecran }));
      assert.equal(editeur.affichage, "editeur", `écran ${ecran} non monté`);
      assert.ok(editeur.progression, `progression absente de l'écran ${ecran}`);
      assert.equal(editeur.ferme, null);
    }
    // Aucun réglage d'IA par étape en Simple, même ouvert (D-eq-12).
    const ecran2 = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, ecran: 2 }));
    for (const bloc of ecran2.ecran2?.blocs ?? []) for (const etape of bloc.etapes) assert.equal(etape.ia, null, `IA par étape proposée en Simple (${etape.stepId})`);

    // Avis de délégation : texte complet et [Voir les équipes], lus de la même valeur.
    const avis = avisDelegationSimple(vueListe.ouvertesEnSimple);
    assert.equal(avis.texte, DELEGATION.simple.avisEquipes);
    assert.equal(avis.bouton?.libelle, DELEGATION.simple.voirEquipes);

    // FERMÉ (le dépôt) : la même lecture, avec `ouvertesEnSimple` faux, referme tout.
    const ferme: TeamsListResponse = { ...vueListe, ouvertesEnSimple: false };
    assert.equal(vueLanceur({ liste: ferme, advanced: false, busy: false, demandeVide: false }).visible, false);
    assert.equal(buildTeamsTab({ advanced: false, donnees: ferme, chargement: false, erreur: null, dateDe: () => "" }).affichage, "ferme");
    const editeurFerme = buildEditor(entree({ advanced: false, ouvertesEnSimple: false, ecran: 2 }));
    assert.equal(editeurFerme.affichage, "ferme");
    assert.equal(editeurFerme.apercuDemande, false, "un éditeur fermé ne demande AUCUN aperçu");
    assert.equal(avisDelegationSimple(ferme.ouvertesEnSimple).bouton, null);
    h.assertNoGlobalRestart();
  });
});
