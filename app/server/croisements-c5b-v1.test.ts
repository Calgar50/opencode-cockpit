// Tests de croisement du train 5b V1 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L42a (relecture et
// aiguillage, liens et méthodes des étapes, déroulé pur), L48 (Vue d'ensemble de la carte) et L49 (Démonstration d'équipe),
// ENSEMBLE, sur le code fusionné de l'itération 4 (FE4).
//
// Les trois paquets ont été écrits sans se voir, sur la même base : L42a étend les modules purs des équipes, L48 lit la carte
// des assistants, L49 rejoue un lancement enregistré. Ce que la vague doit prouver ensemble, et qu'aucun paquet ne prouvait
// seul :
//   1. §5.3 « un déroulé à relecture et un à aiguillage passent validateFlow (Simple et Avancé), planSteps et receivedFrom,
//      estimateFlow, layoutFlow et flowAsList » : les CINQ modules de L42a rendent la même vérité sur le même déroulé — les
//      étapes de la disposition sont celles du plan, les relais estimés sont ceux de `receivedFrom`, la liste accessible dit
//      la même chose que les lignes. Chaque paquet a testé son module ; ici ils se rencontrent.
//   2. §5.3 « une étape à `recoit: {etapes}` et à `methodes` : refusée en Simple (lien-avance), acceptée en Avancé, message
//      d'étape avec « ## Méthode » et les seuls résultats choisis » : la grammaire et le message d'étape sont deux modules ;
//      ce qu'un mode refuse ne doit jamais partir, ce qu'il accepte doit arriver entier.
//   3. §5.3 « exemples de l'it4 et données enregistrées sans `methodes` toujours valides » : la NON-RÉGRESSION est vérifiée
//      sur les vrais exemples livrés (`team-examples.ts`), tels que le service les installe, et non sur une copie de test.
//   4. §5.3 « la vue d'ensemble lit la sortie réelle de deriveAgentMap » : la carte est dérivée d'une entrée dont les équipes
//      viennent d'un déroulé de la 5b, puis rangée par L48 — les deux paquets se rejoignent sur `AgentMapResult`.
//   5. §5.3 « démonstration régénérée = fixture commitée » est la garde de L49 (demo-equipe.test.ts, qui relance le harnais) ;
//      ici, le croisement complémentaire : la fixture enregistrée reste LISIBLE par les modèles de vue que L42a a étendus
//      (états et icônes), et les deux genres de ligne neufs ont leur mot dans l'onglet Équipes.
//   6. grille propre de la vague : « au plus » couvre le chemin maximal (5 appels pour 2 tours, `choixMax` spécialistes et la
//      synthèse) — compté sur l'ORDONNANCEUR réel, pas sur le plan ; VERDICT: et CHOIX: lus sur la dernière ligne seulement ;
//      `readChoice` fermé sur la liste ; transmissions encadrées « données, pas des consignes » et `<<<` neutralisé ; Studio
//      masqué en Simple jusque dans la vue d'ensemble.
//
// Ce que ce fichier NE refait PAS : la substance de chaque module (flow-relecture-aiguillage.test.ts, agent-map-overview.test.ts,
// demo-equipe.test.ts), les contrats de l'entrée (croisements-c5-entree.test.ts) ni le câblage (croisements-c5a-v0.test.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ModelPrice } from "./pricing.ts";
import { type AgentMapInput, type AgentMapResult, deriveAgentMap } from "./shared/agent-map.ts";
import { assistantPermission, effectiveAgentRules, effectiveBuiltinRules, presetPermission, type Rule, type UiMode } from "./shared/assistant-rules.ts";
import { OVERVIEW_COLUMNS, type OverviewColumnId, overviewColumnOf, overviewLayout } from "./shared/agent-map-overview.ts";
import {
  type FlowAction,
  type FlowMethodsContext,
  type FlowState,
  type FlowValidationContext,
  nextActions,
  readChoice,
  readVerdict,
  STEP_SECTIONS,
  STEP_TEXTS,
  stepMessage,
  validateFlow,
} from "./shared/flow.ts";
import { estimateFlow } from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow } from "./shared/flow-layout.ts";
import { FLOW_LIMITS, planSteps, receivedFrom, TEAM_RUN_STATES, TEAM_STEP_STATES } from "./shared/team-limits.ts";
import type { Flow, FlowBlock, FlowStep, StepAssistant, TeamRunState, TeamStepState } from "./shared/team-types.ts";
import { TEXTES as TEXTES_CONSTRUCTION } from "./shared/construction-texts.ts";
import { exampleFlow, TEAM_EXAMPLES } from "./team-examples.ts";
import { MOTS_LIGNE } from "../web/pages/assistants/teams/teams-tab-model.ts";
import { ETATS_VERROU, RUN_ICONS, STEP_ICONS } from "../web/pages/chat/team/team-view-model.ts";

