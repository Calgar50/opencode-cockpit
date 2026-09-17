// Tests L3, module pur des planchers (spécification §3.4, D5, P4 ; plan fiche L3) : contenu de chaque plancher, « jamais plus
// permissif » (500 jeux de règles × 40 couples, graine fixe), disabled() pour ETAPE et PLAN, aucune règle « allow » ni « ask » sur
// une racine, jamais « *.env: ask » ni « *.env.example: allow », vérification de l'écho (floorHolds), marque enregistrée.
// Conformité aux mesures : listes d'outils de M2 (fixtures/m2-tools.json) et de MX1 (M3, M16 : fixtures/mx1-mesures.json).
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { type Action, evaluate, KEY_FILE_READ_RULES, type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import type { FloorKind } from "./shared/autonomy-types.ts";
import {
  buildFloor,
  canonicalRules,
  conversationFloorHolds,
  DENY_ONLY_FLOORS,
  disabledTools,
  FLOOR_KINDS,
  floorHolds,
  floorMark,
  keyFileDenyRules,
  MCP_RESOURCE_TOOLS,
  parseFloorMark,
  readSessionRules,
  STEP_READ_PERMISSIONS,
  toolPermission,
} from "./shared/session-floors.ts";
import { builtinTools, nativeAgents } from "./test-support/fake-opencode.ts";

interface Mx1Tools {
  configPermission: Record<string, unknown>;
  mcpResourceTools: string[];
  floor: Rule[];
  cases: Array<{ name: string; model: string; permission: Rule[] | "floor" | null; patch?: boolean; tools: string[] }>;
}

interface M2Fixture {
  model: { providerID: string; modelID: string };
  configPermission: Record<string, unknown>;
  cases: Array<{ name: string; agent: string; parent?: string; create: Rule[] | null; patch: Rule[] | null; tools: string[] }>;
}

const mx1 = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/mx1-mesures.json", import.meta.url), "utf8")) as { tools: Mx1Tools };
const m2 = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/m2-tools.json", import.meta.url), "utf8")) as M2Fixture;

const RANK: Readonly<Record<Action, number>> = { deny: 0, ask: 1, allow: 2 };
const deny = (permission: string, pattern: string): Rule => ({ permission, pattern, action: "deny" });

/** Générateur à graine fixe (mulberry32) : mêmes 500 jeux de règles à chaque exécution. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TRUNCATED = truncateGlob();

/** Permissions des jeux aléatoires : noms exacts, jokers de permission (« * », « re* », « r?ad »), permissions des étapes. */
const RULE_PERMISSIONS = ["*", "read", "re*", "r?ad", "grep", "glob", "list", "external_directory", "edit", "e*", "bash", "task", "webfetch", "websearch", "todowrite", "question", "skill", "doom_loop"];
/** Motifs des jeux aléatoires : fichiers de clés, .env, ressources MCP, sorties tronquées, commandes, motifs larges ou vides. */
const RULE_PATTERNS = ["*", "**", "?", "", "*.env", "*.env.*", "*.env.example", "*.pfx", "*.key", "*id_rsa*", "*kubeconfig*", "mcp:*", "mcp:fixture:*", TRUNCATED, "/tmp/*", "src/*", "*.ts", "git *", "ls", "a*"];
const ACTIONS: readonly Action[] = ["allow", "ask", "deny"];

/** 40 couples permission/motif évalués : fichiers de clés et .env, MCP, sorties tronquées, dossiers externes, modification, shell… */
const COUPLES: ReadonlyArray<readonly [string, string]> = [
  ["read", "config/.env"],
  ["read", "a.env.local"],
  ["read", "x/.env.example"],
  ["read", "cle.pfx"],
  ["read", "CLE.PFX"],
  ["read", "secrets/server.key"],
  ["read", "home/.ssh/id_rsa"],
  ["read", "id_ed25519.pub"],
  ["read", "prod-kubeconfig"],
  ["read", "home/.kube/config"],
  ["read", "src/main.ts"],
  ["read", "README.md"],
  ["read", "mcp:fixture:fixture://note"],
  ["read", `${TRUNCATED.slice(0, -1)}sortie-1`],
  ["read", "/tmp/x"],
  ["read", "a"],
  ["grep", "*.pfx"],
  ["grep", "src/*"],
  ["glob", "**/*.key"],
  ["glob", "src/*.ts"],
  ["list", "/workspace"],
  ["list", "/tmp/x"],
  ["external_directory", TRUNCATED],
  ["external_directory", "/tmp/*"],
  ["external_directory", "/etc/*"],
  ["edit", "src/main.ts"],
  ["edit", ".env"],
  ["edit", "cle.pfx"],
  ["bash", "git status"],
  ["bash", "ls"],
  ["bash", "rm -rf /"],
  ["bash", "cat cle.pfx"],
  ["task", "general"],
  ["task", "explore"],
  ["webfetch", "https://example.com"],
  ["websearch", "opencode"],
  ["todowrite", "*"],
  ["question", "*"],
  ["skill", "revue"],
  ["doom_loop", "*"],
];

function randomRuleSets(count: number, seed: number): Rule[][] {
  const next = seeded(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  return Array.from({ length: count }, () =>
    Array.from({ length: Math.floor(next() * 13) }, (): Rule => ({ permission: pick(RULE_PERMISSIONS), pattern: pick(RULE_PATTERNS), action: pick(ACTIONS) })),
  );
}

const RULE_SETS = randomRuleSets(500, 0x5eed_f10a);

/** Couples où `floorOf(agent)` rend opencode plus permissif que les règles de l'assistant seules (vide : jamais plus permissif). */
function morePermissive(floorOf: (agent: Rule[]) => Rule[]): { widened: string[]; narrowed: number; kept: number } {
  const widened: string[] = [];
  let narrowed = 0;
  let kept = 0;
  RULE_SETS.forEach((agent, index) => {
    const combined = [...agent, ...floorOf(agent)];
    for (const [permission, input] of COUPLES) {
      const before = RANK[evaluate(agent, permission, input)];
      const after = RANK[evaluate(combined, permission, input)];
      if (after > before) widened.push(`jeu ${index} : ${permission} ${input}`);
      else if (after < before) narrowed++;
      else kept++;
    }
  });
  return { widened, narrowed, kept };
}

/** Outils de la 1.18.30 (IA « gpt- » et autres), plus des outils sans règle propre ; sans outil MCP. */
const TOOLS = [...new Set([...builtinTools("gpt-5-mini"), ...builtinTools("claude-sonnet-5"), "list", "websearch", "codesearch", "lsp", "batch", "plan_exit"])];
const NATIVE = nativeAgents();

describe("planchers : contenu (§3.4, D5)", () => {
  it("CONVERSATION = les 18 refus de KEY_FILE_READ_RULES, dans leur ordre, identiques au plancher mesuré par MX1 (M16)", () => {
    const floor = buildFloor("CONVERSATION");
    const denied = Object.entries(KEY_FILE_READ_RULES).filter(([, action]) => action === "deny");
    assert.equal(floor.length, 18);
    assert.deepEqual(floor, denied.map(([pattern]) => deny("read", pattern)));
    assert.deepEqual(floor, mx1.tools.floor);
    assert.deepEqual(keyFileDenyRules(), floor);
  });

  it("PLAN = CONVERSATION + edit * deny + bash * deny ; CONTROLE = * * deny", () => {
    assert.deepEqual(buildFloor("PLAN"), [...buildFloor("CONVERSATION"), deny("edit", "*"), deny("bash", "*")]);
    assert.deepEqual(buildFloor("CONTROLE"), [deny("*", "*")]);
  });

  it("ETAPE : * * deny, lectures permises, sorties tronquées, recopie en refus des règles de l'assistant, clés, read mcp:* deny", () => {
    const agentRules: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "ask" },
      { permission: "read", pattern: "*.env.example", action: "allow" },
      { permission: "re*", pattern: "secret/*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
    ];
    assert.deepEqual(buildFloor("ETAPE", { agentRules, truncateGlob: "/data/tool-output/*" }), [
      deny("*", "*"),
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "/data/tool-output/*", action: "allow" },
      deny("read", "*.env"),
      deny("read", "secret/*"),
      deny("external_directory", "*"),
      ...keyFileDenyRules(),
      deny("read", "mcp:*"),
    ]);
    // Règle suivie d'une règle de motif « * » de la même permission : elle ne décide jamais, elle n'est pas recopiée (explore).
    const shadowed: Rule[] = [deny("*", "*"), { permission: "read", pattern: "*", action: "allow" }, { permission: "read", pattern: "*.pfx", action: "ask" }];
    assert.deepEqual(
      buildFloor("ETAPE", { agentRules: shadowed, truncateGlob: "/t/*" }).slice(6, -19),
      [deny("read", "*.pfx"), deny("grep", "*"), deny("glob", "*"), deny("list", "*"), deny("external_directory", "*")],
    );
    // Aucune règle « * » pour grep, glob et list chez l'assistant : sans règle, opencode demanderait ; l'étape les refuse.
    const bare = buildFloor("ETAPE", { agentRules: [] });
    for (const permission of [...STEP_READ_PERMISSIONS, "external_directory"]) assert.ok(bare.some((r) => r.permission === permission && r.pattern === "*" && r.action === "deny"), permission);
    assert.ok(bare.some((r) => r.permission === "external_directory" && r.pattern === TRUNCATED && r.action === "allow"), "Truncate.GLOB par défaut");
    assert.throws(() => buildFloor("ETAPE"), RangeError);
  });

  it("aucune règle « allow » ni « ask » sur une racine ; jamais « *.env: ask » ni « *.env.example: allow » ; ETAPE : 5 autorisations exactes", () => {
    assert.deepEqual([...DENY_ONLY_FLOORS].sort(), ["CONTROLE", "CONVERSATION", "PLAN"]);
    for (const kind of DENY_ONLY_FLOORS) {
      assert.deepEqual(buildFloor(kind).filter((rule) => rule.action !== "deny"), [], kind);
    }
    const envPatterns = new Set(Object.keys(KEY_FILE_READ_RULES).filter((pattern) => KEY_FILE_READ_RULES[pattern] !== "deny"));
    assert.deepEqual([...envPatterns].sort(), ["*.env", "*.env.*", "*.env.example"]);
    for (const agentRules of [[], ...NATIVE.map((agent) => agent.permission), ...RULE_SETS.slice(0, 100)]) {
      for (const kind of FLOOR_KINDS) {
        const floor = buildFloor(kind, { agentRules });
        assert.equal(floor.filter((rule) => rule.action === "ask").length, 0, `${kind} : aucune règle « ask »`);
        assert.equal(floor.filter((rule) => rule.action !== "deny" && envPatterns.has(rule.pattern)).length, 0, `${kind} : .env jamais levé`);
        const allows = floor.filter((rule) => rule.action === "allow").map((rule) => `${rule.permission} ${rule.pattern}`);
        assert.deepEqual(allows, kind === "ETAPE" ? ["read *", "grep *", "glob *", "list *", `external_directory ${TRUNCATED}`] : [], kind);
      }
    }
  });
});

