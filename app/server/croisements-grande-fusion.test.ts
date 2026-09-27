// Croisements de la grande fusion (GF5 ; plan it5 §8.6 GF5 points 1 à 9, repris en entier ; spéc. §5.9 l.1013-1017, §7.9, §7.11,
// §3.9 l.343, §3.5 ; plan it3 §8.3 (U1), §8.4 (c), D-3d-08, D-3d-21, D-3d-30 ; plan it4 D-eq-13, D-eq-23 ; D-5-15, D-5-17, D-5-24 ;
// U1, U2, A2). Harnais : modules « tous », équipes « tous », option `omo` (salle factice, COUPÉE : SALLE_OUVERTE faux).
// Faux opencode seulement : aucun appel facturé. La jonction U2 des étapes est faite par GF3 (croisements-fusion.test.ts) : GF5
// n'écrit rien dans le module de consignes de l'it3, il en vérifie ici la tenue avec une relecture en deux tours suivie d'un
// aiguillage confirmé (point 4 : « relecture et choix », « différé = direct » comparé à la lecture en direct et au plan 3D du
// préfixe, relecture de F2, vague 3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { EqModule, PlannedStep, PreflightOutcome, RunPlan, TeamPreflightPort, TeamRow, TeamsPort } from "./contracts-eq.ts";
import { createConsignesStore } from "./consignes-store.ts";
import { MIGRATIONS, openMemoryDb } from "./db.ts";
import { createSecondReadingService } from "./second-reading.ts";
import { floorHash } from "./session-floor-service.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import { type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import { SECOND_READING_CATALOG_ID, SECOND_READING_TURN_KIND } from "./shared/construction-constants.ts";
import { outilsDeConstruction } from "./shared/construction-salle.ts";
import { secondReadingPrefix } from "./shared/construction-texts.ts";
import { demonstrationsProposees, equipesOuvertes } from "./shared/equipes-ouvertes.ts";
import { planConversation } from "./shared/neon-plan3d.ts";
import { moments, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { Plan3d, RevoirConsignesEnfantResponse, RevoirResponse } from "./shared/salle3d-types.ts";
import { buildFloor, canonicalRules } from "./shared/session-floors.ts";
import type { Flow, FlowEstimate, FlowStep, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import { createTeamRunnerModule, type TeamRunner } from "./team-runner.ts";
import { createTeamStore } from "./team-store.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import { EQUIPES_SIMPLE_OUVERTES, EQ_MODULE_ORDER } from "./wiring-eq.ts";
import { MODULE_ORDER, SALLE_OUVERTE, STEP_ORDER } from "./wiring-11.ts";
import { OMO_MODULE_NAMES } from "./omo-contracts.ts";
import { CONSTRUCTION_MODULE_ORDER } from "./wiring-construction.ts";
import { parse as parseJsonc } from "jsonc-parser";
import { planWebMigration } from "./oc-config-web.ts";
import { effectiveAgentRules, PERMISSION_PRESETS, PERMISSION_PRESETS_1_0 } from "./shared/assistant-rules.ts";
import { usesInternet } from "./shared/flow.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const lire = (...relatif: string[]): string => fs.readFileSync(path.join(DEPOT, ...relatif), "utf8");
const compact = (texte: string): string => texte.replace(/\s+/g, " ");
const sha256 = (texte: string): string => createHash("sha256").update(texte, "utf8").digest("hex");
const lignesUsage = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
const NL = String.fromCharCode(10);

/** Racine suivie par le cockpit, dans l'instance voulue ; racine de la salle : ligne omo_rooms (L18c). */
function poserRacine(h: CockpitHarness, rootId: string, instance: "principale" | "omo"): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, '/workspace/proj', ?, 'chat', ?, ?, ?)",
    )
    .run(rootId, rootId, "[synthétique] conversation", instance, maintenant, maintenant);
  if (instance === "omo") h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', ?)").run(rootId, maintenant);
}

// --- 1. Salle × construction ------------------------------------------------------------------------------------------------------

const SALLE = "ses_gf5_salle";
const PRINCIPALE = "ses_gf5_principale";

