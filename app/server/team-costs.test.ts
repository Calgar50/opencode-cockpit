// Coûts et archives par équipe (itération 5, plan d'exécution it5, fiche L46a, D-5-10, D-5-11 ; spécification §7.9 l.1204,
// §3.5 l.244-246) : lignes `team_runs`, `team_run_steps`, `teams` et `usage` SEMÉES dans une base en mémoire (les tables
// viennent de la migration 4, aucune migration n'est ajoutée par la construction).
// Contrôles : sommes, moyennes et « Estimé en général » par équipe ; repli sur `team_runs.cost` sans ligne `usage` ; filtre du
// mois sur `created_at` ; ordre et nombre des lancements les plus coûteux ; équipe supprimée (`teamId` null, « Équipe
// supprimée ») ; étapes par `ordre`, `tour`, `tentative` ; extrait MASQUÉ PUIS coupé à ARCHIVE_EXCERPT_MAX ; conversation
// purgée → `extrait: null` ; racines du filtre « Avec une équipe » et `tronque` ; CSV (en-tête, valeurs, formule neutralisée,
// secret masqué) ; Markdown (section présente, SANS extrait, export inchangé sans lancement) ; identifiant invalide → 400 ;
// mois invalide → 400 ; modes Simple et Avancé identiques ; routes absentes sans le module.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import type { ModelCatalog } from "./catalog.ts";
import { purgeConversation } from "./conversation-purge.ts";
import { openMemoryDb, params } from "./db.ts";
import { Ledger, monthKey } from "./ledger.ts";
import { SettingsStore } from "./settings.ts";
import {
  ARCHIVE_EXCERPT_MAX,
  CONSTRUCTION_ROUTE_PATHS,
  TEAM_CONVERSATIONS_MAX,
  TEAM_COSTS_TOP,
} from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { ArchiveTeamsResponse, TeamConversationsResponse, TeamCostsResponse } from "./shared/construction-types.ts";
import {
  ARCHIVE_STEPS_MAX,
  archiveTeams,
  registerTeamCostsRoutes,
  teamConversations,
  teamCosts,
  teamRunsMarkdown,
} from "./team-costs.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";

// --- Semailles ----------------------------------------------------------------------------------------------------------------

const MOIS = "2026-05";
const T = (jour: number, heure = 12) => Date.UTC(2026, 4, jour, heure);
const RACINE = "ses_racine_equipe";

/** Élément d'une liste, avec un échec lisible quand il manque (`noUncheckedIndexedAccess`). */
function item<T>(liste: readonly T[], index = 0): T {
  const valeur = liste[index];
  assert.ok(valeur !== undefined, `élément ${index} absent (${liste.length} au total)`);
  return valeur;
}

interface RunSeed {
  id: string;
  teamId?: string | null;
  titre?: string;
  rootId?: string;
  directory?: string;
  etat?: string;
  cause?: string | null;
  cost?: number;
  estimeTypique?: number | null;
  plafond?: number | null;
  createdAt?: number;
  endedAt?: number | null;
}

interface StepSeed {
  runId: string;
  stepId: string;
  ordre: number;
  titre: string;
  agent: string;
  model?: string | null;
  etat?: string;
  tour?: number;
  tentative?: number;
  verdict?: string | null;
  choix?: string | null;
  cost?: number;
  sessionId?: string | null;
  extrait?: string | null;
}

function seedTeam(db: DatabaseSync, id: string, titre: string): void {
  db.prepare(
    `INSERT INTO teams (id, titre, description, flow, origine, created_at, updated_at)
     VALUES (:id, :titre, '', '{}', 'creee', :at, :at)`,
  ).run(params({ id, titre, at: T(1) }));
}

