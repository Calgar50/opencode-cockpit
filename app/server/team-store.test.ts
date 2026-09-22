// Magasin des équipes (L37s, plan d'exécution it4 fiche L37s ; D-eq-09, D-eq-26, A2) : base réelle ouverte par db.ts à sa
// version courante (règle unique d'assertion du §2.3 : `>= 5`, ou `MIGRATIONS.length` pour une base neuve, JAMAIS un nombre
// écrit), colonnes de la migration 4, transitions refusées, ON DELETE CASCADE, purge d'une conversation, coût observé, dépense
// d'un lancement, résumés rendus par /activity, et gardes (extrait masqué et coupé, événements sans texte de message, aucune
// écriture hors des tables d'équipes).
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { purgeConversation } from "./conversation-purge.ts";
import { MIGRATIONS, openMemoryDb } from "./db.ts";
import type { OcSession } from "./opencode.ts";
import { chooseEstimate, OBSERVED_MIN_SAMPLES } from "./shared/assistant-rules.ts";
import { COPILOT_PRICES } from "./pricing.ts";
import type { ActivityResponse } from "./shared/activity-types.ts";
import { TEAM_RUN_TRANSITIONS, TEAM_STEP_TRANSITIONS } from "./shared/team-limits.ts";
import type { Flow, TeamRunState, TeamStepState } from "./shared/team-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { createTeamStore, RESULT_EXCERPT_MAX, type StepKey, type TeamStore } from "./team-store.ts";

const ROOT = "ses_racine";
const RUN = "run_1";
const T = 1_800_000_000_000;
const DAY = 86_400_000;

const FLOW: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: { id: "e1", titre: "Standards", assistant: "relire-script", niveau: null, taille: "M", consigne: "Relis.", recoit: "demande" } },
    { type: "pause", id: "b2", message: "Vérifiez les points bloquants." },
    { type: "etape", id: "b3", etape: { id: "e2", titre: "Sécurité", assistant: "relire-script", niveau: "expert", taille: "M", consigne: "Relis.", recoit: "precedent" } },
  ],
};

/** Prix réel d'une IA du catalogue : la bascule « profil → observé » de chooseEstimate se lit sur la source, pas sur un montant. */
const PRIX = COPILOT_PRICES["gpt-5-mini"] as NonNullable<(typeof COPILOT_PRICES)[string]>;

const STEP1: StepKey = { runId: RUN, stepId: "e1", tour: 1, tentative: 1 };
const STEP2: StepKey = { runId: RUN, stepId: "e2", tour: 1, tentative: 1 };

function seeded(store: TeamStore, runId = RUN, rootId = ROOT) {
  store.teams.put({ id: "revue-sql", titre: "Revue SQL sur réplica", description: "Trois avis puis une synthèse.", flow: FLOW, origine: "exemple", exempleId: "revue-sql", exempleVersion: 1, avance: false });
  store.runs.create({
    id: runId,
    teamId: "revue-sql",
    teamTitre: "Revue SQL sur réplica",
    flow: FLOW,
    flowSha256: "flow-sha",
    estimateSha256: "estimation-sha",
    modeUi: "avance",
    rootId,
    directory: "/workspace",
    estimate: { typique: 0.2, maximum: 0.6 },
    plafond: 0.6,
    confirmations: { workspace: true },
  });
  store.steps.create({ runId, stepId: "e1", tour: 1, tentative: 1, ordre: 1, blocIndex: 0, titre: "Standards", agent: "relire-script", state: "prevue" });
  store.steps.create({ runId, stepId: "e2", tour: 1, tentative: 1, ordre: 2, blocIndex: 2, titre: "Sécurité", agent: "relire-script", state: "prevue" });
}

/** Une base neuve, à la version courante de db.ts, et son magasin. */
function base(t: TestContext, now: () => number = () => T) {
  const db = openMemoryDb();
  t.after(() => db.close());
  return { db, store: createTeamStore({ db, now }) };
}

const version = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** Nombre de lignes de chaque table, pour prouver qu'aucune table hors des équipes n'est écrite. */
function rowCounts(db: DatabaseSync): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const name of names) {
    try {
      out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    } catch {
      // Table interne d'un index plein texte : non comptée.
    }
  }
  return out;
}

