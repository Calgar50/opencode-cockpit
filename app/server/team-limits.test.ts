// Tests T4 (plan d'exécution it4 §4.1.1, §4.1.6) : contrats purs des équipes. Listes des unions fermées (sans doublon, égales à
// la fiche), bornes figées, transitions (un état final ne régresse jamais, à la compilation et à l'exécution), ordre d'exécution
// (planSteps), sémantique de `recoit` (receivedFrom : aucun avis ne reçoit un autre avis), RunRole « etape » et son libellé,
// pureté de team-types.ts et team-limits.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { describeTurn, type RunRole, type RunSource, type Turn } from "./shared/assistant-rules.ts";
import {
  canTransition,
  FLOW_BLOCK_TYPES,
  FLOW_LIMITS,
  FLOW_PROBLEM_CODES,
  FLOW_VERSION,
  planSteps,
  receivedFrom,
  STEP_ID_RE,
  STEP_INPUTS,
  TEAM_CONFIRMATIONS,
  TEAM_ERROR_CODES,
  TEAM_GUARD_CODES,
  TEAM_ID_RE,
  TEAM_RUN_CAUSES,
  TEAM_RUN_STATES,
  TEAM_RUN_TRANSITIONS,
  TEAM_STEP_STATES,
  TEAM_STEP_TRANSITIONS,
  TEAM_TEXT_LIMITS,
} from "./shared/team-limits.ts";
import type { Flow, FlowBlock, FlowStep, StepInput, TeamRunTransitions, TeamStepTransitions } from "./shared/team-types.ts";

const step = (id: string, recoit: StepInput = "demande", assistant = "relire-script"): FlowStep => ({
  id,
  titre: `Étape ${id}`,
  assistant,
  niveau: null,
  taille: "S",
  consigne: "",
  recoit,
});
const etape = (id: string, recoit: StepInput = "demande"): FlowBlock => ({ type: "etape", id: `b-${id}`, etape: step(id, recoit) });
const avis = (id: string, ids: string[], synthese: FlowStep = step(`${id}-synthese`, "tous")): FlowBlock => ({
  type: "avis",
  id,
  avis: ids.map((a) => step(a)),
  synthese,
});
const pause = (id: string): FlowBlock => ({ type: "pause", id, message: "Vérifiez avant la suite." });
const flow = (...blocs: FlowBlock[]): Flow => ({ version: FLOW_VERSION, blocs });

