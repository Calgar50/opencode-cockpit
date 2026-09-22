// Tests de l'éditeur guidé d'une équipe (L40b ; spécification §5.3 l.894-902, §5.5, §5.6, §2.2 l.90 ; C §8.1, §9.11 ; plan
// d'exécution it4, fiche L40b, §2.6, D-eq-10 à D-eq-13, D-eq-24 ; décisions U1 et A11 Q3 et Q6).
// Le module pur (server/shared/flow-edit.ts) porte tout ce qui se teste : opérations sur le brouillon, bornes de FLOW_LIMITS
// (T4), identifiants stables, historique annuler / rétablir de 100 états, et le modèle des 4 écrans. L'interface n'étant pas
// exécutée par `npm test`, les composants et la feuille de style sont RELUS (contrat statique) : aucun texte en dur, aucune
// région aria-live nouvelle, raccourcis d'annulation bornés à l'éditeur, bloc `forced-colors` complet.
// MODE SIMPLE FERMÉ (U1) : tant que `ouvertesEnSimple` est faux, en Simple, l'éditeur n'est pas monté et AUCUN aperçu n'est
// demandé. L'ouverture tient en UNE ligne : les mêmes entrées avec `ouvertesEnSimple: true` rendent les 4 écrans, sans qu'aucune
// autre valeur n'entre en jeu — et sans aucun réglage d'IA par étape, de simultanéité ni de Réflexion en Simple (D-eq-12).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { RightLine } from "./shared/assistant-rules.ts";
import {
  ajouterAvis,
  ajouterBloc,
  annuler,
  appliquer,
  assistantsProposables,
  BLOCS_AJOUTABLES,
  brouillonDe,
  brouillonDeForme,
  brouillonVide,
  buildEditor,
  choixIaEtape,
  compterBlocsTravail,
  compterEtapes,
  corpsEnregistrement,
  descendre,
  dupliquerBloc,
  type EcranId,
  type EditHistory,
  type EditorAssistantView,
  type EditorInput,
  type EditorTier,
  type FlowDraft,
  FORMES_DEPART,
  HISTORIQUE_MAX,
  historiqueDe,
  identifiantEquipe,
  modifierEtape,
  modifierPause,
  monter,
  peutAjouterAvis,
  peutAjouterBloc,
  peutAnnuler,
  peutDupliquer,
  peutRetablir,
  peutRetirerAvis,
  progressionDe,
  raisonIndisponible,
  retablir,
  retirerAvis,
  supprimerBloc,
  TAILLE_PAR_DEFAUT,
} from "./shared/flow-edit.ts";
import { FLOW_LIMITS, FLOW_VERSION, receivedFrom, STEP_ID_RE, TEAM_ID_RE, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import { montant, refusEnregistrement, remplir, TEXTES } from "./shared/team-texts.ts";
import type { FlowBlock, FlowProblem, FlowStep, TeamExampleView, TeamPreviewResponse } from "./shared/team-types.ts";
import { exampleById } from "./team-examples.ts";

const P = TEXTES.partout;
const E = P.editeur;
const TEAMS_DIR = path.join(import.meta.dirname, "..", "web", "pages", "assistants", "teams");
const lire = (fichier: string) => fs.readFileSync(path.join(TEAMS_DIR, fichier), "utf8");

/** Source sans ses commentaires de ligne : un commentaire qui cite une règle ne doit jamais la faire passer pour tenue. */
const sansCommentaires = (source: string) =>
  source
    .split("\n")
    .filter((ligne) => !ligne.trim().startsWith("//"))
    .join("\n");

// --- Fixtures ---------------------------------------------------------------------------------------------------------------

const ligneDroit = (id: string, action: "allow" | "ask" | "deny"): RightLine => ({
  id,
  kind: action === "allow" ? "oui" : action === "ask" ? "demande" : "non",
  text: id,
  danger: false,
  permission: id,
  action,
});

/** Règles d'un assistant de lecture : rien de refusé qui empêche d'être une étape (D-eq-11). */
const LECTURE: RightLine[] = [
  ligneDroit("lecture", "allow"),
  ligneDroit("modification", "deny"),
  ligneDroit("commande", "deny"),
  ligneDroit("internet", "deny"),
  ligneDroit("delegation", "deny"),
  ligneDroit("hors-dossier", "deny"),
];

/** Règles de lecture dont UNE ligne change : la ligne remplacée, jamais ajoutée (la première lue est la bonne). */
const avec = (id: string, action: "allow" | "ask" | "deny"): RightLine[] => LECTURE.map((ligne) => (ligne.id === id ? ligneDroit(id, action) : ligne));

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

function apercuDe(problems: FlowProblem[] = [], over: Partial<TeamPreviewResponse> = {}): TeamPreviewResponse {
  return {
    problems,
    estimate: {
      typique: 0.6,
      maximum: 1.25,
      plafond: 1.25,
      etapesFacturees: 2,
      depassementUnAppel: 0.08,
      relais: 0.02,
      parEtape: [
        {
          stepId: "e2",
          titre: "Standards",
          assistant: "relire-script",
          model: "gpt-5.5",
          modelLabel: "GPT-5.5",
          niveau: null,
          choisieParEquipe: false,
          typique: 0.3,
          maximum: 0.6,
          source: "profil",
        },
      ],
    },
    droits: LECTURE,
    layout: [],
    liste: ["Étape 1 : Standards"],
    ...over,
  };
}

const probleme = (over: Partial<FlowProblem> = {}): FlowProblem => ({ code: "titre", bloc: null, etape: null, bloquant: true, ...over });

function entree(over: Partial<EditorInput> = {}): EditorInput {
  return {
    mode: "nouvelle",
    advanced: true,
    ouvertesEnSimple: false,
    ecran: 1,
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
    ...over,
  };
}

/** Étapes déclarées d'un brouillon, dans l'ordre d'écriture. */
function etapesDe(draft: FlowDraft): FlowStep[] {
  return draft.flow.blocs.flatMap((bloc: FlowBlock) => {
    if (bloc.type === "etape") return [bloc.etape];
    if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
    return [];
  });
}

const identifiants = (draft: FlowDraft): string[] => [...draft.flow.blocs.map((bloc) => bloc.id), ...etapesDe(draft).map((step) => step.id)];

// --- Brouillon : opérations -------------------------------------------------------------------------------------------------

describe("éditeur guidé : brouillon et opérations (fiche L40b, C §5.1, D-eq-10)", () => {
  it("brouillon vide : aucun bloc, version du déroulé posée", () => {
    const vide = brouillonVide();
    assert.equal(vide.flow.version, FLOW_VERSION);
    assert.deepEqual(vide.flow.blocs, []);
    assert.equal(compterEtapes(vide.flow), 0);
    assert.equal(compterBlocsTravail(vide.flow), 0);
  });

  it("genres ajoutables : « etape », « avis » et « pause » seulement (aucune « relecture », aucun « aiguillage »)", () => {
    assert.deepEqual([...BLOCS_AJOUTABLES], ["etape", "avis", "pause"]);
    assert.deepEqual([...FORMES_DEPART], ["a-la-suite", "avis"]);
    // Un genre hors de la liste fermée ne pose rien : le brouillon est rendu tel quel.
    const draft = brouillonVide();
    assert.equal(ajouterBloc(draft, "relecture" as FlowBlock["type"], 0), draft);
  });

  it("ajouter une étape : valeurs par défaut de C §5.1 (titre vide, IA de l'assistant, taille M, consigne vide)", () => {
    const draft = ajouterBloc(brouillonVide(), "etape", 0);
    const [bloc] = draft.flow.blocs;
    assert.equal(bloc?.type, "etape");
    const etape = etapesDe(draft)[0];
    assert.equal(etape?.titre, "");
    assert.equal(etape?.assistant, "");
    assert.equal(etape?.niveau, null);
    assert.equal(etape?.taille, TAILLE_PAR_DEFAUT);
    assert.equal(etape?.consigne, "");
    // Le premier bloc de travail part de la demande (C §5.1).
    assert.equal(etape?.recoit, "demande");
    for (const id of identifiants(draft)) assert.match(id, STEP_ID_RE);
  });

  it("ajouter des avis : 2 avis qui reçoivent la demande (indépendance) et une synthèse qui reçoit tout", () => {
    const draft = ajouterBloc(brouillonVide(), "avis", 0);
    const [bloc] = draft.flow.blocs;
    assert.equal(bloc?.type, "avis");
    if (bloc?.type !== "avis") return;
    assert.equal(bloc.avis.length, FLOW_LIMITS.avisMin);
    for (const avis of bloc.avis) assert.equal(avis.recoit, "demande");
    assert.equal(bloc.synthese.recoit, "tous");
    // Seule la synthèse part avec son titre de rôle, repris de team-texts.ts.
    assert.equal(bloc.synthese.titre, E.synthese);
    assert.equal(bloc.avis[0]?.titre, "");
    // Clé JSON « avis », jamais « regards » (D-eq-10).
    assert.ok(Object.hasOwn(bloc, "avis"));
    assert.equal(Object.hasOwn(bloc, "regards"), false);
  });

  it("ajouter une pause : message vide, aucune étape ; le bloc de travail suivant reçoit le précédent", () => {
    let draft = ajouterBloc(brouillonVide(), "etape", 0);
    draft = ajouterBloc(draft, "etape", 1);
    draft = ajouterBloc(draft, "pause", 1);
    assert.deepEqual(draft.flow.blocs.map((bloc) => bloc.type), ["etape", "pause", "etape"]);
    assert.equal(compterEtapes(draft.flow), 2);
    assert.equal(compterBlocsTravail(draft.flow), 2);
    const [premiere, seconde] = etapesDe(draft);
    assert.equal(premiere?.recoit, "demande");
    assert.equal(seconde?.recoit, "precedent");
  });

  it("ajouter ou retirer un avis : bornes 2 à 5 (FLOW_LIMITS)", () => {
    let draft = ajouterBloc(brouillonVide(), "avis", 0);
    const blocId = draft.flow.blocs[0]?.id ?? "";
    assert.equal(peutRetirerAvis(draft, blocId), false);
    const inchange = retirerAvis(draft, blocId, etapesDe(draft)[0]?.id ?? "");
    assert.equal(inchange, draft, "retirer sous la borne basse ne change rien");
    for (let n = FLOW_LIMITS.avisMin; n < FLOW_LIMITS.avisMax; n++) {
      assert.equal(peutAjouterAvis(draft, blocId), true);
      draft = ajouterAvis(draft, blocId);
    }
    const bloc = draft.flow.blocs[0];
    assert.equal(bloc?.type === "avis" ? bloc.avis.length : 0, FLOW_LIMITS.avisMax);
    assert.equal(peutAjouterAvis(draft, blocId), false);
    assert.equal(ajouterAvis(draft, blocId), draft, "un sixième avis est refusé");
    // Retrait : l'avis visé part, les autres gardent leur identifiant.
    const avant = bloc?.type === "avis" ? bloc.avis.map((step) => step.id) : [];
    const apres = retirerAvis(draft, blocId, avant[1] ?? "");
    const restants = apres.flow.blocs[0];
    assert.deepEqual(
      restants?.type === "avis" ? restants.avis.map((step) => step.id) : [],
      avant.filter((id) => id !== avant[1]),
    );
  });

  it("borne des blocs de travail : 5 au plus, les pauses ne comptent pas", () => {
    let draft = brouillonVide();
    for (let n = 0; n < FLOW_LIMITS.blocsTravail; n++) draft = ajouterBloc(draft, "etape", n);
    assert.equal(compterBlocsTravail(draft.flow), FLOW_LIMITS.blocsTravail);
    assert.equal(peutAjouterBloc(draft, "etape"), false);
    assert.equal(ajouterBloc(draft, "etape", 0), draft);
    // Une pause reste permise : elle n'est pas un bloc de travail.
    assert.equal(peutAjouterBloc(draft, "pause"), true);
    assert.equal(ajouterBloc(draft, "pause", 1).flow.blocs.length, FLOW_LIMITS.blocsTravail + 1);
  });

  it("borne des étapes : 12 au plus, avis et synthèses comprises", () => {
    let draft = brouillonVide();
    // 3 blocs d'avis à 3 avis : 3 × (3 + 1) = 12 étapes, 3 blocs de travail.
    for (let n = 0; n < 3; n++) {
      draft = ajouterBloc(draft, "avis", n);
      draft = ajouterAvis(draft, draft.flow.blocs[n]?.id ?? "");
    }
    assert.equal(compterEtapes(draft.flow), FLOW_LIMITS.etapes);
    assert.equal(peutAjouterBloc(draft, "etape"), false, "une étape de plus dépasserait 12");
    assert.equal(peutAjouterAvis(draft, draft.flow.blocs[0]?.id ?? ""), false);
    assert.equal(peutDupliquer(draft, draft.flow.blocs[0]?.id ?? ""), false);
  });

  it("monter, descendre et supprimer : ordre changé, identifiants STABLES, entrées recalculées", () => {
    let draft = ajouterBloc(ajouterBloc(brouillonVide(), "etape", 0), "etape", 1);
    const [premier, second] = draft.flow.blocs.map((bloc) => bloc.id);
    const avant = identifiants(draft);

    draft = descendre(draft, premier ?? "");
    assert.deepEqual(draft.flow.blocs.map((bloc) => bloc.id), [second, premier]);
    assert.deepEqual([...identifiants(draft)].sort(), [...avant].sort(), "aucun identifiant n'est recréé");
    // L'étape désormais en tête reçoit la demande, l'autre le bloc précédent.
    const [tete, suite] = etapesDe(draft);
    assert.equal(tete?.recoit, "demande");
    assert.equal(suite?.recoit, "precedent");

    draft = monter(draft, premier ?? "");
    assert.deepEqual(draft.flow.blocs.map((bloc) => bloc.id), [premier, second]);
    // Au bord : rien ne bouge, et le même objet est rendu (aucun état d'historique écrit).
    assert.equal(monter(draft, premier ?? ""), draft);
    assert.equal(descendre(draft, second ?? ""), draft);
    assert.equal(monter(draft, "inconnu"), draft);

    draft = supprimerBloc(draft, premier ?? "");
    assert.deepEqual(draft.flow.blocs.map((bloc) => bloc.id), [second]);
    assert.equal(etapesDe(draft)[0]?.recoit, "demande", "le bloc restant devient le premier bloc de travail");
    assert.equal(supprimerBloc(draft, "inconnu"), draft);
  });

  it("« tous » d'un bloc « etape » est GARDÉ par l'édition : l'exemple « Chaîne de relecture de script » n'est pas dégradé", () => {
    // La grammaire (flow.ts) laisse le choix à un bloc « etape » qui n'est pas le premier : `attendu` y vaut null. L'éditeur ne
    // répare donc que ce qui est devenu ILLÉGAL pour la place, jamais une valeur légitime choisie par l'équipe.
    const exemple = exampleById("relecture-script");
    assert.ok(exemple, "l'exemple « Chaîne de relecture de script » (A11, Q3 (a)) est au catalogue");
    const attendu = ["standards", "securite", "exploitation-nuit"];
    const consolidation = (courant: FlowDraft) => etapesDe(courant).find((step) => step.id === "consolidation");

    let draft = brouillonDe(exemple.flow);
    assert.equal(consolidation(draft)?.recoit, "tous", "le déroulé livré porte bien « tous » sur la consolidation");
    assert.deepEqual(receivedFrom(draft.flow, "consolidation"), attendu);

    // Première opération d'édition : une simple frappe dans un titre.
    draft = modifierEtape(draft, "standards", { titre: "Standards maison" }, { simple: false });
    assert.equal(consolidation(draft)?.recoit, "tous", "une frappe ne doit pas changer ce que la consolidation reçoit");
    assert.deepEqual(receivedFrom(draft.flow, "consolidation"), attendu);

    // Déplacement, ajout puis suppression : la valeur légitime tient à travers toutes les opérations.
    draft = monter(draft, "securite");
    assert.equal(consolidation(draft)?.recoit, "tous");
    draft = ajouterBloc(draft, "etape", 1);
    assert.equal(consolidation(draft)?.recoit, "tous");
    draft = supprimerBloc(draft, draft.flow.blocs[1]?.id ?? "");
    assert.equal(consolidation(draft)?.recoit, "tous");
    assert.deepEqual(receivedFrom(draft.flow, "consolidation"), attendu);
  });

  it("`recoit` devenu ILLÉGAL pour la place est réparé : « demande » hors de la tête, « demande » rendue à la tête", () => {
    const flow = {
      version: FLOW_VERSION,
      blocs: [
        { type: "etape", id: "b1", etape: { id: "e1", titre: "Un", assistant: "relire-script", niveau: null, taille: "M", consigne: "", recoit: "demande" } },
        { type: "etape", id: "b2", etape: { id: "e2", titre: "Deux", assistant: "relire-script", niveau: null, taille: "M", consigne: "", recoit: "tous" } },
      ],
    } as const;
    // Le bloc « tous » remonté en tête : « demande » est la seule valeur que la grammaire accepte à cette place.
    const remonte = monter(brouillonDe({ version: flow.version, blocs: [...flow.blocs] }), "b2");
    assert.equal(etapesDe(remonte).find((step) => step.id === "e2")?.recoit, "demande");
    // Et le bloc « demande » descendu passe à « precedent ».
    assert.equal(etapesDe(remonte).find((step) => step.id === "e1")?.recoit, "precedent");
  });

  it("dupliquer : copie posée après l'original, identifiants NEUFS pour la copie, originaux gardés", () => {
    const base = ajouterBloc(brouillonVide(), "avis", 0);
    const blocId = base.flow.blocs[0]?.id ?? "";
    const avant = identifiants(base);
    const draft = dupliquerBloc(base, blocId);
    assert.equal(draft.flow.blocs.length, 2);
    assert.equal(draft.flow.blocs[0]?.id, blocId, "l'original garde son identifiant");
    const copie = draft.flow.blocs[1];
    assert.notEqual(copie?.id, blocId);
    const neufs = identifiants(draft).filter((id) => !avant.includes(id));
    assert.equal(neufs.length, avant.length, "chaque élément copié a un identifiant neuf");
    assert.equal(new Set(identifiants(draft)).size, identifiants(draft).length, "aucun doublon");
    for (const id of identifiants(draft)) assert.match(id, STEP_ID_RE);
    assert.equal(dupliquerBloc(draft, "inconnu"), draft);
  });

  it("un identifiant supprimé n'est jamais réattribué (le compteur ne redescend pas)", () => {
    let draft = ajouterBloc(brouillonVide(), "etape", 0);
    const premier = identifiants(draft);
    draft = supprimerBloc(draft, draft.flow.blocs[0]?.id ?? "");
    draft = ajouterBloc(draft, "etape", 0);
    for (const id of identifiants(draft)) assert.equal(premier.includes(id), false, id);
  });

  it("brouillon repris d'un déroulé : identifiants gardés, aucun heurt avec les identifiants neufs", () => {
    const flow = {
      version: FLOW_VERSION,
      blocs: [{ type: "etape", id: "b7", etape: { id: "e9", titre: "Lire", assistant: "relire-script", niveau: null, taille: "M", consigne: "", recoit: "demande" } }],
    } as const;
    let draft = brouillonDe({ version: flow.version, blocs: [...flow.blocs] });
    assert.deepEqual(identifiants(draft), ["b7", "e9"]);
    draft = ajouterBloc(draft, "etape", 1);
    assert.equal(new Set(identifiants(draft)).size, identifiants(draft).length);
    // Un déroulé venu d'un exemple, avec des identifiants parlants, ne heurte rien non plus.
    const exemple = brouillonDe({
      version: FLOW_VERSION,
      blocs: [{ type: "etape", id: "standards", etape: { id: "securite", titre: "Sécurité", assistant: "relire-script", niveau: null, taille: "M", consigne: "", recoit: "demande" } }],
    });
    const suite = ajouterBloc(exemple, "etape", 1);
    assert.equal(new Set(identifiants(suite)).size, identifiants(suite).length);
  });

  it("formes de départ : « À la suite » = deux étapes, « Avis indépendants » = un bloc d'avis", () => {
    const suite = brouillonDeForme("a-la-suite");
    assert.deepEqual(suite.flow.blocs.map((bloc) => bloc.type), ["etape", "etape"]);
    const avis = brouillonDeForme("avis");
    assert.deepEqual(avis.flow.blocs.map((bloc) => bloc.type), ["avis"]);
    assert.equal(compterEtapes(avis.flow), FLOW_LIMITS.avisMin + 1);
  });

  it("modifier une étape : titre borné à 60, consigne bornée à 4 000, taille contrôlée", () => {
    const draft = ajouterBloc(brouillonVide(), "etape", 0);
    const stepId = etapesDe(draft)[0]?.id ?? "";
    const modifie = modifierEtape(
      draft,
      stepId,
      { titre: "T".repeat(200), consigne: "C".repeat(FLOW_LIMITS.consigne + 500), assistant: "relire-script", taille: "L" },
      { simple: false },
    );
    const etape = etapesDe(modifie)[0];
    assert.equal(etape?.titre.length, TEAM_TEXT_LIMITS.titreEtape.max);
    assert.equal(etape?.consigne.length, FLOW_LIMITS.consigne);
    assert.equal(etape?.assistant, "relire-script");
    assert.equal(etape?.taille, "L");
    // Taille hors de la liste fermée : ignorée.
    assert.equal(etapesDe(modifierEtape(modifie, stepId, { taille: "XL" as "L" }, { simple: false }))[0]?.taille, "L");
    assert.equal(modifierEtape(draft, "inconnue", { titre: "x" }, { simple: false }), draft);
  });

  it("un patch qui ne change RIEN rend le brouillon tel quel : aucun état d'historique identique au précédent", () => {
    const depart = historiqueDe(ajouterBloc(brouillonVide(), "etape", 0));
    const stepId = etapesDe(depart.present)[0]?.id ?? "";
    const plein = "T".repeat(TEAM_TEXT_LIMITS.titreEtape.max);
    // 60 caractères : un état. Les frappes suivantes sont tronquées au MÊME titre : plus aucun état (le champ n'a pas de
    // maxLength avant la correction, donc ces frappes arrivent bien jusqu'ici).
    let historique = appliquer(depart, (draft) => modifierEtape(draft, stepId, { titre: plein }, { simple: false }));
    assert.equal(historique.passe.length, 1);
    for (let n = 1; n <= 5; n++) {
      historique = appliquer(historique, (draft) => modifierEtape(draft, stepId, { titre: `${plein}${"X".repeat(n)}` }, { simple: false }));
    }
    assert.equal(historique.passe.length, 1, "cinq frappes au-delà de la borne n'empilent aucun état");
    assert.equal(etapesDe(historique.present)[0]?.titre, plein);
    // Même règle pour les autres champs, et pour le message d'une pause.
    assert.equal(modifierEtape(historique.present, stepId, { titre: plein, taille: "M", consigne: "" }, { simple: false }), historique.present);
    let pause = historiqueDe(ajouterBloc(brouillonDeForme("a-la-suite"), "pause", 1));
    const pauseId = pause.present.flow.blocs[1]?.id ?? "";
    pause = appliquer(pause, (draft) => modifierPause(draft, pauseId, "Relire avant la suite."));
    assert.equal(pause.passe.length, 1);
    assert.equal(appliquer(pause, (draft) => modifierPause(draft, pauseId, "Relire avant la suite.")).passe.length, 1);
  });

  it("IA de l'étape : posée en Avancé, IGNORÉE en Simple (décision n° 3, D-eq-12)", () => {
    const draft = ajouterBloc(brouillonVide(), "etape", 0);
    const stepId = etapesDe(draft)[0]?.id ?? "";
    assert.equal(etapesDe(modifierEtape(draft, stepId, { niveau: "expert" }, { simple: false }))[0]?.niveau, "expert");
    assert.equal(etapesDe(modifierEtape(draft, stepId, { niveau: "expert" }, { simple: true }))[0]?.niveau, null);
  });

  it("message d'une pause : borné à 300 caractères ; un bloc qui n'est pas une pause n'est pas touché", () => {
    let draft = ajouterBloc(ajouterBloc(brouillonVide(), "etape", 0), "etape", 1);
    draft = ajouterBloc(draft, "pause", 1);
    const pauseId = draft.flow.blocs[1]?.id ?? "";
    const modifie = modifierPause(draft, pauseId, "V".repeat(TEAM_TEXT_LIMITS.messagePause + 100));
    const bloc = modifie.flow.blocs[1];
    assert.equal(bloc?.type === "pause" ? bloc.message.length : 0, TEAM_TEXT_LIMITS.messagePause);
    assert.equal(modifierPause(draft, draft.flow.blocs[0]?.id ?? "", "x"), draft);
  });

  it("corps d'enregistrement : titre ébarbé et borné, description bornée, déroulé tel quel", () => {
    const draft = brouillonDeForme("a-la-suite");
    const corps = corpsEnregistrement({ titre: `  ${"N".repeat(200)}  `, description: "D".repeat(500), draft });
    assert.equal(corps.titre.length, TEAM_TEXT_LIMITS.titreEquipe.max);
    assert.equal(corps.description.length, TEAM_TEXT_LIMITS.description);
    assert.equal(corps.flow, draft.flow);
  });

  it("identifiant d'une équipe neuve : tiré du nom, suffixé quand il est pris, toujours conforme à TEAM_ID_RE", () => {
    assert.equal(identifiantEquipe("Revue SQL sur réplica", []), "revue-sql-sur-replica");
    assert.equal(identifiantEquipe("Revue SQL", ["revue-sql"]), "revue-sql-2");
    assert.equal(identifiantEquipe("Revue SQL", ["revue-sql", "revue-sql-2"]), "revue-sql-3");
    assert.equal(identifiantEquipe("🙂", []), "equipe");
    for (const titre of ["N".repeat(120), "Équipe de relecture de scripts d'exploitation de nuit", "   "]) {
      assert.match(identifiantEquipe(titre, ["n".repeat(40)]), TEAM_ID_RE);
    }
  });
});

// --- Historique -------------------------------------------------------------------------------------------------------------

describe("éditeur guidé : annuler et rétablir (100 états)", () => {
  it("une opération qui ne change rien n'écrit AUCUN état", () => {
    const historique = historiqueDe(brouillonVide());
    assert.equal(peutAnnuler(historique), false);
    assert.equal(peutRetablir(historique), false);
    const inchange = appliquer(historique, (draft) => monter(draft, "inconnu"));
    assert.equal(inchange, historique);
    assert.equal(peutAnnuler(inchange), false);
  });

  it("annuler puis rétablir rend exactement l'état précédent, puis le suivant", () => {
    const depart = historiqueDe(brouillonVide());
    const un = appliquer(depart, (draft) => ajouterBloc(draft, "etape", 0));
    const deux = appliquer(un, (draft) => ajouterBloc(draft, "avis", 1));
    assert.equal(deux.present.flow.blocs.length, 2);

    const revenu = annuler(deux);
    assert.equal(revenu.present, un.present);
    assert.equal(peutRetablir(revenu), true);
    const refait = retablir(revenu);
    assert.equal(refait.present, deux.present);
    assert.equal(peutRetablir(refait), false);

    // Une modification après une annulation oublie le futur.
    const autre = appliquer(revenu, (draft) => ajouterBloc(draft, "pause", 1));
    assert.equal(peutRetablir(autre), false);
    // Au bout de l'historique, rien ne bouge.
    assert.equal(annuler(depart), depart);
    assert.equal(retablir(depart), depart);
  });

  it("100 états gardés : la 100e annulation rend le premier état gardé, jamais un état oublié", () => {
    assert.equal(HISTORIQUE_MAX, 100);
    let historique: EditHistory = historiqueDe(brouillonVide());
    const etats: FlowDraft[] = [historique.present];
    // 150 modifications : la consigne d'une étape change à chaque fois (aucune borne atteinte).
    const base = appliquer(historique, (draft) => ajouterBloc(draft, "etape", 0));
    historique = base;
    etats.push(base.present);
    const stepId = etapesDe(base.present)[0]?.id ?? "";
    for (let n = 0; n < 150; n++) {
      historique = appliquer(historique, (draft) => modifierEtape(draft, stepId, { consigne: `consigne ${n}` }, { simple: false }));
      etats.push(historique.present);
    }
    assert.equal(historique.passe.length, HISTORIQUE_MAX - 1);
    let remonte: EditHistory = historique;
    for (let n = 0; n < HISTORIQUE_MAX - 1; n++) remonte = annuler(remonte);
    assert.equal(peutAnnuler(remonte), false, "les états au-delà de 100 sont oubliés");
    assert.equal(remonte.present, etats[etats.length - HISTORIQUE_MAX]);
    // Puis tout rétablir ramène au dernier état.
    let redescend: EditHistory = remonte;
    for (let n = 0; n < HISTORIQUE_MAX - 1; n++) redescend = retablir(redescend);
    assert.equal(redescend.present, historique.present);
  });
});

// --- Assistants et IA de l'étape --------------------------------------------------------------------------------------------

describe("éditeur guidé : assistants proposables (D-eq-11, D-eq-12)", () => {
  it("un assistant proposable n'a aucune raison ; chaque refus a la phrase courte de T4t", () => {
    assert.equal(raisonIndisponible(assistant(), { simple: false }), null);
    const cas: Array<[Partial<EditorAssistantView>, string]> = [
      [{ hidden: true }, E.indisponibles["assistant-interne"]],
      [{ mode: "subagent" }, E.indisponibles["assistant-non-proposable"]],
      [{ rights: "propose" }, E.indisponibles["propose-reporte"]],
      [{ rightLines: avec("delegation", "ask") }, E.indisponibles.delegue],
      [{ rightLines: avec("internet", "allow") }, E.indisponibles.internet],
      [{ rightLines: avec("modification", "allow") }, E.indisponibles["autorise-sans-demander"]],
      [{ rightLines: avec("commande", "allow") }, E.indisponibles["autorise-sans-demander"]],
      [{ rightLines: avec("hors-dossier", "allow") }, E.indisponibles["autorise-sans-demander"]],
    ];
    for (const [over, phrase] of cas) assert.equal(raisonIndisponible(assistant(over), { simple: false }), phrase, JSON.stringify(over));
    // « Personnalisé » : refusé en Simple seulement (D-eq-11).
    assert.equal(raisonIndisponible(assistant({ rights: "personnalise" }), { simple: true }), E.indisponibles.personnalise);
    assert.equal(raisonIndisponible(assistant({ rights: "personnalise" }), { simple: false }), null);
    // Sans IA propre : en Avancé, la grammaire l'accepte dès qu'une « IA de l'étape » est choisie (D-eq-12, flow.ts), et l'aperçu
    // pose le problème sur l'étape tant qu'aucune ne l'est. L'éditeur ne ferme donc pas ce montage — mais il le ferme en Simple,
    // où aucun niveau ne peut être choisi.
    assert.equal(raisonIndisponible(assistant({ modelName: null }), { simple: false }), null);
    assert.equal(raisonIndisponible(assistant({ modelName: null }), { simple: true }), E.indisponibles["niveau-indisponible"]);
  });

  it("liste des assistants : un seul groupe « Mes assistants », les indisponibles désactivés avec leur raison", () => {
    const groupes = assistantsProposables([assistant(), assistant({ name: "propose", rights: "propose" })], { simple: false });
    assert.equal(groupes.length, 1);
    assert.equal(groupes[0]?.titre, E.champs.mesAssistants);
    assert.deepEqual(groupes[0]?.options.map((option) => [option.nom, option.desactivee, option.raison]), [
      ["relire-script", false, null],
      ["propose", true, E.indisponibles["propose-reporte"]],
    ]);
    assert.deepEqual(assistantsProposables([], { simple: false }), []);
    // Un assistant sans IA propre reste CHOISISSABLE en Avancé, et seulement là.
    const sansIa = [assistant({ name: "sans-ia", modelName: null })];
    assert.equal(assistantsProposables(sansIa, { simple: false })[0]?.options[0]?.desactivee, false);
    assert.equal(assistantsProposables(sansIa, { simple: true })[0]?.options[0]?.desactivee, true);
  });

  it("choix d'« IA de l'étape » : l'IA de l'assistant d'abord, puis un niveau par ligne avec « ≈ X $ »", () => {
    const draft = ajouterBloc(brouillonVide(), "etape", 0);
    const etape = etapesDe(draft)[0];
    assert.ok(etape);
    const choix = choixIaEtape(etape, NIVEAUX, "GPT-5.5");
    assert.equal(choix[0]?.valeur, null);
    assert.equal(choix[0]?.libelle, remplir(TEXTES.avance.editeurIa.assistant, { ia: "GPT-5.5" }));
    assert.equal(choix[1]?.libelle, remplir(TEXTES.avance.editeurIa.niveau, { niveau: "Rapide", cout: 0.03 }));
    // Niveau indisponible : l'option reste lisible, désactivée ; un prix inconnu écrit « — », jamais un chiffre inventé.
    const expert = choix.find((option) => option.valeur === "expert");
    assert.equal(expert?.desactive, true);
    assert.ok(expert?.libelle.includes(montant(Number.NaN)));
  });
});

// --- Modèle des 4 écrans ----------------------------------------------------------------------------------------------------

describe("éditeur guidé : Simple fermé, ouverture en une ligne (U1, D-eq-13, plan §2.6)", () => {
  it("rien de lu : l'éditeur attend, sans jamais demander d'aperçu", () => {
    const modele = buildEditor(entree({ ouvertesEnSimple: null, chargement: true }));
    assert.equal(modele.affichage, "chargement");
    assert.equal(modele.apercuDemande, false);
    assert.equal(modele.ecran1, null);
    assert.equal(modele.progression, null);
  });

  it("Simple fermé : l'éditeur N'EST PAS monté, aucun aperçu n'est demandé, le texte du §2.6 et le retour sont là", () => {
    // Brouillon NON vide : sans cela, l'aperçu ne serait pas demandé de toute façon et le contrôle serait sans portée.
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    assert.equal(buildEditor(entree({ advanced: false, ouvertesEnSimple: true, ecran: 2, historique })).apercuDemande, true);
    const modele = buildEditor(entree({ advanced: false, ouvertesEnSimple: false, ecran: 2, historique }));
    assert.equal(modele.affichage, "ferme");
    assert.equal(modele.ferme?.texte, TEXTES.simple.fermees);
    assert.equal(modele.retour, E.retourEquipes);
    assert.equal(modele.apercuDemande, false, "aucune requête d'aperçu tant que les équipes sont fermées en Simple");
    for (const ecran of [modele.ecran1, modele.ecran2, modele.ecran3, modele.ecran4]) assert.equal(ecran, null);
    assert.equal(modele.progression, null);
  });

  it("ouverture en UNE ligne : la même entrée avec ouvertesEnSimple vrai monte les 4 écrans", () => {
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    for (const ecran of [1, 2, 3, 4] as EcranId[]) {
      const modele = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, ecran, historique, apercu: apercuDe() }));
      assert.equal(modele.affichage, "editeur", `écran ${ecran}`);
      assert.equal(modele.apercuDemande, true);
      assert.equal(modele.ferme, null);
      const monte = [modele.ecran1, modele.ecran2, modele.ecran3, modele.ecran4].filter((valeur) => valeur !== null);
      assert.equal(monte.length, 1, "un seul écran monté à la fois");
    }
  });

  it("brouillon vide : aucun aperçu demandé (l'écran de départ ne demande rien)", () => {
    const vide = buildEditor(entree({ ecran: 1, historique: historiqueDe(brouillonVide()) }));
    assert.equal(vide.affichage, "editeur");
    assert.equal(vide.apercuDemande, false);
    const pose = buildEditor(entree({ ecran: 2, historique: historiqueDe(brouillonDeForme("avis")) }));
    assert.equal(pose.apercuDemande, true);
  });

  it("mode Avancé : l'éditeur est monté même quand les équipes sont fermées en Simple", () => {
    const modele = buildEditor(entree({ advanced: true, ouvertesEnSimple: false, historique: historiqueDe(brouillonDeForme("a-la-suite")) }));
    assert.equal(modele.affichage, "editeur");
    assert.equal(modele.apercuDemande, true);
  });
});