function seedRun(db: DatabaseSync, run: RunSeed): void {
  db.prepare(
    `INSERT INTO team_runs (id, team_id, team_titre, flow, flow_sha256, root_session_id, directory, state, cause,
       estimate_typique, plafond, cost, created_at, ended_at)
     VALUES (:id, :team_id, :team_titre, '{}', 'sha', :root, :directory, :state, :cause,
       :estimate_typique, :plafond, :cost, :created_at, :ended_at)`,
  ).run(
    params({
      id: run.id,
      team_id: run.teamId === undefined ? null : run.teamId,
      team_titre: run.titre ?? "Revue SQL sur réplica",
      root: run.rootId ?? RACINE,
      directory: run.directory ?? "/travail/projet",
      state: run.etat ?? "terminee",
      cause: run.cause ?? null,
      estimate_typique: run.estimeTypique === undefined ? null : run.estimeTypique,
      plafond: run.plafond === undefined ? null : run.plafond,
      cost: run.cost ?? 0,
      created_at: run.createdAt ?? T(10),
      ended_at: run.endedAt === undefined ? null : run.endedAt,
    }),
  );
}

function seedStep(db: DatabaseSync, step: StepSeed): void {
  db.prepare(
    `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, model, session_id, state,
       verdict, choix, result_excerpt, cost)
     VALUES (:run_id, :step_id, :tour, :tentative, :ordre, 0, :titre, :agent, :model, :session_id, :state,
       :verdict, :choix, :excerpt, :cost)`,
  ).run(
    params({
      run_id: step.runId,
      step_id: step.stepId,
      tour: step.tour ?? 1,
      tentative: step.tentative ?? 1,
      ordre: step.ordre,
      titre: step.titre,
      agent: step.agent,
      model: step.model === undefined ? "github-copilot/gpt-5-mini" : step.model,
      session_id: step.sessionId === undefined ? `ses_${step.runId}_${step.stepId}_${step.tour ?? 1}` : step.sessionId,
      state: step.etat ?? "terminee",
      verdict: step.verdict === undefined ? null : step.verdict,
      choix: step.choix === undefined ? null : step.choix,
      excerpt: step.extrait === undefined ? null : step.extrait,
      cost: step.cost ?? 0,
    }),
  );
}

function seedUsage(db: DatabaseSync, id: string, sessionId: string, cost: number, at = T(10), rootId = RACINE): void {
  db.prepare(
    `INSERT INTO usage (message_id, session_id, root_id, directory, provider_id, model_id, agent, purpose, created_at, cost)
     VALUES (:id, :session, :root, '/travail/projet', 'github-copilot', 'gpt-5-mini', 'redacteur', 'equipe', :at, :cost)`,
  ).run(params({ id, session: sessionId, root: rootId, at, cost }));
}

function seedConversation(db: DatabaseSync, sessionId: string, title: string): void {
  db.prepare(
    `INSERT INTO conversations (session_id, directory, title, category, created_at, updated_at)
     VALUES (:id, '/travail/projet', :title, 'other', :at, :at)`,
  ).run(params({ id: sessionId, title, at: T(10) }));
}

/** Base en mémoire au dernier numéro de migration (les tables d'équipe viennent de la 4). */
const base = (): DatabaseSync => openMemoryDb();

// --- Coûts par équipe -----------------------------------------------------------------------------------------------------------

