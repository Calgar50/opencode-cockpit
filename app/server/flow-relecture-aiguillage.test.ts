// Relecture et aiguillage, liens entre étapes et méthodes des étapes (itération 5b, plan d'exécution it5 fiche L42a ;
// spécification §3.13 l.411, §5.3 l.903, §6 l.1049 ; conception C §3.1, §5.1, §5.2, §5.4, §5.5, §6.2, §6.3, §6.4, §6.7, §13,
// §17.1 ; D-5-13, D-5-14 confirmée par la mesure MC5-2, D-5-20).
//
// Ce que ces tests tiennent :
// - la GRAMMAIRE : un cas par règle neuve et par mode, `lien-arriere`, `lien-avis`, `lien-avance`, `methodes` (3, inconnue,
//   « seconde-lecture » qui n'est pas une méthode de consigne, déjà appliquée par l'assistant) ;
// - la NON-RÉGRESSION de l'itération 4 : un déroulé sans `methodes` ni `recoit: {etapes}` garde les mêmes problèmes, la même
//   estimation, le même message d'étape et le même ordre de `planSteps` qu'avant ;
// - l'ORDONNANCEUR : relecture en 1 et 2 tours avec la révision finale, relecteur toujours « À REPRENDRE » → 5 appels au plus
//   pour 2 tours, verdict illisible, pause avant relecture ; aiguillage à 1 et 2 choix, « aucun », choix illisible, synthèse
//   sautée à un seul choix ; aucun spécialiste ne part avant la confirmation ;
// - les CHIFFRES de l'estimation sur une table de prix FIXE, relais comptés selon `recoit.etapes`, et la propriété « au plus
//   couvre le chemin maximal » sur 200 déroulés tirés au hasard (graine fixe) ;
// - la LECTURE du verdict et du choix : dernière ligne seulement, liste fermée ;
// - les LIVRABLES, la DISPOSITION et la liste accessible ;
// - les TRANSITIONS neuves et la PURETÉ des deux modules de contrats.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import type { ModelPrice } from "./pricing.ts";
import { type Rule, type TaskSize, type Tier, type UiMode } from "./shared/assistant-rules.ts";
import { TEXTES as CONSTRUCTION_TEXTES } from "./shared/construction-texts.ts";
import {
  deliverable,
  DELIVERABLE_TEXTS,
  type FlowAction,
  type FlowMethodsContext,
  type FlowState,
  type FlowValidationContext,
  METHODE_HEADER,
  nextActions,
  readChoice,
  readVerdict,
  STEP_SECTIONS,
  STEP_TEXTS,
  stepMessage,
  type StepMessageContext,
  tourKey,
  validateFlow,
} from "./shared/flow.ts";
import { estimateFlow, type FlowEstimateContext, type StepIa } from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow } from "./shared/flow-layout.ts";
import { canTransition, FLOW_LIMITS, planSteps, receivedFrom, TEAM_RUN_TRANSITIONS, TEAM_STEP_TRANSITIONS } from "./shared/team-limits.ts";
import { TEXTES as TEAM_TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowBlock, FlowProblemCode, FlowStep, StepAssistant, StepInput, TeamStepState } from "./shared/team-types.ts";

// --- Montages -------------------------------------------------------------------------------------------------------------------

const REGLES_LECTURE: Rule[] = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
];

function assistant(name: string, model: string | null = "github-copilot/gpt-5-mini"): StepAssistant {
  return {
    name,
    title: `Titre de ${name}`,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: REGLES_LECTURE,
    model,
    available: true,
    steps: 12,
    taille: "M",
  };
}

const REDACTEUR = assistant("rediger-note");
const RELECTEUR = assistant("relecteur-critique", "github-copilot/claude-sonnet-5");
const AIGUILLEUR = assistant("aiguilleur");
const SPECIALISTE = assistant("relire-script");
const ASSISTANTS = [REDACTEUR, RELECTEUR, AIGUILLEUR, SPECIALISTE];

const step = (id: string, over: Partial<FlowStep> = {}): FlowStep => ({
  id,
  titre: `Étape ${id}`,
  assistant: REDACTEUR.name,
  niveau: null,
  taille: "S",
  consigne: `Consigne de ${id}`,
  recoit: "demande",
  ...over,
});

const flowOf = (...blocs: FlowBlock[]): Flow => ({ version: 1, blocs });

const etapeBloc = (id: string, over: Partial<FlowStep> = {}): FlowBlock => ({ type: "etape", id: `b-${id}`, etape: step(id, over) });

/** Bloc « relecture » : l'auteur part de la demande, le relecteur reçoit implicitement sa version courante. */
function relecture(over: Partial<Extract<FlowBlock, { type: "relecture" }>> = {}): Extract<FlowBlock, { type: "relecture" }> {
  return {
    type: "relecture",
    id: "b-relecture",
    auteur: step("auteur", { assistant: REDACTEUR.name, titre: "Rédaction" }),
    relecteur: step("relecteur", { assistant: RELECTEUR.name, titre: "Relecture", recoit: "precedent" }),
    toursMax: 2,
    pauseAvantRelecture: false,
    ...over,
  };
}

/** Bloc « aiguillage » : l'aiguilleur part de la demande, les spécialistes reçoivent sa raison, la synthèse les résultats. */
function aiguillage(over: Partial<Extract<FlowBlock, { type: "aiguillage" }>> = {}): Extract<FlowBlock, { type: "aiguillage" }> {
  return {
    type: "aiguillage",
    id: "b-aiguillage",
    aiguilleur: step("aiguilleur", { assistant: AIGUILLEUR.name, titre: "Aiguillage" }),
    specialistes: [
      step("sql", { assistant: SPECIALISTE.name, titre: "Requête SQL" }),
      step("script", { assistant: SPECIALISTE.name, titre: "Script" }),
      step("reseau", { assistant: SPECIALISTE.name, titre: "Réseau" }),
    ],
    choixMax: 2,
    synthese: step("synthese", { assistant: REDACTEUR.name, titre: "Synthèse", recoit: "tous" }),
    repli: "assistant-general",
    ...over,
  };
}

const methodes = (consigne: string[], parAssistant: Record<string, string[]> = {}): FlowMethodsContext => ({
  consigne: new Set(consigne),
  parAssistant: (nom: string) => new Set(parAssistant[nom] ?? []),
});

const ctx = (mode: UiMode, over: Partial<FlowValidationContext> = {}): FlowValidationContext => ({
  assistants: ASSISTANTS,
  mode,
  niveauDisponible: () => true,
  ...over,
});

const codes = (flow: Flow, c: FlowValidationContext): FlowProblemCode[] => validateFlow(flow, c).map((p) => p.code);

/** Le même code dans les deux modes : une règle « both » de C §5.2 ne dépend jamais du mode. */
function dansLesDeuxModes(flow: Flow, code: FlowProblemCode, over: Partial<FlowValidationContext> = {}): void {
  for (const mode of ["simple", "avance"] as UiMode[]) {
    assert.ok(codes(flow, ctx(mode, over)).includes(code), `${code} attendu en mode ${mode}`);
  }
}

const etats = (entries: Record<string, TeamStepState>): FlowState => ({ etapes: entries });

const messageCtx = (over: Partial<StepMessageContext> = {}): StepMessageContext => ({
  runId: "run-1",
  tour: 1,
  tentative: 1,
  equipe: "Équipe d'essai",
  total: 3,
  n: 1,
  demande: "Relis ce script.",
  fichiers: [],
  precisions: [],
  resultats: [],
  ...over,
});

// --- 1. Types et textes repris par valeur ---------------------------------------------------------------------------------------

