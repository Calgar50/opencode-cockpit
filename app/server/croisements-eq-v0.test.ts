// Tests de croisement du train it4 V0 (plan d'exécution it4 §2.4, §5.2 ; propriété de l'intégrateur). Les quatre paquets de la
// vague ont été écrits en parallèle, sans se lire : T4 (contrats, câblage), T4t (textes, listes de codes recopiées de la fiche
// L39a et du plan), T4w (emplacements web) et L39a (carte, module pur). Ce qu'aucun d'eux ne peut prouver seul :
//   1. textes ↔ unions : les clés de team-texts sont les unions exécutables de team-limits (T4), sans clé pour TeamGuardCode ; les
//      autres listes fermées que T4t a rangées (pauses, formes, blocs, `recoit`, tailles, raisons de fraîcheur) aussi ; les bornes
//      écrites en chiffres dans les phrases sont celles de FLOW_LIMITS et TEAM_TEXT_LIMITS (écart 5 de T4t) ;
//   2. exemples (Q3) : les étapes écrites par T4t, montées comme le dit la fiche L37a, sont des déroulés que planSteps et
//      receivedFrom (T4) ordonnent et relient comme prévu, dans les bornes de T4 ;
//   3. carte ↔ textes : clés d'agent-map-texts = listes fermées d'agent-map.ts, identiques à la fiche L39a ; toute arête dérivée
//      a une phrase qui nomme sa source et sa cible et dit qui l'applique (dont le raccourci qui n'est pas une sous-tâche, écart 2
//      de L39a, corrigé au train) ; toute note, tout avertissement et tout genre ont leur phrase ; carte ↔ route (L39a × T4w) :
//      tout identifiant de nœud dérivé (mapNodeId) passe par l'adresse de la carte et revient identique, homonymes et noms longs
//      compris (C §9.8 element=<id> ; correction du train de V0, relecture 4-vague-0) ;
//   4. contrats ↔ migration 4 : formes des lignes de contracts-eq = colonnes créées par db.ts ;
//   5. harnais avec les modules 1.1 de production : sans `equipes` = avec tous les squelettes (proxy, rechargement,
//      réalignement, arrêt, DELETE /api/archive/:id) ; c11.reloadBusy composé seulement si teamRunner est installé ; arrêt décoré
//      seulement avec teamGuards ;
//   6. MX-EQ (report du train de V0) : ME-8 → la phrase d'aide de Q6 reste vraie tant que le plancher ETAPE refuse les sorties
//      complètes enregistrées ; ME-2 → une étape ne garde que glob, grep et read de la liste témoin mesurée ; constantes U1 et
//      D-eq-14 inchangées.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { assistantsHref, assistantsViewOf, parseRoute, parseRouteQuery } from "../web/lib/router.ts";
import { AssistantService } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { EventRow, RunRow, StepRow, TeamRow, TeamRunnerPort } from "./contracts-eq.ts";
import { openMemoryDb } from "./db.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import {
  AGENT_MAP_ERROR_CODES,
  type AgentMapInput,
  deriveAgentMap,
  MAP_EDGE_CODES,
  MAP_NODE_KINDS,
  MAP_NOTE_CODES,
  MAP_VOUS_ID,
  MAP_WARNING_CODES,
  type MapEdge,
  mapAsList,
  mapNodeId,
  neighbours,
} from "./shared/agent-map.ts";
import * as carte from "./shared/agent-map-texts.ts";
import { evaluate, type Rule, type TaskSize, truncateGlob } from "./shared/assistant-rules.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import { buildFloor, disabledTools } from "./shared/session-floors.ts";
import {
  FLOW_BLOCK_TYPES,
  FLOW_LIMITS,
  FLOW_PROBLEM_CODES,
  planSteps,
  receivedFrom,
  STEP_ID_RE,
  STEP_INPUTS,
  TEAM_ERROR_CODES,
  TEAM_GUARD_CODES,
  TEAM_ID_RE,
  TEAM_RUN_CAUSES,
  TEAM_RUN_STATES,
  TEAM_STEP_STATES,
  TEAM_TEXT_LIMITS,
} from "./shared/team-limits.ts";
import * as equipes from "./shared/team-texts.ts";
import type { Flow, FlowStep, StepInput, TeamPauseView, TeamView } from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { neutralRunner } from "./team-runner.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULE_ORDER, EQUIPES_INJECTION, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";

const E = equipes.TEXTES.partout;
const C = carte.TEXTES.partout;

const sorted = (values: Iterable<string>) => [...values].sort();
const keysOf = (record: object) => sorted(Object.keys(record));

/** Toutes les clés d'un arbre de textes, à toute profondeur. */
function allKeys(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => [key, ...allKeys(value)]);
}

/** Nombres écrits dans une phrase ; « 4 000 » compte pour 4000. */
function numbers(text: string): number[] {
  const joined = text.replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, "$1");
  return [...joined.matchAll(/\d+/g)].map((match) => Number(match[0] ?? ""));
}