describe("éditeur guidé : progression et écrans (spécification §2.2 l.90, §5.3)", () => {
  it("progression : « 2 / 4 · Les étapes », aria-label « Progression » (jamais « Étape »)", () => {
    const progression = progressionDe(2);
    assert.equal(progression.libelle, E.progressionLibelle);
    assert.equal(progression.libelle, "Progression");
    assert.equal(progression.texte, remplir(E.progression, { n: 2, ecran: E.ecrans.etapes }));
    assert.equal(progression.texte, "2 / 4 · Les étapes");
    assert.equal(progression.libelle.includes(P.etape), false);
    assert.deepEqual([...progression.ecrans], [E.ecrans.depart, E.ecrans.etapes, E.ecrans.cout, E.ecrans.verifier]);
    assert.equal(progressionDe(1).texte, remplir(E.progression, { n: 1, ecran: E.ecrans.depart }));
  });

  it("écran 1 : exemples et les DEUX formes de l'itération 4 (ni « Rédaction et relecture », ni « Aiguillage »)", () => {
    const modele = buildEditor(entree({ ecran: 1 }));
    const ecran = modele.ecran1;
    assert.ok(ecran);
    assert.equal(ecran.partirExemple, E.partirExemple);
    assert.equal(ecran.partirForme, E.partirForme);
    assert.deepEqual(ecran.exemples.map((exemple) => exemple.id), ["revue-sql"]);
    assert.deepEqual(ecran.formes.map((forme) => [forme.id, forme.titre, forme.aide]), [
      ["a-la-suite", P.formes["a-la-suite"], P.aidesFormes["a-la-suite"]],
      ["avis", P.formes.avis, P.aidesFormes.avis],
    ]);
    assert.equal(modele.precedent, null, "aucun [Précédent] sur le premier écran");
    assert.equal(modele.suivant, E.suivant);
    assert.equal(modele.schemaACote, false);
  });

  it("écran 2 : cartes de blocs, commandes, menu d'ajout et historique ; schéma dessiné à côté", () => {
    const historique = historiqueDe(brouillonDeForme("avis"));
    const modele = buildEditor(entree({ ecran: 2, historique }));
    const ecran = modele.ecran2;
    assert.ok(ecran);
    assert.equal(modele.schemaACote, true);
    assert.equal(ecran.blocs.length, 1);
    const bloc = ecran.blocs[0];
    assert.equal(bloc?.titre, remplir(E.bloc, { n: 1, forme: E.blocs.avis }));
    assert.equal(bloc?.aide, P.honnetete.avis);
    assert.equal(bloc?.monter.libelle, E.monter);
    assert.equal(bloc?.monter.possible, false, "un bloc seul ne monte pas");
    assert.equal(bloc?.descendre.possible, false);
    assert.equal(bloc?.supprimer, E.supprimer);
    assert.equal(bloc?.ajouterAvis, E.ajouterAvis);
    assert.deepEqual(ecran.ajouter.choix.map((choix) => choix.type), ["etape", "avis", "pause"]);
    assert.equal(ecran.ajouter.libelle, E.ajouter);
    assert.equal(ecran.annuler.libelle, E.annulerModif);
    assert.equal(ecran.annuler.possible, false);
    assert.equal(ecran.retablir.possible, false);
    // Rôles : les avis, puis la synthèse ; seule la synthèse ne se retire pas.
    assert.deepEqual(bloc?.etapes.map((etape) => etape.role), ["avis", "avis", "synthese"]);
    assert.equal(bloc?.etapes.at(-1)?.retirer, null);
    // Deux avis : le retrait n'est pas proposé tant que la borne basse est atteinte.
    assert.equal(bloc?.etapes[0]?.retirer, null);
  });

  it("écran 2 : le formulaire d'étape reprend les textes de T4t, dont la limite de sortie (Q6, option a)", () => {
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const modele = buildEditor(entree({ ecran: 2, historique }));
    const etape = modele.ecran2?.blocs[0]?.etapes[0];
    assert.ok(etape);
    assert.equal(etape.titre.libelle, E.champs.titre);
    assert.equal(etape.titre.max, TEAM_TEXT_LIMITS.titreEtape.max, "la borne du champ vient du modèle, jamais d'un nombre écrit dans le .tsx");
    assert.equal(etape.assistant.libelle, E.champs.assistant);
    assert.equal(etape.consigne.libelle, E.champs.consigne);
    assert.equal(etape.consigne.max, FLOW_LIMITS.consigne);
    assert.equal(etape.consigne.limite, E.champs.limiteSortie);
    assert.equal(etape.consigne.limite, "Une étape ne relit pas une sortie trop longue : demandez-lui de chercher plus précisément.");
    assert.equal(etape.recoit.libelle, E.champs.recoit);
    assert.equal(etape.recoit.texte, E.champs.recoitChoix.demande);
    assert.deepEqual(etape.taille.choix.map((choix) => choix.valeur), ["S", "M", "L"]);
  });

  it("écran 2, mode SIMPLE : aucune « IA de l'étape », aucun réglage de simultanéité ni de Réflexion (D-eq-12)", () => {
    const historique = historiqueDe(brouillonDeForme("avis"));
    const simple = buildEditor(entree({ advanced: false, ouvertesEnSimple: true, ecran: 2, historique }));
    const blocs = simple.ecran2?.blocs ?? [];
    assert.ok(blocs.length > 0);
    for (const bloc of blocs) {
      for (const etape of bloc.etapes) assert.equal(etape.ia, null, `IA proposée à l'étape ${etape.stepId} en Simple`);
    }
    const champs = JSON.stringify(simple.ecran2);
    for (const interdit of ["simultan", "Réflexion", "reflexion", "concurrentSteps"]) {
      assert.equal(champs.includes(interdit), false, interdit);
    }
    // Mode Avancé : « IA de l'étape » est là, avec son libellé et son aide.
    const avance = buildEditor(entree({ advanced: true, ecran: 2, historique }));
    const ia = avance.ecran2?.blocs[0]?.etapes[0]?.ia;
    assert.equal(ia?.libelle, TEXTES.avance.editeurIa.libelle);
    assert.equal(ia?.aide, TEXTES.avance.editeurIa.aide);
    assert.equal(ia?.valeur, null);
    assert.ok((ia?.choix.length ?? 0) > 1);
  });

  it("écran 2 : les problèmes de l'aperçu sont posés sur LEUR bloc et LEUR étape, jamais ailleurs", () => {
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const draft = historique.present;
    const blocId = draft.flow.blocs[0]?.id ?? "";
    const stepId = etapesDe(draft)[0]?.id ?? "";
    const apercu = apercuDe([
      probleme({ code: "titre", bloc: blocId, etape: stepId }),
      probleme({ code: "pause-mal-placee", bloc: blocId, etape: null }),
      probleme({ code: "trop-d-etapes", bloc: null, etape: null }),
      probleme({ code: "inconnu-du-cockpit" as FlowProblem["code"], bloc: null, etape: null }),
    ]);
    const modele = buildEditor(entree({ ecran: 2, historique, apercu }));
    const bloc = modele.ecran2?.blocs[0];
    assert.deepEqual(bloc?.problemes.map((p) => p.code), ["pause-mal-placee"]);
    assert.deepEqual(bloc?.etapes[0]?.problemes.map((p) => p.texte), [P.problemes.titre]);
    // L'étape de l'autre bloc ne reprend rien : un problème ne migre jamais d'une étape à l'autre.
    assert.deepEqual(modele.ecran2?.blocs[1]?.etapes[0]?.problemes, []);
    assert.deepEqual(modele.ecran2?.blocs[1]?.problemes, []);
    // Problèmes de l'équipe entière : à part, et un code sans phrase est ignoré plutôt qu'affiché muet.
    assert.deepEqual(modele.problemes.map((p) => p.code), ["trop-d-etapes"]);
  });

  it("écran 3 : tableau par étape, total et phrase du plafond appliquée par un arrêt", () => {
    const modele = buildEditor(entree({ ecran: 3, apercu: apercuDe() }));
    const ecran = modele.ecran3;
    assert.ok(ecran);
    assert.equal(modele.schemaACote, true);
    assert.deepEqual([...ecran.colonnes], [E.cout.colonneEtape, E.cout.colonneAssistant, E.cout.colonneIa, E.cout.colonneEnGeneral, E.cout.colonneEstimationHaute]);
    assert.deepEqual(ecran.lignes.map((ligne) => [ligne.etape, ligne.ia, ligne.typique, ligne.maximum]), [["Standards", "GPT-5.5", "0,30 $", "0,60 $"]]);
    assert.equal(ecran.total, remplir(E.cout.total, { typique: 0.6, maximum: 1.25 }));
    assert.equal(ecran.arret, E.cout.arret);
    assert.equal(
      ecran.arret,
      "Le cockpit arrête l'équipe si le coût atteint le montant « au plus ». Le dernier appel d'IA en cours peut le dépasser un peu.",
    );
    // Sans aperçu : aucune ligne, aucun total inventé.
    const sansEstimation = buildEditor(entree({ ecran: 3, apercu: apercuDe([], { estimate: null }) }));
    assert.deepEqual(sansEstimation.ecran3?.lignes, []);
    assert.equal(sansEstimation.ecran3?.total, null);
  });

  it("écran 4 : nom, « Quand l'utiliser », liste, droits, contrôle et décision, confidentialité ; AUCUNE case contractuelle", () => {
    const historique = historiqueDe(brouillonDeForme("a-la-suite"));
    const modele = buildEditor(entree({ ecran: 4, historique, titre: "Relecture de script", apercu: apercuDe(), liste: ["local"] }));
    const ecran = modele.ecran4;
    assert.ok(ecran);
    assert.equal(modele.schemaACote, false, "l'écran 4 montre la vue liste, pas un second schéma");
    assert.equal(ecran.nom.libelle, E.verifier.nom);
    assert.equal(ecran.nom.min, TEAM_TEXT_LIMITS.titreEquipe.min);
    assert.equal(ecran.nom.max, TEAM_TEXT_LIMITS.titreEquipe.max);
    assert.equal(ecran.quand.libelle, E.verifier.quand);
    assert.deepEqual([...ecran.liste], ["Étape 1 : Standards"], "la liste du serveur passe devant la liste locale");
    assert.equal(ecran.droits.titre, E.verifier.droits);
    assert.deepEqual(ecran.droits.lignes, LECTURE);
    assert.equal(ecran.controle.texte, E.verifier.controleTexte);
    assert.equal(ecran.decide.texte, E.verifier.decideTexte);
    assert.equal(ecran.confidentialite, E.verifier.confidentialite);
    assert.deepEqual([...ecran.honnetete], [P.honnetete.etapes, P.honnetete.cles, P.honnetete.lecture]);
    assert.equal(ecran.enregistrer, E.verifier.enregistrer);
    assert.equal(modele.suivant, null, "aucun [Suivant] sur le dernier écran");
    assert.equal(modele.precedent, E.precedent);
    // Aucune case à cocher contractuelle : le modèle n'en porte aucune.
    const texte = JSON.stringify(ecran).toLowerCase();
    for (const interdit of ["case", "cocher", "jeconfirme", "confirme que"]) assert.equal(texte.includes(interdit), false, interdit);
  });

  it("écran 4 : liste locale tant que l'aperçu n'est pas rendu", () => {
    const modele = buildEditor(entree({ ecran: 4, apercu: null, liste: ["Étape 1 : Standards · relire-script"] }));
    assert.deepEqual([...(modele.ecran4?.liste ?? [])], ["Étape 1 : Standards · relire-script"]);
  });

  it("enregistrement : refusé sans aperçu, sur un problème bloquant ou sur un nom trop court ou déjà pris", () => {
    const base = { ecran: 4 as EcranId, historique: historiqueDe(brouillonDeForme("a-la-suite")) };
    assert.equal(buildEditor(entree({ ...base, titre: "Relecture", apercu: null })).ecran4?.enregistrable, false);

    const bon = buildEditor(entree({ ...base, titre: "Relecture", apercu: apercuDe() })).ecran4;
    assert.equal(bon?.enregistrable, true);
    assert.equal(bon?.nom.erreur, null);
    assert.equal(bon?.refus, null);

    const court = buildEditor(entree({ ...base, titre: "ab", apercu: apercuDe() })).ecran4;
    assert.equal(court?.enregistrable, false);
    assert.equal(court?.nom.erreur, E.verifier.nomCourt);

    const pris = buildEditor(entree({ ...base, titre: " relecture ", nomsPris: ["Relecture"], apercu: apercuDe() })).ecran4;
    assert.equal(pris?.enregistrable, false);
    assert.equal(pris?.nom.erreur, E.verifier.nomPris);

    const problemes = [probleme({ code: "vide" }), probleme({ code: "titre", bloquant: false })];
    const invalide = buildEditor(entree({ ...base, titre: "Relecture", apercu: apercuDe(problemes) })).ecran4;
    assert.equal(invalide?.enregistrable, false);
    assert.equal(invalide?.refus, refusEnregistrement(1));
  });

  it("écran 4 d'un brouillon VIDE : le refus est EXPLIQUÉ près du bouton, jamais un bouton désactivé muet", () => {
    // Aucun bloc : aucun aperçu n'est demandé, donc aucun problème du serveur n'arrive. Sans phrase, le bouton serait désactivé
    // sans que rien, nulle part, ne dise pourquoi.
    const modele = buildEditor(entree({ ecran: 4, historique: historiqueDe(brouillonVide()), titre: "Relecture de script", apercu: null }));
    assert.equal(modele.apercuDemande, false);
    assert.equal(modele.ecran4?.enregistrable, false);
    assert.equal(modele.ecran4?.nom.erreur, null, "le nom est bon : rien d'autre n'expliquerait le refus");
    assert.deepEqual(modele.problemes, [], "aucun problème de l'équipe entière ne vient du serveur");
    assert.equal(modele.ecran4?.refus, P.problemes.vide);
  });

  it("titre de la page et confirmation de départ", () => {
    assert.equal(buildEditor(entree({ mode: "nouvelle" })).titre, E.titreNouvelle);
    assert.equal(buildEditor(entree({ mode: "modifier", titre: "Revue SQL" })).titre, remplir(E.titreModifier, { titre: "Revue SQL" }));
    const quitter = buildEditor(entree()).quitter;
    assert.equal(quitter.titre, E.quitter.titre);
    assert.equal(quitter.titre, "Quitter sans enregistrer l'équipe ?");
    assert.equal(quitter.rester, E.quitter.rester);
    assert.equal(quitter.quitter, E.quitter.quitter);
  });

  it("une lecture qui a échoué garde sa phrase, sans jamais monter un éditeur vide", () => {
    const attente = buildEditor(entree({ ouvertesEnSimple: null, chargement: false, erreur: "Lecture impossible." }));
    assert.equal(attente.affichage, "chargement");
    assert.equal(attente.erreur, "Lecture impossible.");
    const monte = buildEditor(entree({ erreur: "Aperçu impossible." }));
    assert.equal(monte.affichage, "editeur");
    assert.equal(monte.erreur, "Aperçu impossible.");
  });
});