// --- Fixtures communes --------------------------------------------------------------------------------------------------------

const REGLES: Rule[] = effectiveAgentRules(presetPermission("prudent"), assistantPermission("lecture", false, []));

function assistant(name: string, model: string | null = "github-copilot/gpt-5-mini"): StepAssistant {
  return {
    name,
    title: `Titre de ${name}`,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: REGLES,
    model,
    available: true,
    steps: 12,
    taille: "M",
  };
}

const AUTEUR = assistant("rediger-note");
const RELECTEUR = assistant("relecteur-critique");
const AIGUILLEUR = assistant("aiguilleur");
const SPECIALISTE = assistant("relire-script");
const SPECIALISTE_RESEAU = assistant("analyser-reseau", "github-copilot/gpt-5");
const ASSISTANTS = [AUTEUR, RELECTEUR, AIGUILLEUR, SPECIALISTE, SPECIALISTE_RESEAU];

const step = (id: string, over: Partial<FlowStep> = {}): FlowStep => ({
  id,
  titre: `Étape ${id}`,
  assistant: AUTEUR.name,
  niveau: null,
  taille: "S",
  consigne: `Consigne de ${id}`,
  recoit: "demande",
  ...over,
});

const flowOf = (...blocs: FlowBlock[]): Flow => ({ version: 1, blocs });

/** Déroulé à RELECTURE : une note rédigée, relue au plus deux fois, avec la pause avant la première relecture. */
const FLOW_RELECTURE: Flow = flowOf({
  type: "relecture",
  id: "b-relecture",
  auteur: step("auteur", { titre: "Rédaction" }),
  relecteur: step("relecteur", { assistant: RELECTEUR.name, titre: "Relecture", recoit: "precedent" }),
  toursMax: 2,
  pauseAvantRelecture: true,
});

/**
 * Déroulé à AIGUILLAGE : un aiguilleur, trois spécialistes possibles, deux choix au plus et une synthèse. Les trois spécialistes
 * n'ont ni le même assistant ni la même taille, et le plus GROS est écrit en DERNIER : un « au plus » qui ne couvrirait que les
 * premiers écrits se verrait tout de suite.
 */
const FLOW_AIGUILLAGE: Flow = flowOf({
  type: "aiguillage",
  id: "b-aiguillage",
  aiguilleur: step("aiguilleur", { assistant: AIGUILLEUR.name, titre: "Aiguillage" }),
  specialistes: [
    step("sql", { assistant: SPECIALISTE.name, titre: "Requête SQL", taille: "S" }),
    step("script", { assistant: SPECIALISTE.name, titre: "Script", taille: "M" }),
    step("reseau", { assistant: SPECIALISTE_RESEAU.name, titre: "Réseau", taille: "L" }),
  ],
  choixMax: 2,
  synthese: step("synthese", { titre: "Synthèse", recoit: "tous" }),
  repli: "assistant-general",
});

const ctxValidation = (mode: UiMode, over: Partial<FlowValidationContext> = {}): FlowValidationContext => ({
  assistants: ASSISTANTS,
  mode,
  niveauDisponible: () => true,
  ...over,
});

const methodesConnues = (consigne: string[], parAssistant: Record<string, string[]> = {}): FlowMethodsContext => ({
  consigne: new Set(consigne),
  parAssistant: (nom: string) => new Set(parAssistant[nom] ?? []),
});

const PRIX: ModelPrice = { rates: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 10 } };

/** Contexte d'estimation : tarifs FIXES, aucune moyenne observée — les chiffres ne dépendent d'aucune lecture du disque. */
const ctxEstimation = () => ({
  assistants: new Map(ASSISTANTS.map((a) => [a.name, a])),
  iaDe: () => ({ model: "github-copilot/gpt-5-mini", variant: null, niveau: null, label: "IA de test" }),
  prix: () => PRIX,
  observe: () => null,
  simultanees: 3,
});

const NOMS = new Map(ASSISTANTS.map((a) => [a.name, a.title]));

/** Toutes les étapes déclarées d'un déroulé, tous blocs confondus (l'ordre d'exécution vient de planSteps). */
function toutesLesEtapes(flow: Flow): FlowStep[] {
  const out: FlowStep[] = [];
  for (const bloc of flow.blocs) {
    if (bloc.type === "etape") out.push(bloc.etape);
    else if (bloc.type === "avis") out.push(...bloc.avis, bloc.synthese);
    else if (bloc.type === "relecture") out.push(bloc.auteur, bloc.relecteur);
    else if (bloc.type === "aiguillage") out.push(bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : []));
  }
  return out;
}

