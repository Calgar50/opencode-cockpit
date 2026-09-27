// Tests du paquet L36b (plan d'exécution it4 §6, fiche L36b) : estimation d'un déroulé, texte canonique de l'empreinte,
// disposition, liste et union des droits. Deux modules purs, sans magasin ni réseau : server/shared/flow-estimate.ts et
// server/shared/flow-layout.ts.
//
// Ce que ces tests tiennent :
// - les chiffres, sur des PRIX FIXES écrits ici (± 0,01 $) : un changement de TASK_PROFILES ou de la formule de coût se voit ;
// - l'honnêteté « En général / au plus » (spécification §6 l.1049) : `maximum` = le profil de la taille au-dessus, jamais plus bas
//   que « en général », `plafond` = `maximum`, et le dépassement possible est chiffré à part (un appel par étape en cours) ;
// - les relais comptés sur `receivedFrom` de T4 : un avis n'en ajoute AUCUN, la synthèse en ajoute un par avis ;
// - la moyenne observée retenue à partir de OBSERVED_MIN_SAMPLES (5) échantillons, jamais à 4 ;
// - le texte canonique de D-eq-19 : stable (clés triées), et différent dès qu'une IA, un prix, un plafond ou la simultanéité
//   change (A4, D-eq-17 : l'instantané des lectures y est lié) ;
// - la disposition et la liste, par forme ; l'union des droits sous le plancher ETAPE ;
// - la pureté des deux modules et l'indépendance de vague : aucun import de flow.ts (L36a, écrit en parallèle).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ModelPrice } from "./pricing.ts";
import { assistantPermission, effectiveAgentRules, OBSERVED_MIN_SAMPLES, type Rule, TASK_PROFILES, type TaskSize } from "./shared/assistant-rules.ts";
import {
  canonicalSteps,
  type EstimateCanonicalInput,
  estimateCanonical,
  estimateFlow,
  type FlowEstimateContext,
  estimateProblems,
  maximumTaskCost,
  RELAY_OUTPUT_TOKENS,
  relayCost,
  type StepIa,
  suiteEstimate,
  unAppelCost,
  up,
} from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow, rightsUnion } from "./shared/flow-layout.ts";
import { planSteps, receivedFrom } from "./shared/team-limits.ts";
import type { Flow, FlowStep, StepAssistant, StepInput } from "./shared/team-types.ts";

// --- Montage ---------------------------------------------------------------------------------------------------------------------

/** Prix fixe A : 1 $ d'entrée, 0,10 $ d'entrée en cache et 10 $ de sortie par million de jetons. */
const PRIX_A: ModelPrice = { rates: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 10 } };
/** Prix fixe B : le double de A, pour montrer qu'un changement de prix se voit. */
const PRIX_B: ModelPrice = { rates: { input: 2, cachedInput: 0.2, cacheWrite: null, output: 20 } };

/** Chiffres attendus avec PRIX_A (profils S, M et L de TASK_PROFILES). */
const COUT_A = { S: 0.03882, M: 0.1098, L: 0.3441, relaisS: 0.0024, relaisM: 0.006, unAppelS: 0.01941 };

const IA_A: StepIa = { model: "faux/ia-a", variant: null, niveau: null, label: "IA A" };
const IA_B: StepIa = { model: "faux/ia-b", variant: "poussee", niveau: "expert", label: "IA B" };

/**
 * Règles EFFECTIVES d'un assistant de lecture du catalogue, telles que GET /agent les rend (StepAssistant.rules) : le profil
 * « lecture » écrit par le cockpit, posé sur les défauts d'opencode.
 */
const REGLES_LECTURE: Rule[] = effectiveAgentRules(undefined, assistantPermission("lecture", false, []));

/** Assistant très permissif : hors équipe il modifie, lance des commandes, consulte Internet et délègue sans demander. */
const REGLES_PERMISSIVES: Rule[] = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "task", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "allow" },
];

function assistant(name: string, title: string, rules: Rule[] = REGLES_LECTURE): StepAssistant {
  return { name, title, origin: "catalogue", rights: "lecture", mode: "all", hidden: false, rules, model: null, available: true, steps: 40, taille: "M" };
}

const ASSISTANTS = new Map<string, StepAssistant>([
  ["relire-script", assistant("relire-script", "Relire un script")],
  ["relire-requete-sql", assistant("relire-requete-sql", "Relire une requête SQL")],
]);

const NOMS = new Map([...ASSISTANTS].map(([nom, a]) => [nom, a.title]));