describe("teamCosts : sommes, moyennes et estimé par équipe", () => {
  it("le coût d'un lancement est la somme des lignes `usage` de ses étapes ; moyenne et estimé par équipe", () => {
    const db = base();
    seedTeam(db, "team_a", "Revue SQL sur réplica");
    seedRun(db, { id: "run_1", teamId: "team_a", estimeTypique: 0.2, cost: 99 });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", sessionId: "ses_1" });
    seedStep(db, { runId: "run_1", stepId: "e2", ordre: 2, titre: "Relecture", agent: "relecteur-critique", sessionId: "ses_2" });
    seedUsage(db, "msg_1", "ses_1", 0.25);
    seedUsage(db, "msg_2", "ses_2", 0.15);
    seedRun(db, { id: "run_2", teamId: "team_a", estimeTypique: 0.4, createdAt: T(11) });
    seedStep(db, { runId: "run_2", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", sessionId: "ses_3" });
    seedUsage(db, "msg_3", "ses_3", 0.6, T(11));

    const reponse = teamCosts(db, MOIS);
    assert.equal(reponse.mois, MOIS);
    assert.equal(reponse.parEquipe.length, 1);
    const ligne = item(reponse.parEquipe);
    assert.equal(ligne.teamId, "team_a");
    assert.equal(ligne.titre, "Revue SQL sur réplica");
    assert.equal(ligne.lancements, 2);
    // 0,25 + 0,15 = 0,40 pour le premier lancement (le `cost` enregistré, 99, est ignoré : des lignes `usage` existent).
    assert.equal(ligne.cout, 1);
    assert.equal(ligne.moyenne, 0.5);
    // « Estimé en général » : moyenne des `estimate_typique` enregistrés.
    assert.equal(ligne.estimeTypique, 0.3);
    db.close();
  });

  it("sans aucune ligne `usage`, le coût enregistré du lancement fait foi ; un estimé absent ne compte pas dans la moyenne", () => {
    const db = base();
    seedTeam(db, "team_a", "Chaîne de relecture de script");
    seedRun(db, { id: "run_1", teamId: "team_a", cost: 0.75, estimeTypique: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", sessionId: "ses_1" });
    seedRun(db, { id: "run_2", teamId: "team_a", cost: 0.25, estimeTypique: 0.9, createdAt: T(11) });

    const ligne = item(teamCosts(db, MOIS).parEquipe);
    assert.equal(ligne.cout, 1);
    assert.equal(ligne.moyenne, 0.5);
    assert.equal(ligne.estimeTypique, 0.9, "seul l'estimé enregistré compte");

    // Aucun estimé du tout : null, jamais 0 (un chiffre inventé serait pris pour une estimation).
    const autre = base();
    seedTeam(autre, "team_b", "Sans estimation");
    seedRun(autre, { id: "run_3", teamId: "team_b", cost: 1 });
    assert.equal(item(teamCosts(autre, MOIS).parEquipe).estimeTypique, null);
    autre.close();
    db.close();
  });

  it("le mois se lit sur `team_runs.created_at` : un lancement d'un autre mois est écarté", () => {
    const db = base();
    seedTeam(db, "team_a", "Revue SQL sur réplica");
    seedRun(db, { id: "run_mai", teamId: "team_a", cost: 1, createdAt: Date.UTC(2026, 4, 31, 23, 59) });
    seedRun(db, { id: "run_juin", teamId: "team_a", cost: 5, createdAt: Date.UTC(2026, 5, 1) });
    seedRun(db, { id: "run_avril", teamId: "team_a", cost: 7, createdAt: Date.UTC(2026, 3, 30) });

    const mai = teamCosts(db, MOIS);
    assert.equal(item(mai.parEquipe).cout, 1);
    assert.deepEqual(
      mai.lancements.map((r) => r.runId),
      ["run_mai"],
    );
    assert.deepEqual(
      teamCosts(db, "2026-06").lancements.map((r) => r.runId),
      ["run_juin"],
    );
    db.close();
  });

  it("lancements les plus coûteux : coût décroissant, TEAM_COSTS_TOP au plus", () => {
    const db = base();
    seedTeam(db, "team_a", "Revue SQL sur réplica");
    for (let i = 0; i < TEAM_COSTS_TOP + 3; i++) {
      seedRun(db, { id: `run_${String(i).padStart(2, "0")}`, teamId: "team_a", cost: i / 100, createdAt: T(10) + i });
    }
    const lancements = teamCosts(db, MOIS).lancements;
    assert.equal(lancements.length, TEAM_COSTS_TOP);
    const tete = item(lancements);
    assert.equal(tete.runId, `run_${String(TEAM_COSTS_TOP + 2).padStart(2, "0")}`);
    const couts = lancements.map((r) => r.cout);
    assert.deepEqual([...couts].sort((a, b) => b - a), couts, "ordre décroissant");
    assert.equal(tete.rootId, RACINE);
    assert.equal(tete.directory, "/travail/projet");
    assert.equal(tete.etat, "terminee");
    db.close();
  });

  it("équipe supprimée : `teamId` null, lancements toujours comptés, regroupés sur le titre enregistré", () => {
    const db = base();
    // `team_id` pointe une équipe qui n'existe plus dans `teams` (les lancements passés restent, plan it4).
    seedRun(db, { id: "run_1", teamId: "team_disparue", titre: "Revue SQL sur réplica", cost: 0.4 });
    seedRun(db, { id: "run_2", teamId: "team_disparue", titre: "Revue SQL sur réplica", cost: 0.6, createdAt: T(11) });
    const ligne = item(teamCosts(db, MOIS).parEquipe);
    assert.equal(ligne.teamId, null, "équipe supprimée");
    assert.equal(ligne.titre, "Revue SQL sur réplica", "le titre enregistré au lancement survit à la suppression");
    assert.equal(ligne.lancements, 2);
    assert.equal(ligne.cout, 1);
    db.close();
  });

  it("équipe supprimée sans titre gardé : « Équipe supprimée », jamais une case vide", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "   ", cost: 0.5 });
    const reponse = teamCosts(db, MOIS);
    assert.equal(item(reponse.parEquipe).teamId, null);
    assert.equal(item(reponse.parEquipe).titre, TEXTES.partout.couts.equipeSupprimee);
    assert.equal(item(reponse.parEquipe).titre, "Équipe supprimée");
    assert.equal(item(reponse.lancements).titre, "Équipe supprimée");
    db.close();
  });

  it("une équipe encore installée et une équipe supprimée du même titre font deux lignes", () => {
    const db = base();
    seedTeam(db, "team_a", "Revue SQL sur réplica");
    seedRun(db, { id: "run_1", teamId: "team_a", titre: "Revue SQL sur réplica", cost: 1 });
    seedRun(db, { id: "run_2", teamId: "team_ancienne", titre: "Revue SQL sur réplica", cost: 2, createdAt: T(11) });
    const lignes = teamCosts(db, MOIS).parEquipe;
    assert.equal(lignes.length, 2);
    assert.deepEqual(
      lignes.map((l) => [l.teamId, l.cout]),
      [
        [null, 2],
        ["team_a", 1],
      ],
    );
    db.close();
  });

  it("un titre d'équipe qui contient un faux secret est masqué dans la réponse", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "Équipe password=hunter2 interne", cost: 1 });
    const ligne = item(teamCosts(db, MOIS).parEquipe);
    assert.ok(!ligne.titre.includes("hunter2"), ligne.titre);
    assert.ok(ligne.titre.includes("****"), ligne.titre);
    db.close();
  });
});