// --- 1. Textes des équipes ↔ unions de team-types (T4t × T4) ------------------------------------------------------------------

describe("croisement it4 V0 : clés de team-texts = unions de team-types", () => {
  it("TeamErrorCode, FlowProblemCode, TeamRunState, TeamStepState, TeamRunCause : une phrase par membre, ni plus ni moins", () => {
    assert.deepEqual(keysOf(E.erreurs), sorted(TEAM_ERROR_CODES));
    assert.deepEqual(keysOf(E.problemes), sorted(FLOW_PROBLEM_CODES));
    assert.deepEqual(keysOf(E.etatsEquipe), sorted(TEAM_RUN_STATES));
    assert.deepEqual(keysOf(E.etatsEtape), sorted(TEAM_STEP_STATES));
    assert.deepEqual(keysOf(E.causes), sorted(TEAM_RUN_CAUSES));
    for (const code of TEAM_ERROR_CODES) assert.notEqual(equipes.phraseErreur(code), E.erreurInconnue, code);
    for (const code of FLOW_PROBLEM_CODES) assert.notEqual(equipes.phraseProbleme(code), null, code);
  });

  it("aucune clé pour TeamGuardCode : la garde de rechargement de la 1.1 rend son propre message", () => {
    const toutes = [...allKeys(equipes.TEXTES), ...allKeys(carte.TEXTES)];
    for (const code of TEAM_GUARD_CODES) {
      assert.equal(toutes.includes(code), false, code);
      assert.equal(equipes.phraseErreur(code), E.erreurInconnue, code);
    }
  });

  it("autres listes fermées rangées par T4t : pauses, formes, états d'équipe installée, blocs, `recoit`, tailles, raisons", () => {
    // Listes des types sans valeur exécutable dans T4 : vérifiées par le compilateur (clé manquante ou en trop → typecheck rouge).
    const pauseKinds = { verification: true, budget: true, modification: true, "redemarrage-cockpit": true, changement: true } satisfies Record<
      TeamPauseView["kind"],
      true
    >;
    const formes = { "a-la-suite": true, avis: true, mixte: true } satisfies Record<TeamView["forme"], true>;
    const etats = { "a-completer": true, avance: true } satisfies Record<Exclude<TeamView["etat"], "ok">, true>;
    const tailles = { S: true, M: true, L: true } satisfies Record<TaskSize, true>;
    assert.deepEqual(keysOf(E.pauses), keysOf(pauseKinds), "écart 6 de T4t : pauses rangées par TeamPauseView.kind");
    assert.deepEqual(keysOf(E.formes), keysOf(formes));
    assert.deepEqual(keysOf(E.aidesFormes), keysOf(formes));
    assert.deepEqual(keysOf(E.onglet.etats), keysOf(etats));
    assert.deepEqual(keysOf(E.onglet.etatsAide), keysOf(etats));
    assert.deepEqual(keysOf(E.editeur.blocs), sorted(FLOW_BLOCK_TYPES));
    assert.deepEqual(keysOf(E.editeur.champs.recoitChoix), sorted(STEP_INPUTS));
    assert.deepEqual(keysOf(E.editeur.champs.tailles), keysOf(tailles));
    for (const code of Object.keys(E.editeur.indisponibles)) assert.ok((FLOW_PROBLEM_CODES as readonly string[]).includes(code), code);
    // Raisons de la pause de fraîcheur : codes que recheck (L37p) peut rendre, tous des TeamErrorCode, plus « autre ».
    for (const code of Object.keys(E.raisonsChangement)) {
      assert.ok(code === "autre" || (TEAM_ERROR_CODES as readonly string[]).includes(code), code);
    }
    for (const code of ["conversation-occupee", "extension-configuree", "profondeur-delegation", "dossier-externe", "ia-indisponible", "fournisseur-refuse", "equipe-invalide", "opencode-injoignable"]) {
      assert.notEqual(equipes.pauseChangement(code), equipes.pauseChangement("autre"), code);
    }
  });

  it("bornes écrites en chiffres (écart 5 de T4t) = FLOW_LIMITS, TEAM_TEXT_LIMITS et STEP_ID_RE de T4", () => {
    const idMax = Number(/\{1,(\d+)\}/.exec(STEP_ID_RE.source)?.[1]);
    assert.deepEqual(numbers(E.problemes["trop-de-blocs"]), [FLOW_LIMITS.blocsTravail]);
    assert.deepEqual(numbers(E.problemes["trop-d-etapes"]), [FLOW_LIMITS.etapes]);
    assert.deepEqual(numbers(E.problemes["avis-nombre"]), [FLOW_LIMITS.avisMin, FLOW_LIMITS.avisMax]);
    assert.deepEqual(numbers(E.problemes["consigne-longue"]), [FLOW_LIMITS.consigne]);
    assert.deepEqual(numbers(E.problemes.titre), [TEAM_TEXT_LIMITS.titreEtape.min, TEAM_TEXT_LIMITS.titreEtape.max]);
    assert.deepEqual(numbers(E.problemes["id-invalide"]), [idMax]);
    assert.deepEqual(numbers(equipes.TEXTES.avance.reglages.simultaneesAide), [FLOW_LIMITS.simultanees]);
    assert.deepEqual(numbers(E.editeur.verifier.nomCourt), [TEAM_TEXT_LIMITS.titreEquipe.min]);
  });
});

