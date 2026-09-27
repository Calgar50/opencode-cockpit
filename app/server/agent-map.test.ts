// Carte des assistants, module pur (1.1, itération 4, L39a ; spécification §3.7 l.298, §5.2 l.887-892, §5.4 l.911, §6 l.1048, F-a,
// F-i ; conception C §7.4, §9.9) : parité avec le registre d'opencode 1.18.30 (primaire exclu, hidden gardé, mode all inclus,
// dernière règle gagnante), profil Prudent, refus du cockpit en mode Simple, raccourcis, fiches, équipes, internes, profondeur,
// notes, vues Liste et Centrée, 200 jeux de règles aléatoires à graine fixe contre evaluate, listes fermées de codes recopiées de la
// fiche L39a (constat 16) et module pur sans phrase écrite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isInternalAgentName } from "./shared/agent-choice.ts";
import {
  AGENT_MAP_ERROR_CODES,
  type AgentMapInput,
  type AgentMapResult,
  deriveAgentMap,
  hasTaskRule,
  MAP_EDGE_CODES,
  MAP_EDGE_KINDS,
  MAP_NODE_KINDS,
  MAP_NOTE_CODES,
  MAP_VOUS_ID,
  MAP_WARNING_CODES,
  type MapAgentInput,
  type MapEdge,
  mapAsList,
  mapNodeId,
  neighbours,
} from "./shared/agent-map.ts";
import {
  type Action,
  assistantPermission,
  BUILTIN_ASSISTANTS,
  effectiveAgentRules,
  effectiveBuiltinRules,
  evaluate,
  presetPermission,
  rightLines,
  type Rule,
  wildcardMatch,
} from "./shared/assistant-rules.ts";

const PRUDENT = presetPermission("prudent");
const A = (name: string) => mapNodeId("agent", name);
const R = (name: string) => mapNodeId("raccourci", name);
const F = (name: string) => mapNodeId("fiche", name);
const E = (id: string) => mapNodeId("equipe", id);

function input(partial: Partial<AgentMapInput>): AgentMapInput {
  return { agents: [], commands: [], fiches: [], equipes: [], subagentDepth: 1, mode: "avance", internes: [], ...partial };
}

function integre(name: "build" | "plan", global: Record<string, unknown> = PRUDENT): MapAgentInput {
  return { name, mode: "primary", origine: "integre", titre: BUILTIN_ASSISTANTS[name].title, rules: effectiveBuiltinRules(name, global) };
}

function sousAgentIntegre(name: string, own: Record<string, unknown> = {}, global: Record<string, unknown> = PRUDENT): MapAgentInput {
  return { name, mode: "subagent", origine: "integre", rules: effectiveAgentRules(global, own) };
}

function assistant(name: string, fiches: string[] = [], disponible = true): MapAgentInput {
  return {
    name,
    mode: "primary",
    origine: "assistant",
    titre: `Titre ${name}`,
    rules: effectiveAgentRules(PRUDENT, assistantPermission("lecture", false, fiches)),
    ia: { label: "IA de test", niveau: "equilibre", disponible },
    steps: 40,
  };
}

function studio(name: string, mode: MapAgentInput["mode"], own: Record<string, unknown> = {}, extra: Partial<MapAgentInput> = {}): MapAgentInput {
  return { name, mode, origine: "studio", rules: effectiveAgentRules(PRUDENT, own), ...extra };
}

/** Assistants par défaut d'opencode sous le profil Prudent (configuration livrée). */
function base(): MapAgentInput[] {
  return [integre("build"), integre("plan"), sousAgentIntegre("general"), sousAgentIntegre("explore", { edit: "deny", bash: "deny" })];
}

function delegues(result: AgentMapResult, from?: string): MapEdge[] {
  return result.edges.filter((e) => e.kind === "delegue" && (from === undefined || e.from === from));
}

function node(result: AgentMapResult, id: string) {
  const found = result.nodes.find((n) => n.id === id);
  assert.ok(found, id);
  return found;
}