// --- Archives d'équipe -----------------------------------------------------------------------------------------------------------

describe("archiveTeams : lancements et étapes d'une conversation", () => {
  it("étapes rendues par `ordre`, `tour` puis `tentative` ; `tour` seulement quand le lancement en a plusieurs", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "Rédaction et relecture", cause: "verdict", endedAt: T(10, 14) });
    seedStep(db, { runId: "run_1", stepId: "relecture", ordre: 2, tour: 2, titre: "Relecture", agent: "relecteur-critique" });
    seedStep(db, { runId: "run_1", stepId: "redaction", ordre: 1, titre: "Rédaction", agent: "redacteur" });
    seedStep(db, { runId: "run_1", stepId: "relecture", ordre: 2, tour: 1, tentative: 2, titre: "Relecture", agent: "relecteur-critique" });
    seedStep(db, { runId: "run_1", stepId: "relecture", ordre: 2, tour: 1, tentative: 1, titre: "Relecture", agent: "relecteur-critique" });

    const reponse = archiveTeams(db, RACINE);
    assert.equal(reponse.rootId, RACINE);
    assert.equal(reponse.lancements.length, 1);
    const run = item(reponse.lancements);
    assert.equal(run.runId, "run_1");
    assert.equal(run.titre, "Rédaction et relecture");
    assert.equal(run.cause, "verdict");
    assert.equal(run.debut, T(10));
    assert.equal(run.fin, T(10, 14));
    assert.deepEqual(
      run.etapes.map((e) => [e.titre, e.tour]),
      [
        ["Rédaction", null],
        ["Relecture", 1],
        ["Relecture", 1],
        ["Relecture", 2],
      ],
    );
    const premiere = item(run.etapes);
    assert.equal(premiere.agent, "redacteur");
    assert.equal(premiere.ia, "github-copilot/gpt-5-mini");
    assert.equal(premiere.etat, "terminee");
    db.close();
  });

  it("extrait : MASQUÉ puis coupé à ARCHIVE_EXCERPT_MAX (couper d'abord laisserait passer le début d'un secret)", () => {
    const db = base();
    // Le faux jeton commence juste avant la coupe : masqué d'abord, il disparaît ; coupé d'abord, son début resterait.
    const brut = `${"x".repeat(1989)} ghp_${"A".repeat(40)} fin`;
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", extrait: brut });

    const extrait = item(item(archiveTeams(db, RACINE).lancements).etapes).extrait;
    assert.ok(extrait !== null);
    assert.equal(extrait.length, ARCHIVE_EXCERPT_MAX);
    assert.ok(!extrait.includes("ghp_"), "aucun début de jeton");
    assert.ok(extrait.includes("gh_****"), "jeton masqué");
    db.close();
  });

  it("conversation purgée : `extrait: null`, coûts et états conservés", () => {
    const db = base();
    db.prepare(
      "INSERT INTO sessions (id, root_id, parent_id, directory, title, purpose, created_at, updated_at) VALUES (?, ?, NULL, '', '', 'chat', 0, 0)",
    ).run(RACINE, RACINE);
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", extrait: "Résultat détaillé", cost: 0.5 });
    assert.equal(item(item(archiveTeams(db, RACINE).lancements).etapes).extrait, "Résultat détaillé");

    purgeConversation(db, RACINE);
    const etape = item(item(archiveTeams(db, RACINE).lancements).etapes);
    assert.equal(etape.extrait, null, "vidé par la purge");
    assert.equal(etape.cout, 0.5, "les coûts restent");
    assert.equal(etape.etat, "terminee");
    db.close();
  });

  it("verdict et choix sont masqués ; une conversation sans équipe rend une liste vide", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, {
      runId: "run_1",
      stepId: "e1",
      ordre: 1,
      titre: "Relecture",
      agent: "relecteur-critique",
      verdict: "à reprendre : token=ghp_0123456789012345678901",
      choix: "spécialiste réseau",
    });
    const etape = item(item(archiveTeams(db, RACINE).lancements).etapes);
    assert.ok(!(etape.verdict ?? "").includes("ghp_0123456789012345678901"), etape.verdict ?? "");
    assert.ok((etape.verdict ?? "").includes("****"));
    assert.equal(etape.choix, "spécialiste réseau");
    assert.deepEqual(archiveTeams(db, "ses_sans_equipe").lancements, []);
    db.close();
  });

  it("la lecture des étapes est bornée (ARCHIVE_STEPS_MAX)", () => {
    assert.equal(ARCHIVE_STEPS_MAX, 2_000);
  });
});