const bloquants = (flow: Flow, ctx: FlowValidationContext) => validateFlow(flow, ctx).filter((p) => p.bloquant);

// --- 1. Les cinq modules de L42a sur les mêmes deux déroulés ------------------------------------------------------------------

describe("croisement V1 : un déroulé à relecture et un à aiguillage traversent les cinq modules", () => {
  for (const [nom, flow] of [
    ["relecture", FLOW_RELECTURE],
    ["aiguillage", FLOW_AIGUILLAGE],
  ] as const) {
    it(`${nom} : validateFlow ne bloque ni en Simple ni en Avancé (aucun réglage du mode Avancé employé)`, () => {
      assert.deepEqual(bloquants(flow, ctxValidation("simple")), []);
      assert.deepEqual(bloquants(flow, ctxValidation("avance")), []);
    });

    it(`${nom} : planSteps, receivedFrom, layoutFlow et flowAsList disent la MÊME chose des mêmes étapes`, () => {
      const plan = planSteps(flow);
      const ids = new Set(toutesLesEtapes(flow).map((s) => s.id));

      // Le plan ne cite que des étapes du déroulé, l'ordre est contigu à partir de 1, et le tour ne dépasse jamais la limite.
      assert.deepEqual(
        plan.map((p) => p.ordre),
        plan.map((_, i) => i + 1),
      );
      for (const planned of plan) {
        assert.ok(ids.has(planned.stepId), planned.stepId);
        assert.ok(planned.tour >= 1 && planned.tour <= FLOW_LIMITS.toursMax + 1, `tour ${planned.tour}`);
      }

      // Toute étape planifiée reçoit des étapes du déroulé, jamais elle-même.
      for (const id of new Set(plan.map((p) => p.stepId))) {
        for (const source of receivedFrom(flow, id)) {
          assert.ok(ids.has(source), `${id} ← ${source}`);
          assert.notEqual(source, id);
        }
      }

      // La disposition couvre tous les blocs, et ses cellules nommées sont exactement les étapes du déroulé.
      const lignes = layoutFlow(flow, NOMS);
      assert.deepEqual(
        [...new Set(lignes.map((l) => l.bloc))],
        flow.blocs.map((b) => b.id),
      );
      const cellules = lignes.flatMap((l) => l.cellules.map((c) => c.stepId).filter((id): id is string => id !== null));
      assert.deepEqual(new Set(cellules), ids);

      // `recoitDe` des lignes vient de receivedFrom, jamais d'une seconde lecture de `recoit` (croisement de V1 de l'it4).
      for (const ligne of lignes) for (const source of ligne.recoitDe) assert.ok(ids.has(source), `${ligne.bloc} ← ${source}`);

      // La liste accessible est la même vérité en phrases : une ligne au moins par étape, aucune ligne vide.
      const liste = flowAsList(flow, NOMS);
      assert.ok(liste.length > 0);
      for (const ligne of liste) assert.ok(ligne.trim().length > 0);
      for (const etape of toutesLesEtapes(flow)) {
        assert.ok(
          liste.some((ligne) => ligne.includes(etape.titre)),
          etape.titre,
        );
      }
    });

    it(`${nom} : estimateFlow estime CHAQUE étape déclarée, et « en général » ≤ « au plus » = plafond`, () => {
      const estimation = estimateFlow(flow, ctxEstimation());
      // TOUTES les étapes déclarées, pas seulement celles du plan : un spécialiste au-delà de `choixMax` reste choisissable,
      // donc la feuille de lancement doit pouvoir le nommer. La condition est plus stricte que « les étapes de planSteps ».
      const declarees = new Set(toutesLesEtapes(flow).map((e) => e.id));
      assert.deepEqual(new Set(estimation.parEtape.map((e) => e.stepId)), declarees);
      for (const planifiee of planSteps(flow)) assert.ok(declarees.has(planifiee.stepId), planifiee.stepId);
      assert.ok(estimation.typique <= estimation.maximum, `${estimation.typique} ≤ ${estimation.maximum}`);
      assert.equal(estimation.plafond, estimation.maximum);
      assert.ok(estimation.relais >= 0);
      assert.ok(estimation.etapesFacturees > 0);
    });
  }

  it("relecture : « au plus » couvre 2 tours ; aiguillage : `choixMax` spécialistes et la synthèse (repetitions)", () => {
    // Un déroulé sans aiguillage ne répète aucun spécialiste : la ligne « 1 spécialiste en général, {n} au plus » ne s'écrit pas.
    const relecture = estimateFlow(FLOW_RELECTURE, ctxEstimation());
    assert.deepEqual(relecture.repetitions, { tours: 2, specialistes: 0 });
    // Symétriquement, un déroulé sans relecture ne répète aucun tour : les deux compteurs disent 0 quand la forme est absente.
    const aiguillage = estimateFlow(FLOW_AIGUILLAGE, ctxEstimation());
    assert.deepEqual(aiguillage.repetitions, { tours: 0, specialistes: 2 });
  });

  it("un déroulé de l'itération 4 n'a PAS de `repetitions` : son estimation ne change en rien", () => {
    const flow = flowOf({ type: "etape", id: "b1", etape: step("seule") });
    assert.equal(estimateFlow(flow, ctxEstimation()).repetitions, undefined);
  });
});

