// Tests de L42d : relecture et aiguillage dans l'éditeur guidé, formulaire d'étape et emplacement du schéma modifiable
// (itération 5b, vague 2 ; spécification §5.3 l.896-903, §5.5, §5.6 ; C §8.1, §9.11, §10 ; plan d'exécution it5, fiche L42d,
// §4.3, §2.6 ; décisions U1 et D-5-24).
//
// AUCUN TYPE N'EST TOUCHÉ par L42d : `FlowStep.methodes`, `recoit: {etapes}`, les blocs « relecture » et « aiguillage », leurs
// bornes (FLOW_LIMITS) et la grammaire qui les juge (validateFlow) viennent de L42a. Ces tests portent donc sur ce que L42d
// ajoute : les OPÉRATIONS du brouillon (insérer, supprimer, régler, annuler / rétablir) et le MODÈLE des écrans (menus, cartes
// de blocs, formulaire d'étape, tableau de coût, bascule vers le schéma).
//
// Deux garanties de non-régression, vérifiées ici et pas seulement dans server/flow-edit.test.ts :
// - les valeurs de l'itération 4 ne bougent pas : `BLOCS_AJOUTABLES`, `FORMES_DEPART`, `ajouterBloc` et `Ecran2Model.ajouter`
//   ignorent toujours les formes de la 5b, qui vivent dans des valeurs et des champs à part ;
// - MODE SIMPLE (U1, D-5-24) : aucune constante ni aucun réglage propre au mode Simple des équipes n'est ajouté. Ce qui est
//   Simple est PRÊT pour l'ouverture en une ligne — d'où les entrées `ouvertesEnSimple: true` de ces tests, qui montrent
//   l'éditeur Simple sans IA par étape et SANS « Le résultat d'étapes choisies ».
//
// L'interface n'étant pas exécutée par `npm test`, les composants sont RELUS (contrat statique) : squelette de SchemaEditor,
// absence de texte en dur, phrase des écrans étroits rendue à la place du schéma.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { RightLine, Rule } from "./shared/assistant-rules.ts";
import { TEXTES as CONSTRUCTION_TEXTES } from "./shared/construction-texts.ts";
import type { MethodView } from "./shared/construction-types.ts";
import {
  ajouterBloc,
  ajouterBlocC5,
  ajouterSpecialiste,
  annuler,
  appliquer,
  BLOCS_AJOUTABLES,
  BLOCS_AJOUTABLES_C5,
  brouillonDeForme,
  brouillonVide,
  buildEditor,
  descendre,
  dupliquerBloc,
  type EditorAssistantView,
  type EditorInput,
  type EditorTier,
  type FlowDraft,
  FORMES_C5,
  FORMES_DEPART,
  historiqueDe,
  modifierChoixMax,
  modifierEtape,
  modifierMethodes,
  modifierPauseAvantRelecture,
  modifierRecoitEtapes,
  modifierTours,
  monter,
  peutAjouterBlocC5,
  peutRetirerSpecialiste,
  retablir,
  retirerSpecialiste,
  SCHEMA_LARGEUR_MIN,
  supprimerBloc,
} from "./shared/flow-edit.ts";
import { validateFlow } from "./shared/flow.ts";
import { FLOW_LIMITS, FLOW_VERSION, stepInputEtapes, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import { remplir, TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  FlowBlock,
  FlowEstimate,
  FlowProblem,
  FlowStep,
  StepAssistant,
  TeamExampleView,
  TeamPreviewResponse,
} from "./shared/team-types.ts";

const P = TEXTES.partout;
const E = P.editeur;
const C5 = CONSTRUCTION_TEXTES.partout;
const C5_SCHEMA = CONSTRUCTION_TEXTES.avance.schema;
const TEAMS_DIR = path.join(import.meta.dirname, "..", "web", "pages", "assistants", "teams");
const lire = (fichier: string) => fs.readFileSync(path.join(TEAMS_DIR, fichier), "utf8");

// --- Fixtures ---------------------------------------------------------------------------------------------------------------

const ligneDroit = (id: string, action: "allow" | "ask" | "deny"): RightLine => ({
  id,
  kind: action === "allow" ? "oui" : action === "ask" ? "demande" : "non",
  text: id,
  danger: false,
  permission: id,
  action,
});

const LECTURE: RightLine[] = [
  ligneDroit("lecture", "allow"),
  ligneDroit("modification", "deny"),
  ligneDroit("commande", "deny"),
  ligneDroit("internet", "deny"),
  ligneDroit("delegation", "deny"),
  ligneDroit("hors-dossier", "deny"),
];

function assistant(over: Partial<EditorAssistantView> = {}): EditorAssistantView {
  return {
    name: "relire-script",
    title: "Relire un script",
    rights: "lecture",
    rightLines: LECTURE,
    modelName: "GPT-5.5",
    mode: "primary",
    hidden: false,
    ...over,
  };
}

const NIVEAUX: EditorTier[] = [
  { niveau: "rapide", libelle: "Rapide", coutParTaille: { S: 0.01, M: 0.03, L: 0.09 }, disponible: true },
  { niveau: "equilibre", libelle: "Équilibré", coutParTaille: { S: 0.02, M: 0.06, L: 0.18 }, disponible: true },
  { niveau: "expert", libelle: "Expert", coutParTaille: null, disponible: false },
];

const EXEMPLE: TeamExampleView = {
  id: "revue-sql",
  titre: "Revue SQL sur réplica",
  description: "Trois avis indépendants.",
  flow: { version: FLOW_VERSION, blocs: [] },
  installee: false,
  assistantsManquants: [],
  layout: [],
  liste: ["Étape 1 : Exactitude"],
};

/** Méthode « consigne » du catalogue ; `utiliseePar` porte les assistants dont le FICHIER la contient déjà (L44b). */
function methode(id: string, titre: string, utiliseePar: Array<{ name: string; title: string }> = []): MethodView {
  return {
    id,
    version: 1,
    titre,
    phrase: `${titre} : une phrase.`,
    quand: "Toujours.",
    attention: "Rien.",
    kind: "consigne",
    bloc: `## ${titre}`,
    enTete: `<!-- methode:${id} -->`,
    sources: [],
    utiliseePar,
    conseilleePour: [],
  };
}

const CATALOGUE: MethodView[] = [
  methode("cinq-pourquoi", "Cinq pourquoi"),
  methode("pre-mortem", "Pré-mortem"),
  methode("avocat-du-diable", "Avocat du diable"),
  { ...methode("liste-de-controle", "Liste de contrôle"), kind: "relecture" },
];

const ESTIMATION: FlowEstimate = {
  typique: 0.6,
  maximum: 1.25,
  plafond: 1.25,
  etapesFacturees: 2,
  depassementUnAppel: 0.08,
  relais: 0.02,
  parEtape: [],
};

function apercuDe(problems: FlowProblem[] = [], over: Partial<TeamPreviewResponse> = {}): TeamPreviewResponse {
  return { problems, estimate: ESTIMATION, droits: LECTURE, layout: [], liste: [], ...over };
}

/** Aperçu dont l'estimation porte les répétitions du chemin maximal (tours d'une relecture, spécialistes d'un aiguillage). */
const apercuRepetitions = (repetitions: { tours: number; specialistes: number }): TeamPreviewResponse =>
  apercuDe([], { estimate: { ...ESTIMATION, repetitions } });

function entree(over: Partial<EditorInput> = {}): EditorInput {
  return {
    mode: "nouvelle",
    advanced: true,
    ouvertesEnSimple: false,
    ecran: 2,
    historique: historiqueDe(brouillonVide()),
    titre: "",
    description: "",
    apercu: null,
    liste: [],
    exemples: [EXEMPLE],
    assistants: [assistant()],
    niveaux: NIVEAUX,
    nomsPris: [],
    chargement: false,
    erreur: null,
    methodes: CATALOGUE,
    ...over,
  };
}

/** Étapes déclarées d'un brouillon, toutes formes comprises, dans l'ordre d'écriture. */
function etapesDe(draft: FlowDraft): FlowStep[] {
  return draft.flow.blocs.flatMap((bloc: FlowBlock) => {
    if (bloc.type === "etape") return [bloc.etape];
    if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
    if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur];
    if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : [])];
    return [];
  });
}