// --- Filtre « Avec une équipe » ---------------------------------------------------------------------------------------------------

describe("teamConversations : racines qui ont lancé une équipe", () => {
  it("racines distinctes, la plus récente d'abord, sans troncature", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, rootId: "ses_a", createdAt: T(10) });
    seedRun(db, { id: "run_2", teamId: null, rootId: "ses_a", createdAt: T(12) });
    seedRun(db, { id: "run_3", teamId: null, rootId: "ses_b", createdAt: T(11) });
    const reponse = teamConversations(db);
    assert.deepEqual(reponse.rootIds, ["ses_a", "ses_b"]);
    assert.equal(reponse.tronque, false);
    db.close();
  });

  it("au-delà de TEAM_CONVERSATIONS_MAX racines : liste coupée et `tronque` vrai", () => {
    const db = base();
    for (let i = 0; i <= TEAM_CONVERSATIONS_MAX; i++) {
      seedRun(db, { id: `run_${i}`, teamId: null, rootId: `ses_${String(i).padStart(5, "0")}`, createdAt: T(10) + i });
    }
    const reponse = teamConversations(db);
    assert.equal(reponse.rootIds.length, TEAM_CONVERSATIONS_MAX);
    assert.equal(reponse.tronque, true);
    db.close();
  });
});