describe("planchers : jamais plus permissif (§3.4, 500 jeux × 40 couples, graine fixe)", () => {
  it("générateur figé : 500 jeux, 40 couples, contenu stable", () => {
    assert.equal(RULE_SETS.length, 500);
    assert.equal(COUPLES.length, 40);
    assert.equal(new Set(COUPLES.map(([p, i]) => `${p} ${i}`)).size, 40);
    const rules = RULE_SETS.flat();
    assert.equal(rules.length, RULE_SETS.reduce((n, set) => n + set.length, 0));
    for (const action of ACTIONS) assert.ok(rules.some((rule) => rule.action === action), action);
    assert.deepEqual(randomRuleSets(3, 0x5eed_f10a), RULE_SETS.slice(0, 3));
  });

  for (const kind of FLOOR_KINDS) {
    it(`${kind} : evaluate(agent ++ plancher) n'est jamais plus permissif que evaluate(agent)`, () => {
      const result = morePermissive((agent) => buildFloor(kind, { agentRules: agent }));
      assert.deepEqual(result.widened.slice(0, 5), [], `${result.widened.length} couples élargis`);
      // Le test n'est pas vide : le plancher refuse vraiment quelque chose, et laisse le reste à l'assistant (sauf CONTROLE).
      assert.ok(result.narrowed > 500, `${kind} : ${result.narrowed} couples resserrés`);
      if (kind !== "CONTROLE") assert.ok(result.kept > 500, `${kind} : ${result.kept} couples inchangés`);
    });
  }

  it("le test détecte un plancher fautif : « *.env allow » ajouté, ou ETAPE sans refus complémentaire sur « * »", () => {
    const envAllowed = morePermissive(() => [...buildFloor("CONVERSATION"), { permission: "read", pattern: "*.env", action: "allow" }]);
    assert.ok(envAllowed.widened.length > 0);
    const noCompletion = morePermissive((agent) => buildFloor("ETAPE", { agentRules: agent }).filter((rule) => !(rule.action === "deny" && rule.pattern === "*" && rule.permission !== "*")));
    assert.ok(noCompletion.widened.length > 0);
  });

  it("fichiers de clés refusés pour tout assistant natif, .env laissé à l'assistant (« avec votre accord »)", () => {
    for (const agent of NATIVE) {
      const combined = [...agent.permission, ...buildFloor("CONVERSATION")];
      for (const input of ["cle.pfx", "CLE.P12", "srv.key", "home/.ssh/id_ed25519", "cluster-kubeconfig", "home/.kube/config", "tls-key.pem"]) {
        assert.equal(evaluate(combined, "read", input), "deny", `${agent.name} ${input}`);
      }
      assert.equal(evaluate(combined, "read", "config/.env"), evaluate(agent.permission, "read", "config/.env"), agent.name);
      assert.equal(evaluate(combined, "read", "config/.env.example"), evaluate(agent.permission, "read", "config/.env.example"), agent.name);
    }
  });
});