function etape(id: string, titre: string, taille: TaskSize, recoit: StepInput, assistantName = "relire-script"): FlowStep {
  return { id, titre, assistant: assistantName, niveau: null, taille, consigne: "", recoit };
}

/** « Avis indépendants » : trois avis qui ne reçoivent que la demande, puis une synthèse qui reçoit tous les avis. */
const AVIS: Flow = {
  version: 1,
  blocs: [
    {
      type: "avis",
      id: "avis",
      avis: [
        etape("exactitude", "Exactitude", "S", "demande", "relire-requete-sql"),
        etape("performance", "Performance et verrous", "S", "demande", "relire-requete-sql"),
        etape("donnees", "Données sensibles", "S", "demande", "relire-requete-sql"),
      ],
      synthese: etape("synthese", "Synthèse", "S", "tous", "relire-requete-sql"),
    },
  ],
};

/** « À la suite » avec une pause : trois étapes M, la dernière reçoit tous les résultats précédents. */
const SUITE: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "b-standards", etape: etape("standards", "Standards", "M", "demande") },
    { type: "pause", id: "b-pause", message: "Vérifiez les points bloquants avant la suite." },
    { type: "etape", id: "b-securite", etape: etape("securite", "Sécurité", "M", "precedent") },
    { type: "etape", id: "b-consolidation", etape: etape("consolidation", "Consolidation", "M", "tous") },
  ],
};

interface ContexteOptions {
  ia?: (step: FlowStep) => StepIa | null;
  prix?: (model: string) => ModelPrice | null;
  observe?: (assistant: string, model: string) => { avgUsd: number | null; samples: number } | null;
  simultanees?: number;
  assistants?: ReadonlyMap<string, StepAssistant>;
}

function contexte(options: ContexteOptions = {}): FlowEstimateContext {
  return {
    assistants: options.assistants ?? ASSISTANTS,
    iaDe: options.ia ?? (() => IA_A),
    prix: options.prix ?? (() => PRIX_A),
    observe: options.observe ?? (() => null),
    simultanees: options.simultanees ?? 3,
  };
}

/** Égalité au centime près : les chiffres annoncés à l'utilisateur sont arrondis au centime (spéc. §6 l.1049). */
function proche(reel: number | null, attendu: number, message: string): void {
  assert.ok(reel !== null && Math.abs(reel - attendu) <= 0.01, `${message} : ${reel} au lieu de ${attendu}`);
}

// --- Chiffres de l'estimation ------------------------------------------------------------------------------------------------

describe("L36b · estimation : chiffres sur des prix fixes", () => {
  it("une étape M : « en général » = profil M, « au plus » = profil L, plafond = « au plus »", () => {
    const flow: Flow = { version: 1, blocs: [{ type: "etape", id: "b", etape: etape("une", "Une étape", "M", "demande") }] };
    const estimation = estimateFlow(flow, contexte());
    proche(estimation.typique, COUT_A.M, "typique");
    proche(estimation.maximum, COUT_A.L, "maximum");
    assert.equal(estimation.plafond, estimation.maximum);
    assert.equal(estimation.etapesFacturees, 1);
    assert.equal(estimation.relais, 0);
    proche(estimation.depassementUnAppel, COUT_A.M / TASK_PROFILES.M.calls, "dépassement d'un appel");
    assert.equal(estimation.parEtape.length, 1);
    assert.equal(estimation.parEtape[0]?.source, "profil");
    assert.equal(estimation.parEtape[0]?.model, IA_A.model);
    assert.equal(estimation.parEtape[0]?.modelLabel, "IA A");
    assert.equal(estimation.parEtape[0]?.choisieParEquipe, false);
  });

  it("« Avis indépendants » : quatre étapes S, trois relais, et les chiffres attendus", () => {
    const estimation = estimateFlow(AVIS, contexte());
    assert.equal(estimation.etapesFacturees, 4);
    proche(estimation.relais, 3 * COUT_A.relaisS, "relais");
    proche(estimation.typique, 4 * COUT_A.S + 3 * COUT_A.relaisS, "typique");
    proche(estimation.maximum, 4 * COUT_A.M + 3 * COUT_A.relaisS, "maximum");
    assert.equal(estimation.plafond, estimation.maximum);
  });

  it("« À la suite » : trois étapes M et trois relais (précédent, puis tous)", () => {
    const estimation = estimateFlow(SUITE, contexte());
    assert.equal(estimation.etapesFacturees, 3);
    proche(estimation.relais, 3 * COUT_A.relaisM, "relais");
    proche(estimation.typique, 3 * COUT_A.M + 3 * COUT_A.relaisM, "typique");
    proche(estimation.maximum, 3 * COUT_A.L + 3 * COUT_A.relaisM, "maximum");
  });

  it("un prix double double l'estimation", () => {
    const simple = estimateFlow(SUITE, contexte());
    const double = estimateFlow(SUITE, contexte({ prix: () => PRIX_B }));
    proche(double.typique, simple.typique * 2, "typique doublé");
    proche(double.maximum, simple.maximum * 2, "maximum doublé");
  });

  it("choix de la taille au-dessus : up() rend S → M, M → L, L → L × 2", () => {
    assert.deepEqual(up("S"), { taille: "M", facteur: 1 });
    assert.deepEqual(up("M"), { taille: "L", facteur: 1 });
    assert.deepEqual(up("L"), { taille: "L", facteur: 2 });
    proche(maximumTaskCost(PRIX_A, "S"), COUT_A.M, "maximum d'une étape S");
    proche(maximumTaskCost(PRIX_A, "M"), COUT_A.L, "maximum d'une étape M");
    proche(maximumTaskCost(PRIX_A, "L"), COUT_A.L * 2, "maximum d'une étape L");
  });

  it("le coût d'un appel est le profil divisé par son nombre d'appels", () => {
    proche(unAppelCost(PRIX_A, "S"), COUT_A.unAppelS, "un appel S");
    proche(unAppelCost(PRIX_A, "M"), COUT_A.M / TASK_PROFILES.M.calls, "un appel M");
  });
});