// --- Export CSV -------------------------------------------------------------------------------------------------------------------

const ledgerDe = (db: DatabaseSync): Ledger =>
  new Ledger({ db, settings: new SettingsStore(db), catalog: { prices: new Map() } as unknown as ModelCatalog });

describe("ledger.exportCsv : colonnes `lancement_equipe` et `etape` en fin de ligne", () => {
  it("en-tête et valeurs en fin de ligne ; une ligne sans équipe garde deux cases vides", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "Revue SQL sur réplica" });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", sessionId: "ses_etape" });
    seedUsage(db, "msg_1", "ses_etape", 0.25);
    seedUsage(db, "msg_2", "ses_libre", 0.1, T(10) + 1);

    const lignes = ledgerDe(db).exportCsv(MOIS).trimEnd().split("\r\n");
    const entete = item(lignes);
    assert.ok(entete.endsWith(",lancement_equipe,etape"), entete);
    assert.equal(entete.split(",").length, 20);
    assert.ok(item(lignes, 1).endsWith(",Revue SQL sur réplica,Rédaction"), item(lignes, 1));
    assert.ok(item(lignes, 2).endsWith(",,"), item(lignes, 2));
    db.close();
  });

  it("formule neutralisée et secret masqué dans les deux colonnes ajoutées", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "Équipe api_key=ABCDEFGHIJKLMNOP" });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "=1+1", agent: "redacteur", sessionId: "ses_etape" });
    seedUsage(db, "msg_1", "ses_etape", 0.25);

    const ligne = item(ledgerDe(db).exportCsv(MOIS).trimEnd().split("\r\n"), 1);
    assert.ok(ligne.endsWith(",'=1+1"), `formule neutralisée : ${ligne}`);
    assert.ok(!ligne.includes("ABCDEFGHIJKLMNOP"), ligne);
    assert.ok(ligne.includes("****"), ligne);
    db.close();
  });

  it("la première tentative de l'étape fait foi quand une session est réutilisée", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, tentative: 2, titre: "Seconde tentative", agent: "redacteur", sessionId: "ses_etape" });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, tentative: 1, titre: "Première tentative", agent: "redacteur", sessionId: "ses_etape" });
    seedUsage(db, "msg_1", "ses_etape", 0.25);
    assert.ok(ledgerDe(db).exportCsv(MOIS).includes(",Première tentative"));
    db.close();
  });
});

// --- Export Markdown ----------------------------------------------------------------------------------------------------------------