describe("magasin des équipes : base et colonnes", () => {
  it("base réelle à la version courante de db.ts (jamais un nombre écrit) ; chaque colonne écrite existe et se relit", (t) => {
    const { db, store } = base(t);
    assert.ok(version(db) >= 5, `version de base ${version(db)}`);
    assert.equal(version(db), MIGRATIONS.length, "base neuve : dernière entrée du tableau des migrations");

    seeded(store);
    // Toutes les colonnes modifiables d'une étape, en une fois : une colonne absente ferait échouer la préparation SQL.
    store.steps.patch(STEP1, {
      sessionId: "ses_etape1",
      agentFileSha256: "agent-sha",
      rulesSha256: "regles-sha",
      floorSha256: "plancher-sha",
      rights: "lecture",
      rightLines: [{ id: "lecture", kind: "info", text: "Lit les fichiers du projet", danger: false, permission: "read", action: "allow" }],
      model: "github-copilot/gpt-5-mini",
      variant: null,
      steps: 40,
      cause: null,
      tronquee: true,
      messageSha256: "message-sha",
      messageText: "Consigne exacte envoyée à l'étape.",
      correctionSha256: "correction-sha",
      resultExcerpt: "Résultat lisible.",
      verdict: "ok",
      choix: "continuer",
      queuedAt: T + 1,
      startedAt: T + 2,
      endedAt: T + 3,
      cost: 0.2,
    });
    store.runs.patch(RUN, {
      estimateSha256: "estimation-2",
      requestMessageId: "msg_demande",
      resultMessageId: "msg_resultat",
      cause: "pause",
      estimateTypique: 0.3,
      estimateMax: 0.7,
      plafond: 0.7,
      cost: 0.25,
      confirmations: { workspace: true, secret: true },
      precisions: ["Regarde aussi les verrous."],
      startedAt: T + 10,
      endedAt: null,
    });
    const step = store.steps.get(STEP1);
    assert.equal(step?.message_text, "Consigne exacte envoyée à l'étape.", "texte exact gardé");
    assert.deepEqual([step?.rights, step?.steps, step?.tronquee, step?.cost, step?.verdict], ["lecture", 40, 1, 0.2, "ok"]);
    assert.equal(JSON.parse(String(step?.right_lines)).length, 1);
    const run = store.runs.get(RUN);
    assert.deepEqual([run?.request_message_id, run?.result_message_id, run?.cost, run?.estimate_max], ["msg_demande", "msg_resultat", 0.25, 0.7]);
    assert.deepEqual(JSON.parse(String(run?.precisions)), ["Regarde aussi les verrous."]);
    assert.deepEqual(JSON.parse(String(run?.confirmations)), { workspace: true, secret: true });

    // Les deux identifiants de messages injectés sont rendus par la vue.
    const view = store.runs.view(RUN);
    assert.deepEqual([view?.requestMessageId, view?.resultMessageId, view?.resultatsAjoutes], ["msg_demande", "msg_resultat", true]);
    assert.deepEqual(view?.steps.map((s) => [s.stepId, s.ordre, s.tronquee, s.ia.choisieParEquipe]), [
      ["e1", 1, true, false],
      ["e2", 2, false, true],
    ]);
    assert.equal(view?.steps[0]?.extrait, "Résultat lisible.");
    assert.equal(view?.estimate?.typique, 0.3);
  });

  it("équipes : lister, lire, écrire (avance), supprimer ; les lancements passés restent", (t) => {
    const { store } = base(t);
    seeded(store);
    assert.equal(store.teams.get("revue-sql")?.avance, 0);
    const modifiee = store.teams.put({ id: "revue-sql", titre: "Revue SQL", description: "", flow: FLOW, origine: "creee", avance: true });
    assert.deepEqual([modifiee.avance, modifiee.origine, modifiee.exemple_id, modifiee.created_at], [1, "creee", null, T]);
    assert.deepEqual(store.teams.list().map((t2) => t2.id), ["revue-sql"]);
    assert.equal(store.teams.remove("revue-sql"), true);
    assert.equal(store.teams.remove("revue-sql"), false);
    assert.equal(store.teams.get("revue-sql"), null);
    assert.equal(store.runs.get(RUN)?.team_id, "revue-sql", "le lancement reste au déroulé de la conversation");
  });

  it("aucune écriture hors des tables d'équipes", (t) => {
    const { db, store } = base(t);
    const avant = rowCounts(db);
    seeded(store);
    store.steps.setState(STEP1, "en-cours");
    store.steps.patch(STEP1, { cost: 0.1, resultExcerpt: "fait" });
    store.steps.setState(STEP1, "terminee");
    store.runs.setState(RUN, "en-cours");
    store.events.append({ runId: RUN, kind: "etape-terminee", par: "cockpit", data: { etape: "e1" } });
    store.spentOfRun(RUN);
    store.summaries(ROOT);
    store.observedStepCost("relire-script", "github-copilot/gpt-5-mini", T - 30 * DAY);
    const apres = rowCounts(db);
    // sqlite_sequence : compteur interne de SQLite pour la clé AUTOINCREMENT de team_run_events, pas une table du cockpit.
    const changees = Object.keys(apres).filter((name) => apres[name] !== avant[name] && name !== "sqlite_sequence");
    assert.deepEqual(changees.sort(), ["team_run_events", "team_run_steps", "team_runs", "teams"]);
  });
});