// --- Honnêteté « En général / au plus » (spéc. §6 l.1049) ---------------------------------------------------------------------

describe("L36b · honnêteté « En général / au plus »", () => {
  it("« au plus » n'est jamais plus bas que « en général », et le plafond est ce montant", () => {
    for (const flow of [AVIS, SUITE]) {
      for (const observee of [null, { avgUsd: 0.5, samples: 9 }]) {
        const estimation = estimateFlow(flow, contexte({ observe: () => observee }));
        assert.ok(estimation.typique <= estimation.maximum, `typique ${estimation.typique} > maximum ${estimation.maximum}`);
        assert.equal(estimation.plafond, estimation.maximum);
        for (const ligne of estimation.parEtape) assert.ok((ligne.typique ?? 0) <= (ligne.maximum ?? 0), ligne.stepId);
      }
    }
  });

  it("une moyenne observée au-dessus du profil relève l'estimation haute (sinon le plafond arrêterait sous « en général »)", () => {
    const flow: Flow = { version: 1, blocs: [{ type: "etape", id: "b", etape: etape("une", "Une étape", "S", "demande") }] };
    const estimation = estimateFlow(flow, contexte({ observe: () => ({ avgUsd: 4, samples: 12 }) }));
    proche(estimation.typique, 4, "typique observé");
    assert.ok(estimation.maximum >= estimation.typique, "le plafond reste au-dessus de « en général »");
  });

  it("« au plus » est un plafond d'arrêt, dépassable d'un appel par étape en cours seulement", () => {
    const estimation = estimateFlow(AVIS, contexte({ simultanees: 3 }));
    proche(estimation.depassementUnAppel, 3 * COUT_A.unAppelS, "dépassement de trois avis");
    const seul = estimateFlow(AVIS, contexte({ simultanees: 1 }));
    proche(seul.depassementUnAppel, COUT_A.unAppelS, "dépassement d'une seule étape en cours");
    assert.ok(estimation.depassementUnAppel < estimation.maximum, "un appel en cours ne double jamais le plafond");
  });

  it("le dépassement se compte sur les étapes les PLUS chères, pas sur les moins chères", () => {
    const inegal: Flow = {
      version: 1,
      blocs: [
        { type: "etape", id: "b1", etape: etape("bon-marche", "Bon marché", "S", "demande") },
        { type: "etape", id: "b2", etape: etape("cher", "Cher", "M", "demande") },
      ],
    };
    const ctx = contexte({
      simultanees: 1,
      ia: (step) => (step.id === "cher" ? IA_B : IA_A),
      prix: (model) => (model === IA_B.model ? PRIX_B : PRIX_A),
    });
    proche(estimateFlow(inegal, ctx).depassementUnAppel, unAppelCost(PRIX_B, "M"), "l'étape la plus chère");
    assert.ok(unAppelCost(PRIX_B, "M") > unAppelCost(PRIX_A, "S") + 0.01, "les deux appels se distinguent bien");
  });
});

// --- Relais comptés sur receivedFrom (T4) ---------------------------------------------------------------------------------------

