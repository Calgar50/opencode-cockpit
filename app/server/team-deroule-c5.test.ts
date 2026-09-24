// Déroulé d'équipe « Prévu / Réel » et cartes du chat pour la relecture et l'aiguillage (1.1, itération 5b, L42c ; plan
// d'exécution it5 §4.3, §5.3, fiche L42c ; spécification §2.3, §5.1 l.881, §5.5 ; C §3.4, §7.3, §9.5, §9.6 ; conception A §7.3
// l.1095-1101 : « ×2 », « non choisi », « Prévu : jusqu'à 2 tours · Réel : 1 tour »).
// Modèles PURS (web/pages/chat/team/deroule-model.ts et team-view-model.ts) : une ligne par TOUR réellement fait, « ×{n} » sur
// le bloc, verdict en MOT et icône, « Non relue après la dernière correction. », spécialistes écartés en « Non choisi » (sans
// barre ni coût), écarts entre le prévu et le réel. Les tests `deroule-model` de l'itération 4 restent verts : ils sont dans
// server/web-team-deroule.test.ts, et ce fichier ne couvre QUE les formes de la 5b.
// L'interface n'étant pas exécutée par `npm test`, les composants et la feuille de style sont relus (contrat statique) : bloc
// `forced-colors`, aucune animation, aucun texte écrit en dur, aucun texte d'IA inséré en HTML, focus jamais volé.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ecartSpecialistes, ecartTours, TEXTES as CONSTRUCTION } from "./shared/construction-texts.ts";
import { DELIVERABLE_TEXTS, injectionText } from "./shared/flow.ts";
import { aucunDuLivrable } from "./shared/team-choice-view.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type { StepRunView, TeamConfirmation, TeamRunView } from "./shared/team-types.ts";
import { buildTeamDeroule, ecartsDe, specialistesDuBloc } from "../web/pages/chat/team/deroule-model.ts";
import { demandeRecopiee } from "../web/pages/chat/team/team-transcript.ts";
import { buildTeamRunCard, etapesParTour, modelePause, modeleResultat, teamPauseElementId, toursParBloc, toursPrevusParBloc, verdictLigne } from "../web/pages/chat/team/team-view-model.ts";
// Clôture 5b (D-5b-1) : les fonctions de la reprise sont lues par l'espace de noms, pour qu'un module qui ne les exporte pas
// fasse tomber leurs seuls tests, et non le fichier entier au chargement.
import * as VUE_MODELE from "../web/pages/chat/team/team-view-model.ts";

const P = TEXTES.partout;
const E = CONSTRUCTION.partout.execution;
const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const blank = (text: string) => text.replace(/[^\n]/g, " ");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);

const DIR = "web/pages/chat/team";
const CARD = `${DIR}/TeamRunCard.tsx`;
const PAUSE = `${DIR}/TeamPauseCard.tsx`;
const RESULT = `${DIR}/TeamResultCard.tsx`;
const VUE = `${DIR}/TeamDeroule.tsx`;
const MODEL = `${DIR}/team-view-model.ts`;
const DEROULE = `${DIR}/deroule-model.ts`;
const CSS = `${DIR}/team-choice.css`;

const NOW = 100_000;

// --- Doublures : les lignes que l'exécuteur crée au lancement (une par entrée de planSteps) ----------------------------------

let rang = 0;

function ligne(patch: Partial<StepRunView> & { stepId: string }): StepRunView {
  rang += 1;
  return {
    blocIndex: 0,
    ordre: rang,
    tour: 1,
    tentative: 1,
    titre: patch.stepId,
    assistant: patch.stepId,
    assistantTitre: patch.stepId,
    ia: { model: "gpt-5-mini", label: "Rapide", variant: null, choisieParEquipe: false },
    state: "prevue",
    cause: null,
    sessionId: null,
    queuedAt: null,
    startedAt: null,
    endedAt: null,
    cost: 0,
    tronquee: false,
    extrait: null,
    droits: [],
    ...patch,
  };
}

/** Étape faite : elle a un début, une fin et un coût. */
const faite = (patch: Partial<StepRunView> & { stepId: string }): StepRunView =>
  ligne({ state: "terminee", startedAt: 10_000, endedAt: 20_000, sessionId: `ses_${patch.stepId}`, cost: 0.03, ...patch });

function run(steps: StepRunView[], patch: Partial<TeamRunView> = {}): TeamRunView {
  return {
    id: "run-1",
    teamId: "relecture",
    titre: "Rédaction et relecture",
    rootId: "ses_root",
    directory: "/w/projet",
    state: "terminee",
    cause: null,
    modeUi: "avance",
    estimate: { typique: 0.1, maximum: 0.4 },
    plafond: 0.4,
    cost: 0.09,
    steps,
    pause: null,
    relancable: false,
    suite: null,
    resultatsAjoutes: false,
    requestMessageId: null,
    resultMessageId: null,
    createdAt: 1_000,
    startedAt: 5_000,
    endedAt: 30_000,
    ...patch,
  };
}

/** Bloc de relecture à 2 tours : 5 lignes (auteur 1-2-3, relecteur 1-2), comme planSteps sur le chemin maximal. */
function relecture(options: { toursFaits: 1 | 2; dernierVerdict?: "a-reprendre" | "rien-a-reprendre" | null; revisionFinale?: boolean }): StepRunView[] {
  rang = 0;
  const { toursFaits, dernierVerdict = "rien-a-reprendre", revisionFinale = false } = options;
  const lignes: StepRunView[] = [];
  for (let tour = 1; tour <= 2; tour++) {
    const verdict = tour === toursFaits ? dernierVerdict : "a-reprendre";
    lignes.push(tour <= toursFaits ? faite({ stepId: "auteur", tour, titre: "Rédiger" }) : ligne({ stepId: "auteur", tour, titre: "Rédiger" }));
    lignes.push(
      tour <= toursFaits
        ? faite({ stepId: "relecteur", tour, titre: "Relire", verdict })
        : ligne({ stepId: "relecteur", tour, titre: "Relire", verdict: undefined }),
    );
  }
  lignes.push(revisionFinale ? faite({ stepId: "auteur", tour: 3, titre: "Rédiger" }) : ligne({ stepId: "auteur", tour: 3, titre: "Rédiger" }));
  return lignes.sort((a, b) => a.ordre - b.ordre);
}

/** Bloc d'aiguillage : aiguilleur, deux spécialistes, synthèse (choixMax = 2, chemin maximal). */
function aiguillage(choix: string[] | "aucun"): StepRunView[] {
  rang = 0;
  const retenu = (stepId: string) => choix !== "aucun" && choix.includes(stepId);
  const specialiste = (stepId: string, titre: string) =>
    retenu(stepId) ? faite({ stepId, titre }) : ligne({ stepId, titre, state: "non-choisi", cost: 0 });
  // L'ordre de création fait l'ordre du plan (`ordre`) : aiguilleur, spécialistes, puis synthèse.
  const lignes = [faite({ stepId: "aiguilleur", titre: "Aiguiller", choix }), specialiste("reseau", "Expliquer l'alerte réseau"), specialiste("base", "Expliquer l'alerte base")];
  lignes.push(choix !== "aucun" && choix.length >= 2 ? faite({ stepId: "synthese", titre: "Synthèse" }) : ligne({ stepId: "synthese", titre: "Synthèse", state: "non-choisi" }));
  return lignes;
}

/** Bornes DÉCLARÉES d'un aiguillage, telles que `view()` les pose (team-runner.ts, section `c5:blocs-prevus`). */
const bornesAiguillage = (choixMax: number, specialistes: number): NonNullable<TeamRunView["blocs"]> => [
  { index: 0, type: "aiguillage", choixMax, specialistes },
];

/**
 * Aiguillage SANS synthèse : la forme par défaut de l'éditeur (`choixMax: 1`, `synthese: null`, flow-edit.ts `blocNeufC5`).
 * La dernière ligne du bloc est alors un VRAI spécialiste, jamais une synthèse.
 */