describe("croisements grande fusion (1) : salle × construction", () => {
  it("racine de la salle : ni puce de méthode ni Seconde lecture (fonction pure, puis composeur et vue d'un tour qui la lisent)", () => {
    assert.deepEqual(outilsDeConstruction(true), { puceMethode: false, presenceMethode: false, secondeLecture: false });
    assert.deepEqual(outilsDeConstruction(false), { puceMethode: true, presenceMethode: true, secondeLecture: true });
    const composeur = compact(lire("app", "web", "pages", "chat", "Composer.tsx"));
    assert.ok(composeur.includes("const outils = outilsDeConstruction(salle);"));
    assert.ok(composeur.includes("{outils.puceMethode ? <MethodChipList "), "méthodes retenues seulement hors de la salle");
    assert.ok(composeur.includes("{outils.puceMethode ? ( <MethodChip "), "puce « + Méthode » seulement hors de la salle");
    assert.equal((composeur.match(/<MethodChip\b/g) ?? []).length, 1, "une seule puce, sous la règle");
    const vue = compact(lire("app", "web", "pages", "chat", "MessageView.tsx"));
    assert.ok(vue.includes("const outils = outilsDeConstruction(salle);"));
    assert.ok(vue.includes("{totals.running || !outils.presenceMethode ? null : <MethodPresence "));
    assert.ok(vue.includes("pied !== null && !totals.running && outils.secondeLecture ? <SecondReadingFooter "));
    assert.ok(vue.includes("conversationRoot && sessionDeTour !== null && outils.secondeLecture ? ( <SecondReadingButton"));
    // La page du chat sert l'instance principale seule : une racine de la salle y reçoit 404 (cloison P11), la propriété vaut faux.
    const page = lire("app", "web", "pages", "ChatPage.tsx");
    assert.doesNotMatch(page, /\bsalle=\{true\}/);
  });

  it("le crochet secondReading ne requalifie RIEN sur l'instance omo (ni par runHooks, ni appelé directement) ; témoin principal : requalifié", async (t) => {
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true });
    const maintenant = Date.now();
    h.db
      .prepare(
        `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
         VALUES ('agents', 'relecteur-critique', 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
      )
      .run(SECOND_READING_CATALOG_ID, maintenant, maintenant);
    const tour = (sessionId: string) =>
      Number(h.db.prepare("INSERT INTO chat_turns (session_id, created_at, kind, agent) VALUES (?, ?, 'message', 'relecteur-critique')").run(sessionId, Date.now()).lastInsertRowid);
    const genre = (id: number) => (h.db.prepare("SELECT kind FROM chat_turns WHERE id = ?").get(id) as { kind: string }).kind;
    const contexte = (sessionId: string, instance?: "omo") =>
      ({
        c: {},
        method: "POST",
        sub: `/session/${sessionId}/prompt_async`,
        directory: "/workspace/proj",
        body: { agent: "relecteur-critique", parts: [{ type: "text", text: `${secondReadingPrefix("reponse")} « Réponse. »` }] },
        sessionId,
        ...(instance ? { instance } : {}),
      }) as never;
    poserRacine(h, SALLE, "omo");
    const ligneSalle = tour(SALLE);
    assert.ok(h.omo);
    assert.equal(await h.omo.runHooks("beforeBilledSend", contexte(SALLE)), null);
    assert.equal(genre(ligneSalle), "message", "runHooks de la salle : le crochet n'est pas appelé");
    const service = createSecondReadingService(h.cockpit.c11);
    assert.equal(await service.beforeBilledSend(contexte(SALLE, "omo")), null);
    assert.equal(genre(ligneSalle), "message", "appel direct avec l'instance omo : rien n'est requalifié");
    // Témoin : même envoi sur l'instance principale → requalifié.
    const lignePrincipale = tour(PRINCIPALE);
    await h.cockpit.wiring.runHooks("beforeBilledSend", contexte(PRINCIPALE));
    assert.equal(genre(lignePrincipale), SECOND_READING_TURN_KIND, "témoin principal requalifié");
  });

  it("GET /api/conversations/:rootId/chronologie d'une racine de la salle en Simple → 403 comme /facts (même phrase) ; Avancé → 200 ; racine principale en Simple → 200", async (t) => {
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true });
    poserRacine(h, SALLE, "omo");
    poserRacine(h, PRINCIPALE, "principale");
    const lireRoute = (chemin: string) => h.call("GET", chemin, { headers: h.headers.authed });
    const chrono = await lireRoute(`/api/conversations/${SALLE}/chronologie`);
    const faits = await lireRoute(`/api/conversations/${SALLE}/facts?since=0`);
    assert.equal(chrono.status, 403, chrono.body);
    assert.equal(faits.status, 403, faits.body);
    assert.deepEqual(chrono.json(), { error: "mode-avance", message: phraseRefusActivation("mode-avance") });
    assert.deepEqual(chrono.json(), faits.json(), "même refus que /facts (L18c)");
    assert.equal((await lireRoute(`/api/conversations/${PRINCIPALE}/chronologie`)).status, 200, "hors de la salle, rien ne change");
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await lireRoute(`/api/conversations/${SALLE}/chronologie`)).status, 200, "témoin Avancé : le 403 vient du mode");
  });

  it("« Revoir » d'une demande terminée passe par /api/revoir (plan it3 D-3d-08), jamais par la chronologie", () => {
    for (const fichier of [
      ["app", "server", "revoir-service.ts"],
      ["app", "server", "routes-revoir.ts"],
      ["app", "web", "pages", "salle-controle", "revoir", "RevoirDialog.tsx"],
      ["app", "web", "lib", "api-salle3d.ts"],
    ]) {
      const source = lire(...fichier);
      assert.doesNotMatch(source, /chronologie/i, fichier.join("/"));
    }
    assert.match(lire("app", "web", "lib", "api-salle3d.ts"), /\/api\/revoir\//);
  });
});

// --- 2. Coûts par équipe et instance des lancements (P11) ----------------------------------------------------------------------------

describe("croisements grande fusion (2) : coûts par équipe sans la salle ; lancements sur l'instance principale seulement (P11)", () => {
  it("GET /api/usage/equipes : le coût d'un lancement ne compte que les sessions de SES étapes, jamais une ligne usage de la salle", async (t) => {
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true });
    poserRacine(h, PRINCIPALE, "principale");
    poserRacine(h, SALLE, "omo");
    const debut = Date.now();
    h.db
      .prepare(
        "INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, precisions, created_at, cost) VALUES ('run_gf5', '[synthétique] Revue', '{}', 'f0', ?, '/workspace/proj', 'terminee', '[]', ?, 0)",
      )
      .run(PRINCIPALE, debut);
    h.db
      .prepare("INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, state, session_id) VALUES ('run_gf5', 'a', 1, 0, 'A', 'relire', 'terminee', 'ses_gf5_etape')")
      .run();
    const usage = h.db.prepare(
      "INSERT INTO usage (message_id, session_id, root_id, agent, provider_id, model_id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, created_at, completed_at) VALUES (?, ?, ?, 'relire', 'github-copilot', 'gpt-5-mini', ?, 1, 1, 0, 0, 0, ?, ?)",
    );
    usage.run("msg_gf5_etape", "ses_gf5_etape", PRINCIPALE, 0.25, debut, debut);
    usage.run("msg_gf5_salle", SALLE, SALLE, 4, debut, debut);
    const mois = new Date(debut).toISOString().slice(0, 7);
    const lu = await h.call("GET", `/api/usage/equipes?month=${mois}`, { headers: h.headers.authed });
    assert.equal(lu.status, 200, lu.body);
    const corps = lu.json<{ lancements: Array<{ runId: string; cout: number }> }>();
    assert.deepEqual(
      corps.lancements.map((l) => [l.runId, l.cout]),
      [["run_gf5", 0.25]],
      "la ligne usage de la salle (4 $) n'est jamais comptée",
    );
  });

  it("lancement sur une racine de la salle → 409 instance-salle, zéro requête aux deux instances, aucune ligne team_runs ; exécuteur sur le client principal seulement", async (t) => {
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true, settings: { ui: { mode: "avance" } } });
    assert.ok(h.omo);
    poserRacine(h, SALLE, "omo");
    createTeamStore({ db: h.db }).teams.put({ id: "equipe-gf5-p11", titre: "[synthétique] Relecture", description: "", flow: RELECTURE, origine: "creee", exempleId: null, exempleVersion: null, avance: false });
    const avant = { principale: h.fake.requests.length, salle: h.omo.fake.requests.length };
    const res = await h.call("POST", "/api/teams/equipe-gf5-p11/estimate", { headers: h.headers.mutating, body: { directory: "/workspace/proj", rootId: SALLE } });
    assert.equal(res.status, 409, res.body);
    assert.equal(res.json<{ error: string }>().error, "instance-salle");
    assert.equal(h.fake.requests.length, avant.principale);
    assert.equal(h.omo.fake.requests.length, avant.salle);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM team_runs").get() as { n: number }).n, 0);
    // L'exécuteur ne connaît que le client de l'instance principale : aucune référence aux instances.
    const runner = lire("app", "server", "team-runner.ts");
    assert.doesNotMatch(runner, /instances\.omo|instances\?\.omo|\.of\("omo"\)/);
  });
});

// --- 3. Démonstration d'équipe dans le choix du lecteur complet (porte « 3D ») -------------------------------------------------

describe("croisements grande fusion (3) : démonstration d'équipe dans le lecteur complet de l'it3 (U1)", () => {
  it("fonction pure qui compose le choix : Simple fermé → aucune ; ouverture en une ligne → présente ; Avancé → présente ; lecture en échec → absente", () => {
    const choix = (mode: "simple" | "avance", ouvertes: boolean | null) => demonstrationsProposees(equipesOuvertes(mode, ouvertes));
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.equal(choix("simple", EQUIPES_SIMPLE_OUVERTES).includes("equipe"), false, "Simple, constante fausse : aucune démonstration d'équipe");
    assert.equal(choix("simple", true).includes("equipe"), true, "ouverture en une ligne : présente");
    assert.equal(choix("avance", false).includes("equipe"), true);
    assert.equal(choix("simple", null).includes("equipe"), false, "lecture en échec : fermé");
  });

  it("DemoPlayer : l'entrée passe par le lecteur complet (vitesses, pas à pas, badge « EN DIFFÉRÉ ») ; ni fetch, ni api, ni oc ; ne lit jamais ouvertesEnSimple", () => {
    const source = lire("app", "web", "pages", "chat", "activity", "DemoPlayer.tsx");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const interdit of [/\bfetch\s*\(/, /\bapi\b/, /\boc\b/, /ouvertesEnSimple/, /\bimport\s*\(/]) assert.doesNotMatch(code, interdit, String(interdit));
    assert.ok(code.includes("const proposees = demonstrationsProposees(equipesVisibles).map((une) => PAR_CLE[une]);"));
    assert.ok(code.includes('equipe: demonstration("equipe", TEXTES_C5.partout.demonstration.titre, { faits: FAITS_EQUIPE }),'));
    // Même lecteur pour toutes les démonstrations proposées : useReplay et ReplayBar (vitesses, pas à pas, badge du lecteur).
    const complet = code.slice(code.indexOf("function LecteurComplet("), code.indexOf("function DemonstrationPassee("));
    assert.ok(complet.includes("useReplay(faits, null)") && complet.includes("<ReplayBar") && complet.includes("vitesse={lecteur.etat.vitesse}"));
    assert.ok(complet.includes('{demo.cle === "equipe" ? <ContenuDemoEquipe moment={momentEquipeAu(t)} advanced={advanced} /> : null}'));
    assert.match(lire("app", "server", "shared", "revoir-texts.ts"), /badgeDiffere: "EN DIFFÉRÉ ×\{vitesse\} · \{heure\}"/);
    // Défaut faux ; l'appelant de la page du chat passe la valeur calculée par equipesOuvertes.
    assert.match(code, /export function DemoPlayer\(\{ advanced, demo: passee, equipesVisibles = false, onClose \}/);
    const region = compact(lire("app", "web", "pages", "chat", "activity", "ActivityRegion.tsx"));
    assert.ok(region.includes('const equipesVisibles = equipesOuvertes(advanced ? "avance" : "simple", useOuvertesEnSimple(!advanced));'));
    assert.ok(region.includes("<DemoPlayer advanced={advanced} equipesVisibles={equipesVisibles} onClose={fermerDemonstration} />"));
    assert.ok(compact(lire("app", "web", "pages", "assistants", "teams", "TeamsTab.tsx")).includes("<TeamDemo advanced={advanced} equipesVisibles={ouvertes} "));
  });

  it("zéro requête vers opencode : la source de la démonstration d'équipe et le crochet de lecture n'importent aucun client ; la lecture de ouvertesEnSimple n'a lieu qu'en Simple, à l'affichage", () => {
    const source = lire("app", "web", "pages", "assistants", "teams", "demo-equipe-source.tsx");
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /lib\/api|fetch\(|\boc\./);
    const crochet = lire("app", "web", "pages", "chat", "activity", "useOuvertesEnSimple.ts");
    assert.match(crochet, /if \(!lire\) return undefined;/);
    assert.match(crochet, /teamsApi\.list\(\)/);
    assert.doesNotMatch(crochet, /\boc\.|lib\/api\.ts/);
  });

  it("en Simple, aucune proposition d'équipe dans « Revoir » ni dans le lecteur (plan it3 §8.4 (c)) : « Revoir » n'importe rien des équipes", () => {
    const revoir = lire("app", "web", "pages", "salle-controle", "revoir", "RevoirDialog.tsx");
    for (const interdit of [/equipes-ouvertes/, /api-teams/, /TeamDemo/, /demonstration\.voir/, /TEXTES_C5\.partout\.demonstration/]) assert.doesNotMatch(revoir, interdit, String(interdit));
  });
});

// --- 4. « Revoir » d'une conversation d'équipe avec relecture ------------------------------------------------------------------------

const MODEL = "github-copilot/gpt-5-mini";
const AGENT_REDAC = "relire-script";
const AGENT_RELEC = "relire-requete-sql";

const lectureSeule = (): Rule[] => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
];
const agentEtape = (name: string): FakeAgent => ({ name, mode: "all", description: `Assistant de test ${name}`, options: {}, permission: lectureSeule() as FakeAgent["permission"] });
const etape = (id: string, titre: string, assistant: string, recoit: FlowStep["recoit"]): FlowStep => ({
  id,
  titre,
  assistant,
  niveau: null,
  taille: "M",
  consigne: `Consigne de ${titre}.`,
  recoit,
});
const RELECTURE: Flow = {
  version: 1,
  blocs: [{ type: "relecture", id: "rel", auteur: etape("redac", "Rédaction", AGENT_REDAC, "demande"), relecteur: etape("relec", "Relecture", AGENT_RELEC, "precedent"), toursMax: 2, pauseAvantRelecture: false }],
};

/**
 * Point 4 (« relecture et choix », plan it5 §8.6 GF5) : la relecture en deux tours, puis un aiguillage dont l'aiguilleur propose
 * un spécialiste (ligne CHOIX:) ; VOUS confirmez le choix (pause « attente-choix »), l'autre spécialiste reste « Non choisi ».
 */
const RELECTURE_ET_CHOIX: Flow = {
  version: 1,
  blocs: [
    ...RELECTURE.blocs,
    {
      type: "aiguillage",
      id: "aig",
      aiguilleur: etape("tri", "Tri", AGENT_RELEC, "precedent"),
      specialistes: [etape("s1", "Réseau", AGENT_REDAC, "demande"), etape("s2", "Base", AGENT_REDAC, "demande")],
      choixMax: 1,
      synthese: null,
    },
  ],
};

/** Étapes déclarées du déroulé, dans l'ordre d'écriture, avec leur bloc (le faux pré-lancement couvre la liste ENTIÈRE). */
const etapesDeclarees = (flow: Flow): Array<{ step: FlowStep; blocIndex: number }> =>
  flow.blocs.flatMap((bloc, blocIndex) => {
    if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur].map((step) => ({ step, blocIndex }));
    if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : [])].map((step) => ({ step, blocIndex }));
    return [];
  });

const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const SIMPLE: NeonSceneOptions = { zoom: 2, mode: "simple" };
/** Plan 3D d'une conversation au moment `t` (null : tous les faits), comme croisements-3d-fusion (GF12). */
const planDe = (faits: readonly ActivityFact[], t: number | null, vue: NeonSceneOptions): Plan3d => planConversation(scene(faits, t, vue), { theme: "sombre", mode: vue.mode });

/** Équipe « relecture en deux tours, puis aiguillage » sur le cockpit réuni (modules « tous », équipes « tous », salle), pré-lancement doublé. */
async function equipeRelecture(t: TestContext) {
  const ctx: { plan: RunPlan | null } = { plan: null };
  const preflight: TeamPreflightPort = {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }) as never,
    check: async (): Promise<PreflightOutcome> => ({ ok: true, plan: ctx.plan as RunPlan }),
    recheck: async () => ({ ok: true }),
  };
  const team: TeamRow = {
    id: "equipe-gf5",
    titre: "[synthétique] Rédaction relue",
    description: "",
    flow: JSON.stringify(RELECTURE_ET_CHOIX),
    origine: "exemple",
    exemple_id: "enquete-incident",
    exemple_version: 1,
    avance: 0,
    created_at: 1,
    updated_at: 1,
  };
  const teams: TeamsPort = { get: (id) => (id === team.id ? team : null), estimate: async () => ({ ok: false, status: 409, code: "a-venir" }) };
  const runnerModule: EqModule = createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 1_000 });
  const h = await startCockpit(t, {
    modules: "tous",
    equipes: ["agentMap", "teams", "teamPreflight", runnerModule, "teamGuards"],
    eqPorts: { preflight, teams },
    omo: true,
    settings: { ui: { mode: "avance" } },
  });
  h.fake.setAgents([...h.fake.agents(), agentEtape(AGENT_REDAC), agentEtape(AGENT_RELEC)]);
  const directory = h.fake.directory;
  const snapshot = await h.cockpit.c11.lookup.get(directory);
  const regles = (name: string): Rule[] => snapshot.agents.find((agent) => agent.name === name)?.permission ?? [];
  const etapes: PlannedStep[] = etapesDeclarees(RELECTURE_ET_CHOIX).map(({ step: s, blocIndex }, index) => {
    const agentRules = regles(s.assistant);
    return {
      stepId: s.id,
      blocIndex,
      ordre: index + 1,
      titre: s.titre,
      assistant: s.assistant,
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
  createTeamStore({ db: h.db }).teams.put({ id: team.id, titre: team.titre, description: "", flow: RELECTURE_ET_CHOIX, origine: "exemple", exempleId: "enquete-incident", exempleVersion: 1, avance: false });
  const estimate: FlowEstimate = {
    typique: 0.2,
    maximum: 0.8,
    plafond: 0.8,
    etapesFacturees: etapes.length,
    depassementUnAppel: 0.02,
    relais: 0,
    parEtape: etapes.map((e) => ({ stepId: e.stepId, titre: e.titre, assistant: e.assistant, model: MODEL, modelLabel: "GPT-5 mini", niveau: null, choisieParEquipe: false, typique: 0.05, maximum: 0.2, source: "profil" as const })),
  };
  ctx.plan = {
    flow: RELECTURE_ET_CHOIX,
    flowSha256: sha256(JSON.stringify(RELECTURE_ET_CHOIX)),
    estimate,
    estimateSha256: "b".repeat(64),
    plafond: estimate.plafond,
    rootId: null,
    directory,
    modeUi: "avance",
    agentConversation: "build",
    iaConversation: { model: MODEL, variant: null },
    etapes,
  };
  h.fake.scriptWhen(
    (session) => (session.metadata as { etape?: string } | undefined)?.etape === "redac",
    { text: "[synthétique] Version 1 du compte rendu.", cost: 0.01, stepMs: 5 },
    { text: "[synthétique] Version 2 du compte rendu.", cost: 0.01, stepMs: 5 },
    { text: "[synthétique] Version 3 du compte rendu.", cost: 0.01, stepMs: 5 },
  );
  h.fake.scriptWhen(
    (session) => (session.metadata as { etape?: string } | undefined)?.etape === "relec",
    { text: `[synthétique] Les causes ne sont pas étayées.${NL}VERDICT: À REPRENDRE`, cost: 0.01, stepMs: 5 },
    { text: `[synthétique] Il reste un point.${NL}VERDICT: À REPRENDRE`, cost: 0.01, stepMs: 5 },
  );
  for (const [stepId, texte] of [
    ["tri", `[synthétique] Le réseau d'abord.${NL}CHOIX: Réseau`],
    ["s1", "[synthétique] Réseau : pertes de paquets la nuit."],
    ["s2", "[synthétique] Base : verrous longs."],
  ] as const) {
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === stepId, { text: texte, cost: 0.01, stepMs: 5 });
  }
  const runner = h.cockpit.equipes.eq.ports.runner as TeamRunner;
  const attendre = (runId: string, etats: readonly string[]): Promise<TeamRunView> =>
    until(() => {
      const v = runner.view(runId);
      return v && etats.includes(v.state) ? v : undefined;
    }, 15_000);
  const lancer = async (): Promise<{ runId: string; rootId: string; enChoix: TeamRunView; vue: TeamRunView }> => {
    const res = await h.call("POST", `/api/teams/${team.id}/run`, {
      headers: h.headers.mutating,
      body: { directory, rootId: null, demande: "[synthétique] Rédige le compte rendu.", fichiers: [], agentConversation: "build", estimateSha256: ctx.plan?.estimateSha256, confirmations: {} },
    });
    assert.equal(res.status, 202, res.body);
    const { runId, rootId } = res.json<TeamRunStarted>();
    // Pause de choix de l'aiguillage : VOTRE confirmation, jamais un départ automatique (spéc. §4.11 l.772).
    const enChoix = await attendre(runId, ["attente-choix", "terminee", "echec", "plafond"]);
    assert.equal(enChoix.state, "attente-choix", JSON.stringify(enChoix.state));
    const choix = await h.call("POST", `/api/team-runs/${runId}/continue`, { headers: h.headers.mutating, body: { choix: ["s1"] } });
    assert.equal(choix.status, 200, choix.body);
    const vue = await attendre(runId, ["terminee", "echec", "plafond"]);
    return { runId, rootId, enChoix, vue };
  };
  return { h, lancer };
}

