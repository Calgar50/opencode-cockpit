// Tests de croisement de la grande fusion, GF3 : les équipes (H4) rejoignent `chantier/1.1`, qui porte déjà l'itération 2, la salle
// (GF1), la 3D (GF2) et « 3s » (plan d'exécution it5 §8.6 « GF3 » ; plan it4 §9.5, repris en entier ; plan it3 §8.3 (c)). Chaque
// branche garde ses propres tests : ici, seulement ce qui ne se voit QU'UNE FOIS les branches réunies, sur le câblage complet
// (modules 1.1 « tous », les cinq modules d'équipes réels, option `omo` du harnais : seconde instance réelle, salle coupée).
//   1. équipes × autonomie : `doom_loop` d'une étape laissé à l'utilisateur dans une racine « Autonome avec contrôle » ; injection
//      sans ligne `autonomy_requests` ; plafond d'autonomie aveugle au coût d'une équipe ; « Plan d'abord » ; ACTIVATION_OUVERTE ;
//   2. équipes × salle : racine de la salle refusée (409 `instance-salle`, zéro requête aux deux instances) ; aucun événement de la
//      salle ne parvient aux équipes ; verrou sans effet sur le proxy de la salle ; cloison P11 ; Simple ; jamais `opencode-omo` ;
//   3. équipes × 3D : « différé = direct » sur `equipe-avis.jsonl`, rôle `etape` dessiné en délégation, messages injectés rendus
//      par la transcription des équipes ;
//   4. consignes (U2) × étapes : jonction de GF3 dans le runner (une ligne `revoir_consignes` par message d'étape envoyé, bornée,
//      masquée), [Voir la consigne] par l'enfant, zéro requête et zéro ligne `usage` pendant « Revoir », purge commune, aucune
//      consigne au journal, une seule source ;
//   5. suppression 409, garde de rechargement composée, pré-lancement A4, textes, câblage, migrations.
// Aucun appel facturé : faux opencode seulement. Textes des fixtures « [synthétique] » ; jeton factice construit à l'exécution.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { textesPanneau } from "../web/pages/salle-controle/useFaitsConversation.ts";
import { createCockpitApp } from "./app-factory.ts";
import { AssistantService } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { createConsignesStore } from "./consignes-store.ts";
import type { EventDerivation } from "./contracts-11.ts";
import type { EqModule, TeamProxyGuardRequest } from "./contracts-eq.ts";
import { MIGRATIONS, openDb, openMemoryDb, transaction } from "./db.ts";
import { forbiddenCommandArguments, forbiddenProxyBody } from "./http.ts";
import { createLogger } from "./log.ts";
import { createOcProxy, PROXY_RULES_OMO } from "./oc-proxy.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { AutonomyCaps } from "./shared/autonomy-types.ts";
import { bornerConsigne, CONSIGNES, pointsDeCode } from "./shared/consignes.ts";
import { avisDelegationSimple, TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import { planConversation } from "./shared/neon-plan3d.ts";
import { moments, NEON_SECTEURS, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { libelleConsigneTronquee, TEXTES as REVOIR } from "./shared/revoir-texts.ts";
import type { Plan3d, RevoirConsignesEnfantResponse, RevoirResponse } from "./shared/salle3d-types.ts";
import { parseFloorMark } from "./shared/session-floors.ts";
import type { Flow, TeamEstimateResponse, TeamInstallResponse, TeamRunStarted, TeamRunView, TeamsListResponse } from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { createTeamRunnerModule, neutralRunner } from "./team-runner.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, type FakeSession, type FakeToolScript, readCapture } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";
import { buildSalle3dRoutes } from "./wiring-3d.ts";
import { ACTIVATION_OUVERTE, MODULE_ORDER, SALLE_OUVERTE } from "./wiring-11.ts";
import { EQ_MODULE_ORDER, EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const lire = (relatif: string): string => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const DOSSIER = "/workspace/proj";
const FIN = "Réponse du faux opencode.";
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Banc : câblage complet, cinq modules d'équipes réels, seconde instance (salle coupée) ---------------------------------------

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  "",
].join(NL);

/** Workspace réel monté en /workspace : `proj` = dossier des conversations et des équipes, avec un dépôt git sain. */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-fusion-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const fichiers: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": CLEAN_GIT_CONFIG,
  };
  for (const [nom, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(proj, ...nom.split("/")), contenu);
  return root;
}

/** Studio simulé complet : l'installation d'un exemple écrit ses assistants par lui, sans toucher au disque ni à opencode. */
function studioEspion(): StudioService {
  const saved = new Map<string, unknown>();
  return {
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
}

/**
 * Les cinq modules d'équipes RÉELS (ceux de `equipes: "tous"`), le runner aux délais de test de L37b (option de test, jamais une
 * variable lue en production) pour tenir la durée du FIN. Le câblage de production, `equipes: "tous"` à la lettre, est éprouvé à part.
 */
const EQUIPES_REELLES: readonly EqModule[] = [
  EQ_MODULES.agentMap,
  EQ_MODULES.teams,
  EQ_MODULES.teamPreflight,
  createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }),
  EQ_MODULES.teamGuards,
];

interface Banc extends CockpitHarness {
  /** Requêtes utiles reçues par le faux principal depuis `repere` (sondage GET /session/status de la 1.1 exclu). */
  depuis(repere: number): string[];
  /** Requêtes reçues par le faux de la salle depuis `repere`. */
  salleDepuis(repere: number): string[];
  repere(): { principale: number; salle: number };
}

interface BancOptions extends Pick<CockpitHarnessOptions, "ports" | "eqPorts" | "gate" | "log"> {
  settings?: Record<string, unknown>;
  equipes?: CockpitHarnessOptions["equipes"];
}

async function banc(t: TestContext, options: BancOptions = {}): Promise<Banc> {
  const studio = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" }, ...(options.settings ?? {}) },
    modules: "tous",
    equipes: options.equipes ?? EQUIPES_REELLES,
    omo: true,
    ...(options.ports ? { ports: options.ports } : {}),
    ...(options.eqPorts ? { eqPorts: options.eqPorts } : {}),
    ...(options.gate ? { gate: options.gate } : {}),
    ...(options.log ? { log: options.log } : {}),
    env: { workspaceDir: workspace(t) },
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
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return { studio, assistants, routes: [(app: Hono) => registerAssistantRoutes(app, routeDeps), (app: Hono) => registerAiRoutes(app, routeDeps)] };
    },
  });
  ref.h = h;
  assert.ok(h.omo, "option « omo » du harnais");
  const omo = h.omo;
  const utiles = (liste: ReadonlyArray<{ method: string; pathname: string }>, depuis: number): string[] =>
    liste
      .slice(depuis)
      .filter((r) => !(r.method === "GET" && r.pathname === "/session/status"))
      .map((r) => `${r.method} ${r.pathname}`);
  return Object.assign(h, {
    depuis: (repere: number) => utiles(h.fake.requests, repere),
    salleDepuis: (repere: number) => utiles(omo.fake.requests, repere),
    repere: () => ({ principale: h.fake.requests.length, salle: omo.fake.requests.length }),
  });
}

// --- Équipes : exemple, estimation, lancement, lecture ---------------------------------------------------------------------------

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
  model: MODEL,
  options: {},
  permission: readOnlyRules() as FakeAgent["permission"],
  steps: 20,
});

function assistantsDe(flow: Flow): string[] {
  const etapes = flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : []));
  return [...new Set(etapes.map((etape) => etape.assistant))];
}