const blocDe = (draft: FlowDraft, type: FlowBlock["type"]): FlowBlock | undefined => draft.flow.blocs.find((bloc) => bloc.type === type);

/** Règles d'un assistant de LECTURE : rien de ce que la grammaire refuse à une étape (D-eq-11). */
const REGLES_LECTURE: Rule[] = ["task", "webfetch", "websearch", "edit", "bash", "external_directory"].map((permission) => ({
  permission,
  pattern: "*",
  action: "deny" as const,
}));

/**
 * Codes posés par la grammaire (L42a) sur un déroulé, les TITRES et les ASSISTANTS mis hors de cause : chaque étape sans
 * assistant en reçoit un qui lui est propre, avec une IA d'une famille qui lui est propre. Ainsi ni « relecteur-distinct » ni
 * « meme-famille » ne se déclenchent sur un brouillon neuf — ce que ces tests veulent lire, ce sont les problèmes de STRUCTURE
 * que les opérations de L42d pourraient créer (aiguillage mal placé, nombre de spécialistes, synthèse exigée, liens).
 */
function codesDe(flow: Flow, mode: "simple" | "avance" = "avance"): string[] {
  const nomme: Flow = { version: flow.version, blocs: JSON.parse(JSON.stringify(flow.blocs)) as FlowBlock[] };
  const etapes = etapesDe({ flow: nomme, compteur: 0 });
  const familles = new Map<string, string>();
  etapes.forEach((step, rang) => {
    if (step.titre === "") step.titre = "Une étape";
    // Noms faits de lettres seules et tous différents : la famille d'IA en est tirée (flow.ts, `familleDe`).
    if (step.assistant === "") step.assistant = String.fromCharCode(97 + (rang % 26)).repeat(3);
    familles.set(step.assistant, `ia/${step.assistant}-5`);
  });
  const assistants: StepAssistant[] = [...familles].map(([name, model]) => ({
    name,
    title: name,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: REGLES_LECTURE,
    model,
    available: true,
    steps: null,
    taille: "M",
  }));
  return validateFlow(nomme, { assistants, mode, niveauDisponible: () => true, pour: "enregistrement" }).map((probleme) => probleme.code);
}

// --- Opérations : insertion, suppression, bornes -----------------------------------------------------------------------------

describe("L42d : insertion des formes de la 5b (fiche L42d ; spéc. §5.3 l.896-903)", () => {
  it("les valeurs de l'itération 4 ne bougent pas : ajouterBloc ignore toujours « relecture » et « aiguillage »", () => {
    assert.deepEqual([...BLOCS_AJOUTABLES], ["etape", "avis", "pause"]);
    assert.deepEqual([...FORMES_DEPART], ["a-la-suite", "avis"]);
    assert.deepEqual([...BLOCS_AJOUTABLES_C5], ["relecture", "aiguillage"]);
    assert.deepEqual([...FORMES_C5], ["relecture", "aiguillage"]);
    const draft = brouillonVide();
    assert.equal(ajouterBloc(draft, "relecture" as FlowBlock["type"], 0), draft, "ajouterBloc rend le brouillon TEL QUEL");
    assert.equal(ajouterBloc(draft, "aiguillage" as FlowBlock["type"], 0), draft);
  });

  it("bloc de relecture : rédacteur et relecteur, 1 tour, aucune pause avant la relecture ; le déroulé est accepté", () => {
    const draft = ajouterBlocC5(brouillonVide(), "relecture", 0);
    const bloc = blocDe(draft, "relecture");
    assert.ok(bloc && bloc.type === "relecture");
    assert.equal(bloc.toursMax, 1);
    assert.equal(bloc.pauseAvantRelecture, false);
    assert.equal(bloc.auteur.titre, "", "le titre part vide : la grammaire pose l'invite sur l'étape");
    assert.equal(bloc.auteur.recoit, "demande", "premier bloc de travail : l'auteur part de la demande");
    assert.equal(bloc.relecteur.recoit, "precedent", "le relecteur reçoit la version courante");
    assert.equal(bloc.auteur.taille, "M");
    assert.deepEqual(codesDe(draft.flow), [], "aucun problème hormis ceux des titres et des assistants, mis hors de cause");
  });

  it("insertion d'un AIGUILLAGE : en tête seulement, refusée ailleurs et refusée une seconde fois", () => {
    const suite = brouillonDeForme("a-la-suite");
    assert.equal(peutAjouterBlocC5(suite, "aiguillage", 0), true);
    assert.equal(peutAjouterBlocC5(suite, "aiguillage", 1), false, "au milieu : refusé");
    assert.equal(peutAjouterBlocC5(suite, "aiguillage", suite.flow.blocs.length), false, "à la fin : refusé");
    // L'opération elle-même rend le brouillon TEL QUEL hors de la tête (donc [Annuler] n'écrit aucun état).
    assert.equal(ajouterBlocC5(suite, "aiguillage", 1), suite);
    const avec = ajouterBlocC5(suite, "aiguillage", 0);
    assert.notEqual(avec, suite);
    assert.equal(avec.flow.blocs[0]?.type, "aiguillage");
    assert.deepEqual(codesDe(avec.flow), [], "un aiguillage en tête est accepté par la grammaire");
    // Un SECOND aiguillage ne pourrait pas être le premier bloc : il est refusé, même en tête.
    assert.equal(peutAjouterBlocC5(avec, "aiguillage", 0), false);
    assert.equal(ajouterBlocC5(avec, "aiguillage", 0), avec);
    // « Une rédaction et relecture » reste possible à toutes les places.
    assert.equal(peutAjouterBlocC5(avec, "relecture", 0), true);
    assert.equal(peutAjouterBlocC5(avec, "relecture", avec.flow.blocs.length), true);
  });

  it("aiguillage neuf : 2 spécialistes, 1 choix au plus, aucune synthèse (elle n'est exigée qu'à 2)", () => {
    const draft = ajouterBlocC5(brouillonVide(), "aiguillage", 0);
    const bloc = blocDe(draft, "aiguillage");
    assert.ok(bloc && bloc.type === "aiguillage");
    assert.equal(bloc.specialistes.length, FLOW_LIMITS.specialistesMin);
    assert.equal(bloc.choixMax, 1);
    assert.equal(bloc.synthese, null);
    assert.equal(bloc.aiguilleur.recoit, "demande");
    for (const specialiste of bloc.specialistes) assert.equal(specialiste.recoit, "demande");
  });

  it("insertion PUIS suppression d'un bloc de relecture : le brouillon revient à ce qu'il était", () => {
    const depart = brouillonDeForme("a-la-suite");
    const avant = depart.flow.blocs.map((bloc) => bloc.id);
    const avec = ajouterBlocC5(depart, "relecture", 1);
    assert.equal(avec.flow.blocs.length, 3);
    assert.equal(avec.flow.blocs[1]?.type, "relecture");
    const relecture = avec.flow.blocs[1];
    assert.ok(relecture);
    const sans = supprimerBloc(avec, relecture.id);
    assert.deepEqual(sans.flow.blocs.map((bloc) => bloc.id), avant, "les identifiants des blocs gardés ne bougent pas");
    assert.equal(blocDe(sans, "relecture"), undefined);
  });

  it("bornes : un bloc de relecture de trop est refusé (5 blocs de travail, 12 étapes)", () => {
    let draft = brouillonVide();
    for (let rang = 0; rang < FLOW_LIMITS.blocsTravail; rang++) draft = ajouterBloc(draft, "etape", rang);
    assert.equal(draft.flow.blocs.length, FLOW_LIMITS.blocsTravail);
    assert.equal(peutAjouterBlocC5(draft, "relecture", 0), false, "un bloc de travail de plus dépasserait 5");
    assert.equal(ajouterBlocC5(draft, "relecture", 0), draft);
  });
});