describe("planchers : disabled() (F-e, M2, M3)", () => {
  it("toolPermission : edit pour les outils de modification, read pour les ressources MCP", () => {
    assert.deepEqual(["edit", "write", "apply_patch", ...MCP_RESOURCE_TOOLS, "bash"].map(toolPermission), ["edit", "edit", "edit", "read", "read", "read", "bash"]);
  });

  it("ETAPE ne laisse que read grep glob list (sans MCP à ressources), pour tout assistant", () => {
    const readTools = new Set(STEP_READ_PERMISSIONS);
    for (const agent of NATIVE) {
      const rules = [...agent.permission, ...buildFloor("ETAPE", { agentRules: agent.permission })];
      const left = TOOLS.filter((tool) => !disabledTools(rules, TOOLS).includes(tool));
      // Assistant caché (« * deny ») : read reste visible (dernière règle read = « mcp:* », motif précis), chaque lecture refusée.
      assert.deepEqual(left.sort(), agent.hidden ? ["read"] : ["glob", "grep", "list", "read"], agent.name);
      if (agent.hidden) for (const input of ["src/main.ts", "README.md"]) assert.equal(evaluate(rules, "read", input), "deny", agent.name);
      else assert.equal(evaluate(rules, "read", "src/main.ts"), "allow", agent.name);
    }
    for (const agentRules of RULE_SETS) {
      const rules = [...agentRules, ...buildFloor("ETAPE", { agentRules })];
      for (const tool of TOOLS.filter((candidate) => !disabledTools(rules, TOOLS).includes(candidate))) assert.ok(readTools.has(tool), tool);
    }
  });

  it("ETAPE avec un MCP à ressources : les trois outils restent visibles, refusés à l'appel (M3)", () => {
    const build = NATIVE.find((agent) => agent.name === "build");
    assert.ok(build);
    const tools = [...TOOLS, ...MCP_RESOURCE_TOOLS];
    const rules = [...build.permission, ...buildFloor("ETAPE", { agentRules: build.permission })];
    const left = tools.filter((tool) => !disabledTools(rules, tools).includes(tool));
    assert.deepEqual(left.sort(), ["glob", "grep", "list", "list_mcp_resource_templates", "list_mcp_resources", "read", "read_mcp_resource"]);
    assert.equal(evaluate(rules, "read", "mcp:fixture:*"), "deny");
    assert.equal(evaluate(rules, "read", "mcp:fixture:fixture://note"), "deny");
    assert.equal(evaluate(rules, "read", "src/main.ts"), "allow");
  });

  it("PLAN retire edit write apply_patch bash, et rien d'autre ; CONVERSATION ne retire rien ; CONTROLE retire tout", () => {
    for (const agent of NATIVE.filter((candidate) => !candidate.hidden)) {
      const own = new Set(disabledTools(agent.permission, TOOLS));
      const added = (kind: FloorKind) => disabledTools([...agent.permission, ...buildFloor(kind)], TOOLS).filter((tool) => !own.has(tool)).sort();
      assert.deepEqual(added("PLAN"), ["apply_patch", "bash", "edit", "write"].filter((tool) => !own.has(tool)), agent.name);
      assert.deepEqual(added("CONVERSATION"), [], agent.name);
      assert.deepEqual(disabledTools([...agent.permission, ...buildFloor("CONTROLE")], TOOLS).sort(), [...TOOLS].sort(), agent.name);
    }
    assert.deepEqual(disabledTools(buildFloor("PLAN"), TOOLS).sort(), ["apply_patch", "bash", "edit", "write"]);
  });

  it("listes d'outils mesurées : M2 (racines) et MX1 (M16 plancher à la création et par PATCH, M3 ETAPE, read mcp:*, read *)", () => {
    const remaining = (rules: Rule[], offered: readonly string[]) => offered.filter((tool) => !disabledTools(rules, offered).includes(tool)).sort();
    const m2Build = nativeAgents(m2.configPermission).find((agent) => agent.name === "build");
    assert.ok(m2Build);
    const roots = m2.cases.filter((c) => c.parent === undefined);
    assert.equal(roots.length, 4);
    for (const c of roots) {
      const session = [...(c.create ?? []), ...(c.patch ?? [])];
      assert.deepEqual(remaining([...m2Build.permission, ...session], builtinTools(m2.model.modelID)), c.tools, `M2 ${c.name}`);
    }
    // PLAN sur une racine : mêmes outils que la racine mesurée « edit + bash refusés » (les refus de clés ne retirent pas read).
    const measuredPlan = m2.cases.find((c) => c.name === "racine-edit-bash-refuses");
    assert.ok(measuredPlan);
    assert.deepEqual(remaining([...m2Build.permission, ...buildFloor("PLAN")], builtinTools(m2.model.modelID)), measuredPlan.tools);

    const mx1Build = nativeAgents(mx1.tools.configPermission).find((agent) => agent.name === "build");
    assert.ok(mx1Build);
    const baseline = new Map(mx1.tools.cases.filter((c) => c.permission === null).map((c) => [c.name, c.tools]));
    for (const c of mx1.tools.cases) {
      const offered = c.name.startsWith("m3-") ? (baseline.get("m3-temoin") ?? []) : c.model === "gpt-5-mock" ? (baseline.get("meta-gpt-5-mock") ?? []) : (baseline.get("meta-mock-1") ?? []);
      assert.ok(offered.length > 0, c.name);
      const session = c.permission === "floor" ? mx1.tools.floor : (c.permission ?? []);
      assert.deepEqual(remaining([...mx1Build.permission, ...session], offered), c.tools, `MX1 ${c.name}`);
    }
    // M16 : le plancher CONVERSATION posé à la création ou par PATCH ne retire aucun outil (read reste, refusé sur les clés).
    const temoin = baseline.get("meta-mock-1") ?? [];
    assert.deepEqual(remaining([...mx1Build.permission, ...buildFloor("CONVERSATION")], temoin), temoin);
    // M3 : l'ETAPE complet du cockpit donne la même liste que l'ETAPE réduit mesuré.
    const measuredStep = mx1.tools.cases.find((c) => c.name === "m3-etape");
    assert.ok(measuredStep);
    assert.deepEqual(remaining([...mx1Build.permission, ...buildFloor("ETAPE", { agentRules: mx1Build.permission })], baseline.get("m3-temoin") ?? []), measuredStep.tools);
  });
});