describe("L36b · relais comptés sur receivedFrom de T4", () => {
  it("les jetons de sortie relayés sont ceux des profils : S 2 400, M 6 000, L 18 000", () => {
    assert.deepEqual({ ...RELAY_OUTPUT_TOKENS }, { S: 2400, M: 6000, L: 18000 });
    proche(relayCost("S", PRIX_A), COUT_A.relaisS, "relais d'une étape S");
    proche(relayCost("M", PRIX_A), COUT_A.relaisM, "relais d'une étape M");
    assert.ok(relayCost("L", PRIX_A) > relayCost("M", PRIX_A), "un résultat plus long coûte plus cher à relire");
  });

  it("un avis n'ajoute aucun relais, la synthèse en ajoute un par avis", () => {
    for (const avis of ["exactitude", "performance", "donnees"]) assert.deepEqual(receivedFrom(AVIS, avis), [], avis);
    assert.deepEqual(receivedFrom(AVIS, "synthese"), ["exactitude", "performance", "donnees"]);
    const troisAvis = estimateFlow(AVIS, contexte());
    proche(troisAvis.relais, 3 * COUT_A.relaisS, "trois relais");
    const deuxAvis: Flow = {
      version: 1,
      blocs: [
        {
          type: "avis",
          id: "avis",
          avis: [etape("a", "A", "S", "demande"), etape("b", "B", "S", "demande")],
          synthese: etape("synthese", "Synthèse", "S", "tous"),
        },
      ],
    };
    proche(estimateFlow(deuxAvis, contexte()).relais, 2 * COUT_A.relaisS, "deux relais");
  });

  it("le relais se paie sur la longueur du résultat PRODUIT, pas sur la taille du receveur", () => {
    const grosPuisPetit: Flow = {
      version: 1,
      blocs: [
        { type: "etape", id: "b1", etape: etape("gros", "Gros travail", "L", "demande") },
        { type: "etape", id: "b2", etape: etape("petit", "Petite reprise", "S", "precedent") },
      ],
    };
    const estimation = estimateFlow(grosPuisPetit, contexte());
    proche(estimation.relais, (RELAY_OUTPUT_TOKENS.L * PRIX_A.rates.input) / 1_000_000, "relais d'un résultat long");
    assert.ok(estimation.relais > 5 * COUT_A.relaisS, "un résultat de taille L coûte bien plus à relire qu'un résultat S");
  });

  it("une synthèse qui ne reçoit que la demande n'a aucun relais", () => {
    const sansRelais: Flow = {
      version: 1,
      blocs: [
        {
          type: "avis",
          id: "avis",
          avis: [etape("a", "A", "S", "demande"), etape("b", "B", "S", "demande")],
          synthese: etape("synthese", "Synthèse", "S", "demande"),
        },
      ],
    };
    assert.equal(estimateFlow(sansRelais, contexte()).relais, 0);
  });
});

// --- Moyenne observée -------------------------------------------------------------------------------------------------------------

describe("L36b · moyenne observée", () => {
  it(`la moyenne remplace le profil à partir de ${OBSERVED_MIN_SAMPLES} lancements, jamais à ${OBSERVED_MIN_SAMPLES - 1}`, () => {
    const flow: Flow = { version: 1, blocs: [{ type: "etape", id: "b", etape: etape("une", "Une étape", "S", "demande") }] };
    const quatre = estimateFlow(flow, contexte({ observe: () => ({ avgUsd: 0.25, samples: OBSERVED_MIN_SAMPLES - 1 }) }));
    assert.equal(quatre.parEtape[0]?.source, "profil");
    proche(quatre.typique, COUT_A.S, "profil retenu à quatre lancements");
    const cinq = estimateFlow(flow, contexte({ observe: () => ({ avgUsd: 0.25, samples: OBSERVED_MIN_SAMPLES }) }));
    assert.equal(cinq.parEtape[0]?.source, "observe");
    proche(cinq.typique, 0.25, "moyenne retenue à cinq lancements");
  });

  it("la moyenne est demandée pour le couple assistant / IA de l'étape", () => {
    const vus: Array<[string, string]> = [];
    estimateFlow(AVIS, contexte({ observe: (a, m) => (vus.push([a, m]), null) }));
    assert.deepEqual(new Set(vus.map(([a]) => a)), new Set(["relire-requete-sql"]));
    assert.deepEqual(new Set(vus.map(([, m]) => m)), new Set([IA_A.model]));
  });
});

// --- Étapes marquées ------------------------------------------------------------------------------------------------------------

