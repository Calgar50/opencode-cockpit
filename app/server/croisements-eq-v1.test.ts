// Tests de croisement du train it4 V1 (plan d'exécution it4 §2.4, §5.2 ; propriété de l'intégrateur). Les six paquets de la
// vague ont été écrits en parallèle, sans se lire : L36a (grammaire, ordonnanceur, message d'étape, livrable), L36b (estimation,
// empreinte, disposition, liste, droits), L37s (magasin et fidélité du faux), L38a (lanceur et feuille), L38b (cartes) et L40a
// (onglet Équipes). Ce qu'aucun d'eux ne peut prouver seul :
//   1. ORDRE ET RELAIS : `planSteps` et `receivedFrom` de team-limits.ts (T4) sont consommés TELS QUELS par les trois modules
//      purs du déroulé — aucun autre ordre d'exécution, aucune autre lecture de `recoit` n'y est définie (recherche de symboles) ;
//   2. MESSAGE ↔ COÛT : sur les deux exemples (Q3, textes de T4t), les résultats que `stepMessage` (L36a) transmet réellement
//      sont EXACTEMENT ceux que le coût des relais d'`estimateFlow` (L36b) facture, au centime près ; un avis ne reçoit rien,
//      la synthèse reçoit tous les avis (spéc. §6 l.1034) ;
//   3. BORNES ET RECONSTITUTION : `stepMessage` respecte `FLOW_LIMITS.relaisCaracteres` et l'annonce ; l'aller-retour
//      `requestFromStepMessage(stepMessage(…))` rend la demande et les pièces jointes à l'identique (D-eq-17, D-eq-27) ;
//   4. TEXTES : les en-têtes d'injection recopiés PAR VALEUR dans flow.ts (L36a) sont ceux de `partout.injection` de T4t, à
//      l'octet ; « au plus » n'est jamais annoncé sans l'arrêt qui le tient (`plafond === maximum`, P3) ;
//   5. MAGASIN ↔ MIGRATION 4 : toute colonne des quatre tables d'équipes est connue du magasin (L37s) ou listée ici comme non
//      écrite en V1 ; les états écrits sont dans les unions de T4 ; aucun fichier d'équipes n'asserte un numéro de migration
//      écrit (A2) ; `runs` de `/activity` a la forme de `TeamRunSummary` ;
//   6. FAUX ↔ PLANCHER RÉEL : sous `buildFloor("ETAPE")` posé sur les règles effectives d'un assistant de lecture du catalogue,
//      les outils intégrés du faux se réduisent à `glob`, `grep` et `read` (ME-2, report MX-EQ) ;
//   7. WEB : les trois périmètres neufs passent par `api-teams.ts` (aucun `fetch` écrit à la main), n'écrivent aucun montant par
//      `formatUsd` (report MX-EQ §4.2) et portent chacun leur bloc `forced-colors` (contraste forcé, grille de V1).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { openMemoryDb } from "./db.ts";
import type { ModelPrice } from "./pricing.ts";
import { assistantPermission, effectiveAgentRules, type Rule, type TaskSize } from "./shared/assistant-rules.ts";
import {
  estimateFlow,
  type FlowEstimateContext,
  relayCost,
  type StepIa,
} from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow } from "./shared/flow-layout.ts";
import { INJECTION_TEXTS, nextActions, requestFromStepMessage, STEP_SECTIONS, STEP_TEXTS, stepMessage, validateFlow } from "./shared/flow.ts";
import { buildFloor, disabledTools } from "./shared/session-floors.ts";
import { FLOW_LIMITS, planSteps, receivedFrom, TEAM_RUN_STATES, TEAM_STEP_STATES } from "./shared/team-limits.ts";
import * as equipes from "./shared/team-texts.ts";
import type { Flow, FlowStep, StepAssistant, TeamRunSummary, TeamStepState } from "./shared/team-types.ts";
import { ACTIVE_RUN_STATES, createTeamStore, RESULT_EXCERPT_MAX, type StepInput as StepRowInput } from "./team-store.ts";
import { builtinTools } from "./test-support/fake-opencode.ts";

const E = equipes.TEXTES.partout;
const SERVER = import.meta.dirname;
const APP = path.join(SERVER, "..");
const lire = (relatif: string): string => fs.readFileSync(path.join(APP, relatif), "utf8");