describe("magasin des équipes : transitions", () => {
  it("un état final ne régresse jamais ; un état arrêté ne mène qu'à preparation ou arretee ; un refus n'écrit rien", (t) => {
    const { store } = base(t);
    seeded(store);
    assert.equal(store.runs.get(RUN)?.state, "preparation");

    // Table de T4 : un lancement fini (terminee, arretee) n'a aucune suite ; echec, interrompue et plafond n'ont que la
    // relance ou la fermeture. Chaque couple est essayé sur un lancement neuf amené à son état de départ.
    const etats = Object.keys(TEAM_RUN_TRANSITIONS) as TeamRunState[];
    const amener = (id: string, from: TeamRunState) => {
      if (from === "preparation") return;
      // « terminee » ne s'atteint que depuis « en-cours » ; tous les autres états partent de « preparation ».
      if (from === "terminee") assert.equal(store.runs.setState(id, "en-cours"), true);
      assert.equal(store.runs.setState(id, from), true, `arrivée en ${from}`);
    };
    for (const from of etats) {
      const permis = TEAM_RUN_TRANSITIONS[from] as readonly TeamRunState[];
      for (const to of etats) {
        const id = `run_${from}_${to}`;
        store.runs.create({ id, teamId: null, teamTitre: "T", flow: FLOW, flowSha256: "f", estimateSha256: null, modeUi: null, rootId: ROOT, directory: "/workspace", estimate: null, plafond: null });
        amener(id, from);
        assert.equal(store.runs.setState(id, to), permis.includes(to), `${from} → ${to}`);
        assert.equal(store.runs.get(id)?.state, permis.includes(to) ? to : from, `état après ${from} → ${to}`);
      }
    }
    assert.deepEqual(TEAM_RUN_TRANSITIONS.echec, ["preparation", "arretee"]);
    assert.deepEqual([TEAM_RUN_TRANSITIONS.terminee, TEAM_RUN_TRANSITIONS.arretee], [[], []]);
  });

  it("étapes : chaque état final est sans suite ; la date de fin est posée, la cause gardée ; un état inconnu est refusé", (t) => {
    const { store } = base(t);
    seeded(store);
    assert.equal(store.steps.setState(STEP1, "terminee"), false, "prevue → terminee n'existe pas dans la table de T4");
    assert.equal(store.steps.setState(STEP1, "en-cours", { at: T + 5 }), true);
    assert.equal(store.steps.setState(STEP1, "echec", { cause: "ia-indisponible", at: T + 9 }), true);
    assert.deepEqual([store.steps.get(STEP1)?.started_at, store.steps.get(STEP1)?.ended_at, store.steps.get(STEP1)?.cause], [T + 5, T + 9, "ia-indisponible"]);
    for (const to of Object.keys(TEAM_STEP_TRANSITIONS) as TeamStepState[]) {
      assert.equal(store.steps.setState(STEP1, to), false, `echec → ${to} refusé (état final)`);
    }
    assert.equal(store.steps.get(STEP1)?.state, "echec");
    assert.equal(store.steps.setState(STEP1, "inconnu" as TeamStepState), false);
    assert.equal(store.steps.setState({ ...STEP1, tentative: 9 }, "en-cours"), false, "tentative inconnue");

    // Nouvelle tentative : une ligne neuve, la ligne finie ne bouge pas.
    const deuxieme = { ...STEP1, tentative: 2 };
    store.steps.create({ ...deuxieme, ordre: 1, blocIndex: 0, titre: "Standards", agent: "relire-script", state: "en-file" });
    assert.equal(store.steps.get(deuxieme)?.queued_at, T);
    assert.equal(store.steps.setState(deuxieme, "en-cours"), true);
    assert.equal(store.steps.get(STEP1)?.state, "echec");
  });

  it("un lancement arrêté en chemin repart en preparation : sa date de fin est effacée", (t) => {
    const { store } = base(t);
    seeded(store);
    assert.equal(store.runs.setState(RUN, "en-cours", { at: T + 1 }), true);
    assert.equal(store.runs.setState(RUN, "plafond", { cause: "plafond", at: T + 2 }), true);
    assert.deepEqual([store.runs.get(RUN)?.ended_at, store.runs.get(RUN)?.cause], [T + 2, "plafond"]);
    assert.equal(store.runs.view(RUN)?.relancable, true);
    assert.equal(store.runs.setState(RUN, "preparation", { at: T + 3 }), true);
    assert.deepEqual([store.runs.get(RUN)?.ended_at, store.runs.get(RUN)?.cause, store.runs.get(RUN)?.started_at], [null, null, T + 1]);
    // « terminee » ne s'atteint que depuis « en-cours » : un lancement fini n'est plus relançable.
    assert.equal(store.runs.setState(RUN, "terminee", { at: T + 4 }), false, "preparation → terminee n'existe pas");
    assert.equal(store.runs.setState(RUN, "en-cours", { at: T + 4 }), true);
    assert.equal(store.runs.setState(RUN, "terminee", { at: T + 5 }), true);
    assert.equal(store.runs.view(RUN)?.relancable, false);
  });

  it("équipes actives : par conversation et en tout (P4, P5)", (t) => {
    const { store } = base(t);
    seeded(store);
    store.runs.create({ id: "run_2", teamId: null, teamTitre: "T", flow: FLOW, flowSha256: "f", estimateSha256: null, modeUi: null, rootId: "ses_autre", directory: "/workspace", estimate: null, plafond: null });
    assert.equal(store.runs.activeCount(), 2);
    assert.deepEqual(store.runs.activeOfRoot(ROOT).map((r) => r.id), [RUN]);
    store.runs.setState(RUN, "attente-verification");
    assert.deepEqual(store.runs.activeOfRoot(ROOT).map((r) => r.id), [RUN], "une pause reste active");
    store.runs.setState(RUN, "arretee");
    assert.deepEqual(store.runs.activeOfRoot(ROOT), []);
    assert.equal(store.runs.activeCount(), 1);
  });
});