describe("L36b · prix inconnu, IA absente, assistant retiré", () => {
  it("prix inconnu : l'étape est marquée, son estimation est nulle, le reste est estimé", () => {
    const estimation = estimateFlow(SUITE, contexte({ prix: (model) => (model === IA_B.model ? null : PRIX_A), ia: (step) => (step.id === "securite" ? IA_B : IA_A) }));
    const securite = estimation.parEtape.find((ligne) => ligne.stepId === "securite");
    assert.equal(securite?.typique, null);
    assert.equal(securite?.maximum, null);
    assert.equal(securite?.model, IA_B.model);
    proche(estimation.typique, 2 * COUT_A.M + 2 * COUT_A.relaisM, "les deux autres étapes restent estimées");
    assert.equal(estimation.etapesFacturees, 3);
  });

  it("IA absente : étape marquée et problème « niveau-indisponible » bloquant", () => {
    const ctx = contexte({ ia: (step) => (step.id === "securite" ? null : IA_A) });
    const estimation = estimateFlow(SUITE, ctx);
    assert.equal(estimation.parEtape.find((ligne) => ligne.stepId === "securite")?.typique, null);
    assert.deepEqual(estimateProblems(SUITE, ctx), [
      { code: "niveau-indisponible", bloc: "b-securite", etape: "securite", bloquant: true, nom: "relire-script" },
    ]);
    assert.deepEqual(estimateProblems(SUITE, contexte()), []);
  });

  it("assistant retiré du poste : l'étape n'est pas estimée", () => {
    const estimation = estimateFlow(SUITE, contexte({ assistants: new Map() }));
    assert.deepEqual(
      estimation.parEtape.map((ligne) => ligne.typique),
      [null, null, null],
    );
    assert.equal(estimation.typique, 0);
    assert.equal(estimation.relais, 0);
  });
});

// --- Coût du reste du chemin ------------------------------------------------------------------------------------------------------

describe("L36b · suiteEstimate (pause, relance)", () => {
  it("les étapes terminées sortent du compte, dans l'ordre de planSteps", () => {
    const reste = suiteEstimate(SUITE, { etapes: [{ stepId: "standards", state: "terminee" }] }, contexte());
    assert.deepEqual(
      reste.parEtape.map((ligne) => ligne.stepId),
      ["securite", "consolidation"],
    );
    assert.equal(reste.etapesFacturees, 2);
    // Le résultat de « standards », déjà terminée, reste à transmettre : ses relais sont recomptés.
    proche(reste.relais, 3 * COUT_A.relaisM, "relais recomptés par receivedFrom");
    proche(reste.typique, 2 * COUT_A.M + 3 * COUT_A.relaisM, "typique du reste");
  });

  it("aucune étape terminée : le reste vaut le chemin complet", () => {
    assert.deepEqual(suiteEstimate(SUITE, { etapes: [] }, contexte()), estimateFlow(SUITE, contexte()));
  });

  it("toutes les étapes terminées : plus rien à payer", () => {
    const fini = suiteEstimate(
      SUITE,
      { etapes: planSteps(SUITE).map((planned) => ({ stepId: planned.stepId, state: "terminee" as const })) },
      contexte(),
    );
    assert.equal(fini.typique, 0);
    assert.equal(fini.maximum, 0);
    assert.equal(fini.etapesFacturees, 0);
    assert.equal(fini.depassementUnAppel, 0);
  });

  it("une étape échouée reste à repayer à la relance", () => {
    const reste = suiteEstimate(SUITE, { etapes: [{ stepId: "standards", state: "echec" }] }, contexte());
    assert.equal(reste.etapesFacturees, 3);
  });
});

// --- Texte canonique de l'empreinte (D-eq-19) -----------------------------------------------------------------------------------