// --- Montage : les deux exemples (Q3, réponse A11) montés comme au croisement de V0 --------------------------------------------

const step = (id: string, text: { titre: string; consigne: string }, recoit: FlowStep["recoit"], taille: TaskSize, assistant: string): FlowStep => ({
  id,
  titre: text.titre,
  assistant,
  niveau: null,
  taille,
  consigne: text.consigne,
  recoit,
});

const sql = E.exemples["revue-sql"];
const script = E.exemples["relecture-script"];

/** « Revue SQL sur réplica » : trois avis indépendants puis une synthèse qui les reçoit tous. */
const REVUE_SQL: Flow = {
  version: 1,
  blocs: [
    {
      type: "avis",
      id: "avis",
      avis: [
        step("exactitude", sql.etapes.exactitude, "demande", "S", "relire-requete-sql"),
        step("performance", sql.etapes.performance, "demande", "S", "relire-requete-sql"),
        step("donnees-sensibles", sql.etapes["donnees-sensibles"], "demande", "S", "relire-requete-sql"),
      ],
      synthese: step("synthese", sql.etapes.synthese, "tous", "S", "relire-requete-sql"),
    },
  ],
};

/** « Chaîne de relecture de script » : à la suite, avec une pause après la première étape. */
const RELECTURE_SCRIPT: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "standards", etape: step("standards", script.etapes.standards, "demande", "M", "relire-script") },
    { type: "pause", id: "verifier", message: script.pause },
    { type: "etape", id: "securite", etape: step("securite", script.etapes.securite, "precedent", "M", "relire-script") },
    { type: "etape", id: "exploitation-nuit", etape: step("exploitation-nuit", script.etapes["exploitation-nuit"], "precedent", "M", "relire-script") },
    { type: "etape", id: "consolidation", etape: step("consolidation", script.etapes.consolidation, "tous", "S", "relire-script") },
  ],
};

const EXEMPLES: ReadonlyArray<{ nom: string; flow: Flow }> = [
  { nom: "revue-sql", flow: REVUE_SQL },
  { nom: "relecture-script", flow: RELECTURE_SCRIPT },
];

/** Prix fixe : 1 $ d'entrée et 10 $ de sortie par million de jetons (mêmes chiffres que les tests de L36b). */
const PRIX: ModelPrice = { rates: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 10 } };
const IA: StepIa = { model: "faux/ia", variant: null, niveau: null, label: "IA d'essai" };
const REGLES_LECTURE: Rule[] = effectiveAgentRules(undefined, assistantPermission("lecture", false, []));

function assistant(name: string): StepAssistant {
  return { name, title: name, origin: "catalogue", rights: "lecture", mode: "all", hidden: false, rules: REGLES_LECTURE, model: IA.model, available: true, steps: 40, taille: "M" };
}

const ASSISTANTS = new Map<string, StepAssistant>([
  ["relire-requete-sql", assistant("relire-requete-sql")],
  ["relire-script", assistant("relire-script")],
]);

const CONTEXTE: FlowEstimateContext = {
  assistants: ASSISTANTS,
  iaDe: () => IA,
  prix: () => PRIX,
  observe: () => null,
  simultanees: FLOW_LIMITS.simultanees,
};

/** Étapes du déroulé par identifiant, pour retrouver une taille ou un titre sans réécrire l'ordre. */
function stepsById(flow: Flow): Map<string, FlowStep> {
  const out = new Map<string, FlowStep>();
  for (const bloc of flow.blocs) {
    if (bloc.type === "etape") out.set(bloc.etape.id, bloc.etape);
    else if (bloc.type === "avis") for (const s of [...bloc.avis, bloc.synthese]) out.set(s.id, s);
  }
  return out;
}

/** Message d'une étape, avec des résultats disponibles pour TOUTES les autres étapes : seuls les reçus doivent y paraître. */
function messagePourToutes(flow: Flow, stepId: string, runId = "run-croisement"): string {
  const steps = stepsById(flow);
  const plan = planSteps(flow);
  const rang = plan.findIndex((p) => p.stepId === stepId);
  return stepMessage(flow, stepId, {
    runId,
    tour: 1,
    tentative: 1,
    equipe: "Équipe d'essai",
    total: plan.length,
    n: rang + 1,
    demande: "Relis la migration de la nuit.",
    fichiers: ["scripts/migration.ps1"],
    precisions: [],
    resultats: [...steps.values()]
      .filter((s) => s.id !== stepId)
      .map((s) => ({ stepId: s.id, titre: s.titre, assistant: s.assistant, ia: "IA d'essai", texte: `Résultat de ${s.id}.`, corrige: false })),
  });
}