/** Installe l'exemple (assistants écrits par le Studio simulé) et les déclare au faux, que le vrai pré-lancement relit. */
async function installer(h: CockpitHarness, id = "revue-sql"): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = assistantsDe(body.team.flow).filter((nom) => !connus.has(nom));
  if (manquants.length > 0) h.fake.setAgents([...h.fake.agents(), ...manquants.map(fakeAgent)]);
  return body;
}

async function estimer(h: CockpitHarness, rootId: string | null, directory = DOSSIER, teamId = "revue-sql"): Promise<TeamEstimateResponse> {
  const res = await h.call("POST", `/api/teams/${teamId}/estimate`, { headers: h.headers.mutating, body: { directory, rootId } });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamEstimateResponse>();
}

const DEMANDE = "[synthétique] Relis la requête de facturation du mois dernier.";

const corpsLancement = (estimateSha256: string, patch: Record<string, unknown> = {}) => ({
  directory: DOSSIER,
  rootId: null,
  demande: DEMANDE,
  fichiers: [],
  agentConversation: "build",
  estimateSha256,
  confirmations: {},
  ...patch,
});

async function lancer(h: CockpitHarness, estimateSha256: string, patch: Record<string, unknown> = {}): Promise<TeamRunStarted> {
  const res = await h.call("POST", "/api/teams/revue-sql/run", { headers: h.headers.mutating, body: corpsLancement(estimateSha256, patch) });
  assert.equal(res.status, 202, res.body);
  return res.json<TeamRunStarted>();
}

async function vue(h: CockpitHarness, runId: string): Promise<TeamRunView> {
  const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamRunView>();
}

async function attendre(h: CockpitHarness, runId: string, predicat: (v: TeamRunView) => boolean, libelle: string, timeoutMs = 10_000): Promise<TeamRunView> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const courante = await vue(h, runId);
    if (predicat(courante)) return courante;
    if (Date.now() > limite) throw new Error(`${libelle} : état ${courante.state}, étapes ${courante.steps.map((s) => `${s.stepId}=${s.state}`).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Après « terminee », le runner rafraîchit encore les Archives de la racine (GET /session/:id et …/message, team-runner.ts,
 * `deliver`) : une mesure « zéro requête » prise trop tôt verrait cette lecture, qui ne doit rien à la route mesurée. On attend
 * la ligne des Archives, puis 150 ms sans requête utile vers l'instance principale (5 s au plus).
 */
async function auRepos(h: Banc, rootId: string): Promise<void> {
  await until(() => ((h.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?").get(rootId) as { n: number }).n === 1 ? true : null), 5_000);
  const limite = Date.now() + 5_000;
  let repere = h.fake.requests.length;
  let calmeDepuis = Date.now();
  while (Date.now() - calmeDepuis < 150) {
    assert.ok(Date.now() < limite, "l'instance principale ne revient pas au calme");
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (h.depuis(repere).length > 0) {
      repere = h.fake.requests.length;
      calmeDepuis = Date.now();
    }
  }
}

const estEtape = (session: FakeSession): boolean => (session.metadata as { cockpit?: string } | undefined)?.cockpit === "equipe";
const etapeDe = (session: FakeSession): string | undefined => (session.metadata as { etape?: string } | undefined)?.etape;

/** Chaque session d'étape répond un texte, au coût donné. */
function scripterEtapes(h: CockpitHarness, texte = "[synthétique] Constat de l'étape.", cost = 0.01): void {
  h.fake.scriptWhen(estEtape, { text: texte, cost, tokens: { input: 100, output: 30 }, stepMs: 5 });
}

/** P4 : aucune règle « allow » ou « ask » envoyée à opencode hors du plancher ETAPE d'une session d'étape. */
function assertNoLooseRules(h: CockpitHarness): void {
  for (const req of h.fake.requests) {
    const body = req.body as { permission?: unknown; metadata?: { cockpit?: string } } | undefined;
    const rules = body?.permission;
    if (!Array.isArray(rules)) continue;
    if (rules.every((rule) => (rule as { action?: string }).action === "deny")) continue;
    assert.equal(body?.metadata?.cockpit, "equipe", `règles permissives hors d'une session d'étape : ${req.method} ${req.pathname}`);
  }
}

// --- Conversations, autonomie ------------------------------------------------------------------------------------------------------

async function conversation(h: CockpitHarness, title: string, directory = DOSSIER): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

async function envoyer(h: CockpitHarness, session: FakeSession, tools: FakeToolScript[] = []): Promise<void> {
  h.fake.script(session.id, { tools, followUp: { text: FIN } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${encodeURIComponent(session.directory)}`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

/** Conversation dont opencode a rapporté l'assistant : l'activation réelle lit les règles de cet assistant-là. */
async function conversationRepondue(h: CockpitHarness, title: string): Promise<FakeSession> {
  const session = await conversation(h, title);
  await envoyer(h, session);
  await within(h.fake.settled(session.id), "réponse du faux terminée");
  await until(() => h.sessions.get(session.id)?.agent === "build");
  return session;
}

interface DemandeAutonome {
  id: string;
  fin: string | null;
  ended_at: number | null;
  started_at: number;
}
const demandesAutonomes = (h: CockpitHarness, rootId: string): DemandeAutonome[] =>
  h.db.prepare("SELECT id, fin, ended_at, started_at FROM autonomy_requests WHERE root_id = ? ORDER BY rowid").all(rootId) as unknown as DemandeAutonome[];
const choixDe = (h: CockpitHarness, rootId: string) =>
  h.db.prepare("SELECT choix, retour_cause FROM conversation_autonomy WHERE root_id = ?").get(rootId) as { choix: string; retour_cause: string | null } | undefined;
const lignesUsage = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;

/** Racine posée en base, comme une conversation suivie ; pour la salle, avec sa ligne `omo_rooms` (isRoomRoot, L18c). */
function poserRacine(h: CockpitHarness, rootId: string, instance: "principale" | "omo"): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'chat', ?, ?, ?)",
    )
    .run(rootId, rootId, DOSSIER, "[synthétique] conversation", instance, maintenant, maintenant);
  if (instance === "omo") h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', ?)").run(rootId, maintenant);
}

// === 1. Équipes × autonomie =========================================================================================================