describe("carte des assistants : listes fermées de codes (constat 16)", () => {
  it("codes, genres et erreurs identiques à la fiche L39a, dans son ordre (agent-map-texts.ts les recopie)", () => {
    assert.deepEqual(
      [...MAP_EDGE_CODES],
      ["delegue-sans-confirmation", "delegue-apres-accord", "delegue-refuse-en-simple", "raccourci-sans-confirmation", "consulte-fiche", "etape-imposee", "utilise"],
    );
    assert.deepEqual([...MAP_NOTE_CODES], ["profondeur-un", "profondeur-plus", "ia-du-delegant", "aucun-assistant", "aucun-lien", "regles-pas-historique"]);
    assert.deepEqual([...MAP_WARNING_CODES], ["ia-indisponible", "droits-larges"]);
    assert.deepEqual([...AGENT_MAP_ERROR_CODES], ["invalid", "forbidden-directory", "mode-avance", "salle-coupee"]);
    assert.deepEqual([...MAP_NODE_KINDS], ["vous", "assistant", "integre", "agent-studio", "sous-agent", "raccourci", "fiche", "equipe"]);
    assert.deepEqual([...MAP_EDGE_KINDS], ["delegue", "lance", "consulte", "etape", "utilise"]);
  });
});

describe("carte des assistants : délégation (registre d'opencode, F-a)", () => {
  it("profil Prudent : build fait travailler general et explore « après votre accord », jamais un primaire", () => {
    const result = deriveAgentMap(input({ agents: base() }));
    assert.deepEqual(
      delegues(result, A("build")).map((e) => [e.to, e.confirmation, e.code, e.appliquePar, e.refuseEnSimple]),
      [
        [A("explore"), "demandee", "delegue-apres-accord", "opencode", false],
        [A("general"), "demandee", "delegue-apres-accord", "opencode", false],
      ],
    );
    // Le Conseiller refuse general dans ses règles propres, mais la configuration globale (task: ask) passe après (F-a).
    assert.deepEqual(delegues(result, A("plan")).map((e) => [e.to, e.confirmation]), [
      [A("explore"), "demandee"],
      [A("general"), "demandee"],
    ]);
    assert.equal(result.edges.some((e) => e.kind === "delegue" && (e.to === A("build") || e.to === A("plan"))), false, "primaire exclu");
  });

  it("primaire exclu, hidden gardé, mode all inclus, internes exclus comme cible, appelant et nœud", () => {
    const result = deriveAgentMap(
      input({
        agents: [
          integre("build"),
          studio("cache", "subagent", {}, { hidden: true }),
          studio("polyvalent", "all"),
          studio("principal", "primary"),
          studio("compaction", "subagent"),
          studio("cockpit-controle", "subagent"),
          studio("gardien", "subagent"),
          studio("summary", "primary", { task: "allow" }),
        ],
        internes: ["gardien"],
      }),
    );
    assert.deepEqual(
      delegues(result, A("build")).map((e) => e.to),
      [A("polyvalent"), A("cache")],
    );
    for (const name of ["compaction", "cockpit-controle", "gardien", "summary"]) {
      assert.equal(result.nodes.some((n) => n.name === name), false, name);
      assert.equal(result.edges.some((e) => e.from === A(name) || e.to === A(name)), false, name);
    }
    assert.equal(node(result, A("cache")).cacheDansLeChat, true);
    assert.equal(node(result, A("cache")).kind, "sous-agent");
    assert.equal(node(result, A("polyvalent")).kind, "agent-studio");
    // Un agent de mode all délègue lui-même (chat) ; son appel vers lui-même est permis par le registre.
    assert.deepEqual(delegues(result, A("polyvalent")).map((e) => e.to), [A("polyvalent"), A("cache")]);
  });

  it("dernière règle gagnante : {general: allow, *: deny} ne délègue à personne ; {*: deny, x: ask} → x demandée seule", () => {
    const cibles = [sousAgentIntegre("general"), sousAgentIntegre("explore"), studio("x", "subagent")];
    const piege = deriveAgentMap(input({ agents: [studio("chef", "primary", { task: { general: "allow", "*": "deny" } }), ...cibles] }));
    assert.deepEqual(delegues(piege, A("chef")), [], "la règle « * » écrite après general l'emporte aussi pour general");
    const seul = deriveAgentMap(input({ agents: [studio("chef", "primary", { task: { "*": "deny", x: "ask" } }), ...cibles] }));
    assert.deepEqual(delegues(seul, A("chef")).map((e) => [e.to, e.confirmation]), [[A("x"), "demandee"]]);
    const ouvert = deriveAgentMap(input({ agents: [studio("chef", "primary", { task: { "*": "deny", general: "allow" } }), ...cibles] }));
    assert.deepEqual(delegues(ouvert, A("chef")).map((e) => [e.to, e.confirmation, e.code]), [[A("general"), "sans", "delegue-sans-confirmation"]]);
  });

  it("assistants du catalogue : task refusé, aucune délégation", () => {
    const result = deriveAgentMap(input({ agents: [...base(), assistant("relire-script")] }));
    assert.deepEqual(delegues(result, A("relire-script")), []);
  });

  it("mode Simple : une délégation demandée est refusée par le cockpit (décision n° 4) ; sans confirmation, rien ne change", () => {
    const agents = [...base(), studio("libre", "primary", { task: { "*": "deny", general: "allow" } })];
    const simple = deriveAgentMap(input({ agents, mode: "simple" }));
    assert.deepEqual(
      delegues(simple, A("build")).map((e) => [e.to, e.confirmation, e.code, e.appliquePar, e.refuseEnSimple]),
      [
        [A("explore"), "demandee", "delegue-refuse-en-simple", "cockpit", true],
        [A("general"), "demandee", "delegue-refuse-en-simple", "cockpit", true],
      ],
    );
    assert.deepEqual(
      delegues(simple, A("libre")).map((e) => [e.to, e.confirmation, e.code, e.appliquePar, e.refuseEnSimple]),
      [[A("general"), "sans", "delegue-sans-confirmation", "opencode", false]],
    );
    const avance = deriveAgentMap(input({ agents, mode: "avance" }));
    assert.equal(avance.edges.some((e) => e.refuseEnSimple || e.code === "delegue-refuse-en-simple"), false);
  });
});