describe("L42a · textes repris par valeur de la construction", () => {
  it("« ## Méthode : {titre} » et les phrases du livrable sont celles de construction-texts.ts, à l'octet", () => {
    const C = CONSTRUCTION_TEXTES.partout;
    assert.equal(METHODE_HEADER, C.liens.enTeteMethode);
    assert.equal(DELIVERABLE_TEXTS.journal, C.execution.relecture.journal);
    assert.equal(DELIVERABLE_TEXTS.tour, C.execution.relecture.tour);
    assert.equal(DELIVERABLE_TEXTS.aReprendre, C.execution.relecture.aReprendre);
    assert.equal(DELIVERABLE_TEXTS.rienAReprendre, C.execution.relecture.rienAReprendre);
    assert.equal(DELIVERABLE_TEXTS.verdictIllisible, C.execution.relecture.verdictIllisible);
    assert.equal(DELIVERABLE_TEXTS.nonRelue, C.execution.relecture.nonRelue);
    assert.equal(DELIVERABLE_TEXTS.nonConclue, C.execution.relecture.nonConclue);
    assert.equal(DELIVERABLE_TEXTS.aucun, C.execution.aucun.phrase);
    assert.equal(DELIVERABLE_TEXTS.aucunRepli, C.execution.aucun.repli);
  });

  it("les phrases des codes ajoutés sont dans team-texts.ts (croisement de V0 de l'it4), reprises à l'octet de la construction", () => {
    const T = TEAM_TEXTES.partout;
    const C = CONSTRUCTION_TEXTES.partout;
    assert.equal(T.problemes["aiguillage-premier"], C.problemes["aiguillage-premier"]);
    assert.equal(T.problemes.specialistes, C.problemes.specialistes);
    assert.equal(T.problemes["relecteur-distinct"], C.problemes["relecteur-distinct"]);
    assert.equal(T.problemes["meme-famille"], C.problemes["meme-famille"]);
    assert.equal(T.problemes["lien-arriere"], C.problemes["lien-arriere"]);
    assert.equal(T.problemes["lien-avis"], C.problemes["lien-avis"]);
    assert.equal(T.problemes["lien-avance"], C.problemes["lien-avance"]);
    assert.equal(T.problemes.methodes, C.problemes.methodes.trop);
    assert.equal(T.etatsEtape["non-choisi"], C.execution.etat.nonChoisi);
    assert.equal(T.pauses.choix.titre, C.execution.choix.titre);
    assert.equal(T.editeur.blocs.relecture, C.editeur.menu.relecture);
    assert.equal(T.editeur.blocs.aiguillage, C.editeur.menu.aiguillage);
  });

  it("les bornes de la 5b sont celles de FLOW_LIMITS et de construction-constants.ts", () => {
    assert.equal(FLOW_LIMITS.methodesParEtape, 2);
    assert.equal(FLOW_LIMITS.specialistesMin, 2);
    assert.equal(FLOW_LIMITS.specialistesMax, 8);
    assert.equal(FLOW_LIMITS.toursMax, 2);
    assert.equal(FLOW_LIMITS.choixMax, 2);
  });
});

// --- 2. Grammaire ---------------------------------------------------------------------------------------------------------------

