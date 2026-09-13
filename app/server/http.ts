// Application HTTP : API du cockpit, proxy filtré vers opencode, flux SSE et fichiers de l'interface.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ArchiveService } from "./archive.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import type { ControlService } from "./control.ts";
import type { AppEnv } from "./env.ts";
import { assertInside, PathError, readIfExists, writeFileAtomic } from "./fsutil.ts";
import { applyEdits, modify } from "jsonc-parser";
import type { BrowserEvent, EventHub } from "./hub.ts";
import { type Ledger, MONTH_RE, monthKey } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { COPILOT_PRICES, PRICING_AS_OF, PRICING_SOURCE_URL, USD_PER_CREDIT } from "./pricing.ts";
import type { EventProcessor } from "./processor.ts";
import type { ProjectsService } from "./projects.ts";
import type { QuotaSync } from "./quota.ts";
import {
  authGuard,
  CONFIRM_HEADER,
  clearSessionCookie,
  csrfGuard,
  hostGuard,
  LoginLimiter,
  safeEqual,
  securityHeaders,
  sessionValue,
  setSessionCookie,
} from "./security.ts";
import { type Settings, SettingsError, type SettingsStore } from "./settings.ts";
import { StudioApplyError, type StudioScope, type StudioService, StudioValidationError } from "./studio.ts";
import type { StudioKind } from "./studio-schema.ts";
import { TEMPLATES } from "./templates.ts";

export interface AppDeps {
  env: AppEnv;
  log: Logger;
  db: DatabaseSync;
  client: OpencodeClient;
  catalog: ModelCatalog;
  ledger: Ledger;
  archive: ArchiveService;
  classifier: Classifier;
  studio: StudioService;
  projects: ProjectsService;
  control: ControlService;
  quota: QuotaSync;
  processor: EventProcessor;
  settings: SettingsStore;
  hub: EventHub;
}

// --- Proxy opencode : liste blanche explicite ------------------------------------------

const ID = "[A-Za-z0-9_-]{1,128}";

interface ProxyRule {
  method: string;
  pattern: RegExp;
  /** Requête qui déclenche un appel de modèle : soumise au garde-fou budgétaire. */
  guarded?: boolean;
}

const rule = (method: string, route: string, guarded = false): ProxyRule => ({
  method,
  pattern: new RegExp(`^${route}$`),
  guarded,
});

/**
 * Moindre privilège : uniquement les routes dont l'interface a besoin. Exclues notamment :
 * exécution shell directe sans permission (/session/:id/shell), lecture de fichiers arbitraires (/file*),
 * partage public (/share), mise à jour (/global/upgrade), injection d'identifiants (PUT /auth), terminal (/pty).
 */
export const PROXY_RULES: ProxyRule[] = [
  rule("GET", "/provider/auth"),
  // Connexion limitée à GitHub Copilot : l'interface ne propose aucun autre fournisseur.
  rule("POST", "/provider/github-copilot/oauth/authorize"),
  rule("POST", "/provider/github-copilot/oauth/callback"),
  rule("DELETE", "/auth/github-copilot"),
  rule("GET", "/agent"),
  rule("GET", "/command"),
  rule("GET", "/session"),
  rule("POST", "/session"),
  rule("GET", "/session/status"),
  rule("GET", `/session/${ID}`),
  rule("PATCH", `/session/${ID}`),
  rule("DELETE", `/session/${ID}`),
  rule("GET", `/session/${ID}/children`),
  rule("GET", `/session/${ID}/todo`),
  rule("GET", `/session/${ID}/diff`),
  rule("GET", `/session/${ID}/message`),
  rule("POST", `/session/${ID}/prompt_async`, true),
  rule("POST", `/session/${ID}/command`, true),
  rule("POST", `/session/${ID}/summarize`, true),
  rule("POST", `/session/${ID}/abort`),
  rule("GET", "/permission"),
  rule("POST", `/permission/${ID}/reply`),
  rule("GET", "/question"),
  rule("POST", `/question/${ID}/reply`),
  rule("POST", `/question/${ID}/reject`),
  rule("GET", "/find/file"),
];

const ALLOWED_QUERY = new Set(["directory", "roots", "limit", "query"]);