describe("croisements grande fusion (4) : « Revoir » d'une conversation d'équipe avec relecture et choix (U2 × relecture × aiguillage)", () => {
  it("relecture en 2 tours puis aiguillage confirmé : une consigne par tour (etape-1-…, etape-2-…, mêmes sessions) listées par l'enfant ; « Revoir » = faits du direct (sessions d'étape comprises), plan 3D à chaque moment = direct du préfixe (Avancé et Simple), sans requête ni ligne usage, textes d'étape jamais rendus ; suppression → consignes et message_text vidés", async (t) => {
    const { h, lancer } = await equipeRelecture(t);
    const { runId, rootId, enChoix, vue } = await lancer();
    assert.equal(vue.state, "terminee", JSON.stringify(vue.state));
    assert.deepEqual(
      enChoix.pause?.choix?.map((c) => [c.stepId, c.propose]),
      [
        ["s1", true],
        ["s2", false],
      ],
      "la proposition de l'aiguilleur (ligne CHOIX:) est présélectionnée",
    );
    assert.deepEqual(vue.steps.find((s) => s.stepId === "tri")?.choix, ["s1"], "votre choix");
    assert.equal(vue.steps.find((s) => s.stepId === "s2")?.state, "non-choisi");
    // L'exécuteur rafraîchit l'archive APRÈS avoir posé « terminee » (team-runner.ts) : ses lectures (GET /session/:id, …/message)
    // appartiennent au lancement, pas à « Revoir ». Attendues ici, avant le repère.
    await until(() => h.db.prepare("SELECT 1 AS x FROM conversations WHERE session_id = ?").get(rootId), 10_000);
    await h.processor.settled();
    await h.attentesAuRepos();
    const lignes = h.db.prepare("SELECT step_id, tour, session_id FROM team_run_steps WHERE run_id = ? ORDER BY ordre, tour").all(runId) as Array<{ step_id: string; tour: number; session_id: string | null }>;
    const sessionDe = (stepId: string) => lignes.find((l) => l.step_id === stepId)?.session_id ?? "";
    const redac = sessionDe("redac");
    const relec = sessionDe("relec");
    const tri = sessionDe("tri");
    const specialiste = sessionDe("s1");
    assert.ok(redac && relec && redac !== relec);
    assert.ok(tri && specialiste && new Set([redac, relec, tri, specialiste]).size === 4, "une session par étape qui a travaillé");
    assert.equal(sessionDe("s2"), "", "le spécialiste écarté n'a aucune session");
    for (const l of lignes.filter((ligne) => ligne.step_id === "redac" || ligne.step_id === "relec")) {
      assert.equal(l.session_id, l.step_id === "redac" ? redac : relec, "mêmes sessions à chaque tour (D-5-14)");
    }
    const consignes = h.db.prepare("SELECT call_id, enfant_session_id FROM revoir_consignes WHERE root_id = ? ORDER BY call_id").all(rootId) as Array<{ call_id: string; enfant_session_id: string }>;
    assert.deepEqual(
      consignes.filter((c) => c.enfant_session_id === relec).map((c) => c.call_id),
      [`etape-1-1-${relec}`, `etape-2-1-${relec}`],
      "une consigne par tour du relecteur",
    );
    assert.deepEqual(
      consignes.filter((c) => c.enfant_session_id === redac).map((c) => c.call_id),
      [`etape-1-1-${redac}`, `etape-2-1-${redac}`, `etape-3-1-${redac}`],
      "une consigne par tour de l'auteur (deux révisions)",
    );
    for (const enfant of [tri, specialiste]) {
      assert.deepEqual(
        consignes.filter((c) => c.enfant_session_id === enfant).map((c) => c.call_id),
        [`etape-1-1-${enfant}`],
        "une consigne pour l'aiguilleur et pour le spécialiste choisi",
      );
    }
    // Consigne d'une délégation dans la même conversation (U2) : purgée avec le reste.
    assert.equal(createConsignesStore(h.db).enregistrer({ rootId, parent: rootId, enfant: "ses_gf5_delegue", callId: "call_gf5_task", brut: "[synthétique] consigne déléguée", at: Date.now() }), "enregistree");

    // Direct : faits de la conversation lus en mode Avancé par la route du Déroulé (/facts), AVANT le repère de « Revoir ».
    const lectureDirecte = await h.call("GET", `/api/conversations/${rootId}/facts?since=0`, { headers: h.headers.authed });
    assert.equal(lectureDirecte.status, 200, lectureDirecte.body);
    const direct = lectureDirecte.json<FactsResponse>();
    assert.equal(direct.partial, false);
    const sessionsDirect = new Set(direct.facts.map((f) => f.sessionId));
    for (const [nom, session] of [
      ["conversation", rootId],
      ["rédaction", redac],
      ["relecture", relec],
      ["aiguilleur", tri],
      ["spécialiste choisi", specialiste],
    ] as const) {
      assert.ok(sessionsDirect.has(session), `témoin du direct : faits de la session « ${nom} » absents de /facts`);
    }

    // « Revoir » : zéro requête opencode, zéro ligne usage ; ni résultat d'étape ni texte de relecture rendu.
    const avant = { requetes: h.fake.requests.length, usage: lignesUsage(h) };
    const revoir = await h.call("GET", `/api/revoir/${rootId}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    const lu = revoir.json<RevoirResponse>();
    assert.equal(lu.instance, "principale");
    assert.equal(lu.partial, false);
    // « Différé = direct » (point 4) : « Revoir » sert EXACTEMENT les faits du direct, sessions d'étape, tours de relecture,
    // aiguilleur et spécialiste compris (jamais les seuls faits de la racine).
    assert.deepEqual(lu.facts, direct.facts, "différé = direct : « Revoir » sert les faits de la lecture en direct");
    const sessionsRevues = new Set(lu.facts.map((f) => f.sessionId));
    for (const [nom, session] of [
      ["rédaction", redac],
      ["relecture", relec],
      ["aiguilleur", tri],
      ["spécialiste choisi", specialiste],
    ] as const) {
      assert.ok(sessionsRevues.has(session), `« Revoir » sans les faits de la session d'étape « ${nom} »`);
    }
    // Même lecture en mode Simple (conversation de l'instance principale : accès dans les deux modes, D-3d-09).
    h.settings.update({ ui: { mode: "simple" } });
    const revoirSimple = await h.call("GET", `/api/revoir/${rootId}`, { headers: h.headers.authed });
    assert.equal(revoirSimple.status, 200, revoirSimple.body);
    assert.deepEqual(revoirSimple.json<RevoirResponse>().facts, direct.facts, "différé = direct, en Simple aussi");
    h.settings.update({ ui: { mode: "avance" } });
    // Plan 3D rejoué à chaque moment = plan du direct sur le préfixe des faits, en Avancé et en Simple (comme GF12).
    const tous = moments(lu.facts);
    assert.ok(tous.length > 1, "la conversation d'équipe a plusieurs moments");
    for (const moment of tous) {
      const prefixe = direct.facts.slice(0, visibleCount(direct.facts, moment));
      for (const vueScene of [AVANCE, SIMPLE]) assert.deepEqual(planDe(lu.facts, moment, vueScene), planDe(prefixe, null, vueScene), `moment ${moment}, ${vueScene.mode}`);
    }
    for (const enfant of [redac, relec]) {
      const parEnfant = await h.call("GET", `/api/revoir/${rootId}/consignes?enfant=${enfant}`, { headers: h.headers.authed });
      assert.equal(parEnfant.status, 200, parEnfant.body);
      assert.equal(parEnfant.json<RevoirConsignesEnfantResponse>().consignes.length, enfant === redac ? 3 : 2, "[Voir la consigne] : chaque tour listé");
    }
    for (const texte of [
      "Version 3 du compte rendu.",
      "Les causes ne sont pas étayées.",
      "Il reste un point.",
      "Le réseau d'abord.",
      "CHOIX: Réseau",
      "Réseau : pertes de paquets la nuit.",
    ]) {
      assert.equal(revoir.body.includes(texte), false, `texte d'étape rendu par « Revoir » : ${texte}`);
    }
    assert.deepEqual(
      h.fake.requests.slice(avant.requetes).map((r) => `${r.method} ${r.pathname}`),
      [],
      "zéro requête à opencode pendant « Revoir »",
    );
    assert.equal(lignesUsage(h), avant.usage, "zéro ligne usage pendant « Revoir »");
    // La phrase « Texte non affiché pendant « Revoir » » est celle de l'interface pour tout texte de message (U2).
    assert.match(lire("app", "server", "shared", "revoir-texts.ts"), /Texte non affiché pendant « Revoir »/);

    // Suppression de la conversation (point unique, archive.remove) : consignes de délégation et d'étape, message_text vidés.
    h.db.prepare("INSERT OR IGNORE INTO conversations (session_id, title, created_at, updated_at) VALUES (?, '[synthétique]', ?, ?)").run(rootId, Date.now(), Date.now());
    const supprimee = await h.call("DELETE", `/api/archive/${rootId}`, { headers: h.headers.mutating });
    assert.equal(supprimee.status, 200, supprimee.body);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes WHERE root_id = ?").get(rootId) as { n: number }).n, 0);
    assert.equal(
      (h.db.prepare("SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ? AND message_text IS NOT NULL").get(runId) as { n: number }).n,
      0,
      "message_text vidé",
    );
  });
});