describe("L42a grammaire : relecture, aiguillage, liens et méthodes", () => {
  it("le refus « forme à venir » n'existe plus : une relecture et un aiguillage valides ne posent AUCUN problème", () => {
    assert.deepEqual(codes(flowOf(relecture()), ctx("avance")), []);
    assert.deepEqual(codes(flowOf(relecture()), ctx("simple")), []);
    assert.deepEqual(codes(flowOf(aiguillage()), ctx("avance")), []);
    assert.deepEqual(codes(flowOf(aiguillage()), ctx("simple")), []);
  });

  it("`aiguillage-premier` : un aiguillage ne peut être que le premier bloc de travail", () => {
    const tardif = flowOf(etapeBloc("un"), { ...aiguillage(), aiguilleur: step("aiguilleur", { assistant: AIGUILLEUR.name, recoit: "demande" }) });
    dansLesDeuxModes(tardif, "aiguillage-premier");
    assert.equal(codes(flowOf(aiguillage()), ctx("avance")).includes("aiguillage-premier"), false);
  });

  it("`specialistes` : de 2 à 8 spécialistes, `choixMax` dans les bornes et jamais plus grand que la liste", () => {
    const un = flowOf(aiguillage({ specialistes: [step("sql", { assistant: SPECIALISTE.name, recoit: "precedent" })], choixMax: 1, synthese: null }));
    dansLesDeuxModes(un, "specialistes");
    const neuf = flowOf(
      aiguillage({ specialistes: Array.from({ length: 9 }, (_, i) => step(`s${i}`, { assistant: SPECIALISTE.name, recoit: "precedent" })) }),
    );
    dansLesDeuxModes(neuf, "specialistes");
    const deuxProposes = flowOf(
      aiguillage({
        specialistes: [
          step("sql", { assistant: SPECIALISTE.name, recoit: "precedent" }),
          step("script", { assistant: SPECIALISTE.name, recoit: "precedent" }),
        ],
        choixMax: 2,
      }),
    );
    assert.equal(codes(deuxProposes, ctx("avance")).includes("specialistes"), false);
  });

  it("`synthese-requise` : une synthèse est exigée dès que 2 spécialistes peuvent être choisis", () => {
    dansLesDeuxModes(flowOf(aiguillage({ synthese: null })), "synthese-requise");
    assert.equal(codes(flowOf(aiguillage({ choixMax: 1, synthese: null })), ctx("avance")).includes("synthese-requise"), false);
  });

  it("`relecteur-distinct` : le même assistant sans autre IA est refusé, le même avec un autre niveau est accepté", () => {
    const meme = flowOf(relecture({ relecteur: step("relecteur", { assistant: REDACTEUR.name, recoit: "precedent" }) }));
    dansLesDeuxModes(meme, "relecteur-distinct");
    const autreNiveau = flowOf(
      relecture({ relecteur: step("relecteur", { assistant: REDACTEUR.name, niveau: "expert" as Tier, recoit: "precedent" }) }),
    );
    assert.equal(codes(autreNiveau, ctx("avance")).includes("relecteur-distinct"), false);
  });

  it("`meme-famille` : AVERTISSEMENT (non bloquant) quand les deux IA sont de la même famille, jamais sur une supposition", () => {
    const memeFamille = flowOf(relecture({ relecteur: step("relecteur", { assistant: AIGUILLEUR.name, recoit: "precedent" }) }));
    const probleme = validateFlow(memeFamille, ctx("avance")).find((p) => p.code === "meme-famille");
    assert.ok(probleme, "avertissement attendu : deux IA « gpt-* »");
    assert.equal(probleme.bloquant, false);
    dansLesDeuxModes(memeFamille, "meme-famille");
    // Familles différentes (gpt contre claude) : rien à dire.
    assert.equal(codes(flowOf(relecture()), ctx("avance")).includes("meme-famille"), false);
    // Un niveau choisi résout l'IA ailleurs : aucune famille n'est supposée ici.
    const avecNiveau = flowOf(
      relecture({
        auteur: step("auteur", { assistant: REDACTEUR.name, niveau: "rapide" as Tier }),
        relecteur: step("relecteur", { assistant: AIGUILLEUR.name, recoit: "precedent" }),
      }),
    );
    assert.equal(codes(avecNiveau, ctx("avance")).includes("meme-famille"), false);
  });

  it("`lien-arriere` : une étape plus bas, ou inconnue, est refusée ; une étape plus haut est acceptée", () => {
    const versLeBas = flowOf(etapeBloc("un", { recoit: "demande" }), etapeBloc("deux", { recoit: { etapes: ["trois"] } }), etapeBloc("trois", { recoit: "precedent" }));
    dansLesDeuxModes(versLeBas, "lien-arriere");
    const inconnue = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: { etapes: ["fantome"] } }));
    dansLesDeuxModes(inconnue, "lien-arriere");
    const versLeHaut = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }), etapeBloc("trois", { recoit: { etapes: ["un"] } }));
    assert.deepEqual(codes(versLeHaut, ctx("avance")), []);
  });

  it("`lien-avis` : un avis ne va jamais chercher un avis frère de son propre bloc", () => {
    const frere = flowOf({
      type: "avis",
      id: "avis",
      avis: [step("a1"), step("a2", { recoit: { etapes: ["a1"] } })],
      synthese: step("synthese", { recoit: "tous" }),
    });
    dansLesDeuxModes(frere, "lien-avis");
    assert.ok(codes(frere, ctx("avance")).includes("recoit-invalide"), "un avis doit recevoir « demande »");
  });

  it("`lien-avance` : `recoit: {etapes}` est refusé en mode Simple, accepté en mode Avancé", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: { etapes: ["un"] } }));
    assert.ok(codes(flow, ctx("simple")).includes("lien-avance"));
    assert.equal(codes(flow, ctx("avance")).includes("lien-avance"), false);
    assert.deepEqual(codes(flow, ctx("avance")), []);
  });

  it("`methodes` : 3 méthodes, une méthode inconnue, « seconde-lecture » (genre relecture) ou une méthode déjà appliquée", () => {
    const connues = methodes(["cinq-pourquoi", "pre-mortem"], { [REDACTEUR.name]: ["pre-mortem"] });
    const trois = flowOf(etapeBloc("un", { methodes: ["cinq-pourquoi", "pre-mortem", "autre"] }));
    dansLesDeuxModes(trois, "methodes", { methods: connues });
    // Sans contexte de méthodes, seul le NOMBRE est contrôlé : rien n'est supposé sur le catalogue.
    assert.ok(codes(trois, ctx("avance")).includes("methodes"));
    const inconnue = flowOf(etapeBloc("un", { methodes: ["jamais-vue"] }));
    assert.ok(codes(inconnue, ctx("avance", { methods: connues })).includes("methodes"));
    assert.equal(codes(inconnue, ctx("avance")).includes("methodes"), false, "sans contexte, le nombre seul est contrôlé");
    const relectureMethode = flowOf(etapeBloc("un", { methodes: ["seconde-lecture"] }));
    assert.ok(codes(relectureMethode, ctx("avance", { methods: connues })).includes("methodes"), "une méthode de relecture ne s'attache pas");
    const deja = flowOf(etapeBloc("un", { methodes: ["pre-mortem"] }));
    dansLesDeuxModes(deja, "methodes", { methods: connues });
    const double = flowOf(etapeBloc("un", { methodes: ["cinq-pourquoi", "cinq-pourquoi"] }));
    assert.ok(codes(double, ctx("avance", { methods: connues })).includes("methodes"));
    const bonne = flowOf(etapeBloc("un", { methodes: ["cinq-pourquoi"] }));
    assert.deepEqual(codes(bonne, ctx("avance", { methods: connues })), []);
  });

  it("plafonds : les spécialistes comptent dans les 12 étapes et l'aiguillage dans les 5 blocs de travail", () => {
    const large = flowOf(
      aiguillage({ specialistes: Array.from({ length: 8 }, (_, i) => step(`s${i}`, { assistant: SPECIALISTE.name, recoit: "precedent" })) }),
      relecture({ auteur: step("auteur2", { recoit: "precedent" }), relecteur: step("relecteur2", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
      etapeBloc("fin", { recoit: "precedent" }),
    );
    assert.ok(codes(large, ctx("avance")).includes("trop-d-etapes"), "8 spécialistes + aiguilleur + synthèse + 2 + 1 = 13");
    const sixBlocs = flowOf(
      relecture({ id: "r1" }),
      relecture({ id: "r2", auteur: step("a2", { recoit: "precedent" }), relecteur: step("r2b", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
      relecture({ id: "r3", auteur: step("a3", { recoit: "precedent" }), relecteur: step("r3b", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
      relecture({ id: "r4", auteur: step("a4", { recoit: "precedent" }), relecteur: step("r4b", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
      relecture({ id: "r5", auteur: step("a5", { recoit: "precedent" }), relecteur: step("r5b", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
      relecture({ id: "r6", auteur: step("a6", { recoit: "precedent" }), relecteur: step("r6b", { assistant: RELECTEUR.name, recoit: "precedent" }) }),
    );
    assert.ok(codes(sixBlocs, ctx("avance")).includes("trop-de-blocs"));
  });

  it("non-régression : un déroulé de l'itération 4 rend EXACTEMENT les mêmes problèmes qu'avant", () => {
    const it4 = flowOf(etapeBloc("un"), { type: "pause", id: "p", message: "Vérifiez." }, etapeBloc("deux", { recoit: "precedent" }));
    assert.deepEqual(codes(it4, ctx("avance")), []);
    assert.deepEqual(codes(it4, ctx("simple")), []);
    const avis = flowOf({ type: "avis", id: "avis", avis: [step("a1"), step("a2")], synthese: step("s", { recoit: "tous" }) });
    assert.deepEqual(codes(avis, ctx("avance")), []);
  });
});

// --- 3. planSteps, receivedFrom et transitions ------------------------------------------------------------------------------------

describe("L42a planification : planSteps et receivedFrom (team-limits.ts, fonctions de référence)", () => {
  it("`planSteps(flow)` sans option = l'ordre de l'itération 4 sur ses deux exemples", () => {
    const suite = flowOf(etapeBloc("un"), { type: "pause", id: "p", message: "" }, etapeBloc("deux", { recoit: "precedent" }));
    assert.deepEqual(
      planSteps(suite).map((p) => [p.stepId, p.blocIndex, p.ordre, p.tour, p.role]),
      [
        ["un", 0, 1, 1, "etape"],
        ["deux", 2, 2, 1, "etape"],
      ],
    );
    const avis = flowOf({ type: "avis", id: "avis", avis: [step("a1"), step("a2")], synthese: step("s", { recoit: "tous" }) });
    assert.deepEqual(planSteps(avis), planSteps(avis, { chemin: "typique" }), "les formes de l'it4 ont un seul chemin");
    assert.deepEqual(
      planSteps(avis).map((p) => [p.stepId, p.ordre, p.role]),
      [
        ["a1", 1, "avis"],
        ["a2", 2, "avis"],
        ["s", 3, "synthese"],
      ],
    );
  });

  it("relecture : 2 entrées sur le chemin typique, 1 + 2 × toursMax sur le chemin maximal (révision finale comprise)", () => {
    const deuxTours = flowOf(relecture());
    assert.deepEqual(
      planSteps(deuxTours, { chemin: "typique" }).map((p) => [p.stepId, p.tour, p.role]),
      [
        ["auteur", 1, "redaction"],
        ["relecteur", 1, "relecture"],
      ],
    );
    assert.deepEqual(
      planSteps(deuxTours, { chemin: "maximal" }).map((p) => [p.stepId, p.tour, p.role]),
      [
        ["auteur", 1, "redaction"],
        ["relecteur", 1, "relecture"],
        ["auteur", 2, "redaction"],
        ["relecteur", 2, "relecture"],
        ["auteur", 3, "redaction"],
      ],
    );
    assert.equal(planSteps(deuxTours).length, 1 + 2 * 2);
    assert.equal(planSteps(flowOf(relecture({ toursMax: 1 }))).length, 1 + 2 * 1);
  });

  it("aiguillage : un spécialiste sans synthèse au typique, `choixMax` spécialistes et la synthèse au maximal", () => {
    const flow = flowOf(aiguillage());
    assert.deepEqual(
      planSteps(flow, { chemin: "typique" }).map((p) => [p.stepId, p.role]),
      [
        ["aiguilleur", "aiguilleur"],
        ["sql", "specialiste"],
      ],
    );
    assert.deepEqual(
      planSteps(flow, { chemin: "maximal" }).map((p) => [p.stepId, p.role]),
      [
        ["aiguilleur", "aiguilleur"],
        ["sql", "specialiste"],
        ["script", "specialiste"],
        ["synthese", "synthese"],
      ],
    );
    // `choixMax` à 1 : aucune synthèse sur le chemin maximal non plus, elle ne travaille qu'à partir de deux résultats.
    const unSeul = flowOf(aiguillage({ choixMax: 1 }));
    assert.deepEqual(
      planSteps(unSeul, { chemin: "maximal" }).map((p) => p.stepId),
      ["aiguilleur", "sql"],
    );
  });

  it("`receivedFrom` : `{etapes: [a, c]}` rend [a, c] dans l'ordre de planSteps, même écrites à l'envers", () => {
    const flow = flowOf(
      etapeBloc("a"),
      etapeBloc("b", { recoit: "precedent" }),
      etapeBloc("c", { recoit: "precedent" }),
      etapeBloc("d", { recoit: { etapes: ["c", "a"] } }),
    );
    assert.deepEqual(receivedFrom(flow, "d"), ["a", "c"]);
    assert.deepEqual(receivedFrom(flow, "b"), ["a"], "« precedent » ne change pas");
  });

  it("`receivedFrom` : mêmes résultats que l'itération 4 pour « demande », « precedent » et « tous »", () => {
    const flow = flowOf(
      etapeBloc("un"),
      { type: "pause", id: "p", message: "" },
      { type: "avis", id: "avis", avis: [step("a1"), step("a2")], synthese: step("s", { recoit: "tous" }) },
      etapeBloc("fin", { recoit: "precedent" }),
    );
    assert.deepEqual(receivedFrom(flow, "un"), []);
    assert.deepEqual(receivedFrom(flow, "a1"), [], "un avis reçoit la demande seule");
    assert.deepEqual(receivedFrom(flow, "a2"), []);
    assert.deepEqual(receivedFrom(flow, "s"), ["un", "a1", "a2"]);
    assert.deepEqual(receivedFrom(flow, "fin"), ["s"]);
  });

  it("`receivedFrom` : transmissions implicites de la relecture et de l'aiguillage", () => {
    const flow = flowOf(relecture());
    assert.deepEqual(receivedFrom(flow, "auteur"), []);
    assert.deepEqual(receivedFrom(flow, "relecteur"), ["auteur"], "le relecteur reçoit la version courante");
    const a = flowOf(aiguillage());
    assert.deepEqual(receivedFrom(a, "aiguilleur"), []);
    assert.deepEqual(receivedFrom(a, "sql"), ["aiguilleur"], "un spécialiste reçoit la raison de l'aiguilleur");
    assert.deepEqual(receivedFrom(a, "synthese"), ["sql", "script", "reseau"], "la synthèse reçoit les résultats choisis");
    // « precedent » après une relecture : la DERNIÈRE version de l'auteur, jamais la relecture elle-même.
    const apres = flowOf(relecture(), etapeBloc("suite", { recoit: "precedent" }));
    assert.deepEqual(receivedFrom(apres, "suite"), ["auteur"]);
  });

  it("transitions `attente-choix` et `non-choisi` : aucun état final ne régresse", () => {
    assert.ok(canTransition("run", "en-cours", "attente-choix"));
    for (const cible of ["en-cours", "terminee", "arretee", "interrompue"]) assert.ok(canTransition("run", "attente-choix", cible), cible);
    assert.equal(canTransition("run", "attente-choix", "attente-choix"), false);
    assert.equal(canTransition("run", "terminee", "attente-choix"), false);
    assert.equal(canTransition("run", "arretee", "attente-choix"), false);
    assert.deepEqual([...TEAM_STEP_TRANSITIONS["non-choisi"]], [], "« non-choisi » est final");
    assert.ok(canTransition("step", "prevue", "non-choisi"));
    assert.ok(canTransition("step", "en-file", "non-choisi"));
    assert.equal(canTransition("step", "terminee", "non-choisi"), false);
    assert.equal(canTransition("step", "non-choisi", "en-cours"), false);
    assert.ok(Object.isFrozen(TEAM_RUN_TRANSITIONS["attente-choix"]));
  });
});

// --- 4. Ordonnanceur --------------------------------------------------------------------------------------------------------------

/** Déroule l'ordonnanceur en appliquant les actions, et rend la suite des lancements faits (étape et tour). */
function derouler(
  flow: Flow,
  verdictsScenario: readonly (("a-reprendre" | "rien-a-reprendre") | null)[],
  options: { pause?: boolean } = {},
): { lancements: Array<{ etape: string; tour: number; reprise: boolean }>; pauses: string[]; fin: boolean } {
  const state: {
    etapes: Record<string, TeamStepState>;
    tours: Record<string, number>;
    verdicts: Record<string, (("a-reprendre" | "rien-a-reprendre") | null)[]>;
    pausesRelecture: string[];
    resultats: Record<string, string>;
  } = { etapes: {}, tours: {}, verdicts: {}, pausesRelecture: [], resultats: {} };
  const lancements: Array<{ etape: string; tour: number; reprise: boolean }> = [];
  const pauses: string[] = [];
  const relectureBloc = flow.blocs.find((b) => b.type === "relecture");
  for (let garde = 0; garde < 40; garde++) {
    const actions: FlowAction[] = nextActions(flow, state as FlowState, { simultanees: 3 });
    const first = actions[0];
    if (!first) return { lancements, pauses, fin: false };
    if ("fin" in first) return { lancements, pauses, fin: true };
    if ("pause" in first) {
      pauses.push(first.pause);
      if (options.pause === false) return { lancements, pauses, fin: false };
      state.pausesRelecture.push(first.pause);
      continue;
    }
    if (!("lancer" in first)) return { lancements, pauses, fin: false };
    const tour = first.tour ?? 1;
    lancements.push({ etape: first.lancer, tour, reprise: first.reprendreSession === true });
    state.etapes[first.lancer] = "terminee";
    state.tours[first.lancer] = (state.tours[first.lancer] ?? 0) + 1;
    state.resultats[first.lancer] = `résultat de ${first.lancer} (tour ${tour})`;
    state.resultats[tourKey(first.lancer, tour)] = `résultat de ${first.lancer} (tour ${tour})`;
    if (relectureBloc?.type === "relecture" && first.lancer === relectureBloc.relecteur.id) {
      const liste = state.verdicts[relectureBloc.id] ?? [];
      liste.push(verdictsScenario[liste.length] ?? "a-reprendre");
      state.verdicts[relectureBloc.id] = liste;
    }
  }
  throw new Error("ordonnanceur : boucle");
}

describe("L42a ordonnanceur : relecture (C §6.2)", () => {
  it("un tour qui conclut « rien à reprendre » : 2 appels, aucune reprise de session", () => {
    const suite = derouler(flowOf(relecture()), ["rien-a-reprendre"]);
    assert.deepEqual(
      suite.lancements.map((l) => [l.etape, l.tour, l.reprise]),
      [
        ["auteur", 1, false],
        ["relecteur", 1, false],
      ],
    );
    assert.equal(suite.fin, true);
  });

  it("relecteur toujours « À REPRENDRE » avec 2 tours : 5 appels AU PLUS, tours ≥ 2 dans les MÊMES sessions (D-5-14)", () => {
    const suite = derouler(flowOf(relecture()), ["a-reprendre", "a-reprendre"]);
    assert.deepEqual(
      suite.lancements.map((l) => [l.etape, l.tour, l.reprise]),
      [
        ["auteur", 1, false],
        ["relecteur", 1, false],
        ["auteur", 2, true],
        ["relecteur", 2, true],
        ["auteur", 3, true],
      ],
    );
    assert.equal(suite.lancements.length, 1 + 2 * 2);
    assert.equal(suite.fin, true);
  });

  it("un seul tour : la dernière révision suit la relecture, et le bloc se clôt (3 appels)", () => {
    const suite = derouler(flowOf(relecture({ toursMax: 1 })), ["a-reprendre"]);
    assert.deepEqual(
      suite.lancements.map((l) => [l.etape, l.tour]),
      [
        ["auteur", 1],
        ["relecteur", 1],
        ["auteur", 2],
      ],
    );
    assert.equal(suite.fin, true);
  });

  it("verdict illisible : traité comme « à reprendre », jamais comme une relecture concluante", () => {
    const suite = derouler(flowOf(relecture({ toursMax: 1 })), [null]);
    assert.equal(suite.lancements.length, 3, "une révision suit un verdict illisible");
  });

  it("`pauseAvantRelecture` : une pause après le premier jet, au tour 1 SEULEMENT", () => {
    const bloque = derouler(flowOf(relecture({ pauseAvantRelecture: true })), ["a-reprendre", "a-reprendre"], { pause: false });
    assert.deepEqual(bloque.lancements.map((l) => l.etape), ["auteur"]);
    assert.deepEqual(bloque.pauses, ["b-relecture"]);
    const complet = derouler(flowOf(relecture({ pauseAvantRelecture: true })), ["a-reprendre", "a-reprendre"]);
    assert.deepEqual(complet.pauses, ["b-relecture"], "une seule pause, jamais au tour 2");
    assert.equal(complet.lancements.length, 5);
  });
});

describe("L42a ordonnanceur : aiguillage (C §6.2, spéc. l.772)", () => {
  const flow = flowOf(aiguillage());

  it("après l'aiguilleur, TOUJOURS une demande de choix : aucun spécialiste ne part avant votre confirmation", () => {
    assert.deepEqual(nextActions(flow, etats({}), { simultanees: 3 }), [{ lancer: "aiguilleur" }]);
    const apres: FlowState = { etapes: { aiguilleur: "terminee" } };
    assert.deepEqual(nextActions(flow, apres, { simultanees: 3 }), [{ choix: "b-aiguillage" }]);
  });

  it("deux choix : les deux spécialistes partent ensemble, puis la synthèse", () => {
    const base: FlowState = { etapes: { aiguilleur: "terminee" }, choix: { "b-aiguillage": ["sql", "script"] } };
    assert.deepEqual(nextActions(flow, base, { simultanees: 3 }), [{ lancer: "sql" }, { lancer: "script" }]);
    const faits: FlowState = { ...base, etapes: { aiguilleur: "terminee", sql: "terminee", script: "terminee" } };
    assert.deepEqual(nextActions(flow, faits, { simultanees: 3 }), [{ lancer: "synthese" }]);
    const tout: FlowState = { ...faits, etapes: { ...faits.etapes, synthese: "terminee" } };
    assert.deepEqual(nextActions(flow, tout, { simultanees: 3 }), [{ fin: true }]);
  });

  it("un seul choix : la synthèse est SAUTÉE, le résultat du spécialiste est le livrable", () => {
    const un: FlowState = { etapes: { aiguilleur: "terminee", sql: "terminee" }, choix: { "b-aiguillage": ["sql"] } };
    assert.deepEqual(nextActions(flow, un, { simultanees: 3 }), [{ fin: true }]);
  });

  it("« aucun » : le bloc est clos sans le moindre appel de spécialiste", () => {
    const aucun: FlowState = { etapes: { aiguilleur: "terminee" }, choix: { "b-aiguillage": "aucun" } };
    assert.deepEqual(nextActions(flow, aucun, { simultanees: 3 }), [{ fin: true }]);
  });

  it("simultanéité : jamais plus de `simultanees` spécialistes lancés ensemble", () => {
    const large = flowOf(aiguillage({ choixMax: 2 }));
    const base: FlowState = { etapes: { aiguilleur: "terminee" }, choix: { "b-aiguillage": ["sql", "script", "reseau"] } };
    assert.deepEqual(nextActions(large, base, { simultanees: 1 }), [{ lancer: "sql" }]);
  });
});

// --- 5. Message d'étape ------------------------------------------------------------------------------------------------------------

describe("L42a message d'étape (C §6.3)", () => {
  it("aucune méthode : le message est IDENTIQUE à celui de l'itération 4 (non-régression)", () => {
    const flow = flowOf(etapeBloc("un"));
    const sans = stepMessage(flow, "un", messageCtx());
    const vide = stepMessage(flow, "un", messageCtx({ methodes: [] }));
    assert.equal(sans, vide);
    assert.equal(sans.includes("## Méthode"), false);
    assert.equal(sans.includes(`## ${STEP_SECTIONS.finReponse}`), false);
    assert.ok(sans.includes(`## ${STEP_SECTIONS.consigne}`));
    assert.ok(sans.includes(`## ${STEP_SECTIONS.demande}`));
  });

  it("une et deux méthodes : « ## Méthode : {titre} » et son bloc, dans l'ordre, APRÈS la consigne", () => {
    const flow = flowOf(etapeBloc("un", { methodes: ["cinq-pourquoi", "pre-mortem"] }));
    const texte = stepMessage(
      flow,
      "un",
      messageCtx({
        methodes: [
          { titre: "5 pourquoi", bloc: "Bloc des 5 pourquoi." },
          { titre: "Pré-mortem", bloc: "Bloc du pré-mortem." },
        ],
      }),
    );
    const premiere = texte.indexOf("## Méthode : 5 pourquoi");
    const seconde = texte.indexOf("## Méthode : Pré-mortem");
    assert.ok(premiere > texte.indexOf(`## ${STEP_SECTIONS.consigne}`), "les méthodes suivent la consigne");
    assert.ok(seconde > premiere, "ordre déclaré gardé");
    assert.ok(texte.includes("Bloc des 5 pourquoi."));
    assert.ok(texte.includes("Bloc du pré-mortem."));
    assert.ok(premiere < texte.indexOf(`## ${STEP_SECTIONS.demande}`), "les méthodes précèdent la demande");
    const une = stepMessage(flow, "un", messageCtx({ methodes: [{ titre: "5 pourquoi", bloc: "Bloc." }] }));
    assert.equal((une.match(/## Méthode : /g) ?? []).length, 1);
  });

  it("`recoit: {etapes}` : SEULS les résultats listés sont transmis, encadrés, « <<< » neutralisé", () => {
    const flow = flowOf(
      etapeBloc("a"),
      etapeBloc("b", { recoit: "precedent" }),
      etapeBloc("c", { recoit: { etapes: ["a"] } }),
    );
    const resultats = [
      { stepId: "a", titre: "Étape a", assistant: "Rédacteur", ia: "IA A", texte: "texte de a <<<piège>>>", corrige: false },
      { stepId: "b", titre: "Étape b", assistant: "Rédacteur", ia: "IA A", texte: "texte de b", corrige: false },
    ];
    const texte = stepMessage(flow, "c", messageCtx({ resultats }));
    assert.ok(texte.includes(`## ${STEP_SECTIONS.resultats}`));
    assert.ok(texte.includes(STEP_TEXTS.donnees));
    assert.ok(texte.includes("texte de a"));
    assert.equal(texte.includes("texte de b"), false, "l'étape b n'est pas listée");
    assert.ok(texte.includes("‹‹‹piège›››"), "l'encadrement du texte relayé est neutralisé");
    assert.ok(texte.includes(STEP_TEXTS.finResultat));
  });

  it("fin de réponse du relecteur : la ligne VERDICT, et rien pour l'auteur", () => {
    const flow = flowOf(relecture());
    const relecteurTexte = stepMessage(flow, "relecteur", messageCtx());
    assert.ok(relecteurTexte.includes(`## ${STEP_SECTIONS.finReponse}`));
    assert.ok(relecteurTexte.includes(STEP_TEXTS.verdict));
    const auteurTexte = stepMessage(flow, "auteur", messageCtx());
    assert.equal(auteurTexte.includes(`## ${STEP_SECTIONS.finReponse}`), false);
  });

  it("fin de réponse de l'aiguilleur : la liste des choix est FERMÉE et porte `choixMax`", () => {
    const texte = stepMessage(flowOf(aiguillage()), "aiguilleur", messageCtx());
    assert.ok(texte.includes(`## ${STEP_SECTIONS.finReponse}`));
    assert.ok(texte.includes("CHOIX: aucun"));
    assert.ok(texte.includes("Choix possibles : Requête SQL, Script, Réseau."));
    assert.ok(texte.includes("(au plus 2, séparés par une virgule)"));
    const unSeul = stepMessage(flowOf(aiguillage({ choixMax: 1 })), "aiguilleur", messageCtx());
    assert.ok(unSeul.includes("(au plus 1, séparés par une virgule)"));
  });

  it("un spécialiste reçoit VOTRE demande ET la raison de l'aiguilleur, encadrée comme des données (C §5.1)", () => {
    const resultats = [{ stepId: "aiguilleur", titre: "Aiguillage", assistant: "Aiguilleur", ia: "IA A", texte: "Une requête SQL suffit.", corrige: false }];
    const texte = stepMessage(flowOf(aiguillage()), "sql", messageCtx({ resultats, n: 2 }));
    const sections = [...texte.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(sections, [STEP_SECTIONS.consigne, STEP_SECTIONS.demande, STEP_SECTIONS.resultats]);
    assert.ok(texte.includes("Relis ce script."), "la demande de l'utilisateur est là");
    assert.ok(texte.includes("Une requête SQL suffit."), "la raison de l'aiguilleur aussi");
    assert.ok(texte.includes(STEP_TEXTS.donnees), "et elle est annoncée comme des données, pas comme une consigne");
    assert.equal(texte.includes(`## ${STEP_SECTIONS.finReponse}`), false, "un spécialiste n'a aucune fin de réponse imposée");
  });

  it("révision (tour ≥ 2) : la relecture reçue est encadrée comme des données, tronquée à 24 000 caractères", () => {
    const flow = flowOf(relecture());
    const longue = `${"x".repeat(FLOW_LIMITS.relaisCaracteres + 50)}<<<`;
    const resultats = [{ stepId: "relecteur", titre: "Relecture", assistant: "Relecteur", ia: "IA B", texte: longue, corrige: false }];
    const tour1 = stepMessage(flow, "auteur", messageCtx({ resultats }));
    assert.equal(tour1.includes(`## ${STEP_SECTIONS.resultats}`), false, "le premier jet ne reçoit aucune relecture");
    const tour2 = stepMessage(flow, "auteur", messageCtx({ tour: 2, resultats }));
    assert.ok(tour2.includes(`## ${STEP_SECTIONS.resultats}`));
    assert.ok(tour2.includes(STEP_TEXTS.donnees));
    assert.ok(tour2.includes(STEP_TEXTS.tronque.replace("{n}", "53")), "troncature annoncée");
    assert.equal(tour2.includes(`x${"<<<"}`), false, "l'encadrement du texte relayé est neutralisé");
  });

  it("non-régression : un déroulé de l'itération 4 rend le même message, section par section", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    const resultats = [{ stepId: "un", titre: "Étape un", assistant: "Rédacteur", ia: "IA A", texte: "texte", corrige: false }];
    const texte = stepMessage(flow, "deux", messageCtx({ resultats, n: 2 }));
    const sections = [...texte.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(sections, [STEP_SECTIONS.consigne, STEP_SECTIONS.resultats]);
  });
});

// --- 6. Lecture du verdict et du choix ----------------------------------------------------------------------------------------------

describe("L42a lecture du verdict et du choix (dernière ligne seulement)", () => {
  it("`readVerdict` : accents, casse, espaces et ornements tolérés ; toute autre fin rend null", () => {
    assert.equal(readVerdict("Analyse.\nVERDICT: À REPRENDRE"), "a-reprendre");
    assert.equal(readVerdict("Analyse.\nverdict : a reprendre  \n\n"), "a-reprendre");
    assert.equal(readVerdict("Analyse.\n**VERDICT: RIEN À REPRENDRE**"), "rien-a-reprendre");
    assert.equal(readVerdict("Analyse.\nVERDICT: rien a reprendre."), "rien-a-reprendre");
    assert.equal(readVerdict("VERDICT: À REPRENDRE\nMais en fait non."), null, "seule la DERNIÈRE ligne compte");
    assert.equal(readVerdict("VERDICT: peut-être"), null);
    assert.equal(readVerdict("Rien à dire."), null);
    assert.equal(readVerdict(""), null);
    assert.equal(readVerdict(undefined), null);
  });

  it("`readChoice` : FERMÉ sur la liste, au plus `choixMax`, « aucun » reconnu", () => {
    const liste = aiguillage().specialistes.map((s) => ({ id: s.id, titre: s.titre }));
    assert.deepEqual(readChoice("Analyse.\nCHOIX: Requête SQL", liste, 2), { ids: ["sql"] });
    assert.deepEqual(readChoice("Analyse.\nchoix : script, requete sql", liste, 2), { ids: ["sql", "script"] }, "ordre du déroulé");
    assert.equal(readChoice("Analyse.\nCHOIX: aucun", liste, 2), "aucun");
    assert.equal(readChoice("Analyse.\nCHOIX: Base de données", liste, 2), null, "titre hors de la liste");
    assert.equal(readChoice("Analyse.\nCHOIX: Requête SQL, Script, Réseau", liste, 2), null, "plus de choixMax");
    assert.equal(readChoice("Analyse.\nCHOIX: Requête SQL, Script", liste, 1), null, "un aiguillage à un seul choix n'en retient pas deux");
    // `choixMax` reste borné par FLOW_LIMITS.choixMax : un appelant qui en demanderait davantage (JSON non validé) n'ouvre rien.
    assert.equal(readChoice("Analyse.\nCHOIX: Requête SQL, Script, Réseau", liste, 3), null, "la borne du cockpit l'emporte");
    assert.equal(readChoice("CHOIX: Requête SQL\nEn conclusion…", liste, 2), null, "seule la DERNIÈRE ligne compte");
    assert.equal(readChoice("Analyse.\nCHOIX:", liste, 2), null);
    assert.equal(readChoice("Analyse sans choix.", liste, 2), null);
    assert.deepEqual(readChoice("**CHOIX: Script, Script**", liste, 2), { ids: ["script"] }, "un doublon ne compte qu'une fois");
  });
});

// --- 7. Estimation ------------------------------------------------------------------------------------------------------------------

/** Prix fixe : 1 $ d'entrée, 0,10 $ d'entrée en cache, 10 $ de sortie par million de jetons (même table que L36b). */
const PRIX: ModelPrice = { rates: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 10 } };
const IA: StepIa = { model: "faux/ia", variant: null, niveau: null, label: "IA d'essai" };

function contexte(over: Partial<FlowEstimateContext> = {}): FlowEstimateContext {
  return {
    assistants: new Map(ASSISTANTS.map((a) => [a.name, a])),
    iaDe: () => IA,
    prix: () => PRIX,
    observe: () => null,
    simultanees: 3,
    ...over,
  };
}

describe("L42a estimation : « en général » sur le chemin typique, « au plus » sur le chemin maximal", () => {
  it("relecture à 2 tours : 2 étapes facturées « en général », 5 « au plus », et le maximum couvre le chemin maximal", () => {
    const flow = flowOf(relecture());
    const estimation = estimateFlow(flow, contexte());
    assert.equal(estimation.etapesFacturees, 5, "1 + 2 × toursMax appels");
    assert.equal(estimation.parEtape.length, 2, "une ligne par étape, jamais une par tour");
    assert.ok(estimation.maximum > estimation.typique, "« au plus » couvre les tours que « en général » ne fait pas");
    assert.equal(estimation.plafond, estimation.maximum);
    assert.deepEqual(estimation.repetitions, { tours: 2, specialistes: 0 });
  });

  it("aiguillage : « au plus » couvre `choixMax` spécialistes et la synthèse ; « en général » un seul spécialiste", () => {
    const estimation = estimateFlow(flowOf(aiguillage()), contexte());
    assert.equal(estimation.etapesFacturees, 4, "aiguilleur + 2 spécialistes + synthèse");
    assert.deepEqual(estimation.repetitions, { tours: 0, specialistes: 2 });
    assert.ok(estimation.maximum > estimation.typique);
  });

  it("relais comptés sur `recoit.etapes` : une étape liée paie l'entrée du résultat transmis, une étape isolée non", () => {
    const lie = flowOf(etapeBloc("a"), etapeBloc("b", { recoit: { etapes: ["a"] } }));
    const isole = flowOf(etapeBloc("a"), etapeBloc("b", { recoit: "demande" }));
    const avec = estimateFlow(lie, contexte());
    const sans = estimateFlow(isole, contexte());
    assert.ok(avec.relais > 0, "un résultat transmis coûte en entrée");
    assert.equal(sans.relais, 0);
    assert.equal(avec.relais, 0.0024, "S → 2 400 jetons de sortie à 1 $ le million");
    const deux = flowOf(etapeBloc("a"), etapeBloc("b", { recoit: "precedent" }), etapeBloc("c", { recoit: { etapes: ["a", "b"] } }));
    assert.equal(estimateFlow(deux, contexte()).relais, 0.0072, "trois relais de 0,0024 $");
  });

  it("non-régression : un déroulé de l'itération 4 rend la MÊME estimation qu'avant, chiffre pour chiffre", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    const estimation = estimateFlow(flow, contexte());
    assert.deepEqual(
      planSteps(flow, { chemin: "typique" }),
      planSteps(flow, { chemin: "maximal" }),
      "sans relecture ni aiguillage, les deux chemins sont le MÊME : l'estimation ne peut pas avoir changé",
    );
    assert.equal(estimation.etapesFacturees, 2);
    assert.equal(estimation.parEtape.length, 2);
    assert.equal(Object.hasOwn(estimation, "repetitions"), false, "aucun champ neuf sur un déroulé de l'it4");
    // Deux étapes S à 0,03882 $ en général, 0,1098 $ au plus, plus un relais de 0,0024 $ (table de prix fixe ci-dessus).
    assert.equal(estimation.typique, 0.08004);
    assert.equal(estimation.maximum, 0.222);
    assert.equal(estimation.plafond, 0.222);
    assert.equal(estimation.relais, 0.0024);
  });

  it("propriété (200 déroulés, graine fixe) : `maximum` ≥ la somme brute du chemin maximal", () => {
    let seed = 20260922;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const tailles: readonly TaskSize[] = ["S", "M", "L"];
    const ctxPrix = contexte();
    for (let n = 0; n < 200; n++) {
      let compteur = 0;
      const neuve = (recoit: StepInput, assistantName = REDACTEUR.name) =>
        step(`s${compteur++}`, { recoit, assistant: assistantName, taille: pick(tailles) });
      const blocs: FlowBlock[] = [];
      const combien = 1 + Math.floor(random() * 4);
      for (let b = 0; b < combien; b++) {
        const forme = pick(["etape", "avis", "relecture", "aiguillage"] as const);
        const premier = blocs.length === 0;
        if (forme === "etape") blocs.push({ type: "etape", id: `b${b}`, etape: neuve(premier ? "demande" : "precedent") });
        else if (forme === "avis") {
          blocs.push({
            type: "avis",
            id: `b${b}`,
            avis: Array.from({ length: 2 + Math.floor(random() * 2) }, () => neuve("demande")),
            synthese: neuve("tous"),
          });
        } else if (forme === "relecture") {
          blocs.push({
            type: "relecture",
            id: `b${b}`,
            auteur: neuve(premier ? "demande" : "precedent"),
            relecteur: neuve("precedent", RELECTEUR.name),
            toursMax: pick([1, 2] as const),
            pauseAvantRelecture: random() < 0.5,
          });
        } else {
          const specialistes = Array.from({ length: 2 + Math.floor(random() * 3) }, () => neuve("precedent", SPECIALISTE.name));
          blocs.push({
            type: "aiguillage",
            id: `b${b}`,
            aiguilleur: neuve(premier ? "demande" : "precedent", AIGUILLEUR.name),
            specialistes,
            choixMax: pick([1, 2] as const),
            synthese: neuve("tous"),
          });
        }
      }
      const flow = flowOf(...blocs);
      const estimation = estimateFlow(flow, ctxPrix);
      const parEtape = new Map(estimation.parEtape.map((ligne) => [ligne.stepId, ligne.maximum ?? 0]));
      const somme = planSteps(flow, { chemin: "maximal" }).reduce((total, planned) => total + (parEtape.get(planned.stepId) ?? 0), 0);
      assert.ok(estimation.maximum + 1e-9 >= somme, `déroulé ${n} : maximum ${estimation.maximum} < somme ${somme}`);
      assert.ok(estimation.maximum >= estimation.typique, `déroulé ${n} : « au plus » sous « en général »`);
      assert.equal(estimation.plafond, estimation.maximum);
    }
  });
});

// --- 8. Livrables ----------------------------------------------------------------------------------------------------------------

describe("L42a livrables (C §6.7)", () => {
  it("relecture conclue : la dernière version, puis le journal, sans note", () => {
    const flow = flowOf(relecture());
    const state: FlowState = {
      etapes: { auteur: "terminee", relecteur: "terminee" },
      resultats: { auteur: "Version finale.", relecteur: "Relecture 1.", [tourKey("relecteur", 1)]: "Relecture 1." },
      verdicts: { "b-relecture": ["rien-a-reprendre"] },
    };
    const livrable = deliverable(flow, state);
    assert.ok(livrable);
    assert.ok(livrable.texte.startsWith("Version finale."));
    assert.ok(livrable.texte.includes(`## ${DELIVERABLE_TEXTS.journal}`));
    assert.ok(livrable.texte.includes(DELIVERABLE_TEXTS.rienAReprendre));
    assert.ok(livrable.texte.includes("Relecture 1."));
    assert.equal(livrable.etapeSource, "auteur");
    assert.equal(livrable.notes, undefined);
  });

  it("relecture non conclue après 2 tours : les DEUX notes d'honnêteté sont là", () => {
    const flow = flowOf(relecture());
    const state: FlowState = {
      etapes: { auteur: "terminee", relecteur: "terminee" },
      resultats: {
        auteur: "Dernière correction.",
        [tourKey("relecteur", 1)]: "Relecture 1.",
        [tourKey("relecteur", 2)]: "Relecture 2.",
      },
      verdicts: { "b-relecture": ["a-reprendre", "a-reprendre"] },
    };
    const livrable = deliverable(flow, state);
    assert.ok(livrable);
    assert.deepEqual(livrable.notes, [DELIVERABLE_TEXTS.nonRelue, DELIVERABLE_TEXTS.nonConclue.replace("{n}", "2")]);
    assert.ok(livrable.texte.includes(DELIVERABLE_TEXTS.nonRelue));
    assert.ok(livrable.texte.includes("Relecture 1."));
    assert.ok(livrable.texte.includes("Relecture 2."));
  });

  it("verdict illisible : le journal le dit, sans prétendre que la relecture a conclu", () => {
    const flow = flowOf(relecture({ toursMax: 1 }));
    const state: FlowState = {
      etapes: { auteur: "terminee", relecteur: "terminee" },
      resultats: { auteur: "Version.", [tourKey("relecteur", 1)]: "Texte sans verdict." },
      verdicts: { "b-relecture": [null] },
    };
    const livrable = deliverable(flow, state);
    assert.ok(livrable?.texte.includes(DELIVERABLE_TEXTS.verdictIllisible));
    assert.ok(livrable?.texte.includes(DELIVERABLE_TEXTS.aReprendre));
  });

  it("aiguillage : la synthèse à deux choix, le spécialiste seul à un choix, la phrase et le repli pour « aucun »", () => {
    const flow = flowOf(aiguillage());
    const deux: FlowState = {
      etapes: { aiguilleur: "terminee", sql: "terminee", script: "terminee", synthese: "terminee" },
      resultats: { sql: "Résultat SQL.", script: "Résultat script.", synthese: "Synthèse." },
      choix: { "b-aiguillage": ["sql", "script"] },
    };
    assert.equal(deliverable(flow, deux)?.texte, "Synthèse.");
    const un: FlowState = {
      etapes: { aiguilleur: "terminee", sql: "terminee", script: "non-choisi", reseau: "non-choisi", synthese: "non-choisi" },
      resultats: { sql: "Résultat SQL." },
      choix: { "b-aiguillage": ["sql"] },
    };
    assert.equal(deliverable(flow, un)?.texte, "Résultat SQL.");
    const aucun: FlowState = { etapes: { aiguilleur: "terminee" }, choix: { "b-aiguillage": "aucun" } };
    const texte = deliverable(flow, aucun)?.texte ?? "";
    assert.ok(texte.includes(DELIVERABLE_TEXTS.aucun));
    assert.ok(texte.includes(DELIVERABLE_TEXTS.aucunRepli.replace("{assistant}", "assistant-general")));
  });

  it("non-régression : le livrable d'un déroulé de l'itération 4 reste le texte brut de sa dernière étape", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    const state: FlowState = { etapes: { un: "terminee", deux: "terminee" }, resultats: { un: "A", deux: "B" } };
    assert.deepEqual(deliverable(flow, state), { texte: "B", etapeSource: "deux" });
  });
});

// --- 9. Disposition et liste accessible ---------------------------------------------------------------------------------------------

describe("L42a disposition et liste (spéc. §5.5)", () => {
  const NOMS = new Map(ASSISTANTS.map((a) => [a.name, a.title]));

  it("relecture : une ligne à deux cellules ; aiguillage : une ligne de proposition, puis la synthèse", () => {
    const rows = layoutFlow(flowOf(relecture()), NOMS);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.cellules.map((c) => c.stepId), r.recoitDe]),
      [["relecture", ["auteur", "relecteur"], []]],
    );
    const aiguillageRows = layoutFlow(flowOf(aiguillage()), NOMS);
    assert.deepEqual(
      aiguillageRows.map((r) => [r.kind, r.cellules.map((c) => c.stepId)]),
      [
        ["aiguillage", ["aiguilleur", "sql", "script", "reseau"]],
        ["synthese", ["synthese"]],
      ],
    );
    assert.deepEqual(aiguillageRows[1]?.recoitDe, ["sql", "script", "reseau"]);
  });

  it("`recoitDe` et la phrase « Reçoit le résultat de : … » nomment les étapes par leur TITRE", () => {
    const flow = flowOf(etapeBloc("a"), etapeBloc("b", { recoit: "precedent" }), etapeBloc("c", { recoit: { etapes: ["a"] } }));
    const rows = layoutFlow(flow, NOMS);
    assert.deepEqual(rows.at(-1)?.recoitDe, ["a"]);
    const liste = flowAsList(flow, NOMS);
    const attendue = CONSTRUCTION_TEXTES.partout.liens.recoit.replace("{etapes}", "Étape a");
    assert.ok(liste.some((ligne) => ligne.includes(attendue)), liste.join(" | "));
  });

  it("liste : une phrase par étape, la pause avant relecture annoncée, ordre stable", () => {
    const liste = flowAsList(flowOf(relecture({ pauseAvantRelecture: true })), NOMS);
    assert.equal(liste.length, 3);
    assert.ok(liste[0]?.startsWith("Étape 1 : Rédaction"));
    assert.equal(liste[1], TEAM_TEXTES.partout.execution.pause);
    assert.ok(liste[2]?.startsWith("Étape 2 : Relecture"));
    assert.deepEqual(flowAsList(flowOf(relecture({ pauseAvantRelecture: true })), NOMS), liste, "stable");
  });

  it("non-régression : la disposition et la liste d'un déroulé de l'itération 4 ne changent pas", () => {
    const flow = flowOf({ type: "avis", id: "avis", avis: [step("a1"), step("a2")], synthese: step("s", { recoit: "tous" }) });
    assert.deepEqual(
      layoutFlow(flow, NOMS).map((r) => [r.kind, r.cellules.map((c) => c.stepId), r.recoitDe]),
      [
        ["avis", ["a1", "a2"], []],
        ["synthese", ["s"], ["a1", "a2"]],
      ],
    );
    assert.equal(flowAsList(flow, NOMS).length, 4);
  });
});

// --- 10. Pureté --------------------------------------------------------------------------------------------------------------------

describe("L42a pureté des contrats", () => {
  it("team-types.ts sans code exécutable ; team-limits.ts sans import de valeur hors de ./", () => {
    const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "shared", file), "utf8");
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const types = read("team-types.ts");
    assert.equal(withoutComments(stripTypeScriptTypes(types)).trim(), "");
    assert.equal(/^\s*import (?!type\b)/m.test(types), false);
    const limits = read("team-limits.ts");
    const imports = [...limits.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => [m[1]?.trim() ?? "", m[2]]);
    assert.deepEqual(imports, [["type", "./team-types.ts"]]);
    for (const source of [types, limits, read("flow.ts"), read("flow-estimate.ts"), read("flow-layout.ts")]) {
      assert.equal(source.includes('"node:'), false);
      assert.equal(/\bprocess\./.test(source), false);
    }
  });

  it("`planSteps` et `receivedFrom` restent définis dans team-limits.ts SEULEMENT", () => {
    const dossier = path.join(import.meta.dirname, "shared");
    for (const fichier of fs.readdirSync(dossier).filter((f) => f.endsWith(".ts") && f !== "team-limits.ts")) {
      const source = fs.readFileSync(path.join(dossier, fichier), "utf8");
      assert.equal(/export (?:function|const) (?:planSteps|receivedFrom)\b/.test(source), false, fichier);
    }
  });

  it("flow.ts n'importe pas le catalogue de méthodes (le contexte vient des appelants)", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "flow.ts"), "utf8");
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    assert.equal(imports.includes("./methods.ts"), false);
    assert.equal(imports.includes("../methods-catalogue.ts"), false);
    for (const spec of imports) assert.ok(/^\.\/[\w.-]+\.ts$/.test(spec) || spec === "../pricing.ts" || spec === "../redact.ts", spec);
  });
});