describe("planchers : vérification de l'écho (floorHolds) et marque", () => {
  const floor = buildFloor("CONVERSATION");
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it("écho exact (POST) ou refus déjà posés puis plancher (PATCH ajoute, F-g) : tenu", () => {
    assert.equal(floorHolds(clone(floor), floor), true);
    assert.equal(conversationFloorHolds(clone(floor)), true);
    assert.equal(floorHolds([...clone(floor), ...clone(floor)], floor), true);
    assert.equal(floorHolds([deny("edit", "*"), deny("todowrite", "*"), ...clone(floor)], floor), true);
    assert.equal(floorHolds([...buildFloor("PLAN"), ...clone(floor)], floor), true);
    // Ordre des clés d'une règle indifférent (JSON), ordre des règles significatif.
    assert.equal(floorHolds(floor.map((r) => ({ action: r.action, pattern: r.pattern, permission: r.permission })), floor), true);
  });

  it("écarts : valeur illisible, plancher manquant, réordonné, modifié, règle après, allow ou ask avant, clé en plus, plancher vide", () => {
    const cases: Array<[string, unknown, readonly Rule[]]> = [
      ["absent", undefined, floor],
      ["null", null, floor],
      ["objet", { read: "deny" }, floor],
      ["vide", [], floor],
      ["plancher vide", [], []],
      ["tronqué", floor.slice(1), floor],
      ["dernière règle retirée", floor.slice(0, -1), floor],
      ["réordonné", [...floor.slice(1), floor[0]], floor],
      ["motif changé", floor.map((r, i) => (i === 3 ? { ...r, pattern: "*.PFX " } : r)), floor],
      ["action en majuscules", floor.map((r, i) => (i === 0 ? { ...r, action: "DENY" } : r)), floor],
      ["action allow", floor.map((r, i) => (i === 17 ? { ...r, action: "allow" } : r)), floor],
      ["règle après", [...floor, deny("read", "x")], floor],
      ["allow avant", [{ permission: "read", pattern: "*.env", action: "allow" }, ...floor], floor],
      ["ask avant", [{ permission: "*", pattern: "*", action: "ask" }, ...floor], floor],
      ["clé en plus", floor.map((r, i) => (i === 5 ? { ...r, extra: 1 } : r)), floor],
      ["clé manquante", floor.map((r, i) => (i === 5 ? { permission: r.permission, pattern: r.pattern } : r)), floor],
      ["motif non texte", floor.map((r, i) => (i === 2 ? { ...r, pattern: 7 } : r)), floor],
      ["élément non objet", [...floor.slice(0, -1), "deny"], floor],
    ];
    for (const [name, value, expected] of cases) assert.equal(floorHolds(value, expected), false, name);
    assert.equal(conversationFloorHolds(buildFloor("CONTROLE")), false);
  });

  it("readSessionRules : trois champs exacts ; canonicalRules : clés dans l'ordre, règles dans leur ordre", () => {
    assert.deepEqual(readSessionRules([{ action: "ask", permission: "bash", pattern: "*" }]), [{ permission: "bash", pattern: "*", action: "ask" }]);
    assert.equal(readSessionRules([{ permission: "bash", pattern: "*", action: "ask", __proto__: null, x: 1 }]), null);
    assert.equal(readSessionRules("[]"), null);
    const rule = { permission: "read", pattern: "*.pfx", action: "deny" };
    for (const [name, item] of [
      ["action inconnue", { ...rule, action: "refuse" }],
      ["action en majuscules", { ...rule, action: "DENY" }],
      ["motif non texte", { ...rule, pattern: 7 }],
      ["permission non texte", { ...rule, permission: null }],
      ["élément tableau", ["read", "*.pfx", "deny"]],
    ] as const) {
      assert.equal(readSessionRules([rule, item]), null, name);
    }
    assert.deepEqual(readSessionRules([rule]), [rule]);
    assert.equal(canonicalRules([{ action: "deny", pattern: "b", permission: "a" } as Rule]), '[{"permission":"a","pattern":"b","action":"deny"}]');
    assert.notEqual(canonicalRules(buildFloor("PLAN")), canonicalRules([...buildFloor("PLAN")].reverse()));
  });

  it("marque « <genre>:<sha256> » : aller-retour, empreinte invalide refusée, marque illisible → null", () => {
    const hash = "a".repeat(64);
    for (const kind of FLOOR_KINDS) assert.deepEqual(parseFloorMark(floorMark(kind, hash)), { kind, hash });
    assert.equal(floorMark("PLAN", hash), `plan:${hash}`);
    for (const bad of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) assert.throws(() => floorMark("CONVERSATION", bad), RangeError, bad);
    for (const mark of [null, undefined, "", hash, `:${hash}`, `CONVERSATION:${hash}`, `inconnu:${hash}`, `conversation:${hash}0`, `conversation:${"A".repeat(64)}`, "conversation:"]) {
      assert.equal(parseFloorMark(mark), null, String(mark));
    }
  });
});