// --- Opérations : spécialistes et réglages ------------------------------------------------------------------------------------

describe("L42d : spécialistes et réglages des formes (fiche L42d)", () => {
  it("retrait d'un spécialiste sous 2 : REFUSÉ (« Proposez de 2 à 8 spécialistes. »)", () => {
    const draft = ajouterBlocC5(brouillonVide(), "aiguillage", 0);
    const bloc = blocDe(draft, "aiguillage");
    assert.ok(bloc && bloc.type === "aiguillage");
    const premier = bloc.specialistes[0];
    assert.ok(premier);
    assert.equal(peutRetirerSpecialiste(draft, bloc.id), false, "2 spécialistes : la borne basse est atteinte");
    assert.equal(retirerSpecialiste(draft, bloc.id, premier.id), draft, "le brouillon est rendu TEL QUEL");
    // Un spécialiste de plus : le retrait redevient possible, et ramène exactement à 2.
    const trois = ajouterSpecialiste(draft, bloc.id);
    const blocTrois = blocDe(trois, "aiguillage");
    assert.ok(blocTrois && blocTrois.type === "aiguillage");
    assert.equal(blocTrois.specialistes.length, 3);
    assert.equal(peutRetirerSpecialiste(trois, bloc.id), true);
    const deux = retirerSpecialiste(trois, bloc.id, premier.id);
    const blocDeux = blocDe(deux, "aiguillage");
    assert.ok(blocDeux && blocDeux.type === "aiguillage");
    assert.equal(blocDeux.specialistes.length, 2);
    assert.equal(blocDeux.specialistes.some((step) => step.id === premier.id), false);
    assert.deepEqual(codesDe(deux.flow), []);
  });

  it("spécialistes : 8 au plus (FLOW_LIMITS.specialistesMax), et la grammaire refuse au-delà", () => {
    let draft = ajouterBlocC5(brouillonVide(), "aiguillage", 0);
    const bloc = blocDe(draft, "aiguillage");
    assert.ok(bloc);
    for (let rang = FLOW_LIMITS.specialistesMin; rang < FLOW_LIMITS.specialistesMax; rang++) draft = ajouterSpecialiste(draft, bloc.id);
    const plein = blocDe(draft, "aiguillage");
    assert.ok(plein && plein.type === "aiguillage");
    assert.equal(plein.specialistes.length, FLOW_LIMITS.specialistesMax);
    assert.equal(ajouterSpecialiste(draft, bloc.id), draft, "le neuvième est refusé");
    assert.deepEqual(codesDe(draft.flow), []);
  });

  it("« Nombre de tours au maximum » : 1 · 2 seulement ; « Me laisser vérifier le premier jet » bascule", () => {
    const draft = ajouterBlocC5(brouillonVide(), "relecture", 0);
    const bloc = blocDe(draft, "relecture");
    assert.ok(bloc);
    const deux = modifierTours(draft, bloc.id, 2);
    const blocDeux = blocDe(deux, "relecture");
    assert.ok(blocDeux && blocDeux.type === "relecture");
    assert.equal(blocDeux.toursMax, 2);
    assert.equal(modifierTours(deux, bloc.id, 2), deux, "une valeur inchangée n'écrit aucun état");
    assert.equal(modifierTours(deux, bloc.id, 3 as 1 | 2), deux, "au-delà de FLOW_LIMITS.toursMax : refusé");
    assert.deepEqual(codesDe(deux.flow), []);
    const avecPause = modifierPauseAvantRelecture(deux, bloc.id, true);
    const blocPause = blocDe(avecPause, "relecture");
    assert.ok(blocPause && blocPause.type === "relecture");
    assert.equal(blocPause.pauseAvantRelecture, true);
    assert.equal(modifierPauseAvantRelecture(avecPause, bloc.id, true), avecPause);
    assert.deepEqual(codesDe(avecPause.flow), []);
  });

  it("« Spécialistes à consulter au plus » à 2 : la SYNTHÈSE est posée (exigée à 2) ; revenir à 1 la garde", () => {
    const draft = ajouterBlocC5(brouillonVide(), "aiguillage", 0);
    const bloc = blocDe(draft, "aiguillage");
    assert.ok(bloc);
    const deux = modifierChoixMax(draft, bloc.id, 2);
    const blocDeux = blocDe(deux, "aiguillage");
    assert.ok(blocDeux && blocDeux.type === "aiguillage");
    assert.equal(blocDeux.choixMax, 2);
    assert.ok(blocDeux.synthese, "« Synthèse » est exigée avec 2 spécialistes possibles");
    assert.equal(blocDeux.synthese.titre, E.synthese);
    assert.equal(blocDeux.synthese.recoit, "tous");
    assert.deepEqual(codesDe(deux.flow), [], "aucun « synthese-requise » : l'éditeur ne produit pas un déroulé qu'il sait refusé");
    const un = modifierChoixMax(deux, bloc.id, 1);
    const blocUn = blocDe(un, "aiguillage");
    assert.ok(blocUn && blocUn.type === "aiguillage");
    assert.equal(blocUn.choixMax, 1);
    assert.ok(blocUn.synthese, "revenir à 1 ne détruit pas un travail déjà réglé");
    assert.deepEqual(codesDe(un.flow), []);
  });

  it("déplacement et duplication d'un bloc de la 5b : identifiants neufs pour la copie, entrées réparées", () => {
    const depart = ajouterBlocC5(brouillonDeForme("a-la-suite"), "relecture", 2);
    const bloc = depart.flow.blocs[2];
    assert.ok(bloc && bloc.type === "relecture");
    assert.equal(bloc.auteur.recoit, "precedent", "hors de la tête : la valeur par défaut");
    // Monté en tête, l'auteur repart de la demande ; redescendu, il retrouve « precedent ».
    const tete = monter(monter(depart, bloc.id), bloc.id);
    const blocTete = blocDe(tete, "relecture");
    assert.ok(blocTete && blocTete.type === "relecture");
    assert.equal(blocTete.auteur.recoit, "demande");
    const rendu = descendre(tete, bloc.id);
    const blocRendu = blocDe(rendu, "relecture");
    assert.ok(blocRendu && blocRendu.type === "relecture");
    assert.equal(blocRendu.auteur.recoit, "precedent");
    // Duplication : la copie a des identifiants neufs, l'original garde les siens.
    const copie = dupliquerBloc(depart, bloc.id);
    const identifiants = etapesDe(copie).map((step) => step.id);
    assert.equal(new Set(identifiants).size, identifiants.length, "aucun identifiant d'étape en double");
    assert.equal(copie.flow.blocs.filter((b) => b.type === "relecture").length, 2);
    assert.deepEqual(codesDe(copie.flow), []);
  });

  it("copie profonde : une méthode cochée après coup ne remonte pas dans l'état précédent de l'historique", () => {
    const depart = ajouterBlocC5(brouillonVide(), "relecture", 0);
    const auteur = etapesDe(depart)[0];
    assert.ok(auteur);
    const avec = modifierMethodes(depart, auteur.id, ["cinq-pourquoi"]);
    const plus = modifierMethodes(avec, auteur.id, ["cinq-pourquoi", "pre-mortem"]);
    assert.deepEqual(etapesDe(depart)[0]?.methodes, undefined, "l'état de départ n'a jamais porté de méthode");
    assert.deepEqual(etapesDe(avec)[0]?.methodes, ["cinq-pourquoi"], "l'état intermédiaire garde SA liste");
    assert.deepEqual(etapesDe(plus)[0]?.methodes, ["cinq-pourquoi", "pre-mortem"]);
  });
});