// --- 5. Salle de contrôle 3D : étapes dessinées à partir des faits (P12) ---------------------------------------------------------

describe("croisements grande fusion (5) : étapes d'équipe dessinées seulement à partir de faits (P12)", () => {
  const fixture = JSON.parse(lire("app", "web", "pages", "assistants", "teams", "demo-equipe.json")) as { moments: Array<{ faits: ActivityFact[] }> };
  const faits = fixture.moments.flatMap((m) => m.faits);
  it("chaque nœud de la scène est une session nommée par un fait ; retirer les faits d'une étape retire son nœud ; la scène ne lit pas les tables d'équipe", () => {
    const sessionsDesFaits = new Set(faits.map((f) => f.sessionId));
    const vue = scene(faits, null, { zoom: 2, mode: "avance" });
    assert.ok(vue.noeuds.length >= 3, "conversation et étapes dessinées");
    for (const noeud of vue.noeuds) assert.ok(sessionsDesFaits.has(noeud.sessionId), `nœud sans fait : ${noeud.sessionId}`);
    const etape = vue.noeuds.find((n) => n.role !== "conversation");
    assert.ok(etape);
    const sans = scene(
      faits.filter((f) => f.sessionId !== etape.sessionId),
      null,
      { zoom: 2, mode: "avance" },
    );
    assert.equal(
      sans.noeuds.some((n) => n.sessionId === etape.sessionId),
      false,
      "aucun nœud sans ses faits",
    );
    const source = lire("app", "server", "shared", "neon-scene.ts");
    assert.doesNotMatch(source, /team_run|team-runner|team-store/);
  });
});