// --- 2. « au plus » compté sur l'ordonnanceur réel ------------------------------------------------------------------------------

describe("croisement V1 : « au plus » couvre le chemin maximal, compté sur l'ordonnanceur", () => {
  /** Déroule nextActions jusqu'à la fin, en répondant aux pauses et aux choix ; rend les étapes lancées, dans l'ordre. */
  function derouler(flow: Flow, reponses: { verdict: () => ReturnType<typeof readVerdict>; choix?: readonly string[] | "aucun" }): string[] {
    const etapes: Record<string, TeamStepState> = {};
    const tours: Record<string, number> = {};
    const verdicts: Record<string, (ReturnType<typeof readVerdict>)[]> = {};
    const state = (): FlowState => ({
      etapes,
      pausesFranchies: [],
      pausesRelecture: ["b-relecture"],
      tours,
      verdicts,
      ...(reponses.choix ? { choix: { "b-aiguillage": reponses.choix } } : {}),
    });
    const lances: string[] = [];
    for (let garde = 0; garde < 40; garde++) {
      const actions: FlowAction[] = nextActions(flow, state(), { simultanees: 3 });
      if (actions.length === 0 || actions.some((a) => "fin" in a || "echec" in a)) break;
      const pause = actions.find((a) => "pause" in a || "choix" in a);
      if (pause) break;
      for (const action of actions) {
        if (!("lancer" in action)) continue;
        const id = action.lancer;
        lances.push(id);
        etapes[id] = "terminee";
        tours[id] = (tours[id] ?? 0) + 1;
        const bloc = flow.blocs.find((b) => b.type === "relecture" && b.relecteur.id === id);
        if (bloc) (verdicts["b-relecture"] ??= []).push(reponses.verdict());
      }
    }
    return lances;
  }

  it("relecteur TOUJOURS « À REPRENDRE » : 5 appels au plus pour 2 tours, et le plan maximal en annonce autant", () => {
    const lances = derouler(FLOW_RELECTURE, { verdict: () => readVerdict("Des points restent.\nVERDICT: À REPRENDRE") });
    assert.deepEqual(lances, ["auteur", "relecteur", "auteur", "relecteur", "auteur"]);
    // Le plan maximal de team-limits.ts et l'ordonnanceur de flow.ts comptent le même nombre d'appels : c'est ce qui rend
    // « au plus » vrai, puisque l'estimation est bâtie sur le plan et l'arrêt sur l'ordonnanceur.
    assert.equal(planSteps(FLOW_RELECTURE, { chemin: "maximal" }).length, lances.length);
    assert.equal(planSteps(FLOW_RELECTURE, { chemin: "typique" }).length, 2);
  });

  it("aiguillage à deux choix : aiguilleur, 2 spécialistes puis la synthèse — le plan maximal dit les mêmes 4 appels", () => {
    const lances = derouler(FLOW_AIGUILLAGE, { verdict: () => null, choix: ["sql", "script"] });
    assert.deepEqual(lances, ["aiguilleur", "sql", "script", "synthese"]);
    assert.equal(planSteps(FLOW_AIGUILLAGE, { chemin: "maximal" }).length, lances.length);
    assert.equal(FLOW_AIGUILLAGE.blocs[0]?.type === "aiguillage" ? FLOW_AIGUILLAGE.blocs[0].choixMax : 0, 2);
  });

  it("aucun spécialiste ne part avant votre confirmation : l'ordonnanceur demande le choix", () => {
    const apres: FlowState = { etapes: { aiguilleur: "terminee" } };
    assert.deepEqual(nextActions(FLOW_AIGUILLAGE, apres, { simultanees: 3 }), [{ choix: "b-aiguillage" }]);
  });
});

// --- 3. Liens et méthodes : ce que le mode refuse ne part jamais ----------------------------------------------------------------