// --- Annuler et rétablir -----------------------------------------------------------------------------------------------------

describe("L42d : annuler et rétablir sur les formes de la 5b (fiche L42d)", () => {
  it("annuler puis rétablir : l'insertion, le retrait d'un spécialiste et le réglage des tours reviennent à l'identique", () => {
    let historique = historiqueDe(brouillonVide());
    historique = appliquer(historique, (draft) => ajouterBlocC5(draft, "aiguillage", 0));
    const bloc = blocDe(historique.present, "aiguillage");
    assert.ok(bloc);
    historique = appliquer(historique, (draft) => ajouterSpecialiste(draft, bloc.id));
    const trois = etapesDe(historique.present).length;
    historique = appliquer(historique, (draft) => modifierChoixMax(draft, bloc.id, 2));
    const avecSynthese = historique.present;

    historique = annuler(historique);
    assert.equal(etapesDe(historique.present).length, trois, "[Annuler] retire la synthèse posée avec « 2 au plus »");
    const apresAnnulation = blocDe(historique.present, "aiguillage");
    assert.ok(apresAnnulation && apresAnnulation.type === "aiguillage");
    assert.equal(apresAnnulation.choixMax, 1);

    historique = retablir(historique);
    assert.deepEqual(historique.present.flow, avecSynthese.flow, "[Rétablir] rend exactement l'état annulé");

    // Deux annulations de plus : le spécialiste ajouté, puis le bloc entier.
    historique = annuler(annuler(historique));
    assert.equal(blocDe(historique.present, "aiguillage")?.type, "aiguillage");
    assert.equal(etapesDe(historique.present).length, FLOW_LIMITS.specialistesMin + 1);
    historique = annuler(historique);
    assert.deepEqual(historique.present.flow.blocs, [], "la dernière annulation retire le bloc d'aiguillage");
  });

  it("une opération refusée n'écrit AUCUN état : [Annuler] ne rend jamais un état identique au précédent", () => {
    let historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const avant = historique;
    historique = appliquer(historique, (draft) => ajouterBlocC5(draft, "aiguillage", 1));
    assert.equal(historique, avant, "un aiguillage hors de la tête ne pose rien");
    const relecture = appliquer(historique, (draft) => ajouterBlocC5(draft, "relecture", 0));
    const bloc = blocDe(relecture.present, "relecture");
    assert.ok(bloc);
    const specialisteRefuse = appliquer(relecture, (draft) => retirerSpecialiste(draft, bloc.id, "e1"));
    assert.equal(specialisteRefuse, relecture, "un retrait qui ne s'applique pas n'écrit rien");
  });
});

// --- Formulaire d'étape : méthodes et liens ------------------------------------------------------------------------------------

