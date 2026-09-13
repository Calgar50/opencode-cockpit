// Tests 0.2.0 : assistants, niveaux d'IA, réalignement en lot et modes Simple / Avancé (conception §14.2).
// Service réel (StudioService sur un dossier temporaire, SQLite en mémoire) derrière une petite application Hono ;
// opencode est simulé (GET /agent relit les fichiers et peut répondre 400 pour une IA donnée).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Hono } from "hono";
import { AssistantService, assistantDraftSchema } from "./assistants.ts";
import { CATALOGUE, CATALOGUE_FICHES, REVIEW_BANNER } from "./assistants-catalogue.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { ControlService } from "./control.ts";
import { type ItemMetaRow, openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { advancedOnly, settingsPatchGuard, settingsResetGuard } from "./mode.ts";
import type { OcLookup } from "./oc-lookup.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { SettingsStore } from "./settings.ts";
import {
  assistantPermission,
  type CatalogLite,
  DEFAULT_TIERS,
  effectiveAgentRules,
  effectiveBuiltinRules,
  MESSAGES,
  parseModelKey,
  unknownAgentKeyMessage,
} from "./shared/assistant-rules.ts";
import { StudioApplyError, StudioService, StudioValidationError } from "./studio.ts";
import { TEMPLATES } from "./templates.ts";
import { TierService } from "./tiers.ts";

const SONNET = "github-copilot/claude-sonnet-5";
const CODEX = "github-copilot/gpt-5.3-codex";
const CRLF = String.fromCharCode(13, 10);
const GLOBAL = { type: "global" } as const;
const PRUDENT = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" };

const NAMES: Record<string, string> = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4.8": "Claude Opus 4.8",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.4-mini": "GPT-5.4 mini",
};

const copilot = (id: string): CatalogLite => ({
  key: `github-copilot/${id}`,
  providerID: "github-copilot",
  name: NAMES[id] ?? id,
  variants: ["high"],
  toolcall: true,
  status: "active",
  contextLimit: 200_000,
});

const ALL_MODELS = [...new Set(Object.values(DEFAULT_TIERS).flatMap((t) => t.candidates))].map((key) => copilot(parseModelKey(key).modelID));

const DRAFT = {
  title: "Relire un script avant mise en production",
  description: "Relit un script PowerShell ou Bash avant une mise en production et signale les risques, sans rien modifier.",
  useCase: "relire",
  rights: "lecture",
  web: false,
  tier: "equilibre",
  reflection: "standard",
  taskSize: "M",
  instructions: "Relis le script ligne par ligne et signale chaque risque avec sa gravité.",
  fiches: ["standards-scripts"],
  examples: ["Relis deploy.ps1 avant jeudi."],
  icon: "eye",
};

/** Réponses JSON lues sans schéma dans les tests. */
type Json = any;

