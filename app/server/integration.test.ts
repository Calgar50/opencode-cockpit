// Tests d'intégration : registre des coûts sur SQLite réel, et sécurité HTTP sur un vrai serveur.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { parse as parseJsonc } from "jsonc-parser";
import { ArchiveService } from "./archive.ts";
import { AssistantService } from "./assistants.ts";
import { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import type { ControlService } from "./control.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { createApp, forbiddenAttachment, forbiddenProxyBody, mergeConfigPatch, parsePermissionReply, PROXY_RULES, turnModelFromBody } from "./http.ts";
import { EventHub } from "./hub.ts";
import { csvCell, Ledger, monthBounds, monthKey } from "./ledger.ts";
import { createLogger, type Logger } from "./log.ts";
import { OcLookup } from "./oc-lookup.ts";
import { type OcAssistantMessage, type OcSession, OpencodeClient, type OcUserMessage } from "./opencode.ts";
import type { EventProcessor } from "./processor.ts";
import { ProjectsService } from "./projects.ts";
import { apiHostFor, type QuotaSync } from "./quota.ts";
import { sessionValue } from "./security.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import type { Run } from "./shared/assistant-rules.ts";
import { StudioService, StudioValidationError } from "./studio.ts";
import { TierService } from "./tiers.ts";

const T = Date.UTC(2026, 8, 10, 12, 0, 0);

const session = (id: string, parentID?: string): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: T, updated: T },
  ...(parentID ? { parentID } : {}),
});

const assistant = (id: string, sessionID: string, cost: number, input: number, output: number, modelID = "claude-sonnet-5"): OcAssistantMessage => ({
  id,
  sessionID,
  role: "assistant",
  time: { created: T + 1_000, completed: T + 2_000 },
  parentID: "msg_u1",
  modelID,
  providerID: "github-copilot",
  mode: "build",
  agent: "build",
  cost,
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
});

function setup() {
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  const catalog = { prices: new Map() } as unknown as ModelCatalog;
  const ledger = new Ledger({ db, settings, catalog });
  const sessions = new SessionTracker(db, {} as OpencodeClient);
  return { db, settings, catalog, ledger, sessions };
}

describe("registre des coûts", () => {
  it("agrège par mois, usage, modèle et conversation (sous-agents rattachés)", () => {
    const { ledger, sessions } = setup();
    const root = sessions.upsert(session("ses_root"));
    const child = sessions.upsert(session("ses_child", "ses_root"));
    const user: OcUserMessage = { id: "msg_u1", sessionID: "ses_root", role: "user", time: { created: T }, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" } };
    ledger.recordUser(user, root);
    assert.equal(ledger.recordAssistant(assistant("msg_a1", "ses_root", 0.02, 100, 100), root), true);
    assert.equal(ledger.recordAssistant(assistant("msg_a1", "ses_root", 0.02, 100, 100), root), false);
    ledger.recordAssistant(assistant("msg_a2", "ses_child", 0, 1_000, 1_000), child);

    const s = ledger.summary(monthKey(T), T + 3_600_000);
    assert.equal(s.spentUsd, 0.032);
    assert.equal(s.calls, 2);
    assert.equal(s.prompts, 1);
    assert.deepEqual(
      s.byPurpose.map((p) => [p.purpose, p.cost]).sort(),
      [["chat", 0.02], ["subagent", 0.012]],
    );
    assert.equal(s.topSessions[0]?.rootId, "ses_root");
    assert.equal(s.topSessions[0]?.cost, 0.032);
    assert.equal(s.byDay.length, 10);
    assert.equal(s.bySource.find((b) => b.source === "table")?.cost, 0.012);
  });

  it("rattache à la vraie racine des descendants arrivés avant leurs ancêtres", () => {
    const { ledger, sessions } = setup();
    const grandchild = sessions.upsert(session("ses_gc", "ses_c"));
    ledger.recordAssistant(assistant("msg_gc", "ses_gc", 0.01, 1, 1), grandchild);
    sessions.upsert(session("ses_c", "ses_r"));
    sessions.upsert(session("ses_r"));
    assert.equal(sessions.get("ses_gc")?.root_id, "ses_r");
    assert.equal(ledger.sessionUsage("ses_r").cost, 0.01);
  });

  it("garde-fou : modèles chers puis budget atteint, confirmation possible", () => {
    const { ledger, sessions, settings, catalog } = setup();
    const root = sessions.upsert(session("ses_root"));
    ledger.recordAssistant({ ...assistant("msg_a1", "ses_root", 90, 1, 1), time: { created: Date.now(), completed: Date.now() } }, root);
    settings.update({ budget: { monthlyUsd: 100 } });
    const opus = { providerID: "github-copilot", modelID: "claude-opus-5" };
    const mini = { providerID: "github-copilot", modelID: "gpt-5-mini" };
    assert.equal(ledger.guard(opus, false).code, "expensive-model");
    assert.equal(ledger.guard(mini, false).allowed, true);
    assert.equal(ledger.guard(opus, true).allowed, true);

    settings.update({ budget: { monthlyUsd: 50 } });
    assert.equal(ledger.guard(mini, false).code, "budget-exhausted");
    (catalog.prices as Map<string, unknown>).set("opencode/gratuit", { rates: { input: 0, cachedInput: 0, cacheWrite: null, output: 0 } });
    assert.equal(ledger.guard({ providerID: "opencode", modelID: "gratuit" }, false).allowed, true);
    assert.equal(ledger.guard({ providerID: "inconnu", modelID: "x" }, false).allowed, true);
  });

  it("garde-fou sur tous les appels facturés : le plus cher d'abord, texte de confirmation en français", () => {
    const { ledger, sessions, settings } = setup();
    const root = sessions.upsert(session("ses_root"));
    ledger.recordAssistant({ ...assistant("msg_a1", "ses_root", 90, 1, 1), time: { created: Date.now(), completed: Date.now() } }, root);
    settings.update({ budget: { monthlyUsd: 100 } });
    const runs: Run[] = [
      { role: "reprise", model: "github-copilot/gpt-5-mini", variant: null, source: "niveau", agent: "build" },
      { role: "delegue", model: "github-copilot/claude-opus-5", variant: null, source: "assistant-delegue", agent: "expert-cab" },
    ];
    const ctx = {
      command: "revue-cab",
      modelName: (m: string) => (m.endsWith("claude-opus-5") ? "Claude Opus 5" : "GPT-5 mini"),
      tierOfModel: (m: string) => (m.endsWith("claude-opus-5") ? ("expert" as const) : null),
      size: "M" as const,
    };
    const refusal = ledger.guardRuns(runs, false, ctx);
    assert.equal(refusal?.error, "budget-guard");
    assert.equal(refusal?.code, "expensive-model");
    assert.equal(refusal?.run?.role, "delegue");
    assert.equal(refusal?.modelName, "Claude Opus 5");
    assert.equal(refusal?.title, "Confirmer une demande coûteuse");
    assert.match(
      refusal?.message ?? "",
      /^90 % du budget du mois est consommé\. Cette demande utilise Claude Opus 5 \(niveau Expert\) : environ [\d,]+ \$, via le raccourci \/revue-cab\. Envoyer quand même \?$/,
    );
    assert.equal(ledger.guardRuns(runs, true, ctx), null);
    assert.equal(ledger.guardRuns(runs.slice(0, 1), false, ctx), null);

    settings.update({ budget: { monthlyUsd: 50 } });
    const exhausted = ledger.guardRuns(runs.slice(0, 1), false, ctx);
    assert.equal(exhausted?.code, "budget-exhausted");
    assert.equal(
      exhausted?.message,
      "Budget du mois atteint (90 $ sur 50 $). Cette demande reste facturée sur votre compte GitHub Copilot. Envoyer quand même ?",
    );
  });

  it("trace les tours de chat (choix restaurés sans raccourci) et la moyenne observée par agent", () => {
    const { ledger, sessions } = setup();
    const root = sessions.upsert(session("ses_root"));
    const sonnet = { providerID: "github-copilot", modelID: "claude-sonnet-5" };
    const message: Run = { role: "message", model: "github-copilot/claude-sonnet-5", variant: "high", source: "assistant", agent: "relire-script" };
    ledger.recordChatTurn({ session_id: "ses_root", created_at: T, kind: "message", agent: "relire-script", command: null, tier: "equilibre", model: message.model, variant: "high", runs: [message] });
    ledger.recordChatTurn({ session_id: "ses_root", created_at: T + 10, kind: "raccourci", agent: "build", command: "revue", tier: null, model: "github-copilot/gpt-5-mini", variant: null, runs: [] });
    assert.deepEqual(ledger.lastChatChoice("ses_root"), { agent: "relire-script", tier: "equilibre", model: message.model, variant: "high", createdAt: T });
    assert.equal(ledger.lastChatChoice("ses_autre"), null);

    const user = (id: string, agent: string, created: number): OcUserMessage => ({ id, sessionID: "ses_root", role: "user", time: { created }, agent, model: sonnet });
    ledger.recordUser(user("msg_u1", "relire-script", T), root);
    ledger.recordAssistant(assistant("msg_a1", "ses_root", 0.2, 1, 1), root);
    ledger.recordUser(user("msg_u2", "build", T + 5_000), root);
    ledger.recordAssistant({ ...assistant("msg_a2", "ses_root", 0.1, 1, 1), time: { created: T + 6_000, completed: T + 7_000 } }, root);
    assert.deepEqual(ledger.estimateAgent("relire-script", sonnet, T + 60_000), { avgUsd: 0.2, samples: 1 });
    assert.deepEqual(ledger.estimateAgent("build", undefined, T + 60_000), { avgUsd: 0.1, samples: 1 });
    assert.deepEqual(ledger.estimateAgent("relire-script", { providerID: "github-copilot", modelID: "gpt-5-mini" }, T + 60_000), { avgUsd: null, samples: 0 });
  });

  it("n'émet chaque seuil d'alerte qu'une fois par mois", () => {
    const { ledger, sessions, settings } = setup();
    const root = sessions.upsert(session("ses_root"));
    ledger.recordAssistant({ ...assistant("msg_a1", "ses_root", 80, 1, 1), time: { created: Date.now(), completed: Date.now() } }, root);
    settings.update({ budget: { monthlyUsd: 100 } });
    assert.deepEqual(ledger.checkAlerts().map((a) => a.threshold), [50, 75]);
    assert.deepEqual(ledger.checkAlerts(), []);
  });

  it("recalcule les coûts quand la grille change", () => {
    const { ledger, sessions, settings } = setup();
    const root = sessions.upsert(session("ses_root"));
    ledger.recordAssistant({ ...assistant("msg_a1", "ses_root", 0, 1_000_000, 0), time: { created: Date.now(), completed: Date.now() } }, root);
    assert.equal(ledger.monthTotal(), 2);
    settings.update({ pricing: { overrides: { "github-copilot/claude-sonnet-5": { rates: { input: 1, cachedInput: 0, cacheWrite: null, output: 1 } } } } });
    ledger.recompute();
    assert.equal(ledger.monthTotal(), 1);
  });

  it("utilitaires de mois et CSV", () => {
    assert.equal(monthBounds("2026-02").days, 28);
    assert.equal(monthKey(Date.UTC(2026, 0, 31, 23, 59)), "2026-01");
    assert.throws(() => monthBounds("2026-13"));
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("-12.5"), "-12.5");
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    // Excel en français (séparateur « ; ») : une formule après un séparateur ou un retour à la ligne est neutralisée aussi.
    assert.equal(csvCell("Revue;=LIEN_HYPERTEXTE(CAR(104)&A3);fin"), "Revue;'=LIEN_HYPERTEXTE(CAR(104)&A3);fin");
    assert.equal(csvCell("a;=1+1;b"), "a;'=1+1;b");
    assert.equal(csvCell("a;  +1;b"), "a;  '+1;b");
    assert.equal(csvCell('a;"=1+1";b'), `"a;""'=1+1"";b"`);
    const newline = String.fromCharCode(10);
    const tab = String.fromCharCode(9);
    assert.equal(csvCell(`a${newline}=1+1;b`), `"a${newline}'=1+1;b"`);
    assert.equal(csvCell(`a${tab}@SOMME(1)`), `a${tab}'@SOMME(1)`);
    assert.equal(csvCell("Revue F;-12"), "Revue F;'-12");
  });
});