describe("croisements-fusion : équipes × autonomie (spéc. §4.11 l.772)", () => {
  it("racine « Autonome avec contrôle » : le doom_loop d'une étape attend l'utilisateur ; l'injection n'ouvre aucune demande autonome ; le plafond d'autonomie ne voit pas le coût de l'équipe", async (t) => {
    const h = await banc(t);
    const root = await conversationRepondue(h, "Autonome et équipe");
    const plafonds: Partial<AutonomyCaps> = { plafondUsd: 0.02 };
    const choix = await h.call("PUT", `/api/conversations/${root.id}/autonomie`, { headers: h.headers.confirmed, body: { choix: "autonome", plafonds } });
    assert.equal(choix.status, 200, choix.body);
    // Un envoi ouvre la demande autonome (L10a) ; elle reste ouverte, conversation au repos, jusqu'au prochain envoi.
    await envoyer(h, root);
    await within(h.fake.settled(root.id), "réponse du faux terminée");
    const ouverte = await until(() => demandesAutonomes(h, root.id).find((d) => d.ended_at === null));
    const avantEquipe = demandesAutonomes(h, root.id);

    await installer(h);
    h.fake.scriptWhen((s) => etapeDe(s) === "exactitude", {
      text: "[synthétique] Exactitude : rien à dire.",
      cost: 0.01,
      stepMs: 5,
      tools: [{ tool: "doom_loop", input: {}, ask: { permission: "doom_loop", patterns: ["*"], scope: "agent" }, askAfterMs: 2 }],
    });
    scripterEtapes(h);
    const estimation = await estimer(h, root.id);
    const { runId } = await lancer(h, estimation.estimateSha256, { rootId: root.id });

    // doom_loop sous plancher ETAPE : l'étape attend VOTRE accord ; ni l'autonomie ni le cockpit n'y répondent.
    const enAttente = await attendre(h, runId, (v) => v.steps.some((s) => s.stepId === "exactitude" && s.state === "attente-accord"), "étape en attente d'accord");
    const etape = enAttente.steps.find((s) => s.stepId === "exactitude")?.sessionId as string;
    const demande = await until(() => h.fake.pendingPermissions().find((p) => p.sessionID === etape));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${demande.id}/reply`),
      [],
      "le cockpit a répondu seul au doom_loop d'une étape",
    );
    const decisions = h.db.prepare("SELECT verdict FROM autonomy_decisions WHERE permission_id = ?").all(demande.id);
    assert.deepEqual(decisions, [], "l'autonomie a examiné la demande d'une étape (§4.11 : jamais tranchée par l'autonomie)");
    // Réponse de l'utilisateur, comme l'interface l'envoie : dossier de la conversation joint (portillon « once » vérifié, L2a).
    const reponse = await h.call("POST", `/api/oc/permission/${demande.id}/reply?directory=${encodeURIComponent(DOSSIER)}`, {
      headers: h.headers.mutating,
      body: { reply: "once" },
    });
    assert.ok(reponse.status < 400, reponse.body);

    // Plafond d'autonomie de 0,02 $ : les quatre étapes coûtent 0,04 $ ; l'équipe va au bout, la demande autonome n'est ni close
    // au plafond ni ramenée à « Demander ».
    const finie = await attendre(h, runId, (v) => v.state === "terminee" || v.state === "arretee", "équipe finie", 15_000);
    assert.equal(finie.state, "terminee", `équipe arrêtée (cause ${String(finie.cause)}) : le plafond d'autonomie a compté son coût`);
    const coutEtapes = (h.db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage u JOIN sessions s ON s.id = u.session_id WHERE s.purpose = 'equipe' AND u.root_id = ?").get(root.id) as { c: number }).c;
    assert.ok(coutEtapes >= 0.04 - 1e-9, `coût des étapes enregistré : ${coutEtapes}`);
    const courante = h.cockpit.c11.ports.requests.current(root.id);
    assert.ok(courante, "la demande autonome est toujours ouverte");
    assert.equal(courante.id, ouverte.id);
    assert.ok(courante.spent < (plafonds.plafondUsd as number), `dépense vue par l'autonomie : ${courante.spent}`);
    assert.equal(choixDe(h, root.id)?.choix, "autonome");
    // L'injection (demande, résultat) passe hors du proxy : aucune demande autonome ouverte ni close par elle.
    assert.deepEqual(demandesAutonomes(h, root.id), avantEquipe, "l'injection d'une équipe a touché aux demandes autonomes");
    const plafondsAtteints = h.db.prepare("SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ? AND kind = 'statut' AND data LIKE '%plafond%'").get(root.id) as { n: number };
    assert.equal(plafondsAtteints.n, 0);
    h.assertNoGlobalRestart();
    assertNoLooseRules(h);
  });

  it("« Plan d'abord » : le lancement est permis dans une conversation de plan, et ses étapes restent sous plancher ETAPE (lecture seule)", async (t) => {
    const h = await banc(t);
    const plan = await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: DOSSIER } });
    assert.equal(plan.status, 200, plan.body);
    const { rootId } = plan.json<{ rootId: string }>();
    await until(() => h.sessions.get(rootId));
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(rootId), "plan");
    await installer(h);
    scripterEtapes(h);
    const estimation = await estimer(h, rootId);
    const { runId } = await lancer(h, estimation.estimateSha256, { rootId });
    const finie = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");
    for (const step of finie.steps) {
      assert.ok(step.sessionId, `étape ${step.stepId} sans session`);
      assert.equal(parseFloorMark(h.sessions.get(step.sessionId)?.plancher)?.kind, "ETAPE", `plancher de ${step.stepId}`);
      assert.equal(h.fake.session(step.sessionId)?.parentID, rootId);
    }
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(rootId), "plan", "le lancement ne change pas le choix de la conversation");
    assertNoLooseRules(h);
    h.assertNoGlobalRestart();
  });

  it("ACTIVATION_OUVERTE sans effet sur les équipes : aucun fichier des équipes ne la lit, ni ne lit c11.activationOuverte", () => {
    assert.equal(ACTIVATION_OUVERTE, true);
    const fichiers = fs
      .readdirSync(path.join(APP_DIR, "server"))
      .filter((nom) => /^(team-|wiring-eq|contracts-eq|routes-team|agent-map)/.test(nom) && nom.endsWith(".ts") && !nom.endsWith(".test.ts"));
    assert.ok(fichiers.length >= 8, `fichiers des équipes découverts : ${fichiers.join(", ")}`);
    for (const nom of fichiers) {
      const source = lire(path.join("server", nom));
      assert.equal(/ACTIVATION_OUVERTE|activationOuverte/.test(source), false, `${nom} lit l'ouverture de l'activation`);
    }
  });
});

// === 2. Équipes × salle =============================================================================================================

const SALLE = "ses_gf3_salle";