function mdFiles(dir: string): Array<{ name: string; data: Record<string, unknown>; raw: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      return { name: file.slice(0, -3), data: parseFrontmatter(raw).data, raw };
    });
}

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function harness(options: { mode?: "simple" | "avance"; models?: CatalogLite[] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-assistants-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const config = path.join(tmp, "oc-config");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    opencodeConfigDir: config,
    workspaceDir: workspace,
    opencodeWorkspaceDir: "/workspace",
    projectConfig: false,
    allowedProviders: ["github-copilot"],
    version: "0.2.0-test",
  } as AppEnv;
  const state = {
    rejectModel: null as string | null,
    statuses: {} as Record<string, unknown>,
    calls: [] as string[],
    restarts: 0,
    loaded: true,
    models: options.models ?? ALL_MODELS,
    /** GET /agent injoignable (repli sur les fichiers). */
    lookupFails: false,
    globalConfig: { permission: PRUDENT } as Record<string, unknown>,
  };

  // Assistants intégrés dans l'ordre d'opencode 1.18.30 : règles propres, puis configuration globale.
  const agents = () => [
    { name: "build", mode: "primary", native: true, permission: effectiveBuiltinRules("build", PRUDENT) },
    { name: "plan", mode: "primary", native: true, permission: effectiveBuiltinRules("plan", PRUDENT) },
    ...mdFiles(path.join(config, "agents")).map(({ name, data }) => ({
      name,
      mode: data.mode === "primary" || data.mode === "subagent" ? data.mode : "all",
      ...(data.hidden === true ? { hidden: true } : {}),
      ...(typeof data.model === "string" ? { model: parseModelKey(data.model) } : {}),
      ...(typeof data.variant === "string" ? { variant: data.variant } : {}),
      ...(typeof data.description === "string" ? { description: data.description } : {}),
      permission: effectiveAgentRules(PRUDENT, data.permission),
    })),
  ];
  const rejected = () =>
    state.rejectModel !== null &&
    [...mdFiles(path.join(config, "agents")), ...mdFiles(path.join(config, "commands"))].some((f) => f.raw.includes(state.rejectModel as string));

  const client = {
    async request(method: string, pathname: string, opts: { directory?: string } = {}) {
      state.calls.push(`${method} ${pathname}${opts.directory ? ` ${opts.directory}` : ""}`);
      if (method === "POST") return true;
      switch (pathname) {
        case "/global/config":
          return state.globalConfig;
        case "/session/status":
          return state.statuses;
        case "/skill": {
          const dir = path.join(config, "skills");
          if (!fs.existsSync(dir)) return [];
          return fs.readdirSync(dir).map((name) => {
            const data = parseFrontmatter(fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8")).data;
            return { name, description: String(data.description ?? "") };
          });
        }
        case "/agent":
          if (rejected()) {
            throw new OpencodeError(400, { name: "ConfigInvalidError", data: { path: "/oc-config/agents/x.md", issues: [{ path: ["model"], message: "IA refusée" }] } });
          }
          return agents();
        case "/command":
          return [];
      }
      throw new Error(`route inattendue : ${method} ${pathname}`);
    },
  } as unknown as OpencodeClient;

  const lookup = {
    async get() {
      if (state.lookupFails) throw new Error("opencode injoignable");
      return { directory: null, agents: agents(), commands: [], loadedAt: Date.now() };
    },
    invalidate() {},
  } as unknown as OcLookup;
  const catalog = {
    get loaded() {
      return state.loaded;
    },
    lite: () => (state.loaded ? state.models : []),
    list: () => [],
  } as unknown as ModelCatalog;
  const ledger = {
    pricingContext: () => ({ overrides: {}, catalog: new Map(), preferTable: false }),
    estimateAgent: () => ({ avgUsd: null, samples: 0 }),
  } as unknown as Ledger;
  const control = {
    restartOpencode: async () => {
      state.restarts++;
      return { ok: true, durationMs: 0, message: "" };
    },
  } as unknown as ControlService;

  const log = createLogger("error");
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  if (options.mode) settings.update({ ui: { mode: options.mode } });
  const hub = new EventHub();
  const events: BrowserEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const projects = new ProjectsService(env);
  const studio = new StudioService({ env, client, projects, control, log, catalog });
  const tiers = new TierService({ settings, catalog, ledger, env });
  const assistants = new AssistantService({ db, env, client, studio, lookup, tiers, ledger, settings, catalog, projects, hub, log });

  // Mêmes correspondances d'erreurs que le onError de http.ts.
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof StudioValidationError) return c.json({ error: "validation", message: err.message, issues: err.issues }, 422);
    if (err instanceof StudioApplyError) return c.json({ error: "rejected-by-opencode", message: err.message, issues: err.issues, restarted: err.restarted }, 422);
    return c.json({ error: "internal", message: err.message }, 500);
  });
  const deps = { assistants, tiers, settings, hub, log };
  registerAssistantRoutes(app, deps);
  registerAiRoutes(app, deps);
  app.put("/api/studio/:kind/:name", advancedOnly(settings), (c) => c.json({ ok: true }));
  app.put("/api/settings", settingsPatchGuard(settings), async (c) => c.json(settings.update(await c.req.json())));
  app.post("/api/settings/reset", settingsResetGuard(settings), async (c) => {
    const { section } = (await c.req.json()) as { section: "budget" | "chat" };
    return c.json(settings.reset(section));
  });

  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? JSON.parse(raw) : null };
  };
  const meta = (kind: string, name: string) =>
    db.prepare("SELECT * FROM item_meta WHERE kind = ? AND name = ?").get(kind, name) as unknown as ItemMetaRow | undefined;
  const cockpitEvent = (type: string) => events.find((e) => e.kind === "cockpit" && e.type === type) as { data: Json } | undefined;

  return { config, state, db, settings, studio, tiers, assistants, call, meta, cockpitEvent };
}

describe("niveaux d'IA (service)", () => {
  it("résout chaque niveau, signale l'IA de secours et s'utilise en fonctions de rappel", () => {
    const h = harness({ models: ALL_MODELS.filter((m) => m.key !== "github-copilot/claude-opus-5") });
    const views = h.tiers.views();
    const expert = views.find((v) => v.id === "expert");
    assert.equal(expert?.status, "secours");
    assert.equal(expert?.statusLabel, "IA de secours");
    assert.equal(expert?.model, "github-copilot/claude-opus-4.8");
    assert.equal(expert?.fallbackText, "claude-opus-5 n'est pas proposée par votre abonnement : Claude Opus 4.8 est utilisée.");
    assert.equal(views.find((v) => v.id === "equilibre")?.estimateText, "≈ 0,18 $ par demande");
    const { tierOfModel, priceOf, isExpensive } = h.tiers;
    assert.equal(tierOfModel(SONNET), "equilibre");
    assert.equal(priceOf(SONNET)?.rates.output, 10);
    assert.equal(isExpensive("github-copilot/claude-opus-4.8"), true);
    assert.equal(isExpensive(SONNET), false);
    assert.equal(h.tiers.sourceText(), "Recommandation livrée avec le cockpit 0.2.0-test");
    assert.deepEqual(h.tiers.validate({ ...DEFAULT_TIERS, rapide: { candidates: ["github-copilot/gpt-5-mini", "openai/gpt-5"], variant: null } }), [
      { path: "tiers.rapide.candidates.1", message: MESSAGES.fournisseurRefuse },
    ]);
    h.state.loaded = false;
    assert.equal(h.tiers.views()[0]?.status, "non-verifie");
    assert.equal(h.tiers.views()[0]?.statusLabel, "Non vérifié");
  });
});