// --- 2. Exemples de T4t ↔ planSteps et receivedFrom de T4 ---------------------------------------------------------------------

describe("croisement it4 V0 : exemples (Q3) montés comme le dit la fiche L37a", () => {
  const step = (id: string, text: { titre: string; consigne: string }, recoit: StepInput, taille: TaskSize, assistant: string): FlowStep => ({
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
  const revueSql: Flow = {
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
  const relectureScript: Flow = {
    version: 1,
    blocs: [
      { type: "etape", id: "standards", etape: step("standards", script.etapes.standards, "demande", "M", "relire-script") },
      { type: "pause", id: "verifier", message: script.pause },
      { type: "etape", id: "securite", etape: step("securite", script.etapes.securite, "precedent", "M", "relire-script") },
      { type: "etape", id: "exploitation-nuit", etape: step("exploitation-nuit", script.etapes["exploitation-nuit"], "precedent", "M", "relire-script") },
      { type: "etape", id: "consolidation", etape: step("consolidation", script.etapes.consolidation, "tous", "S", "relire-script") },
    ],
  };

  it("les clés des étapes de T4t sont les identifiants attendus par L37a, dans l'ordre", () => {
    assert.deepEqual(Object.keys(E.exemples), ["revue-sql", "relecture-script"]);
    assert.deepEqual(Object.keys(sql.etapes), ["exactitude", "performance", "donnees-sensibles", "synthese"]);
    assert.deepEqual(Object.keys(script.etapes), ["standards", "securite", "exploitation-nuit", "consolidation"]);
  });

  it("« Revue SQL sur réplica » : trois avis indépendants, puis la synthèse qui les reçoit tous", () => {
    assert.deepEqual(
      planSteps(revueSql).map((p) => [p.stepId, p.role, p.ordre]),
      [
        ["exactitude", "avis", 1],
        ["performance", "avis", 2],
        ["donnees-sensibles", "avis", 3],
        ["synthese", "synthese", 4],
      ],
    );
    for (const avis of ["exactitude", "performance", "donnees-sensibles"]) assert.deepEqual(receivedFrom(revueSql, avis), [], avis);
    assert.deepEqual(receivedFrom(revueSql, "synthese"), ["exactitude", "performance", "donnees-sensibles"]);
  });

  it("« Chaîne de relecture de script » : à la suite avec une pause, la consolidation reçoit toutes les étapes", () => {
    assert.deepEqual(
      planSteps(relectureScript).map((p) => [p.stepId, p.blocIndex, p.ordre]),
      [
        ["standards", 0, 1],
        ["securite", 2, 2],
        ["exploitation-nuit", 3, 3],
        ["consolidation", 4, 4],
      ],
    );
    assert.deepEqual(receivedFrom(relectureScript, "standards"), []);
    assert.deepEqual(receivedFrom(relectureScript, "securite"), ["standards"]);
    assert.deepEqual(receivedFrom(relectureScript, "exploitation-nuit"), ["securite"]);
    assert.deepEqual(receivedFrom(relectureScript, "consolidation"), ["standards", "securite", "exploitation-nuit"]);
  });

  it("dans les bornes de T4 : identifiants, titres, consignes, message de pause, description, nombre d'avis, d'étapes et de blocs", () => {
    for (const [id, exemple] of Object.entries(E.exemples)) {
      assert.match(id, TEAM_ID_RE);
      assert.ok(exemple.titre.length >= TEAM_TEXT_LIMITS.titreEquipe.min && exemple.titre.length <= TEAM_TEXT_LIMITS.titreEquipe.max, id);
      assert.ok(exemple.description.length <= TEAM_TEXT_LIMITS.description, id);
    }
    assert.ok(script.pause.length <= TEAM_TEXT_LIMITS.messagePause);
    for (const flow of [revueSql, relectureScript]) {
      const planned = planSteps(flow);
      assert.ok(planned.length <= FLOW_LIMITS.etapes);
      assert.ok(flow.blocs.filter((b) => b.type !== "pause").length <= FLOW_LIMITS.blocsTravail);
      for (const block of flow.blocs) {
        assert.match(block.id, STEP_ID_RE);
        if (block.type === "avis") assert.ok(block.avis.length >= FLOW_LIMITS.avisMin && block.avis.length <= FLOW_LIMITS.avisMax);
      }
      const steps = flow.blocs.flatMap((b) => (b.type === "etape" ? [b.etape] : b.type === "avis" ? [...b.avis, b.synthese] : []));
      for (const s of steps) {
        assert.match(s.id, STEP_ID_RE);
        assert.ok(s.titre.length >= TEAM_TEXT_LIMITS.titreEtape.min && s.titre.length <= TEAM_TEXT_LIMITS.titreEtape.max, s.titre);
        assert.ok(s.consigne.length > 0 && s.consigne.length <= FLOW_LIMITS.consigne, s.titre);
      }
    }
  });
});

// --- 3. Carte : agent-map-texts (T4t) ↔ agent-map (L39a) ---------------------------------------------------------------------

/** Listes fermées de la fiche L39a (plan it4 §6), qui font foi (constat 16). */
const FICHE_L39A = {
  edges: ["delegue-sans-confirmation", "delegue-apres-accord", "delegue-refuse-en-simple", "raccourci-sans-confirmation", "consulte-fiche", "etape-imposee", "utilise"],
  notes: ["profondeur-un", "profondeur-plus", "ia-du-delegant", "aucun-assistant", "aucun-lien", "regles-pas-historique"],
  warnings: ["ia-indisponible", "droits-larges"],
  errors: ["invalid", "forbidden-directory", "mode-avance", "salle-coupee"],
  kinds: ["vous", "assistant", "integre", "agent-studio", "sous-agent", "raccourci", "fiche", "equipe"],
};

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action });

/** Conversation type : build (intégré, délègue après accord), deux sous-agents intégrés, un assistant du catalogue, un caché,
 *  un agent du Studio, deux raccourcis (sous-tâche et non), deux fiches, une équipe. */
function sampleMap(mode: "simple" | "avance", subagentDepth = 1): AgentMapInput {
  const readOnly = [rule("*", "*", "ask"), rule("read", "*", "allow"), rule("grep", "*", "allow"), rule("glob", "*", "allow"), rule("task", "*", "deny")];
  return {
    agents: [
      { name: "build", mode: "primary", origine: "integre", titre: "Assistant général", rules: [rule("*", "*", "allow"), rule("task", "*", "ask"), rule("skill", "*", "ask")] },
      { name: "general", mode: "subagent", origine: "integre", rules: [rule("*", "*", "allow"), rule("task", "*", "allow")] },
      { name: "explore", mode: "subagent", origine: "integre", rules: [...readOnly] },
      {
        name: "relire-script",
        mode: "all",
        origine: "assistant",
        titre: "Relire un script",
        ia: { label: "Rapide", niveau: "rapide", disponible: false },
        rules: [...readOnly, rule("skill", "*", "allow"), rule("edit", "*", "allow")],
      },
      { name: "cache", mode: "primary", hidden: true, origine: "studio", rules: [rule("*", "*", "ask"), rule("task", "*", "deny")] },
      { name: "studio-perso", mode: "primary", origine: "studio", rules: [rule("*", "*", "ask"), rule("task", "explore", "allow")] },
      { name: "cockpit-classifier", mode: "primary", origine: "studio", rules: [] },
    ],
    commands: [
      { name: "revue", agent: "relire-script", subtask: true },
      { name: "relire", agent: "relire-script" },
      { name: "outil-mcp", agent: "build", source: "mcp" },
    ],
    fiches: ["standards-scripts", "anonymisation"],
    equipes: [{ id: "revue-sql", titre: "Revue SQL sur réplica", etapes: [{ assistant: "explore", niveau: null }, { assistant: "relire-script", niveau: "rapide" }] }],
    subagentDepth,
    mode,
    internes: ["cockpit-classifier"],
  };
}

describe("croisement it4 V0 : clés d'agent-map-texts = listes fermées d'agent-map.ts, identiques à la fiche L39a", () => {
  it("listes du module = fiche L39a, dans son ordre ; phrases = listes (salle-coupee exclue) ; genres = MapNodeKind", () => {
    assert.deepEqual([...MAP_EDGE_CODES], FICHE_L39A.edges);
    assert.deepEqual([...MAP_NOTE_CODES], FICHE_L39A.notes);
    assert.deepEqual([...MAP_WARNING_CODES], FICHE_L39A.warnings);
    assert.deepEqual([...AGENT_MAP_ERROR_CODES], FICHE_L39A.errors);
    assert.deepEqual([...MAP_NODE_KINDS], FICHE_L39A.kinds);
    assert.deepEqual(keysOf(C.aretes), sorted(MAP_EDGE_CODES));
    assert.deepEqual(keysOf(C.notes), sorted(MAP_NOTE_CODES));
    assert.deepEqual(keysOf(C.avertissements), sorted(MAP_WARNING_CODES));
    assert.deepEqual(keysOf(C.erreurs), sorted(AGENT_MAP_ERROR_CODES.filter((code) => code !== "salle-coupee")));
    assert.equal(carte.phraseErreurCarte("salle-coupee"), C.erreurInconnue, "salle-coupee : phrase de la salle (L39o)");
    assert.deepEqual(keysOf(C.genres), sorted(MAP_NODE_KINDS));
    for (const kind of Object.keys(carte.TEXTES.avance.genres)) assert.ok((MAP_NODE_KINDS as readonly string[]).includes(kind), kind);
    const appliquePar = { opencode: true, cockpit: true } satisfies Record<MapEdge["appliquePar"], true>;
    assert.deepEqual(keysOf(C.appliquePar), keysOf(appliquePar));
  });

  for (const [mode, depth] of [
    ["simple", 1],
    ["simple", 2],
    ["avance", 1],
    ["avance", 2],
  ] as const) {
    it(`toute arête dérivée a une phrase qui nomme sa source et sa cible et dit qui l'applique (${mode}, profondeur ${depth})`, () => {
      const map = deriveAgentMap(sampleMap(mode, depth));
      const names = new Map(map.nodes.map((node) => [node.id, node.title ?? node.name]));
      const kinds = new Set(map.edges.map((edge) => `${edge.kind}/${edge.code}`));
      // L'échantillon couvre les cas qui comptent, dont l'écart 2 de L39a (raccourci qui n'est pas une sous-tâche).
      for (const expected of ["utilise/utilise", "lance/utilise", "lance/raccourci-sans-confirmation", "etape/etape-imposee", "consulte/consulte-fiche"]) {
        assert.ok(kinds.has(expected), expected);
      }
      assert.ok(kinds.has(mode === "simple" ? "delegue/delegue-refuse-en-simple" : "delegue/delegue-apres-accord"));
      for (const edge of map.edges) {
        const source = names.get(edge.from) ?? "";
        const cible = names.get(edge.to) ?? "";
        const phrase = carte.phraseArete(edge.code, source, cible, edge.confirmation, edge.kind);
        const where = `${edge.from} → ${edge.to} (${edge.kind}/${edge.code})`;
        assert.ok(phrase !== null, where);
        assert.ok(phrase.includes(`« ${cible} »`), `${where} : ${phrase}`);
        if (edge.from === MAP_VOUS_ID) continue;
        assert.ok(phrase.includes(`« ${source} »`), `${where} : ${phrase}`);
        const qui = edge.refuseEnSimple ? C.refuseEnSimple : C.appliquePar[edge.appliquePar];
        assert.ok(phrase.includes(qui), `${where} : ${phrase}`);
        if (edge.confirmation === "demandee" && !edge.refuseEnSimple) assert.ok(phrase.includes(C.legende.accord), `${where} : ${phrase}`);
      }
      // La phrase de « utilise » (Vous) ne décrit jamais un raccourci : le raccourci qui fait répondre son assistant a la sienne.
      const shortcut = map.edges.find((edge) => edge.kind === "lance" && edge.code === "utilise");
      assert.ok(shortcut);
      assert.notEqual(
        carte.phraseArete(shortcut.code, names.get(shortcut.from) ?? "", names.get(shortcut.to) ?? "", shortcut.confirmation, shortcut.kind),
        carte.phraseArete(shortcut.code, names.get(shortcut.from) ?? "", names.get(shortcut.to) ?? "", shortcut.confirmation),
      );
      // Notes, avertissements, genres : une phrase chacun ; vue Liste : une entrée par arête, chacune avec sa phrase.
      for (const note of map.notes) assert.notEqual(carte.phraseNote(note), null, note);
      for (const node of map.nodes) {
        assert.notEqual(carte.genre(node.kind, mode === "avance"), null, node.kind);
        for (const warning of node.avertissements) assert.notEqual(carte.phraseAvertissement(warning), null, warning);
      }
      const entries = mapAsList(map).flatMap((section) => section.entries);
      assert.equal(entries.length, map.edges.length);
      if (mode === "simple") assert.equal(map.notes.includes("profondeur-plus"), false, "aucune mention de profondeur en Simple");
    });
  }

  it("carte ↔ route (L39a × T4w) : tout identifiant de nœud passe par l'adresse et revient identique, homonymes et noms longs compris", () => {
    const input = sampleMap("avance");
    // 43 caractères : accepté par le Studio (nameSchema, 64 au plus), plus long que la règle des identifiants d'équipe.
    const long = "revue-des-requetes-sql-du-reporting-mensuel";
    const map = deriveAgentMap({
      ...input,
      agents: [
        ...input.agents,
        { name: "revue", mode: "subagent", origine: "assistant", rules: [] },
        { name: long, mode: "primary", origine: "studio", rules: [] },
        { name: "Relecteur_v2.1", mode: "primary", origine: "studio", rules: [] },
      ],
      fiches: [...input.fiches, "revue"],
      equipes: [...input.equipes, { id: "e".repeat(40), titre: "Équipe au plus long identifiant", etapes: [{ assistant: "revue", niveau: null }] }],
    });
    // Un agent, un raccourci et une fiche nommés « revue » : trois nœuds, que seul l'identifiant distingue.
    assert.deepEqual(sorted(map.nodes.filter((node) => node.name === "revue").map((node) => node.id)), ["agent:revue", "fiche:revue", "raccourci:revue"]);
    for (const id of [MAP_VOUS_ID, mapNodeId("agent", long), mapNodeId("agent", "Relecteur_v2.1"), mapNodeId("equipe", "e".repeat(40))]) {
      assert.ok(map.nodes.some((node) => node.id === id), id);
    }
    for (const node of map.nodes) {
      const hash = assistantsHref({ mode: "carte", element: node.id });
      assert.deepEqual(assistantsViewOf(parseRoute(hash), parseRouteQuery(hash)), { mode: "carte", element: node.id }, `${node.id} (${hash})`);
      assert.equal(neighbours(map, node.id)?.element.id, node.id, node.id);
      assert.deepEqual(mapAsList(map, node.id).map((section) => section.node.id), [node.id], node.id);
    }
  });
});

// --- 4. Formes des lignes (contracts-eq, T4) ↔ migration 4 (db.ts) -------------------------------------------------------------

describe("croisement it4 V0 : formes des lignes de contracts-eq = colonnes de la migration 4", () => {
  it("teams, team_runs, team_run_steps, team_run_events : mêmes colonnes, ni plus ni moins", () => {
    const TEAM = {
      id: true,
      titre: true,
      description: true,
      flow: true,
      origine: true,
      exemple_id: true,
      exemple_version: true,
      avance: true,
      created_at: true,
      updated_at: true,
    } satisfies Record<keyof TeamRow, true>;
    const RUN = {
      id: true,
      team_id: true,
      team_titre: true,
      flow: true,
      flow_sha256: true,
      estimate_sha256: true,
      mode_ui: true,
      root_session_id: true,
      directory: true,
      request_message_id: true,
      result_message_id: true,
      state: true,
      cause: true,
      facultatifs: true,
      estimate_typique: true,
      estimate_max: true,
      plafond: true,
      cost: true,
      confirmations: true,
      precisions: true,
      created_at: true,
      started_at: true,
      ended_at: true,
    } satisfies Record<keyof RunRow, true>;
    const STEP = {
      run_id: true,
      step_id: true,
      tour: true,
      tentative: true,
      ordre: true,
      bloc_index: true,
      titre: true,
      agent: true,
      agent_file_sha256: true,
      rules_sha256: true,
      floor_sha256: true,
      rights: true,
      right_lines: true,
      model: true,
      variant: true,
      steps: true,
      session_id: true,
      state: true,
      cause: true,
      tronquee: true,
      message_sha256: true,
      message_text: true,
      correction_sha256: true,
      result_excerpt: true,
      verdict: true,
      choix: true,
      queued_at: true,
      started_at: true,
      ended_at: true,
      cost: true,
    } satisfies Record<keyof StepRow, true>;
    const EVENT = { id: true, run_id: true, kind: true, par: true, data: true, at: true } satisfies Record<keyof EventRow, true>;
    const db = openMemoryDb();
    try {
      const columns = (table: string) => sorted((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      assert.deepEqual(columns("teams"), keysOf(TEAM));
      assert.deepEqual(columns("team_runs"), keysOf(RUN));
      assert.deepEqual(columns("team_run_steps"), keysOf(STEP));
      assert.deepEqual(columns("team_run_events"), keysOf(EVENT));
    } finally {
      db.close();
    }
  });
});

// --- 5. Harnais avec les modules 1.1 de production ---------------------------------------------------------------------------

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/** Studio simulé complet (lecture des fichiers d'agents), pour que le réalignement et l'installation aillent jusqu'au bout. */
function fullStudio(): StudioService {
  const saved = new Map<string, unknown>();
  return {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown> }) => {
      const item = { kind, name: input.name, scope: "global", project: null, file: `${kind}/${input.name}.md`, frontmatter: input.frontmatter, body: "x", error: null, files: [], updatedAt: Date.now() };
      saved.set(`${kind}/${input.name}`, item);
      return item;
    },
    remove: async () => true,
    get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
}

/** Harnais avec tous les modules 1.1 (production), les routes des assistants et une garde lue au moment de l'appel. */
async function production(t: TestContext, options: Pick<CockpitHarnessOptions, "equipes" | "eqPorts"> = {}): Promise<CockpitHarness> {
  const ref: { h?: CockpitHarness } = {};
  const studio = fullStudio();
  const h = await startCockpit(t, {
    ...options,
    modules: "tous",
    deps: (base) => {
      const assistants = new AssistantService({
        db: base.db,
        env: base.env,
        client: base.client,
        studio,
        lookup: base.lookup,
        tiers: base.tiers as TierService,
        ledger: base.ledger,
        settings: base.settings,
        catalog: base.catalog,
        projects: base.projects,
        hub: base.hub,
        log: base.log,
        queue: base.configQueue as ConfigWriteQueue,
        reloadBusy: () => ref.h?.cockpit.c11.reloadBusy() ?? false,
      });
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return { studio, assistants, routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)] };
    },
  });
  ref.h = h;
  return h;
}