describe("croisements-fusion : équipes × salle (P11, spéc. §3.13 « Instance »)", () => {
  it("racine de la salle : estimation et lancement → 409 instance-salle, zéro requête aux deux instances, aucune ligne team_runs", async (t) => {
    const h = await banc(t);
    poserRacine(h, SALLE, "omo");
    await installer(h);
    const estimation = await estimer(h, null);
    const repere = h.repere();
    const lancements = (h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n;
    for (const [route, corps] of [
      ["/api/teams/revue-sql/estimate", { directory: DOSSIER, rootId: SALLE }],
      ["/api/teams/revue-sql/run", corpsLancement(estimation.estimateSha256, { rootId: SALLE })],
    ] as const) {
      const res = await h.call("POST", route, { headers: h.headers.mutating, body: corps });
      assert.equal(res.status, 409, `${route} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "instance-salle", route);
    }
    assert.deepEqual(h.depuis(repere.principale), [], "requêtes à l'instance principale");
    assert.deepEqual(h.salleDepuis(repere.salle), [], "requêtes à la salle");
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n, lancements);
  });

  it("aucun événement de la salle ne parvient aux équipes : dérivations sur le seul processeur principal, abonnements filtrés par instance", async (t) => {
    const recus: { derivation: string[]; hub: unknown[] } = { derivation: [], hub: [] };
    const espion: EqModule = {
      name: "teamGuards",
      install(reg) {
        const derivation: EventDerivation = {
          name: "espion-equipes",
          onEvent(event: OcGlobalEvent) {
            const payload = event.payload as { type?: string; properties?: { sessionID?: string } };
            const session = String(payload.properties?.sessionID);
            if (payload.type === "session.status" && session.startsWith("ses_gf3_")) recus.derivation.push(session);
          },
        };
        reg.derivation(derivation);
        reg.hub("usage.updated", (data) => void recus.hub.push(data));
      },
    };
    const h = await banc(t, { equipes: [EQ_MODULES.agentMap, EQ_MODULES.teams, EQ_MODULES.teamPreflight, espion] });
    assert.ok(h.omo);
    // Hub commun aux deux instances : l'étiquette d'instance est sur l'enveloppe (hub.cockpit(…, instance)).
    h.hub.cockpit("usage.updated", { rootId: SALLE, sessionId: SALLE, monthSpentUsd: 0, percent: 0 }, "omo");
    assert.deepEqual(recus.hub, [], "un usage.updated de la salle est parvenu aux équipes");
    h.hub.cockpit("usage.updated", { rootId: "ses_gf3_principale", sessionId: "ses_gf3_principale", monthSpentUsd: 0, percent: 0 });
    assert.equal(recus.hub.length, 1, "l'instance principale reste servie");
    // Flux de la salle, traité par SON processeur (chemin réel) : aucune dérivation des équipes n'y est branchée.
    await h.emitOmo({ directory: DOSSIER, payload: { id: "evt_gf3_salle", type: "session.status", properties: { sessionID: "ses_gf3_omo", status: { type: "busy" } } } });
    h.fake.emit({ type: "session.status", properties: { sessionID: "ses_gf3_principal", status: { type: "busy" } } }, DOSSIER);
    await until(() => (recus.derivation.includes("ses_gf3_principal") ? true : null), 5_000);
    assert.deepEqual(recus.derivation, ["ses_gf3_principal"], "un événement de la salle est parvenu à une dérivation des équipes");
  });

  it("verrou des équipes sans effet sur le proxy de la salle : passé au seul montage principal, jamais appelé pour la salle", async (t) => {
    const h = await banc(t);
    assert.ok(h.omo);
    poserRacine(h, SALLE, "omo");
    const appels: TeamProxyGuardRequest[] = [];
    const toujoursVerrouille = async (req: TeamProxyGuardRequest): Promise<Response> => {
      appels.push(req);
      return new Response(JSON.stringify({ error: "equipe-en-cours", message: "verrou d'essai" }), { status: 409, headers: { "content-type": "application/json" } });
    };
    // Montage de la salle construit comme dans http.ts (createOcProxy, PROXY_RULES_OMO), avec un verrou passé PAR ERREUR.
    const app = new Hono();
    app.all(
      "/api/omo/oc/*",
      createOcProxy({
        env: h.deps.env,
        log: h.deps.log,
        projects: h.deps.projects,
        hooks: h.cockpit.wiring,
        instanceOf: (id: string) => h.sessions.get(id)?.instance ?? null,
        forbiddenProxyBody,
        forbiddenCommandArguments,
        enforceTurn: async (_c, _sub, _directory, body) => body,
        instance: h.omo.deps,
        prefix: "/api/omo/oc",
        rules: PROXY_RULES_OMO,
        teamGuard: toujoursVerrouille,
      }),
    );
    const res = await app.request(`/api/omo/oc/session/${SALLE}/message?directory=${encodeURIComponent(DOSSIER)}`);
    assert.notEqual(res.status, 409, "le verrou des équipes a été appliqué au montage de la salle");
    assert.deepEqual(appels, [], "verrou appelé pour la salle");
    // Câblage réel : http.ts ne passe le verrou qu'au montage principal (comme la fenêtre de connexion du relais).
    const http = lire("server/http.ts");
    const principal = http.slice(http.indexOf('prefix: "/api/oc",'), http.indexOf("// --- Proxy de la Salle OMO"));
    assert.match(principal, /teamGuard: deps\.teamGuard,/);
    const debutCommun = http.indexOf("const proxyCommun");
    assert.ok(debutCommun > 0);
    assert.equal(/teamGuard/.test(http.slice(debutCommun, http.indexOf(NL, debutCommun))), false, "verrou dans proxyCommun");
    const salle = http.slice(http.indexOf("// --- Proxy de la Salle OMO"), http.indexOf('app.all("/api/omo/oc/*"'));
    assert.equal(/teamGuard/.test(salle), false, "verrou passé au montage de la salle");
  });

  it("cloison P11 et Simple : session de l'autre instance → 404 ; envoi en Simple vers une racine de la salle → 403 ; lancement jamais servi par opencode-omo", async (t) => {
    const h = await banc(t, { settings: { ui: { mode: "simple" } } });
    assert.ok(h.omo);
    poserRacine(h, SALLE, "omo");
    const repere = h.repere();
    const corps = { parts: [{ type: "text", text: "Continue." }] };
    const salleSimple = await h.call("POST", `/api/omo/oc/session/${SALLE}/prompt_async?directory=${encodeURIComponent(DOSSIER)}`, { headers: h.headers.mutating, body: corps });
    assert.equal(salleSimple.status, 403, salleSimple.body);
    const croise = await h.call("POST", `/api/oc/session/${SALLE}/prompt_async?directory=${encodeURIComponent(DOSSIER)}`, { headers: h.headers.mutating, body: corps });
    assert.equal(croise.status, 404, croise.body);
    assert.equal(croise.json<{ error: string }>().error, "not-found");
    assert.deepEqual(h.depuis(repere.principale), []);
    assert.deepEqual(h.salleDepuis(repere.salle), []);
    // routes-activity.ts (résolution de GF3) : en Simple, `/facts` et `/activity` gardent leur 403 pour une racine de la salle
    // (L18c) ; en Avancé, `/activity` la lit et rend `runs`, toujours vide (aucune équipe dans la salle).
    for (const route of ["facts?since=0", "activity"]) {
      const refus = await h.call("GET", `/api/conversations/${SALLE}/${route}`, { headers: h.headers.authed });
      assert.equal(refus.status, 403, `${route} : ${refus.body}`);
    }
    h.settings.update({ ui: { mode: "avance" } });
    const activite = await h.call("GET", `/api/conversations/${SALLE}/activity`, { headers: h.headers.authed });
    assert.equal(activite.status, 200, activite.body);
    assert.deepEqual(activite.json<{ runs: unknown[] }>().runs, []);

    // Avancé : un lancement complet sur l'instance principale ; la salle ne reçoit RIEN, toutes les étapes sont principales.
    await installer(h);
    scripterEtapes(h);
    const estimation = await estimer(h, null);
    const avantSalle = h.omo.fake.requests.length;
    const { runId } = await lancer(h, estimation.estimateSha256);
    const finie = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");
    assert.deepEqual(h.salleDepuis(avantSalle), [], "une requête du lancement est partie vers opencode-omo");
    for (const step of finie.steps) assert.equal(h.sessions.get(step.sessionId as string)?.instance, "principale", step.stepId);
    assert.equal(h.sessions.get(finie.rootId)?.instance, "principale");
  });
});

// === 3. Équipes × 3D ================================================================================================================

/** Faits de `equipe-avis.jsonl` par le chemin du direct : sessions d'étape reconnues à `metadata.cockpit` (L4a, L4b, L37b). */
function faitsEquipe(): ActivityFact[] {
  const lignes = readCapture("equipe-avis.jsonl");
  const sessions = new Map<string, FactSession>();
  const memoire = new EventMemory();
  const dedoublonneur = new FactDeduper();
  const genres = new Map<string, string>();
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const connue = sessions.get(id);
    if (connue) return connue;
    if (!info || info.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (parentId !== null && !parent) return null;
    const cockpit = isRecord(info.metadata) ? info.metadata.cockpit : undefined;
    const purpose = parent && parent.purpose !== "chat" ? parent.purpose : cockpit === "equipe" ? "equipe" : "chat";
    return { rootId: parent ? parent.rootId : id, parentId, purpose: purpose as FactSession["purpose"], instance: "principale" };
  };
  const faits: ActivityFact[] = [];
  for (const { recv, wire } of lignes) {
    const event = wire.payload as FactEvent;
    memoire.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = resolve(info.id, info);
      if (session) sessions.set(info.id, session);
    }
    const part = event.properties?.part;
    if (event.type === "message.part.updated" && isRecord(part) && typeof part.text === "string" && typeof part.messageID === "string") {
      if (part.text.startsWith("<!-- cockpit:equipe-demande run=")) genres.set(part.messageID, "equipe-demande");
      if (part.text.startsWith("<!-- cockpit:equipe-resultat run=")) genres.set(part.messageID, "equipe-resultat");
    }
    const ctx: FactContext = {
      receivedAt: recv,
      session: resolve,
      messageRole: (id) => memoire.messageRole(id),
      promptKind: (id) => genres.get(id) ?? null,
      firstUserMessage: (id) => memoire.firstUserMessage(id),
      userMessageParts: (id) => memoire.userMessageParts(id),
      unansweredUserMessages: (id) => memoire.unansweredUserMessages(id),
    };
    faits.push(...factsFromEvent(event, ctx).filter((fait) => dedoublonneur.accept(fait)));
  }
  return faits;
}

const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const SIMPLE: NeonSceneOptions = { zoom: 2, mode: "simple" };
const planDe = (faits: readonly ActivityFact[], t: number | null, options: NeonSceneOptions): Plan3d => planConversation(scene(faits, t, options), { theme: "sombre", mode: options.mode });

describe("croisements-fusion : équipes × 3D", () => {
  it("« Revoir » d'une demande d'équipe (equipe-avis.jsonl) : différé = direct du plan 3D ; étapes dessinées en délégation, secteur « Autres » ; aucune erreur", () => {
    const faits = faitsEquipe();
    const racine = faits[0]?.rootId as string;
    const etapes = [...new Set(faits.filter((f) => f.sessionId !== racine).map((f) => f.sessionId))];
    assert.equal(etapes.length, 4, "quatre sessions d'étape dans la capture");
    const tous = moments(faits);
    assert.ok(tous.length > 0);
    for (const t of tous) {
      const prefixe = faits.slice(0, visibleCount(faits, t));
      for (const options of [AVANCE, SIMPLE]) assert.deepEqual(planDe(faits, t, options), planDe(prefixe, null, options), `moment ${t}, ${options.mode}`);
    }
    const plan = planDe(faits, null, AVANCE);
    for (const etape of etapes) {
      const noeud = plan.noeuds.find((n) => n.id === etape);
      assert.ok(noeud, `session d'étape ${etape} non dessinée`);
      assert.equal(noeud.role, "delegation", `rôle ${etape}`);
      assert.ok(noeud.secteur !== null && NEON_SECTEURS.includes(noeud.secteur), `secteur ${String(noeud.secteur)}`);
    }
    // Mode Simple : la scène se dessine aussi, sans erreur (vue Simple de « Revoir », D-3d-20).
    assert.ok(planDe(faits, null, SIMPLE).noeuds.length >= 1);
    // L'assistant des étapes (relire-requete-sql) n'a pas de rôle d'opencode : « Autres », jamais un rôle inventé.
    assert.ok(planDe(faits, null, AVANCE).noeuds.filter((n) => n.role === "delegation").every((n) => n.secteur === "autres"));
  });

  it("messages injectés : reconnus d'abord par la transcription des équipes (L38c), jamais rendus en bulle par un autre bloc de MessageView.tsx", () => {
    const source = lire("web/pages/chat/MessageView.tsx");
    const corps = source.slice(source.indexOf("function TurnViewImpl("), source.indexOf("return (", source.indexOf("function TurnViewImpl(")));
    const ordinaire = corps.indexOf("opening = isAutomaticUserMessage(turn.user)");
    const equipe = corps.indexOf("<TeamTranscriptEntry message={turn.user}");
    assert.ok(ordinaire > 0 && equipe > ordinaire, "le rendu ordinaire est calculé d'abord, puis confié à la transcription des équipes");
    assert.match(corps, /<TeamTranscriptEntry message=\{turn\.user\} conversationRoot=\{conversationRoot\} advanced=\{advanced\} fallback=\{opening\} \/>/);
    // Une seule bulle « Vous » possible : celle du repli (fallback), jamais une seconde écrite après le bloc des équipes.
    assert.equal(corps.split("<UserBubble").length - 1, 1);
    const rendu = source.slice(source.indexOf("return (", source.indexOf("function TurnViewImpl(")));
    assert.equal(/<UserBubble|turn\.user\.parts/.test(rendu.slice(0, rendu.indexOf("</article>"))), false, "un autre bloc rend le message du tour");
  });
});

// === 4. Consignes (U2) × étapes : jonction de GF3 ===================================================================================

/** Jeton factice reconnu par redactSecrets, assemblé à l'exécution (règle de L28d) : forme d'un jeton GitHub personnel. */
const jetonFactice = (): string => `gh${String.fromCharCode(112)}${String.fromCharCode(95)}${randomBytes(16).toString("hex")}`;

interface LigneConsigne {
  root_id: string;
  parent_session_id: string;
  enfant_session_id: string | null;
  call_id: string;
  texte: string;
  longueur: number;
  tronque: number;
}
const consignesDe = (h: CockpitHarness, rootId: string): LigneConsigne[] =>
  h.db
    .prepare("SELECT root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, tronque FROM revoir_consignes WHERE root_id = ? ORDER BY id")
    .all(rootId) as unknown as LigneConsigne[];

/** Fenêtres de 12 caractères d'un texte (contrôle « aucune sous-chaîne de 12 caractères au journal », L28d). */
const fenetres = (texte: string, n = 12): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + n <= texte.length; i++) out.add(texte.slice(i, i + n));
  return out;
};

