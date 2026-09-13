import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { buildDigest, ftsQuery, isDefaultTitle, projectOf } from "./archive.ts";
import { catalogLite, ModelCatalog } from "./catalog.ts";
import { extractJson, parseClassifierOutput } from "./classifier.ts";
import { openMemoryDb } from "./db.ts";
import { EnvError, parseAllowedProviders } from "./env.ts";
import { FrontmatterError, parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { safeSegment, slugify } from "./fsutil.ts";
import { classifyHeuristic } from "./heuristic.ts";
import type { OcMessageWithParts, OcSession, OpencodeClient } from "./opencode.ts";
import { COPILOT_PRICES, computeCost, priceFromCatalog, resolveMessageCost } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import { hostnameOf, safeEqual, sessionValue } from "./security.ts";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  mergeSettings,
  RULES_VERSION,
  SettingsError,
  SettingsStore,
  settingsPathsOutsideSimple,
} from "./settings.ts";
import {
  type AgentLite,
  type AssistantDraft,
  assistantPermission,
  buildAssistantFile,
  builtinAssistantInfo,
  type CatalogLite,
  COMMON_RULES_BLOCK,
  COMMON_RULES_START,
  type CommandLite,
  chooseEstimate,
  DEFAULT_TIERS,
  describeTurn,
  detectPermissionPreset,
  detectRights,
  PERMISSION_PRESET_IDS,
  PERMISSION_PRESETS,
  presetPermission,
  toCatalogLite,
  draftVariant,
  effectiveAgentRules,
  effectiveBuiltinRules,
  estimateTaskCost,
  evaluate,
  isDefaultProviders,
  isReservedModel,
  isSubtask,
  OPENCODE_AGENT_KEYS,
  parseModelKey,
  perRequestText,
  providerOf,
  rangeText,
  resolveChatTurn,
  resolveCommandTurn,
  resolveTier,
  type Rule,
  rightLines,
  rulesFromConfig,
  budgetShareText,
  formatUsd,
  slugifyName,
  stripCommonRules,
  TIER_IDS,
  unknownAgentKeys,
  uniqueName,
  variantLabel,
  wildcardMatch,
  withTierAvailability,
} from "./shared/assistant-rules.ts";
import { agentFrontmatterSchema, commandFrontmatterSchema, skillFrontmatterSchema } from "./studio-schema.ts";

const usage = (input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, reasoning, cacheRead, cacheWrite });
const noCatalog = { overrides: {}, catalog: new Map(), preferTable: false };

describe("tarification", () => {
  it("applique entrée, cache et sortie (raisonnement au prix de sortie)", () => {
    const price = COPILOT_PRICES["claude-sonnet-5"];
    assert.ok(price);
    assert.equal(computeCost(usage(1_000, 500, 100, 10_000, 2_000), price), 0.015);
  });

  it("bascule sur le palier long contexte au-delà du seuil", () => {
    const price = COPILOT_PRICES["gpt-5.4"];
    assert.ok(price);
    assert.equal(computeCost(usage(100_000, 1_000), price), 0.265);
    assert.equal(computeCost(usage(280_000, 1_000), price), 1.4225);
  });

  it("compte l'écriture de cache au prix d'entrée quand elle n'est pas tarifée", () => {
    const price = COPILOT_PRICES["gpt-5-mini"];
    assert.ok(price);
    assert.equal(computeCost(usage(0, 0, 0, 0, 1_000), price), 0.00025);
  });

  it("préfère le coût rapporté par opencode, sauf si la grille est imposée", () => {
    const msg = { providerID: "github-copilot", modelID: "claude-sonnet-5", reportedCost: 0.5, usage: usage(1_000_000) };
    assert.deepEqual(resolveMessageCost(msg, noCatalog), { cost: 0.5, estimated: 2, source: "reported" });
    assert.equal(resolveMessageCost(msg, { ...noCatalog, preferTable: true }).source, "table");
    assert.equal(resolveMessageCost({ ...msg, reportedCost: 0 }, noCatalog).cost, 2);
  });

  it("utilise les tarifs personnalisés puis le catalogue", () => {
    const override = { rates: { input: 1, cachedInput: 0, cacheWrite: null, output: 1 } };
    const ctx = { overrides: { "github-copilot/claude-sonnet-5": override }, catalog: new Map(), preferTable: true };
    assert.equal(resolveMessageCost({ providerID: "github-copilot", modelID: "claude-sonnet-5", reportedCost: 0, usage: usage(1_000_000) }, ctx).source, "override");
    const unknown = resolveMessageCost({ providerID: "x", modelID: "y", reportedCost: 0, usage: usage(10) }, noCatalog);
    assert.deepEqual(unknown, { cost: 0, estimated: null, source: "none" });
  });

  it("convertit les paliers du catalogue opencode", () => {
    const price = priceFromCatalog({ input: 2, output: 8, cache: { read: 0.5, write: 0 }, tiers: [{ input: 4, output: 16, tier: { type: "context", size: 200_000 } }] });
    assert.equal(price.rates.cacheWrite, null);
    assert.equal(price.tiers?.[0]?.aboveInputTokens, 200_000);
  });
});

describe("en-têtes Markdown", () => {
  it("lit l'en-tête YAML et le corps", () => {
    const doc = parseFrontmatter("---\ndescription: Test\nmode: subagent\n---\nCorps\n");
    assert.equal(doc.data.mode, "subagent");
    assert.equal(doc.body, "Corps\n");
  });

  it("tolère BOM et fins de ligne Windows", () => {
    const doc = parseFrontmatter(`${String.fromCharCode(0xfeff)}---\r\na: 1\r\n---\r\nX`);
    assert.equal(doc.data.a, 1);
    assert.equal(doc.body, "X");
  });

  it("refuse un YAML invalide ou non objet", () => {
    assert.throws(() => parseFrontmatter("---\na: [\n---\n"), FrontmatterError);
    assert.throws(() => parseFrontmatter("---\n- a\n---\n"), FrontmatterError);
  });

  it("recompose un fichier relisible", () => {
    const text = stringifyFrontmatter({ description: "Revue: sécurité", mode: "subagent", ignored: undefined }, "\n\nCorps");
    const doc = parseFrontmatter(text);
    assert.deepEqual(doc.data, { description: "Revue: sécurité", mode: "subagent" });
    assert.equal(doc.body.trim(), "Corps");
  });
});

describe("schémas du studio (règles opencode)", () => {
  it("clés inconnues refusées pour un nouvel agent, tolérées si déjà présentes", () => {
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", mode: "nope" }).success, false);
    // core/v1/config/agent.ts:62-66 : une clé inconnue partirait telle quelle chez le fournisseur.
    assert.deepEqual(unknownAgentKeys({ description: "x", mode: "primary", custom: 1 }), ["custom"]);
    assert.deepEqual(unknownAgentKeys({ description: "x", custom: 1 }, { description: "ancien", custom: 0 }), []);
    assert.deepEqual(unknownAgentKeys({ description: "x", custom: 1, autre: true }, { custom: 0 }), ["autre"]);
    assert.equal(OPENCODE_AGENT_KEYS.has("permission"), true);
  });

  it("valide les permissions par motif et les clés à action simple", () => {
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", permission: { edit: "ask", bash: { "*": "ask", "git *": "allow" } } }).success, true);
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", permission: { webfetch: { "*": "allow" } } }).success, false);
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", permission: "deny" }).success, true);
  });

  it("contrôle couleur et modèle", () => {
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", color: "#ff0000" }).success, true);
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", color: "rouge" }).success, false);
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", model: "sans-fournisseur" }).success, false);
  });

  it("commande stricte : toute clé inconnue est refusée", () => {
    assert.equal(commandFrontmatterSchema.safeParse({ description: "x", subtask: true }).success, true);
    assert.equal(commandFrontmatterSchema.safeParse({ description: "x", foo: 1 }).success, false);
  });

  it("nom de skill au format opencode", () => {
    assert.equal(skillFrontmatterSchema.safeParse({ name: "revue-code", description: "x" }).success, true);
    assert.equal(skillFrontmatterSchema.safeParse({ name: "Revue_Code", description: "x" }).success, false);
  });
});