describe("croisement V1 : une étape à `recoit: {etapes}` et à `methodes`", () => {
  const FLOW_LIENS: Flow = flowOf(
    { type: "etape", id: "b1", etape: step("a", { titre: "Première" }) },
    { type: "etape", id: "b2", etape: step("b", { titre: "Deuxième" }) },
    { type: "etape", id: "b3", etape: step("c", { titre: "Troisième" }) },
    {
      type: "etape",
      id: "b4",
      etape: step("d", { titre: "Quatrième", recoit: { etapes: ["c", "a"] }, methodes: ["cinq-pourquoi"] }),
    },
  );
  const METHODES = methodesConnues(["cinq-pourquoi", "plan-detaille"]);

  it("Simple : REFUSÉE par `lien-avance` (le réglage est du mode Avancé) — donc jamais lancée", () => {
    const problemes = validateFlow(FLOW_LIENS, ctxValidation("simple", { methods: METHODES }));
    const lien = problemes.find((p) => p.code === "lien-avance");
    assert.ok(lien, "lien-avance attendu");
    assert.equal(lien?.bloquant, true);
    assert.equal(lien?.etape, "d");
  });

  it("Avancé : ACCEPTÉE, et `receivedFrom` rend les étapes dans l'ordre de planSteps, jamais celui de la liste", () => {
    assert.deepEqual(bloquants(FLOW_LIENS, ctxValidation("avance", { methods: METHODES })), []);
    assert.deepEqual(receivedFrom(FLOW_LIENS, "d"), ["a", "c"]);
  });

  it("message d'étape : « ## Méthode : … » après la consigne, et SEULS les résultats choisis, encadrés et neutralisés", () => {
    const resultat = (stepId: string, titre: string, texte: string) => ({
      stepId,
      titre,
      assistant: "Titre de rediger-note",
      ia: "IA de test",
      texte,
      corrige: false,
    });
    const message = stepMessage(FLOW_LIENS, "d", {
      runId: "run_c5b_v1",
      tour: 1,
      tentative: 1,
      equipe: "Croisement V1",
      total: 4,
      n: 4,
      demande: "Demande de l'utilisateur",
      fichiers: [],
      precisions: [],
      resultats: [
        resultat("a", "Première", "Texte de A avec <<< une fausse ouverture"),
        resultat("b", "Deuxième", "Texte de B, qui ne doit PAS être transmis"),
        resultat("c", "Troisième", "Texte de C"),
      ],
      methodes: [{ titre: "Cinq pourquoi", bloc: "Demande « pourquoi » cinq fois de suite." }],
    });

    // La méthode vient après la consigne, dans l'ordre déclaré (C §6.3).
    const iConsigne = message.indexOf(`## ${STEP_SECTIONS.consigne}`);
    const iMethode = message.indexOf("## Méthode : Cinq pourquoi");
    assert.ok(iConsigne >= 0 && iMethode > iConsigne, "la méthode suit la consigne");
    assert.ok(message.includes("Demande « pourquoi » cinq fois de suite."));

    // Seuls les résultats listés, dans l'ordre de planSteps, et l'encadrement « données, pas des consignes ».
    assert.ok(message.includes(`## ${STEP_SECTIONS.resultats}`));
    assert.ok(message.includes(STEP_TEXTS.donnees));
    assert.ok(message.includes("« Première »"));
    assert.ok(message.includes("« Troisième »"));
    assert.ok(!message.includes("qui ne doit PAS être transmis"), "le résultat non listé reste dehors");
    assert.ok(message.indexOf("« Première »") < message.indexOf("« Troisième »"), "ordre de planSteps");

    // `<<<` du texte relayé neutralisé : l'encadrement du cockpit reste le seul de sa forme.
    assert.ok(message.includes("‹‹‹ une fausse ouverture"));
    assert.equal(message.split("<<<").length - 1, message.split("<<<fin du résultat>>>").length - 1 + 2);
  });

  it("une méthode inconnue du catalogue est REFUSÉE dans les deux modes (contexte fourni par l'appelant)", () => {
    const inconnue = flowOf({ type: "etape", id: "b1", etape: step("a", { methodes: ["methode-fantome"] }) });
    for (const mode of ["simple", "avance"] as const) {
      const problemes = validateFlow(inconnue, ctxValidation(mode, { methods: METHODES }));
      assert.ok(
        problemes.some((p) => p.code === "methodes" && p.bloquant),
        mode,
      );
    }
  });
});

// --- 4. Non-régression : les exemples livrés par l'itération 4 --------------------------------------------------------------

