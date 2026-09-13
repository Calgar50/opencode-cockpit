import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDigest, ftsQuery, isDefaultTitle, projectOf } from "./archive.ts";
import { extractJson, parseClassifierOutput } from "./classifier.ts";
import { FrontmatterError, parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { safeSegment, slugify } from "./fsutil.ts";
import { classifyHeuristic } from "./heuristic.ts";
import type { OcMessageWithParts, OcSession } from "./opencode.ts";
import { COPILOT_PRICES, computeCost, priceFromCatalog, resolveMessageCost } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import { hostnameOf, safeEqual, sessionValue } from "./security.ts";
import { DEFAULT_CATEGORIES, mergeSettings } from "./settings.ts";
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
  it("refuse un mode d'agent inconnu, accepte les clés libres", () => {
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", mode: "nope" }).success, false);
    assert.equal(agentFrontmatterSchema.safeParse({ description: "x", custom: 1 }).success, true);
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