describe("carte des assistants : raccourcis, fiches, équipes et « Vous »", () => {
  it("raccourcis : sous-tâche lancée sans confirmation ; sinon l'assistant répond (utilise) ; skill, mcp, interne ou inconnu : aucun lien", () => {
    const result = deriveAgentMap(
      input({
        agents: [...base(), assistant("relire-script")],
        commands: [
          { name: "revue-rapide", agent: "relire-script", subtask: true },
          { name: "explorer", agent: "explore" },
          { name: "direct", agent: "relire-script" },
          { name: "explorer-ici", agent: "explore", subtask: false },
          { name: "fiche-en-commande", agent: "build", source: "skill" },
          { name: "outil-mcp", source: "mcp" },
          { name: "classer", agent: "cockpit-classifier", subtask: true },
          { name: "perdu", agent: "absent", subtask: true },
          { name: "sans-agent", source: "command" },
        ],
      }),
    );
    const lance = result.edges.filter((e) => e.kind === "lance").map((e) => [e.from, e.to, e.confirmation, e.code, e.appliquePar]);
    assert.deepEqual(lance, [
      [R("direct"), A("relire-script"), "aucune", "utilise", "opencode"],
      [R("explorer"), A("explore"), "sans", "raccourci-sans-confirmation", "opencode"],
      [R("explorer-ici"), A("explore"), "aucune", "utilise", "opencode"],
      [R("revue-rapide"), A("relire-script"), "sans", "raccourci-sans-confirmation", "opencode"],
    ]);
    const raccourcis = result.nodes.filter((n) => n.kind === "raccourci").map((n) => n.name);
    assert.deepEqual(raccourcis, ["classer", "direct", "explorer", "explorer-ici", "perdu", "revue-rapide", "sans-agent"]);
    for (const name of raccourcis) assert.ok(result.edges.some((e) => e.kind === "utilise" && e.from === MAP_VOUS_ID && e.to === R(name)), name);
  });

  it("fiches : consulte selon evaluate(règles, skill, fiche) ; assistant du catalogue : ses fiches seulement", () => {
    const result = deriveAgentMap(
      input({
        agents: [integre("build"), assistant("relire-sql", ["regles-sql"]), studio("prudent", "primary", { skill: { "*": "ask", secret: "deny" } })],
        fiches: ["regles-sql", "autre", "secret", "autre"],
      }),
    );
    const consulte = (from: string) => result.edges.filter((e) => e.kind === "consulte" && e.from === from).map((e) => [e.to, e.confirmation, e.code]);
    assert.deepEqual(consulte(A("relire-sql")), [[F("regles-sql"), "sans", "consulte-fiche"]]);
    assert.deepEqual(consulte(A("build")), [
      [F("autre"), "sans", "consulte-fiche"],
      [F("regles-sql"), "sans", "consulte-fiche"],
      [F("secret"), "sans", "consulte-fiche"],
    ]);
    assert.deepEqual(consulte(A("prudent")), [
      [F("autre"), "demandee", "consulte-fiche"],
      [F("regles-sql"), "demandee", "consulte-fiche"],
    ]);
    assert.equal(result.nodes.filter((n) => n.kind === "fiche").length, 3, "fiches sans doublon");
  });

  it("équipes : une arête « imposée par le cockpit » par étape, niveau gardé ; assistant absent ou interne : aucun lien", () => {
    const result = deriveAgentMap(
      input({
        agents: [...base(), assistant("relire-requete-sql")],
        equipes: [
          {
            id: "revue-sql",
            titre: "Revue SQL sur réplica",
            etapes: [
              { assistant: "relire-requete-sql", niveau: null },
              { assistant: "relire-requete-sql", niveau: "expert" },
              { assistant: "absent", niveau: null },
              { assistant: "cockpit-classifier", niveau: null },
            ],
          },
        ],
      }),
    );
    const etapes = result.edges.filter((e) => e.kind === "etape");
    assert.deepEqual(
      etapes.map((e) => [e.from, e.to, e.confirmation, e.appliquePar, e.refuseEnSimple, e.code, e.etape]),
      [
        [E("revue-sql"), A("relire-requete-sql"), "aucune", "cockpit", false, "etape-imposee", { numero: 1, niveau: null }],
        [E("revue-sql"), A("relire-requete-sql"), "aucune", "cockpit", false, "etape-imposee", { numero: 2, niveau: "expert" }],
      ],
    );
    assert.equal(node(result, E("revue-sql")).title, "Revue SQL sur réplica");
    const vers = result.edges.find((e) => e.kind === "utilise" && e.to === E("revue-sql"));
    assert.deepEqual(vers && [vers.from, vers.appliquePar, vers.code], [MAP_VOUS_ID, "cockpit", "utilise"]);
  });

  it("« Vous » utilise les assistants du chat (ni sous-agent, ni caché), les raccourcis et les équipes", () => {
    const result = deriveAgentMap(
      input({
        agents: [...base(), assistant("relire-script"), studio("cache", "primary", {}, { hidden: true }), studio("polyvalent", "all")],
        commands: [{ name: "revue" }],
        equipes: [{ id: "chaine", titre: "Chaîne de relecture de script", etapes: [] }],
      }),
    );
    const utilise = result.edges.filter((e) => e.kind === "utilise");
    assert.ok(utilise.every((e) => e.from === MAP_VOUS_ID && e.confirmation === "aucune" && e.code === "utilise" && !e.refuseEnSimple));
    assert.deepEqual(
      utilise.map((e) => e.to),
      [R("revue"), E("chaine"), A("build"), A("plan"), A("relire-script"), A("polyvalent")],
    );
  });
});