describe("L42d : formulaire d'étape — méthodes et « Le résultat d'étapes choisies » (§4.3)", () => {
  it("« Méthodes (facultatif, 2 au plus) » : seules les méthodes « consigne », cochées dans FlowStep.methodes", () => {
    const draft = brouillonDeForme("a-la-suite");
    const premiere = etapesDe(draft)[0];
    assert.ok(premiere);
    const modele = buildEditor(entree({ historique: historiqueDe(draft) }));
    const etape = modele.ecran2?.blocs[0]?.etapes[0];
    assert.ok(etape?.methodes);
    assert.equal(etape.methodes.libelle, C5.editeur.champs.methodes);
    assert.equal(etape.methodes.libelle, "Méthodes (facultatif, 2 au plus)");
    assert.deepEqual(
      etape.methodes.options.map((option) => option.id),
      ["cinq-pourquoi", "pre-mortem", "avocat-du-diable"],
      "la méthode de genre « relecture » n'est pas proposée à une étape",
    );
    for (const option of etape.methodes.options) {
      assert.equal(option.choisie, false);
      assert.equal(option.desactivee, false);
      assert.equal(option.raison, null);
    }
    // L'opération écrit bien dans FlowStep.methodes, et une liste vide retire le champ (aucune migration, A2).
    const avec = modifierMethodes(draft, premiere.id, ["pre-mortem"]);
    assert.deepEqual(etapesDe(avec)[0]?.methodes, ["pre-mortem"]);
    assert.deepEqual(codesDe(avec.flow), [], "une méthode de l'étape ne fait rien refuser à la grammaire");
    const sans = modifierMethodes(avec, premiere.id, []);
    assert.equal(Object.hasOwn(etapesDe(sans)[0] ?? {}, "methodes"), false, "aucune méthode = champ ABSENT");
  });

  it("puces DÉSACTIVÉES avec leur RAISON : « Déjà appliquée par l'assistant. » et « 2 méthodes au maximum par étape. »", () => {
    const depart = brouillonDeForme("a-la-suite");
    const premiere = etapesDe(depart)[0];
    assert.ok(premiere);
    // L'étape porte l'assistant dont le FICHIER contient déjà « Avocat du diable ».
    const draft = modifierEtape(depart, premiere.id, { assistant: "relire-script" }, { simple: false });
    // Deux méthodes retenues : la limite par étape est atteinte (FLOW_LIMITS.methodesParEtape).
    const deux = modifierMethodes(draft, premiere.id, ["cinq-pourquoi", "pre-mortem"]);
    const catalogue: MethodView[] = [...CATALOGUE.slice(0, 2), methode("avocat-du-diable", "Avocat du diable", [{ name: "relire-script", title: "Relire un script" }])];
    const modele = buildEditor(entree({ historique: historiqueDe(deux), methodes: catalogue }));
    const etape = modele.ecran2?.blocs[0]?.etapes[0];
    assert.ok(etape?.methodes);
    const parId = new Map(etape.methodes.options.map((option) => [option.id, option]));
    // Déjà dans le FICHIER de l'assistant : refusée, avec sa phrase.
    assert.equal(parId.get("avocat-du-diable")?.desactivee, true);
    assert.equal(parId.get("avocat-du-diable")?.raison, C5.problemes.methodes.deja);
    assert.equal(parId.get("avocat-du-diable")?.raison, "Déjà appliquée par l'assistant.");
    // Les deux retenues restent COCHÉES et décochables : jamais retirées en silence.
    assert.equal(parId.get("cinq-pourquoi")?.choisie, true);
    assert.equal(parId.get("cinq-pourquoi")?.desactivee, false);
    // Une troisième méthode, catalogue plus large : la limite par étape la refuse avec sa phrase.
    const troisieme = buildEditor(entree({ historique: historiqueDe(deux), methodes: [...CATALOGUE, methode("boucle-ooda", "Boucle OODA")] }));
    const options = troisieme.ecran2?.blocs[0]?.etapes[0]?.methodes?.options ?? [];
    const refusee = options.find((option) => option.id === "boucle-ooda");
    assert.equal(refusee?.desactivee, true);
    assert.equal(refusee?.raison, C5.problemes.methodes.trop);
    assert.equal(refusee?.raison, "2 méthodes au maximum par étape.");
    // L'opération elle-même BORNE à 2 : une troisième n'est jamais écrite dans le déroulé.
    const trop = modifierMethodes(deux, premiere.id, ["cinq-pourquoi", "pre-mortem", "boucle-ooda"]);
    assert.equal(etapesDe(trop)[0]?.methodes?.length, FLOW_LIMITS.methodesParEtape);
  });

  it("aucune méthode au catalogue : la section n'est PAS rendue (jamais une section vide)", () => {
    const modele = buildEditor(entree({ historique: historiqueDe(brouillonDeForme("a-la-suite")), methodes: [] }));
    assert.equal(modele.ecran2?.blocs[0]?.etapes[0]?.methodes, null);
  });

  it("« Le résultat d'étapes choisies » : PRÉSENT en Avancé, ABSENT en Simple (U1, D-5-24)", () => {
    const draft = brouillonDeForme("a-la-suite");
    const [premiere, seconde] = etapesDe(draft);
    assert.ok(premiere && seconde);

    const avance = buildEditor(entree({ advanced: true, historique: historiqueDe(draft) }));
    const etape2 = avance.ecran2?.blocs[1]?.etapes[0];
    assert.ok(etape2?.recoit.etapes, "la seconde étape peut recevoir le résultat d'étapes plus haut");
    assert.equal(etape2.recoit.etapes.libelle, C5.editeur.recoitEtapes);
    assert.equal(etape2.recoit.etapes.libelle, "Le résultat d'étapes choisies");
    assert.equal(etape2.recoit.etapes.actif, false);
    assert.deepEqual(etape2.recoit.etapes.choix.map((choix) => choix.stepId), [premiere.id]);
    // La PREMIÈRE étape n'a aucune étape plus haut : aucun choix n'est proposé.
    assert.equal(avance.ecran2?.blocs[0]?.etapes[0]?.recoit.etapes, null);

    // Mode Simple, équipes OUVERTES (l'ouverture tient en une ligne) : le choix reste ABSENT, comme l'IA de l'étape.
    const simple = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, historique: historiqueDe(draft) }));
    for (const bloc of simple.ecran2?.blocs ?? []) {
      for (const etape of bloc.etapes) {
        assert.equal(etape.recoit.etapes, null, `lien proposé à l'étape ${etape.stepId} en Simple`);
        assert.equal(etape.ia, null);
      }
    }
    assert.equal(JSON.stringify(simple.ecran2).includes(C5.editeur.recoitEtapes), false);
  });

  it("lien posé : `recoit: {etapes}` écrit et coché ; une liste vide rend l'étape à sa valeur par défaut", () => {
    const draft = brouillonDeForme("a-la-suite");
    const [premiere, seconde] = etapesDe(draft);
    assert.ok(premiere && seconde);
    const lie = modifierRecoitEtapes(draft, seconde.id, [premiere.id]);
    assert.deepEqual(stepInputEtapes(etapesDe(lie)[1]?.recoit), [premiere.id]);
    assert.deepEqual(codesDe(lie.flow, "avance"), [], "un lien vers une étape plus haut est accepté en Avancé");
    assert.deepEqual(codesDe(lie.flow, "simple"), ["lien-avance"], "le même lien est un réglage du mode Avancé");
    const modele = buildEditor(entree({ historique: historiqueDe(lie) }));
    const lien = modele.ecran2?.blocs[1]?.etapes[0]?.recoit.etapes;
    assert.equal(lien?.actif, true);
    assert.equal(lien?.choix[0]?.cochee, true);
    const defait = modifierRecoitEtapes(lie, seconde.id, []);
    assert.equal(etapesDe(defait)[1]?.recoit, "precedent");
    assert.equal(modifierRecoitEtapes(defait, seconde.id, []), defait, "rien à défaire : aucun état écrit");
  });

  it("le RÉDACTEUR d'une relecture peut recevoir des étapes choisies ; le relecteur et les spécialistes, jamais", () => {
    const draft = ajouterBlocC5(brouillonDeForme("a-la-suite"), "relecture", 2);
    const modele = buildEditor(entree({ historique: historiqueDe(draft) }));
    const bloc = modele.ecran2?.blocs[2];
    assert.ok(bloc);
    assert.deepEqual(bloc.etapes.map((etape) => etape.role), ["redaction", "relecture"]);
    assert.ok(bloc.etapes[0]?.recoit.etapes, "le rédacteur a le choix, comme une étape");
    assert.equal(bloc.etapes[1]?.recoit.etapes, null, "le relecteur reçoit la version courante : aucun choix");
    const aiguillage = buildEditor(entree({ historique: historiqueDe(ajouterBlocC5(brouillonVide(), "aiguillage", 0)) }));
    for (const etape of aiguillage.ecran2?.blocs[0]?.etapes ?? []) assert.equal(etape.recoit.etapes, null);
  });
});

// --- Modèle des écrans ---------------------------------------------------------------------------------------------------------