/** Identifiants des étapes dont le résultat est réellement encadré dans un message (lecture du texte produit). */
function relayesDansLeTexte(flow: Flow, texte: string): string[] {
  const steps = stepsById(flow);
  const vus: string[] = [];
  for (const [id, s] of steps) if (texte.includes(`<<<résultat de l'étape « ${s.titre} »`)) vus.push(id);
  return vus.sort();
}

// --- 1. planSteps et receivedFrom de T4 consommés tels quels --------------------------------------------------------------------

describe("croisement it4 V1 : l'ordre et les relais restent ceux de T4", () => {
  const MODULES = ["server/shared/flow.ts", "server/shared/flow-estimate.ts", "server/shared/flow-layout.ts"];

  it("aucun des trois modules ne redéfinit planSteps ni receivedFrom ; tous les trois les importent de team-limits.ts", () => {
    for (const relatif of MODULES) {
      const source = lire(relatif);
      for (const symbole of ["planSteps", "receivedFrom"]) {
        assert.equal(new RegExp(`(function|const|let|var)\\s+${symbole}\\b`).test(source), false, `${relatif} redéfinit ${symbole}`);
      }
      const imports = source.match(/import\s+\{[^}]*\}\s+from\s+"\.\/team-limits\.ts";/s)?.[0] ?? "";
      assert.ok(imports.includes("planSteps") || imports.includes("receivedFrom"), `${relatif} n'importe pas l'ordre de T4`);
    }
    // Contrôle discriminant : la recherche verrait une redéfinition.
    assert.equal(/(function|const|let|var)\s+planSteps\b/.test("function planSteps(flow) {}"), true);
  });

  it("le coût et les liens ne relisent jamais « recoit » : seule la phrase affichée par T4t le nomme", () => {
    // flow.ts a deux lectures légitimes et nommées : la grammaire (valeur permise) et D-eq-18 (la demande ne va qu'aux étapes
    // qui reçoivent « demande »). flow-estimate.ts, qui compte les relais, n'a aucune raison de lire ce champ ; flow-layout.ts
    // ne le lit que pour choisir le libellé « ce que l'étape reçoit » de T4t (recoitChoix), jamais pour relier deux étapes.
    const code = (relatif: string): string[] =>
      lire(relatif)
        .split("\n")
        .filter((ligne) => !/^\s*(\/\/|\*|\/\*)/.test(ligne));
    assert.equal(code("server/shared/flow-estimate.ts").some((ligne) => /\.recoit\b/.test(ligne)), false, "flow-estimate.ts relit « recoit » au lieu de receivedFrom");
    for (const ligne of code("server/shared/flow-layout.ts").filter((l) => /\.recoit\b/.test(l))) {
      assert.match(ligne, /recoitChoix|choix\[/, `flow-layout.ts relit « recoit » hors du libellé de T4t — ${ligne.trim()}`);
    }
    // Les liens rendus par la disposition viennent de receivedFrom, pas d'une lecture locale de « recoit ».
    assert.match(lire("server/shared/flow-layout.ts"), /recoitDe:\s*receivedFrom\(/);
    assert.ok(/\.recoit\b/.test(lire("server/shared/flow.ts")), "contrôle discriminant : flow.ts, lui, lit « recoit »");
  });

  it("l'ordre rendu par nextActions est celui de planSteps, la simultanéité ne dépasse jamais FLOW_LIMITS.simultanees", () => {
    for (const { nom, flow } of EXEMPLES) {
      const attendu = planSteps(flow).map((p) => p.stepId);
      const lances: string[] = [];
      const etapes: Record<string, TeamStepState> = {};
      const pausesFranchies: string[] = [];
      let fini = false;
      for (let boucle = 0; boucle < 40 && !fini; boucle += 1) {
        const actions = nextActions(flow, { etapes, pausesFranchies }, { simultanees: FLOW_LIMITS.simultanees });
        const aLancer = actions.flatMap((a) => ("lancer" in a ? [a.lancer] : []));
        assert.ok(aLancer.length <= FLOW_LIMITS.simultanees, `${nom} : ${aLancer.length} étapes lancées ensemble`);
        const pause = actions.find((a): a is { pause: string } => "pause" in a);
        if (pause) {
          pausesFranchies.push(pause.pause);
          continue;
        }
        if (actions.some((a) => "fin" in a)) {
          fini = true;
          continue;
        }
        assert.ok(aLancer.length > 0, `${nom} : l'ordonnanceur ne rend plus rien`);
        for (const id of aLancer) {
          lances.push(id);
          etapes[id] = "terminee";
        }
      }
      assert.ok(fini, `${nom} : le déroulé ne s'achève pas`);
      assert.deepEqual(lances, attendu, nom);
      // La pause de l'exemple « à la suite » est bien franchie, et une seule fois.
      assert.deepEqual(pausesFranchies, flow.blocs.filter((b) => b.type === "pause").map((b) => b.id), nom);
    }
  });
});

// --- 2. Message d'étape (L36a) ↔ coût des relais (L36b) ------------------------------------------------------------------------

describe("croisement it4 V1 : les résultats transmis sont ceux que le coût des relais facture", () => {
  it("sur les deux exemples, chaque message porte exactement les résultats de receivedFrom (avis indépendants, synthèse servie)", () => {
    for (const { nom, flow } of EXEMPLES) {
      for (const { stepId } of planSteps(flow)) {
        assert.deepEqual(relayesDansLeTexte(flow, messagePourToutes(flow, stepId)), [...receivedFrom(flow, stepId)].sort(), `${nom} / ${stepId}`);
      }
    }
    // Honnêteté §6 l.1034 : aucun avis ne voit le travail d'un autre avis ; la synthèse les voit tous.
    for (const avis of ["exactitude", "performance", "donnees-sensibles"]) {
      assert.deepEqual(relayesDansLeTexte(REVUE_SQL, messagePourToutes(REVUE_SQL, avis)), []);
    }
    assert.deepEqual(relayesDansLeTexte(REVUE_SQL, messagePourToutes(REVUE_SQL, "synthese")), ["donnees-sensibles", "exactitude", "performance"]);
  });

  it("le total des relais compté par estimateFlow = celui recalculé sur les textes réellement écrits (± 0,01 $)", () => {
    for (const { nom, flow } of EXEMPLES) {
      const steps = stepsById(flow);
      let attendu = 0;
      for (const { stepId } of planSteps(flow)) {
        for (const source of relayesDansLeTexte(flow, messagePourToutes(flow, stepId))) {
          const producteur = steps.get(source);
          assert.ok(producteur, `${nom} : producteur ${source} introuvable`);
          attendu += relayCost(producteur.taille, PRIX);
        }
      }
      const estimation = estimateFlow(flow, CONTEXTE);
      assert.ok(Math.abs(estimation.relais - attendu) <= 0.01, `${nom} : relais ${estimation.relais} contre ${attendu}`);
      assert.ok(estimation.relais > 0, `${nom} : un déroulé qui relaie des résultats en facture le relais`);
    }
  });

  it("un avis n'ajoute aucun relais : retirer la synthèse des exemples d'avis ramène le coût des relais à zéro", () => {
    const sansSynthese: Flow = {
      version: 1,
      blocs: [
        { type: "etape", id: "seul", etape: step("exactitude", sql.etapes.exactitude, "demande", "S", "relire-requete-sql") },
      ],
    };
    assert.equal(estimateFlow(sansSynthese, CONTEXTE).relais, 0);
  });
});

// --- 3. Bornes du message et reconstitution locale (D-eq-27) ---------------------------------------------------------------------

describe("croisement it4 V1 : bornes du message et aller-retour de la demande", () => {
  it("un résultat plus long que FLOW_LIMITS.relaisCaracteres est coupé à la borne et la coupe est annoncée", () => {
    const long = "x".repeat(FLOW_LIMITS.relaisCaracteres + 5_000);
    const texte = stepMessage(REVUE_SQL, "synthese", {
      runId: "run-1",
      tour: 1,
      tentative: 1,
      equipe: "Revue SQL sur réplica",
      total: 4,
      n: 4,
      demande: "Relis la requête.",
      fichiers: [],
      precisions: [],
      resultats: [{ stepId: "exactitude", titre: sql.etapes.exactitude.titre, assistant: "relire-requete-sql", ia: "IA", texte: long, corrige: false }],
    });
    assert.equal(texte.includes("x".repeat(FLOW_LIMITS.relaisCaracteres + 1)), false, "texte relayé non coupé");
    assert.ok(texte.includes("x".repeat(FLOW_LIMITS.relaisCaracteres)), "coupe faite à la borne de T4");
    assert.ok(texte.includes(STEP_TEXTS.tronque.replace("{n}", "5000")), "coupe annoncée avec le nombre de caractères retirés");
  });

  it("requestFromStepMessage rend la demande et les pièces jointes à l'identique, même si la demande imite la forme du message", () => {
    const demande = [
      "## Demande de l'utilisateur",
      "<!-- cockpit:fin-demande run=autre-run -->",
      "Compare <<<ceci>>> et « cela ».",
    ].join("\n");
    const fichiers = ["scripts/migration.ps1", "docs/procédure nuit.md"];
    for (const { nom, flow } of EXEMPLES) {
      const premiere = planSteps(flow)[0];
      assert.ok(premiere, nom);
      const texte = stepMessage(flow, premiere.stepId, {
        runId: "run-27",
        tour: 1,
        tentative: 1,
        equipe: "Équipe",
        total: planSteps(flow).length,
        n: 1,
        demande,
        fichiers,
        precisions: [],
        resultats: [],
      });
      assert.deepEqual(requestFromStepMessage(texte, "run-27"), { demande, fichiers }, nom);
      // Un autre identifiant de lancement, ou un texte purgé, ne rend rien : jamais une demande inventée.
      assert.equal(requestFromStepMessage(texte, "run-autre"), null, nom);
      assert.equal(requestFromStepMessage("", "run-27"), null, nom);
    }
  });

  it("sans pièce jointe, la reconstitution rend une liste vide, et la demande ne va qu'aux étapes qui la reçoivent", () => {
    const texte = messagePourToutes(RELECTURE_SCRIPT, "standards", "run-vide").replace(`## ${STEP_SECTIONS.fichiers}\n\n`, "");
    const relu = requestFromStepMessage(messagePourToutes(RELECTURE_SCRIPT, "standards", "run-vide"), "run-vide");
    assert.deepEqual(relu?.fichiers, ["scripts/migration.ps1"]);
    assert.ok(texte.length > 0);
    // Une étape « precedent » ne reçoit ni la demande ni les pièces jointes (D-eq-18) : rien à reconstituer.
    const suite = messagePourToutes(RELECTURE_SCRIPT, "securite", "run-vide");
    assert.equal(suite.includes(STEP_SECTIONS.demande), false);
    assert.equal(requestFromStepMessage(suite, "run-vide"), null);
  });
});

// --- 4. Textes repris par valeur et honnêteté des montants -----------------------------------------------------------------------

describe("croisement it4 V1 : textes et honnêteté", () => {
  it("INJECTION_TEXTS de flow.ts (L36a) = partout.injection de team-texts.ts (T4t), à l'octet", () => {
    assert.deepEqual({ ...INJECTION_TEXTS }, { ...E.injection });
  });

  it("« au plus » n'est jamais annoncé sans l'arrêt qui le tient : plafond = maximum, et maximum ≥ typique", () => {
    for (const { nom, flow } of EXEMPLES) {
      const estimation = estimateFlow(flow, CONTEXTE);
      assert.equal(estimation.plafond, estimation.maximum, nom);
      assert.ok(estimation.maximum >= estimation.typique, nom);
      assert.equal(estimation.etapesFacturees, planSteps(flow).length, nom);
      for (const ligne of estimation.parEtape) {
        assert.ok((ligne.maximum ?? 0) >= (ligne.typique ?? 0), `${nom} / ${ligne.stepId}`);
      }
      // Le dépassement possible est chiffré à part, jamais fondu dans le plafond.
      assert.ok(estimation.depassementUnAppel > 0 && estimation.depassementUnAppel < estimation.plafond, nom);
    }
  });

  it("les deux exemples passent la grammaire de L36a dans les deux modes, et leur liste lue nomme chaque étape", () => {
    const noms = new Map([...ASSISTANTS].map(([name, a]) => [name, a.title]));
    for (const { nom, flow } of EXEMPLES) {
      for (const mode of ["simple", "avance"] as const) {
        assert.deepEqual(validateFlow(flow, { assistants: [...ASSISTANTS.values()], mode, niveauDisponible: () => true }), [], `${nom} / ${mode}`);
      }
      const liste = flowAsList(flow, noms);
      for (const { stepId } of planSteps(flow)) {
        const titre = stepsById(flow).get(stepId)?.titre ?? "";
        assert.ok(liste.some((ligne) => ligne.includes(titre)), `${nom} : « ${titre} » absent de la liste lue`);
      }
      assert.ok(layoutFlow(flow, noms).length > 0, nom);
    }
  });
});

// --- 5. Magasin (L37s) ↔ migration 4 (db.ts) ------------------------------------------------------------------------------------

describe("croisement it4 V1 : magasin, migration 4 et activité", () => {
  const TABLES = ["teams", "team_runs", "team_run_steps", "team_run_events"];
  /**
   * Colonnes de la migration 4 qu'aucune écriture de la V1 ne remplit, avec leur propriétaire annoncé. Toute autre colonne doit
   * être citée par team-store.ts : une colonne oubliée par le magasin tombe ici.
   */
  const NON_ECRITES: Readonly<Record<string, readonly string[]>> = {
    teams: [],
    team_runs: ["facultatifs"], // blocs facultatifs : forme d'une itération ultérieure (D-eq-10), colonne laissée à son défaut.
    team_run_steps: [],
    team_run_events: ["id"], // clé technique AUTOINCREMENT.
  };

  const colonnes = (table: string): string[] => {
    const db = openMemoryDb();
    try {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
    } finally {
      db.close();
    }
  };

  it("toute colonne des quatre tables d'équipes est connue du magasin, ou listée ici comme non écrite en V1", () => {
    const source = lire("server/team-store.ts");
    for (const table of TABLES) {
      const noms = colonnes(table);
      assert.ok(noms.length > 0, `${table} absente de la base`);
      assert.ok(source.includes(table), `${table} inconnue du magasin`);
      for (const colonne of noms) {
        if ((NON_ECRITES[table] ?? []).includes(colonne)) continue;
        assert.ok(new RegExp(`\\b${colonne}\\b`).test(source), `${table}.${colonne} n'est citée nulle part dans team-store.ts`);
      }
    }
    // Contrôle discriminant : une colonne inventée ne serait pas citée.
    assert.equal(/\bcolonne_inventee\b/.test(source), false);
  });

  it("les états écrits par le magasin sont ceux des unions de T4 ; un état hors union est refusé sans rien écrire", () => {
    for (const etat of ACTIVE_RUN_STATES) assert.ok((TEAM_RUN_STATES as readonly string[]).includes(etat), etat);
    const db = openMemoryDb();
    try {
      const store = createTeamStore({ db, now: () => 1_700_000_000_000 });
      store.teams.put({ id: "revue-sql", titre: "Revue SQL sur réplica", description: "Trois avis puis une synthèse.", flow: REVUE_SQL, origine: "exemple", exempleId: "revue-sql", exempleVersion: 1, avance: false });
      const run = store.runs.create({
        id: "run-croisement",
        teamId: "revue-sql",
        teamTitre: "Revue SQL sur réplica",
        flow: REVUE_SQL,
        flowSha256: "a".repeat(64),
        estimateSha256: "b".repeat(64),
        modeUi: "avance",
        rootId: "ses_root",
        directory: "C:/projet",
        estimate: { typique: 0.2, maximum: 0.4 },
        plafond: 0.4,
      });
      assert.equal(run.state, "preparation");
      assert.ok((TEAM_RUN_STATES as readonly string[]).includes(run.state));
      assert.equal(store.runs.setState(run.id, "etat-inconnu" as never), false, "un état hors union est refusé");
      assert.equal(store.runs.get(run.id)?.state, "preparation", "un refus n'écrit rien");

      const plan = planSteps(REVUE_SQL);
      for (const [index, planned] of plan.entries()) {
        const entree: StepRowInput = { runId: run.id, stepId: planned.stepId, tour: 1, tentative: 1, ordre: planned.ordre, blocIndex: planned.blocIndex, titre: stepsById(REVUE_SQL).get(planned.stepId)?.titre ?? planned.stepId, agent: "relire-requete-sql", state: index === 0 ? "en-file" : "prevue" };
        const ligne = store.steps.create(entree);
        assert.ok((TEAM_STEP_STATES as readonly string[]).includes(ligne.state));
      }
      // `runs` de /activity : la forme exacte de TeamRunSummary (routes-activity.ts, L37s).
      const resumes = store.summaries("ses_root");
      assert.equal(resumes.length, 1);
      const premier = resumes[0] as TeamRunSummary;
      assert.deepEqual(Object.keys(premier).sort(), ["cause", "cost", "createdAt", "endedAt", "etapesPrevues", "etapesTerminees", "id", "plafond", "state", "titre"]);
      assert.equal(premier.etapesPrevues, plan.length);
      assert.equal(premier.etapesTerminees, 0);
      assert.deepEqual(store.summaries("ses_autre"), [], "les résumés d'une autre conversation ne fuient pas");
    } finally {
      db.close();
    }
  });

  it("routes-activity.ts rend les résumés du magasin, et l'extrait gardé reste borné", () => {
    const source = lire("server/routes-activity.ts");
    assert.match(source, /runs:\s*createTeamStore\(\{\s*db\s*\}\)\.summaries\(rootId\)/);
    assert.ok(RESULT_EXCERPT_MAX <= 2_000, "l'extrait gardé reste court (U2, D-eq-26)");
  });

  it("aucun fichier d'équipes n'asserte un numéro de migration écrit (A2 : user_version >= 5 ou === MIGRATIONS.length)", () => {
    const fichiers = fs
      .readdirSync(SERVER)
      // Le fichier courant est écarté : ses contrôles discriminants portent les deux formes interdites, écrites en toutes lettres.
      .filter((nom) => /^(team-|flow|croisements-eq-|web-team|web-equipes|migration-eq)/.test(nom) && nom.endsWith(".ts") && nom !== path.basename(import.meta.filename));
    assert.ok(fichiers.length >= 5, "les fichiers d'équipes sont bien découverts");
    // Une ligne qui parle de la version de la base et pose un NOMBRE ÉCRIT, soit en comparaison, soit en argument attendu.
    const asserteUnNombre = (ligne: string): boolean => /user_version|version\(db\)/.test(ligne) && (/===?\s*\d/.test(ligne) || /,\s*\d+\s*[,)]/.test(ligne));
    for (const nom of fichiers) {
      const source = fs.readFileSync(path.join(SERVER, nom), "utf8");
      for (const ligne of source.split("\n")) {
        assert.equal(asserteUnNombre(ligne), false, `${nom} asserte un numéro écrit — ${ligne.trim()}`);
      }
    }
    // Contrôles discriminants : les deux formes écrites sont vues, les deux formes permises par A2 ne le sont pas.
    assert.equal(asserteUnNombre("assert.equal(row.user_version, 5);"), true);
    assert.equal(asserteUnNombre("assert.equal(v, 5) // user_version === 5"), true);
    assert.equal(asserteUnNombre('assert.equal(version(db), MIGRATIONS.length, "base neuve");'), false);
    assert.equal(asserteUnNombre("assert.ok(version(db) >= 5);"), false);
  });
});