describe("carte des assistants : IA, droits et avertissements", () => {
  it("IA propre, héritée de la conversation ou de l'assistant qui délègue ; ia-indisponible ; droits = rightLines", () => {
    const result = deriveAgentMap(
      input({
        agents: [...base(), assistant("relire-script"), assistant("vieille-ia", [], false)],
        commands: [
          { name: "rapide", agent: "build", ia: { label: "IA du raccourci", niveau: "rapide", disponible: false } },
          { name: "simple", agent: "build" },
        ],
      }),
    );
    assert.deepEqual(node(result, A("relire-script")).ia, { label: "IA de test", niveau: "equilibre", heritee: null });
    assert.deepEqual(node(result, A("relire-script")).droits, rightLines(assistant("relire-script").rules, [], 40));
    assert.equal(node(result, A("relire-script")).title, "Titre relire-script");
    assert.deepEqual(node(result, A("relire-script")).avertissements, []);
    assert.deepEqual(node(result, A("vieille-ia")).avertissements, ["ia-indisponible"]);
    assert.deepEqual(node(result, A("build")).ia, { label: null, niveau: null, heritee: "conversation" });
    assert.deepEqual(node(result, A("general")).ia, { label: null, niveau: null, heritee: "delegant" });
    assert.deepEqual(node(result, R("rapide")).avertissements, ["ia-indisponible"]);
    assert.deepEqual(node(result, R("rapide")).ia, { label: "IA du raccourci", niveau: "rapide", heritee: null });
    assert.deepEqual(node(result, R("simple")).ia, { label: null, niveau: null, heritee: "conversation" });
    assert.ok(result.notes.includes("ia-du-delegant"));
    const sansDelegant = deriveAgentMap(input({ agents: [integre("build"), studio("aide", "subagent", {}, { ia: { label: "IA", niveau: null, disponible: true } })] }));
    assert.equal(sansDelegant.notes.includes("ia-du-delegant"), false);
  });

  it("droits-larges : « allow » sur modification, commande ou dossier externe ; Internet seul ne compte pas", () => {
    const result = deriveAgentMap(
      input({
        agents: [
          integre("build"),
          studio("modifie", "primary", { edit: "allow" }),
          studio("commande", "primary", { bash: "allow" }),
          studio("dehors", "primary", { external_directory: { "*": "allow" } }),
          studio("web", "primary", { webfetch: "allow", websearch: "allow" }),
        ],
      }),
    );
    for (const name of ["modifie", "commande", "dehors"]) assert.deepEqual(node(result, A(name)).avertissements, ["droits-larges"], name);
    assert.deepEqual(node(result, A("web")).avertissements, []);
    assert.deepEqual(node(result, A("build")).avertissements, [], "profil Prudent");
    const sansProfil = deriveAgentMap(input({ agents: [integre("build", {})] }));
    assert.deepEqual(node(sansProfil, A("build")).avertissements, ["droits-larges"], "défaut d'opencode : * allow");
  });
});

