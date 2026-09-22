// Cartes d'exécution, de pause, de résultat et d'arrêt des équipes (1.1, itération 4, L38b ; plan it4 §6 fiche L38b, §4.1.1,
// §4.2 ; spécification §7.8 l.1184, §5.1 l.876-881, §2.3 l.107-117, §3.12 l.392, §5.5 ; C §9.5, §9.6 ; D-eq-16, D-eq-17, D-eq-22,
// D-eq-24, risque 19).
// Le modèle PUR (web/pages/chat/team/team-view-model.ts) porte toute la logique : chaque état d'équipe et d'étape a son icône ET
// son mot, verrou de la saisie, boutons de pause avec les DEUX montants, pause de fraîcheur, boutons finaux selon `relancable` et
// `resultatsAjoutes`, relance (estimation au clic, confirmation, jamais `relancer` sans empreinte), présence d'UNE SEULE carte de
// résultat. Le cache partagé (useTeamRuns.ts) est vérifié sans navigateur : trois composants d'une même racine ne font qu'UNE
// requête et UN abonnement, au plus 4 relectures par seconde, événements resserrés par EquipeEventMap.
// L'interface n'étant pas exécutée par `npm test`, les composants et la feuille de style sont relus (contrat statique : aucun
// texte écrit en dur, aucun texte d'IA inséré comme HTML, aucune nouvelle région aria-live, bloc forced-colors, TeamResultCard
// exporté avec les propriétés de la fiche pour L38c).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TEAM_RUN_STATES, TEAM_STEP_STATES } from "./shared/team-limits.ts";
import { montant, TEXTES } from "./shared/team-texts.ts";
import type { StepRunView, TeamEstimateResponse, TeamPauseView, TeamRunState, TeamRunView, TeamStepState } from "./shared/team-types.ts";
import type { BrowserEvent } from "../web/lib/types.ts";
import {
  boutonsFinaux,
  buildTeamRunCard,
  confirmationArret,
  ETATS_VERROU,
  etapeResultat,
  etapesVisibles,
  ligneEtape,
  messageFinal,
  messagePause,
  modelePause,
  modeleResultat,
  progression,
  relanceApresConfirmation,
  relanceApresEstimation,
  relanceDebut,
  RUN_ICONS,
  STEP_ICONS,
  type TeamIconName,
  verrouDe,
} from "../web/pages/chat/team/team-view-model.ts";
import { equipeEvent, TEAM_RUNS_MIN_INTERVAL_MS, TeamRunsCache, type TeamRunsDeps } from "../web/pages/chat/team/useTeamRuns.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const blank = (text: string) => text.replace(/[^\n]/g, " ");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);

const P = TEXTES.partout;
const DIR = "web/pages/chat/team";
const CARDS = `${DIR}/TeamRunCards.tsx`;
const CARD = `${DIR}/TeamRunCard.tsx`;
const PAUSE = `${DIR}/TeamPauseCard.tsx`;
const RESULT = `${DIR}/TeamResultCard.tsx`;
const MODEL = `${DIR}/team-view-model.ts`;
const HOOK = `${DIR}/useTeamRuns.ts`;
const CSS = `${DIR}/team-cards.css`;

// --- Doublures ------------------------------------------------------------------------------------------------------------------

function step(patch: Partial<StepRunView> = {}): StepRunView {
  return {
    stepId: "relire",
    blocIndex: 0,
    ordre: 1,
    tour: 1,
    tentative: 1,
    titre: "Relecture du script",
    assistant: "relire-script",
    assistantTitre: "Relecteur de script",
    ia: { model: "gpt-5-mini", label: "Rapide", variant: null, choisieParEquipe: false },
    state: "terminee",
    cause: null,
    sessionId: "ses_1",
    queuedAt: 1_000,
    startedAt: 1_100,
    endedAt: 2_000,
    cost: 0.04,
    tronquee: false,
    extrait: "Trois points à corriger.",
    droits: [],
    ...patch,
  };
}

function run(patch: Partial<TeamRunView> = {}): TeamRunView {
  return {
    id: "run-1",
    teamId: "relecture-script",
    titre: "Chaîne de relecture de script",
    rootId: "ses_root",
    directory: "/w/projet",
    state: "en-cours",
    cause: null,
    modeUi: "avance",
    estimate: { typique: 0.2, maximum: 0.5 },
    plafond: 0.5,
    cost: 0.12,
    steps: [step(), step({ stepId: "consolider", ordre: 2, titre: "Consolidation", state: "en-cours", sessionId: "ses_2", endedAt: null, extrait: null })],
    pause: null,
    relancable: false,
    suite: null,
    resultatsAjoutes: false,
    requestMessageId: "msg_1",
    resultMessageId: null,
    createdAt: 1_000,
    startedAt: 1_050,
    endedAt: null,
    ...patch,
  };
}

function pause(patch: Partial<TeamPauseView> = {}): TeamPauseView {
  return {
    kind: "verification",
    blocId: "pause-1",
    message: "Relisez le résumé avant la suite.",
    resultat: { etape: "relire", titre: "Relecture du script", texte: "Trois points à corriger." },
    suite: { typique: 0.08, maximum: 0.3 },
    changement: null,
    ...patch,
  };
}

function estimation(patch: Partial<TeamEstimateResponse> = {}): TeamEstimateResponse {
  return {
    estimate: { typique: 0.08, maximum: 0.3, plafond: 0.3, etapesFacturees: 2, depassementUnAppel: 0.02, relais: 0.01, parEtape: [] },
    estimateSha256: "a".repeat(64),
    problems: [],
    plafond: 0.42,
    confirmations: [],
    blocage: null,
    expireA: 9_000,
    deja: 0.12,
    ...patch,
  };
}