describe("croisements-fusion : consignes (U2) × étapes d'équipe (jonction de GF3, plan it3 D-3d-30)", () => {
  it("un lancement écrit une ligne revoir_consignes par message d'étape envoyé ; [Voir la consigne] par l'enfant, sans requête ni ligne usage ; purge commune ; jamais au journal", async (t) => {
    const journal: string[] = [];
    const h = await banc(t, { log: createLogger("debug", (ligne) => void journal.push(ligne)) });
    const marque = `demande-gf3-${randomBytes(12).toString("hex")}`;
    const jeton = jetonFactice();
    // Demande de plus de 8 000 caractères : chaque consigne d'étape est tronquée à la borne de U2, la mention le dit.
    const demande = `[synthétique] ${marque} ${jeton} ${"Relis la requête de facturation. ".repeat(300)}`;
    assert.ok(pointsDeCode(demande) > CONSIGNES.maxCaracteres);
    await installer(h);
    scripterEtapes(h);
    const estimation = await estimer(h, null);
    const { runId, rootId } = await lancer(h, estimation.estimateSha256, { demande, confirmations: { secret: true } });
    const finie = await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");

    // Une ligne par message d'étape envoyé (prompt_async vers une session d'étape), clé etape-<tour>-<tentative>-<session>.
    const etapes = h.db.prepare("SELECT session_id, tour, tentative, message_text FROM team_run_steps WHERE run_id = ? ORDER BY ordre").all(runId) as unknown as Array<{
      session_id: string;
      tour: number;
      tentative: number;
      message_text: string;
    }>;
    const envoisEtapes = h.fake.requests.filter((r) => r.method === "POST" && etapes.some((e) => r.pathname === `/session/${e.session_id}/prompt_async`));
    const lignes = consignesDe(h, rootId);
    assert.equal(etapes.length, 4);
    assert.equal(lignes.length, envoisEtapes.length, "une ligne revoir_consignes par message d'étape envoyé");
    let tronquees = 0;
    for (const e of etapes) {
      const ligne = lignes.find((l) => l.enfant_session_id === e.session_id);
      assert.ok(ligne, `consigne de l'étape ${e.session_id} absente`);
      assert.equal(ligne.call_id, `etape-${e.tour}-${e.tentative}-${e.session_id}`);
      assert.equal(ligne.parent_session_id, rootId);
      const borne = bornerConsigne(e.message_text, redactSecrets);
      assert.equal(ligne.texte, borne.texte, "copie = texte envoyé, masqué puis borné comme U2");
      assert.equal(ligne.tronque, borne.tronque ? 1 : 0);
      assert.equal(ligne.longueur, pointsDeCode(e.message_text));
      if (borne.tronque) tronquees += 1;
      // Les avis reçoivent la demande (recoit = « demande ») : leur consigne réelle porte le jeton, jamais sa copie.
      if (e.message_text.includes(jeton)) {
        assert.equal(ligne.texte.includes(jeton), false, "jeton gardé dans la copie de « Revoir »");
        assert.ok(ligne.texte.includes(marque), "la copie porte bien la demande de ce lancement");
      }
    }
    assert.ok(tronquees >= 3, `les trois avis reçoivent la demande longue : ${tronquees} copies tronquées`);
    // Une seule source par session d'étape : aucune consigne de délégation (partie task) pour une étape.
    for (const l of lignes) assert.match(l.call_id, /^etape-\d+-\d+-/);

    // « Revoir » : lecture seule, zéro requête aux deux instances, zéro ligne usage ; consigne lue par l'enfant, mention de troncature.
    await auRepos(h, rootId);
    const repere = h.repere();
    const usageAvant = lignesUsage(h);
    const revoir = await h.call("GET", `/api/revoir/${rootId}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    assert.equal(revoir.json<RevoirResponse>().instance, "principale");
    for (const step of finie.steps) {
      const lue = await h.call("GET", `/api/revoir/${rootId}/consignes?enfant=${step.sessionId}`, { headers: h.headers.authed });
      assert.equal(lue.status, 200, lue.body);
      const { consignes } = lue.json<RevoirConsignesEnfantResponse>();
      assert.equal(consignes.length, 1, `étape ${step.stepId}`);
      const [c] = consignes;
      assert.ok(c);
      assert.equal(c.texte, lignes.find((l) => l.enfant_session_id === step.sessionId)?.texte, "« Revoir » montre la copie gardée");
      if (c.tronque) {
        assert.equal(pointsDeCode(c.texte), CONSIGNES.maxCaracteres);
        const mention = libelleConsigneTronquee(pointsDeCode(c.texte), c.longueur);
        assert.match(mention, /^Consigne tronquée : /);
        assert.ok(mention.replace(/[^0-9]/g, "").startsWith(String(CONSIGNES.maxCaracteres)), mention);
      }
    }
    assert.deepEqual(h.depuis(repere.principale), [], "requête à opencode pendant « Revoir »");
    assert.deepEqual(h.salleDepuis(repere.salle), []);
    assert.equal(lignesUsage(h), usageAvant, "ligne usage pendant « Revoir »");
    // Résultats d'étape et autres textes : « Texte non affiché pendant « Revoir » » (seule la consigne gardée est montrée).
    assert.deepEqual(textesPanneau(false, { consigne: null, actions: { termines: 0, faits: [] }, resultat: { messageId: "msg_gf3", faits: [0] }, reponse: null, metadonnees: null } as never), {
      aRelire: [],
      nonAffiche: true,
      consigneGardee: true,
    });
    assert.equal(REVOIR.partout.texteNonAffiche, "Texte non affiché pendant « Revoir » : rien n'est redemandé ni relancé.");

    // Jamais au journal : ni la marque de la demande, ni le jeton, ni une fenêtre de 12 caractères d'une consigne gardée.
    const texteJournal = journal.join("");
    assert.ok(journal.length > 0, "le journal espion reçoit bien les lignes du cockpit");
    assert.equal(texteJournal.includes(jeton), false, "jeton au journal");
    const fuites = [...fenetres(marque)].filter((f) => texteJournal.includes(f));
    assert.deepEqual(fuites, [], "fenêtre de 12 caractères de la demande au journal");

    // Purge commune : une consigne de délégation et les consignes d'étape partent avec la conversation, message_text vidé.
    assert.equal(
      createConsignesStore(h.db).enregistrer({ rootId, parent: rootId, enfant: "ses_gf3_enfant", callId: "call_gf3_delegation", brut: "[synthétique] consigne confiée", at: 1 }),
      "enregistree",
    );
    const purge = await h.call("DELETE", `/api/archive/${rootId}`, { headers: h.headers.mutating });
    assert.equal(purge.status, 200, purge.body);
    assert.deepEqual(consignesDe(h, rootId), [], "consignes restées après la suppression de la conversation");
    const textes = h.db.prepare("SELECT message_text FROM team_run_steps WHERE run_id = ? AND message_text IS NOT NULL").all(runId);
    assert.deepEqual(textes, [], "message_text resté après la suppression");
    assert.equal(journal.join("").includes(marque), false, "demande au journal après la purge");
    h.assertNoGlobalRestart();
  });

  it("une seule source : ni le magasin des consignes ni « Revoir » ne lisent team_run_steps.message_text ; la jonction est la seule section de GF3 du runner", () => {
    for (const fichier of ["server/consignes-store.ts", "server/consignes-capture.ts", "server/routes-consignes.ts", "server/revoir-service.ts"]) {
      if (!fs.existsSync(path.join(APP_DIR, fichier))) continue;
      assert.equal(/message_text|team_run_steps/.test(lire(fichier)), false, `${fichier} lit les textes d'étape`);
    }
    const runner = lire("server/team-runner.ts");
    const sections = runner.match(/\/\/ <gf3:consignes-etape> début[\s\S]*?\/\/ <\/gf3:consignes-etape> fin/g) ?? [];
    assert.equal(sections.length, 2, "import et appel, rien d'autre");
    const appel = (sections[1] ?? "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert.match(appel, /createConsignesStore\(c11\.db\)\.enregistrer\(\{/);
    assert.match(appel, /callId: `etape-\$\{key\.tour\}-\$\{key\.tentative\}-\$\{sessionId\}`/);
    assert.match(appel, /brut: texte,/);
    assert.equal(/message_text|messageText|log\.|warn\([^)]*texte/.test(appel), false, "la jonction relit message_text ou journalise la consigne");
    // À l'endroit UNIQUE de l'envoi : juste après le prompt_async d'une étape, avant la trace « etape-envoyee ».
    const envoi = runner.indexOf("`/session/${enc(sessionId)}/prompt_async`");
    assert.ok(envoi > 0 && runner.indexOf("// <gf3:consignes-etape> début : jonction") > envoi);
    assert.ok(runner.indexOf('audit(run.runId, "etape-envoyee"') > runner.indexOf("// </gf3:consignes-etape> fin", envoi));
    assert.equal(runner.split("/prompt_async`").length - 1, 1, "un seul envoi de message d'étape dans le runner");
  });
});

// === 5. Suppression, garde de rechargement composée ==================================================================================

describe("croisements-fusion : suppression et garde de rechargement composée (spéc. §3.13 l.425, §3.11)", () => {
  it("équipe en cours : DELETE /api/archive/:id de la racine → 409 (middleware avant la route), aucune purge", async (t) => {
    const h = await banc(t);
    await installer(h);
    h.fake.scriptWhen(estEtape, { tools: [{ tool: "read", input: { filePath: `${DOSSIER}/a.txt` }, beforeAsk: () => new Promise<void>(() => undefined) }], stepMs: 1 });
    const estimation = await estimer(h, null);
    const { runId, rootId } = await lancer(h, estimation.estimateSha256);
    await attendre(h, runId, (v) => v.steps.some((s) => s.state === "en-cours" && s.sessionId !== null), "une étape en cours");
    const refus = await h.call("DELETE", `/api/archive/${rootId}`, { headers: h.headers.mutating });
    assert.equal(refus.status, 409, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "equipe-en-cours");
    assert.equal(h.cockpitEvents().some((e) => e.type === "conversation.deleted"), false, "aucune purge derrière le verrou");
    const http = lire("server/http.ts");
    assert.ok(http.indexOf('"/api/archive/:id",\n      forMethods(["DELETE"]') > 0, "middleware des Archives");
    assert.ok(http.indexOf('"/api/archive/:id",\n      forMethods(["DELETE"]') < http.indexOf('app.delete("/api/archive/:id"'), "middleware placé avant la route");
    await h.call("POST", `/api/conversations/${rootId}/stop`, { headers: h.headers.mutating });
    await attendre(h, runId, (v) => v.state === "arretee", "équipe arrêtée");
  });

  it("examen (it2) et étapes (it4) : chacun seul rend 409, réalignement compris ; la salle ne compose pas la garde (compteur propre, L18b)", async (t) => {
    const examen = { value: false };
    const etapes = { value: false };
    const h = await banc(t, {
      ports: { autonomy: { examining: () => examen.value } },
      eqPorts: { runner: { ...neutralRunner(), stepsBusy: () => etapes.value } },
      equipes: [EQ_MODULES.agentMap, EQ_MODULES.teams, EQ_MODULES.teamPreflight, EQ_MODULES.teamRunner, EQ_MODULES.teamGuards],
    });
    assert.ok(h.omo);
    const realign = async (): Promise<number> => (await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} })).status;
    const refuse = async (libelle: string): Promise<void> => {
      assert.equal(h.cockpit.c11.reloadBusy(), true, libelle);
      assert.equal(await realign(), 409, `${libelle} : réalignement`);
      const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.mutating });
      assert.equal(restart.status, 409, `${libelle} : redémarrage d'opencode ${restart.body}`);
    };
    assert.equal(h.cockpit.c11.reloadBusy(), false);
    assert.equal(await realign(), 200, "au repos, le réalignement passe");
    examen.value = true;
    await refuse("examen seul");
    examen.value = false;
    etapes.value = true;
    await refuse("étapes seules");
    etapes.value = false;
    // Salle : son compteur d'envois facturés est PROPRE (instance-runtime.ts) et n'entre pas dans la garde de l'instance principale.
    const fin = h.omo.deps.beginBilled();
    try {
      assert.equal(h.cockpit.c11.reloadBusy(), false);
      assert.equal(await realign(), 200, "un envoi de la salle en vol ne bloque pas l'instance principale");
    } finally {
      fin();
    }
    h.assertNoGlobalRestart();
  });
});