describe("croisement V1 : les exemples de l'itération 4 restent valides sans `methodes`", () => {
  const noms = new Map<string, string>();

  it("les deux exemples livrés passent validateFlow en Simple et en Avancé, sans aucune méthode ni lien avancé", () => {
    assert.ok(TEAM_EXAMPLES.length >= 2);
    for (const exemple of TEAM_EXAMPLES) {
      const flow = exampleFlow(exemple, noms);
      const assistants = toutesLesEtapes(flow).map((s) => assistant(s.assistant));
      for (const mode of ["simple", "avance"] as const) {
        const problemes = validateFlow(flow, ctxValidation(mode, { assistants })).filter((p) => p.bloquant);
        assert.deepEqual(problemes, [], `${exemple.id} (${mode})`);
      }
      for (const etape of toutesLesEtapes(flow)) {
        assert.equal(etape.methodes, undefined, `${exemple.id} : ${etape.id}`);
        assert.equal(typeof etape.recoit, "string", `${exemple.id} : ${etape.id}`);
      }
    }
  });

  it("`planSteps` sans option rend l'ORDRE DE L'ITÉRATION 4 sur ces exemples : typique = maximal, tour 1 partout", () => {
    for (const exemple of TEAM_EXAMPLES) {
      const flow = exampleFlow(exemple, noms);
      const defaut = planSteps(flow);
      assert.deepEqual(defaut, planSteps(flow, { chemin: "maximal" }), exemple.id);
      assert.deepEqual(defaut, planSteps(flow, { chemin: "typique" }), exemple.id);
      for (const planned of defaut) assert.equal(planned.tour, 1, `${exemple.id} : ${planned.stepId}`);
    }
  });

  it("une donnée enregistrée par l'itération 4 (sans `methodes`) garde son message d'étape mot pour mot", () => {
    const flow = flowOf({ type: "etape", id: "b1", etape: step("seule", { titre: "Seule" }) });
    const base = {
      runId: "run_it4",
      tour: 1,
      tentative: 1,
      equipe: "Équipe de l'itération 4",
      total: 1,
      n: 1,
      demande: "Ma demande",
      fichiers: [],
      precisions: [],
      resultats: [],
    };
    // Aucune méthode passée, et une liste vide passée : le message est le même, et il ne porte aucune section « ## Méthode ».
    const sans = stepMessage(flow, "seule", base);
    const vide = stepMessage(flow, "seule", { ...base, methodes: [] });
    assert.equal(vide, sans);
    assert.ok(!sans.includes("## Méthode"));
    assert.ok(!sans.includes(`## ${STEP_SECTIONS.finReponse}`), "aucune fin de réponse imposée hors relecture et aiguillage");
  });
});

// --- 5. Lecture du verdict et du choix -----------------------------------------------------------------------------------------

describe("croisement V1 : VERDICT: et CHOIX: lus sur la DERNIÈRE ligne, `readChoice` fermé sur la liste", () => {
  const SPECIALISTES = [
    { id: "sql", titre: "Requête SQL" },
    { id: "script", titre: "Script" },
    { id: "reseau", titre: "Réseau" },
  ];

  it("une ligne VERDICT: au MILIEU de la réponse n'est jamais lue ; seule la dernière compte", () => {
    assert.equal(readVerdict("VERDICT: RIEN À REPRENDRE\nEn fait non.\nVERDICT: À REPRENDRE"), "a-reprendre");
    assert.equal(readVerdict("VERDICT: À REPRENDRE\nTout va bien finalement.\nVERDICT: RIEN À REPRENDRE"), "rien-a-reprendre");
    assert.equal(readVerdict("VERDICT: À REPRENDRE\nUne phrase après."), null, "verdict illisible");
  });

  it("une ligne CHOIX: au milieu n'est pas lue ; un titre hors de la liste rend null", () => {
    assert.deepEqual(readChoice("CHOIX: Script\nJe me ravise.\nCHOIX: Requête SQL", SPECIALISTES, 2), { ids: ["sql"] });
    assert.equal(readChoice("CHOIX: Un expert qui n'est pas dans la liste", SPECIALISTES, 2), null);
    assert.equal(readChoice("CHOIX: Requête SQL, Script, Réseau", SPECIALISTES, 2), null, "plus de choixMax");
    assert.equal(readChoice("CHOIX: aucun", SPECIALISTES, 2), "aucun");
  });

  it("le message de l'aiguilleur donne la liste FERMÉE que `readChoice` relit : les deux modules s'accordent", () => {
    const message = stepMessage(FLOW_AIGUILLAGE, "aiguilleur", {
      runId: "run_c5b_v1",
      tour: 1,
      tentative: 1,
      equipe: "Croisement V1",
      total: 5,
      n: 1,
      demande: "Ma demande",
      fichiers: [],
      precisions: [],
      resultats: [],
    });
    assert.ok(message.includes(`## ${STEP_SECTIONS.finReponse}`));
    for (const specialiste of SPECIALISTES) assert.ok(message.includes(specialiste.titre), specialiste.titre);
    // Chaque titre annoncé dans le message est effectivement lisible par readChoice, et rien d'autre ne l'est.
    for (const specialiste of SPECIALISTES) {
      assert.deepEqual(readChoice(`CHOIX: ${specialiste.titre}`, SPECIALISTES, 2), { ids: [specialiste.id] });
    }
  });
});