describe("carte des assistants : profondeur et notes", () => {
  it("profondeur 1 (et 0) : profondeur-un, un sous-agent ne délègue pas", () => {
    for (const subagentDepth of [0, 1]) {
      const result = deriveAgentMap(input({ agents: base(), subagentDepth }));
      assert.deepEqual(delegues(result, A("general")), []);
      assert.ok(result.notes.includes("profondeur-un"));
      assert.equal(result.notes.includes("profondeur-plus"), false);
    }
  });

  it("profondeur 2 et règle task : le sous-agent délègue, note profondeur-plus en Avancé SEULEMENT (§5.2 l.891)", () => {
    const avance = deriveAgentMap(input({ agents: base(), subagentDepth: 2 }));
    assert.deepEqual(delegues(avance, A("general")).map((e) => e.to), [A("explore"), A("general")]);
    assert.ok(avance.notes.includes("profondeur-plus"));
    assert.equal(avance.notes.includes("profondeur-un"), false, "jamais « ne confie pas plus loin » quand c'est possible");
    const simple = deriveAgentMap(input({ agents: base(), subagentDepth: 2, mode: "simple" }));
    assert.equal(simple.notes.includes("profondeur-plus"), false);
    assert.equal(simple.notes.includes("profondeur-un"), false);
  });

  it("profondeur 2 sans règle task : opencode refuse task à la session déléguée, profondeur-un", () => {
    const global = { edit: "ask", bash: "ask" };
    const agents = [integre("build", global), sousAgentIntegre("general", {}, global), sousAgentIntegre("explore", {}, global)];
    assert.equal(hasTaskRule(agents[1]?.rules ?? []), false);
    const result = deriveAgentMap(input({ agents, subagentDepth: 3 }));
    assert.deepEqual(delegues(result, A("build")).map((e) => [e.to, e.confirmation]), [
      [A("explore"), "sans"],
      [A("general"), "sans"],
    ]);
    assert.deepEqual(delegues(result, A("general")), []);
    assert.ok(result.notes.includes("profondeur-un"));
  });

  it("hasTaskRule : motif qui nomme task, jamais le joker « * »", () => {
    const rule = (permission: string, action: Action = "ask"): Rule => ({ permission, pattern: "*", action });
    assert.equal(hasTaskRule([rule("*", "allow")]), false);
    assert.equal(hasTaskRule([rule("task")]), true);
    assert.equal(hasTaskRule([rule("ta*")]), true);
    assert.equal(hasTaskRule([rule("edit")]), false);
  });

  it("états vides : aucun-assistant, aucun-lien ; regles-pas-historique toujours ; ordre des codes", () => {
    const vide = deriveAgentMap(input({ agents: [integre("build", { task: "deny" })] }));
    assert.deepEqual(vide.notes, ["aucun-assistant", "aucun-lien", "regles-pas-historique"]);
    const plein = deriveAgentMap(input({ agents: [...base(), assistant("relire-script")] }));
    assert.deepEqual(plein.notes, ["profondeur-un", "ia-du-delegant", "regles-pas-historique"]);
    const studioSeul = deriveAgentMap(input({ agents: [integre("build", { task: "deny" }), studio("outil", "subagent", {}, { ia: { label: "IA", niveau: null, disponible: true } })] }));
    assert.equal(studioSeul.notes.includes("aucun-assistant"), false, "un agent du Studio est un assistant installé");
    for (const result of [vide, plein, studioSeul]) {
      const positions = result.notes.map((code) => MAP_NOTE_CODES.indexOf(code));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    }
  });
});