// === 6. Pré-lancement A4 : zéro requête aux deux instances ==========================================================================

describe("croisements-fusion : pré-lancement (A4), zéro requête vers les deux instances", () => {
  it("chaque refus de POST …/run et de POST …/relancer laisse les deux faux sans la moindre requête", async (t) => {
    const h = await banc(t);
    poserRacine(h, SALLE, "omo");
    await installer(h);
    scripterEtapes(h);
    const estimation = await estimer(h, null);
    const sansRequete = async (libelle: string, route: string, body: unknown, statut: number, code: string, headers = h.headers.mutating): Promise<void> => {
      const repere = h.repere();
      const res = await h.call("POST", route, { headers, body });
      assert.equal(res.status, statut, `${libelle} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, code, libelle);
      assert.deepEqual(h.depuis(repere.principale), [], `${libelle} : requête à l'instance principale`);
      assert.deepEqual(h.salleDepuis(repere.salle), [], `${libelle} : requête à la salle`);
    };
    const run = "/api/teams/revue-sql/run";
    await sansRequete("empreinte inconnue", run, corpsLancement("b".repeat(64)), 409, "estimation-perimee");
    await sansRequete("racine de la salle", run, corpsLancement(estimation.estimateSha256, { rootId: SALLE }), 409, "instance-salle");
    await sansRequete("dossier hors du workspace", run, corpsLancement(estimation.estimateSha256, { directory: "/etc" }), 403, "forbidden-directory");
    await sansRequete("pièce jointe hors du dossier", run, corpsLancement(estimation.estimateSha256, { fichiers: ["../secret.md"] }), 403, "fichier-refuse");
    await sansRequete("secret probable non confirmé", run, corpsLancement(estimation.estimateSha256, { demande: `${DEMANDE} ${jetonFactice()}` }), 409, "secret-probable");

    // Relance : un lancement terminé n'est pas relançable ; un lancement inconnu n'existe pas ; Simple : fermé.
    const { runId, rootId } = await lancer(h, estimation.estimateSha256);
    await attendre(h, runId, (v) => v.state === "terminee", "équipe terminée");
    await auRepos(h, rootId);
    const relancer = `/api/team-runs/${runId}/relancer`;
    await sansRequete("relance d'un lancement terminé", relancer, { estimateSha256: estimation.estimateSha256 }, 409, "pas-relancable", h.headers.confirmed);
    await sansRequete("relance d'un lancement inconnu", "/api/team-runs/00000000-0000-4000-8000-000000000000/relancer", { estimateSha256: estimation.estimateSha256 }, 404, "not-found", h.headers.confirmed);
    h.settings.update({ ui: { mode: "simple" } });
    await sansRequete("mode Simple (U1)", run, corpsLancement(estimation.estimateSha256), 403, "equipes-simple-fermees");
    await sansRequete("relance en mode Simple (U1)", relancer, { estimateSha256: estimation.estimateSha256 }, 403, "equipes-simple-fermees", h.headers.confirmed);
    h.assertNoGlobalRestart();
  });
});

// === 7. Textes, câblage, migrations =================================================================================================

describe("croisements-fusion : textes et avis Simple de délégation (U1)", () => {
  it("GET /api/teams dit `ouvertesEnSimple` = EQUIPES_SIMPLE_OUVERTES (faux) ; l'avis Simple de délégation garde son texte court ; modules de textes des branches contrôlés", async (t) => {
    const h = await banc(t, { settings: { ui: { mode: "simple" } } });
    const liste = await h.call("GET", "/api/teams", { headers: h.headers.authed });
    assert.equal(liste.status, 200, liste.body);
    assert.equal(liste.json<TeamsListResponse>().ouvertesEnSimple, EQUIPES_SIMPLE_OUVERTES);
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.equal(SALLE_OUVERTE, false);
    const avis = avisDelegationSimple(EQUIPES_SIMPLE_OUVERTES);
    assert.deepEqual(avis, { texte: DELEGATION.simple.avis, bouton: null });
    assert.equal(DELEGATION.simple.avis, "En mode Simple, l'IA ne délègue pas : elle continue seule.");
    // Le contrôle « textes » découvre tout *-texts.ts de server/shared : ceux des équipes, de la carte, de la salle et de la 3D y sont.
    const partages = fs.readdirSync(path.join(APP_DIR, "server", "shared"));
    for (const module of ["team-texts.ts", "agent-map-texts.ts", "delegation-texts.ts", "omo-room-texts.ts", "revoir-texts.ts", "salle3d-texts.ts", "neon-texts.ts"]) {
      assert.ok(partages.includes(module), `${module} hors de server/shared : le contrôle « textes » ne le verrait pas`);
    }
  });
});

describe("croisements-fusion : câblage de production", () => {
  it("tous les modules de toutes les branches ; aucune route en double ; dérivations dans l'ordre 1.1, salle (filtrée), équipes, puis 3D", async (t) => {
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true, env: { workspaceDir: workspace(t) } });
    assert.ok(h.omo);
    assert.deepEqual(h.cockpit.wiring.modules, [...MODULE_ORDER]);
    assert.deepEqual(h.cockpit.equipes.modules, [...EQ_MODULE_ORDER]);
    assert.ok(h.cockpit.equipes.registrations.some((r) => r.kind === "proxyGuard"), "verrou des équipes inscrit en production");

    // Aucune route en double : chaque groupe (1.1 et salle, équipes, 3D) est compté seul, puis dans l'application entière.
    const cles = (app: Hono): string[] => app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    const compter = (liste: readonly string[]) => liste.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    const groupe = (fns: ReadonlyArray<(app: Hono) => void>): Map<string, number> => {
      const app = new Hono();
      for (const fn of fns) fn(app);
      return compter(cles(app));
    };
    const production = compter(cles(h.cockpit.app));
    const groupes = { "1.1 et salle": groupe(h.cockpit.wiring.routes), equipes: groupe(h.cockpit.equipes.routes), "3d": groupe(buildSalle3dRoutes(h.cockpit.c11)) };
    for (const [nom, routes] of Object.entries(groupes)) {
      assert.ok(routes.size > 0, `groupe ${nom} vide`);
      for (const [cle, n] of routes) assert.equal(production.get(cle), n, `${cle} (${nom}) inscrite aussi ailleurs`);
    }
    const noms = Object.keys(groupes);
    for (const [i, a] of noms.entries()) {
      for (const b of noms.slice(i + 1)) {
        const communes = [...(groupes[a as keyof typeof groupes] as Map<string, number>).keys()].filter((k) => (groupes[b as keyof typeof groupes] as Map<string, number>).has(k));
        assert.deepEqual(communes, [], `routes communes à ${a} et ${b}`);
      }
    }

    // Ordre des dérivations : la fabrique rejouée sur des processeurs qui les notent (principal, salle), modules de production.
    const principal: string[] = [];
    const salle: string[] = [];
    const noter = (liste: string[]) => ({ addDerivation: (d: EventDerivation) => (liste.push(d.name), () => undefined) });
    const rejouee = createCockpitApp(
      {
        ...h.deps,
        assistants: h.deps.assistants as Parameters<typeof createCockpitApp>[0]["assistants"],
        processor: noter(principal) as unknown as typeof h.deps.processor,
        sessions: h.sessions,
        configQueue: h.deps.configQueue as ConfigWriteQueue,
        omo: { ...h.omo.deps, processor: noter(salle) as unknown as typeof h.omo.deps.processor },
      },
      {},
    );
    t.after(() => rejouee.close());
    const onze = rejouee.wiring.derivations.map((d) => d.name);
    const servies = (d: EventDerivation, instance: "principale" | "omo") => (d.instances ?? ["principale"]).includes(instance);
    const onzePrincipale = rejouee.wiring.derivations.filter((d) => servies(d, "principale")).map((d) => d.name);
    const onzeSalle = rejouee.wiring.derivations.filter((d) => servies(d, "omo")).map((d) => d.name);
    const equipes = rejouee.equipes.derivations.map((d) => d.name);
    assert.ok(onze.length > 0 && equipes.length === 2, `dérivations : ${onze.join(", ")} / ${equipes.join(", ")}`);
    assert.deepEqual(principal.slice(0, onzePrincipale.length + equipes.length), [...onzePrincipale, ...equipes], "principal : 1.1 puis équipes");
    assert.ok(principal.slice(onzePrincipale.length + equipes.length).length >= 1, "principal : les dérivations de la 3D en dernier");
    assert.deepEqual(salle.slice(0, onzeSalle.length), onzeSalle, "salle : seulement les dérivations 1.1 qui la servent");
    for (const nom of equipes) assert.equal(salle.includes(nom), false, `dérivation des équipes « ${nom} » sur le processeur de la salle`);
  });
});