describe("L42d : écran 1, menu [+ Ajouter] et cartes de blocs (§4.3)", () => {
  it("écran 1 : les DEUX formes de la 5b, activées, avec leur phrase d'aide reprise à l'octet", () => {
    const modele = buildEditor(entree({ ecran: 1 }));
    const ecran = modele.ecran1;
    assert.ok(ecran);
    assert.deepEqual(ecran.formes.map((forme) => forme.id), ["a-la-suite", "avis"], "les formes de l'it4 ne bougent pas");
    assert.deepEqual(
      ecran.formesC5.map((forme) => [forme.id, forme.titre, forme.aide, forme.precision]),
      [
        ["relecture", "Rédaction et relecture", "Un assistant rédige, un autre relit ; 2 tours au maximum.", "Un tour = une relecture, puis une correction si nécessaire."],
        ["aiguillage", "Aiguillage", "Un premier assistant propose le bon spécialiste dans une liste fixe ; vous confirmez son choix.", null],
      ],
    );
    // Chaque phrase vient bien de construction-texts.ts : aucune n'est réécrite ici.
    assert.equal(ecran.formesC5[0]?.aide, C5.formes.relecture.phrase);
    assert.equal(ecran.formesC5[1]?.aide, C5.formes.aiguillage.phrase);
    // Partir d'une forme de la 5b donne bien son bloc.
    assert.equal(brouillonDeForme("relecture").flow.blocs[0]?.type, "relecture");
    assert.equal(brouillonDeForme("aiguillage").flow.blocs[0]?.type, "aiguillage");
  });

  it("[+ Ajouter] : « Une rédaction et relecture » partout, « Un aiguillage » EN TÊTE SEULEMENT", () => {
    const modele = buildEditor(entree({ historique: historiqueDe(brouillonDeForme("a-la-suite")) }));
    const ecran = modele.ecran2;
    assert.ok(ecran);
    assert.deepEqual(ecran.ajouter.choix.map((choix) => choix.type), ["etape", "avis", "pause"], "le menu de l'it4 ne bouge pas");
    assert.equal(ecran.formes.length, ecran.blocs.length + 1, "une entrée par place d'insertion");
    assert.deepEqual(ecran.formes[0]?.choix.map((choix) => [choix.type, choix.libelle, choix.possible]), [
      ["relecture", "Une rédaction et relecture", true],
      ["aiguillage", "Un aiguillage", true],
    ]);
    for (const place of ecran.formes.slice(1)) {
      const parType = new Map(place.choix.map((choix) => [choix.type, choix.possible]));
      assert.equal(parType.get("relecture"), true, `« Une rédaction et relecture » devrait rester possible à la place ${place.place}`);
      assert.equal(parType.get("aiguillage"), false, `« Un aiguillage » ne peut pas être posé à la place ${place.place}`);
    }
    assert.equal(ecran.formes[1]?.choix.length, 2, "l'entrée impossible reste LISIBLE, jamais retirée en silence");
  });

  it("carte d'un bloc de relecture : rôles nommés, aide sur l'IA du relecteur, tours et case de vérification", () => {
    const draft = ajouterBlocC5(brouillonVide(), "relecture", 0);
    const modele = buildEditor(entree({ historique: historiqueDe(draft) }));
    const bloc = modele.ecran2?.blocs[0];
    assert.ok(bloc);
    assert.equal(bloc.titre, remplir(E.bloc, { n: 1, forme: E.blocs.relecture }));
    assert.equal(bloc.aide, C5.formes.relecture.phrase);
    assert.deepEqual(bloc.etapes.map((etape) => etape.roleLibelle), ["Rédacteur", "Relecteur"]);
    assert.equal(bloc.etapes[0]?.roleLibelle, C5.editeur.champs.redacteur);
    assert.equal(bloc.etapes[1]?.roleAide, C5.editeur.aide);
    assert.equal(bloc.etapes[1]?.roleAide, "Pour une relecture plus indépendante, donnez au relecteur une autre IA que le rédacteur.");
    assert.equal(bloc.etapes[0]?.roleAide, null, "l'aide porte sur l'IA du RELECTEUR");
    assert.equal(bloc.tours?.libelle, "Nombre de tours au maximum");
    assert.equal(bloc.tours?.aide, "Un tour = une relecture, puis une correction si nécessaire.");
    assert.deepEqual([...(bloc.tours?.choix ?? [])], [1, 2]);
    assert.equal(bloc.tours?.valeur, 1);
    assert.equal(bloc.pauseAvantRelecture?.libelle, "Me laisser vérifier le premier jet avant la relecture");
    assert.equal(bloc.pauseAvantRelecture?.valeur, false);
    assert.equal(bloc.choixMax, null);
    assert.equal(bloc.specialistes, null);
  });

  it("carte d'un bloc d'aiguillage : aiguilleur, groupe « Spécialistes », [Ajouter] et [Retirer], « au plus » 1 · 2", () => {
    const draft = ajouterBlocC5(brouillonVide(), "aiguillage", 0);
    const modele = buildEditor(entree({ historique: historiqueDe(draft) }));
    const bloc = modele.ecran2?.blocs[0];
    assert.ok(bloc);
    assert.equal(bloc.aide, C5.formes.aiguillage.phrase);
    assert.deepEqual(bloc.etapes.map((etape) => etape.role), ["aiguilleur", "specialiste", "specialiste"]);
    assert.equal(bloc.etapes[0]?.roleLibelle, "Aiguilleur");
    assert.equal(bloc.specialistes?.libelle, "Spécialistes");
    assert.equal(bloc.specialistes?.ajouter, "Ajouter un spécialiste");
    assert.equal(bloc.choixMax?.libelle, "Spécialistes à consulter au plus");
    assert.deepEqual([...(bloc.choixMax?.choix ?? [])], [1, 2]);
    // À 2 spécialistes, aucun retrait n'est proposé ; à 3, chacun porte son libellé de retrait.
    for (const etape of bloc.etapes) assert.equal(etape.retirer, null);
    const trois = buildEditor(entree({ historique: historiqueDe(ajouterSpecialiste(draft, bloc.blocId)) }));
    const blocTrois = trois.ecran2?.blocs[0];
    assert.equal(blocTrois?.etapes.filter((etape) => etape.retirer === "Retirer ce spécialiste").length, 3);
    assert.equal(blocTrois?.etapes[0]?.retirer, null, "l'aiguilleur ne se retire pas");
    // Synthèse posée avec « 2 au plus » : son formulaire porte le libellé « Synthèse ».
    const deux = buildEditor(entree({ historique: historiqueDe(modifierChoixMax(draft, bloc.blocId, 2)) }));
    assert.equal(deux.ecran2?.blocs[0]?.etapes.at(-1)?.roleLibelle, "Synthèse");
    assert.equal(deux.ecran2?.blocs[0]?.etapes.at(-1)?.role, "synthese");
  });

  it("problèmes de l'aperçu : posés sur le BLOC ou l'ÉTAPE fautifs, jamais ailleurs", () => {
    const draft = ajouterBlocC5(brouillonDeForme("a-la-suite"), "aiguillage", 0);
    const aiguillage = draft.flow.blocs[0];
    assert.ok(aiguillage && aiguillage.type === "aiguillage");
    const relecteur = aiguillage.specialistes[0];
    assert.ok(relecteur);
    const apercu = apercuDe([
      { code: "specialistes", bloc: aiguillage.id, etape: null, bloquant: true },
      { code: "meme-famille", bloc: aiguillage.id, etape: relecteur.id, bloquant: false },
    ]);
    const modele = buildEditor(entree({ historique: historiqueDe(draft), apercu }));
    const bloc = modele.ecran2?.blocs[0];
    assert.deepEqual(bloc?.problemes.map((probleme) => [probleme.code, probleme.texte, probleme.bloquant]), [
      ["specialistes", "Proposez de 2 à 8 spécialistes.", true],
    ]);
    const etape = bloc?.etapes.find((item) => item.stepId === relecteur.id);
    assert.deepEqual(etape?.problemes.map((probleme) => [probleme.code, probleme.texte, probleme.bloquant]), [
      ["meme-famille", "Rédacteur et relecteur utilisent la même famille d'IA : la relecture sera moins indépendante.", false],
    ]);
    assert.deepEqual(modele.ecran2?.blocs[1]?.problemes, [], "rien sur un bloc qui n'est pas en cause");
    assert.deepEqual(modele.problemes, [], "rien au niveau de l'équipe");
  });

  it("`synthese-requise` : la phrase de l'aiguillage sur un aiguillage, celle des avis sur un bloc d'avis", () => {
    // Un seul code, deux phrases, parce que ce qui manque n'est pas la même chose (§4.3 pour l'aiguillage, T4t pour les avis).
    // Sans la distinction, un aiguillage sans synthèse parlerait d'avis qu'il n'a pas : c'est ce que ce test empêche.
    const draft = ajouterBloc(ajouterBlocC5(brouillonVide(), "aiguillage", 0), "avis", 1);
    const aiguillage = draft.flow.blocs[0];
    const avis = draft.flow.blocs[1];
    assert.ok(aiguillage && aiguillage.type === "aiguillage");
    assert.ok(avis && avis.type === "avis");
    const apercu = apercuDe([
      { code: "synthese-requise", bloc: aiguillage.id, etape: null, bloquant: true },
      { code: "synthese-requise", bloc: avis.id, etape: null, bloquant: true },
    ]);
    const blocs = buildEditor(entree({ historique: historiqueDe(draft), apercu })).ecran2?.blocs ?? [];
    assert.equal(blocs[0]?.problemes[0]?.texte, "Avec 2 spécialistes possibles, ajoutez une étape de synthèse.");
    assert.equal(blocs[0]?.problemes[0]?.texte, C5.problemes["synthese-requise"], "phrase reprise de construction-texts.ts");
    assert.equal(blocs[1]?.problemes[0]?.texte, "Il manque la synthèse qui rassemble les avis.");
    assert.equal(blocs[1]?.problemes[0]?.texte, P.problemes["synthese-requise"], "les avis gardent la phrase de l'it4");
    // Le code, lui, est le même des deux côtés : rien n'est ajouté à FlowProblemCode (aucun type touché par L42d).
    assert.deepEqual(blocs.slice(0, 2).map((bloc) => bloc.problemes[0]?.code), ["synthese-requise", "synthese-requise"]);
  });

  it("les autres codes de la 5b gardent leur phrase unique, sur un bloc comme sur une étape", () => {
    const draft = ajouterBlocC5(brouillonVide(), "relecture", 0);
    const bloc = draft.flow.blocs[0];
    assert.ok(bloc && bloc.type === "relecture");
    const apercu = apercuDe([
      { code: "aiguillage-premier", bloc: bloc.id, etape: null, bloquant: true },
      { code: "relecteur-distinct", bloc: bloc.id, etape: bloc.relecteur.id, bloquant: true },
      { code: "lien-arriere", bloc: bloc.id, etape: bloc.auteur.id, bloquant: true },
      { code: "methodes", bloc: bloc.id, etape: bloc.auteur.id, bloquant: true },
    ]);
    const carte = buildEditor(entree({ historique: historiqueDe(draft), apercu })).ecran2?.blocs[0];
    assert.deepEqual(carte?.problemes.map((probleme) => probleme.texte), ["Un aiguillage ne peut être que le premier bloc."]);
    const auteur = carte?.etapes.find((etape) => etape.stepId === bloc.auteur.id);
    assert.deepEqual(auteur?.problemes.map((probleme) => probleme.texte), [
      "Une étape ne peut recevoir que le résultat d'étapes situées plus haut.",
      "2 méthodes au maximum par étape.",
    ]);
    const relecteur = carte?.etapes.find((etape) => etape.stepId === bloc.relecteur.id);
    assert.deepEqual(relecteur?.problemes.map((probleme) => probleme.texte), [
      "Le relecteur doit être un autre assistant, ou le même avec une autre IA.",
    ]);
  });
});