// --- 6. Faux opencode (L37s) ↔ plancher ETAPE réel (it1) --------------------------------------------------------------------------

describe("croisement it4 V1 : plancher ETAPE et outils du faux (ME-2)", () => {
  it("sous le plancher ETAPE posé sur les règles d'un assistant de lecture, il ne reste que glob, grep et read", () => {
    const outils = builtinTools("gpt-5-mini");
    const plancher = buildFloor("ETAPE", { agentRules: REGLES_LECTURE });
    const coupes = new Set(disabledTools([...REGLES_LECTURE, ...plancher], outils));
    assert.deepEqual(outils.filter((outil) => !coupes.has(outil)).sort(), ["glob", "grep", "read"]);
    // Témoin : sans le plancher, les seules règles de l'assistant en laissent strictement plus — le plancher fait le travail.
    const temoin = outils.filter((outil) => !new Set(disabledTools(REGLES_LECTURE, outils)).has(outil));
    assert.ok(temoin.length > 3, `témoin sans plancher : ${temoin.join(" ")}`);
    for (const garde of ["glob", "grep", "read"]) assert.ok(temoin.includes(garde), garde);
    // Les outils d'écriture et de délégation sont coupés dans les deux cas : le plancher ne les rouvre jamais.
    for (const interdit of ["edit", "write", "bash", "task", "webfetch"]) assert.equal(coupes.has(interdit) || !outils.includes(interdit), true, interdit);
  });

  it("le faux sait scripter une session créée plus tard et connaît la consigne « MAXIMUM STEPS » (report MX-EQ)", () => {
    const source = lire("server/test-support/fake-opencode.ts");
    assert.match(source, /scriptWhen\(predicat: \(session: FakeSession\) => boolean/);
    assert.match(source, /MAXIMUM STEPS REACHED/);
  });
});

// --- 7. Web : api-teams, montants et contraste forcé ------------------------------------------------------------------------------

describe("croisement it4 V1 : les trois périmètres web neufs", () => {
  const DOSSIERS = ["web/pages/chat/team", "web/pages/assistants/teams"];
  const sources = (): Array<{ nom: string; texte: string }> =>
    DOSSIERS.flatMap((dossier) =>
      fs
        .readdirSync(path.join(APP, dossier))
        .filter((nom) => nom.endsWith(".ts") || nom.endsWith(".tsx"))
        .map((nom) => ({ nom: `${dossier}/${nom}`, texte: lire(`${dossier}/${nom}`) })),
    );

  it("aucun appel réseau écrit à la main : tout passe par api-teams.ts (CSRF, en-tête de confirmation, ApiError)", () => {
    const fichiers = sources();
    assert.ok(fichiers.length >= 10, "les fichiers des deux périmètres sont découverts");
    for (const { nom, texte } of fichiers) {
      assert.equal(/\bfetch\s*\(/.test(texte), false, `${nom} appelle fetch directement`);
      assert.equal(/x-cockpit-csrf/i.test(texte), false, `${nom} écrit un en-tête CSRF à la main`);
    }
    const appelants = fichiers.filter(({ texte }) => /from "[^"]*api-teams\.ts"/.test(texte));
    assert.ok(appelants.length >= 3, "les composants qui appellent le serveur passent par api-teams.ts");
  });

  it("aucun montant écrit par formatUsd : les gabarits de T4t sont remplis par montant() ou remplir() (report MX-EQ §4.2)", () => {
    // Les commentaires citent la règle : seul le code exécuté est jugé.
    const sansCommentaire = (texte: string): string =>
      texte
        .split("\n")
        .filter((ligne) => !/^\s*(\/\/|\*|\/\*)/.test(ligne))
        .join("\n");
    for (const { nom, texte } of sources()) {
      assert.equal(/\bformatUsd\s*\(/.test(sansCommentaire(texte)), false, `${nom} écrit un montant par formatUsd`);
    }
    assert.equal(/\bformatUsd\s*\(/.test(sansCommentaire("const x = formatUsd(1);")), true, "contrôle discriminant");
  });

  it("chaque feuille de style neuve porte son bloc forced-colors (focus Highlight, icônes CanvasText) et aucune animation infinie", () => {
    const feuilles = ["web/pages/chat/team/team-launch.css", "web/pages/chat/team/team-cards.css", "web/pages/assistants/teams/teams.css"];
    for (const relatif of feuilles) {
      const texte = lire(relatif);
      const bloc = texte.slice(texte.indexOf("@media (forced-colors: active)"));
      assert.ok(texte.includes("@media (forced-colors: active)"), `${relatif} sans bloc de contraste forcé`);
      assert.ok(bloc.length > 100, `${relatif} : bloc de contraste forcé vide`);
      assert.ok(/Highlight/.test(bloc), `${relatif} : focus non porté par Highlight`);
      assert.ok(/CanvasText/.test(bloc), `${relatif} : traits non portés par CanvasText`);
      assert.equal(/animation[^;]*infinite/.test(texte), false, `${relatif} : animation infinie`);
      if (/transition/.test(texte)) assert.ok(texte.includes("prefers-reduced-motion"), `${relatif} : mouvement hors du garde-fou`);
    }
  });
});