describe("carte des assistants : vues Liste et Centrée", () => {
  const riche = () =>
    deriveAgentMap(
      input({
        agents: [...base(), assistant("relire-sql", ["regles-sql"]), studio("boucle", "all", { task: { "*": "deny", boucle: "allow" } })],
        commands: [{ name: "revue", agent: "relire-sql", subtask: true }],
        fiches: ["regles-sql"],
        equipes: [{ id: "revue-sql", titre: "Revue SQL sur réplica", etapes: [{ assistant: "relire-sql", niveau: null }] }],
      }),
    );

  it("Liste : une section par élément, une entrée par arête, jamais deux", () => {
    const result = riche();
    const sections = mapAsList(result);
    assert.deepEqual(
      sections.map((s) => s.node.id),
      result.nodes.map((n) => n.id),
    );
    const entries = sections.flatMap((s) => s.entries.map((entry) => ({ section: s.node.id, ...entry })));
    assert.equal(entries.length, result.edges.length);
    assert.deepEqual(
      entries.map((e) => e.edge),
      result.edges,
    );
    for (const entry of entries) {
      assert.equal(entry.section, entry.edge.from);
      assert.equal(entry.sens, "sortant");
      assert.equal(entry.autre.id, entry.edge.to);
    }
  });

  it("Liste d'un élément : ses arêtes entrantes et sortantes, une boucle une seule fois ; élément inconnu : rien", () => {
    const result = riche();
    const [general] = mapAsList(result, A("general"));
    assert.ok(general);
    const attendues = result.edges.filter((e) => e.from === A("general") || e.to === A("general"));
    assert.deepEqual(
      general.entries.map((e) => e.edge),
      attendues,
    );
    for (const e of general.entries) {
      const sortant = e.edge.from === A("general");
      assert.equal(e.sens, sortant ? "sortant" : "entrant");
      assert.equal(e.autre.id, sortant ? e.edge.to : e.edge.from);
    }
    assert.deepEqual(
      [...new Set(general.entries.map((e) => e.sens))].sort(),
      ["entrant", "sortant"],
    );
    const [boucle] = mapAsList(result, A("boucle"));
    const soi = boucle?.entries.filter((e) => e.edge.from === A("boucle") && e.edge.to === A("boucle")) ?? [];
    assert.equal(soi.length, 1);
    assert.equal(soi[0]?.sens, "sortant");
    assert.deepEqual(mapAsList(result, "agent:inconnu"), []);
  });

  it("Centrée : « Qui le fait travailler » et « Qui il fait travailler et ce qu'il consulte »", () => {
    const result = riche();
    const vue = neighbours(result, A("relire-sql"));
    assert.ok(vue);
    assert.equal(vue.element.id, A("relire-sql"));
    assert.deepEqual(
      vue.entrants.map((n) => [n.node.id, n.edge.kind]),
      [
        [MAP_VOUS_ID, "utilise"],
        [R("revue"), "lance"],
        [E("revue-sql"), "etape"],
      ],
    );
    assert.deepEqual(
      vue.sortants.map((n) => [n.node.id, n.edge.kind]),
      [[F("regles-sql"), "consulte"]],
    );
    assert.equal(neighbours(result, "agent:inconnu"), null);
  });
});

