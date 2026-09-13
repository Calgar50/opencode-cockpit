// Tests d'intégration : registre des coûts sur SQLite réel, et sécurité HTTP sur un vrai serveur.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { ArchiveService } from "./archive.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import type { ControlService } from "./control.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { createApp, forbiddenAttachment, forbiddenProxyBody, PROXY_RULES } from "./http.ts";
import { EventHub } from "./hub.ts";
import { csvCell, Ledger, monthBounds, monthKey } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { type OcAssistantMessage, type OcSession, OpencodeClient, type OcUserMessage } from "./opencode.ts";
import type { EventProcessor } from "./processor.ts";
import { ProjectsService } from "./projects.ts";
import { apiHostFor, type QuotaSync } from "./quota.ts";
import { sessionValue } from "./security.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { StudioService, StudioValidationError } from "./studio.ts";

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

describe("serveur HTTP (sécurité et proxy)", () => {
  const token = "t".repeat(48);
  const cookie = `cockpit_session=${sessionValue(token)}`;
  const upstreamRequests: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];
  let upstream: http.Server;
  let cockpit: ReturnType<typeof serve>;
  let port = 0;
  let tmp = "";

  before(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        upstreamRequests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        if (req.url?.startsWith("/global/health")) {
          res.writeHead(200, { "content-type": "application/json" }).end('{"healthy":true,"version":"test"}');
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
    const env: AppEnv = {
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
      githubEnterpriseDomain: null,
      version: "test",
    };
    const { db, settings, catalog, ledger, sessions } = setup();
    // Les routes de configuration rechargent le catalogue après écriture.
    Object.assign(catalog, { refresh: async () => undefined });
    const root = sessions.upsert(session("ses_budget"));
    ledger.recordAssistant({ ...assistant("msg_b", "ses_budget", 500, 1, 1), time: { created: Date.now(), completed: Date.now() } }, root);
    const app = createApp({
      env,
      log: createLogger("error"),
      db,
      client: new OpencodeClient(env),
      catalog,
      ledger,
      settings,
      hub: new EventHub(),
      projects: new ProjectsService(env),
      archive: {} as ArchiveService,
      classifier: {} as Classifier,
      studio: {} as StudioService,
      control: {} as ControlService,
      quota: {} as QuotaSync,
      processor: {} as EventProcessor,
    });
    cockpit = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => cockpit.once("listening", resolve));
    port = (cockpit.address() as AddressInfo).port;
  });

  after(async () => {
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

  it("refuse un en-tête Host inconnu (DNS rebinding)", async () => {
    const res = await call("GET", "/api/health", { host: "evil.example:80" });
    assert.equal(res.status, 421);
  });

  it("pose les en-têtes de sécurité", async () => {
    const res = await call("GET", "/");
    assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal(res.headers["x-frame-options"], "DENY");
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
    const confirmed = { ...mutating, "x-cockpit-confirm": "1" };
    const command = (args: unknown, directory = "/workspace/app") =>
      call("POST", `/api/oc/session/ses_1/command?directory=${encodeURIComponent(directory)}`, confirmed, JSON.stringify({ command: "revue", arguments: args }));
    fs.mkdirSync(path.join(tmp, "app", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "notes"), { recursive: true });
    assert.equal((await command("regarde !`cat ~/.local/share/opencode/auth.json`")).status, 403);
    assert.equal((await command("@~/.local/share/opencode/auth.json")).status, 403);
    assert.equal((await command("@/home/node/.local/share/opencode/auth.json")).status, 403);
    assert.equal((await command("@../../etc/passwd")).status, 403);
    assert.equal((await command(42)).status, 403);
    assert.equal((await command("revois @src/app.ts et @/workspace/app/README.md")).status, 204);
    // Hors dépôt git, opencode résout un @chemin relatif depuis « / » : le jeton Copilot serait lisible.
    assert.equal((await command("@home/node/.local/share/opencode/auth.json", "/workspace/notes")).status, 403);
    assert.equal((await command("revois @src/app.ts", "/workspace/notes")).status, 403);
    const subtask = JSON.stringify({ parts: [{ type: "subtask", agent: "general", description: "x", prompt: "@/home/node/.local/share/opencode/auth.json" }] });
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, subtask)).status, 403);
  });

  it("remplace les permissions globales d'un bloc en gardant les commentaires", async () => {
    const file = path.join(tmp, "opencode.jsonc");
    fs.writeFileSync(file, '{\n  // commentaire conservé\n  "share": "disabled",\n  "permission": { "edit": "ask", "bash": { "*": "ask", "git branch*": "allow" } }\n}\n');
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
      fs.rmSync(file, { force: true });
    }
  });

  it("refuse les permissions glissées dans une requête et les connexions hors GitHub Copilot", async () => {
    const rule = [{ permission: "webfetch", pattern: "*", action: "allow" }];
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ permission: rule }))).status, 403);
    assert.equal((await call("POST", "/api/oc/session", mutating, JSON.stringify({ title: "ok" }))).status, 204);
    assert.equal((await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ permission: rule }))).status, 403);
    assert.equal((await call("PATCH", "/api/oc/session/ses_1", mutating, JSON.stringify({ title: "renommée" }))).status, 200);
    const confirmed = { ...mutating, "x-cockpit-confirm": "1" };
    const prompt = { model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "x" }], tools: { webfetch: true } };
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, JSON.stringify(prompt))).status, 403);
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
    const confirmed = { ...mutating, "x-cockpit-confirm": "1" };
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, body("file:///home/node/.local/share/opencode/auth.json"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, body("file:///workspace/../etc/passwd"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, body("https://exemple.test/a.txt"))).status, 403);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, body("file:///workspace/app/src/x.ts"))).status, 204);
    assert.equal((await call("POST", "/api/oc/session/ses_1/prompt_async", confirmed, body("file:///workspace/..%2Fetc%2Fpasswd"))).status, 403);
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
});