describe("L42d : écran « Coût et plafond » et bascule vers le schéma (§4.3, spéc. l.903)", () => {
  it("tableau du coût : les lignes des TOURS et des CHOIX suivent l'estimation, et rien quand la forme est absente", () => {
    const base = entree({ ecran: 3, historique: historiqueDe(ajouterBlocC5(brouillonVide(), "relecture", 0)) });
    const sans = buildEditor({ ...base, apercu: apercuDe() });
    assert.deepEqual([...(sans.ecran3?.repetitions ?? [])], [], "aucune estimation de répétition : aucune ligne");

    const avec = buildEditor({ ...base, apercu: apercuRepetitions({ tours: 2, specialistes: 0 }) });
    assert.deepEqual([...(avec.ecran3?.repetitions ?? [])], ["1 tour en général, 2 au plus"]);

    const deux = buildEditor({ ...base, apercu: apercuRepetitions({ tours: 2, specialistes: 2 }) });
    assert.deepEqual([...(deux.ecran3?.repetitions ?? [])], ["1 tour en général, 2 au plus", "1 spécialiste en général, 2 au plus"]);
    assert.equal(deux.ecran3?.repetitions[0], remplir(C5.execution.estimation.tours, { n: 2 }));
    assert.equal(deux.ecran3?.repetitions[1], remplir(C5.execution.estimation.specialistes, { n: 2 }));
    // Le tableau de l'itération 4 n'a pas bougé.
    assert.equal(deux.ecran3?.titre, E.cout.titre);
    assert.equal(deux.ecran3?.colonnes.length, 5);
  });

  it("bascule « Étapes | Schéma modifiable » : mode AVANCÉ seulement ; absente en Simple", () => {
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const avance = buildEditor(entree({ advanced: true, historique }));
    const vue = avance.ecran2?.vue;
    assert.ok(vue);
    assert.equal(vue.etapes, "Étapes");
    assert.equal(vue.schema, "Schéma modifiable");
    assert.equal(vue.phrase, "Même équipe, deux façons de la modifier. Le schéma n'accepte que ce que le cockpit sait exécuter.");
    assert.equal(vue.etapes, C5_SCHEMA.etapes);
    assert.equal(vue.schema, C5_SCHEMA.titre);
    assert.equal(vue.courant, "etapes", "les étapes d'abord : le schéma se demande");
    assert.equal(vue.etroit, null);

    const simple = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, historique }));
    assert.equal(simple.ecran2?.vue, null, "aucun schéma modifiable en Simple (réglage du mode Avancé)");
    assert.equal(JSON.stringify(simple.ecran2).includes(C5_SCHEMA.titre), false);
  });

  it("sous 900 px : la phrase du spéc. l.903 remplace le schéma, et seulement sur la vue « Schéma modifiable »", () => {
    assert.equal(SCHEMA_LARGEUR_MIN, 900);
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const large = buildEditor(entree({ advanced: true, historique, vue: "schema", etroit: false }));
    assert.equal(large.ecran2?.vue?.courant, "schema");
    assert.equal(large.ecran2?.vue?.etroit, null, "au-dessus de 900 px, le schéma est rendu");

    const etroit = buildEditor(entree({ advanced: true, historique, vue: "schema", etroit: true }));
    assert.equal(etroit.ecran2?.vue?.etroit, "Le schéma modifiable demande un écran plus large : utilisez les étapes.");
    assert.equal(etroit.ecran2?.vue?.etroit, C5_SCHEMA.etroit);

    const etapes = buildEditor(entree({ advanced: true, historique, vue: "etapes", etroit: true }));
    assert.equal(etapes.ecran2?.vue?.etroit, null, "sur la vue « Étapes », rien ne manque : aucune phrase");
  });

  it("mode Simple FERMÉ (U1) : aucun écran, aucun aperçu — et aucune valeur propre au mode Simple des équipes", () => {
    const ferme = buildEditor(entree({ advanced: false, ouvertesEnSimple: false, historique: historiqueDe(brouillonDeForme("relecture")) }));
    assert.equal(ferme.affichage, "ferme");
    assert.equal(ferme.apercuDemande, false, "aucune requête d'aperçu ne part");
    for (const ecran of [ferme.ecran1, ferme.ecran2, ferme.ecran3, ferme.ecran4]) assert.equal(ecran, null);
    // L'ouverture tient en UNE ligne : la même entrée avec `ouvertesEnSimple: true` monte l'éditeur, sans autre réglage.
    const ouvert = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, historique: historiqueDe(brouillonDeForme("relecture")) }));
    assert.equal(ouvert.affichage, "editeur");
    assert.ok(ouvert.ecran2);
    assert.equal(ouvert.ecran2.blocs[0]?.type, "relecture");
    assert.equal(ouvert.ecran2.formes.length, 2, "les formes de la 5b restent proposées en Simple ouvert");
  });
});