describe("équipes : listes des unions fermées", () => {
  it("chaque liste est figée, sans doublon, et égale à la fiche T4", () => {
    const expected: Record<string, readonly string[]> = {
      // 5b (L42a) : « relecture » et « aiguillage » s'ajoutent aux trois formes de l'itération 4, avant « pause ».
      FLOW_BLOCK_TYPES: ["etape", "avis", "relecture", "aiguillage", "pause"],
      STEP_INPUTS: ["demande", "precedent", "tous"],
      TEAM_CONFIRMATIONS: ["workspace", "secret", "plafond", "budget"],
      FLOW_PROBLEM_CODES: [
        "vide",
        "trop-de-blocs",
        "trop-d-etapes",
        "pause-mal-placee",
        "avis-nombre",
        "synthese-requise",
        "id-invalide",
        "id-double",
        "titre",
        "consigne-longue",
        "recoit-invalide",
        "assistant-absent",
        "assistant-interne",
        "assistant-non-proposable",
        "delegue",
        "internet",
        "autorise-sans-demander",
        "propose-reporte",
        "personnalise",
        "niveau-avance",
        "niveau-indisponible",
        // 5b (L42a) : relecture, aiguillage, liens entre étapes et méthodes des étapes.
        "aiguillage-premier",
        "specialistes",
        "relecteur-distinct",
        "meme-famille",
        "lien-arriere",
        "lien-avis",
        "lien-avance",
        "methodes",
      ],
      TEAM_RUN_STATES: [
        "preparation",
        "en-cours",
        "attente-verification",
        "attente-budget",
        "attente-modification",
        // 5b (L42a) : l'aiguilleur a proposé, le lancement attend VOTRE confirmation.
        "attente-choix",
        "terminee",
        "arretee",
        "echec",
        "interrompue",
        "plafond",
      ],
      // 5b (L42a) : « non-choisi », état final d'un spécialiste ou d'une synthèse écarté par le choix.
      TEAM_STEP_STATES: ["prevue", "en-file", "en-cours", "attente-accord", "terminee", "echec", "arretee", "interrompue", "plafond", "non-lancee", "non-choisi"],
      TEAM_RUN_CAUSES: ["vous", "equipe", "plafond", "echec", "rechargement", "redemarrage-cockpit", "budget", "modification", "pause", "changement"],
      TEAM_ERROR_CODES: [
        "invalid",
        "not-found",
        "equipe-invalide",
        "mode-avance",
        "equipes-simple-fermees",
        "forbidden-directory",
        "fichier-refuse",
        "fournisseur-refuse",
        "ia-indisponible",
        "assistant-absent",
        "equipe-en-cours",
        "conversation-occupee",
        "instance-salle",
        "trop-d-equipes",
        "budget-guard",
        "budget-insuffisant",
        "plafond-trop-haut",
        "plafond-a-confirmer",
        "confirmation-workspace",
        "secret-probable",
        "estimation-perimee",
        "profondeur-delegation",
        "extension-configuree",
        "dossier-externe",
        "plancher-etape",
        "etape-consultable",
        "etat-incompatible",
        // <c5:choix-invalide> Ajouté par le train de la vague 2 de la 5b (demande de contrat de L42b).
        "choix-invalide",
        // </c5:choix-invalide>
        // <c5:reprise-redemarrage>
        // Ajouté par la clôture de la 5b (D-5b-1) : réponse à une pause dont l'estimation a été perdue au redémarrage du cockpit.
        "reestimation-requise",
        // </c5:reprise-redemarrage>
        "pas-relancable",
        "deja-ajoute",
        "confirmation-requise",
        "opencode-injoignable",
        "a-venir",
      ],
      TEAM_GUARD_CODES: ["sessions-busy", "redemarrage-en-cours", "reponses-non-verifiables"],
    };
    const lists: Record<string, readonly string[]> = {
      FLOW_BLOCK_TYPES,
      STEP_INPUTS,
      TEAM_CONFIRMATIONS,
      FLOW_PROBLEM_CODES,
      TEAM_RUN_STATES,
      TEAM_STEP_STATES,
      TEAM_RUN_CAUSES,
      TEAM_ERROR_CODES,
      TEAM_GUARD_CODES,
    };
    assert.deepEqual(Object.keys(lists), Object.keys(expected));
    for (const [name, list] of Object.entries(lists)) {
      assert.ok(Object.isFrozen(list), `${name} figée`);
      assert.equal(new Set(list).size, list.length, `${name} sans doublon`);
      assert.deepEqual([...list], expected[name], name);
    }
    // TeamGuardCode : rendus tels quels par la garde de la 1.1, jamais des TeamErrorCode ; « salle-coupee » : code de la carte.
    for (const code of TEAM_GUARD_CODES) assert.equal(TEAM_ERROR_CODES.includes(code as never), false, code);
    assert.equal(TEAM_ERROR_CODES.includes("salle-coupee" as never), false);
  });

  it("bornes figées : FLOW_LIMITS, TEAM_TEXT_LIMITS, identifiants", () => {
    assert.ok(Object.isFrozen(FLOW_LIMITS));
    assert.deepEqual(
      { ...FLOW_LIMITS },
      {
        blocsTravail: 5,
        etapes: 12,
        avisMin: 2,
        avisMax: 5,
        simultanees: 3,
        consigne: 4000,
        relaisCaracteres: 24000,
        demande: 20000,
        fichiers: 20,
        precision: 1000,
        // 5b (L42a) : bornes des méthodes d'étape, de l'aiguillage et de la relecture (comparées à construction-constants.ts).
        methodesParEtape: 2,
        specialistesMin: 2,
        specialistesMax: 8,
        toursMax: 2,
        choixMax: 2,
      },
    );
    assert.throws(() => {
      (FLOW_LIMITS as { etapes: number }).etapes = 99;
    }, TypeError);
    assert.ok(Object.isFrozen(TEAM_TEXT_LIMITS) && Object.isFrozen(TEAM_TEXT_LIMITS.titreEtape) && Object.isFrozen(TEAM_TEXT_LIMITS.titreEquipe));
    assert.deepEqual(TEAM_TEXT_LIMITS.titreEtape, { min: 2, max: 60 });
    assert.deepEqual(TEAM_TEXT_LIMITS.titreEquipe, { min: 3, max: 80 });
    assert.equal(TEAM_TEXT_LIMITS.apercuOctets, 65536);
    assert.equal(FLOW_VERSION, 1);
    for (const ok of ["a", "revue-sql", "a".repeat(24)]) assert.ok(STEP_ID_RE.test(ok), ok);
    for (const bad of ["", "A", "a_b", "a".repeat(25), "a b", "../x"]) assert.equal(STEP_ID_RE.test(bad), false, bad);
    for (const ok of ["revue-sql", "a".repeat(40)]) assert.ok(TEAM_ID_RE.test(ok), ok);
    for (const bad of ["a".repeat(41), "Revue", "x/y", ""]) assert.equal(TEAM_ID_RE.test(bad), false, bad);
  });
});