describe("L36b · texte canonique de l'empreinte", () => {
  const BASE: EstimateCanonicalInput = {
    flowSha256: "a".repeat(64),
    etapes: [
      { assistant: "relire-script", ia: "faux/ia-a", reflexion: null, tarifEntree: 1, tarifSortie: 10 },
      { assistant: "relire-script", ia: "faux/ia-a", reflexion: "poussee", tarifEntree: 1, tarifSortie: 10 },
    ],
    plafond: 0.45,
    teams: { maxCapUsd: 5, concurrentSteps: 3 },
    budget: { monthlyUsd: 20 },
  };
  const avec = (patch: Partial<EstimateCanonicalInput>): string => estimateCanonical({ ...BASE, ...patch });

  it("les clés sont triées et l'ordre d'écriture de l'entrée ne change rien", () => {
    const texte = estimateCanonical(BASE);
    const rangs = ["budget", "etapes", "flowSha256", "plafond", "teams"].map((cle) => texte.indexOf(`"${cle}"`));
    assert.deepEqual(rangs, [...rangs].sort((a, b) => a - b), texte);
    assert.ok(rangs.every((rang) => rang >= 0), texte);
    const desordre: EstimateCanonicalInput = {
      teams: { concurrentSteps: 3, maxCapUsd: 5 },
      plafond: 0.45,
      etapes: BASE.etapes,
      budget: { monthlyUsd: 20 },
      flowSha256: "a".repeat(64),
    };
    assert.equal(estimateCanonical(desordre), texte);
    assert.equal(estimateCanonical(BASE), texte, "deux appels donnent le même texte");
  });

  it("les montants sont écrits en centimes, sans flottant", () => {
    const texte = estimateCanonical(BASE);
    assert.match(texte, /"plafond":45/);
    assert.match(texte, /"monthlyUsd":2000/);
    assert.match(texte, /"maxCapUsd":500/);
    assert.equal(/\d\.\d/.test(texte), false, texte);
  });

  it("le texte change si une IA, une réflexion, un prix, un plafond ou la simultanéité change", () => {
    const base = estimateCanonical(BASE);
    const autreIa = avec({ etapes: [{ ...BASE.etapes[0]!, ia: "faux/ia-b" }, BASE.etapes[1]!] });
    const autreReflexion = avec({ etapes: [{ ...BASE.etapes[0]!, reflexion: "poussee" }, BASE.etapes[1]!] });
    const autrePrix = avec({ etapes: [{ ...BASE.etapes[0]!, tarifEntree: 2 }, BASE.etapes[1]!] });
    const autreSortie = avec({ etapes: [{ ...BASE.etapes[0]!, tarifSortie: 20 }, BASE.etapes[1]!] });
    const autrePlafond = avec({ plafond: 0.9 });
    const autreSimultaneite = avec({ teams: { maxCapUsd: 5, concurrentSteps: 2 } });
    const autreDeroule = avec({ flowSha256: "b".repeat(64) });
    const textes = [base, autreIa, autreReflexion, autrePrix, autreSortie, autrePlafond, autreSimultaneite, autreDeroule];
    assert.equal(new Set(textes).size, textes.length, "chaque changement donne un texte différent");
  });

  it("l'ordre des étapes compte : deux déroulés aux mêmes étapes inversées ne donnent pas le même texte", () => {
    assert.notEqual(avec({ etapes: [BASE.etapes[1]!, BASE.etapes[0]!] }), estimateCanonical(BASE));
  });

  it("canonicalSteps suit planSteps et reprend l'IA, la réflexion et les tarifs de l'estimation", () => {
    const etapes = canonicalSteps(AVIS, contexte({ ia: (step) => (step.id === "synthese" ? IA_B : IA_A), prix: (model) => (model === IA_B.model ? PRIX_B : PRIX_A) }));
    assert.deepEqual(
      etapes.map((e) => e.ia),
      [IA_A.model, IA_A.model, IA_A.model, IA_B.model],
    );
    assert.deepEqual(etapes.at(-1), { assistant: "relire-requete-sql", ia: IA_B.model, reflexion: "poussee", tarifEntree: 2, tarifSortie: 20 });
    assert.equal(etapes.length, planSteps(AVIS).length);
  });

  it("une étape sans IA ni prix passe en clair dans le texte, sans le rendre instable", () => {
    const etapes = canonicalSteps(SUITE, contexte({ ia: () => null }));
    assert.deepEqual(etapes[0], { assistant: "relire-script", ia: null, reflexion: null, tarifEntree: null, tarifSortie: null });
    assert.equal(estimateCanonical({ ...BASE, etapes }), estimateCanonical({ ...BASE, etapes: canonicalSteps(SUITE, contexte({ ia: () => null })) }));
  });
});

// --- Disposition et liste ----------------------------------------------------------------------------------------------------------