describe("carte des assistants : entrée", () => {
  it("ordre stable quel que soit l'ordre d'entrée, doublons ignorés (premier gardé)", () => {
    const agents = [...base(), assistant("relire-sql", ["regles-sql"]), studio("polyvalent", "all")];
    const commands = [{ name: "b", agent: "relire-sql" }, { name: "a", agent: "explore" }];
    const fiches = ["regles-sql", "autre"];
    const a = deriveAgentMap(input({ agents, commands, fiches }));
    const b = deriveAgentMap(
      input({ agents: [...agents].reverse().concat([studio("general", "primary")]), commands: [...commands].reverse(), fiches: [...fiches].reverse() }),
    );
    const sansDoublon = deriveAgentMap(input({ agents: [...agents].reverse(), commands: [...commands].reverse(), fiches: [...fiches].reverse() }));
    assert.deepEqual(sansDoublon, a);
    assert.equal(node(b, A("general")).kind, "integre", "le premier agent d'un nom est gardé");
  });

  it("subagentDepth invalide : RangeError", () => {
    for (const subagentDepth of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => deriveAgentMap(input({ subagentDepth })), RangeError, String(subagentDepth));
    }
  });
});

// --- Parité sur jeux de règles aléatoires --------------------------------------------------------------------------------------

/** Générateur à graine fixe (mulberry32) : les 200 jeux sont les mêmes à chaque exécution. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMS = ["build", "general", "explore", "revue", "relire-sql", "x", "testeur", "compaction", "cockpit-classifier", "gardien", "genie"];
const PERMISSIONS = ["task", "*", "ta*", "t?sk", "skill", "edit", "sk*"];
const MOTIFS = [...NOMS, "*", "gen*", "re*", "*e*", "fiche-*", "fiche-a"];
const ACTIONS: readonly Action[] = ["allow", "ask", "deny"];
const FICHES = ["fiche-a", "fiche-b", "revue"];

function randomInput(next: () => number): AgentMapInput {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const noms = NOMS.filter(() => next() < 0.6);
  const agents = noms.map((name): MapAgentInput => {
    const rules: Rule[] = Array.from({ length: Math.floor(next() * 9) }, () => ({ permission: pick(PERMISSIONS), pattern: pick(MOTIFS), action: pick(ACTIONS) }));
    return { name, mode: pick(["primary", "subagent", "all"] as const), hidden: next() < 0.3, origine: pick(["assistant", "integre", "studio"] as const), rules };
  });
  return input({
    agents,
    fiches: FICHES.filter(() => next() < 0.7),
    subagentDepth: Math.floor(next() * 4),
    mode: next() < 0.5 ? "simple" : "avance",
    internes: ["gardien"],
  });
}

/** Registre d'opencode (conception C R2, R5-R6) écrit directement sur evaluate : délégations et fiches attendues. */
function reference(i: AgentMapInput): { delegue: string[]; consulte: string[] } {
  const agents = i.agents.filter((a) => !i.internes.includes(a.name) && !isInternalAgentName(a.name));
  const delegue: string[] = [];
  const consulte: string[] = [];
  for (const caller of agents) {
    const nommeTask = caller.rules.some((r) => r.permission !== "*" && wildcardMatch("task", r.permission));
    const appelle = caller.mode !== "subagent" || (i.subagentDepth > 1 && nommeTask);
    for (const target of agents) {
      if (!appelle || target.mode === "primary") continue;
      const action = evaluate(caller.rules, "task", target.name);
      if (action !== "deny") delegue.push(`${caller.name}>${target.name}>${action}`);
    }
    for (const fiche of i.fiches) {
      const action = evaluate(caller.rules, "skill", fiche);
      if (action !== "deny") consulte.push(`${caller.name}>${fiche}>${action}`);
    }
  }
  return { delegue: delegue.sort(), consulte: consulte.sort() };
}