describe("équipes : transitions", () => {
  it("vérification de type : un état final n'a aucune sortie, un lancement arrêté en chemin n'a que relance ou fermeture", () => {
    const finals: [TeamRunTransitions["terminee"], TeamRunTransitions["arretee"], TeamStepTransitions["terminee"], TeamStepTransitions["non-lancee"]] = [[], [], [], []];
    assert.deepEqual(finals, [[], [], [], []]);
    // @ts-expect-error : un lancement terminé ne régresse jamais.
    const regression: TeamRunTransitions["terminee"] = ["en-cours"];
    // @ts-expect-error : une étape terminée ne régresse jamais (une relance crée une nouvelle tentative).
    const stepRegression: TeamStepTransitions["terminee"] = ["en-cours"];
    // @ts-expect-error : un lancement interrompu ne repart que par « preparation » (relance) ou se ferme (« arretee »).
    const skip: TeamRunTransitions["interrompue"] = ["en-cours"];
    // @ts-expect-error : aucun état ne se cite lui-même.
    const self: TeamRunTransitions["en-cours"] = ["en-cours"];
    assert.ok([regression, stepRegression, skip, self].every(Array.isArray));
  });

  it("à l'exécution (canTransition) : tables figées et complètes, aucun état final ne régresse, états inconnus refusés", () => {
    const check = (kind: "run" | "step", table: Readonly<Record<string, readonly string[]>>, states: readonly string[], finals: readonly string[]) => {
      assert.ok(Object.isFrozen(table), `${kind} : table figée`);
      assert.deepEqual(Object.keys(table), [...states], `${kind} : un état par clé, dans l'ordre de l'union`);
      for (const from of states) {
        const targets = table[from] ?? [];
        assert.ok(Object.isFrozen(targets), `${kind} ${from} : liste figée`);
        assert.equal(new Set(targets).size, targets.length, `${kind} ${from} : sans doublon`);
        for (const to of states) assert.equal(canTransition(kind, from, to), targets.includes(to), `${kind} ${from} → ${to}`);
        assert.equal(canTransition(kind, from, from), false, `${kind} ${from} → lui-même`);
        for (const to of targets) assert.ok(states.includes(to), `${kind} ${from} → ${to} connu`);
      }
      for (const final of finals) {
        assert.deepEqual(table[final], [], `${kind} ${final} : final`);
        for (const to of states) assert.equal(canTransition(kind, final, to), false, `${kind} ${final} → ${to}`);
      }
      assert.equal(canTransition(kind, "inconnu", states[0] ?? ""), false);
      assert.equal(canTransition(kind, states[0] ?? "", "inconnu"), false);
      assert.equal(canTransition(kind, "__proto__", "toString"), false);
    };
    check("run", TEAM_RUN_TRANSITIONS, TEAM_RUN_STATES, ["terminee", "arretee"]);
    // 5b (L42a) : « non-choisi » est final comme « non-lancee » — une étape écartée n'a rien envoyé, rien à reprendre.
    check("step", TEAM_STEP_TRANSITIONS, TEAM_STEP_STATES, ["terminee", "echec", "arretee", "interrompue", "plafond", "non-lancee", "non-choisi"]);
    for (const stopped of ["echec", "interrompue", "plafond"]) assert.deepEqual([...(TEAM_RUN_TRANSITIONS[stopped as "echec"] ?? [])], ["preparation", "arretee"]);
    // Parcours attendus par les fiches L37b et L37c.
    for (const [from, to] of [
      ["preparation", "en-cours"],
      ["preparation", "attente-verification"],
      ["en-cours", "terminee"],
      ["en-cours", "attente-verification"],
      ["attente-verification", "en-cours"],
      ["en-cours", "interrompue"],
      ["interrompue", "preparation"],
      ["plafond", "arretee"],
    ]) {
      assert.ok(canTransition("run", from ?? "", to ?? ""), `${from} → ${to}`);
    }
    assert.equal(canTransition("run", "terminee", "preparation"), false);
    assert.equal(canTransition("run", "arretee", "preparation"), false);
    assert.ok(canTransition("step", "prevue", "non-lancee"));
    assert.ok(canTransition("step", "en-file", "non-lancee"));
    assert.ok(canTransition("step", "en-cours", "attente-accord"));
    assert.equal(canTransition("step", "interrompue", "en-cours"), false);
  });
});