describe("L36b · disposition et liste, par forme", () => {
  it("« Avis indépendants » : une ligne pour les avis côte à côte, une ligne pour la synthèse", () => {
    const rows = layoutFlow(AVIS, NOMS);
    assert.deepEqual(
      rows.map((row) => [row.bloc, row.kind, row.cellules.length]),
      [
        ["avis", "avis", 3],
        ["avis", "synthese", 1],
      ],
    );
    assert.deepEqual(rows[0]?.recoitDe, []);
    assert.deepEqual(rows[1]?.recoitDe, ["exactitude", "performance", "donnees"]);
    assert.deepEqual(rows[0]?.cellules[0], { stepId: "exactitude", titre: "Exactitude", sousTitre: "Relire une requête SQL" });
  });

  it("« À la suite » : une ligne par bloc, la pause sans étape, les flèches par receivedFrom", () => {
    const rows = layoutFlow(SUITE, NOMS);
    assert.deepEqual(
      rows.map((row) => [row.bloc, row.kind, row.recoitDe]),
      [
        ["b-standards", "etape", []],
        ["b-pause", "pause", []],
        ["b-securite", "etape", ["standards"]],
        ["b-consolidation", "etape", ["standards", "securite"]],
      ],
    );
    const pause = rows[1];
    assert.equal(pause?.cellules[0]?.stepId, null);
    assert.equal(pause?.cellules[0]?.sousTitre, "Vérifiez les points bloquants avant la suite.");
  });

  it("bloc + genre distingue toujours deux lignes : c'est la clé que tient le schéma (L40a)", () => {
    for (const [nom, flow] of [
      ["avis", AVIS],
      ["suite", SUITE],
    ] as const) {
      const rows = layoutFlow(flow, NOMS);
      assert.equal(new Set(rows.map((row) => `${row.bloc}-${row.kind}`)).size, rows.length, nom);
    }
    // Contrôle discriminant : le bloc SEUL ne suffit pas, un bloc d'avis donne deux lignes qui le partagent.
    const avis = layoutFlow(AVIS, NOMS);
    assert.ok(new Set(avis.map((row) => row.bloc)).size < avis.length, "un bloc d'avis donne deux lignes du même bloc");
  });

  it("les identifiants de la disposition sont ceux du déroulé, sans coordonnée écrite à la main", () => {
    const cellules = layoutFlow(SUITE, NOMS).flatMap((row) => row.cellules.map((cellule) => cellule.stepId));
    assert.deepEqual(
      cellules.filter((id) => id !== null),
      planSteps(SUITE).map((planned) => planned.stepId),
    );
  });

  it("un assistant inconnu de la table garde son nom", () => {
    assert.equal(layoutFlow(SUITE, new Map())[0]?.cellules[0]?.sousTitre, "relire-script");
  });

  it("la liste dit le rang, le titre, l'assistant et ce que l'étape reçoit", () => {
    const liste = flowAsList(SUITE, NOMS);
    assert.equal(liste.length, 4);
    assert.equal(liste[0], "Étape 1 : Standards · Relire un script · Seulement votre demande");
    assert.equal(liste[1], "Pause pour vérifier : Vérifiez les points bloquants avant la suite.");
    assert.equal(liste[2], "Étape 2 : Sécurité · Relire un script · Votre demande et le résultat du bloc précédent");
    assert.equal(liste[3], "Étape 3 : Consolidation · Relire un script · Votre demande et tous les résultats précédents");
  });

  it("un bloc d'avis est annoncé par « En même temps », puis chaque avis et la synthèse", () => {
    const liste = flowAsList(AVIS, NOMS);
    assert.equal(liste[0], "En même temps : Exactitude, Performance et verrous, Données sensibles");
    assert.equal(liste.length, 5);
    assert.ok(liste[1]?.startsWith("Étape 1 : Exactitude · Relire une requête SQL"), liste[1]);
    assert.ok(liste[4]?.startsWith("Étape 4 : Synthèse · Relire une requête SQL"), liste[4]);
  });
});

// --- Union des droits --------------------------------------------------------------------------------------------------------------