// --- 6. L42a × L48 : la vue d'ensemble lit la sortie réelle de deriveAgentMap ----------------------------------------------------

describe("croisement V1 : la vue d'ensemble range la carte réelle, équipes de la 5b comprises", () => {
  const PRUDENT = presetPermission("prudent");
  const V = TEXTES_CONSTRUCTION.avance.vueEnsemble;

  /** Carte dérivée d'une entrée dont l'ÉQUIPE vient du déroulé à aiguillage ci-dessus : les deux paquets se rejoignent ici. */
  function carte(mode: UiMode, filtreAgents: (agents: AgentMapInput["agents"]) => AgentMapInput["agents"] = (a) => a): AgentMapResult {
    const etapes = toutesLesEtapes(FLOW_AIGUILLAGE).map((s) => ({ assistant: s.assistant, niveau: s.niveau }));
    const agents: AgentMapInput["agents"] = [
        { name: "build", mode: "primary", origine: "integre", titre: null, rules: effectiveBuiltinRules("build", PRUDENT) },
        { name: "general", mode: "subagent", origine: "integre", rules: effectiveAgentRules(PRUDENT, {}) },
        ...ASSISTANTS.map((a) => ({
          name: a.name,
          mode: "primary" as const,
          origine: "assistant" as const,
          titre: a.title,
          rules: effectiveAgentRules(PRUDENT, assistantPermission("lecture", false, [])),
          ia: { label: "IA de test", niveau: "equilibre" as const, disponible: true },
          steps: 40,
        })),
      { name: "studio-primaire", mode: "primary", origine: "studio", rules: effectiveAgentRules(PRUDENT, {}) },
      { name: "studio-delegue", mode: "subagent", origine: "studio", rules: effectiveAgentRules(PRUDENT, {}) },
    ];
    const input: AgentMapInput = {
      agents: filtreAgents(agents),
      commands: [],
      fiches: [],
      equipes: [{ id: "aiguillage-5b", titre: "Aiguillage (5b)", etapes }],
      subagentDepth: 2,
      mode,
      internes: [],
    };
    return deriveAgentMap(input);
  }

  it("chaque nœud de la carte réelle tombe dans UNE colonne, et l'équipe bâtie sur un aiguillage est montrée", () => {
    const resultat = carte("avance");
    const layout = overviewLayout(resultat);
    const ranges = layout.colonnes.flatMap((c) => c.groupes.flatMap((g) => g.nodes.map((n) => n.node.id)));
    assert.deepEqual(
      new Set(ranges),
      new Set(resultat.nodes.map((n) => n.id)),
      "aucun nœud de deriveAgentMap n'est perdu ni inventé",
    );
    assert.equal(ranges.length, new Set(ranges).size, "aucun nœud rangé deux fois");
    assert.ok(ranges.some((id) => id.startsWith("equipe:")), "l'équipe est une puce de la vue d'ensemble");
    for (const colonne of layout.colonnes) {
      assert.ok(OVERVIEW_COLUMNS.includes(colonne.id as OverviewColumnId));
      for (const groupe of colonne.groupes) assert.equal(overviewColumnOf(groupe.kind), colonne.id);
    }
  });

  it("chaque GENRE rangé par la vue a son libellé dans construction-texts.ts, groupes de filtre et de liens compris", () => {
    // Le §4.3 veut « un groupe, une puce, un libellé » : la liste fermée des genres vient de la carte de l'it4 (L39a), les
    // libellés du fichier de textes de la construction. Le croisement ferme la boucle entre les deux paquets.
    const libelles: Readonly<Record<string, string>> = {
      vous: V.vous,
      assistant: V.assistants,
      integre: V.integres,
      "agent-studio": V.agentsStudio,
      "sous-agent": V.sousAgents,
      raccourci: V.raccourcis,
      fiche: V.fiches,
      equipe: V.equipes,
    };
    const layout = overviewLayout(carte("avance"));
    for (const colonne of layout.colonnes) {
      for (const groupe of colonne.groupes) {
        const libelle = libelles[groupe.kind];
        assert.ok(typeof libelle === "string" && libelle.length > 0, groupe.kind);
      }
    }
    // Les deux noms de groupe ajoutés par L48 (section c5:vue-ensemble-groupes, posée au train) existent et sont distincts.
    assert.equal(V.filtres, "Afficher");
    assert.equal(V.liens, "Liens");
    assert.notEqual(V.filtres, V.liens);
  });

  it("toute arête montrée a ses DEUX bouts montrés : la vue ne dessine jamais un lien vers un nœud absent", () => {
    const layout = overviewLayout(carte("avance"));
    const montres = new Set(layout.colonnes.flatMap((c) => c.groupes.flatMap((g) => g.nodes.map((n) => n.node.id))));
    for (const arete of layout.aretes) {
      assert.ok(montres.has(arete.source.id), arete.source.id);
      assert.ok(montres.has(arete.cible.id), arete.cible.id);
    }
  });

  it("Studio masqué en Simple : la vue d'ensemble SUIT la carte, elle n'a aucune règle de mode à elle", () => {
    // En Simple, c'est le SERVICE de la carte (agent-map-service.ts) qui retire les agents du Studio de l'entrée, jamais la vue.
    // Le croisement vérifie les deux bouts : sans eux dans la carte, la vue n'en range aucun ; avec eux, elle les range — donc
    // la vue n'ajoute ni ne devine rien sur le mode.
    const sansStudio = carte("simple", (agents) => agents.filter((agent) => agent.origine !== "studio"));
    assert.equal(sansStudio.nodes.filter((n) => n.kind === "agent-studio").length, 0);
    const genresSimple = overviewLayout(sansStudio).colonnes.flatMap((c) => c.groupes.map((g) => g.kind));
    assert.ok(!genresSimple.includes("agent-studio"), "aucun agent du Studio rangé en Simple");

    const avecStudio = carte("avance");
    assert.ok(avecStudio.nodes.some((n) => n.kind === "agent-studio"), "contrôle discriminant : ils existent en Avancé");
    const genresAvance = overviewLayout(avecStudio).colonnes.flatMap((c) => c.groupes.map((g) => g.kind));
    assert.ok(genresAvance.includes("agent-studio"));
  });
});