describe("masquage des secrets", () => {
  it("masque jetons, clés et mots de passe", () => {
    const text = [
      `token ghp_${"a".repeat(36)}`,
      "postgres://admin:SuperSecret1@db:5432/app",
      'password = "hunter22"',
      "Authorization: Bearer abcdefghijklmnop",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSecrets(text);
    assert.ok(!out.includes("a".repeat(36)));
    assert.ok(!out.includes("SuperSecret1"));
    assert.ok(!out.includes("hunter22"));
    assert.ok(!out.includes("abcdefghijklmnop"));
    assert.ok(!out.includes("MIIE"));
  });

  it("laisse le texte ordinaire intact", () => {
    const text = "Corrige la fonction getToken() du fichier auth.ts";
    assert.equal(redactSecrets(text), text);
  });
});

const signals = (prompts: string[], tools: Record<string, number> = {}, files: string[] = [], commands: string[] = []) => ({
  title: "",
  prompts,
  answers: [],
  tools,
  files,
  commands,
});

describe("classement heuristique", () => {
  it("reconnaît un débogage", () => {
    const r = classifyHeuristic(signals(["Corrige l'erreur NullReferenceException qui fait planter le service"], { edit: 1 }), DEFAULT_CATEGORIES);
    assert.equal(r.category, "debug");
  });

  it("reconnaît du SQL par les fichiers et les mots-clés", () => {
    const r = classifyHeuristic(signals(["Écris une requête SQL avec une jointure sur la table clients"], { write: 1 }, ["db/clients.sql"]), DEFAULT_CATEGORIES);
    assert.equal(r.category, "data");
    assert.ok(r.tags.includes("sql"));
  });

  it("reconnaît une question sans modification", () => {
    const r = classifyHeuristic(signals(["Pourquoi ce code utilise un verrou ? Explique le fonctionnement"], { read: 2 }), DEFAULT_CATEGORIES);
    assert.equal(r.category, "question");
  });

  it("reconnaît des tests par les commandes lancées", () => {
    const r = classifyHeuristic(signals(["Ajoute la couverture manquante"], { edit: 2, bash: 1 }, ["src/app.spec.ts"], ["npm test"]), DEFAULT_CATEGORIES);
    assert.equal(r.category, "tests");
  });

  it("se replie sur « other » sans signal", () => {
    assert.equal(classifyHeuristic(signals(["ok"], { edit: 1 }), DEFAULT_CATEGORIES).category, "other");
  });
});

describe("sortie du classificateur", () => {
  it("extrait le JSON d'une réponse bavarde", () => {
    assert.deepEqual(extractJson('Voici : ```json\n{"category":"debug","tags":["api"],"summary":"ok"}\n```'), { category: "debug", tags: ["api"], summary: "ok" });
  });

  it("borne la catégorie à la liste connue et nettoie les étiquettes", () => {
    const r = parseClassifierOutput('{"category":"inventée","tags":["<script>","API"],"summary":"x"}', undefined, DEFAULT_CATEGORIES);
    assert.equal(r?.category, "other");
    assert.deepEqual(r?.tags, ["script", "api"]);
    assert.equal(parseClassifierOutput("pas de json", undefined, DEFAULT_CATEGORIES), null);
  });

  it("reprend le titre proposé et reconnaît les titres génériques d'opencode", () => {
    const r = parseClassifierOutput('{"category":"debug","title":"  « Corriger add »  ","tags":[],"summary":"x"}', undefined, DEFAULT_CATEGORIES);
    assert.equal(r?.title, "Corriger add");
    assert.equal(isDefaultTitle("New session - 2026-09-13T12:00:16.864Z"), true);
    assert.equal(isDefaultTitle(""), true);
    assert.equal(isDefaultTitle("Corriger add"), false);
  });
});

describe("archives", () => {
  it("construit une requête plein texte sans syntaxe injectable", () => {
    assert.equal(ftsQuery('foo "bar" baz* NEAR(x)'), '"foo"* "bar"* "baz"* "NEARx"*');
    assert.equal(ftsQuery("   "), null);
  });

  it("déduit le projet depuis le dossier", () => {
    assert.equal(projectOf("/workspace/app/src", "/workspace"), "app");
    assert.equal(projectOf("/workspace", "/workspace"), "(racine)");
  });

  it("résume une conversation et masque les secrets", () => {
    const session = { id: "ses_1", projectID: "p", directory: "/workspace/app", title: "Bug", time: { created: 1, updated: 2 } } as OcSession;
    const messages = [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" } },
        parts: [{ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: `Corrige avec le jeton ghp_${"b".repeat(36)}` }],
      },
      {
        info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 2 }, parentID: "msg_1", modelID: "claude-sonnet-5", providerID: "github-copilot", mode: "build", agent: "build", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [
          { id: "prt_2", sessionID: "ses_1", messageID: "msg_2", type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/workspace/app/src/x.ts" } } },
          { id: "prt_3", sessionID: "ses_1", messageID: "msg_2", type: "text", text: "Corrigé." },
        ],
      },
    ] as OcMessageWithParts[];
    const d = buildDigest(session, messages, "/workspace");
    assert.equal(d.promptCount, 1);
    assert.deepEqual(d.files, ["app/src/x.ts"]);
    assert.deepEqual(d.tools, { edit: 1 });
    assert.ok(d.transcript.includes("`edit` app/src/x.ts"));
    assert.ok(!d.transcript.includes("b".repeat(36)));
  });
});