describe("équipes : planSteps", () => {
  it("« À la suite » avec pause : une entrée par étape, pause sans entrée, blocIndex compte la pause, ordre à partir de 1", () => {
    const chain = flow(etape("standards"), pause("verif"), etape("securite", "precedent"), etape("nuit", "precedent"), etape("consolidation", "tous"));
    assert.deepEqual(planSteps(chain), [
      { stepId: "standards", blocId: "b-standards", blocIndex: 0, ordre: 1, tour: 1, role: "etape" },
      { stepId: "securite", blocId: "b-securite", blocIndex: 2, ordre: 2, tour: 1, role: "etape" },
      { stepId: "nuit", blocId: "b-nuit", blocIndex: 3, ordre: 3, tour: 1, role: "etape" },
      { stepId: "consolidation", blocId: "b-consolidation", blocIndex: 4, ordre: 4, tour: 1, role: "etape" },
    ]);
  });

  it("avis à 5 : les avis dans l'ordre écrit puis la synthèse ; identifiants et ordre stables", () => {
    const five = flow(etape("cadrage"), avis("revue", ["a1", "a2", "a3", "a4", "a5"], step("synthese", "tous")), etape("rapport", "precedent"));
    const planned = planSteps(five);
    assert.deepEqual(
      planned.map((p) => [p.stepId, p.blocId, p.blocIndex, p.ordre, p.role]),
      [
        ["cadrage", "b-cadrage", 0, 1, "etape"],
        ["a1", "revue", 1, 2, "avis"],
        ["a2", "revue", 1, 3, "avis"],
        ["a3", "revue", 1, 4, "avis"],
        ["a4", "revue", 1, 5, "avis"],
        ["a5", "revue", 1, 6, "avis"],
        ["synthese", "revue", 1, 7, "synthese"],
        ["rapport", "b-rapport", 2, 8, "etape"],
      ],
    );
    assert.deepEqual(planSteps(five), planned, "même déroulé, même plan");
    assert.ok(planned.every((p) => p.tour === 1));
    assert.deepEqual(planSteps(flow()), []);
    assert.deepEqual(planSteps(flow(pause("seule"))), []);
  });
});