// --- 6. Câblage ---------------------------------------------------------------------------------------------------------------------

describe("croisements grande fusion (6) : câblage réuni", () => {
  it("MODULE_ORDER et STEP_ORDER complets (salle, construction, table des attentes) ; EQ_MODULE_ORDER inchangé (H4)", async (t) => {
    for (const nom of [...OMO_MODULE_NAMES, ...CONSTRUCTION_MODULE_ORDER, "pending", "gate"]) assert.ok((MODULE_ORDER as readonly string[]).includes(nom), nom);
    assert.deepEqual(STEP_ORDER.derivations.slice(0, 2), ["pending", "gate"]);
    assert.deepEqual(STEP_ORDER.routes.at(-1), ["omo", "omoRoom"]);
    assert.deepEqual([...EQ_MODULE_ORDER], ["agentMap", "teams", "teamPreflight", "teamRunner", "teamGuards"]);
    const h = await startCockpit(t, { modules: "tous", equipes: "tous", omo: true });
    assert.deepEqual(h.cockpit.wiring.modules, [...MODULE_ORDER]);
    const derivations = h.cockpit.wiring.registrations.filter((r) => r.kind === "derivation").map((r) => `${r.key}${r.instances ? `@${r.instances.join("+")}` : ""}`);
    assert.deepEqual(derivations.slice(0, 4), ["pending", "pending@omo", "gate", "gate@omo"], "table des attentes de chaque instance, avant les portillons");
    const cles = h.cockpit.wiring.registrations.map((r) => `${r.kind}|${r.key}|${r.module}|${(r.instances ?? []).join("+")}`);
    assert.equal(new Set(cles).size, cles.length, "aucune inscription en double");
  });
});