describe("teamRunsMarkdown : résumé des lancements, sans extrait", () => {
  it("titre et tableau Étape · Assistant · IA · État · Coût, sans aucun extrait", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null, titre: "Revue SQL sur réplica" });
    seedStep(db, {
      runId: "run_1",
      stepId: "e1",
      ordre: 1,
      titre: "Rédaction",
      agent: "redacteur",
      cost: 0.25,
      extrait: "SECRET-DU-RESULTAT",
    });
    const md = teamRunsMarkdown(db, RACINE);
    assert.ok(md.includes("## Déroulé de l'équipe « Revue SQL sur réplica »"), md);
    assert.ok(md.includes("| Étape | Assistant | IA | État | Coût |"), md);
    assert.ok(md.includes("| Rédaction | redacteur | github-copilot/gpt-5-mini | terminee | 0.2500 $ |"), md);
    assert.ok(!md.includes("SECRET-DU-RESULTAT"), "aucun extrait dans l'export (D-5-10)");
    assert.ok(!md.includes("Extrait"), md);
    db.close();
  });

  it("barres verticales et retours à la ligne d'un titre d'étape ne cassent pas le tableau", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Avant | après\nsuite", agent: "redacteur" });
    const ligne = teamRunsMarkdown(db, RACINE).split("\n").find((l) => l.includes("Avant")) ?? "";
    assert.ok(ligne.includes("Avant \\| après suite"), ligne);
    assert.equal(ligne.split(/(?<!\\)\|/).length - 1, 6, "cinq colonnes, six barres non échappées");
    db.close();
  });

  it("aucun lancement : chaîne vide (l'export reste celui de l'itération 1)", () => {
    const db = base();
    assert.equal(teamRunsMarkdown(db, RACINE), "");
    db.close();
  });
});