// --- 7. L42a × L49 : la démonstration enregistrée reste lisible par les modèles étendus ------------------------------------------

describe("croisement V1 : la démonstration d'équipe et les états ajoutés par L42a", () => {
  const FIXTURE = path.join(import.meta.dirname, "..", "web", "pages", "assistants", "teams", "demo-equipe.json");
  const demo = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
    version: number;
    moments: Array<{ at: number; faits: unknown[]; run: { state: string; steps: Array<{ state: string }> } }>;
  };

  it("chaque état de la fixture est un état CONNU des listes fermées, et a son icône", () => {
    assert.equal(demo.version, 1);
    assert.ok(demo.moments.length > 0);
    for (const moment of demo.moments) {
      assert.ok(TEAM_RUN_STATES.includes(moment.run.state as TeamRunState), moment.run.state);
      assert.ok(RUN_ICONS[moment.run.state as TeamRunState], `icône de ${moment.run.state}`);
      for (const etape of moment.run.steps) {
        assert.ok(TEAM_STEP_STATES.includes(etape.state as TeamStepState), etape.state);
        assert.ok(STEP_ICONS[etape.state as TeamStepState], `icône de ${etape.state}`);
      }
    }
  });

  it("les états AJOUTÉS par L42a ont eux aussi leur icône et leur place dans le verrou de saisie", () => {
    assert.ok(TEAM_RUN_STATES.includes("attente-choix"));
    assert.ok(TEAM_STEP_STATES.includes("non-choisi"));
    assert.equal(RUN_ICONS["attente-choix"], "pause");
    assert.equal(STEP_ICONS["non-choisi"], "minus");
    assert.ok(ETATS_VERROU.has("attente-choix"), "une équipe qui attend votre choix travaille encore");
    assert.ok(!ETATS_VERROU.has("terminee"));
  });

  it("l'onglet Équipes a un MOT pour chaque genre de ligne rendu par layoutFlow, formes de la 5b comprises", () => {
    const genres = new Set([...layoutFlow(FLOW_RELECTURE, NOMS), ...layoutFlow(FLOW_AIGUILLAGE, NOMS)].map((l) => l.kind));
    assert.ok(genres.has("relecture"));
    assert.ok(genres.has("aiguillage"));
    for (const genre of genres) {
      const mot = MOTS_LIGNE[genre];
      assert.ok(typeof mot === "string" && mot.length > 0, genre);
    }
  });

  it("la fixture n'appelle aucune IA : ses heures sont celles des moments, jamais l'horloge de la machine", () => {
    const heures = demo.moments.map((m) => m.at);
    assert.deepEqual([...heures].sort((a, b) => a - b), heures, "moments dans l'ordre");
    for (const heure of heures) assert.ok(heure >= 1_780_000_000_000 && heure < 1_780_000_100_000, String(heure));
  });
});