// --- 7 et 8. Gardes du dépôt, P13, P8, migrations -------------------------------------------------------------------------------

describe("croisements grande fusion (7, 8) : gardes du dépôt, P13, P8, migrations", () => {
  it("les tests « textes », pureté, web-animations, salle3d-animations et construction-balises existent et sont joués par npm test", () => {
    const serveur = path.join(APP_DIR, "server");
    for (const fichier of ["textes.test.ts", "textes-3d.test.ts", "web-animations.test.ts", "salle3d-animations.test.ts", "construction-balises.test.ts", "p8-dependances.test.ts", "omo-p13.test.ts"]) {
      assert.ok(fs.existsSync(path.join(serveur, fichier)), fichier);
    }
    const paquet = JSON.parse(lire("app", "package.json")) as { scripts: { test: string } };
    assert.match(paquet.scripts.test, /server\/\*\*\/\*\.test\.ts/);
  });

  it("package.json = v1.0.6 + three@0.186.0 SEUL ajout (fiche v106 §4 : « v1.0.6 + three », et non v1.0.5) ; aucune autre dépendance", () => {
    const paquet = JSON.parse(lire("app", "package.json")) as { version: string; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    assert.equal(paquet.version, "1.0.6", "le champ version passe à 1.1.0 avec L51 seulement");
    assert.deepEqual(Object.keys(paquet.dependencies).sort(), ["@hono/node-server", "hono", "jsonc-parser", "yaml", "zod"]);
    assert.equal(paquet.devDependencies.three, "0.186.0");
    const verrou = JSON.parse(lire("app", "package-lock.json")) as { packages: Record<string, { version?: string }> };
    assert.equal(verrou.packages["node_modules/three"]?.version, "0.186.0");
  });

  it("P13 : aucun workflow ne cite l'image de la salle ni l'extension ; compose pull_policy: never pour la salle", () => {
    const workflows = path.join(DEPOT, ".github", "workflows");
    for (const nom of fs.readdirSync(workflows)) {
      const texte = fs.readFileSync(path.join(workflows, nom), "utf8");
      assert.doesNotMatch(texte, /opencode-omo|oh-my-openagent/, nom);
    }
    assert.match(lire("docker-compose.yml"), /pull_policy: never/);
  });

  it("migrations : 6 (salle) et 8 (consignes) appliquées, 7 réservée vide, 9 absente ; user_version === MIGRATIONS.length", () => {
    // Règle unique d'assertion (A2, plan it5 §8.5) : aucun nombre écrit ; la DERNIÈRE entrée est la 8 (consignes), donc pas de 9.
    assert.match(MIGRATIONS.at(-1) ?? "", /CREATE TABLE revoir_consignes/, "aucune entrée 9 (réservée à la construction, inutilisée)");
    assert.match(MIGRATIONS.at(-3) ?? "", /CREATE TABLE omo_rooms/);
    assert.equal((MIGRATIONS[6] ?? "x").replace(/--[^\n]*/g, "").trim(), "", "entrée 7 : commentaire SQL seul");
    assert.match(MIGRATIONS[7] ?? "", /CREATE TABLE revoir_consignes/);
    const db = openMemoryDb();
    try {
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it("constantes de fermeture inchangées : SALLE_OUVERTE false, EQUIPES_SIMPLE_OUVERTES false", () => {
    assert.equal(SALLE_OUVERTE, false);
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
  });
});

// --- 9. Banc e2e : émulation dédoublonnée (§2.8) --------------------------------------------------------------------------------

describe("croisements grande fusion (9) : émulation d'accessibilité dédoublonnée (plan it5 §2.8)", () => {
  const fichiersE2e = (): string[] => {
    const out: string[] = [];
    const parcourir = (dossier: string) => {
      for (const entree of fs.readdirSync(path.join(DEPOT, dossier), { withFileTypes: true })) {
        const relatif = `${dossier}/${entree.name}`;
        if (entree.isDirectory()) {
          if (entree.name !== "node_modules") parcourir(relatif);
        } else if (/\.(?:mjs|js|ts)$/.test(entree.name)) out.push(relatif);
      }
    };
    parcourir("e2e");
    return out;
  };
  const envois = (motif: RegExp) => fichiersE2e().filter((f) => motif.test(fs.readFileSync(path.join(DEPOT, f), "utf8")));

  it("Emulation.setEmulatedMedia ENVOYÉ seulement par emulerMedias de cdp.mjs ; docker-e2e.mjs : données et relevés de la garde du mouvement, jamais un envoi", () => {
    assert.deepEqual(envois(/envoyer\(\s*"Emulation\.setEmulatedMedia"/), ["e2e/lib/cdp.mjs"]);
    const cdp = lire("e2e", "lib", "cdp.mjs");
    assert.equal((cdp.match(/envoyer\("Emulation\.setEmulatedMedia"/g) ?? []).length, 1, "un seul envoi : emulerMedias");
    for (const fichier of fichiersE2e().filter((f) => f !== "e2e/lib/cdp.mjs")) {
      const texte = fs.readFileSync(path.join(DEPOT, fichier), "utf8");
      assert.doesNotMatch(texte, /\.envoyer\(\s*"Emulation\.setEmulatedMedia"/, fichier);
    }
    // webgl.mjs : emuler passe par l'onglet (medias), fermetureUnique gardée ; a11y.mjs appelle onglet.medias.
    const webgl = lire("e2e", "lib", "webgl.mjs");
    assert.doesNotMatch(webgl, /setEmulatedMedia"/);
    assert.match(webgl, /onglet\.medias\(/);
    assert.match(webgl, /export function fermetureUnique\(/);
    assert.match(lire("e2e", "lib", "a11y.mjs"), /onglet\.medias\(/);
  });

  it("Emulation.setEmulatedVisionDeficiency seulement dans a11y.mjs", () => {
    assert.deepEqual(envois(/"Emulation\.setEmulatedVisionDeficiency"/), ["e2e/lib/a11y.mjs"]);
  });
});

// --- Croisement MW × contrôle « internet » d'H4 (fiche de la migration du web §8) ----------------------------------------------

describe("croisement MW × contrôle « internet » des équipes (evaluate ≠ deny, flow.ts usesInternet)", () => {
  /** Règles effectives d'un assistant sans règle propre sous cette configuration globale (défauts, puis global : agent.ts). */
  const regles = (globalPermission: unknown) => effectiveAgentRules(globalPermission, undefined);

  it("volume 1.0.6 MIGRÉ et Prudent 1.1 : l'assistant passe le contrôle ; volume NON migré (Prudent 1.0) : bloqué (témoin)", () => {
    const fixture = fs.readFileSync(path.join(import.meta.dirname, "test-support", "oc-config-1.0.6.jsonc"), "utf8");
    const avant = (parseJsonc(fixture) as { permission: unknown }).permission;
    assert.equal(usesInternet(regles(avant)), true, "témoin : le Prudent 1.0 demande encore Internet (« ask »)");
    const migration = planWebMigration({ "opencode.jsonc": fixture });
    assert.equal(migration.etat, "migre");
    const apres = (parseJsonc(migration.texte ?? "{}") as { permission: unknown }).permission;
    assert.equal(usesInternet(regles(apres)), false, "volume migré : webfetch et websearch refusés, l'assistant passe");
    assert.equal(usesInternet(regles(PERMISSION_PRESETS.prudent.permission)), false, "Prudent 1.1");
    assert.equal(usesInternet(regles(PERMISSION_PRESETS_1_0.prudent)), true, "Prudent 1.0 : bloqué");
  });

  it("configuration personnalisée SANS clé webfetch : reste BLOQUÉE (« * » : allow par défaut d'opencode) ; avec webfetch et websearch à deny : passe", () => {
    const sansCle = { edit: "ask", bash: { "*": "ask" }, task: "ask" };
    assert.equal(usesInternet(regles(sansCle)), true, "sans clé webfetch, opencode l'autorise par défaut : l'assistant est refusé comme étape");
    // La migration ne l'ajoute jamais (aucune clé ajoutée, fiche MW R5) : le cas reste à l'utilisateur, et la phrase le dit (L51).
    const texte = JSON.stringify({ permission: sansCle }, null, 2);
    const plan = planWebMigration({ "opencode.json": texte });
    assert.equal(plan.etat, "conforme");
    assert.equal(plan.texte, texte, "aucune clé ajoutée");
    assert.equal(usesInternet(regles({ ...sansCle, webfetch: "deny", websearch: "deny" })), false, "avec les deux clés à deny : passe");
    // Une seule des deux clés à deny ne suffit pas : l'autre outil reste permis par défaut (evaluate ≠ deny sur chacun).
    assert.equal(usesInternet(regles({ ...sansCle, webfetch: "deny" })), true, "webfetch seul à deny : websearch reste permis, bloqué");
    assert.equal(usesInternet(regles({ ...sansCle, websearch: "deny" })), true, "websearch seul à deny : webfetch reste permis, bloqué");
  });
});