describe("archives : corrections manuelles", () => {
  it("protège un résumé corrigé à la main du reclassement automatique", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-archive-"));
    try {
      const { db, settings, ledger, sessions } = setup();
      const archive = new ArchiveService({
        db,
        client: {} as OpencodeClient,
        settings,
        ledger,
        sessions,
        archiveDir: tmp,
        opencodeWorkspaceDir: "/workspace",
        log: createLogger("error"),
      });
      db.prepare("INSERT INTO conversations (session_id, directory, title, classified_by, created_at, updated_at) VALUES (?, ?, ?, 'llm', ?, ?)").run(
        "ses_resume",
        "/workspace/app",
        "Titre",
        T,
        T,
      );
      const updated = await archive.update("ses_resume", { summary: "Résumé corrigé à la main" });
      assert.equal(updated?.classifiedBy, "manual");
      assert.equal(updated?.summary, "Résumé corrigé à la main");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("masque les secrets des titres : enregistrés, relus (titres antérieurs), exportés en Markdown et dans le nom du fichier", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-archive-"));
    try {
      const { db, settings, ledger, sessions } = setup();
      const archive = new ArchiveService({
        db,
        client: {} as OpencodeClient,
        settings,
        ledger,
        sessions,
        archiveDir: tmp,
        opencodeWorkspaceDir: "/workspace",
        log: createLogger("error"),
      });
      // Ligne enregistrée avant 1.0.0, titre en clair.
      db.prepare("INSERT INTO conversations (session_id, directory, title, classified_by, created_at, updated_at) VALUES (?, ?, ?, 'llm', ?, ?)").run(
        "ses_titre",
        "/workspace/app",
        "Login SQL Password=Sup3rS3cret!",
        T,
        T,
      );
      assert.equal(archive.get("ses_titre")?.title.includes("Sup3rS3cret"), false);
      assert.equal(archive.markdown("ses_titre")?.includes("Sup3rS3cret"), false);
      const stored = () => (db.prepare("SELECT title FROM conversations WHERE session_id = 'ses_titre'").get() as { title: string }).title;
      assert.equal(await archive.syncTitle("ses_titre", `Jeton ghp_${"c".repeat(36)} refusé`), true);
      assert.equal(stored().includes("c".repeat(36)), false);
      await archive.update("ses_titre", { title: "Connexion postgres://admin:MotDePasse42@db/app" });
      assert.equal(stored().includes("MotDePasse42"), false);
      const files = fs.readdirSync(tmp, { recursive: true }).map(String);
      assert.ok(files.length > 0);
      for (const name of files) {
        assert.equal(name.includes("MotDePasse42") || name.includes("Sup3rS3cret"), false, name);
        const full = path.join(tmp, name);
        if (fs.statSync(full).isFile()) assert.equal(/MotDePasse42|Sup3rS3cret|c{36}/.test(fs.readFileSync(full, "utf8")), false, name);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("studio : confinement des chemins (régression revue de sécurité)", () => {
  it("refuse un ancien nom, un nom de skill ou une portée projet qui sortiraient du cadre autorisé", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-studio-"));
    try {
      const config = path.join(tmp, "oc-config");
      const victim = path.join(tmp, "workspace", "proj");
      fs.mkdirSync(path.join(config, "agents"), { recursive: true });
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, "README.md"), "precieux");
      fs.writeFileSync(path.join(victim, "SKILL.md"), "---\nname: proj\ndescription: leurre\n---\ncorps\n");
      const env = {
        opencodeConfigDir: config,
        workspaceDir: path.join(tmp, "workspace"),
        opencodeWorkspaceDir: "/workspace",
        projectConfig: false,
      } as AppEnv;
      const studio = new StudioService({
        env,
        client: {} as OpencodeClient,
        projects: new ProjectsService(env),
        control: {} as ControlService,
        log: createLogger("error"),
      });
      await assert.rejects(
        studio.save("agents", { type: "global" }, { name: "nouvel-agent", previousName: "../../workspace/proj/README", frontmatter: { description: "x" }, body: "y" }),
        StudioValidationError,
      );
      assert.equal(fs.existsSync(path.join(victim, "README.md")), true);
      await assert.rejects(studio.writeSkillFile("../../workspace/proj", "poc.txt", "x", { type: "global" }), StudioValidationError);
      await assert.rejects(studio.deleteSkillFile("../../workspace/proj", "SKILL.md.bak", { type: "global" }), StudioValidationError);
      assert.equal(fs.existsSync(path.join(victim, "poc.txt")), false);
      await assert.rejects(
        studio.save("agents", { type: "project", project: "proj" }, { name: "agent-projet", frontmatter: { description: "x" }, body: "y" }),
        StudioValidationError,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("n'envoie le jeton Copilot qu'au domaine GitHub Enterprise déclaré", () => {
    assert.equal(apiHostFor(undefined, null), "api.github.com");
    assert.equal(apiHostFor("https://entreprise.ghe.com", "entreprise.ghe.com"), "api.entreprise.ghe.com");
    assert.throws(() => apiHostFor("https://attaquant.example", null));
    assert.throws(() => apiHostFor("https://attaquant.example", "entreprise.ghe.com"));
  });
});

// --- Faux opencode : réponses d'opencode 1.18.30 réduites à ce que le cockpit lit -------------

const COPILOT = "github-copilot";
const ref = (modelID: string, providerID = COPILOT) => ({ providerID, modelID });

const FIXTURE_PROVIDERS = {
  providers: [
    {
      id: COPILOT,
      name: "GitHub Copilot",
      models: {
        "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 mini", capabilities: { toolcall: true, reasoning: true }, variants: { low: {}, medium: {}, high: {} }, limit: { context: 264_000, output: 64_000 } },
        "gpt-5.4-mini": { id: "gpt-5.4-mini", name: "GPT-5.4 mini", capabilities: { toolcall: true, reasoning: true }, variants: { low: {}, medium: {}, high: {} }, limit: { context: 400_000, output: 128_000 } },
        "claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5", capabilities: { toolcall: true, reasoning: true }, variants: { low: {}, medium: {}, high: {} }, limit: { context: 1_000_000, output: 64_000 } },
        "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5", capabilities: { toolcall: true, reasoning: true }, variants: { high: {} }, limit: { context: 1_000_000, output: 64_000 } },
      },
    },
    {
      id: "opencode",
      name: "OpenCode Zen",
      models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", cost: { input: 0, output: 0 }, capabilities: { toolcall: true }, limit: { context: 200_000, output: 32_000 } } },
    },
  ],
  default: { [COPILOT]: "claude-sonnet-5" },
};

const FIXTURE_AGENTS = [
  { name: "build", mode: "primary", native: true, options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] },
  { name: "plan", mode: "primary", native: true, options: {}, permission: [{ permission: "edit", pattern: "*", action: "deny" }] },
  { name: "general", mode: "subagent", native: true, options: {}, permission: [] },
  {
    name: "relire-script",
    mode: "primary",
    description: "Relit un script avant une mise en production.",
    model: ref("claude-sonnet-5"),
    variant: "high",
    options: {},
    permission: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "skill", pattern: "*", action: "deny" },
      { permission: "skill", pattern: "standards-scripts", action: "allow" },
    ],
  },
  { name: "expert-cab", mode: "subagent", model: ref("claude-opus-5"), options: {}, permission: [] },
  { name: "ancien", mode: "primary", model: ref("gpt-4-retire"), options: {}, permission: [] },
];

const FIXTURE_COMMANDS = [
  { name: "revue", template: "Revois $ARGUMENTS", hints: ["$ARGUMENTS"], source: "command" },
  { name: "resume-expert", model: "github-copilot/claude-opus-5", template: "Résume $ARGUMENTS", hints: ["$ARGUMENTS"], source: "command" },
  { name: "revue-cab", agent: "expert-cab", template: "Prépare la revue", hints: [], source: "command" },
  { name: "standards-scripts", template: "Fiche", hints: [], source: "skill" },
  { name: "checklist-cab", template: "Fiche", hints: [], source: "skill" },
  { name: "fantome", agent: "disparu", template: "x", hints: [], source: "command" },
];

const FIXTURE_SKILLS = [
  { name: "standards-scripts", description: "Standards des scripts", location: "/oc-config/skills/standards-scripts/SKILL.md", content: "x" },
  { name: "checklist-cab", description: "Checklist CAB", location: "/oc-config/skills/checklist-cab/SKILL.md", content: "x" },
];

const PRUDENT = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" };

describe("serveur HTTP (sécurité et proxy)", () => {
  const token = "t".repeat(48);
  // Secret de session posé dans la base avant createApp (sinon un secret aléatoire y est créé au démarrage).
  const sessionSecret = "s".repeat(43);
  const cookie = `cockpit_session=${sessionValue(token, sessionSecret)}`;
  const upstreamRequests: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];
  const warnings: string[] = [];
  let upstream: http.Server;
  let cockpit: ReturnType<typeof serve>;
  let port = 0;
  let tmp = "";
  /** Interrupteur : GET /agent répond 400 (configuration refusée par opencode). */
  let agentFails = false;
  /** Faux opencode : demandes en attente (GET /permission), états (GET /session/status), sous-agents (GET /session/:id/children). */
  let ocPermissions: Array<Record<string, unknown>> = [];
  let ocStatuses: unknown = {};
  let ocChildren: Record<string, Array<{ id: string }>> = {};
  /** Messages (GET /session/:id/message/:messageID), par « session/message » ; absent : 404. */
  let ocMessages: Record<string, unknown> = {};
  /** États servis tour à tour par GET /session/status avant de revenir à ocStatuses. */
  let ocStatusSequence: unknown[] = [];
  /** Délai de réponse de GET /permission et GET /session/status (valeur lue à la réception, servie après le délai). */
  let lookupDelayMs = 0;
  /** Appelé à la réception de POST /session/:id/abort. */
  let onAbort: ((sessionId: string) => void) | null = null;
  /**
   * Interrupteur : GET /permission coupe la connexion (« socket »), GET /session/status répond 500 (« status ») ou
   * GET /session/:id/message/:messageID répond 500 (« message »).
   */
  let permissionLookupFailure: "socket" | "status" | "message" | null = null;
  let env: AppEnv;
  let db: DatabaseSync;
  let settings: SettingsStore;
  let hub: EventHub;
  let lookup: OcLookup;

  /** GET /global/config : fusion de config.json, opencode.json puis opencode.jsonc (config.ts:272-274), sinon configuration livrée. */
  const globalConfig = (): unknown => {
    const merge = (base: unknown, next: unknown): unknown => {
      if (!base || typeof base !== "object" || Array.isArray(base) || !next || typeof next !== "object" || Array.isArray(next)) return next;
      const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
      for (const [key, value] of Object.entries(next)) out[key] = merge(out[key], value);
      return out;
    };
    let merged: unknown = null;
    for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
      const file = path.join(tmp, name);
      if (fs.existsSync(file)) merged = merge(merged ?? {}, parseJsonc(fs.readFileSync(file, "utf8")));
    }
    return merged ?? { enabled_providers: [COPILOT], permission: PRUDENT };
  };

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        const pathname = new URL(req.url ?? "/", "http://opencode.test").pathname;
        const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
        if (pathname === "/global/health") {
          json(200, { healthy: true, version: "test" });
        } else if (req.method === "GET" && pathname === "/agent") {
          if (agentFails) json(400, { name: "ConfigInvalidError", data: { path: "/oc-config/agents/x.md", issues: [] } });
          else json(200, FIXTURE_AGENTS);
        } else if (req.method === "GET" && pathname === "/command") {
          json(200, FIXTURE_COMMANDS);
        } else if (req.method === "GET" && pathname === "/config/providers") {
          json(200, FIXTURE_PROVIDERS);
        } else if (req.method === "GET" && pathname === "/skill") {
          json(200, FIXTURE_SKILLS);
        } else if (req.method === "GET" && pathname === "/global/config") {
          json(200, globalConfig());
        } else if (req.method === "GET" && pathname === "/permission") {
          const snapshot = ocPermissions;
          if (permissionLookupFailure === "socket") req.socket.destroy();
          else setTimeout(() => json(200, snapshot), lookupDelayMs);
        } else if (req.method === "GET" && pathname === "/session/status") {
          const snapshot = ocStatusSequence.length > 0 ? ocStatusSequence.shift() : ocStatuses;
          if (permissionLookupFailure === "status") json(500, { name: "UnknownError", data: { message: "panne simulée" } });
          else setTimeout(() => json(200, snapshot), lookupDelayMs);
        } else if (req.method === "GET" && /^\/session\/[^/]+\/children$/.test(pathname)) {
          json(200, ocChildren[pathname.split("/")[2] ?? ""] ?? []);
        } else if (req.method === "GET" && /^\/session\/[^/]+\/message\/[^/]+$/.test(pathname)) {
          const [, , sid = "", , mid = ""] = pathname.split("/");
          const message = ocMessages[`${sid}/${mid}`];
          if (permissionLookupFailure === "message") json(500, { name: "UnknownError", data: { message: "panne simulée" } });
          else if (message === undefined) json(404, { name: "NotFoundError", data: { message: `Message not found: ${mid}` } });
          else json(200, message);
        } else if (req.method === "POST" && /^\/session\/[^/]+\/abort$/.test(pathname)) {
          onAbort?.(pathname.split("/")[2] ?? "");
          res.writeHead(204).end();
        } else if (req.method === "GET" && pathname === "/session/ses_html/todo") {
          // Faux serveur (conteneur opencode compromis) qui répond un document : jamais servi tel quel par le cockpit.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<script src=/api/oc/session/x/message></script>");
        } else if (req.method === "POST") {
          res.writeHead(204).end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end("[]");
        }
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-test-"));
    fs.mkdirSync(path.join(tmp, "web"));
    fs.writeFileSync(path.join(tmp, "web", "index.html"), "<!doctype html><title>cockpit</title>");
    // « variant: » d'un raccourci : ignorée par opencode, injectée par le cockpit.
    fs.mkdirSync(path.join(tmp, "commands"));
    fs.writeFileSync(path.join(tmp, "commands", "resume-expert.md"), "---\ndescription: Résumé expert\nmodel: github-copilot/claude-opus-5\nvariant: high\n---\n\nRésume $ARGUMENTS\n");
    env = {
      host: "127.0.0.1",
      port: 0,
      token,
      allowedHosts: ["localhost", "127.0.0.1"],
      dataDir: tmp,
      archiveDir: tmp,
      workspaceDir: tmp,
      opencodeWorkspaceDir: "/workspace",
      opencodeConfigDir: tmp,
      opencodeDataDir: tmp,
      controlDir: tmp,
      webDir: path.join(tmp, "web"),
      opencodeUrl: `http://127.0.0.1:${upstreamPort}`,
      opencodeUsername: "opencode",
      opencodePassword: "p".repeat(24),
      tlsInsecure: false,
      projectConfig: false,
      certsDir: tmp,
      githubEnterpriseDomain: null,
      allowedProviders: ["github-copilot"],
      copilotApiUrl: null,
      version: "test",
    };
    const base = setup();
    db = base.db;
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', ?, ?)").run(sessionSecret, T);
    settings = base.settings;
    const client = new OpencodeClient(env);
    const catalog = new ModelCatalog(client);
    await catalog.refresh();
    const ledger = new Ledger({ db, settings, catalog });
    const root = base.sessions.upsert(session("ses_budget"));
    ledger.recordAssistant({ ...assistant("msg_b", "ses_budget", 500, 1, 1), time: { created: Date.now(), completed: Date.now() } }, root);
    db.prepare("INSERT INTO item_meta (kind, name, title, task_size, origin, created_at, updated_at) VALUES ('agents', ?, ?, 'M', 'assistant', ?, ?)").run(
      "relire-script",
      "Relire un script avant mise en production",
      T,
      T,
    );
    const quiet = createLogger("error");
    const log: Logger = { ...quiet, warn: (message) => warnings.push(message) };
    hub = new EventHub();
    lookup = new OcLookup({ client, env, hub, log });
    // Studio simulé : les écritures réelles sont couvertes par les tests du lot assistants.
    const studio = {
      save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown>; body: string }) => ({
        kind,
        name: input.name,
        scope: "global",
        project: null,
        file: `${kind}/${input.name}.md`,
        frontmatter: input.frontmatter,
        body: input.body,
        error: null,
        files: [],
        updatedAt: T,
      }),
      remove: async () => true,
    } as unknown as StudioService;
    const projects = new ProjectsService(env);
    // Services réels (même implémentation que main.ts) : niveaux d'IA et métadonnées d'assistants.
    const tiers = new TierService({ settings, catalog, ledger, env });
    const assistants = new AssistantService({ db, env, client, studio, lookup, tiers, ledger, settings, catalog, projects, hub, log });
    const app = createApp({
      env,
      log,
      db,
      client,
      catalog,
      ledger,
      settings,
      hub,
      lookup,
      tiers,
      assistants,
      projects,
      archive: {} as ArchiveService,
      classifier: {} as Classifier,
      studio,
      control: { caFilesCount: async () => 0, supervisorPresent: async () => false, restarting: false } as unknown as ControlService,
      quota: { copilotConnected: async () => true, latest: () => null } as unknown as QuotaSync,
      processor: { status: { connected: true } } as unknown as EventProcessor,
      copilot: {
        status: { connected: false, endpoint: null, modelsAt: 0, models: 0, error: null, discoveryError: null },
        probeHosts: async () => [],
      },
      copilotConfig: {
        status: { state: "inactif", message: null, at: 0 },
        sync: async () => ({ state: "inactif", message: null, at: 0 }),
      },
    });
    cockpit = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => cockpit.once("listening", resolve));
    port = (cockpit.address() as AddressInfo).port;
  });

  after(async () => {
    lookup.close();
    await new Promise((resolve) => cockpit.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = (
    method: string,
    pathname: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });

  const authed = { cookie };
  const mutating = { cookie, "x-cockpit-csrf": "1", "content-type": "application/json" };
  const confirmedHeaders = { ...mutating, "x-cockpit-confirm": "1" };
  const APP = encodeURIComponent("/workspace/app");
  const text = (value: string) => [{ type: "text", text: value }];
  /** Demandes réellement relayées à opencode (POST) dont l'URL contient `fragment`. */
  const forwarded = (fragment: string) => upstreamRequests.filter((r) => r.method === "POST" && r.url.includes(fragment));
  const prompt = (sessionId: string, body: unknown, headers: Record<string, string> = mutating) =>
    call("POST", `/api/oc/session/${sessionId}/prompt_async?directory=${APP}`, headers, JSON.stringify(body));
  const command = (sessionId: string, body: unknown, headers: Record<string, string> = mutating) =>
    call("POST", `/api/oc/session/${sessionId}/command?directory=${APP}`, headers, JSON.stringify(body));
  const turnsOf = (sessionId: string) =>
    db.prepare("SELECT kind, agent, command, tier, model, variant, runs FROM chat_turns WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{
      kind: string;
      agent: string;
      command: string | null;
      tier: string | null;
      model: string;
      variant: string | null;
      runs: string;
    }>;

  it("refuse un en-tête Host inconnu (DNS rebinding)", async () => {
    const res = await call("GET", "/api/health", { host: "evil.example:80" });
    assert.equal(res.status, 421);
  });

  it("pose les en-têtes de sécurité", async () => {
    const res = await call("GET", "/");
    assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal(res.headers["x-frame-options"], "DENY");
    // API : jamais un document (aucun script, même de la même origine).
    assert.equal((await call("GET", "/api/health")).headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; sandbox");
  });

  it("ne sert jamais un document ou un script relayé d'opencode : type JSON forcé et CSP bac à sable", async () => {
    const res = await call("GET", "/api/oc/session/ses_html/todo", authed);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; sandbox");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    const list = await call("GET", "/api/oc/session?directory=%2Fworkspace%2Fapp", authed);
    assert.match(String(list.headers["content-type"]), /^application\/json/);
  });

  it("exige la session sur l'API", async () => {
    assert.equal((await call("GET", "/api/settings")).status, 401);
    assert.equal((await call("GET", "/api/settings", authed)).status, 200);
  });

  it("ouvre une session avec le bon jeton seulement, cookie durci", async () => {
    const bad = await call("GET", "/auth?t=mauvais");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, "/?auth=failed");
    const good = await call("GET", `/auth?t=${token}`);
    const setCookie = String(good.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes(token));
  });

  it("bloque les requêtes modifiantes sans en-tête anti-CSRF ou d'une autre origine", async () => {
    assert.equal((await call("PUT", "/api/settings", { cookie, "content-type": "application/json" }, "{}")).status, 403);
    assert.equal((await call("PUT", "/api/settings", { ...mutating, origin: "http://evil.example" }, "{}")).status, 403);
    assert.equal((await call("PUT", "/api/settings", { ...mutating, origin: `http://127.0.0.1:${port}` }, "{}")).status, 200);
  });

  it("relaie vers opencode avec authentification et filtre les paramètres", async () => {
    const res = await call("GET", "/api/oc/session?directory=%2Fworkspace%2Fapp&roots=true&evil=1", authed);
    assert.equal(res.status, 200);
    const last = upstreamRequests.at(-1);
    assert.ok(last?.url.startsWith("/session?"));
    assert.match(last?.url ?? "", /directory=%2Fworkspace%2Fapp/);
    assert.doesNotMatch(last?.url ?? "", /evil/);
    assert.equal(last?.auth, `Basic ${Buffer.from(`opencode:${"p".repeat(24)}`).toString("base64")}`);
  });

  it("refuse les routes opencode hors liste blanche", async () => {
    assert.equal((await call("POST", "/api/oc/session/ses_1/share", mutating, "{}")).status, 404);
    assert.equal((await call("POST", "/api/oc/global/upgrade", mutating, "{}")).status, 404);
    assert.equal((await call("PUT", "/api/oc/auth/github-copilot", mutating, "{}")).status, 404);
    assert.ok(!PROXY_RULES.some((r) => r.pattern.test("/session/ses_1/share")));
  });

  it("ignore les tentatives de connexion émises par une autre page (pas de verrouillage à distance)", async () => {
    for (let i = 0; i < 25; i++) {
      const res = await call("GET", "/auth?t=mauvais", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" });
      assert.equal(res.status, 403);
    }
    const good = await call("GET", `/auth?t=${token}`, { "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(good.status, 303);
  });

  it("n'expose que les routes opencode utilisées par l'interface", async () => {
    assert.equal((await call("POST", "/api/oc/session/ses_1/shell", mutating, '{"agent":"build","command":"id"}')).status, 404);
    assert.equal((await call("GET", "/api/oc/file/content?path=%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode%2Fauth.json", authed)).status, 404);
    assert.equal((await call("POST", "/api/oc/session/ses_1/message", mutating, "{}")).status, 404);
  });

  it("refuse la syntaxe !`commande`, les @chemins hors du workspace et les parties subtask", async () => {
    // 0.2.0 : une demande facturée porte toujours une IA (400 modele-requis sinon).
    const commandOf = (args: unknown, directory = "/workspace/app") =>
      call(
        "POST",
        `/api/oc/session/ses_1/command?directory=${encodeURIComponent(directory)}`,
        confirmedHeaders,
        JSON.stringify({ command: "revue", arguments: args, agent: "build", model: "github-copilot/gpt-5-mini" }),
      );
    fs.mkdirSync(path.join(tmp, "app", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "notes"), { recursive: true });
    assert.equal((await commandOf("regarde !`cat ~/.local/share/opencode/auth.json`")).status, 403);
    assert.equal((await commandOf("@~/.local/share/opencode/auth.json")).status, 403);
    assert.equal((await commandOf("@/home/node/.local/share/opencode/auth.json")).status, 403);
    assert.equal((await commandOf("@../../etc/passwd")).status, 403);
    assert.equal((await commandOf(42)).status, 403);
    assert.equal((await commandOf("revois @src/app.ts et @/workspace/app/README.md")).status, 204);
    // Hors dépôt git, opencode résout un @chemin relatif depuis « / » : le jeton Copilot serait lisible.
    assert.equal((await commandOf("@home/node/.local/share/opencode/auth.json", "/workspace/notes")).status, 403);
    assert.equal((await commandOf("revois @src/app.ts", "/workspace/notes")).status, 403);
    const subtask = JSON.stringify({ parts: [{ type: "subtask", agent: "general", description: "x", prompt: "@/home/node/.local/share/opencode/auth.json" }] });
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, subtask)).status, 403);
  });

  it("remplace les permissions globales d'un bloc en gardant les commentaires", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(file, '{\n  // commentaire conservé\n  "share": "disabled",\n  "permission": { "edit": "ask", "bash": { "*": "ask", "git branch*": "allow" } }\n}\n');
    // 0.2.0 : écriture réservée au mode Avancé.
    settings.update({ ui: { mode: "avance" } });
    try {
      const permission = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask" };
      const res = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission }));
      assert.equal(res.status, 200, res.body);
      const written = fs.readFileSync(file, "utf8");
      assert.match(written, /commentaire conservé/);
      assert.doesNotMatch(written, /git branch/);
      assert.deepEqual(JSON.parse(written.replace(/^\s*\/\/.*$/gm, "")).permission, permission);
      assert.equal((await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { bash: "sudo" } }))).status, 400);
    } finally {
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  it("refuse les permissions glissées dans une requête et les connexions hors GitHub Copilot", async () => {
    const rule = [{ permission: "webfetch", pattern: "*", action: "allow" }];
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ permission: rule }))).status, 403);
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ title: "ok" }))).status, 204);
    assert.equal((await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ permission: rule }))).status, 403);
    assert.equal((await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ title: "renommée" }))).status, 200);
    const promptBody = { model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "x" }], tools: { webfetch: true } };
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, JSON.stringify(promptBody))).status, 403);
    const authorize = (inputs: Record<string, string>) =>
      call("POST", "/api/oc/provider/github-copilot/oauth/authorize", mutating, JSON.stringify({ method: 0, inputs }));
    assert.equal((await authorize({ deploymentType: "enterprise", enterpriseUrl: "github-login.example" })).status, 403);
    assert.equal((await authorize({ deploymentType: "github.com" })).status, 204);
    assert.equal((await call("POST", "/api/oc/provider/openai/oauth/authorize", mutating, JSON.stringify({ method: 0 }))).status, 404);
    const enterprise = { inputs: { deploymentType: "enterprise", enterpriseUrl: "https://Entreprise.ghe.com/" } };
    assert.equal(forbiddenProxyBody("POST", "/provider/github-copilot/oauth/authorize", enterprise, "entreprise.ghe.com"), undefined);
    assert.notEqual(forbiddenProxyBody("POST", "/provider/github-copilot/oauth/authorize", enterprise, "autre.ghe.com"), undefined);
  });

  it("refuse les pièces jointes hors du workspace", async () => {
    const body = (url: string) =>
      JSON.stringify({ model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "file", mime: "text/plain", url }] });
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, body("file:///home/node/.local/share/opencode/auth.json"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, body("file:///workspace/../etc/passwd"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, body("https://exemple.test/a.txt"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, body("file:///workspace/app/src/x.ts"))).status, 204);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmedHeaders, body("file:///workspace/..%2Fetc%2Fpasswd"))).status, 403);
    const seen: string[] = [];
    const allow = (file: string) => (seen.push(file), file.startsWith("/workspace/"));
    assert.equal(forbiddenAttachment({ parts: [{ type: "text", text: "x" }, { url: "data:image/png;base64,AA" }, { url: "file:///workspace/a%20b.txt" }] }, allow), undefined);
    assert.deepEqual(seen, ["/workspace/a b.txt"]);
    assert.equal(forbiddenAttachment({ parts: [{ url: 42 }] }, allow), "number");
    assert.equal(forbiddenAttachment({ parts: [{ url: "data:text/plain;base64,AA" }] }, allow), "data:text/plain;base64,AA");
  });

  it("refuse un dossier hors du workspace", async () => {
    assert.equal((await call("GET", "/api/oc/session?directory=%2Fetc", authed)).status, 403);
    assert.equal((await call("GET", "/api/oc/session?directory=%2Fworkspace%2F..%2Fetc", authed)).status, 403);
  });

  it("applique le garde-fou budgétaire aux prompts, contournable par confirmation", async () => {
    const body = JSON.stringify({ model: { providerID: "github-copilot", modelID: "claude-opus-5" }, parts: [{ type: "text", text: "hi" }] });
    const blocked = await call("POST", "/api/oc/session/ses_1/prompt_async", mutating, body);
    assert.equal(blocked.status, 409);
    assert.equal(JSON.parse(blocked.body).code, "budget-exhausted");
    const confirmed = await call("POST", "/api/oc/session/ses_1/prompt_async", { ...mutating, "x-cockpit-confirm": "1" }, body);
    assert.equal(confirmed.status, 204);
    assert.equal(upstreamRequests.at(-1)?.body, body);
  });

  // --- 0.2.0 : IA réellement facturée (conception §5.4, tests §14.2 « Proxy ») -------------------

  it("garde les agents d'opencode 15 s en cache, les relit après studio.changed et lit la réflexion des raccourcis", async () => {
    lookup.invalidate();
    const agentCalls = () => upstreamRequests.filter((r) => r.method === "GET" && r.url.startsWith("/agent")).length;
    const start = agentCalls();
    const first = await lookup.get("/workspace/app");
    await lookup.get("/workspace/app");
    assert.equal(agentCalls(), start + 1);
    assert.equal(first.directory, "/workspace/app");
    assert.equal(first.commands.find((x) => x.name === "resume-expert")?.fileVariant, "high");
    assert.equal(first.commands.find((x) => x.name === "revue")?.fileVariant, undefined);
    assert.deepEqual(first.agents.find((a) => a.name === "relire-script")?.model, ref("claude-sonnet-5"));
    assert.equal(first.agents.find((a) => a.name === "relire-script")?.permission.length, 3);
    hub.cockpit("studio.changed", { kind: "agents", name: "relire-script" });
    await lookup.get("/workspace/app");
    assert.equal(agentCalls(), start + 2);
    const [a, b] = await Promise.all([lookup.get(null), lookup.get(null)]);
    assert.equal(a, b);
    assert.equal(agentCalls(), start + 3);
  });

  it("exige une IA d'un fournisseur autorisé dans chaque demande facturée", async () => {
    const posts = forwarded("/session/ses_prov/").length;
    const missing = await prompt("ses_prov", { agent: "build", parts: text("x") }, confirmedHeaders);
    assert.equal(missing.status, 400);
    assert.equal(JSON.parse(missing.body).error, "modele-requis");
    const zen = { agent: "build", model: ref("big-pickle", "opencode"), parts: text("x") };
    const refused = await prompt("ses_prov", zen, confirmedHeaders);
    assert.equal(refused.status, 403);
    assert.deepEqual(JSON.parse(refused.body), { error: "fournisseur-refuse", message: "Seules les IA GitHub Copilot sont autorisées dans ce cockpit." });
    const summarize = await call("POST", `/api/oc/session/ses_prov/summarize?directory=${APP}`, confirmedHeaders, JSON.stringify(ref("big-pickle", "opencode")));
    assert.equal(summarize.status, 403);
    assert.equal(forwarded("/session/ses_prov/").length, posts);
    // COCKPIT_ALLOWED_PROVIDERS=github-copilot,opencode (harnais e2e) : accepté.
    env.allowedProviders.push("opencode");
    try {
      assert.equal((await prompt("ses_prov", zen, confirmedHeaders)).status, 204);
    } finally {
      env.allowedProviders.splice(env.allowedProviders.indexOf("opencode"), 1);
    }
    assert.equal(forwarded("/session/ses_prov/").length, posts + 1);
  });

  it("IA d'une demande facturée : seule la forme lue par opencode pour la route compte, les leurres sont refusés", async () => {
    const opus = ref("claude-opus-5");
    assert.deepEqual(turnModelFromBody("message", { model: opus }), opus);
    assert.deepEqual(turnModelFromBody("raccourci", { model: "github-copilot/claude-opus-5" }), opus);
    assert.deepEqual(turnModelFromBody("resume", { ...opus, auto: false }), opus);
    assert.equal(turnModelFromBody("message", { model: "github-copilot/claude-opus-5" }), undefined);
    assert.equal(turnModelFromBody("message", { ...opus }), undefined);
    assert.equal(turnModelFromBody("message", { model: ref("gpt-5-mini"), ...opus }), undefined);
    assert.equal(turnModelFromBody("raccourci", { model: opus }), undefined);
    assert.equal(turnModelFromBody("raccourci", { model: "github-copilot/gpt-5-mini", ...opus }), undefined);
    assert.equal(turnModelFromBody("raccourci", { model: "/gpt-5-mini" }), undefined);
    assert.equal(turnModelFromBody("resume", { model: ref("gpt-5-mini"), ...opus }), undefined);
    assert.equal(turnModelFromBody("resume", { model: "github-copilot/gpt-5-mini" }), undefined);
    assert.equal(turnModelFromBody("resume", []), undefined);

    const posts = forwarded("/session/ses_leurre/").length;
    const refusedWith = async (res: { status: number; body: string }) => {
      assert.equal(res.status, 400, res.body);
      assert.equal(JSON.parse(res.body).error, "modele-requis");
    };
    // Résumer : opencode compacte avec providerID/modelID du premier niveau ; `model` serait contrôlé à sa place.
    // Tout autre champ que providerID/modelID est refusé dès le filtre de contenu.
    const decoy = { model: ref("gpt-5-mini"), ...ref("big-pickle", "opencode") };
    const decoySummary = await call("POST", `/api/oc/session/ses_leurre/summarize?directory=${APP}`, confirmedHeaders, JSON.stringify(decoy));
    assert.equal(decoySummary.status, 403, decoySummary.body);
    assert.equal(JSON.parse(decoySummary.body).error, "forbidden-body");
    // Message sans `model` objet : opencode prendrait l'IA de l'agent ou de la session.
    await refusedWith(await prompt("ses_leurre", { agent: "build", ...ref("gpt-5-mini"), parts: text("x") }, confirmedHeaders));
    await refusedWith(await prompt("ses_leurre", { agent: "build", model: "github-copilot/gpt-5-mini", parts: text("x") }, confirmedHeaders));
    await refusedWith(await prompt("ses_leurre", { agent: "build", model: ref("gpt-5-mini"), ...opus, parts: text("x") }, confirmedHeaders));
    // Raccourci : opencode lit `model` en « fournisseur/modèle » seulement.
    await refusedWith(await command("ses_leurre", { command: "revue", arguments: "x", agent: "build", model: ref("gpt-5-mini") }, confirmedHeaders));
    await refusedWith(await command("ses_leurre", { command: "revue", arguments: "x", agent: "build", model: "github-copilot/gpt-5-mini", ...opus }, confirmedHeaders));
    assert.equal(forwarded("/session/ses_leurre/").length, posts);
    assert.equal(turnsOf("ses_leurre").length, 0);
    // Formes attendues : relayées.
    assert.equal((await prompt("ses_leurre", { agent: "build", model: ref("gpt-5-mini"), parts: text("x") }, confirmedHeaders)).status, 204);
    assert.equal((await call("POST", `/api/oc/session/ses_leurre/summarize?directory=${APP}`, confirmedHeaders, JSON.stringify(ref("gpt-5-mini")))).status, 204);
    assert.equal(forwarded("/session/ses_leurre/").length, posts + 2);
  });

  it("Résumer : garde-fou et trace sur l'IA de l'agent « compaction » qu'opencode facture, `auto` refusé", async () => {
    const url = `/api/oc/session/ses_compact/summarize?directory=${APP}`;
    const auto = await call("POST", url, confirmedHeaders, JSON.stringify({ ...ref("gpt-5-mini"), auto: true }));
    assert.equal(auto.status, 403, auto.body);
    assert.equal(JSON.parse(auto.body).error, "forbidden-body");
    assert.notEqual(forbiddenProxyBody("POST", "/session/ses_compact/summarize", { ...ref("gpt-5-mini"), auto: false }, null), undefined);
    assert.equal(forbiddenProxyBody("POST", "/session/ses_compact/summarize", ref("gpt-5-mini"), null), undefined);
    assert.equal(forwarded("/session/ses_compact/").length, 0);

    const compaction = { name: "compaction", mode: "primary", native: true, hidden: true, options: {}, permission: [], model: ref("claude-opus-5") };
    const fixture = compaction as unknown as (typeof FIXTURE_AGENTS)[number];
    FIXTURE_AGENTS.push(fixture);
    lookup.invalidate();
    try {
      // Budget atteint : le refus nomme l'IA de compaction, pas celle de la demande.
      const blocked = await call("POST", url, mutating, JSON.stringify(ref("gpt-5-mini")));
      assert.equal(blocked.status, 409, blocked.body);
      assert.equal(JSON.parse(blocked.body).run.model, "github-copilot/claude-opus-5");
      assert.equal((await call("POST", url, confirmedHeaders, JSON.stringify(ref("gpt-5-mini")))).status, 204);
      const [row] = turnsOf("ses_compact");
      assert.equal(row?.kind, "resume");
      assert.deepEqual(JSON.parse(row?.runs ?? "[]"), [{ role: "message", model: "github-copilot/claude-opus-5", variant: null, source: "assistant", agent: "compaction" }]);

      // IA de compaction d'un fournisseur non autorisé, ou absente du compte : rien n'est relayé.
      const posts = forwarded("/session/ses_compact/").length;
      compaction.model = ref("big-pickle", "opencode");
      lookup.invalidate();
      const foreign = await call("POST", url, confirmedHeaders, JSON.stringify(ref("gpt-5-mini")));
      assert.equal(foreign.status, 403, foreign.body);
      assert.equal(JSON.parse(foreign.body).error, "fournisseur-refuse");
      compaction.model = ref("claude-inconnu");
      lookup.invalidate();
      const missing = await call("POST", url, confirmedHeaders, JSON.stringify(ref("gpt-5-mini")));
      assert.equal(missing.status, 409, missing.body);
      assert.equal(JSON.parse(missing.body).error, "ia-indisponible");
      assert.equal(forwarded("/session/ses_compact/").length, posts);
    } finally {
      FIXTURE_AGENTS.splice(FIXTURE_AGENTS.indexOf(fixture), 1);
      lookup.invalidate();
    }
  });

  it("impose l'IA d'un assistant : 409 avec son modèle, renvoi accepté et tracé, choix avancé pour un message", async () => {
    const other = { agent: "relire-script", model: ref("gpt-5-mini"), parts: text("relis") };
    const locked = await prompt("ses_lock", other, confirmedHeaders);
    assert.equal(locked.status, 409);
    assert.deepEqual(JSON.parse(locked.body), {
      error: "assistant-model-changed",
      message: "L'IA de cet assistant a changé : Claude Sonnet 5 est utilisée.",
      agent: "relire-script",
      model: ref("claude-sonnet-5"),
      variant: "high",
      modelName: "Claude Sonnet 5",
    });
    // L'en-tête seul ne suffit pas en mode Simple.
    assert.equal((await prompt("ses_lock", other, { ...confirmedHeaders, "x-cockpit-model-override": "1" })).status, 409);
    assert.equal(forwarded("/session/ses_lock/").length, 0);

    const resent = { agent: "relire-script", model: ref("claude-sonnet-5"), variant: "high", parts: text("relis") };
    assert.equal((await prompt("ses_lock", resent, confirmedHeaders)).status, 204);
    assert.deepEqual(JSON.parse(forwarded("/session/ses_lock/").at(-1)?.body ?? "{}"), resent);
    const [row] = turnsOf("ses_lock");
    assert.equal(row?.kind, "message");
    assert.equal(row?.agent, "relire-script");
    assert.equal(row?.tier, "equilibre");
    assert.equal(row?.model, "github-copilot/claude-sonnet-5");
    assert.equal(row?.variant, "high");
    assert.deepEqual(JSON.parse(row?.runs ?? "[]"), [
      { role: "message", model: "github-copilot/claude-sonnet-5", variant: "high", source: "assistant", agent: "relire-script" },
    ]);

    settings.update({ ui: { mode: "avance" }, ai: { allowModelOverride: true } });
    try {
      assert.equal((await prompt("ses_lock", other, confirmedHeaders)).status, 409);
      assert.equal((await prompt("ses_lock", other, { ...confirmedHeaders, "x-cockpit-model-override": "1" })).status, 204);
      assert.deepEqual(JSON.parse(forwarded("/session/ses_lock/").at(-1)?.body ?? "{}").model, ref("gpt-5-mini"));
      // Raccourci : même règle, l'en-tête doit aussi accompagner /command (oc.command côté interface).
      const shortcut = { command: "revue", arguments: "x", agent: "relire-script", model: "github-copilot/gpt-5-mini" };
      assert.equal(JSON.parse((await command("ses_lock_cmd", shortcut, confirmedHeaders)).body).error, "assistant-model-changed");
      assert.equal((await command("ses_lock_cmd", shortcut, { ...confirmedHeaders, "x-cockpit-model-override": "1" })).status, 204);
      assert.equal(JSON.parse(forwarded("/session/ses_lock_cmd/command").at(-1)?.body ?? "{}").model, "github-copilot/gpt-5-mini");
    } finally {
      settings.update({ ui: { mode: "simple" }, ai: { allowModelOverride: false } });
    }
    // Les choix restaurés viennent du dernier message.
    const choices = JSON.parse((await call("GET", "/api/chat/choices/ses_lock", authed)).body);
    assert.equal(choices.agent, "relire-script");
    assert.equal(choices.model, "github-copilot/gpt-5-mini");
    assert.equal((await call("GET", "/api/chat/choices/ses%20lock", authed)).status, 400);
    assert.equal((await call("GET", "/api/chat/choices/ses_vide", authed)).body, "null");
  });

  it("raccourci lié à Expert à 85 % du budget : 409 qui nomme son IA, puis réflexion du fichier injectée après confirmation", async () => {
    settings.update({ budget: { monthlyUsd: 500 / 0.85 } });
    try {
      const body = { command: "resume-expert", arguments: "le journal", agent: "build", model: "github-copilot/gpt-5-mini" };
      const blocked = await command("ses_cmd", body);
      assert.equal(blocked.status, 409);
      const guard = JSON.parse(blocked.body);
      assert.equal(guard.error, "budget-guard");
      assert.equal(guard.code, "expensive-model");
      assert.equal(guard.title, "Confirmer une demande coûteuse");
      assert.equal(guard.run.model, "github-copilot/claude-opus-5");
      assert.equal(guard.modelName, "Claude Opus 5");
      assert.match(guard.message, /^85 % du budget du mois est consommé\. Cette demande utilise Claude Opus 5 \(niveau Expert\) : environ [\d,]+ \$, via le raccourci \/resume-expert\. Envoyer quand même \?$/);
      assert.equal(forwarded("/session/ses_cmd/").length, 0);

      assert.equal((await command("ses_cmd", body, confirmedHeaders)).status, 204);
      assert.deepEqual(JSON.parse(forwarded("/session/ses_cmd/command").at(-1)?.body ?? "{}"), { ...body, variant: "high" });
      const [row] = turnsOf("ses_cmd");
      assert.equal(row?.kind, "raccourci");
      assert.equal(row?.command, "resume-expert");
      assert.equal(row?.tier, "expert");
      assert.equal(row?.variant, "high");
    } finally {
      settings.update({ budget: { monthlyUsd: 150 } });
    }
  });

  it("travail délégué : chaque appel facturé passe au garde-fou, le plus cher d'abord", async () => {
    const body = { command: "revue-cab", arguments: "x", agent: "build", model: "github-copilot/gpt-5-mini", variant: "low" };
    const blocked = await command("ses_cab", body);
    assert.equal(blocked.status, 409);
    const guard = JSON.parse(blocked.body);
    assert.equal(guard.code, "budget-exhausted");
    assert.equal(guard.run.role, "delegue");
    assert.equal(guard.modelName, "Claude Opus 5");
    assert.equal(guard.message, "Budget du mois atteint (500 $ sur 150 $). Cette demande reste facturée sur votre compte GitHub Copilot. Envoyer quand même ?");
    assert.equal((await command("ses_cab", body, confirmedHeaders)).status, 204);
    // La réflexion de la conversation n'atteint que la reprise, sur l'IA de la conversation : conservée.
    assert.deepEqual(JSON.parse(forwarded("/session/ses_cab/command").at(-1)?.body ?? "{}"), body);
    const runs = JSON.parse(turnsOf("ses_cab")[0]?.runs ?? "[]") as Run[];
    assert.deepEqual(runs.map((r) => [r.role, r.model]), [
      ["delegue", "github-copilot/claude-opus-5"],
      ["reprise", "github-copilot/gpt-5-mini"],
    ]);
  });

  it("refuse une fiche interdite à l'assistant et un raccourci dont l'assistant a disparu, sans rien relayer", async () => {
    const base = { arguments: "x", agent: "relire-script", model: "github-copilot/claude-sonnet-5" };
    const fiche = await command("ses_fiche", { ...base, command: "checklist-cab" }, confirmedHeaders);
    assert.equal(fiche.status, 403);
    assert.deepEqual(JSON.parse(fiche.body), {
      error: "fiche-refusee",
      message:
        "L'assistant « Relire un script avant mise en production » n'a pas accès à la fiche « checklist-cab ». Choisissez l'assistant qui l'utilise ou l'Assistant général.",
    });
    const ghost = await command("ses_fiche", { ...base, command: "fantome" }, confirmedHeaders);
    assert.equal(ghost.status, 403);
    assert.deepEqual(JSON.parse(ghost.body), {
      error: "agent-du-raccourci-introuvable",
      message: "Le raccourci /fantome utilise l'assistant « disparu », qui n'existe plus.",
    });
    assert.equal(forwarded("/session/ses_fiche/").length, 0);
    assert.equal(turnsOf("ses_fiche").length, 0);
    assert.equal((await command("ses_fiche", { ...base, command: "standards-scripts" }, confirmedHeaders)).status, 204);
    // Raccourci non délégué sur l'IA de l'assistant : sa réflexion, fixée par le serveur (R1/R2, prompt.ts:647-654).
    assert.equal(JSON.parse(forwarded("/session/ses_fiche/command").at(-1)?.body ?? "{}").variant, "high");
  });

  it("IA absente du compte Copilot : 409 ia-indisponible, rien d'envoyé ni facturé", async () => {
    const retired = await prompt("ses_absent", { agent: "ancien", model: ref("gpt-4-retire"), parts: text("x") }, confirmedHeaders);
    assert.equal(retired.status, 409);
    assert.deepEqual(JSON.parse(retired.body), {
      error: "ia-indisponible",
      message: "L'IA de cet assistant (« gpt-4-retire ») n'est plus disponible sur votre compte Copilot. Rien n'a été envoyé.",
    });
    // Pas de renvoi automatique vers une IA qui a disparu.
    const stale = await prompt("ses_absent", { agent: "ancien", model: ref("gpt-5-mini"), parts: text("x") }, confirmedHeaders);
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.body).error, "ia-indisponible");
    const summarize = await call("POST", `/api/oc/session/ses_absent/summarize?directory=${APP}`, confirmedHeaders, JSON.stringify(ref("claude-inconnu")));
    assert.equal(summarize.status, 409);
    assert.equal(JSON.parse(summarize.body).message, "L'IA « claude-inconnu » n'est pas disponible sur votre compte Copilot. Rien n'a été envoyé ni facturé.");
    assert.equal(forwarded("/session/ses_absent/").length, 0);
  });

  it("sans GET /agent : garde-fou sur l'IA du corps (comportement 0.1.x), demande relayée telle quelle et tracée", async () => {
    agentFails = true;
    lookup.invalidate();
    try {
      const body = { agent: "relire-script", model: ref("claude-opus-5"), variant: "high", parts: text("x") };
      const blocked = await prompt("ses_repli", body);
      assert.equal(blocked.status, 409);
      assert.equal(JSON.parse(blocked.body).code, "budget-exhausted");
      assert.ok(warnings.some((w) => w.includes("agents d'opencode illisibles")));
      assert.equal((await prompt("ses_repli", body, confirmedHeaders)).status, 204);
      assert.equal(forwarded("/session/ses_repli/").at(-1)?.body, JSON.stringify(body));
      assert.equal(turnsOf("ses_repli")[0]?.model, "github-copilot/claude-opus-5");
      const resolve = await call("POST", "/api/chat/resolve", mutating, JSON.stringify({ directory: "/workspace/app", agent: "build" }));
      assert.equal(resolve.status, 502);
      assert.equal(JSON.parse(resolve.body).error, "opencode-unreachable");
    } finally {
      agentFails = false;
      lookup.invalidate();
    }
  });

  it("POST /api/chat/resolve : même résolution que le proxy, textes prêts à afficher", async () => {
    const resolve = (body: unknown) => call("POST", "/api/chat/resolve", mutating, JSON.stringify(body));
    const fixed = await resolve({ directory: "/workspace/app", agent: "relire-script" });
    assert.equal(fixed.status, 200, fixed.body);
    const turn = JSON.parse(fixed.body);
    assert.deepEqual(turn.send, { model: ref("claude-sonnet-5"), variant: "high" });
    assert.deepEqual(turn.lock, { kind: "assistant", name: "relire-script" });
    assert.equal(turn.agentTitle, "Relire un script avant mise en production");
    assert.equal(turn.tier, "equilibre");
    assert.equal(turn.tierStatus, null);
    assert.equal(turn.bodyModel, "github-copilot/claude-sonnet-5");
    assert.equal(turn.display.chip, "IA : Claude Sonnet 5 · Équilibré (fixée par l'assistant)");
    assert.match(turn.display.estimateText, /^≈ [\d,]+ \$ par demande$/);

    const delegated = JSON.parse((await resolve({ directory: "/workspace/app", agent: "build", tier: "rapide", command: "revue-cab" })).body);
    assert.equal(delegated.delegated, true);
    assert.equal(delegated.bodyModel, "github-copilot/gpt-5.4-mini");
    assert.deepEqual(delegated.runs.map((r: Run) => r.role), ["delegue", "reprise"]);
    assert.match(delegated.display.chip, /^Travail délégué à « expert-cab » \(IA Claude Opus 5\) \+ reprise dans la conversation \(IA GPT-5\.4 mini\) · ≈ /);

    const missing = JSON.parse((await resolve({ directory: "/workspace/app", agent: "inconnu", variant: "high" })).body);
    assert.equal(missing.agent, "build");
    assert.equal(missing.agentMissing, "inconnu");
    assert.equal(missing.tier, "equilibre");
    assert.equal(missing.tierStatus, "ok");
    assert.deepEqual(missing.send, { model: ref("claude-sonnet-5"), variant: "high" });

    // Niveau « Indisponible » (IA prévue d'un fournisseur non autorisé) : bloquant, rien ne part sur l'IA prévue.
    settings.update({
      ai: {
        tiers: {
          rapide: { candidates: ["opencode/big-pickle"], variant: null },
          equilibre: { candidates: ["github-copilot/claude-sonnet-5"], variant: null },
          expert: { candidates: ["github-copilot/claude-opus-5"], variant: null },
        },
      },
    });
    try {
      const blocked = JSON.parse((await resolve({ directory: "/workspace/app", agent: "build", tier: "rapide" })).body);
      assert.equal(blocked.tierStatus, "indisponible");
      assert.deepEqual(blocked.problems, [{ code: "ia-indisponible", blocking: true, model: "opencode/big-pickle" }]);
      assert.equal(blocked.display.problems[0]?.blocking, true);
      // Assistant à IA fixée : le niveau ne sert pas.
      assert.deepEqual(JSON.parse((await resolve({ directory: "/workspace/app", agent: "relire-script", tier: "rapide" })).body).problems, []);
    } finally {
      settings.update({ ai: { tiers: null } });
    }

    assert.equal((await resolve({ directory: "/etc", agent: "build" })).status, 403);
    assert.equal((await resolve({ directory: "/workspace/app", agent: "build", command: "nope" })).status, 404);
    assert.equal((await resolve({ directory: "/workspace/app", agent: "build", extra: 1 })).status, 400);
  });

  it("modèles et démarrage : prix effectif pour « cher », niveau, coût par demande, mode et fournisseurs", async () => {
    const models = () => call("GET", "/api/models", authed).then((r) => JSON.parse(r.body).models as Array<Record<string, unknown>>);
    const byKey = (list: Array<Record<string, unknown>>, key: string) => list.find((m) => m.key === key);
    const list = await models();
    const opus = byKey(list, "github-copilot/claude-opus-5");
    assert.equal(opus?.tier, "expert");
    assert.equal(opus?.expensive, true);
    assert.equal(opus?.status, "active");
    assert.equal(opus?.toolcall, true);
    assert.equal(opus?.reserved, false);
    assert.ok(((opus?.taskCost as { M: number } | null)?.M ?? 0) > 0.4);
    assert.equal(byKey(list, "github-copilot/claude-sonnet-5")?.expensive, false);
    // Une surcharge de tarif compte pour « cher » (auparavant, seul le prix du catalogue était lu).
    settings.update({ pricing: { overrides: { "github-copilot/claude-sonnet-5": { rates: { input: 3, cachedInput: 0.3, cacheWrite: null, output: 20 } } } } });
    try {
      const sonnet = byKey(await models(), "github-copilot/claude-sonnet-5");
      assert.equal(sonnet?.expensive, true);
      assert.equal((sonnet?.price as { rates: { output: number } }).rates.output, 20);
    } finally {
      settings.update({ pricing: { overrides: {} } });
    }

    const boot = await call("GET", "/api/bootstrap", authed);
    assert.equal(boot.status, 200, boot.body);
    const data = JSON.parse(boot.body);
    assert.equal(data.ui.mode, "simple");
    assert.equal(data.rulesVersion, 1);
    assert.deepEqual(data.allowedProviders, ["github-copilot"]);
    // Verrou réel d'opencode lu dans sa configuration (configuration livrée : en place).
    assert.deepEqual(data.security.providerIssues, []);
    assert.equal(data.ai.chatDefaultTier, "equilibre");
    assert.equal(data.ai.allowModelOverride, false);
    assert.deepEqual(
      data.ai.tiers.map((t: { id: string; model: string; status: string }) => [t.id, t.model, t.status]),
      [
        ["rapide", "github-copilot/gpt-5.4-mini", "ok"],
        ["equilibre", "github-copilot/claude-sonnet-5", "ok"],
        ["expert", "github-copilot/claude-opus-5", "ok"],
      ],
    );
  });

  it("estimation par agent et taille de demande", async () => {
    const res = await call("GET", "/api/usage/estimate?provider=github-copilot&model=claude-sonnet-5&agent=relire-script&size=S", authed);
    assert.equal(res.status, 200, res.body);
    const data = JSON.parse(res.body);
    assert.equal(data.estimate.source, "profile");
    assert.equal(data.estimate.size, "S");
    assert.match(data.estimate.text, /^≈ [\d,]+ \$ par demande$/);
    assert.match(data.estimate.detailText, /\(estimation\)$/);
    assert.equal(data.guard.allowed, false);
    assert.equal((await call("GET", "/api/usage/estimate?provider=github-copilot&model=claude-sonnet-5&size=XL", authed)).status, 400);
  });

  it("revient au profil Prudent (mode Simple compris) avec l'écriture vérifiée", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(file, '{\n  // commentaire conservé\n  "permission": { "edit": "allow", "bash": "allow" }\n}\n');
    try {
      const res = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(JSON.parse(res.body), { ok: true, permission: PRUDENT });
      const written = fs.readFileSync(file, "utf8");
      assert.match(written, /commentaire conservé/);
      assert.deepEqual(JSON.parse(written.replace(/^\s*\/\/.*$/gm, "")).permission, PRUDENT);
      assert.equal((await call("POST", "/api/security/restore-prudent", mutating, '{"permission":{"bash":"allow"}}')).status, 400);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("« Revenir au profil Prudent » : doublons de « permission » retirés, jamais de faux succès si opencode applique d'autres règles", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const other = path.join(tmp, "config.json");
    // jsonc-parser (comme opencode) garde la DERNIÈRE clé en double : c'est elle qui fait foi.
    fs.writeFileSync(file, '{\n  "permission": { "edit": "ask" },\n  // doublon\n  "permission": { "edit": "allow", "bash": "allow", "task": "allow" }\n}\n');
    try {
      const res = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(res.status, 200, res.body);
      const written = fs.readFileSync(file, "utf8");
      assert.equal((written.match(/"permission"/g) ?? []).length, 1);
      assert.deepEqual(parseJsonc(written).permission, PRUDENT);
      // Fichier de configuration de moindre priorité qui ajoute des règles : elles survivent à la fusion d'opencode.
      fs.writeFileSync(other, JSON.stringify({ permission: { "*": "allow", external_directory: "allow" } }));
      const shadowed = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(shadowed.status, 422, shadowed.body);
      assert.equal(JSON.parse(shadowed.body).error, "permissions-non-appliquees");
      assert.match(JSON.parse(shadowed.body).message, /config\.json/);
      settings.update({ ui: { mode: "avance" } });
      assert.equal((await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: PRUDENT }))).status, 422);
    } finally {
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
      fs.rmSync(other, { force: true });
    }
  });

  it("verrou « fournisseurs » : configuration d'opencode, IA de classement et ancienne IA du chat limitées aux fournisseurs autorisés", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const patches = () => upstreamRequests.filter((r) => r.method === "PATCH" && r.url.startsWith("/global/config")).length;
    const patch = (body: string) => call("PATCH", "/api/opencode/config", mutating, body);
    const raw = (content: string) => call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content }));
    const paths = (res: { body: string }) => (JSON.parse(res.body).issues as Array<{ path: string }>).map((i) => i.path);
    const merged = mergeConfigPatch({ a: { b: 1, c: 2 }, l: [1, 2], enabled_providers: ["github-copilot"] }, { a: { b: 3 }, l: [3] });
    assert.deepEqual(JSON.parse(JSON.stringify(merged)), { a: { b: 3, c: 2 }, l: [3], enabled_providers: ["github-copilot"] });
    settings.update({ ui: { mode: "avance" } });
    try {
      const before = patches();
      const small = await patch(JSON.stringify({ small_model: "opencode/big-pickle" }));
      assert.equal(small.status, 422, small.body);
      assert.equal(JSON.parse(small.body).error, "fournisseur-refuse");
      assert.deepEqual(paths(small), ["small_model"]);
      assert.deepEqual(paths(await patch(JSON.stringify({ enabled_providers: ["github-copilot", "opencode"] }))), ["enabled_providers.1"]);
      assert.deepEqual(paths(await patch(JSON.stringify({ agent: { general: { model: "opencode/big-pickle" } } }))), ["agent.general.model"]);
      assert.equal(patches(), before);
      assert.equal((await patch(JSON.stringify({ small_model: "github-copilot/gpt-5-mini" }))).status, 200);
      assert.equal(patches(), before + 1);

      // Fichier brut : verrou obligatoire, IA par défaut d'un autre fournisseur refusée, rien d'écrit.
      assert.deepEqual(paths(await raw("{}")), ["enabled_providers"]);
      assert.deepEqual(paths(await raw('{\n  // commentaire\n  "enabled_providers": ["github-copilot"],\n  "small_model": "opencode/big-pickle",\n}')), ["small_model"]);
      assert.equal(fs.existsSync(file), false);
      const accepted = await raw('{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" }\n}\n');
      assert.equal(accepted.status, 200, accepted.body);
      // Configuration existante sans verrou : tout correctif est refusé tant qu'il ne le rétablit pas (« __proto__ » compris).
      fs.writeFileSync(file, '{ "permission": { "edit": "ask" } }\n');
      assert.deepEqual(paths(await patch(JSON.stringify({ small_model: "github-copilot/gpt-5-mini" }))), ["enabled_providers"]);
      assert.deepEqual(paths(await patch('{"__proto__": {"enabled_providers": ["github-copilot"]}}')), ["enabled_providers"]);
      const bootstrap = JSON.parse((await call("GET", "/api/bootstrap", authed)).body);
      assert.deepEqual(bootstrap.security.providerIssues.map((i: { path: string }) => i.path), ["enabled_providers"]);

      // Paramètres : IA de classement et ancienne IA du chat.
      const classifier = await call("PUT", "/api/settings", mutating, JSON.stringify({ classifier: { model: "opencode/big-pickle" } }));
      assert.equal(classifier.status, 422, classifier.body);
      assert.deepEqual(JSON.parse(classifier.body).issues, [{ path: "classifier.model", message: "Seules les IA GitHub Copilot sont autorisées dans ce cockpit." }]);
      assert.deepEqual(paths(await call("PUT", "/api/settings", mutating, JSON.stringify({ chat: { defaultModel: "openai/gpt-5" } }))), ["chat.defaultModel"]);
      assert.equal(settings.get().classifier.model, null);
      assert.equal((await call("PUT", "/api/settings", mutating, JSON.stringify({ classifier: { model: "github-copilot/gpt-5-mini" } }))).status, 200);
      assert.equal(settings.get().classifier.model, "github-copilot/gpt-5-mini");
    } finally {
      settings.update({ ui: { mode: "simple" }, classifier: { model: null } });
      fs.rmSync(file, { force: true });
    }
  });

  it("Studio (avancé) : le niveau choisi est lié dans item_meta, suit un renommage, ignore la portée projet, disparaît avec l'élément", async () => {
    const meta = (name: string) => {
      const row = db.prepare("SELECT tier, origin, applied_model, applied_variant FROM item_meta WHERE kind = 'agents' AND name = ?").get(name);
      return row ? { ...row } : undefined;
    };
    const save = (name: string, body: unknown, query = "") => call("PUT", `/api/studio/agents/${name}${query}`, mutating, JSON.stringify(body));
    const frontmatter = { description: "Analyse un incident.", mode: "primary", model: "github-copilot/claude-opus-5", variant: "high" };
    settings.update({ ui: { mode: "avance" } });
    try {
      assert.equal((await save("analyse", { frontmatter, body: "x", tier: "expert" })).status, 200);
      assert.deepEqual(meta("analyse"), { tier: "expert", origin: "studio", applied_model: "github-copilot/claude-opus-5", applied_variant: "high" });
      const renamed = await save("analyse-incident", { frontmatter, body: "x", previousName: "analyse" });
      assert.equal(renamed.status, 200, renamed.body);
      assert.equal(meta("analyse"), undefined);
      assert.equal(meta("analyse-incident")?.tier, "expert");
      assert.equal((await save("projet", { frontmatter, body: "x", tier: "rapide" }, "?project=app")).status, 200);
      assert.equal(meta("projet"), undefined);
      assert.equal((await call("DELETE", "/api/studio/agents/analyse-incident", mutating)).status, 200);
      assert.equal(meta("analyse-incident"), undefined);

      // Ligne sans niveau (IA précise) : l'IA écrite depuis le Studio devient l'IA appliquée, sans champ tier.
      db.prepare(
        "INSERT INTO item_meta (kind, name, title, task_size, origin, tier, applied_model, applied_variant, created_at, updated_at) VALUES ('agents', 'precise', 'IA précise', 'M', 'assistant', NULL, 'github-copilot/claude-sonnet-5', NULL, ?, ?)",
      ).run(T, T);
      const precise = { ...frontmatter, model: "github-copilot/gpt-5-mini", variant: "low" };
      assert.equal((await save("precise", { frontmatter: precise, body: "x" })).status, 200);
      assert.deepEqual(meta("precise"), { tier: null, origin: "assistant", applied_model: "github-copilot/gpt-5-mini", applied_variant: "low" });
      // Ligne liée à un niveau : une modification sans champ tier ne change pas l'IA appliquée.
      assert.equal((await save("lie", { frontmatter, body: "x", tier: "expert" })).status, 200);
      assert.equal((await save("lie", { frontmatter: precise, body: "y" })).status, 200);
      assert.deepEqual(meta("lie"), { tier: "expert", origin: "studio", applied_model: "github-copilot/claude-opus-5", applied_variant: "high" });
      // Aucune ligne : aucune créée.
      assert.equal((await save("sans-ligne", { frontmatter: precise, body: "x" })).status, 200);
      assert.equal(meta("sans-ligne"), undefined);
    } finally {
      db.prepare("DELETE FROM item_meta WHERE kind = 'agents' AND name IN ('precise', 'lie')").run();
      settings.update({ ui: { mode: "simple" } });
    }
  });

  it("mode Simple : écritures risquées refusées ; niveaux d'IA limités aux fournisseurs autorisés", async () => {
    const events: string[] = [];
    const off = hub.subscribe((event) => {
      if (event.kind === "cockpit") events.push(event.type);
    });
    const tiersPatch = (candidate: string) => ({
      ai: {
        tiers: {
          rapide: { candidates: [candidate], variant: null },
          equilibre: { candidates: ["github-copilot/claude-sonnet-5"], variant: null },
          expert: { candidates: ["github-copilot/claude-opus-5"], variant: null },
        },
      },
    });
    try {
      const studio = await call("PUT", "/api/studio/agents/x", mutating, JSON.stringify({ frontmatter: { description: "x" }, body: "y" }));
      assert.equal(studio.status, 403);
      assert.equal(JSON.parse(studio.body).error, "mode-avance");
      assert.equal((await call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content: "{}" }))).status, 403);
      assert.equal((await call("PUT", "/api/settings", mutating, JSON.stringify({ budget: { monthlyUsd: 150 } }))).status, 200);
      assert.equal((await call("PUT", "/api/settings", mutating, JSON.stringify(tiersPatch("github-copilot/gpt-5-mini")))).status, 403);
      assert.equal((await call("POST", "/api/settings/reset", mutating, JSON.stringify({ section: "ai" }))).status, 403);
      assert.equal((await call("POST", "/api/settings/reset", mutating, JSON.stringify({ section: "budget" }))).status, 200);

      settings.update({ ui: { mode: "avance" } });
      const foreign = await call("PUT", "/api/settings", mutating, JSON.stringify(tiersPatch("openai/gpt-5")));
      assert.equal(foreign.status, 422);
      assert.deepEqual(JSON.parse(foreign.body).issues, [{ path: "ai.tiers.rapide.candidates.0", message: "Seules les IA GitHub Copilot sont autorisées dans ce cockpit." }]);
      assert.ok(!events.includes("ai.changed"));
      const ok = await call("PUT", "/api/settings", mutating, JSON.stringify(tiersPatch("github-copilot/gpt-5-mini")));
      assert.equal(ok.status, 200, ok.body);
      assert.ok(events.includes("ai.changed"));
      assert.equal((await call("POST", "/api/settings/reset", mutating, JSON.stringify({ section: "ai" }))).status, 200);
      assert.equal(settings.get().ai.tiers, null);
    } finally {
      off();
      settings.update({ ai: { tiers: null }, ui: { mode: "simple" } });
    }
  });

  // --- 1.0.0 : réponses aux demandes d'autorisation (« Toujours » jamais relayé, demandes orphelines) ---------------

  const permissionRequest = (id: string, sessionID: string, tool?: { messageID: string; callID: string }) => ({
    id,
    sessionID,
    permission: tool ? "task" : "read",
    patterns: tool ? ["analyste-changements"] : ["app/secret.env"],
    metadata: {},
    always: ["*"],
    ...(tool ? { tool } : {}),
  });
  /** Message d'assistant (GET /session/:id/message/:messageID) portant l'appel d'outil `callID` dans l'état `status`. */
  const toolMessage = (sessionID: string, messageID: string, callID: string, status: string, error?: unknown) => {
    const state =
      status === "error"
        ? { status, input: {}, error: "Tool execution aborted", metadata: { interrupted: true }, time: { start: T, end: T } }
        : { status, input: { subagent_type: "analyste-changements" }, time: { start: T } };
    const info = { id: messageID, sessionID, role: "assistant", time: { created: T }, ...(error === undefined ? {} : { error }) };
    return { info, parts: [{ id: `prt_${callID}`, sessionID, messageID, type: "tool", callID, tool: "task", state }] };
  };
  const ABORTED = { name: "MessageAbortedError", data: { message: "Aborted" } };
  const replyPermission = (requestId: string, body: unknown) =>
    call("POST", `/api/oc/permission/${requestId}/reply?directory=${APP}`, mutating, typeof body === "string" ? body : JSON.stringify(body));
  /** Attend une condition remplie en tâche de fond (nettoyage après un arrêt), 3 s au plus. */
  const waitFor = async (condition: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  };
  const resetPermissionFixtures = () => {
    ocPermissions = [];
    ocStatuses = {};
    ocChildren = {};
    ocMessages = {};
    ocStatusSequence = [];
    lookupDelayMs = 0;
    onAbort = null;
    permissionLookupFailure = null;
  };
  /** Requêtes reçues par le faux opencode depuis l'indice `from`, « MÉTHODE url », triées. */
  const upstreamSince = (from: number) => upstreamRequests.slice(from).map((r) => `${r.method} ${r.url}`).sort();
  const TOUJOURS_REFUSE =
    "« Toujours autoriser » est désactivé : opencode l'appliquerait à tous les assistants du projet, y compris ceux qui refusent cette action, jusqu'à son redémarrage.";
  const DEMANDE_EXPIREE = "Cette demande n'est plus active : la réponse a été arrêtée. Rien n'a été lancé.";

  it("« Toujours autoriser » n'est jamais relayé (403) ; tout autre corps que {reply: once|reject, message?} est refusé (400)", async () => {
    ocPermissions = [permissionRequest("per_toujours", "ses_perm")];
    ocStatuses = { ses_perm: { type: "busy" } };
    try {
      for (const body of [{ reply: "always" }, { reply: "ALWAYS" }, { reply: " Always " }, { reply: "always", message: "ok" }, '{"reply":"once","reply":"always"}']) {
        const res = await replyPermission("per_toujours", body);
        assert.equal(res.status, 403, res.body);
        assert.deepEqual(JSON.parse(res.body), { error: "toujours-refuse", message: TOUJOURS_REFUSE });
      }
      const invalid: unknown[] = [
        {},
        { reply: "Once" },
        { reply: "accept" },
        { reply: 1 },
        { reply: "once", always: ["*"] },
        { reply: "reject", message: 42 },
        { reply: "reject", message: "x".repeat(2_001) },
        [],
        "null",
        '"once"',
      ];
      for (const body of invalid) {
        const res = await replyPermission("per_toujours", body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} : ${res.body}`);
        assert.equal(JSON.parse(res.body).error, "reponse-invalide");
      }
      assert.equal((await replyPermission("per_toujours", "{reply")).status, 400);
      assert.equal(forwarded("/permission/per_toujours/").length, 0);
      assert.deepEqual(parsePermissionReply({ reply: "once" }), { ok: true, value: { reply: "once" } });
      assert.deepEqual(parsePermissionReply({ reply: "reject", message: "x".repeat(2_000) }), { ok: true, value: { reply: "reject", message: "x".repeat(2_000) } });
    } finally {
      resetPermissionFixtures();
    }
  });

  it("« Autoriser une fois » : relayé seulement si la demande est en attente et que sa conversation travaille, 409 sinon", async () => {
    ocPermissions = [permissionRequest("per_actif", "ses_actif"), permissionRequest("per_orpheline", "ses_arretee"), permissionRequest("per_retry", "ses_retry")];
    const retry = { type: "retry", attempt: 2, message: "limite atteinte", next: T };
    ocStatuses = { ses_actif: { type: "busy" }, ses_retry: retry, ses_arretee: { type: "idle" } };
    try {
      const before = upstreamRequests.length;
      const idle = await replyPermission("per_orpheline", { reply: "once" });
      assert.equal(idle.status, 409, idle.body);
      assert.deepEqual(JSON.parse(idle.body), { error: "demande-expiree", message: DEMANDE_EXPIREE });
      // Vérifications sur le même dossier que la demande entrante ; demande orpheline d'une conversation au repos : refusée
      // (« reject ») après une nouvelle lecture des états, pour qu'elle ne redevienne pas autorisable.
      assert.deepEqual(upstreamSince(before), [
        "GET /permission?directory=%2Fworkspace%2Fapp",
        "GET /session/status?directory=%2Fworkspace%2Fapp",
        "GET /session/status?directory=%2Fworkspace%2Fapp",
        "POST /permission/per_orpheline/reply?directory=%2Fworkspace%2Fapp",
      ]);
      // GET /session/status ne liste que les sessions qui ne sont pas au repos : une session absente est arrêtée.
      ocStatuses = { ses_actif: { type: "busy" }, ses_retry: retry };
      assert.equal((await replyPermission("per_orpheline", { reply: "once", message: "vas-y" })).status, 409);
      const unknown = await replyPermission("per_inconnue", { reply: "once" });
      assert.equal(unknown.status, 409, unknown.body);
      assert.deepEqual(JSON.parse(unknown.body), { error: "demande-expiree", message: DEMANDE_EXPIREE });
      assert.deepEqual(
        forwarded("/permission/per_orpheline/").map((r) => r.body),
        ['{"reply":"reject"}', '{"reply":"reject"}'],
      );
      assert.equal(forwarded("/permission/per_inconnue/").length, 0);

      // La conversation retravaille entre la vérification et le refus de l'orpheline : aucun refus (il toucherait la nouvelle réponse).
      ocStatusSequence = [{}, { ses_arretee: { type: "busy" } }];
      assert.equal((await replyPermission("per_orpheline", { reply: "once" })).status, 409);
      assert.equal(forwarded("/permission/per_orpheline/").length, 2);
      assert.equal(ocStatusSequence.length, 0);

      // Conversation au travail : relayé, corps réécrit tel que contrôlé (clé en double : la dernière, lue comme opencode).
      const busy = await replyPermission("per_actif", '{"reply":"always","reply":"once"}');
      assert.equal(busy.status, 204, busy.body);
      const sent = forwarded("/permission/per_actif/reply");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.body, '{"reply":"once"}');
      assert.match(sent[0]?.url ?? "", /directory=%2Fworkspace%2Fapp/);
      assert.equal((await replyPermission("per_retry", { reply: "once" })).status, 204);
      assert.equal(forwarded("/permission/per_retry/reply").length, 1);
    } finally {
      resetPermissionFixtures();
    }
  });

  it("« Refuser » est relayé avec sa consigne, même quand la vérification est impossible", async () => {
    // Vérifications impossibles : sans effet sur un refus, qui n'autorise rien et ferme la demande.
    permissionLookupFailure = "socket";
    try {
      const body = { reply: "reject", message: "Non : lis plutôt README.md" };
      const res = await replyPermission("per_refus", body);
      assert.equal(res.status, 204, res.body);
      assert.equal(forwarded("/permission/per_refus/reply").at(-1)?.body, JSON.stringify(body));
      assert.equal((await replyPermission("per_refus_bis", { reply: "reject" })).status, 204);
      assert.equal(forwarded("/permission/per_refus_bis/reply").at(-1)?.body, '{"reply":"reject"}');
      assert.ok(warnings.some((w) => w.includes("refus relayé sans vérification")));
      ocPermissions = [permissionRequest("per_refus_ter", "ses_refus", { messageID: "msg_refus", callID: "call_refus" })];
      ocStatuses = { ses_refus: { type: "busy" } };
      permissionLookupFailure = "message";
      assert.equal((await replyPermission("per_refus_ter", { reply: "reject" })).status, 204);
      assert.equal(forwarded("/permission/per_refus_ter/reply").length, 1);
    } finally {
      resetPermissionFixtures();
    }
  });

  it("« Refuser » une demande d'une réponse arrêtée pendant que la conversation retravaille : 409, rien relayé (opencode refuserait aussi la réponse en cours)", async () => {
    const stale = { messageID: "msg_arrete", callID: "call_arrete" };
    const live = { messageID: "msg_relance", callID: "call_relance" };
    ocPermissions = [
      permissionRequest("per_ancienne", "ses_relance", stale),
      permissionRequest("per_nouvelle", "ses_relance", live),
      permissionRequest("per_sans_outil", "ses_relance"),
      permissionRequest("per_repos", "ses_repos", { messageID: "msg_repos", callID: "call_repos" }),
    ];
    ocStatuses = { ses_relance: { type: "busy" } };
    ocMessages = {
      "ses_relance/msg_arrete": toolMessage("ses_relance", "msg_arrete", "call_arrete", "error", ABORTED),
      "ses_relance/msg_relance": toolMessage("ses_relance", "msg_relance", "call_relance", "running"),
      "ses_repos/msg_repos": toolMessage("ses_repos", "msg_repos", "call_repos", "error", ABORTED),
    };
    try {
      const before = upstreamRequests.length;
      const res = await replyPermission("per_ancienne", { reply: "reject", message: "non" });
      assert.equal(res.status, 409, res.body);
      assert.deepEqual(JSON.parse(res.body), {
        error: "demande-orpheline",
        message:
          "Cette demande vient d'une réponse arrêtée. La refuser maintenant refuserait aussi les demandes de la réponse en cours : rien n'a été envoyé, réessayez quand celle-ci sera terminée.",
      });
      assert.ok(upstreamSince(before).includes("GET /session/ses_relance/message/msg_arrete?directory=%2Fworkspace%2Fapp"));
      assert.equal(forwarded("/permission/per_ancienne/").length, 0);
      // Témoins : demande de l'appel en cours, demande sans appel d'outil, orpheline d'une conversation au repos : relayées.
      for (const id of ["per_nouvelle", "per_sans_outil", "per_repos"]) {
        assert.equal((await replyPermission(id, { reply: "reject" })).status, 204, id);
        assert.equal(forwarded(`/permission/${id}/reply`).at(-1)?.body, '{"reply":"reject"}');
      }
    } finally {
      resetPermissionFixtures();
    }
  });

  it("« Autoriser une fois » : conversation qui retravaille mais appel d'outil arrêté (erreur, interrompu, introuvable) : 409, rien relayé", async () => {
    const tool = { messageID: "msg_arrete", callID: "call_arrete" };
    ocPermissions = [permissionRequest("per_arretee", "ses_relance", tool)];
    // Nouveau message dans la même conversation : elle travaille de nouveau, la demande de la réponse arrêtée reste listée.
    ocStatuses = { ses_relance: { type: "busy" } };
    try {
      const stale: Array<[string, unknown]> = [
        ["partie interrompue, message arrêté", toolMessage("ses_relance", "msg_arrete", "call_arrete", "error", ABORTED)],
        ["partie en erreur", toolMessage("ses_relance", "msg_arrete", "call_arrete", "error")],
        ["message arrêté", toolMessage("ses_relance", "msg_arrete", "call_arrete", "running", ABORTED)],
        ["appel terminé", toolMessage("ses_relance", "msg_arrete", "call_arrete", "completed")],
        ["appel pas encore lancé", toolMessage("ses_relance", "msg_arrete", "call_arrete", "pending")],
        ["autre appel", toolMessage("ses_relance", "msg_arrete", "call_autre", "running")],
        ["message introuvable (404)", undefined],
      ];
      for (const [label, message] of stale) {
        ocMessages = message === undefined ? {} : { "ses_relance/msg_arrete": message };
        const before = upstreamRequests.length;
        const res = await replyPermission("per_arretee", { reply: "once" });
        assert.equal(res.status, 409, `${label} : ${res.body}`);
        assert.deepEqual(JSON.parse(res.body), { error: "demande-expiree", message: DEMANDE_EXPIREE });
        assert.deepEqual(upstreamSince(before), [
          "GET /permission?directory=%2Fworkspace%2Fapp",
          "GET /session/ses_relance/message/msg_arrete?directory=%2Fworkspace%2Fapp",
          "GET /session/status?directory=%2Fworkspace%2Fapp",
        ], label);
      }
      // Ni « once », ni refus : un « reject » refuserait aussi les demandes de la réponse en cours.
      assert.equal(forwarded("/permission/per_arretee/").length, 0);

      // Message illisible, appel d'outil illisible ou panne : 503, rien relayé.
      ocMessages = { "ses_relance/msg_arrete": [] };
      assert.equal((await replyPermission("per_arretee", { reply: "once" })).status, 503);
      ocMessages = { "ses_relance/msg_arrete": toolMessage("ses_relance", "msg_arrete", "call_arrete", "running") };
      permissionLookupFailure = "message";
      assert.equal((await replyPermission("per_arretee", { reply: "once" })).status, 503);
      permissionLookupFailure = null;
      ocPermissions = [{ ...permissionRequest("per_arretee", "ses_relance"), tool: { messageID: "../msg", callID: "call_arrete" } }];
      assert.equal((await replyPermission("per_arretee", { reply: "once" })).status, 503);
      assert.equal(forwarded("/permission/per_arretee/").length, 0);

      // Témoin : appel en cours dans un message sans erreur, relayé.
      ocPermissions = [permissionRequest("per_arretee", "ses_relance", tool)];
      const res = await replyPermission("per_arretee", { reply: "once" });
      assert.equal(res.status, 204, res.body);
      assert.deepEqual(forwarded("/permission/per_arretee/").map((r) => r.body), ['{"reply":"once"}']);
    } finally {
      resetPermissionFixtures();
    }
  });

  it("arrêt pendant la vérification d'un « once » : l'arrêt n'est relayé qu'après le « once », jamais entre la vérification et le relais", async () => {
    const tool = { messageID: "msg_course", callID: "call_course" };
    ocPermissions = [permissionRequest("per_course", "ses_course", tool)];
    ocStatuses = { ses_course: { type: "busy" } };
    ocMessages = { "ses_course/msg_course": toolMessage("ses_course", "msg_course", "call_course", "running") };
    // opencode lent : la vérification dure ; l'arrêt met la conversation au repos et l'appel en erreur, comme opencode.
    lookupDelayMs = 250;
    onAbort = (sessionId) => {
      if (sessionId !== "ses_course") return;
      ocStatuses = {};
      ocMessages = { "ses_course/msg_course": toolMessage("ses_course", "msg_course", "call_course", "error", ABORTED) };
    };
    try {
      const before = upstreamRequests.length;
      const once = replyPermission("per_course", { reply: "once" });
      assert.ok(await waitFor(() => upstreamRequests.slice(before).some((r) => r.url.startsWith("/session/status"))), "vérification commencée");
      const abort = call("POST", `/api/oc/session/ses_course/abort?directory=${APP}`, mutating, "{}");
      const [onceRes, abortRes] = await Promise.all([once, abort]);
      assert.equal(onceRes.status, 204, onceRes.body);
      assert.equal(abortRes.status, 204, abortRes.body);
      const posts = upstreamRequests.slice(before).filter((r) => r.method === "POST");
      const onceAt = posts.findIndex((r) => r.url.startsWith("/permission/per_course/reply") && r.body === '{"reply":"once"}');
      const abortAt = posts.findIndex((r) => r.url.startsWith("/session/ses_course/abort"));
      assert.ok(onceAt >= 0 && abortAt > onceAt, `ordre relayé : ${posts.map((r) => r.url).join(", ")}`);
      // Le nettoyage de l'arrêt voit ensuite la demande (le faux opencode la garde) et la refuse.
      assert.ok(await waitFor(() => forwarded("/permission/per_course/reply").some((r) => r.body === '{"reply":"reject"}')), "refus après l'arrêt");

      // Arrêt d'abord : un « once » envoyé pendant la liste du nettoyage attend son tour, puis voit la conversation arrêtée.
      ocStatuses = { ses_course: { type: "busy" } };
      ocMessages = { "ses_course/msg_course": toolMessage("ses_course", "msg_course", "call_course", "running") };
      const onceCount = forwarded("/permission/per_course/reply").filter((r) => r.body === '{"reply":"once"}').length;
      const abortFirst = await call("POST", `/api/oc/session/ses_course/abort?directory=${APP}`, mutating, "{}");
      assert.equal(abortFirst.status, 204, abortFirst.body);
      const late = await replyPermission("per_course", { reply: "once" });
      assert.equal(late.status, 409, late.body);
      assert.equal(forwarded("/permission/per_course/reply").filter((r) => r.body === '{"reply":"once"}').length, onceCount);
    } finally {
      resetPermissionFixtures();
    }
  });

  it("opencode injoignable ou réponse illisible pendant la vérification : 503, « Autoriser une fois » jamais relayé", async () => {
    ocPermissions = [permissionRequest("per_panne", "ses_panne")];
    ocStatuses = { ses_panne: { type: "busy" } };
    try {
      for (const failure of ["socket", "status"] as const) {
        permissionLookupFailure = failure;
        const res = await replyPermission("per_panne", { reply: "once" });
        assert.equal(res.status, 503, `${failure} : ${res.body}`);
        const data = JSON.parse(res.body);
        assert.equal(data.error, "verification-impossible");
        assert.match(data.message, /Rien n'a été envoyé/);
      }
      permissionLookupFailure = null;
      ocStatuses = [];
      assert.equal((await replyPermission("per_panne", { reply: "once" })).status, 503);
      assert.equal(forwarded("/permission/per_panne/").length, 0);
      assert.ok(warnings.some((w) => w.includes("demande d'autorisation non vérifiable")));
      // Témoin : opencode rétabli, la même demande est relayée.
      ocStatuses = { ses_panne: { type: "busy" } };
      assert.equal((await replyPermission("per_panne", { reply: "once" })).status, 204);
      assert.equal(forwarded("/permission/per_panne/").length, 1);
    } finally {
      resetPermissionFixtures();
    }
  });

  it("arrêt : refuse les demandes en attente de la conversation et de ses sous-agents, jamais celles d'une autre conversation", async () => {
    const tracker = new SessionTracker(db, {} as OpencodeClient);
    tracker.upsert(session("ses_stop"));
    tracker.upsert(session("ses_stop_enfant", "ses_stop"));
    tracker.upsert(session("ses_voisine"));
    // Sous-agent pas encore enregistré par le cockpit : connu d'opencode seulement (GET /session/:id/children).
    ocChildren = { ses_stop: [{ id: "ses_stop_enfant" }, { id: "ses_stop_nouveau" }] };
    // L'autre conversation en premier : si elle était visée, son refus partirait avant les autres.
    ocPermissions = [
      permissionRequest("per_voisine", "ses_voisine"),
      permissionRequest("per_stop", "ses_stop"),
      permissionRequest("per_stop_enfant", "ses_stop_enfant"),
      permissionRequest("per_stop_nouveau", "ses_stop_nouveau"),
    ];
    try {
      const res = await call("POST", `/api/oc/session/ses_stop/abort?directory=${APP}`, mutating, "{}");
      assert.equal(res.status, 204, res.body);
      const expected = ["per_stop", "per_stop_enfant", "per_stop_nouveau"];
      assert.ok(await waitFor(() => expected.every((id) => forwarded(`/permission/${id}/reply`).length === 1)), "refus envoyés après l'arrêt");
      for (const id of expected) {
        const [sent] = forwarded(`/permission/${id}/reply`);
        assert.equal(sent?.body, '{"reply":"reject"}');
        assert.match(sent?.url ?? "", /directory=%2Fworkspace%2Fapp/);
      }
      assert.equal(forwarded("/permission/per_voisine/").length, 0);
      assert.ok(upstreamRequests.some((r) => r.method === "GET" && r.url === "/session/ses_stop/children?directory=%2Fworkspace%2Fapp"));

      // États relus juste avant les refus : une conversation qui travaille de nouveau (nouveau message) est laissée de côté,
      // car opencode refuserait aussi toutes ses demandes en attente, dont celles de la nouvelle réponse.
      ocStatuses = { ses_stop: { type: "busy" } };
      assert.equal((await call("POST", `/api/oc/session/ses_stop/abort?directory=${APP}`, mutating, "{}")).status, 204);
      assert.ok(
        await waitFor(() => ["per_stop_enfant", "per_stop_nouveau"].every((id) => forwarded(`/permission/${id}/reply`).length === 2)),
        "refus des sous-agents au repos",
      );
      assert.equal(forwarded("/permission/per_stop/reply").length, 1);
      ocStatuses = {};

      // Nettoyage impossible (opencode ne répond plus) : l'arrêt garde la réponse d'opencode, l'échec est journalisé.
      permissionLookupFailure = "socket";
      const warned = warnings.length;
      const again = await call("POST", `/api/oc/session/ses_stop/abort?directory=${APP}`, mutating, "{}");
      assert.equal(again.status, 204, again.body);
      assert.ok(await waitFor(() => warnings.slice(warned).some((w) => w.includes("demandes d'autorisation en attente non vérifiées"))));
      assert.equal(forwarded("/permission/per_voisine/").length, 0);
    } finally {
      resetPermissionFixtures();
    }
  });

  // Dernier test de la série : la déconnexion révoque le cookie partagé par les tests précédents.
  it("déconnexion : le cookie et toutes ses copies sont révoqués, une nouvelle connexion en délivre un autre", async () => {
    assert.equal((await call("GET", "/api/settings", authed)).status, 200);
    assert.equal((await call("POST", "/api/logout", mutating, "{}")).status, 200);
    assert.equal((await call("GET", "/api/settings", authed)).status, 401);
    const login = await call("POST", "/api/login", { "x-cockpit-csrf": "1", "content-type": "application/json" }, JSON.stringify({ token }));
    assert.equal(login.status, 200, login.body);
    const fresh = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    assert.match(fresh, /^cockpit_session=\d+\.[A-Za-z0-9_-]{43}$/);
    assert.notEqual(fresh, cookie);
    assert.equal((await call("GET", "/api/settings", { cookie: fresh })).status, 200);
    assert.equal((await call("GET", "/api/settings", authed)).status, 401);
  });
});