/**
 * Première pièce jointe refusée d'un corps de prompt (parts[].url) : opencode lit lui-même les fichiers
 * désignés par une URL file:, qui doit donc rester dans le workspace. Seules les images en data: et les
 * URL file: sont admises.
 */
export function forbiddenAttachment(body: unknown, isAllowed: (file: string) => boolean): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const parts = (body as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("url" in part)) continue;
    const url = (part as { url: unknown }).url;
    if (typeof url === "string" && /^data:image\//i.test(url)) continue;
    if (typeof url !== "string") return typeof url;
    if (!/^file:/i.test(url)) return url;
    let file: string;
    try {
      file = decodeURIComponent(new URL(url).pathname);
    } catch {
      return url;
    }
    if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    if (!isAllowed(file)) return url;
  }
  return undefined;
}

/** Types de parties acceptés dans un corps de prompt : l'interface n'envoie que du texte et des fichiers. */
export function forbiddenPartType(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("parts" in body)) return undefined;
  const parts = (body as { parts: unknown }).parts;
  if (!Array.isArray(parts)) return typeof parts;
  for (const part of parts) {
    const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
    // Une partie « subtask » ou « agent » ferait lire par opencode les @chemins de sa consigne, sans contrôle.
    if (type !== "text" && type !== "file") return typeof type === "string" ? type.slice(0, 40) : typeof type;
  }
  return undefined;
}

/** Références @chemin résolues côté serveur par opencode (motif FILE_REGEX d'opencode 1.18.30). */
const FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;

/**
 * Arguments de commande refusés :
 * - la syntaxe !`commande`, qu'opencode exécute sans demander d'autorisation (tout « ! » accompagné d'un
 *   accent grave est refusé, car les arguments peuvent être recollés par le modèle de commande) ;
 * - les références @chemin qui sortiraient du workspace : ~, segment « .. », ou chemin qui, résolu comme le fait
 *   opencode (depuis la racine du dépôt git, ou depuis « / » hors dépôt), n'est pas dans le workspace.
 */
export function forbiddenCommandArguments(body: unknown, isAllowed: (file: string) => boolean, worktree: string): string | undefined {
  if (!body || typeof body !== "object" || !("arguments" in body)) return undefined;
  const args = (body as { arguments: unknown }).arguments;
  if (typeof args !== "string") return typeof args;
  if (args.includes("!") && args.includes("`")) return "!`commande`";
  for (const match of args.matchAll(FILE_REFERENCE)) {
    const ref = match[1] ?? "";
    if (ref.startsWith("~") || ref.split(/[\\/]/).includes("..")) return ref;
    const target = ref.startsWith("/") ? ref : path.posix.resolve(worktree, ref);
    if (!isAllowed(target)) return ref;
  }
  return undefined;
}

/** Normalisation d'un domaine GitHub Enterprise, identique à celle du plugin github-copilot d'opencode. */
const normalizeDomain = (url: string) => url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");

/**
 * Corps relayés refusés, que l'interface n'envoie jamais :
 * - création ou renommage de conversation avec autre chose qu'un titre : une règle « permission » de session
 *   passerait avant les permissions globales ;
 * - demande de modèle portant « tools » ou « permission », pour la même raison ;
 * - connexion GitHub Enterprise vers un domaine autre que COCKPIT_GITHUB_ENTERPRISE_DOMAIN : opencode y
 *   enverrait toutes les demandes et le jeton sous l'identité « github-copilot ».
 */
export function forbiddenProxyBody(method: string, sub: string, body: unknown, enterpriseDomain: string | null): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if ((method === "POST" && sub === "/session") || (method === "PATCH" && /^\/session\/[^/]+$/.test(sub))) {
    const extra = Object.keys(record).filter((key) => key !== "title");
    if (extra.length > 0) return `Champ non accepté pour une conversation : ${extra.join(", ").slice(0, 80)}.`;
  }
  if (/^\/session\/[^/]+\/(prompt_async|command|summarize)$/.test(sub) && ("tools" in record || "permission" in record)) {
    return "Les champs « tools » et « permission » ne sont pas acceptés : les permissions se règlent dans Paramètres › opencode.";
  }
  if (sub === "/provider/github-copilot/oauth/authorize") {
    const inputs = record.inputs && typeof record.inputs === "object" ? (record.inputs as Record<string, unknown>) : {};
    const type = inputs.deploymentType ?? "github.com";
    if (type === "github.com") return undefined;
    if (type !== "enterprise") return "Type de connexion GitHub inconnu.";
    const expected = enterpriseDomain ? normalizeDomain(enterpriseDomain) : null;
    const domain = typeof inputs.enterpriseUrl === "string" ? normalizeDomain(inputs.enterpriseUrl) : "";
    if (!expected) return "Connexion GitHub Enterprise refusée : déclarez d'abord le domaine dans COCKPIT_GITHUB_ENTERPRISE_DOMAIN (.env).";
    if (domain !== expected) return `Domaine GitHub Enterprise refusé : seul ${expected} est autorisé (COCKPIT_GITHUB_ENTERPRISE_DOMAIN).`;
  }
  return undefined;
}