describe("assistants", () => {
  it("aperçu : n'écrit rien, erreurs en français dans une réponse 200", async () => {
    const h = harness();
    const bad = await h.call("POST", "/api/assistants/preview", { ...DRAFT, title: "ab", instructions: "court" });
    assert.equal(bad.status, 200);
    assert.ok(bad.body.issues.some((i: Json) => i.path === "title" && i.message === "Donnez un nom à l'assistant (3 caractères au moins)."));
    assert.ok(bad.body.issues.some((i: Json) => i.path === "instructions" && i.message === "Les consignes sont trop courtes (20 caractères au moins)."));
    const good = await h.call("POST", "/api/assistants/preview", DRAFT);
    assert.equal(good.status, 200);
    assert.deepEqual(good.body.issues, []);
    assert.equal(good.body.name, "relire-un-script-avant-mise-en-production");
    assert.equal(good.body.model, SONNET);
    assert.equal(good.body.status, "ok");
    assert.equal(good.body.estimate.text, "≈ 0,18 $ par demande");
    assert.ok(good.body.rightLines.some((l: Json) => l.id === "fichiers-cles" && l.kind === "non"));
    assert.ok(good.body.rightLines.some((l: Json) => l.id === "env" && l.kind === "demande"));
    assert.match(good.body.file, /^---\ndescription: Relit un script/);
    assert.equal(fs.existsSync(path.join(h.config, "agents")), false);
    assert.equal((await h.call("POST", "/api/assistants/preview", "{pas du json")).status, 400);
  });

  it("enregistrement : fichier global et ligne item_meta, règles relues identiques à l'aperçu", async () => {
    const h = harness();
    const name = (await h.call("POST", "/api/assistants/preview", DRAFT)).body.name as string;
    const res = await h.call("PUT", `/api/assistants/${name}`, DRAFT);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(h.config, "agents", `${name}.md`), "utf8"));
    assert.equal(data.model, SONNET);
    assert.equal(data.steps, 40);
    assert.deepEqual(data.permission, assistantPermission("lecture", false, ["standards-scripts"]));
    assert.match(body, /Consulte la fiche « standards-scripts » avant de répondre\./);
    const row = h.meta("agents", name);
    assert.equal(row?.title, DRAFT.title);
    assert.equal(row?.origin, "assistant");
    assert.equal(row?.tier, "equilibre");
    assert.equal(row?.applied_model, SONNET);
    assert.equal(res.body.state, "ok");
    assert.equal(res.body.rights, "lecture");
    assert.equal(res.body.effectiveRules, true);
    assert.equal(res.body.rulesDiffer, false);
    assert.deepEqual(h.cockpitEvent("studio.changed")?.data, { kind: "agents", name });

    const again = await h.call("PUT", `/api/assistants/${name}`, DRAFT);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "name-taken");
    const modified = await h.call("PUT", `/api/assistants/${name}`, { ...DRAFT, previousName: name, taskSize: "L" });
    assert.equal(modified.status, 200);
    assert.equal(modified.body.steps, 80);
    const renamed = await h.call("PUT", "/api/assistants/relire-script", { ...DRAFT, previousName: name });
    assert.equal(renamed.status, 200);
    assert.equal(h.meta("agents", name), undefined);
    assert.equal(h.meta("agents", "relire-script")?.task_size, "M");
    assert.equal(fs.existsSync(path.join(h.config, "agents", `${name}.md`)), false);
    assert.equal((await h.call("PUT", "/api/assistants/build", DRAFT)).status, 409);
    assert.equal((await h.call("PUT", "/api/assistants/Mauvais_Nom", DRAFT)).status, 400);
  });

  it("IA non Copilot, absente du compte ou liste indisponible : 422 et rien d'écrit ; portée projet impossible", async () => {
    const h = harness({ mode: "avance" });
    const precise = (model: string) => h.call("PUT", "/api/assistants/assistant-precis", { ...DRAFT, tier: null, model });
    const openai = await precise("openai/gpt-5");
    assert.equal(openai.status, 422);
    assert.ok(openai.body.issues.some((i: Json) => i.path === "model" && i.message === MESSAGES.fournisseurRefuse));
    const absent = await precise("github-copilot/gpt-9");
    assert.equal(absent.status, 422);
    assert.ok(absent.body.issues.some((i: Json) => i.message === MESSAGES.iaAbsenteDuCompte));
    assert.equal(fs.existsSync(path.join(h.config, "agents", "assistant-precis.md")), false);
    assert.equal((await precise(CODEX)).status, 200);

    h.settings.update({ ui: { mode: "simple" } });
    const simple = await h.call("PUT", "/api/assistants/autre-precis", { ...DRAFT, tier: null, model: CODEX });
    assert.equal(simple.status, 422);
    assert.ok(simple.body.issues.some((i: Json) => i.message === MESSAGES.modeAvance));

    h.state.loaded = false;
    const unverified = await h.call("PUT", "/api/assistants/autre-assistant", DRAFT);
    assert.equal(unverified.status, 422);
    assert.ok(unverified.body.issues.some((i: Json) => i.message === MESSAGES.catalogueIndisponible));
    assert.equal(fs.existsSync(path.join(h.config, "agents", "autre-assistant.md")), false);

    await assert.rejects(
      h.studio.save("agents", GLOBAL, { name: "agent-studio", frontmatter: { description: "x", model: "openai/gpt-5" }, body: "y" }),
      (err: unknown) => err instanceof StudioValidationError && err.issues[0]?.message === MESSAGES.fournisseurRefuse,
    );
    await assert.rejects(
      h.studio.save("agents", { type: "project", project: "proj" }, { name: "agent-projet", frontmatter: { description: "x" }, body: "y" }),
      StudioValidationError,
    );
  });

  it("Studio : clé inconnue refusée pour un nouvel agent, tolérée avec un avertissement si déjà présente", async () => {
    const h = harness();
    await assert.rejects(
      h.studio.save("agents", GLOBAL, { name: "nouveau", frontmatter: { description: "x", reasoningEffort: "high" }, body: "y" }),
      (err: unknown) => err instanceof StudioValidationError && err.issues.some((i) => i.message === unknownAgentKeyMessage("reasoningEffort")),
    );
    fs.mkdirSync(path.join(h.config, "agents"), { recursive: true });
    fs.writeFileSync(path.join(h.config, "agents", "ancien.md"), "---\ndescription: Ancien\nreasoningEffort: high\n---\nCorps\n");
    const saved = await h.studio.save("agents", GLOBAL, { name: "ancien", frontmatter: { description: "Ancien modifié", reasoningEffort: "low" }, body: "Corps" });
    assert.equal(saved.frontmatter.reasoningEffort, "low");
    assert.equal(saved.warnings.length, 1);
    await assert.rejects(
      h.studio.save("agents", GLOBAL, { name: "ancien", frontmatter: { description: "x", reasoningEffort: "low", autre: 1 }, body: "y" }),
      StudioValidationError,
    );
    await assert.rejects(
      h.studio.save("commands", GLOBAL, { name: "raccourci", frontmatter: { model: "github-copilot/gpt-9" }, body: "x" }),
      (err: unknown) => err instanceof StudioValidationError && err.issues[0]?.message === MESSAGES.iaAbsenteDuCompte,
    );
  });

  it("catalogue : installation idempotente, fiche existante jamais écrasée", async () => {
    const h = harness();
    const custom = "---\nname: standards-scripts\ndescription: Nos standards maison\n---\n\nNe pas écraser.\n";
    const customFile = path.join(h.config, "skills", "standards-scripts", "SKILL.md");
    fs.mkdirSync(path.dirname(customFile), { recursive: true });
    fs.writeFileSync(customFile, custom);

    const entry = (await h.call("GET", "/api/assistants/catalogue")).body.find((c: Json) => c.id === "relire-script");
    assert.equal(entry.installed, false);
    assert.deepEqual(entry.newFiches, ["anonymisation-donnees"]);
    assert.equal(entry.review, MESSAGES.catalogueReview);
    assert.equal(entry.model, SONNET);
    assert.ok(entry.rightLines.some((l: Json) => l.id === "delegation" && l.kind === "non"));

    const first = await h.call("POST", "/api/assistants/catalogue/relire-script/install", {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.name, "relire-script");
    assert.equal(first.body.origin, "catalogue");
    assert.equal(first.body.catalogId, "relire-script");
    assert.equal(fs.readFileSync(customFile, "utf8"), custom);
    const created = fs.readFileSync(path.join(h.config, "skills", "anonymisation-donnees", "SKILL.md"), "utf8");
    assert.ok(parseFrontmatter(created).body.trimStart().startsWith(REVIEW_BANNER));

    const disposes = () => h.state.calls.filter((c) => c === "POST /global/dispose").length;
    const before = disposes();
    const second = await h.call("POST", "/api/assistants/catalogue/relire-script/install", {});
    assert.equal(second.status, 200);
    assert.equal(second.body.name, "relire-script");
    assert.equal(disposes(), before);
    const installed = (await h.call("GET", "/api/assistants/catalogue")).body.find((c: Json) => c.id === "relire-script");
    assert.equal(installed.installed, true);
    assert.equal(installed.installedName, "relire-script");

    assert.equal((await h.call("POST", "/api/assistants/catalogue/inconnu/install", {})).status, 404);
    const taken = await h.call("POST", "/api/assistants/catalogue/expliquer-alerte/install", { name: "relire-script" });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, "name-taken");
    const sql = await h.call("POST", "/api/assistants/catalogue/relire-requete-sql/install", {});
    assert.equal(sql.status, 200);
    assert.ok(fs.readFileSync(path.join(h.config, "skills", "requetes-sql-sures", "SKILL.md"), "utf8").includes(REVIEW_BANNER));
    h.state.loaded = false;
    assert.equal((await h.call("POST", "/api/assistants/catalogue/expliquer-alerte/install", {})).body.error, "catalogue-indisponible");
  });

  it("adoption d'un agent créé avant 0.2, sans réécrire son fichier", async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.config, "agents"), { recursive: true });
    const legacy = "---\ndescription: Conçoit avant de coder.\nmode: primary\nmodel: github-copilot/claude-sonnet-5\npermission:\n  edit: deny\n---\nTu es architecte.\n";
    const file = path.join(h.config, "agents", "architecte.md");
    fs.writeFileSync(file, legacy);
    const list = (await h.call("GET", "/api/assistants")).body;
    const todo = list.toComplete.find((t: Json) => t.name === "architecte");
    assert.equal(todo?.inferredTier, "equilibre");
    assert.equal(todo?.rights, "personnalise");
    assert.deepEqual(
      list.builtins.map((b: Json) => [b.name, b.title]),
      [
        ["build", "Assistant général"],
        // Profil Prudent : la configuration globale passe après le refus propre du Conseiller, il demande avant de modifier.
        ["plan", "Conseiller"],
      ],
    );
    const adopted = await h.call("POST", "/api/assistants/architecte/adopt", { title: "Concevoir avant de coder", useCase: "autre", taskSize: "L" });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.origin, "adopte");
    assert.equal(adopted.body.tier, "equilibre");
    assert.equal(adopted.body.state, "ok");
    assert.equal(fs.readFileSync(file, "utf8"), legacy);
    assert.equal((await h.call("POST", "/api/assistants/architecte/adopt", { title: "Encore", useCase: "autre", taskSize: "M" })).body.error, "already-assistant");
    assert.equal((await h.call("POST", "/api/assistants/inconnu/adopt", { title: "Inconnu", useCase: "autre", taskSize: "M" })).status, 404);
    assert.equal((await h.call("GET", "/api/assistants")).body.toComplete.length, 0);
  });

  it("agent natif remplacé, sous-agent ou agent masqué : ni adopté, ni complété, ni renommé, ni supprimé depuis les assistants", async () => {
    const h = harness();
    const dir = path.join(h.config, "agents");
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
      build: "---\ndescription: Assistant général restreint par l'administrateur.\npermission:\n  bash: deny\n  edit: deny\n---\nRestreint.\n",
      aide: `---\ndescription: Sous-agent d'aide.\nmode: subagent\nmodel: ${SONNET}\n---\nAide.\n`,
      cache: "---\ndescription: Agent masqué.\nmode: primary\nhidden: true\n---\nMasqué.\n",
    };
    for (const [name, raw] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.md`), raw);
    const adopt = { title: "Assistant adopté", useCase: "autre", taskSize: "M" };
    for (const name of Object.keys(files)) {
      const res = await h.call("POST", `/api/assistants/${name}/adopt`, adopt);
      assert.equal(res.status, 404, name);
      assert.equal(h.meta("agents", name), undefined, name);
    }
    assert.deepEqual((await h.call("GET", "/api/assistants")).body.toComplete, []);
    // opencode injoignable : un agent natif remplacé reste hors de « À compléter ».
    h.state.lookupFails = true;
    assert.deepEqual((await h.call("GET", "/api/assistants")).body.toComplete, []);
    assert.equal((await h.call("POST", "/api/assistants/build/adopt", adopt)).status, 404);
    h.state.lookupFails = false;

    // « Compléter » un agent natif remplacé, renommer un agent qui n'est pas un assistant : refusés, fichiers intacts.
    const complete = await h.call("PUT", "/api/assistants/build", { ...DRAFT, previousName: "build" });
    assert.equal(complete.status, 409);
    assert.equal(complete.body.error, "name-taken");
    assert.equal((await h.call("PUT", "/api/assistants/relire", { ...DRAFT, previousName: "aide" })).status, 404);
    assert.equal(fs.existsSync(path.join(dir, "relire.md")), false);
    for (const [name, raw] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, `${name}.md`), "utf8"), raw, name);

    // Suppression refusée même si une ligne titrée existait déjà (adoption antérieure au correctif).
    h.db.prepare("INSERT INTO item_meta (kind, name, title, task_size, origin, created_at, updated_at) VALUES ('agents', 'build', 'Ancien', 'M', 'adopte', 0, 0)").run();
    assert.equal((await h.call("DELETE", "/api/assistants/build")).status, 404);
    assert.equal(fs.readFileSync(path.join(dir, "build.md"), "utf8"), files.build);

    // Un agent ordinaire se complète toujours.
    fs.writeFileSync(path.join(dir, "architecte.md"), "---\ndescription: Conçoit avant de coder.\nmode: primary\n---\nTu es architecte.\n");
    const completed = await h.call("PUT", "/api/assistants/architecte", { ...DRAFT, previousName: "architecte" });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
  });

  it("fichier disparu : « Fichier introuvable », ligne conservée jusqu'au retrait", async () => {
    const h = harness();
    assert.equal((await h.call("PUT", "/api/assistants/relire", DRAFT)).status, 200);
    fs.rmSync(path.join(h.config, "agents", "relire.md"));
    const list = (await h.call("GET", "/api/assistants")).body;
    assert.deepEqual(list.missing, [{ kind: "agents", name: "relire", title: DRAFT.title, tier: "equilibre" }]);
    assert.equal(list.assistants.length, 0);
    assert.ok(h.meta("agents", "relire"));
    const usage = (await h.call("GET", "/api/ai")).body.usage;
    assert.equal(usage.find((u: Json) => u.name === "relire")?.stateText, "Fichier introuvable");
    assert.equal((await h.call("DELETE", "/api/assistants/relire/meta")).body.deleted, true);
    assert.equal(h.meta("agents", "relire"), undefined);
    assert.equal((await h.call("PUT", "/api/assistants/relire", DRAFT)).status, 200);
    const exists = await h.call("DELETE", "/api/assistants/relire/meta");
    assert.equal(exists.status, 409);
    assert.equal(exists.body.error, "file-exists");
  });

  it("suppression refusée quand un raccourci utilise l'assistant, sauf force", async () => {
    const h = harness();
    assert.equal((await h.call("PUT", "/api/assistants/relire", DRAFT)).status, 200);
    fs.mkdirSync(path.join(h.config, "commands"), { recursive: true });
    const command = path.join(h.config, "commands", "revue-script.md");
    fs.writeFileSync(command, "---\ndescription: Relire le script\nagent: relire\n---\nRelis $ARGUMENTS\n");
    const refused = await h.call("DELETE", "/api/assistants/relire");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "used-by");
    assert.equal(refused.body.message, "Le raccourci /revue-script utilise cet assistant : il ne fonctionnera plus.");
    assert.deepEqual(refused.body.commands, ["revue-script"]);
    const forced = await h.call("DELETE", "/api/assistants/relire?force=1");
    assert.equal(forced.status, 200);
    assert.equal(forced.body.deleted, true);
    assert.equal(fs.existsSync(path.join(h.config, "agents", "relire.md")), false);
    assert.equal(fs.existsSync(command), true);
    assert.equal(h.meta("agents", "relire"), undefined);
    assert.equal((await h.call("DELETE", "/api/assistants/relire")).status, 404);
  });

  it("liaison du Studio : le niveau suit un renommage, titres pour le chat", () => {
    const h = harness();
    h.assistants.bindLevel("agents", "agent-a", "rapide", "github-copilot/gpt-5.4-mini", null);
    h.assistants.bindLevel("agents", "agent-b", "rapide", "github-copilot/gpt-5.4-mini", null, "agent-a");
    assert.equal(h.meta("agents", "agent-a"), undefined);
    assert.equal(h.meta("agents", "agent-b")?.origin, "studio");
    assert.equal(h.meta("agents", "agent-b")?.tier, "rapide");
    h.assistants.bindLevel("commands", "sans-niveau", null, null, null);
    assert.equal(h.meta("commands", "sans-niveau"), undefined);
    const { agentTitle, taskSizeOf } = h.assistants;
    assert.equal(agentTitle("build"), "Assistant général");
    assert.equal(agentTitle("agent-b"), "agent-b");
    assert.equal(taskSizeOf("agent-b"), null);
  });

  it("catalogue livré : 6 assistants sûrs, 3 fiches relues ; exemples du Studio avec niveau conseillé", () => {
    assert.equal(CATALOGUE.length, 6);
    for (const entry of CATALOGUE) {
      const draft = { ...entry, reflection: "standard" } as Record<string, unknown>;
      delete draft.id;
      delete draft.version;
      assert.equal(assistantDraftSchema.safeParse(draft).success, true, entry.id);
      assert.equal(assistantPermission(entry.rights, entry.web, entry.fiches).task, "deny");
      for (const fiche of entry.fiches) {
        assert.ok(CATALOGUE_FICHES.some((f) => f.name === fiche) || TEMPLATES.some((t) => t.kind === "skills" && t.name === fiche), fiche);
      }
    }
    assert.deepEqual(
      CATALOGUE_FICHES.map((f) => f.name),
      ["anonymisation-donnees", "standards-scripts", "checklist-cab"],
    );
    for (const fiche of CATALOGUE_FICHES) assert.ok(fiche.body.startsWith(REVIEW_BANNER), fiche.name);
    assert.match(
      CATALOGUE.find((e) => e.id === "preparer-revue-cab")?.instructions ?? "",
      /Tu ne donnes jamais d'avis favorable ou défavorable : tu listes les manques et les questions\./,
    );
    assert.deepEqual(Object.fromEntries(TEMPLATES.filter((t) => t.kind !== "skills").map((t) => [t.name, t.tier])), {
      "revue-securite": "equilibre",
      architecte: "expert",
      testeur: "equilibre",
      "expert-sql": "equilibre",
      pedagogue: "rapide",
      commit: "rapide",
      revue: null,
      explique: "rapide",
      tests: "equilibre",
      "description-pr": "rapide",
    });
  });
});

describe("réalignement en lot", () => {
  /** 2 assistants et 1 raccourci liés au niveau Équilibré, puis le niveau passe à GPT-5.3 Codex. */
  async function bound(h: ReturnType<typeof harness>): Promise<string[]> {
    for (const name of ["relire-a", "relire-b"]) assert.equal((await h.call("PUT", `/api/assistants/${name}`, DRAFT)).status, 200);
    fs.mkdirSync(path.join(h.config, "commands"), { recursive: true });
    // Fins de ligne Windows : la restauration doit rendre les octets d'origine, pas un fichier réécrit.
    const command = ["---", "description: Vérifier un changement", `model: ${SONNET}`, "---", "", "Vérifie $ARGUMENTS", ""].join(CRLF);
    fs.writeFileSync(path.join(h.config, "commands", "verifier.md"), command);
    h.assistants.bindLevel("commands", "verifier", "equilibre", SONNET, null);
    h.settings.update({ ai: { tiers: { ...DEFAULT_TIERS, equilibre: { candidates: [CODEX], variant: null } } } });
    return ["agents/relire-a.md", "agents/relire-b.md", "commands/verifier.md"].map((rel) => path.join(h.config, rel));
  }

  it("met à jour les 3 éléments liés en un lot : un rechargement, une vérification par type", async () => {
    const h = harness();
    const files = await bound(h);
    const updates = (await h.call("GET", "/api/ai")).body.updates;
    assert.deepEqual(
      updates.map((u: Json) => [u.kind, u.name, u.to]),
      [
        ["agents", "relire-a", CODEX],
        ["agents", "relire-b", CODEX],
        ["commands", "verifier", CODEX],
      ],
    );
    assert.equal((await h.call("GET", "/api/assistants")).body.assistants[0].state, "mise-a-jour");
    const unconfirmed = await h.call("POST", "/api/ai/realign", {});
    assert.equal(unconfirmed.status, 428);
    assert.equal(unconfirmed.body.error, "confirmation-requise");

    const start = h.state.calls.length;
    const res = await h.call("POST", "/api/ai/realign", {}, { "x-cockpit-confirm": "1" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.updated.length, 3);
    for (const file of files) assert.equal(parseFrontmatter(fs.readFileSync(file, "utf8")).data.model, CODEX);
    const calls = h.state.calls.slice(start);
    assert.equal(calls.filter((c) => c === "POST /global/dispose").length, 1);
    assert.equal(calls.filter((c) => c === "GET /agent").length, 1);
    assert.equal(calls.filter((c) => c === "GET /command").length, 1);
    assert.equal(h.meta("commands", "verifier")?.applied_model, CODEX);
    assert.equal(h.meta("agents", "relire-a")?.applied_model, CODEX);
    assert.deepEqual(h.cockpitEvent("ai.changed")?.data, { reason: "realign" });
    assert.deepEqual((await h.call("GET", "/api/ai")).body.updates, []);
    assert.ok((await h.call("GET", "/api/assistants")).body.assistants.every((a: Json) => a.state === "ok"));
  });

  it("refus d'opencode : les 3 fichiers restaurés à l'octet près, 422", async () => {
    const h = harness();
    const files = await bound(h);
    const before = files.map((file) => fs.readFileSync(file));
    h.state.rejectModel = "gpt-5.3-codex";
    const res = await h.call("POST", "/api/ai/realign", {}, { "x-cockpit-confirm": "1" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "rejected-by-opencode");
    assert.equal(res.body.message, MESSAGES.rejectedByOpencode);
    assert.equal(res.body.restored, true);
    assert.equal(res.body.restarted, false);
    assert.ok(res.body.issues.length > 0);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    assert.equal(h.state.restarts, 0);
    assert.equal(h.meta("agents", "relire-a")?.applied_model, SONNET);
  });

  it("réponse en cours : 409 et aucun fichier touché", async () => {
    const h = harness();
    const files = await bound(h);
    const before = files.map((file) => fs.readFileSync(file));
    const now = Date.now();
    h.db.prepare("INSERT INTO sessions (id, root_id, directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ses_1", "ses_1", "/workspace/app", now, now);
    h.state.statuses = { ses_1: { type: "busy" } };
    const one = { items: [{ kind: "agents", name: "relire-a" }] };
    const busy = await h.call("POST", "/api/ai/realign", one, { "x-cockpit-confirm": "1" });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, "sessions-busy");
    assert.equal(busy.body.message, MESSAGES.sessionsBusy);
    assert.ok(h.state.calls.includes("GET /session/status /workspace/app"));
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));

    h.state.statuses = { ses_1: { type: "idle" } };
    const done = await h.call("POST", "/api/ai/realign", one, { "x-cockpit-confirm": "1" });
    assert.equal(done.status, 200);
    assert.deepEqual(
      done.body.updated.map((u: Json) => u.name),
      ["relire-a"],
    );
    assert.equal((await h.call("POST", "/api/ai/realign", { items: [{ kind: "agents", name: "inconnu" }] }, { "x-cockpit-confirm": "1" })).status, 404);
  });
});

describe("modes Simple et Avancé", () => {
  it("mode Simple : écriture du Studio refusée (403), assistants toujours disponibles", async () => {
    const h = harness();
    const studio = await h.call("PUT", "/api/studio/agents/x", { frontmatter: {}, body: "" });
    assert.equal(studio.status, 403);
    assert.deepEqual(studio.body, { error: "mode-avance", message: MESSAGES.modeAvance });
    assert.equal((await h.call("GET", "/api/assistants")).status, 200);
    assert.equal((await h.call("GET", "/api/ai")).status, 200);
    assert.equal((await h.call("PUT", "/api/assistants/relire", DRAFT)).status, 200);
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await h.call("PUT", "/api/studio/agents/x", { frontmatter: {}, body: "" })).status, 200);
  });

  it("paramètres : en mode Simple, seuls les chemins autorisés changent", async () => {
    const h = harness();
    assert.equal((await h.call("PUT", "/api/settings", { budget: { monthlyUsd: 200 } })).status, 200);
    assert.equal((await h.call("PUT", "/api/settings", { ui: { noticeSeen: "0.2.0" }, ai: { chatDefaultTier: "rapide" } })).status, 200);
    const tiers = await h.call("PUT", "/api/settings", { ai: { tiers: DEFAULT_TIERS } });
    assert.equal(tiers.status, 403);
    assert.equal(tiers.body.error, "mode-avance");
    assert.ok(tiers.body.paths.length > 0 && tiers.body.paths.every((p: string) => p.startsWith("ai.tiers")));
    // Une valeur identique n'est pas un changement.
    assert.equal((await h.call("PUT", "/api/settings", { budget: { monthlyUsd: 200, guard: { fromPercent: 80 } } })).status, 200);
    assert.equal((await h.call("PUT", "/api/settings", { budget: { guard: { fromPercent: 10 } } })).status, 403);
    assert.equal((await h.call("PUT", "/api/settings", "{pas du json")).status, 400);
    // Tarifs remplacés en bloc : un dictionnaire vide ou partiel effacerait les tarifs personnalisés.
    const rates = { input: 3, cachedInput: 0.3, cacheWrite: null, output: 20 };
    h.settings.update({ pricing: { overrides: { [SONNET]: { rates }, [CODEX]: { rates } } } });
    for (const overrides of [{}, { [SONNET]: { rates } }]) {
      const wiped = await h.call("PUT", "/api/settings", { pricing: { overrides } });
      assert.equal(wiped.status, 403);
      assert.deepEqual(wiped.body.paths, ["pricing.overrides"]);
    }
    assert.deepEqual(Object.keys(h.settings.get().pricing.overrides).sort(), [SONNET, CODEX].sort());
    assert.equal((await h.call("POST", "/api/settings/reset", { section: "chat" })).status, 403);
    assert.equal((await h.call("POST", "/api/settings/reset", { section: "budget" })).status, 200);
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await h.call("PUT", "/api/settings", { budget: { guard: { fromPercent: 10 } } })).status, 200);
  });

  it("niveaux d'IA : édition réservée au mode Avancé, fournisseurs contrôlés, aucun fichier réécrit", async () => {
    const h = harness();
    const custom = { ...DEFAULT_TIERS, expert: { candidates: ["github-copilot/claude-opus-4.8"], variant: null } };
    assert.equal((await h.call("PUT", "/api/ai/tiers", { tiers: custom })).status, 403);
    h.settings.update({ ui: { mode: "avance" } });
    const refused = await h.call("PUT", "/api/ai/tiers", { tiers: { ...custom, rapide: { candidates: ["openai/gpt-5"], variant: null } } });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body.issues, [{ path: "tiers.rapide.candidates.0", message: MESSAGES.fournisseurRefuse }]);
    assert.equal((await h.call("PUT", "/api/ai/tiers", { tiers: custom, autre: 1 })).status, 400);
    assert.equal((await h.call("PUT", "/api/assistants/cab", { ...DRAFT, tier: "expert" })).status, 200);
    const ok = await h.call("PUT", "/api/ai/tiers", { tiers: custom });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(
      ok.body.impacted.map((i: Json) => [i.name, i.from, i.to]),
      [["cab", "github-copilot/claude-opus-5", "github-copilot/claude-opus-4.8"]],
    );
    assert.equal(ok.body.ai.source, "personnalise");
    assert.equal(ok.body.ai.sourceText, "Réglage personnalisé");
    assert.deepEqual(h.cockpitEvent("ai.changed")?.data, { reason: "tiers" });
    assert.equal(parseFrontmatter(fs.readFileSync(path.join(h.config, "agents", "cab.md"), "utf8")).data.model, "github-copilot/claude-opus-5");
    const usage = ok.body.ai.usage.find((u: Json) => u.name === "cab");
    assert.equal(usage.stateText, "Mise à jour disponible");
    h.state.loaded = false;
    assert.equal((await h.call("PUT", "/api/ai/tiers", { tiers: null })).status, 409);
  });

  it("« À ranger » : seuls les agents de « À compléter » se rangent en mode Simple ; Conseiller en repli dans l'ordre d'opencode", async () => {
    const h = harness();
    const dir = path.join(h.config, "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "principal.md"), `---\ndescription: Agent principal.\nmode: primary\nmodel: ${SONNET}\n---\nx\n`);
    fs.writeFileSync(path.join(dir, "aide.md"), `---\ndescription: Sous-agent.\nmode: subagent\nmodel: ${SONNET}\n---\nx\n`);
    fs.mkdirSync(path.join(h.config, "commands"), { recursive: true });
    fs.writeFileSync(path.join(h.config, "commands", "verifier.md"), `---\ndescription: Vérifier\nmodel: ${SONNET}\n---\nx\n`);
    const usage = (await h.call("GET", "/api/ai")).body.usage as Json[];
    assert.deepEqual(
      usage
        .filter((u) => u.state === "a-ranger")
        .map((u) => [u.name, u.completable])
        .sort((a, b) => a[0].localeCompare(b[0])),
      [
        ["aide", false],
        ["principal", true],
        ["verifier", false],
      ],
    );
    assert.ok(usage.every((u) => typeof u.completable === "boolean"));

    // GET /agent injoignable : règles du Conseiller dans l'ordre d'opencode (Prudent : il demande avant de modifier).
    h.state.lookupFails = true;
    const planOf = async () => ((await h.call("GET", "/api/assistants")).body.builtins as Json[]).find((b) => b.name === "plan");
    const decisions = (plan: Json) => (plan.rightLines as Json[]).filter((l) => l.id === "modification" || l.id === "commande").map((l) => l.kind);
    const fallback = await planOf();
    assert.equal(fallback.effectiveRules, false);
    assert.equal(fallback.title, "Conseiller");
    assert.deepEqual(decisions(fallback), ["demande", "demande"]);
    // agent.plan.permission dans la configuration : la lecture seule est garantie, le titre le dit.
    h.state.globalConfig = { permission: PRUDENT, agent: { plan: { permission: { edit: "deny", bash: "deny" } } } };
    const locked = await planOf();
    assert.equal(locked.title, "Conseiller (lecture seule)");
    assert.equal(locked.help, "Réfléchit et propose un plan, sans rien modifier.");
    assert.deepEqual(decisions(locked), ["non", "non"]);
  });

  it("« Garder cette IA précise » (mode Simple) : liaison retirée, fichier intact, IA du fichier retenue", async () => {
    const h = harness();
    assert.equal((await h.call("PUT", "/api/assistants/relire", DRAFT)).status, 200);
    const file = path.join(h.config, "agents", "relire.md");
    const changed = fs.readFileSync(file, "utf8").replace(SONNET, CODEX);
    fs.writeFileSync(file, changed);
    const usageOf = async () => (await h.call("GET", "/api/ai")).body.usage.find((u: Json) => u.name === "relire");
    assert.equal((await usageOf()).state, "modifie-hors-cockpit");

    const kept = await h.call("POST", "/api/ai/keep-model", { kind: "agents", name: "relire" });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual(kept.body, { kind: "agents", name: "relire", model: CODEX, variant: null });
    assert.equal(fs.readFileSync(file, "utf8"), changed);
    const row = h.meta("agents", "relire");
    assert.equal(row?.tier, null);
    assert.equal(row?.applied_model, CODEX);
    assert.equal(row?.title, DRAFT.title);
    assert.equal((await usageOf()).state, "a-jour");
    assert.deepEqual(h.cockpitEvent("ai.changed")?.data, { reason: "keep-model" });

    // Sans niveau et de nouveau modifié hors du cockpit : rien à réaligner, 422 explicite (pas « introuvable »).
    fs.writeFileSync(file, changed.replace(CODEX, SONNET));
    const drifted = await usageOf();
    assert.equal(drifted.state, "modifie-hors-cockpit");
    assert.equal(drifted.tier, null);
    const realign = await h.call("POST", "/api/ai/realign", { items: [{ kind: "agents", name: "relire" }] }, { "x-cockpit-confirm": "1" });
    assert.equal(realign.status, 422);
    assert.equal(realign.body.error, "sans-niveau");
    assert.equal(realign.body.message, "Cet élément ne suit aucun niveau : choisissez un niveau ou gardez cette IA précise.");
    fs.writeFileSync(file, changed);

    assert.equal((await h.call("POST", "/api/ai/keep-model", { kind: "agents", name: "absent" })).status, 404);
    assert.equal((await h.call("POST", "/api/ai/keep-model", { kind: "skills", name: "relire" })).status, 400);
    fs.writeFileSync(file, changed.replace(CODEX, "openai/gpt-5"));
    const refused = await h.call("POST", "/api/ai/keep-model", { kind: "agents", name: "relire" });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, "fournisseur-refuse");
    assert.equal(h.meta("agents", "relire")?.applied_model, CODEX);
  });
});