describe("sécurité et utilitaires", () => {
  it("extrait le nom d'hôte de l'en-tête Host", () => {
    assert.equal(hostnameOf("127.0.0.1:7777"), "127.0.0.1");
    assert.equal(hostnameOf("[::1]:7777"), "[::1]");
    assert.equal(hostnameOf("LOCALHOST"), "localhost");
    assert.equal(hostnameOf(undefined), "");
  });

  it("dérive une valeur de session stable et compare en temps constant", () => {
    assert.equal(sessionValue("x".repeat(40)), sessionValue("x".repeat(40)));
    assert.notEqual(sessionValue("x".repeat(40)), sessionValue("y".repeat(40)));
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
  });

  it("produit des noms de fichiers sûrs", () => {
    assert.equal(slugify("Réparer l'API « Clients » !"), "reparer-l-api-clients");
    assert.equal(safeSegment("Question / Explication"), "Question - Explication");
    assert.equal(safeSegment("CON"), "_CON");
  });

  it("fusionne les paramètres sans pollution de prototype", () => {
    const merged = mergeSettings({ a: { b: 1, c: 2 } }, JSON.parse('{"a":{"b":3},"__proto__":{"polluted":true}}')) as Record<string, unknown>;
    assert.deepEqual(merged, { a: { b: 3, c: 2 } });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

// --- 0.2.0 « Assistants et niveaux d'IA » ------------------------------------------------
// Citations : packages/opencode/src/ (oc) et packages/core/src/ d'opencode v1.18.30. Toute mise à jour d'opencode
// impose de relire ces lignes et de relancer ces tests.

const SONNET = "github-copilot/claude-sonnet-5";
const OPUS = "github-copilot/claude-opus-5";
const MINI = "github-copilot/gpt-5.4-mini";
const ref = parseModelKey;
const cat = (key: string, variants: string[] = [], extra: Partial<CatalogLite> = {}): CatalogLite => ({
  key,
  providerID: providerOf(key),
  name: key,
  variants,
  toolcall: true,
  status: "active",
  contextLimit: 200_000,
  ...extra,
});
const CATALOG: CatalogLite[] = [cat(SONNET, ["low", "medium", "high"]), cat(OPUS, ["low", "medium", "high", "max"]), cat(MINI, ["low", "medium", "high", "xhigh"])];
/** Profil Prudent livré (docker/opencode/opencode.default.jsonc). */
const PRUDENT = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" };
const FICHES = ["standards-scripts", "anonymisation-donnees"];
const relire: AgentLite = {
  name: "relire-script",
  mode: "primary",
  model: ref(SONNET),
  variant: "high",
  permission: effectiveAgentRules(PRUDENT, assistantPermission("lecture", false, FICHES)),
};
const build: AgentLite = { name: "build", mode: "primary" };
const architecte: AgentLite = { name: "architecte", mode: "primary", model: ref(OPUS), variant: "max" };
const revueSecurite: AgentLite = { name: "revue-securite", mode: "subagent", model: ref(OPUS), variant: "low" };
const general: AgentLite = { name: "general", mode: "subagent" };
const AGENTS = [build, relire, architecte, revueSecurite, general];
const chatTurn = (agent: AgentLite, extra: Partial<Parameters<typeof resolveChatTurn>[0]> = {}) =>
  resolveChatTurn({ agent, tierModel: ref(MINI), tierVariant: null, allowOverride: false, catalog: CATALOG, ...extra });
const commandTurn = (command: CommandLite, chatAgent: AgentLite, turn = chatTurn(chatAgent)) =>
  resolveCommandTurn({ command, agents: AGENTS, chatAgent, chatTurn: turn, catalog: CATALOG });
const codes = (t: { problems: Array<{ code: string; blocking: boolean }> }) => t.problems.map((p) => `${p.code}${p.blocking ? "!" : ""}`);
const priceOf = (modelID: string) => {
  const price = COPILOT_PRICES[modelID];
  if (!price) throw new Error(`prix absent : ${modelID}`);
  return price;
};

describe("résolution de l'IA (opencode 1.18.30)", () => {
  it("assistant à IA fixée : IA et réflexion de l'agent (prompt.ts:646-654)", () => {
    const t = chatTurn(relire);
    assert.deepEqual(t.send, { model: ref(SONNET), variant: "high" });
    assert.deepEqual(t.runs, [{ role: "message", model: SONNET, variant: "high", source: "assistant", agent: "relire-script" }]);
    assert.deepEqual(t.lock, { kind: "assistant", name: "relire-script" });
    assert.deepEqual(t.problems, []);
  });

  it("réflexion inconnue de l'IA : non envoyée (prompt.ts:654 ; session/llm/request.ts:80-91)", () => {
    const t = chatTurn({ ...relire, variant: "turbo" });
    assert.deepEqual(t.send, { model: ref(SONNET) });
    assert.equal(t.runs[0]?.variant, null);
    assert.deepEqual(codes(t), ["reflexion-inconnue"]);
  });

  it("Assistant général sans IA : IA et réflexion du niveau (prompt.ts:646, input.model d'abord)", () => {
    const t = chatTurn(build, { tierModel: ref(SONNET), tierVariant: "medium" });
    assert.deepEqual(t.send, { model: ref(SONNET), variant: "medium" });
    assert.deepEqual(t.runs, [{ role: "message", model: SONNET, variant: "medium", source: "niveau", agent: "build" }]);
    assert.equal(t.lock, null);
  });

  it("changement d'IA d'un assistant refusé, sauf autorisation en mode Avancé (un message)", () => {
    const override = { ...ref(OPUS), variant: "max" };
    const refused = chatTurn(relire, { override });
    assert.deepEqual(refused.send, { model: ref(SONNET), variant: "high" });
    assert.deepEqual(refused.lock, { kind: "assistant", name: "relire-script" });
    assert.deepEqual(codes(refused), ["changement-ia-refuse"]);
    const allowed = chatTurn(relire, { override, allowOverride: true });
    assert.deepEqual(allowed.send, { model: ref(OPUS), variant: "max" });
    assert.equal(allowed.lock, null);
    assert.equal(allowed.runs[0]?.source, "choix-avance");
    assert.deepEqual(codes(allowed), ["reflexion-assistant-ignoree"]);
  });

  it("IA d'un assistant absente du catalogue : bloquant, aucun repli (prompt.ts:594-612)", () => {
    assert.deepEqual(codes(chatTurn({ ...relire, model: ref("github-copilot/gpt-9") })), ["assistant-ia-indisponible!"]);
    // Catalogue non chargé : rien n'est vérifié ni bloqué.
    const unverified = chatTurn(relire, { catalog: [] });
    assert.deepEqual(unverified.problems, []);
    assert.equal(unverified.send.variant, "high");
  });

  it("raccourci avec IA et réflexion de fichier : réflexion injectée (prompt.ts:1412, 1472 ; command/index.ts:90-103)", () => {
    const t = commandTurn({ name: "revue-change", model: OPUS, fileVariant: "high", source: "command" }, build);
    assert.deepEqual(t.send, { model: ref(MINI), variant: "high" });
    assert.deepEqual(t.runs, [{ role: "raccourci", model: OPUS, variant: "high", source: "raccourci", agent: "build" }]);
    assert.deepEqual(t.lock, { kind: "raccourci", name: "revue-change" });
  });

  it("raccourci dont l'agent a une IA : aucune réflexion dans le corps (prompt.ts:1413-1416, 647-654)", () => {
    const chat = chatTurn(build, { tierVariant: "high" });
    const t = commandTurn({ name: "architecture", agent: "architecte", source: "command" }, build, chat);
    assert.deepEqual(t.send, { model: ref(MINI) });
    assert.deepEqual(t.runs, [{ role: "raccourci", model: OPUS, variant: "max", source: "assistant-du-raccourci", agent: "architecte" }]);
    assert.deepEqual(t.lock, { kind: "raccourci", name: "architecture" });
  });

  it("raccourci sans IA avec un assistant fixé : IA de l'assistant (prompt.ts:1417)", () => {
    const t = commandTurn({ name: "explique", source: "command" }, relire);
    assert.deepEqual(t.send, { model: ref(SONNET), variant: "high" });
    assert.deepEqual(t.runs, [{ role: "raccourci", model: SONNET, variant: "high", source: "assistant", agent: "relire-script" }]);
    assert.deepEqual(t.lock, { kind: "assistant", name: "relire-script" });
  });

  it("délégué à un sous-agent qui a son IA : 2 appels, reprise sur l'IA du chat (task.ts:181-184, 209 ; prompt.ts:432-446)", () => {
    const chat = chatTurn(build, { tierModel: ref(SONNET), tierVariant: "medium" });
    const t = commandTurn({ name: "revue", agent: "revue-securite", model: MINI, subtask: true, source: "command" }, build, chat);
    assert.deepEqual(t.send, { model: ref(SONNET), variant: "medium" });
    assert.deepEqual(t.runs, [
      { role: "delegue", model: OPUS, variant: "low", source: "assistant-delegue", agent: "revue-securite" },
      { role: "reprise", model: SONNET, variant: "medium", source: "niveau", agent: "build" },
    ]);
    assert.deepEqual(t.lock, { kind: "assistant-delegue", name: "revue-securite" });
    assert.deepEqual(codes(t), ["ia-du-raccourci-ignoree"]);
  });

  it("délégué à un sous-agent sans IA vers une autre IA : aucune réflexion transmise (task.ts:179, 209)", () => {
    const chat = chatTurn(build, { tierModel: ref(SONNET), tierVariant: "high" });
    const other = commandTurn({ name: "enquete", agent: "general", model: OPUS, source: "command" }, build, chat);
    assert.deepEqual(other.send, { model: ref(SONNET) });
    assert.deepEqual(other.runs, [
      { role: "delegue", model: OPUS, variant: null, source: "raccourci", agent: "general" },
      { role: "reprise", model: SONNET, variant: null, source: "niveau", agent: "build" },
    ]);
    // Même IA que la conversation : la réflexion est gardée et héritée.
    const same = commandTurn({ name: "enquete", agent: "general", source: "command" }, build, chat);
    assert.deepEqual(same.send, { model: ref(SONNET), variant: "high" });
    assert.equal(same.runs[0]?.variant, "high");
    assert.deepEqual(codes(commandTurn({ name: "x", agent: "general", fileVariant: "high", source: "command" }, build, chat)), ["reflexion-deleguee-ignoree"]);
  });

  it("subtask: false avec un sous-agent : non délégué (prompt.ts:1439)", () => {
    assert.equal(isSubtask(revueSecurite, {}), true);
    assert.equal(isSubtask(revueSecurite, { subtask: false }), false);
    assert.equal(isSubtask(build, { subtask: true }), true);
    assert.equal(isSubtask(build, {}), false);
    const t = commandTurn({ name: "revue", agent: "revue-securite", subtask: false, source: "command" }, build);
    assert.deepEqual(t.runs, [{ role: "raccourci", model: OPUS, variant: "low", source: "assistant-du-raccourci", agent: "revue-securite" }]);
  });

  it("fiche refusée par l'assistant : fiche-refusee (command/index.ts:134-152 ; tool/skill.ts:27-32)", () => {
    assert.deepEqual(codes(commandTurn({ name: "checklist-cab", source: "skill" }, relire)), ["fiche-refusee!"]);
    assert.deepEqual(codes(commandTurn({ name: "standards-scripts", source: "skill" }, relire)), []);
    // Sans règle skill propre, le défaut « * » allow d'opencode s'applique (agent/agent.ts:112).
    const generalWithRules = { ...build, permission: effectiveAgentRules(PRUDENT, {}) };
    assert.deepEqual(codes(commandTurn({ name: "checklist-cab", source: "skill" }, generalWithRules)), []);
  });

  it("agent du raccourci introuvable ou IA facturée absente : bloquant", () => {
    const missing = commandTurn({ name: "vieux", agent: "supprime", source: "command" }, build);
    assert.deepEqual(codes(missing), ["agent-du-raccourci-introuvable!"]);
    assert.deepEqual(missing.runs, []);
    assert.deepEqual(codes(commandTurn({ name: "cher", model: "github-copilot/gpt-9", source: "command" }, build)), ["ia-indisponible!"]);
  });

  it("raccourci délégué dont l'IA propre est absente du compte : bloquant, opencode la charge avant de déléguer (prompt.ts:1421, 267)", () => {
    const t = commandTurn({ name: "audit", agent: "revue-securite", model: "github-copilot/gpt-9", subtask: true, source: "command" }, build);
    assert.deepEqual(
      t.runs.map((r) => [r.role, r.model]),
      [
        ["delegue", OPUS],
        ["reprise", MINI],
      ],
    );
    assert.deepEqual(codes(t), ["ia-du-raccourci-ignoree", "ia-indisponible!"]);
    assert.equal(t.problems.at(-1)?.model, "github-copilot/gpt-9");
    // Catalogue non chargé : rien n'est vérifié.
    const unverified = resolveCommandTurn({
      command: { name: "audit", agent: "revue-securite", model: "github-copilot/gpt-9", subtask: true, source: "command" },
      agents: AGENTS,
      chatAgent: build,
      chatTurn: chatTurn(build, { catalog: [] }),
      catalog: [],
    });
    assert.deepEqual(codes(unverified), ["ia-du-raccourci-ignoree"]);
  });

  it("niveau « Indisponible » : chaque appel sur l'IA du niveau bloque, sans repli silencieux sur l'IA prévue", () => {
    const chat = chatTurn(build);
    assert.deepEqual(codes(withTierAvailability(chat, "indisponible")), ["ia-indisponible!"]);
    assert.equal(withTierAvailability(chat, "indisponible").problems[0]?.model, MINI);
    assert.equal(withTierAvailability(chat, "secours"), chat);
    assert.equal(withTierAvailability(chat, null), chat);
    // IA de l'assistant ou du raccourci : le niveau ne sert pas.
    assert.deepEqual(codes(withTierAvailability(chatTurn(relire), "indisponible")), []);
    assert.deepEqual(codes(withTierAvailability(commandTurn({ name: "revue-change", model: OPUS, source: "command" }, build), "indisponible")), []);
    // Travail délégué : la reprise tourne sur l'IA du niveau.
    const delegated = withTierAvailability(commandTurn({ name: "revue", agent: "revue-securite", source: "command" }, build), "indisponible");
    assert.deepEqual(codes(delegated), ["ia-indisponible!"]);
    // Déjà signalée (absente du catalogue) : pas de doublon.
    const absent = chatTurn(build, { tierModel: ref("github-copilot/gpt-9") });
    assert.deepEqual(codes(withTierAvailability(absent, "indisponible")), ["ia-indisponible!"]);
  });
});

describe("droits effectifs", () => {
  it("Wildcard.match : table de parité avec core/util/wildcard.ts (v1.18.30)", () => {
    const table: Array<[string, string, boolean]> = [
      // Cas de packages/opencode/test/util/wildcard.test.ts (v1.18.30).
      ["file1.txt", "file?.txt", true],
      ["file12.txt", "file?.txt", false],
      ["foo+bar", "foo+bar", true],
      ["ls", "ls *", true],
      ["ls -la", "ls *", true],
      ["ls foo bar", "ls *", true],
      ["ls", "ls*", true],
      ["lstmeval", "ls*", true],
      ["lstmeval", "ls *", false],
      ["git status", "git *", true],
      ["git", "git *", true],
      ["git commit -m foo", "git *", true],
      ["C:\\Windows\\System32\\*", "C:/Windows/System32/*", true],
      ["C:/Windows/System32/drivers", "C:\\Windows\\System32\\*", true],
      ["/users/test/file", "/Users/test/*", false],
      // Échappements, drapeau « s » et casse (Linux).
      ["a.b", "a?b", true],
      ["aXb", "a.b", false],
      ["aab", "a+b", false],
      ["(x)", "(x)", true],
      ["[abc]", "[abc]", true],
      ["a", "[abc]", false],
      ["$HOME/x", "$HOME/*", true],
      ["ligne1\nligne2", "ligne1*", true],
      ["", "*", true],
      ["certificat.PFX", "*.pfx", false],
      ["certificat.PFX", "*.PFX", true],
    ];
    for (const [input, pattern, expected] of table) {
      assert.equal(wildcardMatch(input, pattern), expected, `${JSON.stringify(input)} ~ ${JSON.stringify(pattern)}`);
    }
    assert.equal(wildcardMatch("certificat.PFX", "*.pfx", true), true);
  });

  it("evaluate : la dernière règle qui correspond l'emporte, sinon « ask » (permission/index.ts:28-37)", () => {
    const rules = rulesFromConfig({ "*": "allow", read: { "*": "allow", "*.env": "ask" }, bash: { "*": "ask", "git status": "allow", "git *": "deny" } });
    assert.equal(evaluate(rules, "read", "src/a.ts"), "allow");
    assert.equal(evaluate(rules, "read", ".env"), "ask");
    assert.equal(evaluate(rules, "bash", "git status"), "deny");
    assert.equal(evaluate(rules, "edit", "x"), "allow");
    assert.equal(evaluate([], "edit", "x"), "ask");
    assert.deepEqual(rulesFromConfig("deny"), [{ permission: "*", pattern: "*", action: "deny" }]);
    assert.deepEqual(rulesFromConfig({ external_directory: { "~/notes/*": "allow" } }), [
      { permission: "external_directory", pattern: "/home/node/notes/*", action: "allow" },
    ]);
  });

  it("règles effectives : défauts, global puis agent, Truncate réautorisé sauf refus explicite (agent/agent.ts:108-138, 296-310)", () => {
    const rules = effectiveAgentRules({}, {});
    assert.deepEqual(rules.at(-1), { permission: "external_directory", pattern: "/home/node/.local/share/opencode/tool-output/*", action: "allow" });
    const denied = effectiveAgentRules({}, { external_directory: { "/home/node/.local/share/opencode/tool-output/*": "deny" } });
    assert.equal(denied.at(-1)?.action, "deny");
    assert.equal(evaluate(rules, "external_directory", "/tmp/opencode/x"), "allow");
    assert.equal(evaluate(rules, "external_directory", "/tmp/x"), "ask");
    assert.equal(evaluate(rules, "question", "*"), "deny");
  });

  it("Conseiller (plan) : ses règles passent avant la configuration globale ; « lecture seule » seulement si garantie (agent/agent.ts:156-178, 293)", () => {
    const lines = (rules: Rule[]) =>
      rightLines(rules)
        .filter((l) => l.id === "modification" || l.id === "commande")
        .map((l) => `${l.id}:${l.kind}`);
    const plan = (preset: (typeof PERMISSION_PRESET_IDS)[number], agent?: unknown) => effectiveBuiltinRules("plan", PERMISSION_PRESETS[preset].permission, agent);
    assert.deepEqual(lines(plan("prudent")), ["modification:demande", "commande:demande"]);
    assert.deepEqual(lines(plan("equilibre")), ["modification:oui", "commande:demande"]);
    assert.deepEqual(lines(plan("autonome")), ["modification:oui", "commande:oui"]);
    for (const preset of PERMISSION_PRESET_IDS) assert.equal(builtinAssistantInfo("plan", plan(preset)).title, "Conseiller", preset);
    // agent.plan.permission dans la configuration : appliquée après le global, elle rend la promesse vraie.
    const locked = plan("autonome", { edit: "deny", bash: "deny" });
    assert.deepEqual(lines(locked), ["modification:non", "commande:non"]);
    assert.deepEqual(builtinAssistantInfo("plan", locked), { title: "Conseiller (lecture seule)", help: "Réfléchit et propose un plan, sans rien modifier." });
    // Sans configuration globale : refus propre du Conseiller, dossier des plans modifiable, aucune règle de commande.
    const bare = effectiveBuiltinRules("plan", {});
    assert.equal(evaluate(bare, "edit", "scripts/x.ps1"), "deny");
    assert.equal(evaluate(bare, "edit", ".opencode/plans/plan.md"), "allow");
    assert.equal(evaluate(bare, "bash", "Get-ChildItem"), "allow");
    assert.equal(evaluate(bare, "task", "general"), "deny");
    assert.deepEqual(bare.at(-1), { permission: "external_directory", pattern: "/home/node/.local/share/opencode/tool-output/*", action: "allow" });
    assert.equal(builtinAssistantInfo("plan", null).title, "Conseiller");
    assert.equal(builtinAssistantInfo("build", locked).title, "Assistant général");
    assert.deepEqual(lines(effectiveBuiltinRules("build", PERMISSION_PRESETS.prudent.permission)), ["modification:demande", "commande:demande"]);
  });

  it("« Lecture seule » : lignes de la carte d'identité (§9.4)", () => {
    const rules = effectiveAgentRules(PRUDENT, assistantPermission("lecture", false, FICHES));
    assert.deepEqual(
      rightLines(rules, FICHES, 40).map((l) => [l.kind, l.text, l.danger]),
      [
        ["oui", "Lit les fichiers du dossier de travail", false],
        ["non", "Ne modifie aucun fichier", false],
        ["non", "Ne lance aucune commande", false],
        ["non", "N'accède pas à Internet", false],
        ["non", "Ne délègue pas le travail à un autre assistant", false],
        ["non", "N'ouvre jamais les fichiers de clés (.pfx, .key, .jks…)", false],
        ["demande", "Demande avant de lire un fichier .env", false],
        ["info", "Vous rend la main après 40 actions au maximum", false],
      ],
    );
    const propose = rightLines(effectiveAgentRules(PRUDENT, assistantPermission("propose", true, [])));
    assert.deepEqual(
      propose.slice(1, 4).map((l) => l.text),
      ["Demande avant de modifier un fichier", "Demande avant de lancer une commande", "Demande avant de consulter Internet"],
    );
    // Une fiche listée mais refusée par les règles est signalée.
    assert.equal(rightLines(rules, ["checklist-cab"]).at(-1)?.text, "Ne peut pas ouvrir la fiche « checklist-cab »");
  });

  it("fichiers .env et de clés : .env reste « ask » sans règle « * », certificat.PFX refusé", () => {
    const permission = assistantPermission("lecture", false, []);
    assert.equal(Object.hasOwn(permission.read as object, "*"), false);
    const rules = effectiveAgentRules(PRUDENT, permission);
    assert.equal(evaluate(rules, "read", ".env"), "ask");
    assert.equal(evaluate(rules, "read", "config/prod.env"), "ask");
    assert.equal(evaluate(rules, "read", ".env.example"), "allow");
    assert.equal(evaluate(rules, "read", "certificat.pfx"), "deny");
    assert.equal(evaluate(rules, "read", "certificat.PFX"), "deny");
    assert.equal(evaluate(rules, "read", "home/.kube/config"), "deny");
    // Limite connue (§16) : casse mixte non couverte ; grep et glob ne passent pas par « read » (R8).
    assert.equal(evaluate(rules, "read", "certificat.Pfx"), "allow");
  });

  it("bloc skill : « * » en premier, refus simple sans fiche, nom de fiche numérique refusé", () => {
    assert.deepEqual(Object.keys(assistantPermission("lecture", false, FICHES).skill as object), ["*", ...FICHES]);
    assert.equal(assistantPermission("lecture", false, []).skill, "deny");
    assert.throws(() => assistantPermission("lecture", false, ["2024"]), RangeError);
  });

  it("une autorisation sans demande au niveau de l'agent est signalée en rouge", () => {
    const rules = effectiveAgentRules(PRUDENT, { edit: "allow", bash: { "*": "allow" }, task: "allow", external_directory: { "*": "allow" } });
    assert.deepEqual(
      rightLines(rules)
        .filter((l) => l.danger)
        .map((l) => l.text),
      [
        "Modifie des fichiers sans demander",
        "Lance des commandes sans demander",
        "Délègue le travail à un autre assistant sans demander",
        "Ouvre des fichiers hors du dossier de travail sans demander",
        // Sans bloc « read » propre, le défaut d'opencode laisse lire les fichiers de clés.
        "Peut ouvrir les fichiers de clés (.pfx, .key, .jks…)",
      ],
    );
    assert.equal(rightLines(effectiveAgentRules(PRUDENT, {})).some((l) => l.id === "hors-dossier"), false);
  });
});

const DRAFT: AssistantDraft = {
  title: "Relire un script avant mise en production",
  description: "Relit un script PowerShell ou Bash avant une mise en production et signale les risques, sans rien modifier.",
  useCase: "relire",
  rights: "lecture",
  web: false,
  tier: "equilibre",
  reflection: "standard",
  taskSize: "M",
  instructions: "<consignes>",
  fiches: FICHES,
  examples: ["Relis deploy.ps1 avant la mise en production de ce soir"],
  icon: "eye",
};

/** En-tête du fichier d'exemple de la conception (§7.1). */
const SPEC_HEADER = [
  "---",
  "description: Relit un script PowerShell ou Bash avant une mise en production et signale les risques, sans rien modifier.",
  "mode: primary",
  "model: github-copilot/claude-sonnet-5",
  "steps: 40",
  'color: "#12a594"',
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "  task: deny",
  "  webfetch: deny",
  "  websearch: deny",
  "  skill:",
  '    "*": deny',
  "    standards-scripts: allow",
  "    anonymisation-donnees: allow",
  "  read:",
  '    "*.env": ask',
  '    "*.env.*": ask',
  '    "*.env.example": allow',
  '    "*.pfx": deny',
  '    "*.PFX": deny',
  '    "*.p12": deny',
  '    "*.P12": deny',
  '    "*.key": deny',
  '    "*.KEY": deny',
  '    "*.jks": deny',
  '    "*.JKS": deny',
  '    "*.keystore": deny',
  '    "*.kdbx": deny',
  '    "*privkey*": deny',
  '    "*-key.pem": deny',
  '    "*_key.pem": deny',
  '    "*id_rsa*": deny',
  '    "*id_ecdsa*": deny',
  '    "*id_ed25519*": deny',
  '    "*kubeconfig*": deny',
  '    "*.kube/config": deny',
  "---",
  "",
  "<consignes>",
  "",
].join("\n");

describe("fichier d'assistant", () => {
  it("n'écrit que des clés connues d'opencode, dans l'ordre du §7.1 (schéma strict)", () => {
    const file = buildAssistantFile(DRAFT, { model: SONNET, variant: null });
    assert.equal(file.name, "relire-un-script-avant-mise-en-production");
    assert.deepEqual(Object.keys(file.frontmatter), ["description", "mode", "model", "steps", "color", "permission"]);
    assert.ok(Object.keys(file.frontmatter).every((key) => OPENCODE_AGENT_KEYS.has(key)));
    assert.equal(agentFrontmatterSchema.safeParse(file.frontmatter).success, true);
    assert.equal(z.strictObject(agentFrontmatterSchema.shape).safeParse(file.frontmatter).success, true);
    const text = stringifyFrontmatter(file.frontmatter, file.body);
    assert.ok(text.startsWith(SPEC_HEADER), text);
    assert.ok(text.endsWith(`${COMMON_RULES_BLOCK}\n`));
  });

  it("task refusé ; external_directory et question absents ; steps selon la taille", () => {
    for (const [taskSize, steps] of [["S", 20], ["M", 40], ["L", 80]] as const) {
      const { frontmatter } = buildAssistantFile({ ...DRAFT, taskSize, rights: "propose", web: true }, { model: SONNET, variant: "high" });
      const permission = frontmatter.permission as Record<string, unknown>;
      assert.equal(frontmatter.steps, steps);
      assert.equal(frontmatter.variant, "high");
      assert.equal(permission.task, "deny");
      assert.deepEqual(permission.bash, { "*": "ask" });
      assert.equal(permission.edit, "ask");
      assert.equal(permission.webfetch, "ask");
      assert.equal("external_directory" in permission, false);
      assert.equal("question" in permission, false);
    }
  });

  it("bloc de règles communes remplacé, jamais dupliqué", () => {
    const first = buildAssistantFile(DRAFT, { model: SONNET, variant: null });
    const older = first.body.replace(COMMON_RULES_START, "<!-- cockpit:regles-communes v0 -->");
    const again = buildAssistantFile({ ...DRAFT, instructions: older }, { model: SONNET, variant: null });
    assert.equal(again.body, first.body);
    assert.equal(again.body.split("cockpit:regles-communes v").length - 1, 1);
    assert.equal(
      stripCommonRules(first.body),
      "<consignes>\n\nConsulte la fiche « standards-scripts » avant de répondre.\nConsulte la fiche « anonymisation-donnees » avant de répondre.",
    );
    // Marqueur de fin effacé à la main : les lignes du cockpit ne sont pas recopiées une deuxième fois.
    const orphan = first.body.replace("<!-- /cockpit:regles-communes -->", "");
    assert.equal(buildAssistantFile({ ...DRAFT, instructions: orphan }, { model: SONNET, variant: null }).body, first.body);
  });

  it("nom : slug du titre (48 caractères au plus) puis suffixe -2, -3", () => {
    assert.equal(slugifyName("Préparer une demande de changement pour le CAB"), "preparer-une-demande-de-changement-pour-le-cab");
    const long = slugifyName("Analyser un incident de production très très long avec beaucoup de mots");
    assert.ok(long.length <= 48 && !long.endsWith("-"), long);
    assert.equal(slugifyName("???"), "assistant");
    const taken = ["relire-un-script-avant-mise-en-production"];
    assert.equal(buildAssistantFile(DRAFT, { model: SONNET, variant: null, existingNames: taken }).name, `${taken[0]}-2`);
    assert.equal(uniqueName("revue", ["revue", "revue-2"]), "revue-3");
    assert.throws(() => buildAssistantFile({ ...DRAFT, name: "../evil" }, { model: SONNET, variant: null }), RangeError);
  });

  it("profils de droits reconnus à la relecture du fichier ; toute autre combinaison est « Personnalisé »", () => {
    assert.deepEqual(detectRights(assistantPermission("lecture", false, FICHES)), { rights: "lecture", web: false, fiches: FICHES });
    assert.deepEqual(detectRights(assistantPermission("propose", true, [])), { rights: "propose", web: true, fiches: [] });
    assert.equal(detectRights({ ...assistantPermission("lecture", false, []), edit: "allow" }).rights, "personnalise");
    assert.equal(detectRights("allow").rights, "personnalise");
    const file = buildAssistantFile(DRAFT, { model: SONNET, variant: null });
    const reread = parseFrontmatter(stringifyFrontmatter(file.frontmatter, file.body)).data;
    assert.equal(detectRights(reread.permission).rights, "lecture");
  });

  it("réflexion écrite : « poussée » = high si l'IA la propose, « standard » = réflexion du niveau", () => {
    assert.equal(draftVariant("poussee", null, ["low", "high"]), "high");
    assert.equal(draftVariant("poussee", null, ["low"]), null);
    assert.equal(draftVariant("poussee", null, null), "high");
    assert.equal(draftVariant("standard", "medium", ["medium"]), "medium");
    assert.equal(draftVariant("standard", "medium", []), null);
  });
});

describe("niveaux d'IA", () => {
  const FULL = TIER_IDS.flatMap((id) => DEFAULT_TIERS[id].candidates.map((c) => cat(c, ["low", "medium", "high"])));
  const COPILOT_ONLY = ["github-copilot"];

  it("recommandation livrée : décision utilisateur, grille officielle, ni promotion ni modèle réservé", () => {
    assert.deepEqual(DEFAULT_TIERS.rapide.candidates, ["github-copilot/gpt-5.4-mini", "github-copilot/gpt-5-mini", "github-copilot/claude-haiku-4.5"]);
    assert.deepEqual(DEFAULT_TIERS.equilibre.candidates, [SONNET, "github-copilot/gpt-5.3-codex", "github-copilot/claude-sonnet-4.6"]);
    assert.deepEqual(DEFAULT_TIERS.expert.candidates, [OPUS, "github-copilot/claude-opus-4.8", "github-copilot/gpt-5.6-sol"]);
    for (const id of TIER_IDS) {
      assert.equal(DEFAULT_TIERS[id].variant, null);
      for (const candidate of DEFAULT_TIERS[id].candidates) {
        assert.equal(isReservedModel(candidate, priceOf(parseModelKey(candidate).modelID)), false, candidate);
      }
    }
    assert.equal(isReservedModel("github-copilot/gemini-3.8-flash", priceOf("gemini-3.8-flash")), true);
    assert.equal(isReservedModel("github-copilot/claude-fable-5", priceOf("claude-fable-5")), true);
  });

  it("ok / secours / indisponible / non-verifie", () => {
    assert.deepEqual(resolveTier(DEFAULT_TIERS.expert, FULL, COPILOT_ONLY), { model: OPUS, status: "ok", variant: null, warnings: [] });
    const fallback = resolveTier(DEFAULT_TIERS.expert, FULL.filter((m) => m.key !== OPUS), COPILOT_ONLY);
    assert.equal(fallback.status, "secours");
    assert.equal(fallback.model, "github-copilot/claude-opus-4.8");
    assert.equal(fallback.warnings.length, 1);
    assert.deepEqual(resolveTier(DEFAULT_TIERS.expert, [cat(MINI)], COPILOT_ONLY).model, null);
    assert.equal(resolveTier(DEFAULT_TIERS.expert, [cat(MINI)], COPILOT_ONLY).status, "indisponible");
    const unverified = resolveTier(DEFAULT_TIERS.equilibre, [], COPILOT_ONLY);
    assert.equal(unverified.status, "non-verifie");
    assert.equal(unverified.model, SONNET);
  });

  it("candidats ignorés : fin de vie, sans outils, fournisseur non autorisé ; IA à prix promotionnel retenue si choisie (§6)", () => {
    const def = { candidates: ["opencode/big-pickle", "github-copilot/vieux", "github-copilot/sans-outils"], variant: null };
    const catalog = [
      cat("opencode/big-pickle"),
      cat("github-copilot/gemini-3.8-flash"),
      cat("github-copilot/vieux", [], { status: "deprecated" }),
      cat("github-copilot/sans-outils", [], { toolcall: false }),
      cat(MINI),
    ];
    const refused = resolveTier(def, catalog, COPILOT_ONLY);
    assert.equal(refused.status, "indisponible");
    assert.equal(refused.warnings.length, 3);
    assert.equal(resolveTier(def, catalog, ["github-copilot", "opencode"]).model, "opencode/big-pickle");
    // Groupe « Réservé » du mode Avancé : jamais dans la recommandation livrée, mais utilisé quand l'administrateur le place en tête.
    const promo = { candidates: ["github-copilot/gemini-3.8-flash", MINI], variant: null };
    assert.deepEqual(resolveTier(promo, catalog, COPILOT_ONLY), { model: "github-copilot/gemini-3.8-flash", status: "ok", variant: null, warnings: [] });
    assert.equal(resolveTier({ candidates: ["github-copilot/gemini-3.8-flash"], variant: null }, catalog, COPILOT_ONLY).status, "ok");
    assert.equal(resolveTier(promo, [], COPILOT_ONLY).model, "github-copilot/gemini-3.8-flash");
  });

  it("réflexion retirée avec un avertissement si l'IA ne la propose pas", () => {
    const dropped = resolveTier({ candidates: [SONNET], variant: "xhigh" }, CATALOG, COPILOT_ONLY);
    assert.equal(dropped.status, "ok");
    assert.equal(dropped.variant, null);
    assert.equal(dropped.warnings.length, 1);
    assert.equal(resolveTier({ candidates: [MINI], variant: "xhigh" }, CATALOG, COPILOT_ONLY).variant, "xhigh");
  });

  it("estimations S/M/L au prix de la grille (§6)", () => {
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.0005, `${actual} ≈ ${expected}`);
    near(estimateTaskCost(priceOf("claude-sonnet-5"), "M"), 0.179);
    near(estimateTaskCost(priceOf("gpt-5.4-mini"), "S"), 0.022);
    near(estimateTaskCost(priceOf("claude-opus-5"), "L"), 1.377);
    const shown = (modelID: string) => (["S", "M", "L"] as const).map((size) => perRequestText(estimateTaskCost(priceOf(modelID), size)));
    assert.deepEqual(shown("gpt-5.4-mini"), ["≈ 0,02 $ par demande", "≈ 0,06 $ par demande", "≈ 0,20 $ par demande"]);
    assert.deepEqual(shown("claude-sonnet-5"), ["≈ 0,06 $ par demande", "≈ 0,18 $ par demande", "≈ 0,55 $ par demande"]);
    assert.deepEqual(shown("claude-opus-5"), ["≈ 0,15 $ par demande", "≈ 0,45 $ par demande", "≈ 1,38 $ par demande"]);
  });

  it("estimation observée à partir de 5 demandes, sinon profil ; textes et réflexions", () => {
    const price = priceOf("claude-sonnet-5");
    assert.deepEqual(chooseEstimate({ avgUsd: 0.21, samples: 12 }, price, "M"), { usd: 0.21, source: "observed", samples: 12, size: "M" });
    assert.equal(chooseEstimate({ avgUsd: 0.21, samples: 4 }, price, "M")?.source, "profile");
    assert.equal(chooseEstimate(null, null, "M"), null);
    assert.equal(formatUsd(150), "150 $");
    assert.equal(budgetShareText(0.18, 150), "20 demandes ≈ 3,60 $, soit 2 % de votre budget mensuel (150 $)");
    assert.equal(rangeText(0.18, 0.4), "≈ 0,18–0,40 $");
    assert.equal(variantLabel(null), "Réflexion standard");
    assert.equal(variantLabel("high"), "Réflexion poussée");
    assert.equal(variantLabel("max"), "Réflexion maximale");
    assert.equal(variantLabel("constructor"), "Réglage particulier");
    assert.equal(variantLabel("turbo", true), "Réglage particulier (turbo)");
  });

  it("puces du compositeur : IA fixée, travail délégué et IA de secours", () => {
    const names: Record<string, string> = {
      [SONNET]: "Claude Sonnet 5",
      [OPUS]: "Claude Opus 5",
      [MINI]: "GPT-5.4 mini",
      "github-copilot/claude-opus-4.8": "Claude Opus 4.8",
    };
    const catalog = [...CATALOG, cat("github-copilot/claude-opus-4.8")].map((m) => ({ ...m, name: names[m.key] ?? m.key }));
    const ctx: Parameters<typeof describeTurn>[1] = {
      catalog,
      agentTitle: (name) => (name === "revue-securite" ? "Revue sécurité" : name),
      tierOfModel: (model) => (model === SONNET ? "equilibre" : model === OPUS ? "expert" : model === MINI ? "rapide" : null),
      priceOf: (model) => COPILOT_PRICES[parseModelKey(model).modelID] ?? null,
      size: "M",
      command: null,
      chatTier: null,
    };
    const locked = describeTurn(chatTurn(relire), ctx);
    assert.equal(locked.chip, "IA : Claude Sonnet 5 · Équilibré (fixée par l'assistant)");
    assert.equal(locked.estimateText, "≈ 0,18 $ par demande");
    const chat = chatTurn(build, { tierModel: ref(SONNET) });
    const delegated = describeTurn(commandTurn({ name: "revue", agent: "revue-securite", source: "command" }, build, chat), { ...ctx, command: "revue" });
    assert.equal(delegated.chip, "Travail délégué à « Revue sécurité » (IA Claude Opus 5) + reprise dans la conversation (IA Claude Sonnet 5) · ≈ 0,51–0,63 $");
    const secours = describeTurn(chatTurn(build, { tierModel: ref("github-copilot/claude-opus-4.8") }), {
      ...ctx,
      chatTier: { id: "expert", status: "secours", plannedModel: OPUS },
    });
    assert.equal(secours.fallbackBadge, "IA de secours");
    assert.equal(secours.fallbackText, "Claude Opus 5 n'est pas proposée par votre abonnement : Claude Opus 4.8 est utilisée.");
  });
});

describe("module partagé", () => {
  it("server/shared est pur : ni « node: » ni process, api-types.ts sans code", () => {
    const read = (...parts: string[]) => fs.readFileSync(path.join(import.meta.dirname, ...parts), "utf8");
    const rules = read("shared", "assistant-rules.ts");
    const types = read("shared", "api-types.ts");
    for (const [name, source] of [["assistant-rules.ts", rules], ["api-types.ts", types], ["pricing.ts (importé par le module)", read("pricing.ts")]]) {
      assert.equal(source?.includes('from "node:'), false, name);
      assert.equal(/\bprocess\./.test(source ?? ""), false, name);
    }
    assert.deepEqual([...rules.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["../pricing.ts", "../pricing.ts"]);
    assert.equal(/^export (const|function|class|let|var)\b/m.test(types), false);
    assert.equal(/^import (?!type )/m.test(types), false);
  });
});

describe("paramètres 0.2.0", () => {
  it("ligne enregistrée en 0.1.1 : ai et ui par défaut, modèle par défaut du chat repris comme niveau", () => {
    const legacyRow = (defaultModel: string | null) => {
      const db = openMemoryDb();
      const legacy: Record<string, unknown> = { ...DEFAULT_SETTINGS, chat: { ...DEFAULT_SETTINGS.chat, defaultModel } };
      delete legacy.ai;
      delete legacy.ui;
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('cockpit', ?, ?)").run(JSON.stringify(legacy), 1);
      return new SettingsStore(db).get();
    };
    const plain = legacyRow(null);
    assert.deepEqual(plain.ui, { mode: "simple", rulesAcceptedVersion: 0, noticeSeen: null });
    assert.deepEqual(plain.ai, { tiers: null, chatDefaultTier: "equilibre", allowModelOverride: false });
    assert.equal(legacyRow(OPUS).ai.chatDefaultTier, "expert");
    assert.equal(legacyRow("github-copilot/gpt-5-mini").ai.chatDefaultTier, "rapide");
    assert.equal(RULES_VERSION, 1);
  });

  it("ai.tiers est remplacé en bloc ; niveaux, candidats et mode validés", () => {
    const store = new SettingsStore(openMemoryDb());
    const custom = {
      rapide: { candidates: [MINI], variant: null },
      equilibre: { candidates: [SONNET], variant: "high" },
      expert: { candidates: [OPUS], variant: null },
    };
    assert.deepEqual(store.update({ ai: { tiers: custom } }).ai.tiers, custom);
    const partial = { rapide: { candidates: [SONNET], variant: null } };
    assert.deepEqual(mergeSettings({ ai: { tiers: custom } }, { ai: { tiers: partial } }), { ai: { tiers: partial } });
    assert.throws(() => store.update({ ai: { tiers: partial } }), SettingsError);
    assert.throws(() => store.update({ ai: { tiers: { ...custom, rapide: { candidates: [MINI, MINI], variant: null } } } }), SettingsError);
    assert.equal(store.update({ ai: { tiers: null } }).ai.tiers, null);
    assert.throws(() => store.update({ ai: { chatDefaultTier: "turbo" } }), SettingsError);
    assert.throws(() => store.update({ ui: { mode: "expert" } }), SettingsError);
  });

  it("mode Simple : seuls budget.monthlyUsd, budget.alertThresholds, ui.*, ai.chatDefaultTier et chat.defaultDirectory", () => {
    const current = DEFAULT_SETTINGS;
    assert.deepEqual(settingsPathsOutsideSimple(current, { budget: { monthlyUsd: 200, alertThresholds: [80] } }), []);
    assert.deepEqual(settingsPathsOutsideSimple(current, { budget: current.budget, ui: { mode: "avance" }, ai: { chatDefaultTier: "rapide" } }), []);
    assert.deepEqual(settingsPathsOutsideSimple(current, { ai: { tiers: null } }), []);
    // Réglages remplacés en bloc (mergeSettings) : comparés en entier, jamais clé par clé.
    assert.deepEqual(settingsPathsOutsideSimple(current, { ai: { tiers: { rapide: { candidates: [MINI], variant: null } } } }), ["ai.tiers"]);
    const rates = { input: 3, cachedInput: 0.3, cacheWrite: null, output: 20 };
    const priced = { ...current, pricing: { ...current.pricing, overrides: { [SONNET]: { rates }, [OPUS]: { rates } } } };
    assert.deepEqual(settingsPathsOutsideSimple(priced, { pricing: { overrides: {} } }), ["pricing.overrides"]);
    assert.deepEqual(settingsPathsOutsideSimple(priced, { pricing: { overrides: { [SONNET]: { rates } } } }), ["pricing.overrides"]);
    assert.deepEqual(settingsPathsOutsideSimple(priced, { pricing: priced.pricing }), []);
    assert.deepEqual(settingsPathsOutsideSimple(current, { classifier: { categories: [] } }), ["classifier.categories"]);
    assert.deepEqual(settingsPathsOutsideSimple(current, { budget: { guard: { ...current.budget.guard, enabled: false } } }), ["budget.guard.enabled"]);
    assert.deepEqual(settingsPathsOutsideSimple(current, { ai: { allowModelOverride: true } }), ["ai.allowModelOverride"]);
  });

  it("catalogue jamais lu : nouvel essai rapide après un échec, un seul en attente, puis tours normaux", async () => {
    let calls = 0;
    const client = {
      request: async () => {
        calls++;
        if (calls <= 2) throw new Error("opencode démarre");
        return { providers: [{ id: "github-copilot", models: { "gpt-5-mini": { id: "gpt-5-mini" } } }], default: {} };
      },
    } as unknown as OpencodeClient;
    const catalog = new ModelCatalog(client);
    const errors: string[] = [];
    catalog.startAutoRefresh(60 * 60_000, (err) => errors.push(err.message), 5);
    try {
      for (let i = 0; i < 400 && !catalog.loaded; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(catalog.loaded, true);
      assert.equal(calls, 3);
      assert.deepEqual(errors, ["opencode démarre", "opencode démarre"]);
      assert.equal(catalog.list()[0]?.key, "github-copilot/gpt-5-mini");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(calls, 3);
    } finally {
      catalog.stop();
    }
  });

  it("COCKPIT_ALLOWED_PROVIDERS : github-copilot par défaut, identifiant invalide refusé", () => {
    assert.deepEqual(parseAllowedProviders(undefined), ["github-copilot"]);
    assert.deepEqual(parseAllowedProviders(" , "), ["github-copilot"]);
    assert.deepEqual(parseAllowedProviders("github-copilot, opencode,opencode"), ["github-copilot", "opencode"]);
    assert.throws(() => parseAllowedProviders("github-copilot,../x"), EnvError);
    assert.equal(isDefaultProviders(["github-copilot"]), true);
    assert.equal(isDefaultProviders(["github-copilot", "opencode"]), false);
  });

  it("catalogue réduit pour le résolveur : statut, outils et réflexions conservés", () => {
    const lite = catalogLite([
      {
        key: OPUS,
        providerID: "github-copilot",
        providerName: "GitHub Copilot",
        modelID: "claude-opus-5",
        name: "Claude Opus 5",
        price: null,
        contextLimit: 1_000_000,
        outputLimit: 64_000,
        reasoning: true,
        attachment: true,
        toolcall: false,
        variants: ["high"],
        status: "deprecated",
      },
    ]);
    assert.deepEqual(lite, [{ key: OPUS, providerID: "github-copilot", name: "Claude Opus 5", variants: ["high"], toolcall: false, status: "deprecated", contextLimit: 1_000_000 }]);
  });
});

describe("profils de droits et catalogue partagés", () => {
  it("profils de droits globaux : Prudent = configuration livrée, ordre des clés ignoré", () => {
    const shippedFile = path.join(import.meta.dirname, "..", "..", "docker", "opencode", "opencode.default.jsonc");
    const shipped = parseJsonc(fs.readFileSync(shippedFile, "utf8")) as { permission: unknown };
    assert.deepEqual(presetPermission("prudent"), shipped.permission);
    assert.equal(detectPermissionPreset(shipped.permission), "prudent");
    assert.equal(detectPermissionPreset({ websearch: "ask", webfetch: "ask", task: "ask", bash: { pwd: "allow", "*": "ask" }, edit: "ask" }), "prudent");
    assert.equal(detectPermissionPreset({ ...PRUDENT, edit: "allow" }), null);
    assert.equal(detectPermissionPreset(PERMISSION_PRESETS.autonome.permission), "autonome");
    const copy = presetPermission("prudent");
    (copy.bash as Record<string, string>).pwd = "deny";
    assert.equal(detectPermissionPreset(PERMISSION_PRESETS.prudent.permission), "prudent");
  });

  it("catalogue réduit depuis les modèles de l'interface : mêmes valeurs par défaut que catalog.ts", () => {
    assert.deepEqual(toCatalogLite([{ key: MINI, providerID: "github-copilot", variants: ["low"], contextLimit: null }]), [
      { key: MINI, providerID: "github-copilot", variants: ["low"], toolcall: true, status: "active", contextLimit: null },
    ]);
  });
});

describe("base", () => {
  it("openMemoryDb atteint user_version 2 avec item_meta et chat_turns", () => {
    const db = openMemoryDb();
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('item_meta', 'chat_turns', 'idx_chat_turns_session') ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.deepEqual(names, ["chat_turns", "idx_chat_turns_session", "item_meta"]);
    const insertMeta = db.prepare("INSERT INTO item_meta (kind, name, title, tier, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insertMeta.run("agents", "relire-script", "Relire un script", "equilibre", "catalogue", 1, 1);
    assert.throws(() => insertMeta.run("agents", "relire-script", "Doublon", null, "assistant", 2, 2));
    assert.deepEqual({ ...(db.prepare("SELECT examples, rights FROM item_meta").get() as object) }, { examples: "[]", rights: null });
    db.prepare("INSERT INTO chat_turns (session_id, created_at, kind) VALUES (?, ?, ?)").run("ses_1", 1, "message");
    assert.deepEqual({ ...(db.prepare("SELECT agent, runs FROM chat_turns").get() as object) }, { agent: "", runs: "[]" });
  });
});