function aiguillageSansSynthese(specialistes: readonly string[], retenu: string): StepRunView[] {
  rang = 0;
  const lignes = [faite({ stepId: "aiguilleur", titre: "Aiguiller", choix: [retenu] })];
  for (const stepId of specialistes) {
    lignes.push(stepId === retenu ? faite({ stepId, titre: stepId }) : ligne({ stepId, titre: stepId, state: "non-choisi", cost: 0 }));
  }
  return lignes;
}

// --- Relecture : tours, verdicts et notes ------------------------------------------------------------------------------------

describe("Déroulé 5b : relecture, une ligne par tour réellement fait", () => {
  it("1 tour fait sur 2 prévus : DEUX lignes, aucune ligne pour le tour qui n'a pas eu lieu", () => {
    const lancement = run(relecture({ toursFaits: 1 }));
    const lignes = etapesParTour(lancement);
    assert.deepEqual(lignes.map((s) => `${s.stepId}#${s.tour}`), ["auteur#1", "relecteur#1"]);
    assert.equal(toursParBloc(lancement).get(0), 1);
    assert.equal(toursPrevusParBloc(lancement).get(0), 2, "le plan réserve deux relectures");
  });

  it("2 tours faits : QUATRE lignes, « tour 2 » sur les lignes du second tour, « ×2 » sur le bloc", () => {
    const lancement = run(relecture({ toursFaits: 2 }));
    const modele = buildTeamDeroule(lancement, true, NOW);
    assert.deepEqual(modele.lignes.map((l) => l.titre), ["Rédiger", "Relire", "Rédiger", "Relire"]);
    assert.equal(modele.lignes[0]?.tour, null, "aucun « tour » au premier tour");
    assert.equal(modele.lignes[2]?.tour, "tour 2");
    assert.equal(modele.lignes[0]?.repetition, "×2", "« ×2 » est posé sur le BLOC, donc sur sa première ligne");
    assert.equal(modele.lignes[1]?.repetition, null, "jamais répété sur chaque ligne");
    assert.equal(toursParBloc(lancement).get(0), 2);
  });

  it("verdict en MOT et icône, jamais la couleur seule ; un verdict illisible est dit et traité comme « à reprendre »", () => {
    assert.deepEqual(verdictLigne("rien-a-reprendre"), { mot: "Rien à reprendre", icone: "check" });
    assert.deepEqual(verdictLigne("a-reprendre"), { mot: "À reprendre", icone: "alert" });
    assert.deepEqual(verdictLigne(null), { mot: E.relecture.verdictIllisible, icone: "alert" });
    assert.equal(verdictLigne(null)?.mot, "Verdict illisible : traité comme « à reprendre ».");
    assert.equal(verdictLigne(undefined), null, "une étape qui n'est pas une relecture n'a aucun verdict");
    const modele = buildTeamDeroule(run(relecture({ toursFaits: 1, dernierVerdict: null })), true, NOW);
    assert.equal(modele.lignes[1]?.verdict?.mot, E.relecture.verdictIllisible);
    assert.equal(modele.lignes[0]?.verdict, null, "l'auteur n'a pas de verdict");
  });

  it("« Non relue après la dernière correction. » quand la dernière correction n'a pas été relue, et jamais sinon", () => {
    const nonRelue = buildTeamDeroule(run(relecture({ toursFaits: 2, dernierVerdict: "a-reprendre", revisionFinale: true })), true, NOW);
    assert.deepEqual(nonRelue.notes, [E.relecture.nonRelue]);
    assert.equal(nonRelue.notes[0], "Non relue après la dernière correction.");
    const conclue = buildTeamDeroule(run(relecture({ toursFaits: 2 })), true, NOW);
    assert.deepEqual(conclue.notes, [], "relecture conclue : aucune note");
  });

  it("écart Prévu / Réel des tours : « 1 tour » au singulier, « 2 tours » au pluriel", () => {
    assert.deepEqual(buildTeamDeroule(run(relecture({ toursFaits: 1 })), true, NOW).ecarts, ["Prévu : jusqu'à 2 tours · Réel : 1 tour"]);
    assert.deepEqual(buildTeamDeroule(run(relecture({ toursFaits: 2 })), true, NOW).ecarts, ["Prévu : jusqu'à 2 tours · Réel : 2 tours"]);
    assert.equal(ecartTours(2, 1), "Prévu : jusqu'à 2 tours · Réel : 1 tour");
    assert.equal(ecartTours(2, 0), "Prévu : jusqu'à 2 tours · Réel : 0 tours");
    assert.equal(ecartTours(-1, -3), "Prévu : jusqu'à 0 tours · Réel : 0 tours", "aucun nombre négatif ne s'affiche");
  });

  it("tentative 2 après une relance : une seule ligne par tour, celle de la dernière tentative", () => {
    rang = 0;
    const lancement = run([
      faite({ stepId: "auteur", tour: 1, titre: "Rédiger", tentative: 1, state: "echec" }),
      faite({ stepId: "auteur", tour: 1, titre: "Rédiger", tentative: 2 }),
      faite({ stepId: "relecteur", tour: 1, titre: "Relire", verdict: "rien-a-reprendre" }),
    ]);
    const modele = buildTeamDeroule(lancement, true, NOW);
    assert.equal(modele.lignes.length, 2);
    assert.equal(modele.lignes[0]?.tentative, "tentative 2");
    assert.equal(modele.lignes[0]?.reel, P.etatsEtape.terminee);
  });
});

// --- Aiguillage : choix, « Non choisi » et écart ------------------------------------------------------------------------------