describe("carte des assistants : parité sur 200 jeux de règles aléatoires (graine fixe) contre evaluate", () => {
  it("délégations et fiches identiques au registre ; codes, confirmation et refus en Simple cohérents", () => {
    const next = mulberry32(20260919);
    const nameOf = (id: string) => id.slice(id.indexOf(":") + 1);
    const vus = { allow: 0, ask: 0, simple: 0, profondeur: 0 };
    for (let n = 0; n < 200; n++) {
      const i = randomInput(next);
      const result = deriveAgentMap(i);
      const attendu = reference(i);
      const action = (e: MapEdge) => (e.confirmation === "sans" ? "allow" : "ask");
      const delegue = result.edges.filter((e) => e.kind === "delegue");
      assert.deepEqual(delegue.map((e) => `${nameOf(e.from)}>${nameOf(e.to)}>${action(e)}`).sort(), attendu.delegue, `jeu ${n}`);
      const consulte = result.edges.filter((e) => e.kind === "consulte");
      assert.deepEqual(consulte.map((e) => `${nameOf(e.from)}>${nameOf(e.to)}>${action(e)}`).sort(), attendu.consulte, `jeu ${n}`);
      for (const e of delegue) {
        const refuse = i.mode === "simple" && e.confirmation === "demandee";
        assert.equal(e.refuseEnSimple, refuse, `jeu ${n}`);
        assert.equal(e.appliquePar, refuse ? "cockpit" : "opencode", `jeu ${n}`);
        assert.equal(e.code, e.confirmation === "sans" ? "delegue-sans-confirmation" : refuse ? "delegue-refuse-en-simple" : "delegue-apres-accord", `jeu ${n}`);
        vus[action(e)]++;
        if (refuse) vus.simple++;
      }
      if (result.notes.includes("profondeur-plus")) vus.profondeur++;
      assert.equal(result.notes.includes("profondeur-plus") && i.mode === "simple", false, `jeu ${n}`);
      assert.equal(result.notes.at(-1), "regles-pas-historique", `jeu ${n}`);
      assert.equal(mapAsList(result).reduce((total, s) => total + s.entries.length, 0), result.edges.length, `jeu ${n}`);
    }
    // Jeux assez variés pour que la parité ne soit pas vide.
    assert.ok(vus.allow > 50 && vus.ask > 50 && vus.simple > 20 && vus.profondeur > 5, JSON.stringify(vus));
  });
});

describe("carte des assistants : module pur, codes seulement", () => {
  it("ni « node: » ni process ; imports : assistant-rules et agent-choice seulement (studio.ts jamais) ; aucune phrase écrite", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "agent-map.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["./agent-choice.ts", "./assistant-rules.ts"]);
    // Code sans commentaires : chaque chaîne littérale (et chaque morceau de gabarit) est un code, jamais une phrase.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const literals = [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, ""));
    assert.ok(literals.length > 40, String(literals.length));
    for (const literal of literals) assert.match(literal, /^[a-z0-9:*._/-]*$/, literal);
  });
});