describe("équipes : receivedFrom (sémantique de recoit)", () => {
  const sql = flow(avis("revue-sql", ["exactitude", "performance", "donnees"], step("synthese", "tous")));
  const chain = flow(etape("standards"), pause("verif"), etape("securite", "precedent"), etape("nuit", "precedent"), etape("consolidation", "tous"));

  it("demande → [] ; precedent → étape du bloc de travail précédent (pause sautée), [] pour le premier bloc", () => {
    assert.deepEqual(receivedFrom(chain, "standards"), []);
    assert.deepEqual(receivedFrom(chain, "securite"), ["standards"], "la pause ne compte pas");
    assert.deepEqual(receivedFrom(chain, "nuit"), ["securite"]);
    assert.deepEqual(receivedFrom(flow(etape("seule", "precedent")), "seule"), []);
    assert.deepEqual(receivedFrom(flow(pause("p"), etape("apres", "precedent")), "apres"), []);
  });

  it("precedent après un bloc d'avis → sa synthèse ; tous → toutes les étapes antérieures, dans l'ordre de planSteps", () => {
    const mixed = flow(etape("cadrage"), avis("revue", ["a1", "a2"], step("synthese", "tous")), etape("suite", "precedent"), etape("bilan", "tous"));
    assert.deepEqual(receivedFrom(mixed, "suite"), ["synthese"]);
    assert.deepEqual(receivedFrom(mixed, "bilan"), ["cadrage", "a1", "a2", "synthese", "suite"]);
    assert.deepEqual(receivedFrom(chain, "consolidation"), ["standards", "securite", "nuit"]);
  });

  it("synthèse : les avis de son bloc (tous) ; aucun avis ne reçoit le résultat d'un autre avis", () => {
    assert.deepEqual(receivedFrom(sql, "synthese"), ["exactitude", "performance", "donnees"]);
    for (const id of ["exactitude", "performance", "donnees"]) assert.deepEqual(receivedFrom(sql, id), []);
    // Un avis qui reçoit « tous » ou « precedent » ne voit que les blocs au-dessus du sien, jamais ses voisins.
    const odd: FlowBlock = { type: "avis", id: "revue", avis: [step("x"), step("y", "tous"), step("z", "precedent")], synthese: step("s", "precedent") };
    const withBefore = flow(etape("avant"), odd);
    assert.deepEqual(receivedFrom(withBefore, "y"), ["avant"]);
    assert.deepEqual(receivedFrom(withBefore, "z"), ["avant"]);
    assert.deepEqual(receivedFrom(withBefore, "s"), ["avant"], "synthèse « precedent » : bloc de travail au-dessus du sien");
    assert.throws(() => receivedFrom(sql, "inconnue"), RangeError);
  });

  it("propriété sur 300 déroulés aléatoires (graine fixe) : aucun avis ne reçoit un autre avis ; résultats reçus = étapes antérieures, dans l'ordre", () => {
    let seed = 20260919;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    for (let n = 0; n < 300; n++) {
      let counter = 0;
      const id = () => `s${counter++}`;
      const blocs: FlowBlock[] = [];
      const count = 1 + Math.floor(random() * 6);
      for (let b = 0; b < count; b++) {
        const kind = pick(["etape", "avis", "pause"] as const);
        if (kind === "etape") blocs.push({ type: "etape", id: `b${b}`, etape: step(id(), pick(STEP_INPUTS)) });
        else if (kind === "pause") blocs.push(pause(`b${b}`));
        else {
          const members = Array.from({ length: 2 + Math.floor(random() * 4) }, () => step(id(), pick(STEP_INPUTS)));
          blocs.push({ type: "avis", id: `b${b}`, avis: members, synthese: step(id(), pick(STEP_INPUTS)) });
        }
      }
      const f = flow(...blocs);
      const order = planSteps(f).map((p) => p.stepId);
      for (const planned of planSteps(f)) {
        const got = receivedFrom(f, planned.stepId);
        const position = order.indexOf(planned.stepId);
        assert.ok(
          got.every((g) => order.indexOf(g) < position),
          `${planned.stepId} ne reçoit que des étapes antérieures`,
        );
        assert.deepEqual(
          got,
          [...got].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
          "ordre de planSteps",
        );
        const block = f.blocs[planned.blocIndex];
        if (planned.role === "avis" && block?.type === "avis") {
          const siblings = block.avis.map((a) => a.id).filter((a) => a !== planned.stepId);
          assert.equal(
            got.some((g) => siblings.includes(g)),
            false,
            `avis ${planned.stepId} : aucun autre avis de son bloc`,
          );
        }
      }
    }
  });
});

describe("équipes : RunRole « etape » et pureté", () => {
  it("RunRole accepte « etape », RunSource « equipe » ; ROLE_LABELS couvre toute l'union (« Étape d'équipe »)", () => {
    const roles: Record<RunRole, true> = { message: true, raccourci: true, delegue: true, reprise: true, etape: true };
    const source: RunSource = "equipe";
    const labelOf = (role: RunRole) => {
      const turn: Turn = {
        send: { model: { providerID: "github-copilot", modelID: "gpt-5-mini" } },
        runs: [{ role, model: "github-copilot/gpt-5-mini", variant: null, source }],
        lock: null,
        problems: [],
      };
      const display = describeTurn(turn, {
        catalog: [],
        agentTitle: (name) => name,
        tierOfModel: () => null,
        priceOf: () => null,
        size: "M",
        command: null,
        chatTier: null,
      });
      return display.runs[0]?.roleLabel ?? "";
    };
    for (const role of Object.keys(roles) as RunRole[]) assert.ok(labelOf(role).length > 0, role);
    assert.equal(labelOf("etape"), "Étape d'équipe");
  });

  it("team-types.ts sans code exécutable ; team-limits.ts sans import de valeur, imports limités à ./team-types.ts", () => {
    const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "shared", file), "utf8");
    const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const types = read("team-types.ts");
    assert.equal(withoutComments(stripTypeScriptTypes(types)).trim(), "");
    assert.equal(/^\s*import (?!type\b)/m.test(types), false);
    const limits = read("team-limits.ts");
    const imports = [...limits.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => [m[1]?.trim() ?? "", m[2]]);
    assert.deepEqual(imports, [["type", "./team-types.ts"]]);
    for (const source of [types, limits]) {
      assert.equal(source.includes('"node:'), false);
      assert.equal(/\bprocess\./.test(source), false);
    }
  });
});