describe("Déroulé 5b : aiguillage, spécialistes retenus et écartés", () => {
  it("2 spécialistes retenus : la synthèse travaille, aucun « Non choisi », écart « Réel : 2 »", () => {
    const lancement = run(aiguillage(["reseau", "base"]));
    const modele = buildTeamDeroule(lancement, true, NOW);
    assert.deepEqual(modele.lignes.map((l) => l.reel), [P.etatsEtape.terminee, P.etatsEtape.terminee, P.etatsEtape.terminee, P.etatsEtape.terminee]);
    assert.deepEqual(modele.ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 2"]);
    assert.deepEqual(specialistesDuBloc(lancement.steps), { prevu: 2, reel: 2 });
  });

  it("1 seul spécialiste retenu : l'autre et LA SYNTHÈSE sont « Non choisi » (icône minus), sans barre ni coût", () => {
    const lancement = run(aiguillage(["reseau"]));
    const modele = buildTeamDeroule(lancement, true, NOW);
    const ecartees = modele.lignes.filter((l) => l.reel === P.etatsEtape["non-choisi"]);
    assert.deepEqual(ecartees.map((l) => l.titre), ["Expliquer l'alerte base", "Synthèse"]);
    for (const ligneEcartee of ecartees) {
      assert.equal(ligneEcartee.icone, "minus");
      assert.deepEqual(ligneEcartee.bars, [], "une étape écartée n'a AUCUNE barre");
      assert.equal(ligneEcartee.cost, 0, "rien n'a été facturé");
      assert.equal(ligneEcartee.start, null);
      assert.equal(ligneEcartee.durationMs, null);
    }
    assert.equal(modele.lignes[0]?.reel, P.etatsEtape.terminee);
    assert.deepEqual(modele.ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 1"]);
  });

  it("« aucun ne convient » : TOUS les spécialistes et la synthèse sont « Non choisi », coût nul, écart « Réel : 0 »", () => {
    const lancement = run(aiguillage("aucun"));
    const modele = buildTeamDeroule(lancement, true, NOW);
    const suite = modele.lignes.slice(1);
    assert.equal(suite.length, 3);
    for (const l of suite) {
      assert.equal(l.reel, P.etatsEtape["non-choisi"]);
      assert.equal(l.cost, 0);
      assert.deepEqual(l.bars, []);
    }
    assert.deepEqual(modele.ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 0"]);
    assert.equal(ecartSpecialistes(2, 0), "Prévu : jusqu'à 2 spécialistes · Réel : 0");
  });

  it("un aiguillage à UN spécialiste possible : aucune synthèse à écarter, « Prévu : jusqu'à 1 spécialiste »", () => {
    rang = 0;
    const lancement = run([faite({ stepId: "aiguilleur", titre: "Aiguiller", choix: ["reseau"] }), faite({ stepId: "reseau", titre: "Réseau" })]);
    assert.deepEqual(specialistesDuBloc(lancement.steps), { prevu: 1, reel: 1 });
    assert.deepEqual(ecartsDe(lancement).ecarts, ["Prévu : jusqu'à 1 spécialiste · Réel : 1"]);
  });

  it("aiguillage SANS synthèse : le DERNIER spécialiste retenu compte pour un réel, jamais pris pour une synthèse", () => {
    // Forme par défaut de l'éditeur : `choixMax: 1`, aucune synthèse. La dernière ligne du bloc est un vrai spécialiste ; la
    // supposer synthèse faisait dire « Réel : 0 » alors qu'un spécialiste avait travaillé et avait été facturé (P3).
    const deux = run(aiguillageSansSynthese(["reseau", "base"], "base"), { blocs: bornesAiguillage(1, 2) });
    assert.deepEqual(specialistesDuBloc(deux.steps, 2), { prevu: 2, reel: 1 });
    assert.deepEqual(ecartsDe(deux).ecarts, ["Prévu : jusqu'à 1 spécialiste · Réel : 1"]);
    const trois = run(aiguillageSansSynthese(["reseau", "base", "applicatif"], "applicatif"), { blocs: bornesAiguillage(1, 3) });
    assert.deepEqual(specialistesDuBloc(trois.steps, 3), { prevu: 3, reel: 1 });
    assert.deepEqual(ecartsDe(trois).ecarts, ["Prévu : jusqu'à 1 spécialiste · Réel : 1"]);
    // Contre-épreuve : le PREMIER retenu donnait déjà « Réel : 1 » — le cas « bon » ne l'était que par hasard.
    const premier = run(aiguillageSansSynthese(["reseau", "base"], "reseau"), { blocs: bornesAiguillage(1, 2) });
    assert.deepEqual(ecartsDe(premier).ecarts, ["Prévu : jusqu'à 1 spécialiste · Réel : 1"]);
  });

  it("non-régression : avec une synthèse, elle n'est jamais comptée comme un spécialiste", () => {
    const unSeul = run(aiguillage(["reseau"]), { blocs: bornesAiguillage(2, 2) });
    assert.deepEqual(specialistesDuBloc(unSeul.steps, 2), { prevu: 2, reel: 1 });
    assert.deepEqual(ecartsDe(unSeul).ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 1"]);
    const deux = run(aiguillage(["reseau", "base"]), { blocs: bornesAiguillage(2, 2) });
    assert.deepEqual(ecartsDe(deux).ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 2"]);
    const aucun = run(aiguillage("aucun"), { blocs: bornesAiguillage(2, 2) });
    assert.deepEqual(ecartsDe(aucun).ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 0"]);
  });

  it("après une relance, les spécialistes écartés restent « Non choisi » : l'écart ne dépasse jamais le maximum annoncé", () => {
    // Forme laissée en base par une relance d'aiguillage déjà arbitré : le retenu repart (tentative 2), les écartés gardent
    // leur ligne « non-choisi » de la tentative 1.
    rang = 0;
    const lancement = run(
      [
        faite({ stepId: "aiguilleur", titre: "Aiguiller", choix: ["s1"] }),
        faite({ stepId: "s1", titre: "Réseau", tentative: 2 }),
        ligne({ stepId: "s2", titre: "Base", state: "non-choisi", cost: 0 }),
        ligne({ stepId: "s3", titre: "Applicatif", state: "non-choisi", cost: 0 }),
        ligne({ stepId: "syn", titre: "Synthèse", state: "non-choisi", cost: 0 }),
      ],
      { blocs: bornesAiguillage(2, 3) },
    );
    assert.deepEqual(ecartsDe(lancement).ecarts, ["Prévu : jusqu'à 2 spécialistes · Réel : 1"]);
    const modele = buildTeamDeroule(lancement, true, NOW);
    assert.equal(modele.lignes.filter((l) => l.reel === P.etatsEtape.prevue).length, 0, "aucune ligne « Pas encore commencée » sur un lancement fini");
  });

  it("accord du PRÉVU : « jusqu'à 1 tour » et « jusqu'à 1 spécialiste » au singulier (forme par défaut de l'éditeur)", () => {
    assert.equal(ecartTours(1, 1), "Prévu : jusqu'à 1 tour · Réel : 1 tour");
    assert.equal(ecartTours(1, 0), "Prévu : jusqu'à 1 tour · Réel : 0 tours");
    assert.equal(ecartTours(1, 2), "Prévu : jusqu'à 1 tour · Réel : 2 tours");
    assert.equal(ecartSpecialistes(1, 1), "Prévu : jusqu'à 1 spécialiste · Réel : 1");
    assert.equal(ecartSpecialistes(1, 0), "Prévu : jusqu'à 1 spécialiste · Réel : 0");
    for (const phrase of [ecartTours(1, 1), ecartTours(1, 0), ecartTours(1, 2), ecartSpecialistes(1, 1), ecartSpecialistes(1, 0)]) {
      assert.doesNotMatch(phrase, /1 tours|1 spécialistes/, phrase);
    }
    // Non-régression : au-delà de un, et à zéro, le prévu reste au pluriel.
    assert.equal(ecartTours(2, 1), "Prévu : jusqu'à 2 tours · Réel : 1 tour");
    assert.equal(ecartTours(0, 0), "Prévu : jusqu'à 0 tours · Réel : 0 tours");
    assert.equal(ecartSpecialistes(2, 0), "Prévu : jusqu'à 2 spécialistes · Réel : 0");
    // Un bloc de relecture neuf ne réserve qu'un tour : la phrase du Déroulé s'accorde aussi de bout en bout.
    const unTour = run(relecture({ toursFaits: 1 }), { blocs: [{ index: 0, type: "relecture", toursMax: 1 }] });
    assert.deepEqual(buildTeamDeroule(unTour, true, NOW).ecarts, ["Prévu : jusqu'à 1 tour · Réel : 1 tour"]);
  });

  it("un déroulé de l'itération 4 (ni relecture ni aiguillage) n'a AUCUN écart ni note : rien ne change pour lui", () => {
    rang = 0;
    const lancement = run([faite({ stepId: "rediger", titre: "Rédiger" }), faite({ stepId: "consolider", titre: "Consolider", blocIndex: 1 })]);
    assert.deepEqual(ecartsDe(lancement), { ecarts: [], notes: [] });
    const modele = buildTeamDeroule(lancement, true, NOW);
    assert.deepEqual(modele.lignes.map((l) => l.repetition), [null, null]);
    assert.deepEqual(modele.lignes.map((l) => l.tour), [null, null]);
  });
});

// --- Cartes du chat : lignes, carte de choix et journal ------------------------------------------------------------------------

describe("Cartes 5b : lignes de tour, carte de choix et journal de relecture", () => {
  it("les lignes de la carte portent le tour, le verdict et « ×2 », comme le Déroulé", () => {
    const modele = buildTeamRunCard(run(relecture({ toursFaits: 2 })), true);
    assert.deepEqual(modele.lignes.map((l) => l.tour), [null, null, "tour 2", "tour 2"]);
    assert.equal(modele.lignes[0]?.repetition, "×2");
    assert.equal(modele.lignes[3]?.verdict?.mot, E.relecture.rienAReprendre);
    assert.equal(modele.lignes[3]?.verdict?.icone, "check");
  });

  it("carte de choix : la pause « choix » rend une entrée bornée et n'a plus les deux boutons ordinaires", () => {
    const lancement = run(aiguillage(["reseau"]), {
      state: "attente-choix",
      pause: {
        kind: "choix",
        blocId: "bloc-1",
        message: "",
        resultat: null,
        suite: { typique: 0.12, maximum: 0.4 },
        changement: null,
        choix: [
          { stepId: "reseau", titre: "Expliquer l'alerte réseau", propose: true },
          { stepId: "base", titre: "Expliquer l'alerte base", propose: false },
        ],
        raison: "Les journaux montrent des pertes de paquets.",
        choixMax: 2,
      },
    });
    const carte = buildTeamRunCard(lancement, true);
    assert.equal(carte.genre, "pause", "une équipe qui attend votre choix montre bien sa carte de pause");
    assert.equal(carte.verrou, P.saisieVerrouillee, "l'équipe travaille encore : la saisie reste verrouillée");
    const pause = carte.pause;
    assert.ok(pause, "la carte de pause est rendue");
    assert.deepEqual(pause.boutons, [], "les trois boutons sont composés par la carte de choix, avec le nombre coché");
    assert.equal(pause.gratuite, P.pauses.choix.gratuite);
    assert.equal(pause.choix?.choixMax, 2);
    assert.equal(pause.choix?.suiteUsd, 0.12);
    assert.equal(pause.choix?.raison, "Les journaux montrent des pertes de paquets.");
    assert.deepEqual(pause.choix?.options.map((o) => [o.stepId, o.propose]), [
      ["reseau", true],
      ["base", false],
    ]);
  });

  it("la raison de l'aiguilleur est COUPÉE à 300 caractères : un texte d'IA n'est jamais rendu en entier sans borne", () => {
    const longue = "é".repeat(500);
    const lancement = run(aiguillage(["reseau"]), {
      state: "attente-choix",
      pause: { kind: "choix", blocId: "b", message: "", resultat: null, suite: { typique: 0.1, maximum: 0.2 }, changement: null, choix: [], raison: longue, choixMax: 1 },
    });
    const pause = modelePause(lancement, lancement.pause as NonNullable<TeamRunView["pause"]>);
    assert.equal(pause.choix?.raison.length, 300);
  });

  it("chemin « aucun » : lu SUR LE LIVRABLE écrit par deliverable(), avec ou sans assistant de repli", () => {
    // Les phrases viennent de DELIVERABLE_TEXTS (flow.ts, L42a) : la lecture est donc branchée sur le vrai producteur, et
    // l'égalité à l'octet avec construction-texts.ts est déjà tenue par flow-relecture-aiguillage.test.ts.
    assert.equal(DELIVERABLE_TEXTS.aucun, E.aucun.phrase);
    assert.equal(DELIVERABLE_TEXTS.aucunRepli, E.aucun.repli);

    const sansRepli = DELIVERABLE_TEXTS.aucun;
    const lu = aucunDuLivrable(sansRepli);
    assert.ok(lu, "le livrable « aucun » est reconnu");
    assert.equal(lu.assistant, null, "aucun repli nommé");
    assert.equal(lu.envoyer, null, "sans repli, aucun bouton vers un assistant inconnu (P3)");

    const avecRepli = [DELIVERABLE_TEXTS.aucun, DELIVERABLE_TEXTS.aucunRepli.replace("{assistant}", "Expliquer une alerte")].join("\n\n");
    assert.deepEqual(aucunDuLivrable(avecRepli), { assistant: "Expliquer une alerte", envoyer: E.aucun.envoyer });

    // Un livrable ordinaire n'est JAMAIS pris pour un « aucun » : pas de bouton posé sur un résultat qui n'en est pas un.
    assert.equal(aucunDuLivrable("Voici le script corrigé."), null);
    assert.equal(aucunDuLivrable(null), null);

    // La carte de résultat porte la lecture, et le livrable reste rendu tel quel (les deux phrases y sont encore).
    const modele = modeleResultat(run(aiguillage("aucun")), avecRepli, true);
    assert.equal(modele.aucun?.assistant, "Expliquer une alerte");
    assert.equal(modele.aucun?.envoyer, E.aucun.envoyer);
    assert.ok(modele.texte.includes(E.aucun.phrase), "la phrase reste dans le résultat montré");
    assert.ok(modele.texte.includes("Expliquer une alerte"), "la phrase de repli reste dans le résultat montré");
    assert.equal(modeleResultat(run(aiguillage(["reseau"])), "Résultat simple.", true).aucun, null);
  });

  it("carte de résultat : le journal de relecture est séparé du résultat, et les notes restent visibles", () => {
    const livrable = ["Voici le script corrigé.", `## ${E.relecture.journal}`, `### ${E.relecture.tour.replace("{n}", "1")} · ${E.relecture.aReprendre}`, E.relecture.nonRelue].join("\n\n");
    const modele = modeleResultat(run(relecture({ toursFaits: 1 })), livrable, true);
    assert.equal(modele.texte, "Voici le script corrigé.");
    assert.equal(modele.journal?.titre, "Journal de relecture");
    assert.ok(modele.journal?.texte.includes("tour 1"), modele.journal?.texte ?? "");
    assert.deepEqual(modele.notes, [E.relecture.nonRelue]);
    const sansJournal = modeleResultat(run(relecture({ toursFaits: 1 })), "Résultat simple.", true);
    assert.equal(sansJournal.journal, null);
    assert.deepEqual(sansJournal.notes, []);
  });
});

// --- Corrections de la relecture (5b, vague 2) : l'ÉTAT enregistré commande, jamais le texte d'une IA ------------------------

describe("Cartes 5b : le texte d'une IA ne décide plus de ce que la carte replie ni de ce qu'elle propose", () => {
  it("chemin « aucun » : deux phrases recopiées dans un résultat ordinaire n'ouvrent AUCUN bouton", () => {
    const copie = ["Voici ma conclusion.", E.aucun.phrase, E.aucun.repli.replace("{assistant}", "assistant-pirate"), "Fin."].join("\n\n");
    // Le module pur reconnaît bien les deux phrases : c'est l'appelant qui doit d'abord regarder l'état enregistré.
    assert.equal(aucunDuLivrable(copie)?.assistant, "assistant-pirate");
    // Aiguillage RÉELLEMENT arbitré (choix = deux spécialistes) : aucun renvoi vers l'assistant que l'IA a nommé.
    assert.equal(modeleResultat(run(aiguillage(["reseau", "base"])), copie, true).aucun, null);
    // Une équipe sans aucun aiguillage non plus.
    rang = 0;
    const simple = run([faite({ stepId: "rediger", titre: "Rédiger" })]);
    assert.equal(modeleResultat(simple, copie, true).aucun, null);
    // Non-régression D-5-13 : le vrai chemin « aucun » (colonne `choix` = « aucun ») garde son bouton.
    const vrai = modeleResultat(run(aiguillage("aucun")), copie, true);
    assert.equal(vrai.aucun?.assistant, "assistant-pirate");
    assert.equal(vrai.aucun?.envoyer, E.aucun.envoyer);
  });

  it("journal de relecture : sans bloc de relecture, le livrable reste entier, sans repli ni note du cockpit", () => {
    const replie = ["Voici la réponse courte.", `## ${E.relecture.journal}`, "Contenu que l'IA veut cacher sous un repli.", E.relecture.nonRelue].join("\n\n");
    const sansRelecture = modeleResultat(run(aiguillage(["reseau", "base"])), replie, true);
    assert.equal(sansRelecture.texte, replie, "rien n'est découpé : tout reste visible au premier coup d'œil");
    assert.equal(sansRelecture.journal, null, "aucun <details> fermé posé par une IA");
    assert.deepEqual(sansRelecture.notes, [], "le cockpit ne signe pas une note d'honnêteté écrite par une IA");
    // Cas limite : un livrable qui COMMENCE par l'en-tête ne disparaît plus.
    const debut = [`## ${E.relecture.journal}`, "Tout le texte."].join("\n\n");
    assert.equal(modeleResultat(run(aiguillage(["reseau", "base"])), debut, true).texte, debut);
    // Non-régression : dans un vrai bloc de relecture, le journal est bien replié et la note reste affichée.
    const avecRelecture = modeleResultat(run(relecture({ toursFaits: 1 })), replie, true);
    assert.equal(avecRelecture.texte, "Voici la réponse courte.");
    assert.equal(avecRelecture.journal?.titre, E.relecture.journal);
    assert.deepEqual(avecRelecture.notes, [E.relecture.nonRelue]);
    // Les bornes déclarées suffisent, même sans verdict enregistré (relecture arrêtée avant son premier verdict).
    rang = 0;
    const declare = run([faite({ stepId: "auteur", titre: "Rédiger" })], { blocs: [{ index: 0, type: "relecture", toursMax: 2 }] });
    assert.equal(modeleResultat(declare, replie, true).journal?.titre, E.relecture.journal);
  });
});

// --- Clôture de la 5b (D-5b-2, revue d'itération 5b) : la porte regarde le bloc qui porte le livrable --------------------------

describe("Clôture 5b (D-5b-2) : seul le DERNIER bloc de travail, celui qui porte le livrable, ouvre le découpage", () => {
  /**
   * Sonde de la revue 5b : une relecture (bloc 0, conclue « rien à reprendre ») puis une étape (bloc 1). Le livrable est le texte
   * de l'étape du bloc 1, écrit par une IA : `deliverable()` n'y ajoute ni journal ni note (flow.ts, `dernierBlocDeTravail`).
   */
  const relectureVersEtape = (): StepRunView[] => {
    rang = 0;
    return [
      faite({ stepId: "auteur", titre: "Rédiger", blocIndex: 0 }),
      faite({ stepId: "relecteur", titre: "Relire", blocIndex: 0, verdict: "rien-a-reprendre" }),
      faite({ stepId: "mise-en-forme", titre: "Mettre en forme", blocIndex: 1 }),
    ];
  };
  const imite = [
    "Voici le compte rendu mis en forme.",
    `## ${E.relecture.journal}`,
    "Ce que l'IA voudrait cacher sous un repli fermé.",
    E.relecture.nonRelue,
    E.relecture.nonConclue.replace("{n}", "2"),
  ].join("\n\n");

  it("relecture au bloc 0 puis une étape au bloc 1 : le texte de l'étape reste entier, sans repli ni note du cockpit", () => {
    const avecBornes = run(relectureVersEtape(), { blocs: [{ index: 0, type: "relecture", toursMax: 2 }] });
    const modele = modeleResultat(avecBornes, imite, true);
    assert.equal(modele.texte, imite, "rien n'est découpé : le livrable n'est pas celui d'une relecture");
    assert.equal(modele.journal, null, "aucun <details> fermé posé sur le texte d'une IA");
    assert.deepEqual(modele.notes, [], "le cockpit ne signe pas une note d'honnêteté écrite par une IA (classe team-card-note)");

    // Même règle quand la vue ne porte pas les bornes déclarées : le verdict du bloc 0 ne suffit plus à ouvrir le découpage.
    const sansBornes = modeleResultat(run(relectureVersEtape()), imite, true);
    assert.equal(sansBornes.texte, imite);
    assert.equal(sansBornes.journal, null);
    assert.deepEqual(sansBornes.notes, []);
  });

  it("non-régression : quand la relecture EST le dernier bloc de travail, le journal est replié et les notes restent", () => {
    rang = 0;
    const steps = [
      faite({ stepId: "collecte", titre: "Collecter", blocIndex: 0 }),
      faite({ stepId: "auteur", titre: "Rédiger", blocIndex: 1 }),
      faite({ stepId: "relecteur", titre: "Relire", blocIndex: 1, verdict: "a-reprendre" }),
    ];
    const livrable = ["Voici le script corrigé.", `## ${E.relecture.journal}`, "Tour 1 : à reprendre.", E.relecture.nonRelue].join("\n\n");
    for (const vue of [run(steps, { blocs: [{ index: 1, type: "relecture", toursMax: 2 }] }), run(steps)]) {
      const modele = modeleResultat(vue, livrable, true);
      assert.equal(modele.texte, "Voici le script corrigé.");
      assert.equal(modele.journal?.titre, E.relecture.journal);
      assert.deepEqual(modele.notes, [E.relecture.nonRelue]);
    }
    // Une pause finale ne porte aucun livrable (grammaire) : le dernier bloc de TRAVAIL est celui de la dernière étape.
    assert.equal(modeleResultat(run(steps, { blocs: [{ index: 1, type: "relecture", toursMax: 2 }] }), livrable, true).journal?.titre, E.relecture.journal);
  });
});

// --- Clôture de la 5b (D-5b-1, revue d'itération 5b) : la carte d'une pause reprise après un redémarrage du cockpit -----------

describe("Clôture 5b (D-5b-1) : une pause reprise après un redémarrage montre son issue et un texte vrai", () => {
  const R = E.reprise;
  const pauseDe = (kind: NonNullable<TeamRunView["pause"]>["kind"], reestimation?: { aucunLibre: boolean; possible: boolean }) => ({
    kind,
    blocId: kind === "verification" ? "p" : null,
    message: kind === "redemarrage-cockpit" ? P.pauses["redemarrage-cockpit"].message : "",
    resultat: kind === "verification" ? { etape: "a", titre: "Collecte", texte: "Collecte faite." } : null,
    suite: { typique: 0.12, maximum: 0.4 },
    changement: null,
    ...(kind === "choix"
      ? { choix: [{ stepId: "reseau", titre: "Réseau", propose: true }], raison: "Pertes de paquets.", choixMax: 1 }
      : {}),
    ...(reestimation === undefined ? {} : { reestimation }),
  });
  const lancementEnPause = (pause: ReturnType<typeof pauseDe>) =>
    run(aiguillage(["reseau"]), { state: pause.kind === "choix" ? "attente-choix" : "attente-verification", pause });
  const carteDe = (pause: ReturnType<typeof pauseDe>) => {
    const modele = buildTeamRunCard(lancementEnPause(pause), true).pause;
    assert.ok(modele, "la carte de pause est rendue");
    return modele;
  };

  it("pause « Le cockpit a redémarré » sans estimation : [Refaire l'estimation de la suite] remplace [Continuer], la note dit pourquoi", () => {
    const modele = carteDe(pauseDe("redemarrage-cockpit", { aucunLibre: false, possible: true }));
    assert.deepEqual(modele.reprise, { note: R.note, bouton: R.bouton, raison: R.raison, aucunLibre: false });
    assert.deepEqual(
      modele.boutons.map((b) => [b.action, b.libelle, b.allure]),
      [
        ["relancer", R.bouton, "primary"],
        ["arreter", P.boutons.arreter, "danger"],
      ],
      "aucun [Continuer] que le serveur refuserait",
    );
  });

  it("pause « vérifier » sans estimation : même issue, et les champs de votre réponse restent là pour après", () => {
    const modele = carteDe(pauseDe("verification", { aucunLibre: false, possible: true }));
    assert.equal(modele.reprise?.note, R.note);
    assert.deepEqual(modele.boutons.map((b) => b.action), ["relancer", "arreter"]);
    assert.ok(modele.resume !== null && modele.precision !== null, "résumé et précision gardés : la pause revient après l'estimation");
  });

  it("pause de choix sans estimation : la carte de choix reste, « Aucun ne convient » est libre s'il ne lance rien", () => {
    const libre = carteDe(pauseDe("choix", { aucunLibre: true, possible: true }));
    assert.deepEqual(libre.boutons, [], "la carte de choix compose ses boutons elle-même");
    assert.equal(libre.reprise?.aucunLibre, true);
    assert.equal(libre.reprise?.note, `${R.note} ${R.aucunLibre}`);
    assert.ok(libre.choix, "les cases restent affichées : c'est vous qui choisirez après l'estimation (spéc. l.772)");
    const lie = carteDe(pauseDe("choix", { aucunLibre: false, possible: true }));
    assert.equal(lie.reprise?.aucunLibre, false, "un bloc suivant partirait après « aucun » : il attend lui aussi l'estimation");
    assert.equal(lie.reprise?.note, R.note);
  });

  it("demande plus reconstituable : aucun bouton qui échouerait, la note dit que la suite ne peut plus partir", () => {
    const modele = carteDe(pauseDe("verification", { aucunLibre: false, possible: false }));
    assert.equal(modele.reprise?.bouton, null);
    assert.equal(modele.reprise?.note, `${R.impossible} ${R.impossibleSuite}`);
    assert.deepEqual(modele.boutons.map((b) => b.action), ["arreter"]);
    const choix = carteDe(pauseDe("choix", { aucunLibre: true, possible: false }));
    assert.equal(choix.reprise?.note, `${R.impossible} ${R.impossibleSuite} ${R.aucunLibre}`, "« aucun » reste possible, et c'est dit");
  });

  it("non-régression : une pause dont l'estimation est à jour garde exactement ses boutons de l'itération 4", () => {
    const modele = carteDe(pauseDe("redemarrage-cockpit"));
    assert.equal(modele.reprise, null);
    assert.deepEqual(modele.boutons.map((b) => b.action), ["continuer", "arreter"]);
  });

  it("la boîte de confirmation dit ce qui suivra VRAIMENT : reprise immédiate après un redémarrage, sinon la pause revient", () => {
    const reponse = {
      estimate: { typique: 0.12, maximum: 0.4, plafond: 0.4, etapesFacturees: 1, depassementUnAppel: 0.02, relais: 0, parEtape: [] },
      estimateSha256: "b".repeat(64),
      problems: [],
      plafond: 0.45,
      confirmations: [],
      blocage: null,
      expireA: NOW,
      deja: 0.05,
    };
    const montants = "Déjà dépensé : 0,05 $. Suite : ≈ 0,12 $, plafond 0,45 $.";
    const reprend = VUE_MODELE.repriseApresEstimation(pauseDe("redemarrage-cockpit", { aucunLibre: false, possible: true }), reponse);
    assert.deepEqual(reprend, { genre: "confirmation", confirmation: { titre: R.confirmationTitre, message: `${montants} ${R.confirmationReprend}`, empreinte: "b".repeat(64) } });
    const revient = VUE_MODELE.repriseApresEstimation(pauseDe("choix", { aucunLibre: true, possible: true }), reponse);
    assert.equal(revient.genre === "confirmation" && revient.confirmation.message, `${montants} ${R.confirmationPause}`);
    // Refus prévisible : rien n'est confirmé, la raison est dite.
    const bloque = VUE_MODELE.repriseApresEstimation(pauseDe("verification", { aucunLibre: false, possible: true }), { ...reponse, blocage: { status: 409, code: "budget-insuffisant" } });
    assert.equal(bloque.genre, "blocage");
    // Aucun clic utile sans estimation à refaire, ni quand la demande n'est plus là.
    assert.deepEqual(VUE_MODELE.repriseDebut(lancementEnPause(pauseDe("verification", { aucunLibre: false, possible: true }))), { genre: "estimation" });
    assert.equal(VUE_MODELE.repriseDebut(lancementEnPause(pauseDe("verification", { aucunLibre: false, possible: false }))), null);
    assert.equal(VUE_MODELE.repriseDebut(lancementEnPause(pauseDe("verification"))), null);
  });

  it("aucune phrase de la reprise ne promet une estimation « affichée » : c'était la phrase fausse du 409 d'avant (P3)", () => {
    for (const texte of Object.values(R)) assert.equal(/est affichée/.test(texte), false, texte);
    assert.equal(/est affichée/.test(P.erreurs["reestimation-requise"]), false);
    assert.match(P.erreurs["reestimation-requise"], /Rien n'a été envoyé ni facturé\.$/, "le refus arrive avant toute écriture et toute requête");
  });

  it("pause « Le cockpit a redémarré » : la note ne dit pas que le redémarrage a eu lieu PENDANT la pause, c'est lui qui l'a créée (P3)", () => {
    // La carte rend le message de la pause (« … pendant l'équipe », team-texts.ts), PUIS la note de la reprise : les deux phrases
    // sont lues ensemble et doivent être vraies ensemble. La pause « Le cockpit a redémarré » naît du redémarrage (recover de
    // team-runner.ts) ; les autres pauses ont pu le traverser. Une seule formulation, vraie pour toutes.
    for (const possible of [true, false]) {
      const modele = carteDe(pauseDe("redemarrage-cockpit", { aucunLibre: false, possible }));
      assert.equal(modele.message, P.pauses["redemarrage-cockpit"].message);
      assert.match(modele.message, /pendant l'équipe/, "le message de la pause dit QUAND le cockpit a redémarré");
      const note = modele.reprise?.note ?? "";
      assert.doesNotMatch(note, /pendant cette pause/, `possible=${possible} : « ${note} »`);
      assert.match(note, /redémarrage du cockpit/, "la note dit ce qui s'est passé");
    }
    for (const kind of ["verification", "budget", "modification", "changement", "choix"] as const) {
      for (const possible of [true, false]) {
        const note = carteDe(pauseDe(kind, { aucunLibre: kind === "choix", possible })).reprise?.note ?? "";
        assert.doesNotMatch(note, /pendant cette pause/, `${kind}, possible=${possible} : « ${note} »`);
        assert.match(note, /redémarrage du cockpit/, `${kind} : la note dit ce qui s'est passé`);
      }
    }
    // Même règle pour la phrase du refus, rendue par la même carte quand une réponse est refusée (409 reestimation-requise).
    assert.doesNotMatch(P.erreurs["reestimation-requise"], /pendant cette pause/);
    for (const texte of Object.values(R)) assert.doesNotMatch(texte, /pendant cette pause/, texte);
  });

  it("carte : estimation AVANT la boîte, puis relancer avec l'empreinte ; les réponses qui attendent l'estimation sont désactivées", () => {
    const carte = read(CARD);
    const debut = carte.indexOf("// <c5:reprise-redemarrage>\n  /**");
    const fin = carte.indexOf("// </c5:reprise-redemarrage>", debut + 1);
    assert.ok(debut !== -1 && fin > debut, "la reprise de la carte vit dans sa section c5:");
    const section = withoutComments(carte.slice(debut, fin));
    const estimate = section.indexOf("teamRunsApi.estimate(run.id)");
    const boite = section.indexOf("await confirm({ title: confirmation.titre");
    // Tour 3 : le corps porte l'empreinte confirmée et les accords que la boîte a écrits (`corpsDeReprise`), bâti APRÈS la boîte.
    const corps = section.indexOf("const corps = corpsDeReprise(suite, confirmation);");
    const relaunch = section.indexOf("teamRunsApi.relaunch(run.id, corps)");
    assert.ok(estimate > 0 && boite > estimate && corps > boite && relaunch > corps, `estimate=${estimate} boite=${boite} corps=${corps} relaunch=${relaunch}`);
    assert.match(section, /repriseApresEstimation\(pause, await teamRunsApi\.estimate\(run\.id\)\)/);
    assert.match(withoutComments(carte), /onReprendre=\{reprendre\}/);

    const pause = withoutComments(read(PAUSE));
    assert.match(pause, /bouton\.action === "relancer" \? onReprendre : continuer/, "le bouton de la reprise ne répond jamais à la pause");
    assert.match(pause, /const continuerActif = reprise === null && vue\.continuerActif;/);
    assert.match(pause, /const aucunActif = reprise === null \|\| reprise\.aucunLibre;/);
    assert.match(pause, /aria-disabled=\{!continuerActif\}/);
    assert.match(pause, /onClick=\{\(\) => \(aucunActif \? onAucun\(\) : undefined\)\}/);
    assert.doesNotMatch(pause, /autoFocus|\.focus\(\)/, "le focus n'est jamais pris");
  });
});

// --- Clôture de la 5b (contre-vérification) : …/relancer refusé « estimation-perimee » depuis la carte -----------------------------

describe("Clôture 5b : …/relancer refusé « estimation-perimee » depuis la carte — l'estimation est refaite et MONTRÉE (P3)", () => {
  // La boîte « Relancer la suite ? » ou « Reprendre avec cette estimation ? » est restée ouverte plus longtemps que la validité de
  // l'instantané (SNAPSHOT_TTL_MS de team-preflight.ts), ou les lectures ont changé : POST …/relancer rend 409
  // `estimation-perimee`, dont la phrase (« une nouvelle estimation est affichée ») n'est vraie que pour la feuille de lancement,
  // qui ré-estime. La carte l'affichait telle quelle, sans rien ré-estimer (défaut hérité de l'itération 4).
  const confirmation = { titre: P.relance.titre, message: "Déjà dépensé : 0,05 $. Suite : ≈ 0,12 $, plafond 0,45 $.", empreinte: "c".repeat(64) };

  it("premier refus : l'estimation est refaite et montrée dans une nouvelle boîte, qui dit pourquoi elle revient ; rien n'est envoyé", () => {
    assert.deepEqual(VUE_MODELE.relancePerimee("estimation-perimee", false), { genre: "reestimer" });
    const boite = VUE_MODELE.confirmationReestimee(confirmation);
    assert.deepEqual(boite, { titre: confirmation.titre, message: `${P.feuille.perimee} ${confirmation.message}`, empreinte: confirmation.empreinte });
    assert.match(P.feuille.perimee, /voici la nouvelle/, "vrai : la boîte MONTRE la nouvelle estimation");
    // La relance ne part qu'après VOTRE nouvelle confirmation, avec l'empreinte de la nouvelle estimation.
    assert.equal(VUE_MODELE.relanceApresConfirmation(boite, false), null);
    assert.deepEqual(VUE_MODELE.relanceApresConfirmation(boite, true), { genre: "relancer", empreinte: confirmation.empreinte, confirme: true });
  });

  it("refus de la nouvelle estimation : une phrase vraie, sans autre estimation automatique (une par clic, jamais de boucle)", () => {
    const encore = E.relancePerimee.encore;
    assert.deepEqual(VUE_MODELE.relancePerimee("estimation-perimee", true), { genre: "phrase", texte: encore });
    assert.doesNotMatch(encore, /est affichée|voici/, "rien n'est affiché à ce moment-là");
    assert.match(encore, /refaites-la/, "ce qu'il reste à faire");
    assert.match(encore, /Rien n'a été envoyé ni facturé\.$/, "le refus arrive avant tout envoi (A4)");
  });

  it("tout autre refus garde sa phrase", () => {
    for (const code of ["pas-relancable", "budget-guard", "trop-d-equipes", "confirmation-requise", null]) {
      assert.equal(VUE_MODELE.relancePerimee(code, false), null, String(code));
      assert.equal(VUE_MODELE.relancePerimee(code, true), null, String(code));
    }
  });

  it("carte : la relance et la reprise passent toutes deux par relancerAvecEmpreinte, qui n'affiche jamais la phrase du 409", () => {
    const carte = read(CARD);
    const code = withoutComments(carte);
    const debut = carte.indexOf("// <c5:relance-perimee>\n  /**");
    const fin = carte.indexOf("// </c5:relance-perimee>", debut + 1);
    assert.ok(debut !== -1 && fin > debut, "l'aide vit dans sa section c5: (TeamRunCard.tsx est un fichier de l'itération 4)");
    const aide = withoutComments(carte.slice(debut, fin));
    assert.match(aide, /const relancerAvecEmpreinte = useCallback\(/);
    assert.match(aide, /relancePerimee\(code, dejaReestimee\) === null\) throw err;/, "les autres refus gardent le chemin commun (leur phrase)");
    assert.match(aide, /if \(suite\.genre === "reestimer"\) reestimer\(\);\s*else setMessage\(suite\.texte\);/);
    assert.doesNotMatch(aide, /\.message\b/, "la phrase du serveur n'est jamais lue ici");
    assert.doesNotMatch(aide, /teamRunsApi\./, "l'aide n'envoie rien d'elle-même : elle reçoit l'appel de chaque bouton");
    // Aucun chemin ne relance plus par `lancer` seul, qui afficherait la phrase du serveur.
    assert.doesNotMatch(code, /lancer\(\(\) => teamRunsApi\.relaunch/);
    // [Relancer la suite] (itération 4) : même suite qu'avant, estimation refaite une fois et montrée.
    assert.match(code, /const relancer = useCallback\(\(dejaReestimee: boolean = false\) => \{/, "[Relancer la suite] est appelé sans argument : `false` par défaut");
    assert.match(code, /confirmation = dejaReestimee \? confirmationReestimee\(etape\.confirmation\) : etape\.confirmation;/);
    assert.match(code, /await relancerAvecEmpreinte\(\(\) => teamRunsApi\.relaunch\(run\.id, \{ estimateSha256: suite\.empreinte \}\), dejaReestimee, \(\) => relancer\(true\)\);/);
    // [Refaire l'estimation de la suite] (clôture 5b) : le bouton passe `false` explicitement, jamais l'événement du clic.
    assert.match(code, /const reprendre = useCallback\(\(\) => reprendreEstimation\(false\), \[reprendreEstimation\]\);/);
    assert.match(code, /await relancerAvecEmpreinte\(\(\) => teamRunsApi\.relaunch\(run\.id, corps\), dejaReestimee, \(\) => reprendreEstimation\(true\)\);/);
    assert.match(code, /confirmation = dejaReestimee \? confirmationReestimee\(etape\.confirmation\) : etape\.confirmation;[\s\S]*confirmation = dejaReestimee \? confirmationReestimee\(etape\.confirmation\) : etape\.confirmation;/, "les deux boîtes le disent");
  });
});

// --- Clôture de la 5b, tour 3 (D-5b-1) : les accords de la reprise sont ÉCRITS dans la boîte, et seuls eux sont envoyés ------------

describe("Clôture 5b, tour 3 (D-5b-1) : la boîte d'une reprise écrit les accords annoncés, et votre confirmation ne vaut que pour eux", () => {
  const R = E.reprise;
  const pause = (kind: "budget" | "choix" | "redemarrage-cockpit") => ({
    kind,
    blocId: null,
    message: "",
    resultat: null,
    suite: { typique: 0.12, maximum: 0.4 },
    changement: null,
    ...(kind === "choix" ? { choix: [{ stepId: "reseau", titre: "Réseau", propose: true }], raison: "", choixMax: 1 } : {}),
    reestimation: { aucunLibre: false, possible: true },
  });
  const reponse = (confirmations: TeamConfirmation[]) => ({
    estimate: { typique: 0.12, maximum: 0.4, plafond: 0.4, etapesFacturees: 1, depassementUnAppel: 0.02, relais: 0, parEtape: [] },
    estimateSha256: "d".repeat(64),
    problems: [],
    plafond: 0.45,
    confirmations,
    blocage: null,
    expireA: NOW,
    deja: 0.05,
  });
  const montants = "Déjà dépensé : 0,05 $. Suite : ≈ 0,12 $, plafond 0,45 $.";
  const budget = "La suite peut coûter jusqu'à 0,40 $, plus que ce qui reste sur le budget du mois : en confirmant, vous l'acceptez.";
  const plafond = "Le plafond d'arrêt de cette équipe (0,45 $) dépasse le plafond maximum d'un lancement : en confirmant, vous l'acceptez.";

  it("pause « garde-fou budgétaire », budget du mois épuisé : la boîte dit le budget AVANT la confirmation, qui vaut l'accord « budget »", () => {
    const etape = VUE_MODELE.repriseApresEstimation(pause("budget"), reponse(["budget"]));
    assert.equal(etape.genre, "confirmation");
    const confirmation = etape.genre === "confirmation" ? etape.confirmation : null;
    assert.deepEqual(confirmation, { titre: R.confirmationTitre, message: `${montants} ${budget} ${R.confirmationPause}`, empreinte: "d".repeat(64), accords: { budget: true } });
    const suite = VUE_MODELE.relanceApresConfirmation(confirmation, true);
    assert.ok(suite && confirmation);
    assert.deepEqual(VUE_MODELE.corpsDeReprise(suite, confirmation), { estimateSha256: "d".repeat(64), confirmations: { budget: true } });
    // Refusée, la boîte n'envoie rien : ni accord, ni relance.
    assert.equal(VUE_MODELE.relanceApresConfirmation(confirmation, false), null);
  });

  it("budget et plafond (Avancé) : les deux phrases, dans l'ordre de la feuille de lancement, et les deux accords — jamais un autre", () => {
    const etape = VUE_MODELE.repriseApresEstimation(pause("choix"), reponse(["workspace", "budget", "plafond"]));
    const confirmation = etape.genre === "confirmation" ? etape.confirmation : null;
    assert.ok(confirmation);
    assert.equal(confirmation.message, `${montants} ${budget} ${plafond} ${R.confirmationPause}`);
    assert.deepEqual(confirmation.accords, { budget: true, plafond: true }, "« workspace » vient du lancement, jamais de la reprise");
    const suite = VUE_MODELE.relanceApresConfirmation(confirmation, true);
    assert.ok(suite);
    assert.deepEqual(VUE_MODELE.corpsDeReprise(suite, confirmation), { estimateSha256: "d".repeat(64), confirmations: { budget: true, plafond: true } });
    // Une estimation refaite après un 409 `estimation-perimee` garde ses accords, écrits dans sa propre boîte.
    assert.deepEqual(VUE_MODELE.confirmationReestimee(confirmation).accords, { budget: true, plafond: true });
  });

  it("aucun accord annoncé : ni phrase ni accord, et le corps reste exactement celui de l'itération 4", () => {
    const etape = VUE_MODELE.repriseApresEstimation(pause("redemarrage-cockpit"), reponse([]));
    const confirmation = etape.genre === "confirmation" ? etape.confirmation : null;
    assert.ok(confirmation);
    assert.deepEqual(confirmation, { titre: R.confirmationTitre, message: `${montants} ${R.confirmationReprend}`, empreinte: "d".repeat(64) });
    const suite = VUE_MODELE.relanceApresConfirmation(confirmation, true);
    assert.ok(suite);
    assert.deepEqual(VUE_MODELE.corpsDeReprise(suite, confirmation), { estimateSha256: "d".repeat(64) });
    // La relance de l'itération 4 n'écrit aucun accord dans sa boîte : sa suite est inchangée.
    const relance = VUE_MODELE.relanceApresEstimation(reponse(["budget", "plafond"]));
    assert.equal(relance.genre === "confirmation" && relance.confirmation.accords, undefined);
  });

  it("les phrases des accords sont vraies et reprennent les mots de la feuille de lancement", () => {
    assert.match(R.accordBudget, /plus que ce qui reste sur le budget du mois/);
    assert.match(R.accordPlafond, /dépasse le plafond maximum d'un lancement/);
    for (const texte of [R.accordBudget, R.accordPlafond]) {
      assert.match(texte, /en confirmant, vous l'acceptez\.$/, "la confirmation de la boîte vaut l'accord, et elle le dit");
      assert.doesNotMatch(texte, /est affichée|facturé/, texte);
    }
  });
});

describe("Corrections 5b : [Envoyer à cet assistant] atteint enfin le composeur", () => {
  it("la page du chat écoute le préremplissage, dans une section c5:, et n'envoie rien", () => {
    const chat = read("web/pages/ChatPage.tsx");
    const code = withoutComments(chat);
    assert.match(code, /addEventListener\(EVENEMENT_COMPOSEUR/, "la page du chat écoute l'événement publié par la carte");
    assert.match(code, /removeEventListener\(EVENEMENT_COMPOSEUR/, "l'écoute est retirée au démontage");
    const debut = chat.indexOf("<c5:composeur-ecoute>");
    const fin = chat.indexOf("</c5:composeur-ecoute>", debut + 1);
    assert.ok(debut !== -1 && fin > debut, "le branchement vit dans une section c5: (ChatPage est un fichier de classe A)");
    const section = withoutComments(chat.slice(debut, fin));
    assert.match(section, /setDraftSeed\(\{ text: demande/, "la demande retrouvée remplit la saisie");
    assert.match(section, /agentOptions\.some\(/, "l'assistant n'est retenu que s'il est installé (P3)");
    assert.doesNotMatch(section, /fetch\(|\bapi\.|\boc\./, "aucune requête, aucun coût");
    assert.doesNotMatch(section, /autoFocus|\.focus\(\)/, "le focus n'est pas déplacé");
  });

  it("la demande recopiée est relue sans son marqueur", () => {
    const texte = injectionText("demande", { runId: "run-1", equipe: "Tri d'une alerte", texte: "Le traitement de nuit est tombé." });
    const message = { info: { id: "msg_1", sessionID: "ses_root", role: "user" }, parts: [{ type: "text", text: texte }] };
    assert.equal(demandeRecopiee(message, "run-1"), "Le traitement de nuit est tombé.");
    assert.equal(demandeRecopiee(message, "run-1").includes("cockpit:"), false, "aucun marqueur n'arrive dans la saisie");
  });
});

// --- Contrat statique des composants et de la feuille ---------------------------------------------------------------------------

describe("Cartes 5b : contrat des composants et de team-choice.css", () => {
  it("aucun texte écrit en dur dans les cartes : tout vient des modèles", () => {
    const sansClasses = (code: string) => code.replace(/className=(\{`[^`]*`\}|"[^"]*")/g, "").replace(/console\.\w+\((?:[^()]|\([^()]*\))*\);/g, "");
    for (const fichier of [CARD, PAUSE, RESULT]) {
      const code = sansClasses(withoutComments(read(fichier)));
      const chaines = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[À-ÿ]|\b[a-zà-ÿ]+ [a-zà-ÿ]+\b/.test(s));
      assert.deepEqual(chaines, [], fichier);
    }
  });

  it("Déroulé : les ajouts de la 5b viennent tous du modèle (le reste du fichier garde les en-têtes de l'it4)", () => {
    const code = withoutComments(read(VUE));
    for (const re of [/\{row\.tour\}/, /\{row\.repetition\}/, /\{row\.verdict\.mot\}/, /<strong>\{ecart\}<\/strong>/, /\{note\}/]) {
      assert.match(code, re, String(re));
    }
    assert.match(code, /modele\.ecarts\.map/);
    assert.match(code, /modele\.notes\.map/);
  });

  it("aucun texte d'IA rendu sans échappement : ni dangerouslySetInnerHTML, ni innerHTML, ni eval", () => {
    for (const fichier of [CARD, PAUSE, RESULT, VUE, MODEL, DEROULE, "server/shared/team-choice-view.ts"]) {
      assert.doesNotMatch(withoutComments(read(fichier)), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|\beval\(|new Function/, fichier);
    }
    // Le journal passe par le composant Markdown existant (assaini), comme le résultat.
    assert.match(withoutComments(read(RESULT)), /<Markdown text=\{modele\.journal\.texte\}/);
  });

  it("le focus n'est JAMAIS volé : aucun autoFocus ni .focus() ; le bloc de pause porte l'identifiant du renvoi", () => {
    for (const fichier of [CARD, PAUSE, RESULT, VUE]) {
      assert.doesNotMatch(withoutComments(read(fichier)), /autoFocus|\.focus\(\)/, fichier);
    }
    assert.equal(teamPauseElementId("run-1"), "equipe-pause-run-1");
    assert.match(withoutComments(read(CARD)), /blocId=\{teamPauseElementId\(modele\.runId\)\}/);
    assert.match(withoutComments(read(PAUSE)), /id=\{blocId\}/);
  });

  it("le préremplissage du composeur n'envoie RIEN : aucun appel d'API sur ce chemin", () => {
    const code = withoutComments(read(RESULT));
    assert.match(code, /window\.dispatchEvent\(new CustomEvent\(EVENEMENT_COMPOSEUR, \{ detail \}\)\)/);
    const debut = code.indexOf("const preremplir");
    assert.ok(debut !== -1, "le préremplissage vit dans la carte de résultat, avec le livrable qui nomme le repli");
    assert.doesNotMatch(code.slice(debut, debut + 400), /teamRunsApi|fetch\(|oc\./, "aucune requête, aucun coût");
    // Le bouton n'est composé QUE si le livrable nomme l'assistant : jamais de renvoi vers un assistant inconnu (P3).
    assert.match(code, /repli === null \? null :/);
  });

  it("team-choice.css : bloc @media (forced-colors: active) non vide, et aucune animation", () => {
    const css = read(CSS);
    assert.ok(css.includes("@media (forced-colors: active)"), "bloc de contraste forcé présent");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    assert.match(forced, /CanvasText/);
    assert.match(forced, /\bHighlight\b/, "le focus reste visible en contraste forcé");
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, " "), /\banimation\b|@keyframes|\btransition\b/);
  });

  it("la feuille est chargée là où ses classes servent (cartes, résultat, pause)", () => {
    for (const fichier of [CARD, PAUSE, RESULT]) assert.match(read(fichier), /import "\.\/team-choice\.css";/, fichier);
  });
});