// --- Contrat statique de l'interface ------------------------------------------------------------------------------------------

describe("éditeur guidé : composants et feuille de style (contrat statique)", () => {
  const editeur = sansCommentaires(lire("TeamEditor.tsx"));
  const stepForm = sansCommentaires(lire("StepForm.tsx"));
  const blockCard = sansCommentaires(lire("BlockCard.tsx"));
  const css = lire("editor.css");

  it("aucun texte d'interface en dur : tout vient du modèle pur, donc de team-texts.ts", () => {
    for (const [nom, source] of [
      ["TeamEditor.tsx", editeur],
      ["StepForm.tsx", stepForm],
      ["BlockCard.tsx", blockCard],
    ] as const) {
      // Une chaîne littérale d'interface se reconnaît à une lettre accentuée ou à deux mots séparés par une espace.
      for (const [, valeur] of source.matchAll(/"([^"\\\n]{3,})"/g)) {
        const texte = valeur ?? "";
        const phrase = /[éèêàçùîôûœ]/i.test(texte) || /^[A-Z][a-zéèêà]+ [a-zéèêà]/.test(texte);
        assert.equal(phrase, false, `${nom} : texte en dur « ${texte} »`);
      }
      // Texte écrit directement entre deux balises (hors accolades), qui échapperait au contrôle des chaînes.
      for (const [, valeur] of source.matchAll(/>([^<>{}\n]{3,})</g)) {
        assert.equal(/[éèêàçùîôûœ]/i.test(valeur ?? ""), false, `${nom} : texte en dur entre balises « ${valeur} »`);
      }
    }
  });

  it("progression : aria-label du modèle (jamais « Étape » écrit à la main) et écran courant marqué", () => {
    assert.match(editeur, /aria-label=\{progression\.libelle\}/);
    assert.match(editeur, /aria-current=\{courant \? "step" : undefined\}/);
    assert.equal(/aria-label="Étape/.test(editeur), false);
  });

  it("aucune région aria-live nouvelle : les annonces passent par l'annonceur de la page", () => {
    assert.equal(editeur.includes("aria-live"), false);
    assert.match(editeur, /useAnnouncer\(ui\.activityAnnouncements\)/);
  });

  it("annuler et rétablir : Ctrl+Z et Ctrl+Maj+Z posés SUR l'éditeur, jamais sur la fenêtre", () => {
    assert.match(editeur, /onKeyDown=\{auClavier\}/);
    assert.match(editeur, /event\.ctrlKey \|\| event\.metaKey/);
    assert.match(editeur, /event\.shiftKey/);
    // Aucun écouteur global de clavier : seule la fermeture de l'onglet en pose un.
    for (const [, evenement] of editeur.matchAll(/addEventListener\("(\w+)"/g)) {
      assert.equal(["keydown", "keyup", "keypress"].includes(evenement ?? ""), false, evenement);
    }
  });

  it("aperçu : 300 ms après la dernière modification, et jamais quand l'éditeur n'est pas monté", () => {
    assert.match(editeur, /const APERCU_MS = 300;/);
    assert.match(editeur, /if \(!apercuDemande\) return;/);
    assert.match(editeur, /setTimeout\([\s\S]{0,400}teamsApi\.preview/);
  });

  it("aperçu réussi : la phrase d'un aperçu refusé est EFFACÉE (jamais un refus annoncé qui n'est plus vrai)", () => {
    assert.match(editeur, /await teamsApi\.preview\(corps\);[\s\S]{0,200}setErreur\(null\);/);
  });

  it("Ctrl+Z dans un champ de saisie : l'annulation du texte reste au navigateur, le déroulé n'est pas rembobiné", () => {
    // La garde sort AVANT le preventDefault : sinon l'annulation native du texte serait supprimée dans tous les cas.
    const debut = editeur.indexOf("const auClavier =");
    assert.notEqual(debut, -1, "auClavier introuvable");
    const corps = editeur.slice(debut, editeur.indexOf("\n  };", debut));
    const garde = corps.search(/closest\("input, textarea, select"\)/);
    const empeche = corps.search(/event\.preventDefault\(\)/);
    assert.notEqual(garde, -1, "aucune garde sur les champs de saisie dans auClavier");
    assert.notEqual(empeche, -1, "contrôle discriminant : auClavier empêche bien le comportement par défaut");
    assert.ok(garde < empeche, "la garde doit précéder event.preventDefault()");
  });

  it("titre d'étape : la borne de saisie vient du modèle, comme la consigne et le message de pause", () => {
    assert.match(stepForm, /maxLength=\{etape\.titre\.max\}/);
    assert.match(stepForm, /maxLength=\{etape\.consigne\.max\}/);
  });

  it("schéma dessiné à côté par layoutFlow, liste par flowAsList (importés directement)", () => {
    assert.match(editeur, /import \{ flowAsList, layoutFlow \} from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/flow-layout\.ts";/);
    assert.match(editeur, /modele\.schemaACote \?/);
  });

  it("boutons impossibles : aria-disabled, jamais l'attribut disabled (le focus et la raison restent)", () => {
    for (const source of [editeur, blockCard]) {
      assert.match(source, /aria-disabled=/);
      assert.equal(/<button[^>]*\sdisabled/.test(source), false);
    }
    // Une option d'assistant désactivée reste dans la liste, avec sa raison.
    assert.match(stepForm, /disabled=\{option\.desactivee\}/);
    assert.match(stepForm, /option\.raison === null \? option\.libelle : /);
  });

  it("aucune animation : mouvement seulement sous prefers-reduced-motion: no-preference", () => {
    assert.equal(/animation\s*:/.test(css), false);
    /** Accolades encore ouvertes dans un morceau de feuille (> 0 : on est toujours dans le bloc). */
    const ouvertes = (texte: string) => texte.split("{").length - texte.split("}").length;
    const mouvements = [...css.matchAll(/transition\s*:/g)];
    assert.ok(mouvements.length > 0, "contrôle discriminant : la feuille porte au moins une transition à situer");
    for (const mouvement of mouvements) {
      const avant = css.slice(0, mouvement.index ?? 0);
      const requete = avant.lastIndexOf("@media (prefers-reduced-motion: no-preference)");
      assert.notEqual(requete, -1, "transition hors de prefers-reduced-motion: no-preference");
      assert.ok(ouvertes(avant.slice(requete)) > 0, "transition écrite après la fin du bloc prefers-reduced-motion");
    }
  });

  it("contraste forcé (U9) : cartes et problèmes bordés, progression soulignée, focus Highlight, connecteurs CanvasText", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    assert.notEqual(css.indexOf("@media (forced-colors: active)"), -1);
    for (const attendu of [
      ".tm-ed-bloc",
      ".tm-ed-probleme",
      "border: 1px solid CanvasText",
      "text-decoration: underline",
      "outline: 2px solid Highlight",
      "stroke: CanvasText",
    ]) {
      assert.ok(forced.includes(attendu), attendu);
    }
  });

  it("sous 900 px : une seule colonne ; le schéma n'est à côté qu'au-dessus (§5.6)", () => {
    assert.match(css, /@media \(min-width: 901px\) \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 320px\);/);
    assert.match(css, /\.tm-ed-corps \{[\s\S]*grid-template-columns: 1fr;/);
  });
});