describe("archive.ts : le résumé des lancements est ajouté en fin de fichier", () => {
  it("export Markdown d'une conversation avec équipe : section en fin de fichier, sans extrait", async (t: TestContext) => {
    const h = await startCockpit(t, {});
    seedConversation(h.db, RACINE, "Conversation avec équipe");
    seedRun(h.db, { id: "run_1", teamId: null, titre: "Revue SQL sur réplica" });
    seedStep(h.db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", cost: 0.5, extrait: "SECRET-DU-RESULTAT" });

    await h.deps.archive.update(RACINE, { pinned: true });
    const relatif = (h.db.prepare("SELECT archive_path FROM conversations WHERE session_id = ?").get(RACINE) as { archive_path: string | null })
      .archive_path;
    assert.ok(relatif, "fichier d'archive écrit");
    const contenu = fs.readFileSync(path.join(h.deps.env.archiveDir, relatif), "utf8");
    const attendu = "## Déroulé de l'équipe « Revue SQL sur réplica »";
    assert.ok(contenu.includes(attendu), contenu.slice(-400));
    assert.ok(contenu.indexOf(attendu) > contenu.indexOf("# "), "ajouté APRÈS le corps de l'archive");
    assert.ok(!contenu.includes("SECRET-DU-RESULTAT"));
  });

  it("conversation sans équipe : l'export est exactement celui de l'itération 1", async (t: TestContext) => {
    const h = await startCockpit(t, {});
    seedConversation(h.db, "ses_sans_equipe", "Conversation sans équipe");
    await h.deps.archive.update("ses_sans_equipe", { pinned: true });
    const relatif = (
      h.db.prepare("SELECT archive_path FROM conversations WHERE session_id = ?").get("ses_sans_equipe") as { archive_path: string | null }
    ).archive_path;
    assert.ok(relatif);
    const contenu = fs.readFileSync(path.join(h.deps.env.archiveDir, relatif), "utf8");
    assert.equal(contenu, h.deps.archive.markdown("ses_sans_equipe"));
    assert.ok(!contenu.includes("Déroulé de l'équipe"));
  });
});

// --- Routes ---------------------------------------------------------------------------------------------------------------------------

describe("routes du module teamCosts", () => {
  it("mois invalide → 400 ; sans paramètre, le mois courant", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: ["teamCosts"] });
    for (const mois of ["2026-13", "2026-5", "hier", "2026-05-01", "'; DROP TABLE team_runs; --"]) {
      const res = await h.call("GET", `${CONSTRUCTION_ROUTE_PATHS.coutsEquipes}?month=${encodeURIComponent(mois)}`, {
        headers: h.headers.authed,
      });
      assert.equal(res.status, 400, mois);
      const corps = res.json<{ error: string; message: string }>();
      assert.equal(corps.error, "invalid");
      // Phrase fixe : le mois refusé n'est JAMAIS renvoyé dans le corps (le repli de `monthBounds`, lui, le recopierait).
      assert.equal(corps.message, "Mois invalide (AAAA-MM).", mois);
      assert.ok(!res.body.includes(mois), res.body);
    }
    const courant = await h.call("GET", CONSTRUCTION_ROUTE_PATHS.coutsEquipes, { headers: h.headers.authed });
    assert.equal(courant.status, 200);
    assert.equal(courant.json<TeamCostsResponse>().mois, monthKey(Date.now()));
    assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_runs'").get(), "table intacte");
  });

  it("identifiant de conversation invalide → 400", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: ["teamCosts"] });
    for (const mauvais of ["ses avec espace", "ses/../autre", "x".repeat(129), "ses%20a"]) {
      const res = await h.call("GET", `/api/archives/${encodeURIComponent(mauvais)}/equipes`, { headers: h.headers.authed });
      assert.equal(res.status, 400, mauvais);
      assert.equal(res.json<{ error: string }>().error, "invalid");
    }
  });

  it("les trois routes rendent la même chose en mode Simple et en mode Avancé", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: ["teamCosts"] });
    seedRun(h.db, { id: "run_1", teamId: null, titre: "Revue SQL sur réplica", cost: 0.5, createdAt: Date.now() });
    seedStep(h.db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", extrait: "Résultat" });
    const adresses = [
      CONSTRUCTION_ROUTE_PATHS.coutsEquipes,
      `/api/archives/${RACINE}/equipes`,
      CONSTRUCTION_ROUTE_PATHS.equipesConversations,
    ];
    const lire = async (): Promise<unknown[]> => {
      const out: unknown[] = [];
      for (const adresse of adresses) {
        const res = await h.call("GET", adresse, { headers: h.headers.authed });
        assert.equal(res.status, 200, adresse);
        out.push(res.json());
      }
      return out;
    };
    assert.equal(h.settings.get().ui.mode, "simple");
    const simple = await lire();
    h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual(await lire(), simple);
    const archives = item(simple, 1) as ArchiveTeamsResponse;
    assert.equal(item(item(archives.lancements).etapes).extrait, "Résultat");
    assert.deepEqual((item(simple, 2) as TeamConversationsResponse).rootIds, [RACINE]);
  });

  it("sans le module, les trois routes répondent 404 (comportement de l'itération 1)", async (t: TestContext) => {
    const h = await startCockpit(t, {});
    for (const adresse of [
      CONSTRUCTION_ROUTE_PATHS.coutsEquipes,
      `/api/archives/${RACINE}/equipes`,
      CONSTRUCTION_ROUTE_PATHS.equipesConversations,
    ]) {
      assert.equal((await h.call("GET", adresse, { headers: h.headers.authed })).status, 404, adresse);
    }
  });

  it("sans cookie de session, aucune donnée n'est rendue", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: ["teamCosts"] });
    assert.equal((await h.call("GET", CONSTRUCTION_ROUTE_PATHS.coutsEquipes)).status, 401);
  });

  it("les lectures n'écrivent jamais dans la base", () => {
    const db = base();
    seedRun(db, { id: "run_1", teamId: null });
    seedStep(db, { runId: "run_1", stepId: "e1", ordre: 1, titre: "Rédaction", agent: "redacteur", extrait: "Résultat" });
    const etat = () =>
      JSON.stringify([db.prepare("SELECT * FROM team_runs").all(), db.prepare("SELECT * FROM team_run_steps").all()]);
    const avant = etat();
    teamCosts(db, MOIS);
    archiveTeams(db, RACINE);
    teamConversations(db);
    teamRunsMarkdown(db, RACINE);
    assert.equal(etat(), avant);
    assert.equal(typeof registerTeamCostsRoutes, "function");
    db.close();
  });
});