// --- États : une icône ET un mot (§2.3 l.107-117, jamais la couleur seule) ---------------------------------------------------

/** Icônes déclarées par web/components/Icon.tsx (lecture du source : le .tsx n'est pas exécuté par `npm test`). */
function iconesConnues(): Set<string> {
  const source = withoutComments(read("web/components/Icon.tsx"));
  const bloc = /const PATHS[^{]*\{([\s\S]*?)\n\}\s*as const;/.exec(source);
  assert.ok(bloc, "table des icônes trouvée");
  return new Set([...(bloc[1] ?? "").matchAll(/^\s*"?([A-Za-z][\w-]*)"?\s*:/gm)].map((m) => m[1] ?? ""));
}

describe("cartes d'équipe : chaque état a son icône ET son mot", () => {
  const icones = iconesConnues();

  it("contrôle discriminant : la table des icônes est bien lue", () => {
    for (const nom of ["circle", "pause", "check", "x", "stop", "minus"]) assert.ok(icones.has(nom), nom);
    assert.ok(!icones.has("icone-inventee"));
  });

  it("chaque état de lancement (TeamRunState) a une icône connue et un mot", () => {
    for (const etat of TEAM_RUN_STATES) {
      const icone: TeamIconName = RUN_ICONS[etat];
      assert.ok(icones.has(icone), `${etat} → ${icone}`);
      assert.equal(typeof P.etatsEquipe[etat], "string");
      assert.notEqual(P.etatsEquipe[etat], "");
    }
    assert.deepEqual(Object.keys(RUN_ICONS).sort(), [...TEAM_RUN_STATES].sort());
  });

  it("chaque état d'étape (TeamStepState) a une icône connue et un mot ; les six icônes de la fiche sont à leur place", () => {
    for (const etat of TEAM_STEP_STATES) {
      const icone: TeamIconName = STEP_ICONS[etat];
      assert.ok(icones.has(icone), `${etat} → ${icone}`);
      assert.notEqual(P.etatsEtape[etat], "");
    }
    assert.deepEqual(Object.keys(STEP_ICONS).sort(), [...TEAM_STEP_STATES].sort());
    assert.equal(STEP_ICONS.prevue, "circle");
    assert.equal(STEP_ICONS.terminee, "check");
    assert.equal(STEP_ICONS.echec, "x");
    assert.equal(STEP_ICONS.arretee, "stop");
    assert.equal(STEP_ICONS["non-lancee"], "minus");
  });

  it("chaque ligne d'étape porte l'icône, le mot, et [Voir son travail] seulement avec une session d'étape", () => {
    const ligne = ligneEtape(step({ state: "echec", cause: "plancher-etape", tentative: 2, tronquee: true }), true);
    assert.equal(ligne.icone, "x");
    assert.equal(ligne.mot, P.etatsEtape.echec);
    assert.equal(ligne.voirTravail, P.boutons.voirTravail);
    assert.equal(ligne.tentative, "tentative 2");
    assert.equal(ligne.tronquee, P.execution.tronquee);
    assert.equal(ligne.cause, P.erreurs["plancher-etape"]);
    assert.equal(ligneEtape(step({ sessionId: null }), true).voirTravail, null);
  });

  it("ligne d'étape : IA nommée « choisie par l'équipe » en Avancé seulement ; IA inconnue → aucun séparateur en trop", () => {
    const choisie = step({ ia: { model: "gpt-5", label: "Soigné", variant: null, choisieParEquipe: true } });
    assert.match(ligneEtape(choisie, true).detail, /IA de l'étape : Soigné \(choisie par l'équipe\)$/);
    assert.match(ligneEtape(choisie, false).detail, /IA : Soigné \(celle de l'assistant\)$/);
    const sansIa = ligneEtape(step({ ia: { model: null, label: null, variant: null, choisieParEquipe: false } }), true);
    assert.doesNotMatch(sansIa.detail, /·\s*$/);
    assert.doesNotMatch(sansIa.detail, /\{ia\}/);
  });
});

// --- Verrou de la saisie (D-eq-16) ---------------------------------------------------------------------------------------------

describe("cartes d'équipe : verrou de la saisie (D-eq-16)", () => {
  const verrouillants: TeamRunState[] = ["preparation", "en-cours", "attente-verification", "attente-budget", "attente-modification"];
  const libres: TeamRunState[] = ["terminee", "arretee", "echec", "interrompue", "plafond"];

  it("preparation, en-cours et attente-* verrouillent avec le texte de T4t", () => {
    for (const etat of verrouillants) {
      assert.ok(ETATS_VERROU.has(etat), etat);
      assert.equal(buildTeamRunCard(run({ state: etat }), true).verrou, P.saisieVerrouillee);
    }
  });

  it("interrompue, plafond, echec et terminee ne verrouillent PAS (l'ambiguïté de A §6.11 est tranchée ainsi)", () => {
    for (const etat of libres) {
      assert.ok(!ETATS_VERROU.has(etat), etat);
      assert.equal(buildTeamRunCard(run({ state: etat }), true).verrou, null);
    }
    assert.deepEqual([...TEAM_RUN_STATES].filter((e) => !ETATS_VERROU.has(e)).sort(), [...libres].sort());
  });

  it("verrouDe : le texte dès qu'une équipe de la conversation verrouille, null sinon", () => {
    assert.equal(verrouDe([]), null);
    assert.equal(verrouDe([run({ state: "terminee" }), run({ id: "run-2", state: "plafond" })]), null);
    assert.equal(verrouDe([run({ state: "terminee" }), run({ id: "run-2", state: "attente-budget" })]), P.saisieVerrouillee);
  });
});

// --- Carte d'exécution (C §9.5) --------------------------------------------------------------------------------------------------

describe("cartes d'équipe : carte d'exécution", () => {
  it("en-tête : équipe, étape n sur N, dépense et plafond, montants écrits par montant() (jamais formatUsd)", () => {
    const modele = buildTeamRunCard(run(), true);
    assert.equal(modele.genre, "execution");
    assert.equal(modele.entete, `Équipe « Chaîne de relecture de script » · étape 2 sur 2 · ${montant(0.12)} $ jusqu'ici · plafond ${montant(0.5)} $`);
    assert.doesNotMatch(modele.entete, /\$\s*\$/);
    assert.deepEqual(
      modele.boutons.map((b) => b.action),
      ["arreter"],
    );
    assert.equal(modele.boutons[0]?.libelle, P.boutons.arreter);
  });

  it("progression : rang de la dernière étape commencée, total et étapes terminées ; la dernière tentative seule est montrée", () => {
    const deuxTentatives = run({
      steps: [step({ tentative: 1, state: "echec" }), step({ tentative: 2, state: "terminee" }), step({ stepId: "consolider", ordre: 2, state: "prevue", sessionId: null })],
    });
    assert.deepEqual(progression(deuxTentatives), { n: 1, total: 2, terminees: 1 });
    assert.deepEqual(
      etapesVisibles(deuxTentatives).map((s) => `${s.stepId}-${s.tentative}`),
      ["relire-2", "consolider-1"],
    );
  });

  it("une ligne de pause « Pause pour vérifier » rejoint la liste quand l'équipe attend votre vérification", () => {
    const modele = buildTeamRunCard(run({ state: "attente-verification", pause: pause() }), true);
    const lignePause = modele.lignes.find((l) => l.kind === "pause");
    assert.ok(lignePause, "ligne de pause présente");
    assert.equal(lignePause.icone, "pause");
    assert.equal(lignePause.mot, P.execution.pause);
    assert.equal(buildTeamRunCard(run(), true).lignes.filter((l) => l.kind === "pause").length, 0);
  });

  it("équipe terminée : ce n'est plus une exécution, et [Arrêter l'équipe] n'est pas proposé (POST …/stop rendrait 409)", () => {
    const modele = buildTeamRunCard(run({ state: "terminee", endedAt: 3_000 }), true);
    assert.deepEqual(
      modele.boutons.map((b) => b.action),
      [],
    );
    assert.notEqual(modele.genre, "execution");
  });

  it("aucun état hors ETATS_VERROU ne compose [Arrêter l'équipe] : l'arrêt n'est offert que là où il a un sens", () => {
    for (const etat of TEAM_RUN_STATES) {
      const arretable = buildTeamRunCard(run({ state: etat }), true).boutons.some((b) => b.action === "arreter");
      if (!ETATS_VERROU.has(etat)) assert.equal(arretable, false, etat);
    }
    // Contrôle discriminant : un lancement qui travaille, lui, porte bien le bouton.
    assert.equal(buildTeamRunCard(run({ state: "en-cours" }), true).boutons.some((b) => b.action === "arreter"), true);
  });

  it("boîte d'arrêt : « Arrêter l'équipe ? » et sa phrase", () => {
    assert.deepEqual(confirmationArret(), { titre: P.arret.titre, message: P.arret.message, confirmer: P.arret.confirmer, annuler: P.arret.annuler });
    assert.equal(confirmationArret().titre, "Arrêter l'équipe ?");
  });
});

// --- Pauses (C §9.5) ---------------------------------------------------------------------------------------------------------

describe("cartes d'équipe : pauses", () => {
  it("vérification : message, « Résumé transmis (modifiable) » à 24 000 caractères, précision, « Rien n'est facturé pendant la pause. »", () => {
    const modele = modelePause(run({ state: "attente-verification" }), pause());
    assert.equal(modele.titre, P.pauses.verification.titre);
    assert.equal(modele.message, "Relisez le résumé avant la suite.");
    assert.equal(modele.resume?.libelle, P.pauses.verification.resume);
    assert.equal(modele.resume?.max, 24_000);
    assert.equal(modele.resume?.texte, "Trois points à corriger.");
    assert.equal(modele.precision?.libelle, P.pauses.verification.precision);
    assert.equal(modele.precision?.max, 1_000);
    assert.equal(modele.gratuite, "Rien n'est facturé pendant la pause.");
    assert.equal(modele.confirme, false);
  });

  it("bouton [Continuer l'équipe] porte les DEUX montants ; [Arrêter l'équipe] à côté", () => {
    const modele = modelePause(run({ state: "attente-verification" }), pause());
    assert.deepEqual(
      modele.boutons.map((b) => b.action),
      ["continuer", "arreter"],
    );
    const libelle = modele.boutons[0]?.libelle ?? "";
    assert.equal(libelle, `Continuer l'équipe (≈ ${montant(0.08)} $ de plus, ${montant(0.3)} $ au plus)`);
    assert.ok(libelle.includes(montant(0.08)) && libelle.includes(montant(0.3)), libelle);
  });

  it("pause de budget : texte propre, confirmation du garde-fou ; modification et redémarrage ont leurs textes", () => {
    const budget = modelePause(run({ state: "attente-budget" }), pause({ kind: "budget", message: "", resultat: null }));
    assert.equal(budget.titre, P.pauses.budget.titre);
    assert.equal(budget.confirme, true);
    assert.equal(budget.resume, null);
    assert.equal(modelePause(run({ state: "attente-modification" }), pause({ kind: "modification", message: "", resultat: null })).message, P.pauses.modification.message);
    assert.equal(
      modelePause(run({ state: "attente-verification" }), pause({ kind: "redemarrage-cockpit", message: "", resultat: null })).message,
      P.pauses["redemarrage-cockpit"].message,
    );
  });

  it("pause de fraîcheur (D-eq-17) : la RAISON du code, deux boutons, [Continuer l'équipe] sans montants", () => {
    const fraicheur = pause({ kind: "changement", message: "message du serveur ignoré", resultat: null, changement: { code: "extension-configuree" } });
    const modele = modelePause(run({ state: "attente-verification" }), fraicheur);
    assert.equal(modele.titre, P.pauses.changement.titre);
    assert.ok(modele.message.includes(P.raisonsChangement["extension-configuree"]), modele.message);
    assert.ok(modele.message.endsWith(P.honnetete.rienEnvoye), modele.message);
    assert.deepEqual(
      modele.boutons.map((b) => b.libelle),
      [P.boutons.continuer, P.boutons.arreter],
    );
    assert.doesNotMatch(modele.boutons[0]?.libelle ?? "", /\$/);
    // Code hors de la liste : la raison générale, jamais un message inventé ni le texte du serveur.
    const autre = modelePause(run(), pause({ kind: "changement", changement: { code: "a-venir" } }));
    assert.ok(autre.message.includes(P.raisonsChangement.autre), autre.message);
  });

  it("messagePause : le message du serveur pour une pause écrite dans l'équipe, jamais pour une fraîcheur", () => {
    assert.equal(messagePause(pause(), null), "Relisez le résumé avant la suite.");
    assert.notEqual(messagePause(pause({ kind: "changement", changement: { code: "conversation-occupee" } }), null), "Relisez le résumé avant la suite.");
    assert.equal(messagePause(pause({ message: "" }), null), "");
  });
});

// --- Cartes finales et D-eq-22 ---------------------------------------------------------------------------------------------

describe("cartes d'équipe : cartes finales, boutons selon relancable et resultatsAjoutes", () => {
  const finale = (patch: Partial<TeamRunView>) => run({ state: "arretee", cause: "vous", endedAt: 3_000, ...patch });

  it("relancable : [Relancer la suite (≈ x $)] avec x = run.suite.typique (calcul LOCAL, aucune lecture)", () => {
    const boutons = boutonsFinaux(finale({ relancable: true, suite: { typique: 0.09, maximum: 0.4 } }), true);
    assert.equal(boutons[0]?.action, "relancer");
    assert.equal(boutons[0]?.libelle, `Relancer la suite (≈ ${montant(0.09)} $)`);
    assert.equal(boutons[0]?.desactive, false);
    assert.deepEqual(boutonsFinaux(finale({ relancable: false }), true).map((b) => b.action), ["ajouter-resultats"]);
  });

  it("suite inconnue : le bouton reste, désactivé, avec sa raison", () => {
    const bouton = boutonsFinaux(finale({ relancable: true, suite: null }), true)[0];
    assert.equal(bouton?.desactive, true);
    assert.equal(bouton?.raison, P.erreurs["pas-relancable"]);
  });

  it("resultatsAjoutes : [Ajouter les résultats obtenus à la conversation] désactivé avec « déjà ajoutés » (D-eq-22)", () => {
    const libre = boutonsFinaux(finale({}), true).find((b) => b.action === "ajouter-resultats");
    assert.equal(libre?.libelle, P.boutons.ajouterResultats);
    assert.equal(libre?.desactive, false);
    const ajoutes = boutonsFinaux(finale({ resultatsAjoutes: true }), true).find((b) => b.action === "ajouter-resultats");
    assert.equal(ajoutes?.desactive, true);
    assert.equal(ajoutes?.raison, P.erreurs["deja-ajoute"]);
    // Aucune étape terminée : rien à ajouter.
    assert.equal(boutonsFinaux(finale({ steps: [step({ state: "non-lancee", sessionId: null })] }), true).some((b) => b.action === "ajouter-resultats"), false);
  });

  it("[Fermer] pour interrompue, plafond et echec seulement (POST …/fermer)", () => {
    for (const etat of ["interrompue", "plafond", "echec"] as const) {
      assert.ok(boutonsFinaux(finale({ state: etat }), true).some((b) => b.action === "fermer"), etat);
    }
    assert.equal(boutonsFinaux(finale({ state: "arretee" }), true).some((b) => b.action === "fermer"), false);
  });

  it("phrases des cartes finales : arrêtée, plafond, échec, interrompue, redémarrage du cockpit avant le début", () => {
    assert.equal(messageFinal(finale({})), "Équipe arrêtée par vous à l'étape 2. Les résultats déjà obtenus restent visibles.");
    assert.ok(messageFinal(finale({ state: "plafond", cost: 0.55, plafond: 0.5 })).startsWith("Équipe arrêtée : plafond d'arrêt atteint"));
    assert.ok(messageFinal(finale({ state: "echec", steps: [step({ state: "echec" })] })).includes("« Relecture du script »"));
    assert.equal(messageFinal(finale({ state: "interrompue", cause: "rechargement" })), "Équipe interrompue par un rechargement d'opencode à l'étape 2. Les résultats déjà obtenus sont gardés.");
    assert.equal(messageFinal(finale({ state: "interrompue", cause: "redemarrage-cockpit" })), P.cartes.redemarrage);
    assert.equal(messageFinal(finale({ state: "interrompue", cause: "redemarrage-cockpit", startedAt: null })), P.cartes.redemarrageAvantDebut);
  });

  it("équipes fermées en mode Simple (U1, §2.6) : aucune carte finale ne propose la relance, que le serveur refuse (403)", () => {
    const arretee = finale({ relancable: true, suite: { typique: 0.09, maximum: 0.4 } });
    assert.equal(
      boutonsFinaux(arretee, false).some((b) => b.action === "relancer"),
      false,
      "une fonction absente n'est jamais annoncée avec un prix (P3)",
    );
    assert.deepEqual(
      boutonsFinaux(arretee, false).map((b) => b.action),
      ["ajouter-resultats"],
      "les autres boutons de la carte finale restent",
    );
    assert.equal(boutonsFinaux(arretee, true)[0]?.action, "relancer");
    // La carte entière : en Simple fermé, rien ne mène à la relance ; l'ouverture d'UNE LIGNE (ouvertesEnSimple) la ramène.
    assert.equal(buildTeamRunCard(arretee, false).boutons.some((b) => b.action === "relancer"), false);
    assert.equal(buildTeamRunCard(arretee, false, true).boutons.some((b) => b.action === "relancer"), true);
    assert.equal(buildTeamRunCard(arretee, true).boutons.some((b) => b.action === "relancer"), true);
  });

  it("carte finale : genre, phrase et bilan chiffré", () => {
    const modele = buildTeamRunCard(finale({ relancable: true, suite: { typique: 0.09, maximum: 0.4 } }), true);
    assert.equal(modele.genre, "finale");
    assert.equal(modele.bilan, `Étapes terminées : 1 sur 2 · ${montant(0.12)} $`);
    assert.equal(modele.pause, null);
  });
});

// --- Relance (D-eq-17, A4 : estimation d'abord, jamais `relancer` sans empreinte) ---------------------------------------------

describe("cartes d'équipe : relance de la suite", () => {
  it("au clic : une ESTIMATION, jamais un lancement ; rien du tout si le lancement n'est pas relançable", () => {
    assert.deepEqual(relanceDebut(run({ state: "arretee", relancable: true })), { genre: "estimation" });
    assert.equal(relanceDebut(run({ state: "arretee", relancable: false })), null);
  });

  it("estimation acceptée : boîte « Déjà dépensé : {x} $. Suite : ≈ {y} $, plafond {z} $. » et l'empreinte", () => {
    const etape = relanceApresEstimation(estimation());
    assert.equal(etape.genre, "confirmation");
    if (etape.genre !== "confirmation") return;
    assert.equal(etape.confirmation.titre, P.relance.titre);
    assert.equal(etape.confirmation.message, `Déjà dépensé : ${montant(0.12)} $. Suite : ≈ ${montant(0.08)} $, plafond ${montant(0.42)} $.`);
    assert.equal(etape.confirmation.empreinte, "a".repeat(64));
  });

  it("refus prévisible (`blocage`) : bouton désactivé avec la raison, aucune relance", () => {
    const etape = relanceApresEstimation(estimation({ blocage: { status: 409, code: "conversation-occupee" } }));
    assert.equal(etape.genre, "blocage");
    if (etape.genre !== "blocage") return;
    assert.ok(etape.raison.startsWith(P.feuille.refusPrevisible), etape.raison);
    assert.ok(etape.raison.includes(P.erreurs["conversation-occupee"]), etape.raison);
  });

  it("JAMAIS `relancer` sans empreinte ni sans confirmation", () => {
    const confirmation = { titre: P.relance.titre, message: "…", empreinte: "b".repeat(64) };
    assert.deepEqual(relanceApresConfirmation(confirmation, true), { genre: "relancer", empreinte: "b".repeat(64), confirme: true });
    assert.equal(relanceApresConfirmation(confirmation, false), null);
    assert.equal(relanceApresConfirmation(null, true), null);
    assert.equal(relanceApresConfirmation({ ...confirmation, empreinte: "" }, true), null);
    // Empreinte absente de la réponse d'estimation : refus prévisible, jamais un envoi.
    assert.equal(relanceApresEstimation(estimation({ estimateSha256: "" })).genre, "blocage");
  });
});

// --- Carte de résultat : une seule (C §9.6, risque 19) -------------------------------------------------------------------------

describe("cartes d'équipe : carte de résultat", () => {
  const terminee = (patch: Partial<TeamRunView> = {}) =>
    run({
      state: "terminee",
      endedAt: 3_050,
      steps: [step(), step({ stepId: "consolider", ordre: 2, titre: "Consolidation", extrait: "# Rapport\n\nAucun point bloquant." })],
      ...patch,
    });

  it("présente quand `resultMessageId` est null (carte seule, injection refusée) ; ABSENTE dès qu'il est connu", () => {
    assert.notEqual(buildTeamRunCard(terminee(), true).resultat, null);
    assert.equal(buildTeamRunCard(terminee({ resultMessageId: "msg_2" }), true).resultat, null);
    // Un lancement encore en cours n'a pas de carte de résultat.
    assert.equal(buildTeamRunCard(run(), true).resultat, null);
  });

  it("textes : titre, « Rédigé par l'étape … sans appel d'IA. », résumé chiffré, « À vérifier par vous … », [Ajouter à la conversation]", () => {
    const modele = modeleResultat(terminee(), "# Rapport", true);
    assert.equal(modele.titre, "Résultat de l'équipe « Chaîne de relecture de script »");
    assert.ok(modele.redige.includes("« Consolidation »"), modele.redige);
    assert.ok(modele.redige.toLowerCase().endsWith(P.honnetete.recopie.toLowerCase()), modele.redige);
    assert.ok(modele.resume.startsWith("2 étapes · "), modele.resume);
    assert.ok(modele.resume.includes(`${montant(0.12)} $ (estimé : ${montant(0.2)} $ en général)`), modele.resume);
    assert.equal(modele.aVerifier, P.resultat.aVerifier);
    assert.equal(modele.ajouter, P.boutons.ajouter);
    assert.equal(modele.ajouter, "Ajouter à la conversation");
  });

  it("l'IA choisie par l'équipe n'est nommée comme telle qu'en Avancé (§3.13 l.413)", () => {
    const equipe = terminee({ steps: [step({ stepId: "consolider", ordre: 2, ia: { model: "gpt-5", label: "Soigné", variant: null, choisieParEquipe: true } })] });
    assert.equal(modeleResultat(equipe, "", true).iaEquipe, "IA de l'étape : Soigné (choisie par l'équipe)");
    assert.equal(modeleResultat(equipe, "", false).iaEquipe, null);
    assert.equal(modeleResultat(terminee(), "", true).iaEquipe, null);
  });

  it("le texte montré est celui de la dernière étape terminée qui porte un extrait, borné", () => {
    assert.equal(etapeResultat(terminee())?.stepId, "consolider");
    assert.equal(etapeResultat(run({ steps: [step({ state: "en-cours", extrait: null })] })), null);
    assert.equal(modeleResultat(terminee(), "x".repeat(30_000), true).texte.length, 24_000);
  });
});

// --- Cache partagé des lancements (useTeamRuns) ---------------------------------------------------------------------------------

interface Horloge {
  t: number;
  taches: Array<{ at: number; fn: () => void }>;
}

function cacheEssai(reponses: () => TeamRunView[] | Error) {
  const horloge: Horloge = { t: 0, taches: [] };
  const compte = { charges: 0, abonnements: 0, desabonnements: 0 };
  let handler: ((event: BrowserEvent) => void) | null = null;
  const deps: TeamRunsDeps = {
    charger: (_rootId, _signal) => {
      compte.charges += 1;
      const reponse = reponses();
      return reponse instanceof Error ? Promise.reject(reponse) : Promise.resolve({ runs: reponse });
    },
    abonner: (fn) => {
      compte.abonnements += 1;
      handler = fn;
      return () => {
        compte.desabonnements += 1;
        handler = null;
      };
    },
    setTimer: (fn, ms) => {
      const tache = { at: horloge.t + ms, fn };
      horloge.taches.push(tache);
      return tache;
    },
    clearTimer: (handle) => {
      horloge.taches = horloge.taches.filter((tache) => tache !== handle);
    },
    now: () => horloge.t,
    phraseErreur: () => "erreur",
  };
  const avancer = (ms: number) => {
    horloge.t += ms;
    const dues = horloge.taches.filter((tache) => tache.at <= horloge.t);
    horloge.taches = horloge.taches.filter((tache) => tache.at > horloge.t);
    for (const tache of dues) tache.fn();
  };
  return { cache: new TeamRunsCache(deps), compte, avancer, emettre: (event: BrowserEvent) => handler?.(event) };
}

const attendre = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("cartes d'équipe : useTeamRuns, un chargement et un abonnement par racine", () => {
  it("trois composants d'une même racine → UNE requête et UN abonnement ; le dernier qui part libère tout", async () => {
    const essai = cacheEssai(() => [run()]);
    const stop = [1, 2, 3].map(() => essai.cache.subscribe("ses_root", () => undefined));
    await attendre();
    assert.equal(essai.compte.charges, 1);
    assert.equal(essai.compte.abonnements, 1);
    assert.equal(essai.cache.snapshot("ses_root").runs.length, 1);
    stop[0]?.();
    stop[1]?.();
    assert.equal(essai.compte.desabonnements, 0, "un abonné restant : rien n'est libéré");
    stop[2]?.();
    assert.equal(essai.compte.desabonnements, 1);
    assert.deepEqual(essai.cache.snapshot("ses_root"), { runs: [], chargement: false, erreur: null });
  });

  it("deux racines : un chargement et un abonnement chacune", async () => {
    const essai = cacheEssai(() => []);
    essai.cache.subscribe("ses_a", () => undefined);
    essai.cache.subscribe("ses_b", () => undefined);
    await attendre();
    assert.equal(essai.compte.charges, 2);
    assert.equal(essai.compte.abonnements, 2);
  });

  it("`equipe.lancement` et `equipe.etape` de la racine relisent, au plus 4 fois par seconde ; les autres trames ne font rien", async () => {
    const essai = cacheEssai(() => [run()]);
    let rendus = 0;
    essai.cache.subscribe("ses_root", () => {
      rendus += 1;
    });
    await attendre();
    assert.equal(essai.compte.charges, 1);
    const evenement = (type: string, rootId: string): BrowserEvent => ({ kind: "cockpit", type, data: { runId: "run-1", rootId, state: "en-cours", cause: null } });
    for (let i = 0; i < 8; i += 1) essai.emettre(evenement("equipe.etape", "ses_root"));
    essai.emettre(evenement("equipe.lancement", "ses_root"));
    await attendre();
    assert.equal(essai.compte.charges, 1, "les trames arrivées dans la même fenêtre sont réunies");
    essai.avancer(TEAM_RUNS_MIN_INTERVAL_MS);
    await attendre();
    assert.equal(essai.compte.charges, 2);
    // Une autre conversation, ou un type inconnu : aucune relecture.
    essai.emettre(evenement("equipe.etape", "ses_autre"));
    essai.emettre({ kind: "cockpit", type: "conversation.arretee", data: { rootId: "ses_root" } });
    essai.avancer(1_000);
    await attendre();
    assert.equal(essai.compte.charges, 2);
    assert.ok(rendus >= 2, `rendus = ${rendus}`);
  });

  it("reconnexion du flux : relecture ; lecture en échec : les lancements connus restent affichés", async () => {
    let echoue = false;
    const essai = cacheEssai(() => (echoue ? new Error("réseau") : [run()]));
    essai.cache.subscribe("ses_root", () => undefined);
    await attendre();
    assert.equal(essai.cache.snapshot("ses_root").runs.length, 1);
    echoue = true;
    essai.emettre({ kind: "cockpit", type: "stream.reconnected", data: null });
    essai.avancer(TEAM_RUNS_MIN_INTERVAL_MS);
    await attendre();
    assert.equal(essai.compte.charges, 2);
    const etat = essai.cache.snapshot("ses_root");
    assert.equal(etat.runs.length, 1, "les lancements connus restent affichés");
    assert.equal(etat.erreur, "erreur");
  });

  it("premier chargement en échec : liste vide et phrase d'erreur, jamais une liste inventée", async () => {
    const essai = cacheEssai(() => new Error("réseau"));
    essai.cache.subscribe("ses_root", () => undefined);
    await attendre();
    assert.deepEqual(essai.cache.snapshot("ses_root"), { runs: [], chargement: false, erreur: "erreur" });
  });

  it("equipeEvent : trame resserrée par EquipeEventMap ; tout ce qui ne suit pas le contrat est ignoré", () => {
    const bon: BrowserEvent = { kind: "cockpit", type: "equipe.etape", data: { runId: "run-1", rootId: "ses_root", stepId: "relire", tour: 1, tentative: 1, state: "en-cours", sessionId: null } };
    assert.equal(equipeEvent(bon, "equipe.etape", "ses_root")?.runId, "run-1");
    assert.equal(equipeEvent(bon, "equipe.etape", "ses_autre"), null);
    assert.equal(equipeEvent(bon, "equipe.lancement", "ses_root"), null);
    assert.equal(equipeEvent({ kind: "cockpit", type: "equipe.etape", data: { rootId: "ses_root" } }, "equipe.etape", "ses_root"), null);
    assert.equal(equipeEvent({ kind: "cockpit", type: "equipe.etape", data: "texte" }, "equipe.etape", "ses_root"), null);
    assert.equal(equipeEvent({ kind: "opencode", event: { type: "equipe.etape", properties: {} } }, "equipe.etape", "ses_root"), null);
  });
});

// --- Contrat statique des composants et de la feuille --------------------------------------------------------------------------

describe("cartes d'équipe : contrat des composants", () => {
  it("TeamRunCards : squelette remplacé, propriétés de slots.ts, propriétaire L38b", () => {
    const source = read(CARDS);
    assert.equal(source.split("\n")[0]?.replace(/\r$/, ""), "// Propriétaire : L38b.");
    assert.ok(!source.includes("Squelette T4w"), "le squelette est remplacé");
    assert.match(source, /import type \{ TeamRunCardsProps \} from "\.\/slots\.ts";/);
    assert.match(source, /export function TeamRunCards\([^)]*: TeamRunCardsProps\)/);
  });

  it("TeamRunCards : la carte de résultat n'est rendue que sous `modele.resultat === null ? null :` (une seule carte)", () => {
    const code = withoutComments(read(CARDS));
    assert.match(code, /\{modele\.resultat === null \? null : \(\s*<TeamResultCard\b/);
    assert.equal((code.match(/<TeamResultCard\b/g) ?? []).length, 1, "une seule instance de la carte de résultat");
    for (const autre of [CARD, PAUSE]) assert.doesNotMatch(withoutComments(read(autre)), /<TeamResultCard\b/, autre);
  });

  it("TeamRunCards : un seul crochet partagé (useTeamRuns), le verrou remis à null au démontage", () => {
    const code = withoutComments(read(CARDS));
    assert.match(code, /const \{ runs \} = useTeamRuns\(rootId\);/);
    assert.match(code, /lockRef\.current\(verrou\);/);
    assert.match(code, /return \(\) => lockRef\.current\(null\);/);
  });

  it("TeamRunCards lit `ouvertesEnSimple` (GET /api/teams) et le passe au modèle : rien de fermé n'est proposé en Simple", () => {
    const code = withoutComments(read(CARDS));
    assert.match(code, /teamsApi\.list\(/, "l'ouverture des équipes est lue par api-teams.ts, jamais supposée");
    assert.match(code, /buildTeamRunCard\(run, advanced, equipesOuvertes\)/);
    assert.match(code, /const equipesOuvertes = advanced \|\| ouvertesEnSimple;/);
    // Défaut fermé : un échec de lecture laisse les équipes fermées en Simple, comme le lanceur qui reste absent.
    assert.match(code, /useState\(false\)/);
  });

  it("TeamResultCard est EXPORTÉ avec les propriétés de la fiche (consommateur L38c en V3)", () => {
    const code = withoutComments(read(RESULT));
    assert.match(code, /export interface TeamResultCardProps \{/);
    assert.match(code, /run: TeamRunView;/);
    assert.match(code, /texte: string;/);
    assert.match(code, /advanced: boolean;/);
    assert.match(code, /onAdd\?: \(\) => void;/);
    assert.match(code, /export function TeamResultCard\(\{ run, texte, advanced, onAdd \}: TeamResultCardProps\)/);
  });

  it("aucun texte d'IA inséré comme HTML : le résultat passe par le composant Markdown existant, jamais par dangerouslySetInnerHTML", () => {
    for (const fichier of [CARDS, CARD, PAUSE, RESULT, MODEL, HOOK]) {
      assert.doesNotMatch(withoutComments(read(fichier)), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/, fichier);
    }
    assert.match(withoutComments(read(RESULT)), /<Markdown text=\{modele\.texte\}/);
    // Tout texte venu d'opencode ou d'une équipe passe par boundedAiText dans le modèle pur.
    assert.match(withoutComments(read(MODEL)), /const texte = \(valeur: unknown, max: number\) => boundedAiText\(valeur, max\)\.text;/);
  });

  it("annonces : région de la page (L5b), aucune nouvelle région aria-live", () => {
    assert.match(withoutComments(read(CARD)), /const say = useAnnouncer\(ui\.activityAnnouncements\);/);
    assert.match(withoutComments(read(CARD)), /if \(precedent !== null && precedent !== modele\.annonce\) say\(modele\.annonce\);/);
    for (const fichier of [CARDS, CARD, PAUSE, RESULT]) {
      assert.doesNotMatch(withoutComments(read(fichier)), /aria-live|role="status"|role="alert"/, fichier);
    }
  });

  it("aucun texte écrit en dur dans les composants : tout vient de team-texts.ts par le modèle", () => {
    /** Classes CSS et messages de console : ce ne sont pas des textes affichés à l'utilisateur. */
    const sansClasses = (code: string) => code.replace(/className=(\{`[^`]*`\}|"[^"]*")/g, "").replace(/console\.\w+\((?:[^()]|\([^()]*\))*\);/g, "");
    for (const fichier of [CARDS, CARD, PAUSE, RESULT]) {
      const code = sansClasses(withoutComments(read(fichier)));
      // Texte entre deux balises JSX (lettre accentuée ou deux mots) : refusé.
      assert.doesNotMatch(code, />[ \t]*[\p{L}][^<{}\n]*<\//u, fichier);
      const chaines = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[À-ÿ]|\b[a-zà-ÿ]+ [a-zà-ÿ]+\b/.test(s));
      assert.deepEqual(chaines, [], fichier);
    }
    // Contrôle discriminant : une phrase écrite en dur serait vue.
    assert.notDeepEqual([...`<p>Équipe arrêtée</p>`.matchAll(/>[ \t]*[\p{L}][^<{}\n]*<\//gu)], []);
  });

  it("relance dans la carte : estimation AVANT la confirmation, puis relancer avec l'empreinte", () => {
    const code = withoutComments(read(CARD));
    const estimate = code.indexOf("teamRunsApi.estimate(run.id)");
    const boite = code.indexOf("await confirm({ title: confirmation.titre");
    const relaunch = code.indexOf("teamRunsApi.relaunch(run.id, { estimateSha256: suite.empreinte })");
    assert.ok(estimate > 0 && boite > estimate && relaunch > boite, `estimate=${estimate} boite=${boite} relaunch=${relaunch}`);
    assert.match(code, /const suite = relanceApresConfirmation\(confirmation, ok\);\s*if \(suite === null\) return;/);
  });
});

// --- Contraste forcé (U9) et mouvement --------------------------------------------------------------------------------------

/** Déclarations « sélecteur → propriété → valeur » d'une feuille, avec la pile de ses @media. */
interface CssDeclaration {
  selecteur: string;
  prop: string;
  value: string;
  blocks: string[];
}

function cssDeclarations(css: string): CssDeclaration[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: CssDeclaration[] = [];
  const pile: string[] = [];
  let reste = source;
  const jeton = /([^{}]*)([{}])/g;
  let match: RegExpExecArray | null = jeton.exec(reste);
  while (match !== null) {
    const tete = (match[1] ?? "").trim();
    if (match[2] === "{") {
      pile.push(tete);
    } else {
      const bloc = pile.pop() ?? "";
      if (!bloc.startsWith("@")) {
        for (const decl of tete.split(";")) {
          const sep = decl.indexOf(":");
          if (sep > 0) out.push({ selecteur: bloc, prop: decl.slice(0, sep).trim(), value: decl.slice(sep + 1).trim(), blocks: [...pile] });
        }
      }
    }
    match = jeton.exec(reste);
  }
  reste = "";
  return out;
}

const FORCED = /^@media\b[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i;
const selectors = (d: CssDeclaration) => d.selecteur.split(",").map((s) => s.trim());

describe("cartes d'équipe : contraste forcé (U9) et mouvement", () => {
  const forced = cssDeclarations(read(CSS)).filter((d) => d.blocks.some((bloc) => FORCED.test(bloc)));
  const a = (selecteur: string, prop: string, value: RegExp) => forced.some((d) => selectors(d).includes(selecteur) && d.prop === prop && value.test(d.value));

  it("bloc @media (forced-colors: active) non vide", () => {
    assert.ok(forced.length > 0, "aucune déclaration sous forced-colors");
  });

  it("bordures des cartes et de la pause, icônes en CanvasText (l'état reste dit par le mot), zone « Résumé transmis » bordée", () => {
    assert.ok(a(".team-card", "border", /\bCanvasText\b/) || a(".team-pause", "border", /\bCanvasText\b/), "bordure des cartes");
    assert.ok(a(".team-icon", "color", /^CanvasText$/), "icônes en CanvasText");
    assert.ok(a(".team-pause-textarea", "border", /\bCanvasText\b/), "zone « Résumé transmis » bordée");
  });

  it("[Arrêter l'équipe] et le focus en Highlight", () => {
    assert.ok(a(".team-card-actions .btn.danger", "border", /\bHighlight\b/), "bouton d'arrêt en Highlight");
    assert.ok(a(".team-card-actions .btn:focus-visible", "outline", /\bHighlight\b/), "focus en Highlight");
  });

  it("aucune animation dans la feuille ni dans les composants (spécification §5.5)", () => {
    assert.doesNotMatch(read(CSS).replace(/\/\*[\s\S]*?\*\//g, " "), /\banimation\b|@keyframes/);
    for (const fichier of [CARDS, CARD, PAUSE, RESULT]) assert.doesNotMatch(withoutComments(read(fichier)), /\.animate\(|setInterval\(/, fichier);
  });

  it("contrôles discriminants du lecteur de feuille", () => {
    const decls = cssDeclarations("@media (forced-colors: active) { .a { color: CanvasText; } } .b { color: red; }");
    assert.equal(decls.filter((d) => d.blocks.some((bloc) => FORCED.test(bloc))).length, 1);
    assert.equal(decls.filter((d) => d.selecteur === ".b").length, 1);
    assert.equal(cssDeclarations("/* @media (forced-colors: active) { .a { color: CanvasText; } } */").length, 0);
  });
});