export function modelFromBody(body: unknown): { providerID: string; modelID: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const model = b.model;
  if (model && typeof model === "object") {
    const m = model as Record<string, unknown>;
    if (typeof m.providerID === "string" && typeof m.modelID === "string") return { providerID: m.providerID, modelID: m.modelID };
  }
  if (typeof model === "string" && model.includes("/")) {
    const i = model.indexOf("/");
    return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
  }
  if (typeof b.providerID === "string" && typeof b.modelID === "string") return { providerID: b.providerID, modelID: b.modelID };
  return undefined;
}

// --- Validation des entrées ------------------------------------------------------------

const KINDS = new Set<StudioKind>(["agents", "commands", "skills"]);

const studioBody = z.object({
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string().max(256 * 1024),
  previousName: z.string().max(64).nullable().optional(),
});

const archivePatch = z.strictObject({
  category: z.string().max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(2_000).optional(),
  pinned: z.boolean().optional(),
});

const optionalInt = (value: string | undefined) => {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createApp(deps: AppDeps): Hono {
  const { env, log, client, catalog, ledger, archive, classifier, studio, projects, control, quota, processor, settings, hub } = deps;
  const app = new Hono();
  const expectedSession = sessionValue(env.token);
  const limiter = new LoginLimiter();

  const fail = (c: Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, message, ...extra }, status as ContentfulStatusCode);

  const scopeOf = (c: Context): StudioScope => {
    const project = c.req.query("project");
    return project ? { type: "project", project } : { type: "global" };
  };

  const kindOf = (c: Context): StudioKind => {
    const kind = c.req.param("kind") as StudioKind;
    if (!KINDS.has(kind)) throw new PathError("Type inconnu (agents, commands ou skills).");
    return kind;
  };

  const modelsPayload = (s: Settings) =>
    catalog.list().map((m) => ({
      key: m.key,
      providerID: m.providerID,
      providerName: m.providerName,
      modelID: m.modelID,
      name: m.name,
      price: m.providerID === "github-copilot" ? (COPILOT_PRICES[m.modelID] ?? m.price) : m.price,
      officialPrice: m.providerID === "github-copilot" && COPILOT_PRICES[m.modelID] !== undefined,
      contextLimit: m.contextLimit,
      outputLimit: m.outputLimit,
      reasoning: m.reasoning,
      attachment: m.attachment,
      variants: m.variants,
      expensive: (m.price?.rates.output ?? 0) > s.budget.guard.maxOutputPricePerM,
    }));

  app.use("*", securityHeaders());
  app.use("*", hostGuard(env.allowedHosts));
  app.use("*", authGuard(expectedSession));
  app.use("*", csrfGuard());

  app.onError((err, c) => {
    if (err instanceof StudioValidationError) return fail(c, 422, "validation", err.message, { issues: err.issues });
    if (err instanceof StudioApplyError) {
      return fail(c, 422, "rejected-by-opencode", err.message, { issues: err.issues, restarted: err.restarted });
    }
    if (err instanceof SettingsError) return fail(c, 422, "validation", err.message, { issues: err.issues });
    if (err instanceof z.ZodError) {
      return fail(c, 400, "validation", "Requête invalide.", {
        issues: err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      });
    }
    if (err instanceof PathError || err instanceof RangeError) return fail(c, 400, "invalid", err.message);
    if (err instanceof OpencodeError) {
      return fail(c, err.status >= 500 ? 502 : err.status === 404 ? 404 : 400, "opencode", err.message, { detail: err.body });
    }
    if (err instanceof TypeError && /fetch failed|ECONNREFUSED/i.test(`${err.message} ${String((err as { cause?: unknown }).cause)}`)) {
      return fail(c, 502, "opencode-unreachable", "opencode est injoignable pour le moment.");
    }
    log.error("erreur interne", { path: c.req.path, error: errorMessage(err) });
    return fail(c, 500, "internal", "Erreur interne du cockpit.");
  });

  // --- Authentification ---------------------------------------------------------------

  app.get("/api/health", (c) => c.json({ ok: true, version: env.version }));

  app.get("/auth", async (c) => {
    // Lien à ouvrir directement (installateur, barre d'adresse). Refuser les requêtes émises par une
    // autre page (image, iframe…) évite qu'un site tiers épuise le limiteur et bloque la connexion.
    const site = c.req.header("sec-fetch-site");
    const dest = c.req.header("sec-fetch-dest");
    if ((site && site !== "none" && site !== "same-origin") || (dest && dest !== "document")) {
      return c.text("Ouvrez ce lien directement dans la barre d'adresse du navigateur.", 403);
    }
    if (limiter.blocked()) return c.text("Trop de tentatives, réessayez dans quelques minutes.", 429);
    if (!safeEqual(c.req.query("t") ?? "", env.token)) {
      limiter.fail();
      await sleep(400);
      return c.redirect("/?auth=failed", 303);
    }
    setSessionCookie(c, expectedSession);
    return c.redirect("/", 303);
  });

  app.post("/api/login", bodyLimit({ maxSize: 4_096 }), async (c) => {
    if (limiter.blocked()) return fail(c, 429, "rate-limited", "Trop de tentatives, réessayez dans quelques minutes.");
    const { token } = z.object({ token: z.string().max(512) }).parse(await c.req.json());
    if (!safeEqual(token.trim(), env.token)) {
      limiter.fail();
      await sleep(400);
      return fail(c, 401, "unauthorized", "Jeton incorrect.");
    }
    setSessionCookie(c, expectedSession);
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // --- Vue d'ensemble -------------------------------------------------------------------

  app.get("/api/bootstrap", async (c) => {
    const s = settings.get();
    const [health, projectList, copilotConnected, caFiles, supervisor] = await Promise.all([
      client.health(),
      projects.list(),
      quota.copilotConnected(),
      control.caFilesCount(),
      control.supervisorPresent(),
    ]);
    const usage = ledger.summary();
    return c.json({
      version: env.version,
      opencode: {
        reachable: Boolean(health?.healthy),
        version: health?.version ?? null,
        events: processor.status,
        restarting: control.restarting,
        supervisor,
      },
      security: {
        tlsInsecure: env.tlsInsecure,
        caFiles,
        proxy: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
        projectConfig: env.projectConfig,
      },
      workspace: { hostDir: process.env.COCKPIT_HOST_WORKSPACE_DIR ?? null, root: projects.opencodeRoot },
      projects: projectList,
      settings: s,
      copilotConnected,
      models: modelsPayload(s),
      modelDefaults: catalog.defaults,
      catalogLoadedAt: catalog.loadedAt,
      usage: {
        month: usage.month,
        spentUsd: usage.spentUsd,
        budgetUsd: usage.budgetUsd,
        percent: usage.percent,
        projectedUsd: usage.projectedUsd,
        remainingUsd: usage.remainingUsd,
      },
      quota: quota.latest(),
      pricing: { asOf: PRICING_AS_OF, sourceUrl: PRICING_SOURCE_URL, usdPerCredit: USD_PER_CREDIT },
    });
  });

  app.get("/api/projects", async (c) => c.json(await projects.list()));

  app.get("/api/models", (c) => c.json({ models: modelsPayload(settings.get()), defaults: catalog.defaults, loadedAt: catalog.loadedAt }));

  app.post("/api/models/refresh", async (c) => {
    await catalog.refresh();
    return c.json({ models: modelsPayload(settings.get()), defaults: catalog.defaults, loadedAt: catalog.loadedAt });
  });

  // --- Flux d'événements ----------------------------------------------------------------

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: BrowserEvent[] = [];
      let closed = false;
      let wake: (() => void) | null = null;
      const notify = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const unsubscribe = hub.subscribe((event) => {
        queue.push(event);
        if (queue.length > 10_000) queue.splice(0, queue.length - 10_000);
        notify();
      });
      const heartbeat = setInterval(() => {
        queue.push({ kind: "cockpit", type: "heartbeat", data: Date.now() });
        notify();
      }, 15_000);
      stream.onAbort(() => {
        closed = true;
        notify();
      });
      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: Date.now(), version: env.version }) });
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (queue.length > 0 || closed) notify();
            });
          }
          while (queue.length > 0 && !closed) {
            await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          }
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }),
  );

  // --- Proxy vers opencode --------------------------------------------------------------

  app.all("/api/oc/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
    const sub = c.req.path.slice("/api/oc".length) || "/";
    const method = c.req.method.toUpperCase();
    const matched = PROXY_RULES.find((r) => r.method === method && r.pattern.test(sub));
    if (!matched) return fail(c, 404, "not-allowed", `Route opencode non autorisée : ${method} ${sub}`);

    const incoming = new URL(c.req.url);
    const target = client.url(sub);
    for (const [key, value] of incoming.searchParams) if (ALLOWED_QUERY.has(key)) target.searchParams.set(key, value);
    const directory = target.searchParams.get("directory");
    if (directory !== null && !projects.isAllowedDirectory(directory)) {
      return fail(c, 403, "forbidden-directory", "Ce dossier est hors du workspace monté.");
    }

    let body: string | null = null;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.text();
      let parsed: unknown = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return fail(c, 400, "invalid-json", "Corps JSON invalide.");
      }
      const refusedBody = forbiddenProxyBody(method, sub, parsed, env.githubEnterpriseDomain);
      if (refusedBody !== undefined) return fail(c, 403, "forbidden-body", refusedBody);
      if (matched.guarded) {
        const isAllowed = (file: string) => projects.isAllowedDirectory(file);
        const partType = forbiddenPartType(parsed);
        if (partType !== undefined) {
          return fail(c, 403, "forbidden-part", `Type de contenu refusé : ${partType} (texte et fichiers uniquement).`);
        }
        if (forbiddenAttachment(parsed, isAllowed) !== undefined) {
          return fail(c, 403, "forbidden-attachment", "Pièce jointe refusée : fichier hors du workspace monté ou type d'URL non pris en charge.");
        }
        if (sub.endsWith("/command")) {
          const worktree = await projects.opencodeWorktree(directory ?? projects.opencodeRoot);
          if (forbiddenCommandArguments(parsed, isAllowed, worktree) !== undefined) {
            return fail(
              c,
              403,
              "forbidden-command-arguments",
              "Arguments refusés : un « ! » et un accent grave dans le même texte (opencode pourrait les exécuter comme !`commande`), ou une référence @fichier qui sortirait du workspace (~, .., chemin hors du projet). Retirez-les, ou envoyez le texte sans /commande.",
            );
          }
        }
        const decision = ledger.guard(modelFromBody(parsed), c.req.header(CONFIRM_HEADER) === "1");
        if (!decision.allowed) return c.json({ error: "budget-guard", ...decision }, 409);
      }
    }

    const upstream = await client.raw(method, target, {
      headers: {
        accept: c.req.header("accept") ?? "application/json",
        ...(body !== null ? { "content-type": "application/json" } : {}),
      },
      body: body === null || body === "" ? null : body,
      signal: c.req.raw.signal,
    });
    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // --- Coûts -----------------------------------------------------------------------------

  const monthParam = (c: Context) => {
    const month = c.req.query("month") ?? monthKey(Date.now());
    if (!MONTH_RE.test(month)) throw new RangeError("Mois invalide (AAAA-MM).");
    return month;
  };

  app.get("/api/usage/summary", (c) => c.json({ ...ledger.summary(monthParam(c)), quota: quota.latest() }));

  app.get("/api/usage/export.csv", (c) => {
    const month = monthParam(c);
    return c.body(ledger.exportCsv(month), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cockpit-couts-${month}.csv"`,
    });
  });

  app.get("/api/usage/estimate", (c) => {
    const { provider, model } = z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) }).parse(c.req.query());
    const estimate = ledger.estimate(provider, model);
    return c.json({ ...estimate, guard: ledger.guard({ providerID: provider, modelID: model }, false) });
  });

  app.get("/api/usage/session/:id", (c) => c.json(ledger.sessionUsage(c.req.param("id"))));

  app.post("/api/usage/recompute", (c) => c.json({ updated: ledger.recompute(monthParam(c)) }));

  app.get("/api/quota", (c) =>
    c.json({ latest: quota.latest(), lastError: quota.lastError, enabled: settings.get().quotaSync.enabled }),
  );

  app.post("/api/quota/sync", async (c) => c.json(await quota.syncNow()));

  // --- Archives --------------------------------------------------------------------------

  app.get("/api/archive", (c) => {
    const q = c.req.query();
    const query = {
      limit: Math.min(Math.max(optionalInt(q.limit) ?? 50, 1), 200),
      offset: Math.max(optionalInt(q.offset) ?? 0, 0),
      ...(q.q ? { q: q.q.slice(0, 200) } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.project ? { project: q.project } : {}),
      ...(optionalInt(q.from) !== undefined ? { from: optionalInt(q.from) as number } : {}),
      ...(optionalInt(q.to) !== undefined ? { to: optionalInt(q.to) as number } : {}),
      ...(q.pinned === "1" ? { pinned: true } : {}),
    };
    return c.json(archive.list(query));
  });

  app.get("/api/archive/stats", (c) => c.json({ categories: archive.stats(), projects: archive.projects() }));

  app.post("/api/archive/rescan", async (c) => {
    deps.db.prepare("DELETE FROM settings WHERE key = 'sync.lastAt'").run();
    void processor
      .backfill()
      .then(() => hub.cockpit("archive.rescanned", {}))
      .catch((err) => log.warn("réanalyse de l'historique en échec", { error: errorMessage(err) }));
    return c.json({ started: true });
  });

  app.get("/api/archive/:id", (c) => {
    const conversation = archive.get(c.req.param("id"));
    if (!conversation) return fail(c, 404, "not-found", "Conversation introuvable dans les archives.");
    return c.json({ conversation, transcript: archive.transcript(conversation.sessionId), usage: ledger.sessionUsage(conversation.sessionId) });
  });

  app.patch("/api/archive/:id", async (c) => {
    const patch = archivePatch.parse(await c.req.json());
    const updated = await archive.update(c.req.param("id"), patch);
    if (!updated) return fail(c, 404, "not-found", "Conversation introuvable.");
    hub.cockpit("conversation.updated", { sessionId: updated.sessionId });
    return c.json(updated);
  });

  app.post("/api/archive/:id/classify", async (c) => {
    const conversation = await classifier.run(c.req.param("id"), { force: true });
    if (!conversation) return fail(c, 404, "not-found", "Session introuvable ou vide.");
    return c.json(conversation);
  });

  app.post("/api/archive/:id/refresh", async (c) => {
    const refreshed = await archive.refresh(c.req.param("id"));
    if (!refreshed) return fail(c, 404, "not-found", "Session introuvable ou vide.");
    return c.json(refreshed.conversation);
  });

  app.delete("/api/archive/:id", async (c) => {
    const deleted = await archive.remove(c.req.param("id"));
    if (deleted) hub.cockpit("conversation.deleted", { sessionId: c.req.param("id") });
    return c.json({ deleted });
  });

  app.get("/api/archive/:id/export.md", (c) => {
    const markdown = archive.markdown(c.req.param("id"));
    if (markdown === null) return fail(c, 404, "not-found", "Conversation introuvable.");
    return c.body(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="conversation-${c.req.param("id").replace(/[^A-Za-z0-9_-]/g, "")}.md"`,
    });
  });

  // --- Studio ----------------------------------------------------------------------------

  app.get("/api/studio/templates", (c) => c.json(TEMPLATES));

  app.get("/api/studio/instructions", async (c) => c.json(await studio.getInstructions(scopeOf(c))));

  app.put("/api/studio/instructions", bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(await c.req.json());
    await studio.saveInstructions(scopeOf(c), content);
    return c.json({ ok: true });
  });

  app.get("/api/studio/skills/:name/file", async (c) => {
    const content = await studio.readSkillFile(c.req.param("name"), c.req.query("file") ?? "", scopeOf(c));
    if (content === null) return fail(c, 404, "not-found", "Fichier introuvable.");
    return c.json({ content });
  });

  app.put("/api/studio/skills/:name/file", bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string() }).parse(await c.req.json());
    await studio.writeSkillFile(c.req.param("name"), c.req.query("file") ?? "", content, scopeOf(c));
    return c.json({ ok: true });
  });

  app.delete("/api/studio/skills/:name/file", async (c) => {
    await studio.deleteSkillFile(c.req.param("name"), c.req.query("file") ?? "", scopeOf(c));
    return c.json({ ok: true });
  });

  app.get("/api/studio/:kind", async (c) => c.json(await studio.list(kindOf(c), scopeOf(c))));

  app.get("/api/studio/:kind/:name", async (c) => {
    const item = await studio.get(kindOf(c), c.req.param("name"), scopeOf(c));
    if (!item) return fail(c, 404, "not-found", "Élément introuvable.");
    return c.json(item);
  });

  app.put("/api/studio/:kind/:name", bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const input = studioBody.parse(await c.req.json());
    const item = await studio.save(kindOf(c), scopeOf(c), {
      name: c.req.param("name"),
      previousName: input.previousName ?? null,
      frontmatter: input.frontmatter,
      body: input.body,
    });
    await catalog.refresh().catch(() => undefined);
    hub.cockpit("studio.changed", { kind: item.kind, name: item.name });
    return c.json(item);
  });

  app.delete("/api/studio/:kind/:name", async (c) => {
    const kind = kindOf(c);
    const deleted = await studio.remove(kind, c.req.param("name"), scopeOf(c));
    hub.cockpit("studio.changed", { kind, name: c.req.param("name") });
    return c.json({ deleted });
  });

  // --- Configuration opencode ------------------------------------------------------------

  const configFile = async () => {
    for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
      const file = path.join(env.opencodeConfigDir, name);
      if ((await readIfExists(file)) !== null) return file;
    }
    return path.join(env.opencodeConfigDir, "opencode.jsonc");
  };

  app.get("/api/opencode/config", async (c) => c.json(await client.request("GET", "/global/config", { timeoutMs: 15_000 })));

  app.patch("/api/opencode/config", bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const patch = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const updated = await client.request("PATCH", "/global/config", { body: patch, timeoutMs: 30_000 });
    await client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
    await catalog.refresh().catch(() => undefined);
    hub.cockpit("opencode.config.changed", {});
    return c.json(updated);
  });

  app.get("/api/opencode/config/raw", async (c) => {
    const file = await configFile();
    return c.json({ file: path.basename(file), content: (await readIfExists(file)) ?? "" });
  });

  /** Écrit la configuration, la fait relire par opencode et revient à la version précédente s'il la refuse. */
  const writeConfigChecked = async (file: string, content: string, backup: string | null, reason: string) => {
    await writeFileAtomic(file, content);
    await client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
    try {
      await client.request("GET", "/global/config", { timeoutMs: 20_000 });
      await client.request("GET", "/agent", { timeoutMs: 20_000 });
    } catch (err) {
      if (backup !== null) await writeFileAtomic(file, backup);
      await client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
      const stillBroken = await client.request("GET", "/agent", { timeoutMs: 20_000 }).then(() => false, () => true);
      const restarted = stillBroken ? (await control.restartOpencode(reason)).ok : false;
      return { ok: false as const, error: errorMessage(err), restarted };
    }
    await catalog.refresh().catch(() => undefined);
    hub.cockpit("opencode.config.changed", {});
    return { ok: true as const };
  };

  app.put("/api/opencode/config/raw", bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(await c.req.json());
    const file = await assertInside(env.opencodeConfigDir, await configFile());
    const result = await writeConfigChecked(file, content, await readIfExists(file), "configuration brute invalide annulée");
    if (!result.ok) return fail(c, 422, "rejected-by-opencode", `opencode a refusé ce fichier : ${result.error}`, { restarted: result.restarted });
    return c.json({ ok: true });
  });

  const permissionAction = z.enum(["ask", "allow", "deny"]);
  const permissionSchema = z.record(
    z.string().min(1).max(64),
    z.union([permissionAction, z.record(z.string().min(1).max(512), permissionAction)]),
  );

  // Remplace le bloc « permission » d'un seul tenant (commentaires du fichier conservés). Le PATCH d'opencode
  // fusionne clé par clé : il garderait d'anciennes règles et échoue quand une valeur texte devient un objet.
  app.put("/api/opencode/config/permission", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { permission } = z.object({ permission: permissionSchema }).parse(await c.req.json());
    const file = await assertInside(env.opencodeConfigDir, await configFile());
    const backup = await readIfExists(file);
    const source = backup ?? "{}\n";
    const content = applyEdits(source, modify(source, ["permission"], permission, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const result = await writeConfigChecked(file, content, backup, "permissions invalides annulées");
    if (!result.ok) return fail(c, 422, "rejected-by-opencode", `opencode a refusé ces permissions : ${result.error}`, { restarted: result.restarted });
    return c.json({ ok: true });
  });

  // --- Paramètres du cockpit ------------------------------------------------------------

  app.get("/api/settings", (c) => c.json(settings.get()));

  app.put("/api/settings", bodyLimit({ maxSize: 256 * 1024 }), async (c) => c.json(settings.update(await c.req.json())));

  app.post("/api/settings/reset", async (c) => {
    const { section } = z.object({ section: z.enum(["budget", "pricing", "classifier", "quotaSync", "chat"]) }).parse(await c.req.json());
    return c.json(settings.reset(section));
  });

  app.get("/api/pricing", (c) =>
    c.json({
      asOf: PRICING_AS_OF,
      sourceUrl: PRICING_SOURCE_URL,
      usdPerCredit: USD_PER_CREDIT,
      table: COPILOT_PRICES,
      overrides: settings.get().pricing.overrides,
      catalog: catalog.list().map((m) => ({ key: m.key, name: m.name, price: m.price })),
    }),
  );

  // --- Système ---------------------------------------------------------------------------

  app.get("/api/system/status", async (c) => {
    const [health, supervisor, caFiles, copilotConnected] = await Promise.all([
      client.health(),
      control.supervisorPresent(),
      control.caFilesCount(),
      quota.copilotConnected(),
    ]);
    const count = (table: string) => (deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return c.json({
      version: env.version,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      opencode: { reachable: Boolean(health?.healthy), version: health?.version ?? null, url: env.opencodeUrl, supervisor, restarting: control.restarting },
      events: processor.status,
      browsers: hub.clientCount,
      security: {
        tlsInsecure: env.tlsInsecure,
        caFiles,
        httpProxy: Boolean(process.env.HTTP_PROXY),
        httpsProxy: Boolean(process.env.HTTPS_PROXY),
        noProxy: process.env.NO_PROXY ?? "",
        allowedHosts: env.allowedHosts,
        projectConfig: env.projectConfig,
      },
      copilotConnected,
      catalog: { models: catalog.list().length, providers: catalog.providers(), loadedAt: catalog.loadedAt },
      quota: { latest: quota.latest(), lastError: quota.lastError },
      database: {
        sessions: count("sessions"),
        usage: count("usage"),
        prompts: count("prompts"),
        conversations: count("conversations"),
      },
      paths: { workspace: process.env.COCKPIT_HOST_WORKSPACE_DIR ?? env.workspaceDir, archives: env.archiveDir },
    });
  });

  app.post("/api/system/restart-opencode", async (c) => {
    const result = await control.restartOpencode("demande depuis l'interface");
    if (result.ok) {
      await catalog.refresh().catch(() => undefined);
      await studio.ensureClassifierAgent().catch(() => undefined);
    }
    return c.json(result, result.ok ? 200 : 503);
  });

  app.get("/api/system/logs", async (c) => {
    const lines = Math.min(Math.max(optionalInt(c.req.query("lines")) ?? 400, 10), 5_000);
    return c.json({ content: await control.logs(lines) });
  });

  app.post("/api/system/backfill", async (c) => {
    await processor.backfill();
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => fail(c, 404, "not-found", "Route inconnue."));

  // --- Interface web (fichiers statiques + repli SPA) ------------------------------------

  app.get("*", async (c) => {
    const requested = decodeURIComponent(c.req.path);
    const candidate = path.join(env.webDir, requested);
    let file = path.join(env.webDir, "index.html");
    try {
      const safe = await assertInside(env.webDir, candidate);
      const stat = await fs.stat(safe);
      if (stat.isFile()) file = safe;
    } catch {
      // Chemin inconnu ou refusé : on sert l'application (routage côté client).
    }
    const content = await fs.readFile(file).catch(() => null);
    if (!content) return c.text("Interface non construite : lancez `npm run build`.", 503);
    const isAsset = requested.startsWith("/assets/");
    return c.body(content, 200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
  });

  return app;
}