// --- Contrat statique des composants ---------------------------------------------------------------------------------------------

describe("L42d : composants (contrat statique)", () => {
  const schemaEditor = lire("SchemaEditor.tsx");
  const stepForm = lire("StepForm.tsx");
  const blockCard = lire("BlockCard.tsx");
  const teamEditor = lire("TeamEditor.tsx");
  // Source sans AUCUN commentaire : un commentaire qui cite une phrase ne doit jamais la faire passer pour écrite en dur.
  // Les commentaires de bloc (JSDoc et balises JSX comprises) sont retirés comme ceux de ligne.
  const sansCommentaires = (source: string) =>
    source
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((ligne) => !ligne.trim().startsWith("//"))
      .join("\n");

  it("SchemaEditor.tsx est un SQUELETTE, en tête « Propriétaire : L43 » : aucune opération de schéma", () => {
    assert.equal(schemaEditor.split("\n")[0], "// Propriétaire : L43.");
    const corps = sansCommentaires(schemaEditor);
    for (const operation of ["insertAfter", "moveUp", "moveDown", "addAvis", "removeAvis", "transform", "setRecoit", "dropCheck", "flow-schema-ops"]) {
      assert.equal(corps.includes(operation), false, `SchemaEditor ne doit implémenter aucune opération de schéma (${operation})`);
    }
    for (const glisser of ["onPointerDown", "onDragStart", "draggable"]) {
      assert.equal(corps.includes(glisser), false, `aucun glisser dans le squelette (${glisser})`);
    }
    assert.match(corps, /FlowSchema/, "le squelette occupe la place avec le schéma LU");
    assert.match(corps, /FlowList/, "la liste reste la vérité du lecteur d'écran");
  });

  it("aucun texte d'interface en dur : les phrases viennent du modèle pur", () => {
    for (const source of [schemaEditor, stepForm, blockCard, teamEditor]) {
      const corps = sansCommentaires(source);
      for (const phrase of [
        "Rédacteur",
        "Relecteur",
        "Aiguilleur",
        "Spécialistes",
        "Méthodes",
        "Schéma modifiable",
        "Le schéma modifiable demande un écran plus large",
        "Le résultat d'étapes choisies",
      ]) {
        assert.equal(corps.includes(phrase), false, `texte en dur : « ${phrase} »`);
      }
    }
  });

  it("TeamEditor : la phrase des écrans étroits remplace le schéma, la largeur vient du modèle", () => {
    const corps = sansCommentaires(teamEditor);
    assert.match(corps, /SCHEMA_LARGEUR_MIN/, "la largeur vient du modèle, jamais d'un nombre écrit dans le .tsx");
    assert.equal(/max-width:\s*900px/.test(corps), false, "aucun 900 écrit à la main");
    assert.match(corps, /vue\.etroit === null \? \(/, "la vue « Schéma modifiable » rend le schéma OU la phrase, jamais les deux");
    assert.match(corps, /<SchemaEditor/, "l'emplacement du schéma est bien monté");
    assert.match(corps, /getMethods/, "le catalogue des méthodes est lu, sans aucun appel d'IA");
  });

  it("BlockCard et StepForm : puces et cases refusées gardent le focus (aria-disabled), jamais l'attribut disabled", () => {
    for (const source of [blockCard, stepForm]) {
      assert.equal(/<button[^>]*\sdisabled/.test(source), false);
    }
    assert.match(stepForm, /aria-disabled=\{option\.desactivee\}/, "une méthode refusée reste focalisable, avec sa raison");
    assert.match(stepForm, /option\.raison/, "la raison est rendue à côté de la puce");
    assert.match(blockCard, /onRetirerSpecialiste/, "un spécialiste se retire par son opération propre");
  });

  it("aucun réglage propre au mode Simple des équipes n'est ajouté (U1, D-5-24)", () => {
    for (const source of [schemaEditor, stepForm, blockCard, teamEditor]) {
      const corps = sansCommentaires(source);
      assert.equal(/EQUIPES_SIMPLE[A-Z_]*\s*=/.test(corps), false, "aucune constante d'ouverture n'est posée ici");
    }
    // Le web ne lit qu'`ouvertesEnSimple` : l'ouverture tient en une ligne, dans wiring-eq.ts.
    assert.match(teamEditor, /ouvertesEnSimple/);
  });
});

// --- Bornes de saisie ----------------------------------------------------------------------------------------------------------

describe("L42d : bornes de saisie des étapes d'une forme de la 5b", () => {
  it("les champs d'un rédacteur, d'un relecteur et d'un spécialiste ont les mêmes bornes que ceux d'une étape", () => {
    const draft = ajouterBlocC5(ajouterBlocC5(brouillonVide(), "relecture", 0), "aiguillage", 0);
    const modele = buildEditor(entree({ historique: historiqueDe(draft) }));
    const etapes = (modele.ecran2?.blocs ?? []).flatMap((bloc) => bloc.etapes);
    assert.equal(etapes.length, 5, "aiguilleur, 2 spécialistes, rédacteur, relecteur");
    for (const etape of etapes) {
      assert.equal(etape.titre.max, TEAM_TEXT_LIMITS.titreEtape.max);
      assert.equal(etape.consigne.max, FLOW_LIMITS.consigne);
      assert.equal(etape.consigne.limite, E.champs.limiteSortie);
      assert.deepEqual(etape.taille.choix.map((choix) => choix.valeur), ["S", "M", "L"]);
    }
  });
});