describe("magasin des équipes : textes, purge et suppression", () => {
  it("extrait de résultat : masqué PUIS coupé à 2 000 caractères ; le texte envoyé reste exact", (t) => {
    const { store } = base(t);
    seeded(store);
    const secret = `ghp_${"a".repeat(36)}`;
    store.steps.patch(STEP1, { messageText: `Consigne avec ${secret}`, resultExcerpt: `${secret} puis ${"x".repeat(3_000)}` });
    const step = store.steps.get(STEP1);
    assert.equal(step?.message_text, `Consigne avec ${secret}`, "le texte envoyé est gardé tel quel (U2)");
    assert.equal(step?.result_excerpt?.includes(secret), false, "secret masqué");
    assert.equal(step?.result_excerpt?.length, RESULT_EXCERPT_MAX);
    assert.ok(step?.result_excerpt?.startsWith("gh_****"), "masqué d'abord, coupé ensuite");
  });

  it("purge d'une conversation : textes vidés, empreintes, coûts et états gardés (conversation-purge.ts existant)", (t) => {
    const { db, store } = base(t);
    seeded(store);
    store.steps.patch(STEP1, { messageSha256: "message-sha", messageText: "Consigne.", resultExcerpt: "Extrait.", cost: 0.2, floorSha256: "plancher-sha" });
    store.runs.patch(RUN, { precisions: ["Regarde les verrous."], cost: 0.5 });
    store.runs.setState(RUN, "en-cours");
    store.runs.setState(RUN, "terminee");
    store.events.append({ runId: RUN, kind: "pause", par: "vous", data: { bloc: "b2" } });

    assert.deepEqual(purgeConversation(db, ROOT), { runs: 1, steps: 1, decisions: 0, facts: 0 });
    const step = store.steps.get(STEP1);
    assert.deepEqual([step?.message_text, step?.result_excerpt], [null, null]);
    assert.deepEqual([step?.message_sha256, step?.floor_sha256, step?.cost], ["message-sha", "plancher-sha", 0.2]);
    const run = store.runs.get(RUN);
    assert.deepEqual([run?.precisions, run?.flow_sha256, run?.estimate_sha256, run?.state, run?.cost], ["[]", "flow-sha", "estimation-sha", "terminee", 0.5]);
    assert.equal(store.events.ofRun(RUN).length, 1, "les événements d'audit restent (aucun texte dedans)");
  });

  it("ON DELETE CASCADE : supprimer un lancement emporte ses étapes et ses événements, et lui seul", (t) => {
    const { db, store } = base(t);
    seeded(store);
    seeded(store, "run_2", "ses_autre");
    store.events.append({ runId: RUN, kind: "lancement", par: "vous" });
    store.events.append({ runId: "run_2", kind: "lancement", par: "vous" });
    db.prepare("DELETE FROM team_runs WHERE id = ?").run(RUN);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ?", RUN), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM team_run_events WHERE run_id = ?", RUN), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM team_run_steps WHERE run_id = ?", "run_2"), 2);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM team_run_events WHERE run_id = ?", "run_2"), 1);
  });

  it("événements : identifiants et codes seulement, jamais un texte de message ni un secret ; un refus n'écrit rien", (t) => {
    const { store } = base(t);
    seeded(store);
    const event = store.events.append({ runId: RUN, kind: "correction", par: "vous", data: { avant: "sha-a", apres: "sha-b", etape: "e1", tour: 1, corrige: true, cause: null } });
    assert.deepEqual([event.kind, event.par, event.run_id], ["correction", "vous", RUN]);
    assert.deepEqual(store.events.ofRun(RUN).map((e) => JSON.parse(e.data)), [{ avant: "sha-a", apres: "sha-b", etape: "e1", tour: 1, corrige: true, cause: null }]);
    const refuses: Array<Record<string, unknown>> = [
      { data: { texte: "x".repeat(201) } },
      { data: { texte: "Une consigne\nsur deux lignes." } },
      { data: { jeton: `ghp_${"a".repeat(36)}` } },
      { data: { objet: { a: 1 } as unknown as string } },
      { kind: "Correction" },
      { kind: "" },
      { par: "ia" },
    ];
    for (const patch of refuses) {
      assert.throws(() => store.events.append({ runId: RUN, kind: "correction", par: "vous", data: {}, ...patch } as Parameters<TeamStore["events"]["append"]>[0]), /événement d'équipe refusé/, JSON.stringify(patch));
    }
    assert.equal(store.events.ofRun(RUN).length, 1, "aucun événement refusé n'est écrit");
  });
});