async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Conversation archivée avec un lancement d'équipe : textes purgés par la suppression de la 1.1. */
function seedTeamConversation(h: CockpitHarness, rootId: string): void {
  h.db.prepare("INSERT INTO conversations (session_id, created_at, updated_at) VALUES (?, 1, 1)").run(rootId);
  h.db
    .prepare(
      `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, precisions, created_at)
       VALUES (?, 'Revue SQL', '{"version":1,"blocs":[]}', 'f0', ?, '/workspace', 'en-cours', '["Voir la table des factures"]', 1)`,
    )
    .run(`run-${rootId}`, rootId);
  h.db
    .prepare(
      `INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, state, message_text, result_excerpt)
       VALUES (?, 'exactitude', 1, 0, 'Exactitude', 'relire-requete-sql', 'terminee', 'Consigne envoyée', 'Deux jointures à revoir')`,
    )
    .run(`run-${rootId}`);
}

/** Proxy, arrêt, rechargement, réalignement et Archives : réponses comparables (identifiants et durées retirés). */
async function scenario(h: CockpitHarness): Promise<unknown[]> {
  const out: unknown[] = [];
  const root = await trackedRoot(h, "Croisement");
  const before = h.fake.requests.length;
  const since = h.fake.emitted.length;
  const send = await h.call("POST", `/api/oc/session/${root.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Bonjour" }] },
  });
  const relayed = h.fake.requests.slice(before).filter((r) => r.pathname === `/session/${root.id}/prompt_async`).length;
  out.push(["proxy", send.status, send.status >= 400 ? send.json<{ error?: string }>().error : null, relayed]);
  // Tour du faux fini avant les gardes de rechargement : sinon une conversation encore occupée les ferait répondre 409 au hasard.
  if (send.status < 400) await h.fake.waitForEvent("session.idle", (p) => p.sessionID === root.id, { since });
  const other = await trackedRoot(h, "Arrêt");
  const stop = await h.call("POST", `/api/conversations/${other.id}/stop`, { headers: h.headers.mutating });
  const { durationMs: _duration, rootId: _root, aborted, ...stopRest } = stop.json<StopResult>();
  out.push(["arrêt", stop.status, stopRest, aborted.length]);
  out.push(["reloadBusy", h.cockpit.c11.reloadBusy()]);
  const realign = await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} });
  out.push(["réalignement", realign.status]);
  const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.mutating });
  out.push(["redémarrage", restart.status]);
  seedTeamConversation(h, "ses_archivee");
  const removed = await h.call("DELETE", "/api/archive/ses_archivee", { headers: h.headers.mutating });
  const step = h.db.prepare("SELECT message_text, result_excerpt FROM team_run_steps WHERE run_id = 'run-ses_archivee'").get() as Record<string, unknown>;
  const run = h.db.prepare("SELECT precisions FROM team_runs WHERE id = 'run-ses_archivee'").get() as Record<string, unknown>;
  out.push(["archive", removed.status, removed.json(), { ...step }, { ...run }]);
  const invalid = await h.call("DELETE", "/api/archive/ses.point", { headers: h.headers.mutating });
  out.push(["archive invalide", invalid.status, invalid.json()]);
  return out;
}

describe("croisement it4 V0 : app-factory avec les modules 1.1 de production", () => {
  it("sans `equipes` = avec tous les squelettes : proxy, arrêt, rechargement, réalignement, DELETE /api/archive/:id", async (t) => {
    const bare = await scenario(await production(t));
    const all = await production(t, { equipes: "tous" });
    assert.deepEqual(all.cockpit.equipes.modules, [...EQ_MODULE_ORDER]);
    assert.deepEqual(await scenario(all), bare);
    // Réponses de la 1.1 (le scénario n'est pas vide de sens) : envoi relayé une fois, réalignement et redémarrage faits, purge.
    const byName = new Map(bare.map((entry) => [(entry as unknown[])[0], entry]));
    assert.deepEqual(byName.get("proxy"), ["proxy", 204, null, 1]);
    assert.deepEqual(byName.get("réalignement"), ["réalignement", 200]);
    assert.deepEqual(byName.get("redémarrage"), ["redémarrage", 200]);
    assert.deepEqual(byName.get("archive"), ["archive", 200, { deleted: true }, { message_text: null, result_excerpt: null }, { precisions: "[]" }]);
  });

  it("c11.reloadBusy composé seulement si teamRunner est installé (étapes « occupées » par le port dans les deux cas)", async (t) => {
    const busyRunner = { runner: { ...neutralRunner(), stepsBusy: () => true } };
    const withRunner = await production(t, { equipes: "tous", eqPorts: busyRunner });
    assert.equal(withRunner.cockpit.c11.reloadBusy(), true);
    assert.deepEqual(
      withRunner.cockpit.equipes.registrations.filter((r) => r.kind === "reloadBusy"),
      [{ kind: "reloadBusy", key: "reloadBusy", module: "teamRunner" }],
    );
    const restart = await withRunner.call("POST", "/api/system/restart-opencode", { headers: withRunner.headers.mutating });
    assert.equal(restart.status, 409, restart.body);
    const realign = await withRunner.call("POST", "/api/ai/realign", { headers: withRunner.headers.confirmed, body: {} });
    assert.equal(realign.status, 409, realign.body);
    withRunner.assertNoGlobalRestart();

    const withoutRunner = await production(t, { equipes: EQ_MODULE_ORDER.filter((name) => name !== "teamRunner"), eqPorts: busyRunner });
    assert.equal(withoutRunner.cockpit.c11.reloadBusy(), false);
    assert.equal(withoutRunner.cockpit.equipes.registrations.some((r) => r.kind === "reloadBusy"), false);
    const free = await withoutRunner.call("POST", "/api/system/restart-opencode", { headers: withoutRunner.headers.mutating });
    assert.equal(free.status, 200, free.body);
  });

  it("arrêt réel de la 1.1 décoré seulement avec teamGuards : runner prévenu avant puis après, résultat inchangé", async (t) => {
    const trace: string[] = [];
    const runner: TeamRunnerPort = {
      ...neutralRunner(),
      stopRequested: (_rootId: string, cause: StopCause) => void trace.push(`avant ${cause}`),
      stopped: (_rootId: string, cause: StopCause, result: StopResult | null) => void trace.push(`après ${cause} ${result === null ? "échec" : "fait"}`),
    };
    const guarded = await production(t, { equipes: "tous", eqPorts: { runner } });
    const root = await trackedRoot(guarded, "Arrêt décoré");
    const stop = await guarded.call("POST", `/api/conversations/${root.id}/stop`, { headers: guarded.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.deepEqual(trace, ["avant vous", "après vous fait"]);

    trace.length = 0;
    const bare = await production(t, { equipes: EQ_MODULE_ORDER.filter((name) => name !== "teamGuards"), eqPorts: { runner } });
    const bareRoot = await trackedRoot(bare, "Arrêt sans verrou");
    assert.equal((await bare.call("POST", `/api/conversations/${bareRoot.id}/stop`, { headers: bare.headers.mutating })).status, 200);
    assert.deepEqual(trace, []);
    guarded.assertNoGlobalRestart();
    bare.assertNoGlobalRestart();
  });
});

// --- 6. MX-EQ reporté au train de V0 -----------------------------------------------------------------------------------------

describe("croisement it4 V0 : MX-EQ (report du train de V0) et constantes", () => {
  // Règles effectives de relire-script mesurées par ME-5 (GET /agent, ordre d'opencode) : « * ask », puis la liste blanche
  // d'opencode (sorties tronquées, /tmp/opencode, dossiers de fiches), avec la lecture seule et les refus de clés de l'assistant.
  const output = truncateGlob();
  const agentRules: Rule[] = [
    rule("*", "*", "ask"),
    rule("read", "*", "allow"),
    rule("read", "*.env", "ask"),
    rule("read", "*.pfx", "deny"),
    rule("grep", "*", "allow"),
    rule("glob", "*", "allow"),
    rule("edit", "*", "deny"),
    rule("bash", "*", "deny"),
    rule("task", "*", "deny"),
    rule("webfetch", "*", "deny"),
    rule("external_directory", "*", "ask"),
    rule("external_directory", output, "allow"),
    rule("external_directory", "/tmp/opencode/*", "allow"),
    rule("external_directory", "/home/node/.config/opencode/skills/standards-scripts/*", "allow"),
    rule("external_directory", output, "allow"),
  ];
  const withFloor = [...agentRules, ...buildFloor("ETAPE", { agentRules })];

  it("ME-8 / Q6 (a) : le plancher ETAPE refuse les sorties complètes enregistrées ; la phrase d'aide de T4t reste donc vraie (P3)", () => {
    const saved = output.replace(/\*$/, "tool_0123456789abcdef");
    assert.equal(evaluate(agentRules, "external_directory", saved), "allow", "l'assistant seul les lirait (ME-8, prévision)");
    assert.equal(evaluate(withFloor, "external_directory", saved), "deny", "une étape ne les lit pas (ME-8, mesuré)");
    assert.equal(evaluate(withFloor, "read", "/workspace/eq/script.ps1"), "allow", "une étape lit le projet");
    assert.equal(evaluate(withFloor, "read", "/workspace/eq/cle.pfx"), "deny", "jamais un fichier de clés (ME-2)");
    assert.equal(E.editeur.champs.limiteSortie, "Une étape ne relit pas une sortie trop longue : demandez-lui de chercher plus précisément.");
  });

  it("ME-2 : de la liste témoin mesurée sans plancher (glob grep read skill todowrite), une étape ne garde que glob, grep et read", () => {
    const temoin = ["glob", "grep", "read", "skill", "todowrite"];
    const retires = disabledTools(withFloor, temoin);
    assert.deepEqual(
      temoin.filter((tool) => !retires.includes(tool)),
      ["glob", "grep", "read"],
    );
  });

  it("constantes U1 et D-eq-14 inchangées au train : équipes fermées en Simple, injection noReply", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.equal(EQUIPES_INJECTION, "noReply");
  });
});