describe("L36b · union des droits sous le plancher ETAPE", () => {
  const idsInterdits = ["modification", "commande", "internet", "delegation"];

  it("un assistant de lecture : aucune ligne « oui » sur la modification, les commandes, Internet ni la délégation", () => {
    const lignes = rightsUnion(AVIS, ASSISTANTS);
    assert.ok(lignes.length > 0);
    for (const id of idsInterdits) {
      const ligne = lignes.find((l) => l.id === id);
      assert.ok(ligne, `ligne ${id} absente`);
      assert.equal(ligne?.kind, "non", `${id} : ${ligne?.text}`);
      assert.equal(ligne?.danger, false, id);
    }
    assert.equal(lignes.find((l) => l.id === "lecture")?.kind, "oui");
    assert.equal(
      lignes.some((ligne) => ligne.danger),
      false,
      "aucune ligne en rouge pour une équipe d'assistants de lecture",
    );
  });

  it("un assistant très permissif reste tenu par le plancher ETAPE", () => {
    const permissifs = new Map([["permissif", assistant("permissif", "Permissif", REGLES_PERMISSIVES)]]);
    const flow: Flow = { version: 1, blocs: [{ type: "etape", id: "b", etape: etape("une", "Une étape", "M", "demande", "permissif") }] };
    const lignes = rightsUnion(flow, permissifs);
    for (const id of idsInterdits) assert.equal(lignes.find((l) => l.id === id)?.kind, "non", id);
    assert.equal(lignes.find((l) => l.id === "hors-dossier")?.kind, "non");
    // Le plancher ETAPE ne refuse pas les .env (décision n° 5 : ils restent « avec votre accord » par les règles de
    // l'assistant). L'union le DIT, au lieu de le taire : la seule ligne en rouge porte sur la lecture.
    assert.deepEqual(
      lignes.filter((ligne) => ligne.danger).map((ligne) => ligne.id),
      ["env"],
    );
  });

  it("l'union garde, pour chaque ligne, ce que l'étape la plus permissive peut faire", () => {
    const sansLecture: Rule[] = [...REGLES_LECTURE.filter((regle) => regle.permission !== "read"), { permission: "read", pattern: "*", action: "deny" }];
    const flow: Flow = {
      version: 1,
      blocs: [
        { type: "etape", id: "b1", etape: etape("lit", "Lit", "S", "demande", "lecteur") },
        { type: "etape", id: "b2", etape: etape("aveugle", "Aveugle", "S", "precedent", "aveugle") },
      ],
    };
    const deux = new Map([
      ["lecteur", assistant("lecteur", "Lecteur")],
      ["aveugle", assistant("aveugle", "Aveugle", sansLecture)],
    ]);
    assert.equal(rightsUnion(flow, deux).find((l) => l.id === "lecture")?.kind, "oui");
    const seulAveugle: Flow = { version: 1, blocs: [{ type: "etape", id: "b2", etape: etape("aveugle", "Aveugle", "S", "demande", "aveugle") }] };
    assert.equal(rightsUnion(seulAveugle, deux).find((l) => l.id === "lecture")?.kind, "non");
  });

  it("aucune ligne du nombre d'actions dans l'union (chaque étape a la sienne)", () => {
    assert.equal(
      rightsUnion(AVIS, ASSISTANTS).some((ligne) => ligne.id === "actions"),
      false,
    );
  });

  it("un assistant absent de la table n'ajoute aucun droit", () => {
    assert.deepEqual(rightsUnion(AVIS, new Map()), []);
  });
});

// --- Pureté et indépendance de vague --------------------------------------------------------------------------------------------

describe("L36b · pureté et indépendance de vague", () => {
  const FICHIERS = ["flow-estimate.ts", "flow-layout.ts"];
  const source = (nom: string): string => fs.readFileSync(path.join(import.meta.dirname, "shared", nom), "utf8");

  it("ni module node, ni process, ni horloge, ni aléa, ni réseau", () => {
    for (const nom of FICHIERS) {
      const texte = source(nom);
      assert.equal(texte.includes('"node:'), false, nom);
      assert.equal(/\bprocess\./.test(texte), false, nom);
      assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bperformance\./.test(texte), false, nom);
    }
  });

  it("aucun import de flow.ts (L36a, écrit en parallèle) : L36b ne dépend que de T4", () => {
    for (const nom of FICHIERS) {
      const imports = [...source(nom).matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      assert.equal(imports.includes("./flow.ts"), false, nom);
      for (const spec of imports) assert.ok(spec === "../pricing.ts" || /^\.\/[\w.-]+\.ts$/.test(spec), `${nom} : ${spec}`);
    }
  });

  it("l'ordre et la sémantique de « recoit » ne sont pas réécrits ici", () => {
    for (const nom of FICHIERS) {
      const texte = source(nom);
      assert.equal(/\bfunction\s+(planSteps|receivedFrom)\b/.test(texte), false, nom);
    }
  });

  it("deux appels sur la même entrée rendent la même chose, et l'entrée n'est pas modifiée", () => {
    const flow = structuredClone(SUITE);
    const avant = JSON.stringify(flow);
    assert.deepEqual(estimateFlow(flow, contexte()), estimateFlow(flow, contexte()));
    assert.deepEqual(layoutFlow(flow, NOMS), layoutFlow(flow, NOMS));
    assert.deepEqual(flowAsList(flow, NOMS), flowAsList(flow, NOMS));
    assert.deepEqual(rightsUnion(flow, ASSISTANTS), rightsUnion(flow, ASSISTANTS));
    assert.equal(JSON.stringify(flow), avant, "le déroulé n'est pas modifié");
  });
});