describe("magasin des équipes : coûts et résumés", () => {
  it("coût observé d'une étape : moyenne des étapes terminées sur la période, avec le nombre d'échantillons (4 puis 5)", (t) => {
    const { store } = base(t);
    const model = "github-copilot/gpt-5-mini";
    const since = T - 30 * DAY;
    store.runs.create({ id: RUN, teamId: null, teamTitre: "T", flow: FLOW, flowSha256: "f", estimateSha256: null, modeUi: null, rootId: ROOT, directory: "/workspace", estimate: null, plafond: null });
    const terminee = (stepId: string, cost: number, endedAt: number, state: TeamStepState = "terminee", agent = "relire-script") => {
      const key: StepKey = { runId: RUN, stepId, tour: 1, tentative: 1 };
      store.steps.create({ ...key, ordre: 1, blocIndex: 0, titre: "T", agent, state: "prevue" });
      store.steps.patch(key, { model, cost });
      store.steps.setState(key, "en-cours");
      store.steps.setState(key, state, { at: endedAt });
    };
    for (const n of [1, 2, 3, 4]) terminee(`e${n}`, 0.2, T - n * DAY);
    assert.deepEqual(store.observedStepCost("relire-script", model, since), { avgUsd: 0.2, samples: 4 });
    assert.equal(chooseEstimate(store.observedStepCost("relire-script", model, since), PRIX, "M")?.source, "profile", "moins de 5 échantillons : profil");

    terminee("e5", 0.4, T - DAY);
    const observe = store.observedStepCost("relire-script", model, since);
    assert.deepEqual([observe.samples, Number(observe.avgUsd?.toFixed(4))], [OBSERVED_MIN_SAMPLES, 0.24]);
    assert.equal(chooseEstimate(observe, PRIX, "M")?.source, "observed");

    // Hors compte : étape en échec, autre assistant, autre IA, étape trop ancienne.
    terminee("e6", 9, T - DAY, "echec");
    terminee("e7", 9, T - DAY, "terminee", "relire-requete-sql");
    terminee("e8", 9, T - 40 * DAY);
    assert.deepEqual(store.observedStepCost("relire-script", model, since).samples, OBSERVED_MIN_SAMPLES);
    assert.deepEqual(store.observedStepCost("relire-script", "autre/ia", since), { avgUsd: null, samples: 0 });
  });

  it("dépense d'un lancement : les sessions de ses étapes depuis son départ, ni la racine ni une autre équipe", (t) => {
    const { db, store } = base(t);
    seeded(store);
    seeded(store, "run_2", ROOT);
    store.runs.setState(RUN, "en-cours", { at: T });
    store.steps.patch(STEP1, { sessionId: "ses_e1" });
    store.steps.patch(STEP2, { sessionId: "ses_e2" });
    store.steps.patch({ runId: "run_2", stepId: "e1", tour: 1, tentative: 1 }, { sessionId: "ses_autre_equipe" });
    const usage = db.prepare(
      "INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?)",
    );
    usage.run("msg_1", "ses_e1", ROOT, T + 10, 0.2);
    usage.run("msg_2", "ses_e2", ROOT, T + 20, 0.3);
    usage.run("msg_racine", ROOT, ROOT, T + 30, 5);
    usage.run("msg_autre", "ses_autre_equipe", ROOT, T + 40, 7);
    usage.run("msg_avant", "ses_e1", ROOT, T - 1, 9);
    assert.equal(Number(store.spentOfRun(RUN).toFixed(4)), 0.5);
    assert.equal(store.spentOfRun("run_inconnu"), 0);
  });

  it("résumés d'une conversation : états, coûts, étapes prévues et terminées ; une autre conversation n'y entre pas", (t) => {
    const { store } = base(t);
    seeded(store);
    seeded(store, "run_2", "ses_autre");
    store.runs.setState(RUN, "en-cours", { at: T + 1 });
    store.steps.setState(STEP1, "en-cours");
    store.steps.setState(STEP1, "terminee", { at: T + 2 });
    store.runs.patch(RUN, { cost: 0.42 });
    // Une relance ajoute une tentative, jamais une étape : le compte reste celui du plan.
    store.steps.create({ ...STEP2, tentative: 2, ordre: 2, blocIndex: 2, titre: "Sécurité", agent: "relire-script", state: "prevue" });
    assert.deepEqual(store.summaries(ROOT), [
      { id: RUN, titre: "Revue SQL sur réplica", state: "en-cours", cause: null, cost: 0.42, plafond: 0.6, createdAt: T, endedAt: null, etapesPrevues: 2, etapesTerminees: 1 },
    ]);
    assert.deepEqual(store.summaries("ses_inconnue"), []);
  });

  it("GET …/activity rend les résumés des lancements de la conversation", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    h.sessions.upsert({ id: ROOT, title: "Racine", directory: "/workspace", time: { created: 1, updated: 1 } } as OcSession);
    const store = createTeamStore({ db: h.db, now: () => T });
    seeded(store);
    store.runs.setState(RUN, "en-cours");
    store.steps.setState(STEP1, "en-cours");
    store.steps.setState(STEP1, "terminee");

    const res = await h.call("GET", `/api/conversations/${ROOT}/activity`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json<ActivityResponse>().runs, [
      { id: RUN, titre: "Revue SQL sur réplica", state: "en-cours", cause: null, cost: 0, plafond: 0.6, createdAt: T, endedAt: null, etapesPrevues: 2, etapesTerminees: 1 },
    ]);
    const vide = await h.call("GET", "/api/conversations/ses_inconnue/activity", { headers: h.headers.authed });
    assert.deepEqual(vide.json<ActivityResponse>().runs, []);
  });
});
