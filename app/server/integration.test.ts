// Tests d'intégration : registre des coûts sur SQLite réel, et sécurité HTTP sur un vrai serveur.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { ConfigWriteQueue } from "./config-queue.ts";
import type { ControlService, RestartResult } from "./control.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { createApp, forbiddenAttachment, forbiddenProxyBody, mergeConfigPatch, parsePermissionReply, PROXY_RULES, turnModelFromBody } from "./http.ts";
import { EventHub } from "./hub.ts";
import { csvCell, Ledger, monthBounds, monthKey } from "./ledger.ts";
import { createLogger, type Logger } from "./log.ts";
import type { SyncDueReason } from "./oc-copilot-config.ts";
import { OcLookup } from "./oc-lookup.ts";
import { type OcAssistantMessage, type OcSession, OpencodeClient, type OcUserMessage } from "./opencode.ts";
import type { EventProcessor } from "./processor.ts";
import { ForbiddenDirectoryError, ProjectsService } from "./projects.ts";
import { apiHostFor, type QuotaSync } from "./quota.ts";
import { sessionValue } from "./security.ts";
import { purposeOf, SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { MESSAGES, type Run } from "./shared/assistant-rules.ts";
import { isClassifierRoot } from "./shared/session-purpose.ts";
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
  it("1.1 (migration 4) : tables d'équipes et d'autonomie, IA et réflexion par appel, agent de session, usages equipe et controle", () => {
    const { db, ledger, sessions } = setup();
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('teams', 'team_runs', 'team_run_steps', 'team_run_events',
             'delegations', 'permission_waits', 'conversation_autonomy', 'autonomy_requests', 'autonomy_decisions') ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    assert.deepEqual(tables, [
      "autonomy_decisions",
      "autonomy_requests",
      "conversation_autonomy",
      "delegations",
      "permission_waits",
      "team_run_events",
      "team_run_steps",
      "team_runs",
      "teams",
    ]);
    // Étapes et événements disparaissent avec leur exécution.
    db.prepare("INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, created_at) VALUES ('run_1', 'Revue', '{}', 'x', 'ses_r', '/workspace', 'en-cours', 1)").run();
    db.prepare("INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, state) VALUES ('run_1', 'e1', 1, 0, 'Lecture', 'relire-script', 'en-cours')").run();
    db.prepare("INSERT INTO team_run_events (run_id, kind, par, at) VALUES ('run_1', 'lancement', 'vous', 1)").run();
    db.prepare("DELETE FROM team_runs WHERE id = 'run_1'").run();
    assert.equal((db.prepare("SELECT COUNT(*) n FROM team_run_steps").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM team_run_events").get() as { n: number }).n, 0);

    const root = sessions.upsert({ ...session("ses_m4"), agent: "build" });
    assert.equal(root.agent, "build");
    assert.equal(root.purpose, "chat");
    // Un événement sans agent ne l'efface pas.
    assert.equal(sessions.upsert(session("ses_m4")).agent, "build");
    const step = sessions.upsert({ ...session("ses_m4_etape", "ses_m4"), metadata: { cockpit: "equipe" } });
    const control = sessions.upsert({ ...session("ses_m4_controle", "ses_m4"), metadata: { cockpit: "controle" } });
    assert.equal(step.purpose, "equipe");
    assert.equal(control.purpose, "controle");
    // Hérité par une session enfant, jamais remis en « chat » par une mise à jour sans métadonnées.
    assert.equal(sessions.upsert(session("ses_m4_sous", "ses_m4_etape")).purpose, "equipe");
    assert.equal(sessions.upsert(session("ses_m4_etape", "ses_m4")).purpose, "equipe");

    ledger.recordAssistant({ ...assistant("msg_m4_a", "ses_m4", 0.5, 10, 5, "gpt-5.4-mini"), variant: "high" }, root);
    ledger.recordAssistant(assistant("msg_m4_b", "ses_m4_etape", 0.2, 10, 5), step);
    ledger.recordAssistant(assistant("msg_m4_c", "ses_m4_controle", 0.01, 10, 5), control);
    // Une mise à jour sans réflexion ne l'efface pas.
    ledger.recordAssistant(assistant("msg_m4_a", "ses_m4", 0.5, 10, 5, "gpt-5.4-mini"), root);
    const rows = db.prepare("SELECT message_id, variant, purpose FROM usage WHERE message_id LIKE 'msg_m4_%' ORDER BY message_id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { message_id: "msg_m4_a", variant: "high", purpose: "chat" },
        { message_id: "msg_m4_b", variant: null, purpose: "equipe" },
        { message_id: "msg_m4_c", variant: null, purpose: "controle" },
      ],
    );
  });

  it("1.1 : un message recopié pour une équipe borne la fenêtre de coût sans compter comme vraie demande", () => {
    const { db, ledger, sessions } = setup();
    const root = sessions.upsert(session("ses_kind"));
    const now = Date.now();
    const user = (id: string, created: number): OcUserMessage => ({
      id,
      sessionID: "ses_kind",
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "github-copilot", modelID: "claude-sonnet-5" },
    });
    const kindOf = (id: string) => (db.prepare("SELECT kind FROM prompts WHERE message_id = ?").get(id) as { kind: string }).kind;
    ledger.recordUser(user("msg_k_vraie", now - 10_000), root);
    ledger.recordAssistant({ ...assistant("msg_k_1", "ses_kind", 1, 10, 5), time: { created: now - 9_000, completed: now - 8_500 } }, root);
    // Annonce avant l'événement : cas réel, le message du cockpit arrive plus tard par le flux.
    ledger.markPromptKind("msg_k_equipe", "equipe-demande");
    ledger.recordUser(user("msg_k_equipe", now - 5_000), root);
    ledger.recordAssistant({ ...assistant("msg_k_2", "ses_kind", 7, 10, 5), time: { created: now - 4_000, completed: now - 3_000 } }, root);
    assert.equal(kindOf("msg_k_equipe"), "equipe-demande");
    const firstCost = (db.prepare("SELECT cost FROM usage WHERE message_id = 'msg_k_1'").get() as { cost: number }).cost;
    const estimate = ledger.estimate("github-copilot", "claude-sonnet-5", now);
    assert.equal(estimate.samples, 1);
    assert.equal(estimate.avgUsd, firstCost);
    // Résumé du mois : seule la vraie demande compte (mois de msg_k_vraie, stable même lancé dans les premières secondes d'un mois).
    const prompts = () => ledger.summary(monthKey(now - 10_000), now).prompts;
    assert.equal(prompts(), 1);
    // Annonce après l'enregistrement : appliquée tout de suite ; un nouvel événement ne la remet pas en « message ».
    ledger.markPromptKind("msg_k_vraie", "equipe-resultat");
    ledger.recordUser(user("msg_k_vraie", now - 10_000), root);
    assert.equal(kindOf("msg_k_vraie"), "equipe-resultat");
    assert.equal(ledger.estimate("github-copilot", "claude-sonnet-5", now).samples, 0);
    assert.equal(prompts(), 0);
  });

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

  it("classement (P12) : une conversation suivie n'est jamais reclassée par son titre, écrit par l'IA de titre d'opencode ; seul le titre exact « [cockpit] classement » d'une racine compte, à l'insertion ; usage forcé par le serveur et métadonnées du cockpit, si", () => {
    const { sessions } = setup();
    // Créée sans titre puis titrée par l'IA d'après le premier message (opencode session/prompt.ts, ensureTitle) : reste « chat ».
    sessions.upsert(session("ses_titree"));
    for (const title of ["[cockpit] Bouton Arrêter inopérant", "[cockpit] classement"]) {
      const row = sessions.upsert({ ...session("ses_titree"), title });
      assert.deepEqual([row.title, row.purpose, sessions.isHidden("ses_titree")], [title, "chat", false]);
    }
    // À l'insertion (rattrapage, session inconnue) : titre exact d'une racine seulement, jamais un préfixe ni un enfant.
    assert.equal(sessions.upsert({ ...session("ses_prefixe"), title: "[cockpit] Bouton Arrêter inopérant" }).purpose, "chat");
    assert.equal(sessions.upsert({ ...session("ses_casse"), title: "[cockpit] Classement" }).purpose, "chat");
    assert.equal(sessions.upsert({ ...session("ses_enfant", "ses_titree"), title: "[cockpit] classement" }).purpose, "chat");
    assert.equal(sessions.upsert({ ...session("ses_classement"), title: "[cockpit] classement" }).purpose, "classifier");
    assert.equal(purposeOf({ title: "[cockpit] classement complet" }, null), "chat");
    // Même règle pour le rattrapage (processor.ts) et la liste des conversations de l'interface (ChatPage.tsx).
    assert.deepEqual(
      [
        { title: "[cockpit] classement" },
        { title: "Classement", metadata: { cockpit: "classifier" } },
        { title: "[cockpit] Bouton Arrêter inopérant" },
        { title: "[cockpit] Classement" },
        { title: "[cockpit] classement", parentID: "ses_titree" },
        { title: "Classement", metadata: "classifier" },
      ].map(isClassifierRoot),
      [true, true, false, false, false, false],
    );
    // Session de classement créée par le serveur (classifier.ts), déjà enregistrée en « chat » par session.created : classement.
    sessions.upsert(session("ses_serveur"));
    assert.equal(sessions.upsert({ ...session("ses_serveur"), title: "[cockpit] classement" }, "classifier").purpose, "classifier");
    // Métadonnée posée par le serveur seul (le proxy la refuse) : classement, même pour une session déjà suivie.
    sessions.upsert(session("ses_meta"));
    assert.equal(sessions.upsert({ ...session("ses_meta"), metadata: { cockpit: "classifier" } }).purpose, "classifier");
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

  it("portée projet au nom %XX (opencode l'ouvrirait ailleurs) : refusée avant toute lecture ou écriture, sans requête à opencode", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-studio-pct-"));
    try {
      const workspace = path.join(tmp, "workspace");
      const trap = "st%2F..%2F..%2Fetc";
      const legit = "Remise 20%";
      const dir = path.join(workspace, trap);
      fs.mkdirSync(path.join(dir, ".opencode", "agents"), { recursive: true });
      fs.mkdirSync(path.join(dir, ".opencode", "skills", "fiche"), { recursive: true });
      fs.mkdirSync(path.join(workspace, legit));
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "consignes du projet");
      fs.writeFileSync(path.join(dir, ".opencode", "agents", "espion.md"), "---\ndescription: x\n---\ncorps\n");
      fs.writeFileSync(path.join(dir, ".opencode", "skills", "fiche", "SKILL.md"), "---\nname: fiche\ndescription: x\n---\ncorps\n");
      fs.writeFileSync(path.join(dir, ".opencode", "skills", "fiche", "notes.md"), "notes");
      /** Arborescence du dossier refusé, contenu des fichiers compris : rien ne doit y être écrit, modifié ni supprimé. */
      const snapshot = () =>
        fs
          .readdirSync(dir, { recursive: true, encoding: "utf8" })
          .sort()
          .map((rel) => (fs.statSync(path.join(dir, rel)).isFile() ? `${rel}=${fs.readFileSync(path.join(dir, rel), "utf8")}` : rel));
      const untouched = snapshot();
      const requests: string[] = [];
      const client = {
        request: async (method: string, route: string, options?: { directory?: string }) => {
          requests.push(`${method} ${route} ${options?.directory ?? "(aucun)"}`);
          return {};
        },
      } as unknown as OpencodeClient;
      const env = { opencodeConfigDir: path.join(tmp, "oc-config"), workspaceDir: workspace, opencodeWorkspaceDir: "/workspace", projectConfig: true } as AppEnv;
      const studio = new StudioService({ env, client, projects: new ProjectsService(env), control: {} as ControlService, log: createLogger("error") });
      const scope = { type: "project", project: trap } as const;
      const refused = (err: unknown) => err instanceof ForbiddenDirectoryError && err.message === "Nom de dossier non pris en charge (séquence %XX).";

      // Lectures : jamais servies.
      await assert.rejects(studio.getInstructions(scope), refused);
      await assert.rejects(studio.list("agents", scope), refused);
      await assert.rejects(studio.list("skills", scope), refused);
      await assert.rejects(studio.get("agents", "espion", scope), refused);
      await assert.rejects(studio.readSkillFile("fiche", "notes.md", scope), refused);
      // Écritures : refusées avant d'écrire.
      await assert.rejects(studio.saveInstructions(scope, "consignes remplacées"), refused);
      await assert.rejects(studio.save("agents", scope, { name: "nouvel-agent", frontmatter: { description: "x" }, body: "y" }), refused);
      await assert.rejects(studio.remove("agents", "espion", scope), refused);
      await assert.rejects(studio.writeSkillFile("fiche", "notes.md", "remplacé", scope), refused);
      await assert.rejects(studio.deleteSkillFile("fiche", "notes.md", scope), refused);
      assert.deepEqual(snapshot(), untouched);
      assert.deepEqual(requests, []);

      // Témoin : « % » isolé, qu'opencode ne décode pas. Écriture faite, puis libération de l'instance de ce dossier.
      await studio.saveInstructions({ type: "project", project: legit }, "consignes");
      assert.equal(fs.readFileSync(path.join(workspace, legit, "AGENTS.md"), "utf8"), "consignes");
      assert.deepEqual(requests, ["POST /global/dispose (aucun)", `POST /instance/dispose /workspace/${legit}`]);
      assert.deepEqual(await studio.getInstructions({ type: "project", project: legit }), { content: "consignes", exists: true });
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

/** Profil Prudent livré (docker/opencode/opencode.default.jsonc), web refusé depuis A31 c. */
const PRUDENT = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "deny", websearch: "deny" };

describe("serveur HTTP (sécurité et proxy)", () => {
  // Jeton de test public au format généré par install.ps1 (64 hexadécimaux) : preuve et ticket servis (1.0.5).
  const token = "5a".repeat(32);
  // Secret de session posé dans la base avant createApp (sinon un secret aléatoire y est créé au démarrage).
  const sessionSecret = "s".repeat(43);
  const cookie = `__Host-cockpit_session=${sessionValue(token, sessionSecret)}`;
  /** Demandes reçues par le faux opencode ; directoryHeader : en-tête x-opencode-directory reçu (jamais envoyé par le cockpit). */
  const upstreamRequests: Array<{ method: string; url: string; auth: string | undefined; body: string; directoryHeader?: string | string[] }> = [];
  const warnings: string[] = [];
  /** Lignes info et warn du journal, avec leurs champs : aucune valeur de configuration ne doit y partir. */
  const logLines: Array<{ level: "info" | "warn"; message: string; fields: Record<string, unknown> | undefined }> = [];
  let upstream: http.Server;
  let cockpit: ReturnType<typeof serve>;
  let port = 0;
  let tmp = "";
  /** Interrupteur : GET /agent répond 400 (configuration refusée par opencode). */
  let agentFails = false;
  /** Nombre de prochains GET /agent qui répondent 500 (panne passagère). */
  let agentTransientFailures = 0;
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
  /** Interrupteur : GET /session/status répond 500 pour ce dossier seulement (instance qui ne démarre pas, dossier disparu). */
  let statusFailDirectory: string | null = null;
  /** Interrupteur : GET /global/health répond 500 (opencode entièrement injoignable). */
  let healthFails = false;
  /** GET /global/config servi tel quel jusqu'au prochain redémarrage réussi (opencode 1.18.30 garde sa configuration en mémoire) ; undefined : fichiers relus. */
  let staleGlobalConfig: unknown;
  /** Faux ControlService : raisons des redémarrages demandés, résultats servis dans l'ordre (sinon restartResult), redémarrage déjà en cours. */
  const restarts: string[] = [];
  const RESTART_OK: RestartResult = { ok: true, durationMs: 0, message: "opencode a redémarré." };
  let restartResult = RESTART_OK;
  const restartQueue: Array<RestartResult | Error> = [];
  let restartingNow = false;
  /** File d'écriture de la configuration passée à createApp ; appels à la synchro de l'adresse Copilot, synchro en échec. */
  const configQueue = new ConfigWriteQueue();
  let copilotSyncCalls = 0;
  let copilotSyncFails = false;
  /**
   * Faux CopilotConfigSync, « synchro due » : adresse cible retenue (sinon jamais posée), indicateur, poses demandées (avec
   * l'indicateur d'application du cockpit au moment de la pose), synchro retenue jusqu'à la résolution de copilotSyncHold.
   */
  let copilotTarget = false;
  let copilotDue = false;
  const copilotMarks: Array<{ cause: string; applying: boolean }> = [];
  let copilotSyncHold: Promise<void> | null = null;
  /** Interrupteur : POST /global/dispose répond 500 (libération des instances en échec). */
  let disposeFails = false;
  /** Raison de « synchro due » servie par le faux CopilotConfigSync (motif du refus des demandes facturées). */
  let copilotDueReason: SyncDueReason = "verification";
  /** Interrupteur : PATCH /global/config répond 500 (écriture en erreur). */
  let patchConfigFails = false;
  /** « MÉTHODE chemin » relayé à opencode puis en délai dépassé côté cockpit (TimeoutError, comme AbortSignal.timeout). */
  let requestTimeout: string | null = null;
  /** Réponse de POST /session/:id/prompt_async retenue jusqu'à la résolution de cette promesse (demande facturée en vol). */
  let promptHold: Promise<void> | null = null;
  /** Ouvertures de la fenêtre de connexion GitHub du relais d'opencode (1.0.6) demandées par le proxy. */
  let loginOpens = 0;
  /** Demandes reçues par le faux opencode (« MÉTHODE chemin »), avec l'indicateur d'application du cockpit à la réception. */
  const applyingSeen: Array<[string, boolean]> = [];
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
        upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body, directoryHeader: req.headers["x-opencode-directory"] });
        const pathname = new URL(req.url ?? "/", "http://opencode.test").pathname;
        applyingSeen.push([`${req.method ?? ""} ${pathname}`, configQueue.applying]);
        const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
        if (pathname === "/global/health") {
          if (healthFails) json(500, { name: "UnknownError", data: { message: "santé simulée en échec" } });
          else json(200, { healthy: true, version: "test" });
        } else if (
          req.method === "GET" &&
          pathname === "/session/status" &&
          statusFailDirectory !== null &&
          new URL(req.url ?? "/", "http://opencode.test").searchParams.get("directory") === statusFailDirectory
        ) {
          json(500, { name: "UnknownError", data: { message: "instance du dossier simulée en échec" } });
        } else if (req.method === "GET" && pathname === "/agent") {
          // Fichier de configuration marqué : refusé, comme une configuration invalide relue au démarrage.
          const configFile = path.join(tmp, "opencode.jsonc");
          const refusedConfig = fs.existsSync(configFile) && fs.readFileSync(configFile, "utf8").includes("x-refuse-par-opencode");
          if (agentTransientFailures > 0) {
            agentTransientFailures--;
            json(500, { name: "UnknownError", data: { message: "panne passagère simulée" } });
          } else if (agentFails || refusedConfig) json(400, { name: "ConfigInvalidError", data: { path: "/oc-config/agents/x.md", issues: [] } });
          else json(200, FIXTURE_AGENTS);
        } else if (req.method === "GET" && pathname === "/command") {
          json(200, FIXTURE_COMMANDS);
        } else if (req.method === "GET" && pathname === "/config/providers") {
          json(200, FIXTURE_PROVIDERS);
        } else if (req.method === "GET" && pathname === "/skill") {
          json(200, FIXTURE_SKILLS);
        } else if (req.method === "GET" && pathname === "/global/config") {
          json(200, staleGlobalConfig === undefined ? globalConfig() : staleGlobalConfig);
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
        } else if (req.method === "PATCH" && pathname === "/global/config" && patchConfigFails) {
          json(500, { name: "UnknownError", data: { message: "écriture de la configuration simulée en échec" } });
        } else if (req.method === "POST" && pathname === "/global/dispose" && disposeFails) {
          json(500, { name: "UnknownError", data: { message: "libération des instances simulée en échec" } });
        } else if (req.method === "POST" && promptHold !== null && pathname.endsWith("/prompt_async")) {
          void promptHold.then(() => res.writeHead(204).end());
        } else if (req.method === "POST") {
          res.writeHead(204).end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end("[]");
        }
      });
    });
    await (await import("./test-support/helpers.ts")).listenFetchable(upstream, "127.0.0.1");
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
      autonomy: true,
      // Harnais en HTTP (1.0.5) : dossier TLS jamais créé ni lu.
      localScheme: "http",
      localHttpConfirmedAt: "2026-09-15T10:32:00Z",
      tlsDir: path.join(tmp, "tls"),
      opensslPath: "/usr/bin/openssl",
      version: "test",
      // Relais de sortie d'opencode désactivé (1.0.6) : aucune écoute de plus dans le harnais.
      relay: null,
    };
    const base = setup();
    db = base.db;
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', ?, ?)").run(sessionSecret, T);
    settings = base.settings;
    const client = new OpencodeClient(env);
    // Délai dépassé simulé : demande relayée et traitée par opencode, puis TimeoutError côté cockpit (comme AbortSignal.timeout).
    const request = client.request.bind(client);
    client.request = (async (method: string, pathname: string, options?: Parameters<OpencodeClient["request"]>[2]) => {
      const answer: unknown = await request(method, pathname, options);
      if (requestTimeout === `${method} ${pathname}`) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return answer;
    }) as OpencodeClient["request"];
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
    const log: Logger = {
      ...quiet,
      info: (message, fields) => void logLines.push({ level: "info", message, fields }),
      warn: (message, fields) => {
        warnings.push(message);
        logLines.push({ level: "warn", message, fields });
      },
    };
    hub = new EventHub();
    lookup = new OcLookup({ client, env, hub, log });
    const projects = new ProjectsService(env);
    // Studio réel pour les lectures et les instructions (AGENTS.md) : portée projet refusée avant tout accès (1.0.6).
    const realStudio = new StudioService({ env, client, projects, control: {} as ControlService, log });
    // Studio simulé : les écritures réelles sont couvertes par les tests du lot assistants.
    const studio = {
      list: realStudio.list.bind(realStudio),
      get: realStudio.get.bind(realStudio),
      getInstructions: realStudio.getInstructions.bind(realStudio),
      saveInstructions: realStudio.saveInstructions.bind(realStudio),
      readSkillFile: realStudio.readSkillFile.bind(realStudio),
      // Portée contrôlée avant la garde « réponse en cours » de la 1.1 (écritures du Studio) : règle réelle.
      checkScope: realStudio.checkScope.bind(realStudio),
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
      ensureClassifierAgent: async () => undefined,
    } as unknown as StudioService;
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
      control: {
        caFilesCount: async () => 0,
        supervisorPresent: async () => false,
        get restarting() {
          return restartingNow;
        },
        restartOpencode: async (reason: string) => {
          restarts.push(reason);
          const result = restartQueue.shift() ?? restartResult;
          if (result instanceof Error) throw result;
          // Un redémarrage réussi relit les fichiers de configuration.
          if (result.ok) staleGlobalConfig = undefined;
          return result;
        },
      } as unknown as ControlService,
      quota: { copilotConnected: async () => true, latest: () => null } as unknown as QuotaSync,
      processor: { status: { connected: true } } as unknown as EventProcessor,
      copilot: {
        status: { connected: false, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null },
        probeHosts: async () => [],
        resetDiscovery: () => undefined,
      },
      copilotConfig: {
        status: { state: "inactif", message: null, at: 0, details: { checked: [] } },
        get syncDue() {
          return copilotDue;
        },
        get dueReason() {
          return copilotDue ? copilotDueReason : null;
        },
        markDue: (cause: string) => {
          copilotMarks.push({ cause, applying: configQueue.applying });
          if (copilotTarget) copilotDue = true;
          return copilotTarget;
        },
        sync: async () => {
          copilotSyncCalls++;
          try {
            if (copilotSyncHold) await copilotSyncHold;
            if (copilotSyncFails) throw new Error("synchro de l'adresse Copilot en échec (simulée)");
            return { state: "inactif", message: null, at: 0, details: { checked: [] } };
          } finally {
            // Levée à la fin de la synchro, quel que soit son état, erreur comprise.
            copilotDue = false;
          }
        },
      },
      configQueue,
      // Harnais en HTTP : aucun certificat.
      tls: null,
      egressLogin: {
        open: () => {
          loginOpens++;
        },
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
  /** En-têtes Set-Cookie d'une réponse, un par cookie. */
  const setCookiesOf = (res: { headers: http.IncomingHttpHeaders }): string[] => res.headers["set-cookie"] ?? [];
  /** HMAC du jeton de test, recalculé ici sans le code du cockpit (préfixes du contrat 1.0.5). */
  const tokenMac = (usage: "health-proof" | "auth-ticket" | "auth-ticket-request", value: string) =>
    crypto.createHmac("sha256", token).update(`opencode-cockpit/${usage}/v1\n${value}`).digest("hex");
  /** Lien d'ouverture comme les scripts 1.0.5 : défi et demande de ticket signée, preuve du jeton vérifiée, ticket à usage unique signé. */
  const ticketLink = async (): Promise<string> => {
    const challenge = crypto.randomBytes(32).toString("hex");
    const health = await call("GET", `/api/health?challenge=${challenge}&ticket=${tokenMac("auth-ticket-request", challenge)}`);
    assert.equal(health.status, 200, health.body);
    const body = JSON.parse(health.body) as { scheme?: string; proof?: string | null; ticket?: string };
    assert.equal(body.scheme, env.localScheme);
    assert.equal(body.proof, tokenMac("health-proof", challenge));
    const ticket = body.ticket ?? "";
    assert.match(ticket, /^[0-9a-f]{64}$/);
    return `/auth?k=${ticket}.${tokenMac("auth-ticket", ticket)}`;
  };
  /** Aide de connexion du harnais : ticket puis /auth?k=, cookie de session rendu (nom=valeur). */
  const loginByTicket = async (headers: Record<string, string> = {}) => {
    const res = await call("GET", await ticketLink(), headers);
    return { ...res, cookie: (setCookiesOf(res)[0] ?? "").split(";")[0] ?? "" };
  };
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

  it("exige la session sur l'API ; le cookie à l'ancien nom seul ne suffit plus", async () => {
    assert.equal((await call("GET", "/api/settings")).status, 401);
    assert.equal((await call("GET", "/api/settings", authed)).status, 200);
    // Même valeur sous le nom des versions < 1.0.5 : refusée.
    assert.equal((await call("GET", "/api/settings", { cookie: cookie.slice("__Host-".length) })).status, 401);
    // Les deux noms présents : seul le nom préfixé est lu.
    assert.equal((await call("GET", "/api/settings", { cookie: `cockpit_session=faux; ${cookie}` })).status, 200);
  });

  it("ouvre une session avec un ticket valide seulement, cookie __Host- durci, ancien nom effacé, lien à usage unique", async () => {
    const bad = await call("GET", "/auth?k=mauvais");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, "/?auth=failed");
    assert.deepEqual(setCookiesOf(bad), []);
    // Lien d'une version antérieure : jamais comparé, aucun cookie, même avec le bon jeton.
    const legacy = await call("GET", `/auth?t=${token}`);
    assert.equal(legacy.status, 303);
    assert.equal(legacy.headers.location, "/?auth=ancien-lien");
    assert.deepEqual(setCookiesOf(legacy), []);
    const link = await ticketLink();
    const good = await call("GET", link);
    assert.equal(good.status, 303);
    assert.equal(good.headers.location, "/");
    const [session, legacyCleared, ...others] = setCookiesOf(good);
    assert.match(session ?? "", /^__Host-cockpit_session=\d+\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(legacyCleared, "cockpit_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
    assert.deepEqual(others, []);
    assert.ok(!String(good.headers["set-cookie"]).includes(token));
    const replay = await call("GET", link);
    assert.equal(replay.headers.location, "/?auth=failed");
    assert.deepEqual(setCookiesOf(replay), []);
  });

  it("bloque les requêtes modifiantes sans en-tête anti-CSRF ou d'une autre origine (origine au schéma servi seulement)", async () => {
    assert.equal(env.localScheme, "http");
    const put = (origin?: string) => call("PUT", "/api/settings", origin === undefined ? mutating : { ...mutating, origin }, "{}");
    assert.equal((await call("PUT", "/api/settings", { cookie, "content-type": "application/json" }, "{}")).status, 403);
    assert.equal((await put("http://evil.example")).status, 403);
    assert.equal((await put(`http://127.0.0.1:${port}`)).status, 200);
    // Même hôte, autre schéma que celui servi : refusé.
    assert.equal((await put(`https://127.0.0.1:${port}`)).status, 403);
    assert.equal((await put("null")).status, 403);
    assert.equal((await put()).status, 200);
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
      const res = await call("GET", "/auth?k=mauvais", { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" });
      assert.equal(res.status, 403);
    }
    const good = await loginByTicket({ "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(good.status, 303);
    assert.equal(good.headers.location, "/");
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
    fs.writeFileSync(
      file,
      '{\n  "enabled_providers": ["github-copilot"],\n  // commentaire conservé\n  "share": "disabled",\n  "permission": { "edit": "ask", "bash": { "*": "ask", "git branch*": "allow" } }\n}\n',
    );
    // 0.2.0 : écriture réservée au mode Avancé.
    settings.update({ ui: { mode: "avance" } });
    try {
      const permission = { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask" };
      const res = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission }));
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(JSON.parse(res.body), { ok: true, restarted: true });
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

  it("refuse un titre de conversation « [cockpit] … », réservé au classement du cockpit, à la création comme au renommage ; P12", async () => {
    const relayedTitles = () => upstreamRequests.filter((r) => r.body.includes("ockpit]")).length;
    const before = relayedTitles();
    for (const title of ["[cockpit] classement", "[cockpit] Bouton Arrêter inopérant", "  [Cockpit] notes"]) {
      const expected = forbiddenProxyBody("POST", "/session", { title }, null);
      assert.match(expected ?? "", /^Titre refusé : « \[cockpit\] » /);
      const created = await call("POST", "/api/oc/session", mutating, JSON.stringify({ title }));
      assert.equal(created.status, 403, created.body);
      assert.deepEqual(JSON.parse(created.body), { error: "forbidden-body", message: expected });
      const renamed = await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ title }));
      assert.equal(renamed.status, 403, renamed.body);
      assert.deepEqual(JSON.parse(renamed.body), { error: "forbidden-body", message: expected });
    }
    assert.equal(relayedTitles(), before, "aucun titre « [cockpit] » relayé");
    // Crochet ailleurs que tout au début : titre accepté.
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ title: "Revue du [cockpit]" }))).status, 204);
    assert.equal((await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ title: "Notes cockpit" }))).status, 200);
  });

  it("relais d'opencode (1.0.6) : github.com ouvert seulement par une demande de connexion Copilot acceptée", async () => {
    const before = loginOpens;
    const authorize = (inputs: Record<string, string>) =>
      call("POST", "/api/oc/provider/github-copilot/oauth/authorize", mutating, JSON.stringify({ method: 0, inputs }));
    // Connexion refusée (domaine GitHub Enterprise non déclaré) : la fenêtre reste fermée.
    assert.equal((await authorize({ deploymentType: "enterprise", enterpriseUrl: "github-login.example" })).status, 403);
    // Lectures et autres écritures relayées : jamais.
    assert.equal((await call("GET", "/api/oc/provider/auth", authed)).status, 200);
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ title: "x" }))).status, 204);
    assert.equal((await call("DELETE", "/api/oc/auth/github-copilot", mutating)).status, 200);
    assert.equal(loginOpens, before);
    // Demande du code puis attente de l'accord : ouverte (ou prolongée) à chaque fois.
    assert.equal((await authorize({ deploymentType: "github.com" })).status, 204);
    assert.equal(loginOpens, before + 1);
    assert.equal((await call("POST", "/api/oc/provider/github-copilot/oauth/callback", mutating, JSON.stringify({ method: 0 }))).status, 204);
    assert.equal(loginOpens, before + 2);
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

  it("dossier dont le nom contient %XX (opencode le décoderait une seconde fois) : 403 sans aucune requête vers opencode", async () => {
    // Nom créable par une IA, valide sous NTFS : opencode 1.18.30 ouvrirait son propre dossier de données (auth.json).
    const trap = "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode";
    const legit = "Remise 20%";
    fs.mkdirSync(path.join(tmp, trap));
    fs.mkdirSync(path.join(tmp, legit));
    try {
      const trapped = encodeURIComponent(`/workspace/${trap}`);
      const prompt = JSON.stringify({ model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: text("x") });
      const before = upstreamRequests.length;
      const refused = [
        await call("GET", `/api/oc/session?directory=${trapped}`, authed),
        await call("GET", `/api/oc/find/file?query=auth.json&directory=${trapped}`, authed),
        await call("POST", `/api/oc/session/ses_dd/prompt_async?directory=${trapped}`, confirmedHeaders, prompt),
        await call("POST", `/api/oc/session/ses_dd/prompt_async?directory=${encodeURIComponent("/workspace/app/sous%2f..%2f..%2f..%2fetc")}`, confirmedHeaders, prompt),
        await call("POST", "/api/chat/resolve", mutating, JSON.stringify({ directory: `/workspace/${trap}`, agent: "build" })),
      ];
      for (const res of refused) {
        assert.equal(res.status, 403, res.body);
        assert.equal(JSON.parse(res.body).error, "forbidden-directory", res.body);
      }
      assert.deepEqual(upstreamRequests.slice(before).map((r) => `${r.method} ${r.url}`), [], "aucune requête vers opencode");
      // Liste des projets : le nom piège n'est jamais proposé, le nom légitime l'est.
      const listed = JSON.parse((await call("GET", "/api/projects", authed)).body) as Array<{ name: string; directory: string }>;
      assert.equal(listed.some((p) => p.name === trap), false);
      assert.equal(listed.find((p) => p.name === legit)?.directory, `/workspace/${legit}`);
      // Nom légitime (« % » isolé, qu'opencode ne décode pas) : relayé tel quel.
      const session = await call("GET", `/api/oc/session?directory=${encodeURIComponent(`/workspace/${legit}`)}`, authed);
      assert.equal(session.status, 200, session.body);
      const relayed = upstreamRequests.at(-1);
      assert.equal(new URL(relayed?.url ?? "/", "http://opencode.test").searchParams.get("directory"), `/workspace/${legit}`);
      const resolved = await call("POST", "/api/chat/resolve", mutating, JSON.stringify({ directory: `/workspace/${legit}`, agent: "build" }));
      assert.equal(resolved.status, 200, resolved.body);
    } finally {
      fs.rmSync(path.join(tmp, trap), { recursive: true, force: true });
      fs.rmSync(path.join(tmp, legit), { recursive: true, force: true });
      lookup.invalidate();
    }
  });

  it("Studio, projet au nom %XX : 403 forbidden-directory comme le proxy, en lecture comme en écriture, sans fichier écrit ni requête vers opencode", async () => {
    const trap = "st%2F..%2F..%2Fetc";
    fs.mkdirSync(path.join(tmp, trap));
    fs.mkdirSync(path.join(tmp, "Remise 20%"));
    settings.update({ ui: { mode: "avance" } });
    try {
      const scope = `?project=${encodeURIComponent(trap)}`;
      const before = upstreamRequests.length;
      const refused = [
        await call("GET", `/api/studio/instructions${scope}`, authed),
        await call("PUT", `/api/studio/instructions${scope}`, mutating, JSON.stringify({ content: "consignes" })),
        await call("GET", `/api/studio/agents${scope}`, authed),
        await call("GET", `/api/studio/agents/espion${scope}`, authed),
        await call("GET", `/api/studio/skills/fiche/file${scope}&file=notes.md`, authed),
      ];
      for (const res of refused) {
        assert.equal(res.status, 403, res.body);
        assert.deepEqual(JSON.parse(res.body), { error: "forbidden-directory", message: "Nom de dossier non pris en charge (séquence %XX)." });
      }
      assert.deepEqual(fs.readdirSync(path.join(tmp, trap)), [], "aucun fichier écrit");
      assert.deepEqual(upstreamRequests.slice(before).map((r) => `${r.method} ${r.url}`), [], "aucune requête vers opencode");
      // Témoin : « % » isolé, qu'opencode ne décode pas, servi normalement.
      const legit = await call("GET", `/api/studio/instructions?project=${encodeURIComponent("Remise 20%")}`, authed);
      assert.equal(legit.status, 200, legit.body);
      assert.deepEqual(JSON.parse(legit.body), { content: "", exists: false });
    } finally {
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(path.join(tmp, trap), { recursive: true, force: true });
      fs.rmSync(path.join(tmp, "Remise 20%"), { recursive: true, force: true });
    }
  });

  it("Studio × garde « réponse en cours » (1.1 × 1.0.6) : écriture et suppression d'un élément d'un projet %XX refusées avant la garde, sans requête vers opencode", async () => {
    const trap = "st%2F..%2F..%2Fetc";
    fs.mkdirSync(path.join(tmp, trap));
    settings.update({ ui: { mode: "avance" } });
    try {
      const scope = `?project=${encodeURIComponent(trap)}`;
      const before = upstreamRequests.length;
      const refused = [
        await call("PUT", `/api/studio/agents/espion${scope}`, mutating, JSON.stringify({ frontmatter: { description: "x" }, body: "x" })),
        await call("DELETE", `/api/studio/agents/espion${scope}`, mutating),
      ];
      for (const res of refused) {
        assert.equal(res.status, 403, res.body);
        assert.deepEqual(JSON.parse(res.body), { error: "forbidden-directory", message: "Nom de dossier non pris en charge (séquence %XX)." });
      }
      assert.deepEqual(fs.readdirSync(path.join(tmp, trap)), [], "aucun fichier écrit");
      assert.deepEqual(upstreamRequests.slice(before).map((r) => `${r.method} ${r.url}`), [], "aucune requête vers opencode, garde comprise");
    } finally {
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(path.join(tmp, trap), { recursive: true, force: true });
    }
  });

  it("invariant : le cockpit n'envoie ni ne relaie jamais l'en-tête x-opencode-directory (opencode le lirait sans le paramètre directory)", async () => {
    const header = { "x-opencode-directory": "/home/node/.local/share/opencode" };
    const before = upstreamRequests.length;
    assert.equal((await call("GET", "/api/oc/session", { ...authed, ...header })).status, 200);
    assert.equal((await call("GET", `/api/oc/session?directory=${APP}`, { ...authed, ...header })).status, 200);
    assert.equal((await call("POST", "/api/oc/session", { ...mutating, ...header }, JSON.stringify({ title: "x" }))).status, 204);
    assert.equal((await call("POST", "/api/chat/resolve", { ...mutating, ...header }, JSON.stringify({ directory: "/workspace/app", agent: "build" }))).status, 200);
    assert.ok(upstreamRequests.length > before);
    // Toutes les demandes reçues par le faux opencode depuis le début du harnais, pas seulement celles de ce test.
    assert.deepEqual(upstreamRequests.filter((r) => r.directoryHeader !== undefined).map((r) => `${r.method} ${r.url}`), []);
    // Code du serveur et de l'interface : aucune mention de l'en-tête hors des tests. Outillage de test 1.1 (test-support/ : le faux
    // opencode lit l'en-tête comme opencode) écarté, comme dans la garde « une seule écoute » : retiré de l'image par app/Dockerfile.
    const appDir = path.join(import.meta.dirname, "..");
    const mentions = ["server", "web"].flatMap((dir) =>
      fs
        .readdirSync(path.join(appDir, dir), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".test.ts"))
        .filter((file) => !(dir === "server" && file.replaceAll("\\", "/").startsWith("test-support/")))
        .filter((file) => /x-opencode-directory/i.test(fs.readFileSync(path.join(appDir, dir, file), "utf8")))
        .map((file) => `${dir}/${file}`),
    );
    assert.deepEqual(mentions, []);
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
    fs.writeFileSync(file, '{\n  "enabled_providers": ["github-copilot"],\n  // commentaire conservé\n  "permission": { "edit": "allow", "bash": "allow" }\n}\n');
    try {
      const res = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(JSON.parse(res.body), { ok: true, permission: PRUDENT, restarted: true });
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
    fs.writeFileSync(
      file,
      '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" },\n  // doublon\n  "permission": { "edit": "allow", "bash": "allow", "task": "allow" }\n}\n',
    );
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

  it("configuration gardée en mémoire par opencode : appliquée par un redémarrage, jamais pendant une réponse, version précédente remise en cas d'échec", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const autonome = '{\n  "enabled_providers": ["github-copilot"],\n  // commentaire conservé\n  "permission": { "edit": "allow", "bash": "allow" }\n}\n';
    fs.writeFileSync(file, autonome);
    // opencode 1.18.30 ne relit pas une écriture directe du fichier (mesuré) : il sert l'ancienne configuration jusqu'au redémarrage.
    staleGlobalConfig = globalConfig();
    const from = restarts.length;
    try {
      // Réponse en cours ou redémarrage déjà lancé : rien d'écrit, aucun redémarrage.
      ocStatuses = { ses_actif: { type: "busy" } };
      const busy = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(busy.status, 409, busy.body);
      assert.equal(JSON.parse(busy.body).error, "sessions-busy");
      ocStatuses = {};
      restartingNow = true;
      const restarting = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(restarting.status, 409, restarting.body);
      assert.equal(JSON.parse(restarting.body).error, "redemarrage-en-cours");
      // Pendant un redémarrage, une demande facturée est refusée avant d'être relayée.
      const refusedPrompt = await prompt("ses_1", { parts: text("x") }, confirmedHeaders);
      assert.equal(refusedPrompt.status, 409, refusedPrompt.body);
      assert.equal(JSON.parse(refusedPrompt.body).error, "redemarrage-en-cours");
      restartingNow = false;
      assert.equal(fs.readFileSync(file, "utf8"), autonome);
      assert.equal(restarts.length, from);

      // Écrit, appliqué par un redémarrage, puis relu.
      const applied = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(applied.status, 200, applied.body);
      assert.deepEqual(JSON.parse(applied.body), { ok: true, permission: PRUDENT, restarted: true });
      assert.deepEqual(restarts.slice(from), ["application : profil Prudent"]);
      assert.match(fs.readFileSync(file, "utf8"), /commentaire conservé/);

      // Règles déjà appliquées : aucun redémarrage.
      const again = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.deepEqual(JSON.parse(again.body), { ok: true, permission: PRUDENT, restarted: false });
      assert.equal(restarts.length, from + 1);

      // Fichier modifié hors du cockpit, sans verrou « fournisseurs » : refusé (il serait appliqué tel quel), rien d'écrit.
      const prudentApplied = fs.readFileSync(file, "utf8");
      const unlocked = '{\n  "permission": { "edit": "allow" }\n}\n';
      fs.writeFileSync(file, unlocked);
      const locked = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(locked.status, 422, locked.body);
      assert.equal(JSON.parse(locked.body).error, "fournisseur-refuse");
      assert.equal(fs.readFileSync(file, "utf8"), unlocked);
      assert.equal(restarts.length, from + 1);
      fs.writeFileSync(file, prudentApplied);

      // opencode ne repart pas : version précédente remise dans le fichier.
      settings.update({ ui: { mode: "avance" } });
      const prudentFile = fs.readFileSync(file, "utf8");
      restartResult = { ok: false, durationMs: 120_000, message: "opencode ne répond pas après 2 minutes : consultez le journal.", failure: "delai-depasse" };
      const down = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "allow" } }));
      assert.equal(down.status, 503, down.body);
      assert.equal(JSON.parse(down.body).error, "redemarrage-echoue");
      assert.match(JSON.parse(down.body).message, /version précédente du fichier a été remise\. Redémarrez opencode depuis la page Diagnostic/);
      assert.equal(fs.readFileSync(file, "utf8"), prudentFile);

      // opencode s'arrête à chaque démarrage avec le nouveau fichier : refus, version précédente remise et relue.
      const beforeLoop = restarts.length;
      restartResult = RESTART_OK;
      // Le retour arrière relance opencode avec la version précédente : ce second redémarrage réussit.
      restartQueue.push({ ok: false, durationMs: 9_000, message: "opencode s'arrête à chaque démarrage : consultez le journal (page Diagnostic).", failure: "arrets-repetes" });
      const crashed = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "allow" } }));
      assert.equal(crashed.status, 422, crashed.body);
      assert.equal(JSON.parse(crashed.body).error, "rejected-by-opencode");
      assert.equal(JSON.parse(crashed.body).restarted, true);
      assert.deepEqual(restarts.slice(beforeLoop), ["application : permissions globales", "retour arrière : permissions globales"]);
      assert.equal(fs.readFileSync(file, "utf8"), prudentFile);

      // Exception pendant le redémarrage (dossier de contrôle non inscriptible…) : version précédente remise, 503.
      restartQueue.push(new Error("EACCES: permission denied, open '/control/restart-request'"));
      const thrown = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "allow" } }));
      assert.equal(thrown.status, 503, thrown.body);
      assert.equal(JSON.parse(thrown.body).error, "redemarrage-echoue");
      assert.equal(fs.readFileSync(file, "utf8"), prudentFile);

      // Fichier brut refusé au redémarrage : version précédente remise, relue par un second redémarrage.
      const beforeRaw = restarts.length;
      const refused = await call(
        "PUT",
        "/api/opencode/config/raw",
        mutating,
        JSON.stringify({ content: '{\n  "enabled_providers": ["github-copilot"],\n  "x-refuse-par-opencode": true\n}\n' }),
      );
      assert.equal(refused.status, 422, refused.body);
      assert.equal(JSON.parse(refused.body).error, "rejected-by-opencode");
      assert.equal(JSON.parse(refused.body).restarted, true);
      assert.deepEqual(restarts.slice(beforeRaw), ["application : fichier de configuration brut", "retour arrière : fichier de configuration brut"]);
      assert.equal(fs.readFileSync(file, "utf8"), prudentFile);

      // Fichier brut inchangé : rien à appliquer.
      const unchanged = await call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content: prudentFile }));
      assert.deepEqual(JSON.parse(unchanged.body), { ok: true, restarted: false });
      assert.equal(restarts.length, beforeRaw + 2);

      // Refusé, mais le redémarrage du retour arrière échoue : 503 qui le dit, jamais « restaurée » seul.
      restartQueue.push(RESTART_OK, { ok: false, durationMs: 120_000, message: "opencode ne répond pas après 2 minutes : consultez le journal.", failure: "delai-depasse" });
      const stuck = await call(
        "PUT",
        "/api/opencode/config/raw",
        mutating,
        JSON.stringify({ content: '{\n  "enabled_providers": ["github-copilot"],\n  "x-refuse-par-opencode": true\n}\n' }),
      );
      assert.equal(stuck.status, 503, stuck.body);
      assert.equal(JSON.parse(stuck.body).error, "redemarrage-echoue");
      assert.match(JSON.parse(stuck.body).message, /ne redémarre pas/);
      assert.equal(fs.readFileSync(file, "utf8"), prudentFile);

      // Panne passagère juste après le redémarrage : nouvel essai, rien n'est annulé.
      agentTransientFailures = 1;
      const transient = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "allow" } }));
      assert.equal(transient.status, 200, transient.body);
      assert.deepEqual(JSON.parse(transient.body), { ok: true, restarted: true });
      assert.equal(agentTransientFailures, 0);
      assert.deepEqual(parseJsonc(fs.readFileSync(file, "utf8")).permission, { edit: "allow" });
    } finally {
      agentTransientFailures = 0;
      ocStatuses = {};
      staleGlobalConfig = undefined;
      restartResult = RESTART_OK;
      restartQueue.length = 0;
      restartingNow = false;
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  it("garde « réponse en cours » : redémarrage, Studio et assistants refusés pendant une réponse, dérogation en mode Avancé seulement", async () => {
    ocStatuses = { ses_actif: { type: "busy" } };
    const before = restarts.length;
    try {
      const restart = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(restart.status, 409, restart.body);
      assert.deepEqual(JSON.parse(restart.body), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
      // Mode Simple : la confirmation ne force rien.
      assert.equal((await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}")).status, 409);
      const install = await call("POST", "/api/assistants/catalogue/analyser-incident/install", confirmedHeaders, "{}");
      assert.equal(install.status, 409, install.body);
      assert.equal((await call("DELETE", "/api/assistants/relire-script", confirmedHeaders)).status, 409);
      assert.equal(restarts.length, before);

      settings.update({ ui: { mode: "avance" } });
      const save = await call("PUT", "/api/studio/agents/essai-garde", mutating, JSON.stringify({ frontmatter: { description: "x", mode: "subagent" }, body: "x" }));
      assert.equal(save.status, 409, save.body);
      assert.equal(JSON.parse(save.body).override, true);
      assert.equal((await call("PUT", "/api/studio/instructions", mutating, JSON.stringify({ content: "x" }))).status, 409);
      assert.equal((await call("DELETE", "/api/studio/agents/essai-garde", mutating)).status, 409);
      // Lecture jamais gardée (routes des assistants non montées dans ce banc : 404, jamais 409) ; dérogation explicite en Avancé.
      assert.equal((await call("GET", "/api/assistants", authed)).status, 404);
      const forced = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(forced.status, 200, forced.body);
      assert.deepEqual(restarts.slice(before), ["demande depuis l'interface"]);

      // Redémarrage déjà lancé : refusé, même confirmé.
      restartingNow = true;
      const again = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(again.status, 409, again.body);
      assert.equal(JSON.parse(again.body).error, "redemarrage-en-cours");
      restartingNow = false;

      // Au repos : rien n'est refusé.
      ocStatuses = {};
      assert.equal((await call("POST", "/api/system/restart-opencode", mutating, "{}")).status, 200);
    } finally {
      ocStatuses = {};
      restartingNow = false;
      settings.update({ ui: { mode: "simple" } });
    }
  });

  it("garde « réponse en cours » : demande facturée en vol (pas encore visible dans /session/status) comptée comme une réponse ; la dérogation en mode Avancé reste dans la file avec « synchro due »", async () => {
    ocStatuses = {};
    const before = restarts.length;
    const calls = copilotSyncCalls;
    const marks = copilotMarks.length;
    const endBilled = configQueue.beginBilled();
    try {
      // Sonde des conversations au repos : seule la demande admise par le proxy est en cours.
      const restart = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(restart.status, 409, restart.body);
      assert.deepEqual(JSON.parse(restart.body), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
      assert.equal((await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}")).status, 409);
      assert.equal((await call("POST", "/api/assistants/catalogue/analyser-incident/install", confirmedHeaders, "{}")).status, 409);

      settings.update({ ui: { mode: "avance" } });
      const save = await call("PUT", "/api/studio/agents/essai-vol", mutating, JSON.stringify({ frontmatter: { description: "x", mode: "subagent" }, body: "x" }));
      assert.equal(save.status, 409, save.body);
      assert.equal(JSON.parse(save.body).override, true);
      assert.equal((await call("PUT", "/api/studio/instructions", mutating, JSON.stringify({ content: "x" }))).status, 409);
      assert.equal(restarts.length, before);
      assert.equal(copilotSyncCalls, calls);
      assert.deepEqual(copilotMarks.slice(marks), []);

      // Dérogation explicite en Avancé : la réponse peut être coupée, mais le redémarrage passe par la file (applying posé),
      // pose « synchro due » avant la libération d'applying et relance la synchro, comme sans dérogation.
      const forced = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(forced.status, 200, forced.body);
      assert.deepEqual(restarts.slice(before), ["demande depuis l'interface"]);
      assert.deepEqual(copilotMarks.slice(marks), [{ cause: "redémarrage d'opencode (page Diagnostic)", applying: true }]);
      assert.equal(copilotSyncCalls, calls + 1);
      assert.equal(configQueue.applying, false);
      assert.equal(configQueue.billedInFlight, 1);
    } finally {
      endBilled();
      settings.update({ ui: { mode: "simple" } });
    }
    assert.equal(configQueue.billedInFlight, 0);
  });

  it("garde « réponse en cours » : un dossier illisible alors qu'opencode répond compte comme une réponse en cours (Simple compris) ; seul opencode entièrement injoignable laisse passer le redémarrage", async () => {
    const LENT = "/workspace/lent";
    const now = Date.now();
    // Conversation récente dans un second dossier : la garde le sonde à part, et son instance ne répond pas.
    new SessionTracker(db, {} as OpencodeClient).upsert({ ...session("ses_lent"), directory: LENT, time: { created: now, updated: now } });
    ocStatuses = { ses_actif: { type: "busy" } };
    statusFailDirectory = LENT;
    const before = restarts.length;
    const calls = copilotSyncCalls;
    const marks = copilotMarks.length;
    const warned = warnings.length;
    try {
      // Réponse en cours dans le dossier par défaut, second dossier en échec : refus, jamais « aucune réponse en cours ».
      const from = upstreamRequests.length;
      const restart = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(restart.status, 409, restart.body);
      assert.deepEqual(JSON.parse(restart.body), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
      assert.ok(upstreamSince(from).includes(`GET /session/status?directory=${encodeURIComponent(LENT)}`), "second dossier sondé");
      // Mode Simple : la confirmation ne force rien.
      assert.equal((await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}")).status, 409);
      const install = await call("POST", "/api/assistants/catalogue/analyser-incident/install", confirmedHeaders, "{}");
      assert.equal(install.status, 409, install.body);

      // Aucune réponse lue en cours mais un dossier illisible : absence de réponse non prouvée, refus distinct (journalisé), jamais
      // « des réponses sont en cours ».
      ocStatuses = {};
      const oneUnreadable = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(oneUnreadable.status, 409, oneUnreadable.body);
      assert.deepEqual(JSON.parse(oneUnreadable.body), { error: "reponses-non-verifiables", message: MESSAGES.restartUnverifiable, override: true });
      assert.ok(warnings.slice(warned).some((w) => w.includes("absence de réponse en cours non prouvée")));
      // Aucun dossier lisible alors qu'opencode répond (/global/health) : même refus distinct.
      permissionLookupFailure = "status";
      const unreadable = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(unreadable.status, 409, unreadable.body);
      assert.deepEqual(JSON.parse(unreadable.body), { error: "reponses-non-verifiables", message: MESSAGES.restartUnverifiable, override: true });
      assert.ok(warnings.slice(warned).some((w) => w.includes("rechargement refusé")));
      assert.equal(restarts.length, before);
      assert.equal(copilotSyncCalls, calls);
      assert.deepEqual(copilotMarks.slice(marks), []);

      // Mode Avancé : Studio refusé sans en-tête (dérogation proposée), dérogation explicite dans la file avec « synchro due ».
      settings.update({ ui: { mode: "avance" } });
      const save = await call("PUT", "/api/studio/agents/essai-sonde", mutating, JSON.stringify({ frontmatter: { description: "x", mode: "subagent" }, body: "x" }));
      assert.equal(save.status, 409, save.body);
      assert.deepEqual(JSON.parse(save.body), { error: "reponses-non-verifiables", message: MESSAGES.reloadUnverifiable, override: true });
      assert.equal(restarts.length, before);
      const forced = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(forced.status, 200, forced.body);
      assert.deepEqual(restarts.slice(before), ["demande depuis l'interface"]);
      assert.deepEqual(copilotMarks.slice(marks), [{ cause: "redémarrage d'opencode (page Diagnostic)", applying: true }]);
      assert.equal(configQueue.applying, false);

      // opencode entièrement injoignable (santé en échec aussi) : aucune réponse à couper, le redémarrage passe, même en Simple.
      settings.update({ ui: { mode: "simple" } });
      healthFails = true;
      const unreachable = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(unreachable.status, 200, unreachable.body);
      assert.deepEqual(restarts.slice(before), ["demande depuis l'interface", "demande depuis l'interface"]);
      assert.ok(warnings.slice(warned).some((w) => w.includes("rechargement laissé passer")));
    } finally {
      statusFailDirectory = null;
      healthFails = false;
      permissionLookupFailure = null;
      ocStatuses = {};
      settings.update({ ui: { mode: "simple" } });
      db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = 'ses_lent'").run(Date.now());
    }
  });

  it("garde « réponse en cours » : occupation non vérifiable (opencode répond, conversations illisibles) : code et message vrais ; redémarrage d'opencode permis après confirmation même en Simple, jamais pendant une réponse lue ou une demande facturée en vol ; Studio et installation refusés avec le recours", async () => {
    const LENT = "/workspace/lent-2";
    const now = Date.now();
    new SessionTracker(db, {} as OpencodeClient).upsert({ ...session("ses_lent_2"), directory: LENT, time: { created: now, updated: now } });
    const before = restarts.length;
    const calls = copilotSyncCalls;
    const marks = copilotMarks.length;
    const warned = warnings.length;
    const unverifiable = (message: string, override: boolean) => ({ error: "reponses-non-verifiables", message, override });
    permissionLookupFailure = "status";
    try {
      // Mode Simple, aucun dossier lisible alors qu'opencode répond : le redémarrage (le remède) est refusé à chaque essai sans
      // confirmation, avec un message vrai qui propose de confirmer ; jamais « Des réponses sont en cours ».
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = await call("POST", "/api/system/restart-opencode", mutating, "{}");
        assert.equal(refused.status, 409, refused.body);
        assert.deepEqual(JSON.parse(refused.body), unverifiable(MESSAGES.restartUnverifiable, true));
      }
      assert.match(MESSAGES.restartUnverifiable, /^Impossible de vérifier s'il reste des réponses en cours/);
      assert.match(MESSAGES.reloadUnverifiable, /^Impossible de vérifier s'il reste des réponses en cours.*mode Avancé \(Paramètres › Affichage\)/);
      // Installation d'assistant : refus, même confirmée, avec le recours (mode Avancé).
      const install = await call("POST", "/api/assistants/catalogue/analyser-incident/install", confirmedHeaders, "{}");
      assert.equal(install.status, 409, install.body);
      assert.deepEqual(JSON.parse(install.body), unverifiable(MESSAGES.reloadUnverifiable, false));
      assert.equal(restarts.length, before);

      // Demande facturée en vol : réponse en cours, refus sessions-busy inchangé, confirmation sans effet en Simple.
      const endBilled = configQueue.beginBilled();
      try {
        const billed = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
        assert.equal(billed.status, 409, billed.body);
        assert.deepEqual(JSON.parse(billed.body), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
      } finally {
        endBilled();
      }
      // Réponse lue en cours dans le dossier par défaut, second dossier illisible : sessions-busy, confirmation sans effet.
      permissionLookupFailure = null;
      statusFailDirectory = LENT;
      ocStatuses = { ses_actif: { type: "busy" } };
      const read = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(read.status, 409, read.body);
      assert.deepEqual(JSON.parse(read.body), { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false });
      // Un dossier illisible, les autres au repos : même refus distinct.
      ocStatuses = {};
      const partial = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(partial.status, 409, partial.body);
      assert.deepEqual(JSON.parse(partial.body), unverifiable(MESSAGES.restartUnverifiable, true));
      assert.equal(restarts.length, before);
      assert.equal(copilotSyncCalls, calls);
      assert.deepEqual(copilotMarks.slice(marks), []);

      // Confirmé en mode Simple : redémarrage dans la file, « synchro due » posée avec applying, synchro relancée, journalisé.
      const confirmed = await call("POST", "/api/system/restart-opencode", confirmedHeaders, "{}");
      assert.equal(confirmed.status, 200, confirmed.body);
      assert.deepEqual(restarts.slice(before), ["demande depuis l'interface"]);
      assert.deepEqual(copilotMarks.slice(marks), [{ cause: "redémarrage d'opencode (page Diagnostic)", applying: true }]);
      assert.equal(copilotSyncCalls, calls + 1);
      assert.equal(configQueue.applying, false);
      assert.ok(warnings.slice(warned).some((w) => w.includes("redémarrage confirmé")));

      // Mode Avancé : Studio refusé sans en-tête avec le même code, dérogation proposée.
      settings.update({ ui: { mode: "avance" } });
      const save = await call("PUT", "/api/studio/agents/essai-non-verifiable", mutating, JSON.stringify({ frontmatter: { description: "x", mode: "subagent" }, body: "x" }));
      assert.equal(save.status, 409, save.body);
      assert.deepEqual(JSON.parse(save.body), unverifiable(MESSAGES.reloadUnverifiable, true));
      assert.equal(restarts.length, before + 1);
    } finally {
      permissionLookupFailure = null;
      statusFailDirectory = null;
      ocStatuses = {};
      settings.update({ ui: { mode: "simple" } });
      db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = 'ses_lent_2'").run(Date.now());
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

  it("application de configuration en cours dans la file partagée : demande facturée refusée avant d'être relayée", async () => {
    let release!: () => void;
    const holding = configQueue.applyingWhile(() => new Promise<void>((resolve) => (release = resolve)));
    const relayed = forwarded("/prompt_async").length;
    try {
      const refused = await prompt("ses_1", { parts: text("x") }, confirmedHeaders);
      assert.equal(refused.status, 409, refused.body);
      assert.equal(JSON.parse(refused.body).error, "redemarrage-en-cours");
      assert.equal(forwarded("/prompt_async").length, relayed);
    } finally {
      release();
      await holding;
    }
    assert.equal(configQueue.applying, false);
  });

  it("redémarrage d'opencode depuis Diagnostic : adresse Copilot resynchronisée après un redémarrage réussi seulement", async () => {
    const calls = copilotSyncCalls;
    const from = restarts.length;
    const ok = await call("POST", "/api/system/restart-opencode", mutating, "{}");
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(restarts.slice(from), ["demande depuis l'interface"]);
    assert.equal(copilotSyncCalls, calls + 1);
    // Synchro en échec : avalée par la route, le redémarrage reste un succès.
    copilotSyncFails = true;
    try {
      const swallowed = await call("POST", "/api/system/restart-opencode", mutating, "{}");
      assert.equal(swallowed.status, 200, swallowed.body);
      assert.equal(JSON.parse(swallowed.body).ok, true);
      assert.equal(copilotSyncCalls, calls + 2);
    } finally {
      copilotSyncFails = false;
    }
    // Redémarrage en échec : aucune synchro.
    restartQueue.push({ ok: false, durationMs: 0, message: "opencode ne répond pas après 2 minutes : consultez le journal.", failure: "delai-depasse" });
    const failed = await call("POST", "/api/system/restart-opencode", mutating, "{}");
    assert.equal(failed.status, 503, failed.body);
    assert.equal(copilotSyncCalls, calls + 2);
  });

  it("demande facturée admise : comptée en vol jusqu'à la réponse d'opencode (refus avant relais compris) ; une application qui commence d'ici là attend", async () => {
    let open!: () => void;
    promptHold = new Promise<void>((resolve) => (open = resolve));
    settings.update({ ui: { mode: "avance" } });
    const body = { agent: "build", model: ref("gpt-5-mini"), parts: text("x") };
    const patchCount = () => upstreamRequests.filter((r) => r.method === "PATCH").length;
    const patches = patchCount();
    const file = path.join(tmp, "opencode.jsonc");
    try {
      const pending = prompt("ses_vol", body, confirmedHeaders);
      assert.ok(await waitFor(() => forwarded("/session/ses_vol/prompt_async").length === 1), "demande relayée à opencode");
      assert.equal(configQueue.billedInFlight, 1);
      // Application qui commence pendant la réponse, sonde des conversations au repos : refusée, rien d'écrit.
      const refused = await call("PATCH", "/api/opencode/config", mutating, JSON.stringify({ small_model: "github-copilot/gpt-5-mini" }));
      assert.equal(refused.status, 409, refused.body);
      assert.equal(JSON.parse(refused.body).error, "sessions-busy");
      assert.equal(patchCount(), patches);
      // Fichier brut et permissions (redémarrage) : même garde, rien d'écrit, aucun redémarrage, aucune synchro.
      const base = '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" }\n}\n';
      fs.writeFileSync(file, base);
      const restartsBefore = restarts.length;
      const syncsBefore = copilotSyncCalls;
      const raw = await call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content: base.replace('"ask"', '"allow"') }));
      assert.equal(raw.status, 409, raw.body);
      assert.equal(JSON.parse(raw.body).error, "sessions-busy");
      const permission = await call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "allow" } }));
      assert.equal(permission.status, 409, permission.body);
      assert.equal(JSON.parse(permission.body).error, "sessions-busy");
      assert.equal(restarts.length, restartsBefore);
      assert.equal(fs.readFileSync(file, "utf8"), base);
      assert.equal(copilotSyncCalls, syncsBefore);
      assert.equal(configQueue.billedInFlight, 1);
      open();
      assert.equal((await pending).status, 204);
      assert.equal(configQueue.billedInFlight, 0);
      // Refusée avant le relais (dossier hors du workspace) : retirée aussitôt.
      const outside = await call("POST", `/api/oc/session/ses_vol/prompt_async?directory=${encodeURIComponent("/etc")}`, confirmedHeaders, JSON.stringify(body));
      assert.equal(outside.status, 403, outside.body);
      assert.equal(configQueue.billedInFlight, 0);
    } finally {
      open();
      promptHold = null;
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  it("correctif de configuration (mode Avancé) : dans la file partagée, jamais pendant une réponse, libération en échec signalée (503), adresse Copilot resynchronisée", async () => {
    const patchCount = () => upstreamRequests.filter((r) => r.method === "PATCH" && r.url.startsWith("/global/config")).length;
    const disposeCount = () => upstreamRequests.filter((r) => r.method === "POST" && r.url.startsWith("/global/dispose")).length;
    // Valeurs repérables : jamais dans le journal (seules les clés de premier niveau y figurent).
    const body = JSON.stringify({ small_model: "github-copilot/gpt-5-mini", instructions: ["consignes-confidentielles.md"] });
    const patch = () => call("PATCH", "/api/opencode/config", mutating, body);
    const routeLines = (from: number) => logLines.slice(from).filter((l) => l.message.includes("(mode Avancé)"));
    const noValues = (lines: typeof logLines) => {
      for (const line of lines) assert.doesNotMatch(JSON.stringify(line), /gpt-5-mini|consignes-confidentielles/, line.message);
    };
    settings.update({ ui: { mode: "avance" } });
    const calls = copilotSyncCalls;
    try {
      // Application en cours dans la file : le correctif attend son tour, rien n'est relu ni écrit d'ici là.
      let finish!: () => void;
      const holding = configQueue.run(() => new Promise<void>((resolve) => (finish = resolve)));
      const from = upstreamRequests.length;
      const seenFrom = applyingSeen.length;
      const logFrom = logLines.length;
      const queued = patch();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(upstreamRequests.slice(from).filter((r) => r.url.startsWith("/global/")), []);
      finish();
      await holding;
      const ok = await queued;
      assert.equal(ok.status, 200, ok.body);
      // Journal : une ligne info après l'écriture et la libération, clés de premier niveau seulement.
      assert.deepEqual(routeLines(logFrom), [
        { level: "info", message: "configuration d'opencode corrigée (mode Avancé) : écrite, instances libérées", fields: { keys: ["instructions", "small_model"] } },
      ]);
      // PATCH et libération pendant l'application : les demandes facturées sont refusées d'ici là.
      const writes = applyingSeen.slice(seenFrom).filter(([route]) => route === "PATCH /global/config" || route === "POST /global/dispose");
      assert.deepEqual(writes, [
        ["PATCH /global/config", true],
        ["POST /global/dispose", true],
      ]);
      assert.equal(configQueue.applying, false);
      assert.equal(copilotSyncCalls, calls + 1);
      const written = patchCount();

      // Réponse en cours (sonde des conversations) : 409 avec le message adapté, rien d'écrit, aucune synchro.
      ocStatuses = { ses_actif: { type: "busy" } };
      const busy = await patch();
      assert.equal(busy.status, 409, busy.body);
      assert.deepEqual(JSON.parse(busy.body), {
        error: "sessions-busy",
        message: "Des réponses sont en cours : ce changement recharge ou redémarre opencode et les couperait. Attendez qu'elles se terminent.",
      });
      ocStatuses = {};
      // Demande facturée admise juste avant (en vol) : 409 aussi.
      const endBilled = configQueue.beginBilled();
      try {
        const inFlight = await patch();
        assert.equal(inFlight.status, 409, inFlight.body);
        assert.equal(JSON.parse(inFlight.body).error, "sessions-busy");
      } finally {
        endBilled();
      }
      assert.equal(patchCount(), written);
      assert.equal(copilotSyncCalls, calls + 1);
      const disposes = disposeCount();

      // Redémarrage déjà en cours : 409 avant toute lecture, rien d'écrit ni libéré, aucune synchro.
      restartingNow = true;
      try {
        const from = upstreamRequests.length;
        const restarting = await patch();
        assert.equal(restarting.status, 409, restarting.body);
        assert.deepEqual(JSON.parse(restarting.body), { error: "redemarrage-en-cours", message: "opencode redémarre déjà : réessayez dans une minute." });
        assert.deepEqual(upstreamSince(from).filter((r) => r.includes("/global/") || r.includes("/session/status")), []);
      } finally {
        restartingNow = false;
      }
      // Redémarrage lancé pendant la sonde des conversations : 409 après la sonde, rien d'écrit ni libéré.
      lookupDelayMs = 150;
      try {
        const from = upstreamRequests.length;
        const pending = patch();
        assert.ok(await waitFor(() => upstreamRequests.slice(from).some((r) => r.url.startsWith("/session/status"))), "sonde commencée");
        restartingNow = true;
        const late = await pending;
        assert.equal(late.status, 409, late.body);
        assert.equal(JSON.parse(late.body).error, "redemarrage-en-cours");
      } finally {
        restartingNow = false;
        lookupDelayMs = 0;
      }
      assert.equal(configQueue.applying, false);
      // Sonde des conversations en échec : 503 opencode injoignable (warn sans valeur), rien d'écrit ni libéré, applying levé.
      permissionLookupFailure = "status";
      const unreachableFrom = logLines.length;
      try {
        const unreachable = await patch();
        assert.equal(unreachable.status, 503, unreachable.body);
        assert.equal(JSON.parse(unreachable.body).error, "opencode-injoignable");
      } finally {
        permissionLookupFailure = null;
      }
      assert.deepEqual(
        routeLines(unreachableFrom).map((l) => [l.level, l.message, l.fields?.keys, l.fields?.error]),
        [["warn", "configuration d'opencode non corrigée (mode Avancé) : opencode injoignable", ["instructions", "small_model"], "opencode-injoignable"]],
      );
      assert.equal(configQueue.applying, false);
      assert.equal(patchCount(), written);
      assert.equal(disposeCount(), disposes);
      assert.equal(copilotSyncCalls, calls + 1);

      // Libération des instances en échec : 503 qui le dit (plus avalée), configuration écrite, synchro relancée.
      disposeFails = true;
      const failedFrom = logLines.length;
      const failed = await patch();
      assert.equal(failed.status, 503, failed.body);
      assert.equal(JSON.parse(failed.body).error, "liberation-echouee");
      assert.match(JSON.parse(failed.body).message, /^Configuration écrite, mais opencode n'a pas libéré ses instances \(.+\) : .*Redémarrez opencode depuis la page Diagnostic\.$/);
      assert.equal(patchCount(), written + 1);
      assert.equal(copilotSyncCalls, calls + 2);
      assert.equal(configQueue.applying, false);
      const failedLines = routeLines(failedFrom);
      assert.deepEqual(
        failedLines.map((l) => [l.level, l.message, l.fields?.keys, l.fields?.error]),
        [["warn", "configuration d'opencode corrigée (mode Avancé) : écrite, mais instances non libérées", ["instructions", "small_model"], "liberation-echouee"]],
      );
      assert.match(String(failedLines[0]?.fields?.cause), /libération des instances simulée en échec|500/);
      noValues(routeLines(0));
    } finally {
      disposeFails = false;
      ocStatuses = {};
      restartingNow = false;
      lookupDelayMs = 0;
      permissionLookupFailure = null;
      settings.update({ ui: { mode: "simple" } });
    }
  });

  it("fichier brut, permissions et profil Prudent : adresse Copilot resynchronisée après la tâche de la file dès qu'opencode a redémarré, jamais sans redémarrage", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const base = '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" }\n}\n';
    const raw = (content: string) => call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content }));
    const permission = (value: Record<string, unknown>) => call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: value }));
    fs.writeFileSync(file, base);
    settings.update({ ui: { mode: "avance" } });
    const calls = copilotSyncCalls;
    try {
      // Fichier inchangé : rien d'appliqué, aucune synchro.
      assert.deepEqual(JSON.parse((await raw(base)).body), { ok: true, restarted: false });
      assert.equal(copilotSyncCalls, calls);
      // Adresse vidée à la main dans le fichier brut (répétition S9) : opencode redémarre dessus, la synchro la rétablira.
      const cleared = '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" },\n  "provider": { "github-copilot": { "options": { "baseURL": "" } } }\n}\n';
      const applied = await raw(cleared);
      assert.equal(applied.status, 200, applied.body);
      assert.deepEqual(JSON.parse(applied.body), { ok: true, restarted: true });
      assert.equal(copilotSyncCalls, calls + 1);
      assert.equal(configQueue.applying, false);
      // Permissions puis profil Prudent, appliqués par un redémarrage.
      const allowed = await permission({ edit: "allow" });
      assert.equal(allowed.status, 200, allowed.body);
      assert.deepEqual(JSON.parse(allowed.body), { ok: true, restarted: true });
      assert.equal(copilotSyncCalls, calls + 2);
      const prudent = await call("POST", "/api/security/restore-prudent", mutating, "{}");
      assert.equal(prudent.status, 200, prudent.body);
      assert.equal(JSON.parse(prudent.body).restarted, true);
      assert.equal(copilotSyncCalls, calls + 3);
      // Règles déjà appliquées : aucun redémarrage, aucune synchro.
      assert.equal(JSON.parse((await call("POST", "/api/security/restore-prudent", mutating, "{}")).body).restarted, false);
      assert.equal(copilotSyncCalls, calls + 3);
      // Refusé au redémarrage : retour arrière par un second redémarrage, synchro relancée quand même.
      const refused = await raw('{\n  "enabled_providers": ["github-copilot"],\n  "x-refuse-par-opencode": true\n}\n');
      assert.equal(refused.status, 422, refused.body);
      assert.equal(JSON.parse(refused.body).restarted, true);
      assert.equal(copilotSyncCalls, calls + 4);
      // Synchro en échec : avalée, la réponse reste celle de l'application.
      copilotSyncFails = true;
      const swallowed = await permission({ edit: "deny" });
      assert.equal(swallowed.status, 200, swallowed.body);
      assert.equal(copilotSyncCalls, calls + 5);
      copilotSyncFails = false;
      // opencode ne repart pas (fichier remis, aucun redémarrage abouti) : aucune synchro.
      restartResult = { ok: false, durationMs: 120_000, message: "opencode ne répond pas après 2 minutes : consultez le journal.", failure: "delai-depasse" };
      const down = await permission({ edit: "ask" });
      assert.equal(down.status, 503, down.body);
      assert.equal(copilotSyncCalls, calls + 5);
    } finally {
      copilotSyncFails = false;
      restartResult = RESTART_OK;
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  it("« synchro due » : posée par chaque route qui écrit la configuration ou redémarre opencode, avant la libération d'applying ; demande facturée refusée dès la réponse, admise après la synchro ; jamais sans écriture ni redémarrage", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const base = '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" }\n}\n';
    const body = { agent: "build", model: ref("gpt-5-mini"), parts: text("x") };
    const relayed = () => forwarded("/session/ses_due/prompt_async").length;
    const raw = (content: string) => call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content }));
    const advancedPatch = () => call("PATCH", "/api/opencode/config", mutating, JSON.stringify({ small_model: "github-copilot/gpt-5-mini" }));
    const restart = () => call("POST", "/api/system/restart-opencode", mutating, "{}");
    type Res = { status: number; body: string };

    /**
     * Synchro relancée retenue : l'indicateur est posé une fois, pendant l'application ; une demande facturée envoyée dès la
     * réponse (ou dès la fin de la tâche pour la route qui attend la synchro) est refusée sans être relayée, puis admise une fois
     * la synchro finie.
     */
    const posted = async (label: string, send: () => Promise<Res>, expected: number, awaitsSync = false) => {
      let open!: () => void;
      copilotSyncHold = new Promise<void>((resolve) => (open = resolve));
      const marks = copilotMarks.length;
      const calls = copilotSyncCalls;
      const sent = relayed();
      try {
        const pending = send();
        if (awaitsSync) assert.ok(await waitFor(() => copilotSyncCalls > calls), `${label} : synchro lancée`);
        else {
          const res = await pending;
          assert.equal(res.status, expected, `${label} : ${res.body}`);
        }
        assert.equal(configQueue.applying, false, label);
        assert.deepEqual(
          copilotMarks.slice(marks).map((m) => m.applying),
          [true],
          label,
        );
        const refused = await prompt("ses_due", body, confirmedHeaders);
        assert.equal(refused.status, 409, `${label} : ${refused.body}`);
        assert.deepEqual(JSON.parse(refused.body), {
          error: "redemarrage-en-cours",
          message:
            "opencode vient de redémarrer ou de recharger sa configuration : l'adresse de l'API Copilot est en cours de vérification. Réessayez dans quelques secondes.",
        });
        assert.equal(relayed(), sent, label);
        assert.ok(await waitFor(() => copilotSyncCalls === calls + 1), `${label} : synchro relancée`);
        open();
        if (awaitsSync) {
          const res = await pending;
          assert.equal(res.status, expected, `${label} : ${res.body}`);
        }
        assert.ok(await waitFor(() => !copilotDue), `${label} : indicateur levé`);
        const admitted = await prompt("ses_due", body, confirmedHeaders);
        assert.equal(admitted.status, 204, `${label} : ${admitted.body}`);
        assert.equal(relayed(), sent + 1, label);
      } finally {
        open();
        copilotSyncHold = null;
      }
    };
    /** Sans écriture ni redémarrage réels : aucune pose, aucune synchro, demande facturée admise dès la réponse. */
    const notPosted = async (label: string, send: () => Promise<Res>, expected: number) => {
      const marks = copilotMarks.length;
      const calls = copilotSyncCalls;
      const sent = relayed();
      const res = await send();
      assert.equal(res.status, expected, `${label} : ${res.body}`);
      assert.equal(copilotMarks.length, marks, label);
      assert.equal(copilotSyncCalls, calls, label);
      assert.equal(copilotDue, false, label);
      const admitted = await prompt("ses_due", body, confirmedHeaders);
      assert.equal(admitted.status, 204, `${label} : ${admitted.body}`);
      assert.equal(relayed(), sent + 1, label);
    };

    fs.writeFileSync(file, base);
    settings.update({ ui: { mode: "avance" } });
    copilotTarget = true;
    try {
      const allowed = base.replace('"ask"', '"allow"');
      await posted("fichier brut", () => raw(allowed), 200);
      await notPosted("fichier brut inchangé", () => raw(allowed), 200);
      await posted("permissions globales", () => call("PUT", "/api/opencode/config/permission", mutating, JSON.stringify({ permission: { edit: "deny" } })), 200);
      await posted("profil Prudent", () => call("POST", "/api/security/restore-prudent", mutating, "{}"), 200);
      await notPosted("profil Prudent déjà appliqué", () => call("POST", "/api/security/restore-prudent", mutating, "{}"), 200);
      await posted("correctif (mode Avancé)", advancedPatch, 200);
      disposeFails = true;
      await posted("correctif écrit, libération en échec", advancedPatch, 503);
      disposeFails = false;
      // PATCH en erreur ou hors délai (C4) : opencode a pu écrire quand même, pose dans la tâche puis synchro relancée après elle ;
      // la réponse reste celle d'une erreur d'opencode (502) ou interne (500).
      patchConfigFails = true;
      await posted("correctif en erreur", advancedPatch, 502);
      patchConfigFails = false;
      requestTimeout = "PATCH /global/config";
      await posted("correctif hors délai", advancedPatch, 500);
      requestTimeout = null;
      await notPosted(
        "correctif refusé (réponse en cours)",
        async () => {
          ocStatuses = { ses_actif: { type: "busy" } };
          try {
            return await advancedPatch();
          } finally {
            ocStatuses = {};
          }
        },
        409,
      );
      await posted("redémarrage depuis Diagnostic", restart, 200, true);
      restartQueue.push({ ok: false, durationMs: 0, message: "opencode ne répond pas après 2 minutes : consultez le journal.", failure: "delai-depasse" });
      await notPosted("redémarrage en échec", restart, 503);
      // Refusé au redémarrage puis retour arrière réussi : opencode a redémarré deux fois, une seule pose.
      await posted("fichier brut refusé, retour arrière", () => raw('{\n  "enabled_providers": ["github-copilot"],\n  "x-refuse-par-opencode": true\n}\n'), 422);
      assert.deepEqual(
        copilotMarks.slice(-2).map((m) => m.cause),
        ["redémarrage d'opencode (page Diagnostic)", "redémarrage d'opencode (fichier de configuration brut)"],
      );
    } finally {
      copilotTarget = false;
      copilotDue = false;
      copilotSyncHold = null;
      disposeFails = false;
      patchConfigFails = false;
      requestTimeout = null;
      ocStatuses = {};
      restartQueue.length = 0;
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  it("demande facturée refusée (409 redemarrage-en-cours) : message selon le motif — redémarrage ou application de la configuration, écriture de l'adresse par sa synchro, flux coupé, correction différée, revérification", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    const base = '{\n  "enabled_providers": ["github-copilot"],\n  "permission": { "edit": "ask" }\n}\n';
    const body = { agent: "build", model: ref("gpt-5-mini"), parts: text("x") };
    const relayed = () => forwarded("/session/ses_motif/prompt_async").length;
    const RESTART = "opencode redémarre déjà : réessayez dans une minute.";
    const CHECKING =
      "opencode vient de redémarrer ou de recharger sa configuration : l'adresse de l'API Copilot est en cours de vérification. Réessayez dans quelques secondes.";
    const refused = async (label: string, message: string) => {
      const res = await prompt("ses_motif", body, confirmedHeaders);
      assert.equal(res.status, 409, `${label} : ${res.body}`);
      assert.deepEqual(JSON.parse(res.body), { error: "redemarrage-en-cours", message }, label);
    };
    fs.writeFileSync(file, base);
    settings.update({ ui: { mode: "avance" } });
    copilotTarget = true;
    const sent = relayed();
    let release: () => void = () => undefined;
    try {
      // Écriture de l'adresse par la synchro Copilot (C3) : rien ne redémarre, message « adresse en vérification ».
      const syncWriting = configQueue.applyingWhile(() => new Promise<void>((resolve) => (release = resolve)), "adresse-copilot");
      await refused("écriture de la synchro", CHECKING);
      // Redémarrage lancé pendant cette écriture : son message l'emporte.
      restartingNow = true;
      await refused("redémarrage pendant l'écriture de la synchro", RESTART);
      restartingNow = false;
      release();
      await syncWriting;

      // Fichier brut en cours d'application (sonde des conversations retenue) : message du redémarrage, inchangé.
      lookupDelayMs = 300;
      const from = upstreamRequests.length;
      const applying = call("PUT", "/api/opencode/config/raw", mutating, JSON.stringify({ content: base.replace('"ask"', '"allow"') }));
      assert.ok(await waitFor(() => upstreamRequests.slice(from).some((r) => r.url.startsWith("/session/status"))), "application du fichier brut commencée");
      assert.equal(configQueue.applyingOrigin, "configuration");
      await refused("application du fichier brut", RESTART);
      lookupDelayMs = 0;
      const applied = await applying;
      assert.equal(applied.status, 200, applied.body);
      assert.ok(await waitFor(() => !copilotDue), "synchro relancée après le fichier brut");

      // « Synchro due » selon sa raison.
      copilotDue = true;
      copilotDueReason = "coupure";
      await refused("flux d'événements coupé", "opencode est injoignable ou redémarre : reconnexion en cours. Réessayez dans un moment.");
      copilotDueReason = "correction-differee";
      await refused(
        "adresse fausse relue pendant une réponse",
        "L'adresse de l'API Copilot sera corrigée dès la fin de la réponse en cours : réessayez une fois cette réponse terminée.",
      );
      copilotDueReason = "verification";
      await refused("revérification due", CHECKING);
      assert.equal(relayed(), sent);
      copilotDue = false;
      const admitted = await prompt("ses_motif", body, confirmedHeaders);
      assert.equal(admitted.status, 204, admitted.body);
      assert.equal(relayed(), sent + 1);
    } finally {
      release();
      restartingNow = false;
      lookupDelayMs = 0;
      copilotTarget = false;
      copilotDue = false;
      copilotDueReason = "verification";
      settings.update({ ui: { mode: "simple" } });
      fs.rmSync(file, { force: true });
    }
  });

  // Dernier test de la série : la déconnexion révoque le cookie partagé par les tests précédents.
  it("déconnexion : le cookie et toutes ses copies sont révoqués, les deux noms effacés, une nouvelle connexion en délivre un autre", async () => {
    assert.equal((await call("GET", "/api/settings", authed)).status, 200);
    const logout = await call("POST", "/api/logout", mutating, "{}");
    assert.equal(logout.status, 200);
    assert.deepEqual(setCookiesOf(logout), [
      "__Host-cockpit_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
      "cockpit_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
    ]);
    assert.equal((await call("GET", "/api/settings", authed)).status, 401);
    // Mode HTTP : le jeton ne se saisit jamais dans une page, la connexion passe par un ticket.
    const typed = await call("POST", "/api/login", { "x-cockpit-csrf": "1", "content-type": "application/json" }, JSON.stringify({ token }));
    assert.equal(typed.status, 403, typed.body);
    assert.equal((JSON.parse(typed.body) as { error?: string }).error, "login-disabled");
    assert.deepEqual(setCookiesOf(typed), []);
    const login = await loginByTicket();
    assert.equal(login.status, 303, login.body);
    const fresh = login.cookie;
    assert.match(fresh, /^__Host-cockpit_session=\d+\.[A-Za-z0-9_-]{43}$/);
    assert.notEqual(fresh, cookie);
    assert.equal((await call("GET", "/api/settings", { cookie: fresh })).status, 200);
    assert.equal((await call("GET", "/api/settings", authed)).status, 401);
  });
});