describe("croisements-fusion : migrations (A2, A2 bis ; plan it5 §8.5)", () => {
  const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const instructions = (sql: string): string[] =>
    sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "");

  it("entrée 7 réservée aux équipes toujours vide (D-eq-07) ; base neuve : user_version === MIGRATIONS.length", () => {
    assert.deepEqual(instructions(MIGRATIONS[6] ?? "x"), [], "l'it4 n'apporte aucune migration : l'entrée 7 reste un commentaire seul");
    assert.ok((MIGRATIONS[6] ?? "").includes("7 : réservée aux équipes"));
    // Aucune entrée ajoutée après la 8 (celle de la 3D, dernière du tableau) ; la 9 de la construction reste inutilisée.
    assert.match(MIGRATIONS.at(-1) ?? "", /CREATE TABLE revoir_consignes/);
    assert.match(MIGRATIONS.at(-3) ?? "", /CREATE TABLE omo_rooms/);
    const db = openMemoryDb();
    try {
      assert.equal(userVersion(db), MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it("montée depuis 5, 6 et 7 : verte, tables d'équipe et leurs données intactes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gf3-migrations-"));
    try {
      for (const depuis of [5, 6, 7]) {
        const sousDossier = path.join(dir, `v${depuis}`);
        fs.mkdirSync(sousDossier);
        const vieille = new DatabaseSync(path.join(sousDossier, "cockpit.db"));
        vieille.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        for (let v = 0; v < depuis; v++) {
          transaction(vieille, () => {
            vieille.exec(MIGRATIONS[v] ?? "");
            vieille.exec(`PRAGMA user_version = ${v + 1}`);
          });
        }
        vieille
          .prepare("INSERT INTO teams (id, titre, description, flow, origine, created_at, updated_at) VALUES ('eq_gf3', '[synthétique] Revue', '', '{}', 'creee', 1, 1)")
          .run();
        vieille
          .prepare(
            "INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, precisions, created_at) VALUES ('run_gf3', '[synthétique] Revue', '{}', 'f0', 'ses_gf3', '/workspace/proj', 'terminee', '[]', 1)",
          )
          .run();
        vieille
          .prepare(
            "INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, state, message_text) VALUES ('run_gf3', 'a', 1, 0, 'A', 'relire', 'terminee', '[synthétique] consigne')",
          )
          .run();
        vieille.close();

        const db = openDb(sousDossier);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length, `montée depuis ${depuis}`);
          assert.equal((db.prepare("SELECT titre FROM teams WHERE id = 'eq_gf3'").get() as { titre: string }).titre, "[synthétique] Revue");
          assert.equal((db.prepare("SELECT state FROM team_runs WHERE id = 'run_gf3'").get() as { state: string }).state, "terminee");
          assert.equal((db.prepare("SELECT message_text FROM team_run_steps WHERE run_id = 'run_gf3'").get() as { message_text: string }).message_text, "[synthétique] consigne");
          for (const table of ["omo_rooms", "revoir_consignes", "teams", "team_runs", "team_run_steps"]) {
            assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} absente après la montée depuis ${depuis}`);
          }
        } finally {
          db.close();
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
