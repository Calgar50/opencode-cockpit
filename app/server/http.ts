// Application HTTP : API du cockpit, proxy filtré vers opencode, flux SSE et fichiers de l'interface.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ArchiveService } from "./archive.ts";
import { probeSessionsBusy } from "./assistants.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import type { ControlService } from "./control.ts";
import type { CopilotApi } from "./copilot.ts";
import { transaction } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { assertInside, PathError, readIfExists, readInside, writeFileAtomic } from "./fsutil.ts";
import { applyEdits, modify, parse as parseJsonc, parseTree } from "jsonc-parser";
import type { BrowserEvent, EventHub } from "./hub.ts";
import { type Ledger, MONTH_RE, monthKey } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import { advancedOnly, settingsPatchGuard, settingsResetGuard } from "./mode.ts";
import type { CopilotConfigSync } from "./oc-copilot-config.ts";
import type { OcAgentInfo, OcLookup, OcLookupSnapshot } from "./oc-lookup.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { COPILOT_PRICES, type ModelPrice, PRICING_AS_OF, PRICING_SOURCE_URL, USD_PER_CREDIT } from "./pricing.ts";
import type { EventProcessor } from "./processor.ts";
import type { ProjectsService } from "./projects.ts";
import type { QuotaSync } from "./quota.ts";
import {
  attemptLogin,
  authGuard,
  CONFIRM_HEADER,
  clearSessionCookie,
  csrfGuard,
  hostGuard,
  isValidSession,
  LoginLimiter,
  newSessionSecret,
  securityHeaders,
  sessionValue,
  setSessionCookie,
} from "./security.ts";
import { type Settings, SettingsError, type SettingsStore } from "./settings.ts";
import type {
  AssistantModelChangedError,
  ChatTurnKind,
  IssueLite,
  ItemKind,
  ResolveResponse,
  RestorePrudentResponse,
  TierView,
} from "./shared/api-types.ts";
import {
  assistantModelChangedMessage,
  catalogEntry,
  changedSettingsPaths,
  chooseEstimate,
  configProviderIssues,
  describeTurn,
  estimateText,
  isReservedModel,
  MESSAGES,
  MODEL_OVERRIDE_HEADER,
  modelKey,
  modelName,
  parseModelKey,
  presetPermission,
  type Problem,
  problemMessage,
  providerOf,
  resolveChatTurn,
  resolveCommandTurn,
  RULES_VERSION,
  type Run,
  sameModel,
  TASK_SIZES,
  type TaskSize,
  type Tier,
  TIER_IDS,
  type TierDefs,
  type TierResolution,
  type Turn,
  withTierAvailability,
} from "./shared/assistant-rules.ts";
import { StudioApplyError, type StudioScope, type StudioService, StudioValidationError } from "./studio.ts";
import type { StudioKind } from "./studio-schema.ts";
import { TEMPLATES } from "./templates.ts";

/** Niveaux d'IA utilisés par l'API (TierService les fournit). */
export interface TierPort {
  definitions(): TierDefs;
  resolve(id: Tier): TierResolution;
  tierOfModel(model: string): Tier | null;
  priceOf(model: string): ModelPrice | null;
  isExpensive(model: string): boolean;
  taskCost(model: string): { S: number; M: number; L: number } | null;
  views(): TierView[];
}

/** Métadonnées d'assistants utilisées par le proxy et le Studio (AssistantService les fournit). */
export interface AssistantsPort {
  agentTitle(name: string): string;
  taskSizeOf(name: string): TaskSize | null;
  bindLevel(kind: ItemKind, name: string, tier: Tier | null, model: string | null, variant: string | null): void;
}

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
  /** Agents et raccourcis d'opencode (GET /agent, GET /command) en cache court. */
  lookup: OcLookup;
  /** Niveaux d'IA (TierService). */
  tiers: TierPort;
  /** Titres, tailles et liaisons de niveau des assistants (AssistantService). */
  assistants: AssistantsPort;
  /** Accès direct à GitHub Copilot : adresse de l'API, état de la liste des IA, joignabilité à travers le proxy. */
  copilot: Pick<CopilotApi, "status" | "probeHosts" | "resetDiscovery">;
  /** Adresse de l'API Copilot imposée à opencode. */
  copilotConfig: Pick<CopilotConfigSync, "status" | "sync">;
  /** Routes supplémentaires (assistants, niveaux d'IA), enregistrées juste avant le 404 de /api/*. */
  routes?: Array<(app: Hono) => void>;
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
 * - « Résumer » avec autre chose que providerID/modelID : `auto: true` ferait enchaîner par opencode un tour d'agent avec
 *   outils (« Continue if you have next steps », compaction.ts:468-548), hors de tout contrôle ;
 * - connexion GitHub Enterprise vers un domaine autre que COCKPIT_GITHUB_ENTERPRISE_DOMAIN : opencode y
 *   enverrait toutes les demandes et le jeton sous l'identité « github-copilot ».
 */
export function forbiddenProxyBody(method: string, sub: string, body: unknown, enterpriseDomain: string | null): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if ((method === "POST" && sub === "/session") || (method === "PATCH" && /^\/session\/[^/]+$/.test(sub))) {
    const extra = Object.keys(record).filter((key) => key !== "title");
    if (extra.length > 0) return `Champ non accepté pour une conversation : ${extra.join(", ").slice(0, 80)}.`;
  }
  if (method === "POST" && /^\/session\/[^/]+\/summarize$/.test(sub)) {
    const extra = Object.keys(record).filter((key) => key !== "providerID" && key !== "modelID");
    if (extra.length > 0) return `Champ non accepté pour « Résumer » : ${extra.join(", ").slice(0, 80)}.`;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- Demandes d'autorisation -------------------------------------------------------------

/** Réponse à une demande d'autorisation et arrêt d'une conversation, relayés par le proxy. */
const PERMISSION_REPLY_ROUTE = new RegExp(`^/permission/(${ID})/reply$`);
const SESSION_ABORT_ROUTE = new RegExp(`^/session/(${ID})/abort$`);
const ID_RE = new RegExp(`^${ID}$`);

export const PERMISSION_MESSAGES = Object.freeze({
  toujoursRefuse:
    "« Toujours autoriser » est désactivé : opencode l'appliquerait à tous les assistants du projet, y compris ceux qui refusent cette action, jusqu'à son redémarrage.",
  reponseInvalide: "Réponse invalide : « once » ou « reject » uniquement, avec une consigne facultative de 2 000 caractères au plus.",
  demandeExpiree: "Cette demande n'est plus active : la réponse a été arrêtée. Rien n'a été lancé.",
  demandeOrpheline:
    "Cette demande vient d'une réponse arrêtée. La refuser maintenant refuserait aussi les demandes de la réponse en cours : rien n'a été envoyé, réessayez quand celle-ci sera terminée.",
  verificationImpossible:
    "opencode ne répond pas : impossible de vérifier que cette demande est encore active. Rien n'a été envoyé, réessayez dans un instant.",
});

export interface PermissionReply {
  reply: "once" | "reject";
  message?: string;
}

const permissionReplySchema = z.strictObject({ reply: z.enum(["once", "reject"]), message: z.string().max(2_000).optional() });

/**
 * Corps accepté pour répondre à une demande d'autorisation : exactement { reply: "once" | "reject", message? }.
 * « always » est refusé (403) : opencode 1.18.30 ajoute alors { permission, pattern "*", allow } à une liste propre à
 * l'instance, évaluée APRÈS les règles de chaque agent (permission/index.ts:28-38, 145-150). Mesuré : un « Toujours » sur
 * la lecture d'un .env a levé le refus « *.pfx » d'un autre assistant, dans une autre conversation, jusqu'au redémarrage.
 */
export function parsePermissionReply(
  body: unknown,
): { ok: true; value: PermissionReply } | { ok: false; status: 400 | 403; error: string; message: string } {
  const reply = isRecord(body) ? body.reply : undefined;
  if (typeof reply === "string" && reply.trim().toLowerCase() === "always") {
    return { ok: false, status: 403, error: "toujours-refuse", message: PERMISSION_MESSAGES.toujoursRefuse };
  }
  const parsed = permissionReplySchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: "reponse-invalide", message: PERMISSION_MESSAGES.reponseInvalide };
  const { reply: value, message } = parsed.data;
  return { ok: true, value: message === undefined ? { reply: value } : { reply: value, message } };
}

/** Types de contenu relayés depuis opencode ; tout autre (text/html, JavaScript…) est servi en application/json. */
const PROXY_CONTENT_TYPE = /^(?:application\/json|text\/event-stream)\s*(?:;|$)/i;

/**
 * Configuration après un PATCH d'opencode (objets fusionnés clé par clé, autres valeurs remplacées). Objets sans prototype :
 * une clé « __proto__ » reste une donnée et ne peut pas masquer une clé contrôlée.
 */
export function mergeConfigPatch(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) out[key] = value;
  for (const [key, value] of Object.entries(patch)) out[key] = mergeConfigPatch(Object.hasOwn(base, key) ? base[key] : undefined, value);
  return out;
}

/** Nombre de propriétés « permission » au premier niveau (jsonc-parser comme opencode : la dernière l'emporte). */
function permissionKeyCount(source: string): number {
  const root = parseTree(source);
  return root?.type === "object" ? (root.children ?? []).filter((prop) => prop.children?.[0]?.value === "permission").length : 0;
}

/**
 * IA d'une demande facturée, lue dans la SEULE forme qu'opencode 1.18.30 lit pour cette route : `model` objet pour
 * prompt_async (session/prompt.ts:1499-1511), `model` « fournisseur/modèle » pour command (1536-1543),
 * providerID/modelID au premier niveau pour summarize (http_groups_session.ts:65-67). opencode ignore les autres clés
 * sans erreur : un corps qui porte aussi une autre forme (leurre contrôlé à la place de l'IA réellement utilisée) ou
 * aucune IA lisible donne undefined (400 modele-requis).
 */
export function turnModelFromBody(kind: ChatTurnKind, body: unknown): { providerID: string; modelID: string } | undefined {
  if (!isRecord(body)) return undefined;
  const topLevel = Object.hasOwn(body, "providerID") || Object.hasOwn(body, "modelID");
  if (kind === "resume") {
    if (Object.hasOwn(body, "model")) return undefined;
    return typeof body.providerID === "string" && typeof body.modelID === "string" ? { providerID: body.providerID, modelID: body.modelID } : undefined;
  }
  if (topLevel) return undefined;
  const model = body.model;
  if (kind === "message") {
    return isRecord(model) && typeof model.providerID === "string" && typeof model.modelID === "string"
      ? { providerID: model.providerID, modelID: model.modelID }
      : undefined;
  }
  if (typeof model !== "string") return undefined;
  const i = model.indexOf("/");
  return i > 0 ? { providerID: model.slice(0, i), modelID: model.slice(i + 1) } : undefined;
}

// --- Validation des entrées ------------------------------------------------------------

const KINDS = new Set<StudioKind>(["agents", "commands", "skills"]);

const studioBody = z.object({
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string().max(256 * 1024),
  previousName: z.string().max(64).nullable().optional(),
  /** 0.2.0 (agents et commandes) : niveau lié dans item_meta ; absent = liaison inchangée, null = IA précise ou aucune. */
  tier: z.enum(TIER_IDS).nullable().optional(),
});

/** POST /api/chat/resolve (ResolveRequest). */
const resolveBody = z.strictObject({
  directory: z.string().min(1).max(4_096),
  agent: z.string().min(1).max(200),
  tier: z.enum(TIER_IDS).optional(),
  variant: z.string().min(1).max(40).nullable().optional(),
  override: z
    .strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200), variant: z.string().min(1).max(40).optional() })
    .optional(),
  command: z.string().min(1).max(200).optional(),
});

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Demande facturée résolue par le proxy. */
interface ProxyTurn {
  turn: Turn;
  /** Agent du corps (vide pour « Résumer »). */
  agent: string;
  command: string | null;
  /** true : la réflexion calculée par le serveur remplace celle du corps. */
  authoritative: boolean;
  /** false : rien n'est enregistré dans chat_turns (raccourci inconnu d'opencode). */
  record: boolean;
}

const RESET_SECTIONS = ["budget", "pricing", "classifier", "quotaSync", "chat", "ai", "ui"] as const satisfies ReadonlyArray<keyof Settings>;

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

export function createApp(deps: AppDeps): Hono {
  const { env, log, client, catalog, ledger, archive, classifier, studio, projects, control, quota, processor, settings, hub, lookup, tiers, assistants } =
    deps;
  const advanced = advancedOnly(settings);
  const app = new Hono();
  // Secret de session gardé dans la base : un redémarrage garde les sessions, une déconnexion les révoque toutes.
  const SESSION_SECRET_KEY = "session.secret";
  const storeSessionSecret = (): string => {
    const secret = newSessionSecret();
    deps.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(SESSION_SECRET_KEY, secret, Date.now());
    return secret;
  };
  const storedSecret = deps.db.prepare("SELECT value FROM settings WHERE key = ?").get(SESSION_SECRET_KEY) as { value: string } | undefined;
  let sessionSecret = storedSecret && storedSecret.value.length >= 32 ? storedSecret.value : storeSessionSecret();
  const validSession = (cookie: string | undefined) => isValidSession(cookie, env.token, sessionSecret);
  const limiter = new LoginLimiter();

  const fail = (c: Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, message, ...extra }, status as ContentfulStatusCode);

  /** IA de GitHub Copilot et accès à son API, tels que lus à la dernière vérification. */
  const copilotView = () => {
    const sources = catalog.sources;
    const status = deps.copilot.status;
    return {
      // Adresse confirmée par la dernière lecture, ou imposée par .env ; une adresse en échec n'est montrée que comme tentative.
      endpoint: sources.endpoint ?? (status.endpoint?.source === "env" ? status.endpoint : null),
      lastTried: sources.endpoint ? null : status.lastTried,
      verified: sources.copilotVerified,
      error: sources.copilotError ?? status.error,
      discoveryError: status.discoveryError,
      opencodeError: sources.opencodeError,
      unavailable: sources.unavailable,
      configSync: deps.copilotConfig.status,
      enterpriseDomain: env.githubEnterpriseDomain,
    };
  };

  const scopeOf = (c: Context): StudioScope => {
    const project = c.req.query("project");
    return project ? { type: "project", project } : { type: "global" };
  };

  const kindOf = (c: Context): StudioKind => {
    const kind = c.req.param("kind") as StudioKind;
    if (!KINDS.has(kind)) throw new PathError("Type inconnu (agents, commands ou skills).");
    return kind;
  };

  const modelsPayload = () =>
    catalog.list().map((m) => {
      // Prix effectif (surcharges › grille › catalogue) : le même pour le badge « cher », les niveaux et le garde-fou.
      const price = tiers.priceOf(m.key);
      return {
        key: m.key,
        providerID: m.providerID,
        providerName: m.providerName,
        modelID: m.modelID,
        name: m.name,
        price,
        officialPrice: m.providerID === "github-copilot" && Object.hasOwn(COPILOT_PRICES, m.modelID),
        contextLimit: m.contextLimit,
        outputLimit: m.outputLimit,
        reasoning: m.reasoning,
        attachment: m.attachment,
        variants: m.variants,
        expensive: tiers.isExpensive(m.key),
        status: m.status,
        toolcall: m.toolcall,
        tier: tiers.tierOfModel(m.key),
        taskCost: tiers.taskCost(m.key),
        reserved: isReservedModel(m.key, price),
      };
    });

  app.use("*", securityHeaders());
  app.use("*", hostGuard(env.allowedHosts));
  app.use("*", authGuard(validSession));
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
    const outcome = await attemptLogin(limiter, c.req.query("t") ?? "", env.token);
    if (outcome === "blocked") return c.text("Trop de tentatives, réessayez dans quelques minutes.", 429);
    if (outcome === "refused") return c.redirect("/?auth=failed", 303);
    setSessionCookie(c, sessionValue(env.token, sessionSecret));
    return c.redirect("/", 303);
  });

  app.post("/api/login", bodyLimit({ maxSize: 4_096 }), async (c) => {
    const { token } = z.object({ token: z.string().max(512) }).parse(await c.req.json());
    const outcome = await attemptLogin(limiter, token.trim(), env.token);
    if (outcome === "blocked") return fail(c, 429, "rate-limited", "Trop de tentatives, réessayez dans quelques minutes.");
    if (outcome === "refused") return fail(c, 401, "unauthorized", "Jeton incorrect.");
    setSessionCookie(c, sessionValue(env.token, sessionSecret));
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    // Nouveau secret : ce cookie et toutes ses copies (autre navigateur, service local qui l'aurait reçu) sont révoqués.
    sessionSecret = storeSessionSecret();
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // --- Vue d'ensemble -------------------------------------------------------------------

  app.get("/api/bootstrap", async (c) => {
    const s = settings.get();
    const [health, projectList, copilotConnected, caFiles, supervisor, providerIssues] = await Promise.all([
      client.health(),
      projects.list(),
      quota.copilotConnected(),
      control.caFilesCount(),
      control.supervisorPresent(),
      // Verrou réel d'opencode (enabled_providers, IA par défaut) : null si opencode ne répond pas.
      client
        .request<unknown>("GET", "/global/config", { timeoutMs: 3_000 })
        .then((config) => configProviderIssues(config, env.allowedProviders, env.githubEnterpriseDomain), () => null),
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
        providerIssues,
      },
      workspace: { hostDir: process.env.COCKPIT_HOST_WORKSPACE_DIR ?? null, root: projects.opencodeRoot },
      projects: projectList,
      settings: s,
      copilotConnected,
      models: modelsPayload(),
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
      ui: s.ui,
      ai: { tiers: tiers.views(), chatDefaultTier: s.ai.chatDefaultTier, allowModelOverride: s.ai.allowModelOverride },
      rulesVersion: RULES_VERSION,
      allowedProviders: env.allowedProviders,
      copilot: copilotView(),
    });
  });

  app.get("/api/projects", async (c) => c.json(await projects.list()));

  app.get("/api/models", (c) => c.json({ models: modelsPayload(), defaults: catalog.defaults, loadedAt: catalog.loadedAt }));

  app.post("/api/models/refresh", async (c) => {
    await catalog.refresh();
    return c.json({ models: modelsPayload(), defaults: catalog.defaults, loadedAt: catalog.loadedAt });
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

  // --- IA réellement facturée (conception §5.4) ---------------------------------------------

  /** Agent qu'opencode prendrait sans agent valide : `preferred`, sinon build, sinon le premier agent principal visible. */
  const defaultAgent = (snapshot: OcLookupSnapshot, preferred?: string | null): OcAgentInfo => {
    const usable = (name: string) => snapshot.agents.find((a) => a.name === name && a.mode !== "subagent");
    return (
      (preferred ? usable(preferred) : undefined) ??
      usable("build") ??
      snapshot.agents.find((a) => a.mode !== "subagent" && !a.hidden) ?? { name: "build", mode: "primary", permission: [] }
    );
  };

  /** Agent du corps ; inconnu, opencode refusera la demande (« Agent not found ») sans rien facturer. */
  const bodyAgent = (snapshot: OcLookupSnapshot, requested: unknown): OcAgentInfo => {
    if (typeof requested !== "string") return defaultAgent(snapshot);
    return snapshot.agents.find((a) => a.name === requested) ?? { name: requested.slice(0, 200), mode: "primary", permission: [] };
  };

  interface TurnRequest {
    kind: ChatTurnKind;
    directory: string | null;
    record: Record<string, unknown>;
    bodyModel: { providerID: string; modelID: string };
    bodyVariant: string | undefined;
    lite: ReturnType<ModelCatalog["lite"]>;
    names: { agentTitle: (name: string) => string; modelName: (model: string) => string };
  }

  /** Un seul appel sur l'IA du corps (Résumer, repli sans GET /agent, raccourci inconnu). */
  const bodyTurn = (r: TurnRequest, role: Run["role"], agent: string, variant: string | undefined): Turn => ({
    send: variant ? { model: r.bodyModel, variant } : { model: r.bodyModel },
    runs: [{ role, model: modelKey(r.bodyModel), variant: variant ?? null, source: "niveau", agent }],
    lock: null,
    problems: [],
  });

  /** Résout les appels facturés d'une demande relayée ; renvoie une réponse de refus le cas échéant. */
  const resolveProxyTurn = async (c: Context, r: TurnRequest): Promise<Response | ProxyTurn> => {
    if (r.kind === "resume") {
      // Résumer : opencode facture l'IA de l'agent caché « compaction » s'il en a une, sinon celle de la demande
      // (compaction.ts:358-361). Sans GET /agent, contrôle limité à l'IA de la demande (comme pour un message).
      let compaction: OcAgentInfo | undefined;
      try {
        compaction = (await lookup.get(r.directory)).agents.find((a) => a.name === "compaction");
      } catch (err) {
        log.warn("agents d'opencode illisibles : contrôle limité à l'IA de la demande", { error: errorMessage(err) });
      }
      const turn = bodyTurn(r, "message", "", undefined);
      if (compaction?.model) turn.runs = [{ role: "message", model: modelKey(compaction.model), variant: null, source: "assistant", agent: "compaction" }];
      const billedKey = turn.runs[0]?.model ?? modelKey(r.bodyModel);
      if (r.lite.length > 0 && !catalogEntry(r.lite, billedKey)) turn.problems.push({ code: "ia-indisponible", blocking: true, model: billedKey });
      return { turn, agent: "", command: null, authoritative: false, record: true };
    }
    const requestedCommand = r.kind === "raccourci" && typeof r.record.command === "string" ? r.record.command : null;
    let snapshot: OcLookupSnapshot;
    try {
      snapshot = await lookup.get(r.directory);
    } catch (err) {
      // Repli (comportement 0.1.x) : garde-fou sur l'IA du corps seulement, demande relayée telle quelle.
      log.warn("agents d'opencode illisibles : contrôle limité à l'IA de la demande", { error: errorMessage(err) });
      const agent = typeof r.record.agent === "string" ? r.record.agent.slice(0, 200) : "";
      const role = r.kind === "raccourci" ? "raccourci" : "message";
      return { turn: bodyTurn(r, role, agent, r.bodyVariant), agent, command: requestedCommand?.slice(0, 200) ?? null, authoritative: false, record: true };
    }

    const chatAgent = bodyAgent(snapshot, r.record.agent);
    const s = settings.get();
    const allowOverride = s.ui.mode === "avance" && s.ai.allowModelOverride && c.req.header(MODEL_OVERRIDE_HEADER) === "1";
    if (chatAgent.model && !sameModel(chatAgent.model, r.bodyModel) && !allowOverride) {
      // IA fixée par l'assistant : le client renvoie une fois avec celle-ci.
      const lockedKey = modelKey(chatAgent.model);
      if (!env.allowedProviders.includes(chatAgent.model.providerID)) return fail(c, 403, "fournisseur-refuse", MESSAGES.fournisseurRefuse);
      const entry = catalogEntry(r.lite, lockedKey);
      if (r.lite.length > 0 && !entry) {
        const problem: Problem = { code: "assistant-ia-indisponible", blocking: true, model: lockedKey, agent: chatAgent.name };
        return fail(c, 409, "ia-indisponible", problemMessage(problem, r.names));
      }
      const lockedName = r.names.modelName(lockedKey);
      const changed: AssistantModelChangedError = {
        error: "assistant-model-changed",
        message: assistantModelChangedMessage(lockedName),
        agent: chatAgent.name,
        model: { providerID: chatAgent.model.providerID, modelID: chatAgent.model.modelID },
        variant: chatAgent.variant && (!entry || entry.variants.includes(chatAgent.variant)) ? chatAgent.variant : null,
        modelName: lockedName,
      };
      return c.json(changed, 409);
    }

    const chatTurn = resolveChatTurn({
      agent: chatAgent,
      tierModel: r.bodyModel,
      tierVariant: r.bodyVariant ?? null,
      override: allowOverride ? { ...r.bodyModel, ...(r.bodyVariant ? { variant: r.bodyVariant } : {}) } : undefined,
      allowOverride,
      catalog: r.lite,
    });
    if (r.kind === "message") return { turn: chatTurn, agent: chatAgent.name, command: null, authoritative: true, record: true };

    const command = requestedCommand === null ? undefined : snapshot.commands.find((x) => x.name === requestedCommand);
    if (!command) {
      // Raccourci inconnu d'opencode : il répondra lui-même ; garde-fou sur l'IA du corps, rien d'enregistré.
      return { turn: bodyTurn(r, "raccourci", chatAgent.name, r.bodyVariant), agent: chatAgent.name, command: null, authoritative: false, record: false };
    }
    const turn = resolveCommandTurn({ command, agents: snapshot.agents, chatAgent, chatTurn, catalog: r.lite });
    const refused = turn.problems.find((p) => p.blocking && (p.code === "fiche-refusee" || p.code === "agent-du-raccourci-introuvable"));
    if (refused) return fail(c, 403, refused.code, problemMessage(refused, r.names));
    return { turn, agent: chatAgent.name, command: command.name, authoritative: true, record: true };
  };

  /**
   * Contrôle d'une demande facturée (prompt_async, command, summarize), après les filtres de contenu : IA obligatoire,
   * fournisseurs autorisés, IA de l'assistant, fiches, IA disponible, garde-fou sur chaque appel facturé, trace dans
   * chat_turns. Renvoie la réponse de refus, ou le corps à relayer (réflexion fixée par le serveur).
   */
  const enforceTurn = async (c: Context, sub: string, directory: string | null, body: string, parsed: unknown): Promise<Response | string> => {
    const [, , sessionId = "", action = ""] = sub.split("/");
    const kind: ChatTurnKind = action === "command" ? "raccourci" : action === "summarize" ? "resume" : "message";
    const record = isRecord(parsed) ? parsed : {};

    // Toujours une IA explicite, dans la forme lue par opencode pour cette route : sinon opencode prendrait celle de
    // l'agent ou de la session, hors de tout contrôle.
    const bodyModel = turnModelFromBody(kind, parsed);
    if (!bodyModel?.providerID || !bodyModel.modelID || bodyModel.providerID.length > 100 || bodyModel.modelID.length > 200) {
      return fail(c, 400, "modele-requis", "Précisez l'IA de la demande.");
    }
    if (!env.allowedProviders.includes(bodyModel.providerID)) return fail(c, 403, "fournisseur-refuse", MESSAGES.fournisseurRefuse);

    const lite = catalog.lite();
    const names = { agentTitle: (name: string) => assistants.agentTitle(name), modelName: (model: string) => modelName(model, lite) };
    const bodyVariant = typeof record.variant === "string" && record.variant.length > 0 ? record.variant : undefined;
    const resolved = await resolveProxyTurn(c, { kind, directory, record, bodyModel, bodyVariant, lite, names });
    if (resolved instanceof Response) return resolved;
    const { turn } = resolved;

    // Fournisseur de chaque appel facturé (IA d'un agent ou d'un raccourci comprise).
    if (turn.runs.some((run) => !env.allowedProviders.includes(providerOf(run.model)))) {
      return fail(c, 403, "fournisseur-refuse", MESSAGES.fournisseurRefuse);
    }
    const unavailable = turn.problems.find((p) => p.blocking && (p.code === "ia-indisponible" || p.code === "assistant-ia-indisponible"));
    if (unavailable) return fail(c, 409, "ia-indisponible", problemMessage(unavailable, names));

    const mainRun = turn.runs.find((run) => run.role === "message" || run.role === "raccourci") ?? turn.runs[0];
    const refusal = ledger.guardRuns(turn.runs, c.req.header(CONFIRM_HEADER) === "1", {
      command: resolved.command,
      modelName: names.modelName,
      tierOfModel: (model) => tiers.tierOfModel(model),
      size: assistants.taskSizeOf(mainRun?.agent || resolved.agent) ?? "M",
    });
    if (refusal) return c.json(refusal, 409);

    if (resolved.record) {
      try {
        ledger.recordChatTurn({
          session_id: sessionId,
          created_at: Date.now(),
          kind,
          agent: resolved.agent,
          command: resolved.command,
          tier: mainRun ? tiers.tierOfModel(mainRun.model) : null,
          model: modelKey(turn.send.model),
          variant: turn.send.variant ?? null,
          runs: turn.runs,
        });
      } catch (err) {
        log.warn("tour de chat non enregistré", { error: errorMessage(err) });
      }
    }

    // Le serveur fait foi pour la réflexion (§5.2) ; le corps n'est réécrit que si elle change.
    const wanted = turn.send.variant;
    const differs = Object.hasOwn(record, "variant") ? record.variant !== wanted : wanted !== undefined;
    if (!resolved.authoritative || !differs) return body;
    const next: Record<string, unknown> = { ...record };
    if (wanted === undefined) delete next.variant;
    else next.variant = wanted;
    return JSON.stringify(next);
  };

  // --- Demandes d'autorisation : vérification avant de relayer une réponse, nettoyage après un arrêt ----------

  const PERMISSION_LOOKUP_TIMEOUT_MS = 5_000;
  /** Bornes du nettoyage après un arrêt : profondeur de sous-agents, sessions suivies, appels à opencode, refus envoyés. */
  const CLEANUP_MAX_DEPTH = 8;
  const CLEANUP_MAX_SESSIONS = 200;
  const CLEANUP_MAX_CHILDREN_CALLS = 50;
  const CLEANUP_MAX_REJECTS = 100;
  const CALL_ID_MAX_LENGTH = 512;

  /** Appel d'outil qui a posé une demande (tool.messageID, tool.callID). */
  interface PermissionTool {
    messageID: string;
    callID: string;
  }

  interface PendingPermission {
    id: string;
    sessionID: string;
    /** null : demande posée hors d'un appel d'outil ; « invalid » : champ présent mais illisible (rien n'est vérifiable). */
    tool: PermissionTool | "invalid" | null;
  }

  const permissionTool = (value: unknown): PendingPermission["tool"] => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) return "invalid";
    const { messageID, callID } = value;
    return typeof messageID === "string" && ID_RE.test(messageID) && typeof callID === "string" && callID.length > 0 && callID.length <= CALL_ID_MAX_LENGTH
      ? { messageID, callID }
      : "invalid";
  };

  /** Demandes en attente (GET /permission, même dossier) ; erreur si opencode ne répond pas ou répond autre chose qu'une liste. */
  const pendingPermissions = async (directory: string | null): Promise<PendingPermission[]> => {
    const list = await client.request<unknown>("GET", "/permission", { query: { directory }, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
    if (!Array.isArray(list)) throw new Error("liste des demandes d'autorisation illisible");
    return list.flatMap((item) =>
      isRecord(item) && typeof item.id === "string" && typeof item.sessionID === "string"
        ? [{ id: item.id, sessionID: item.sessionID, tool: permissionTool(item.tool) }]
        : [],
    );
  };

  /** Conversations qui travaillent (busy ou retry) : GET /session/status ne liste que les sessions qui ne sont pas au repos. */
  const workingSessions = async (directory: string | null): Promise<Set<string>> => {
    const statuses = await client.request<unknown>("GET", "/session/status", { query: { directory }, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
    if (!isRecord(statuses)) throw new Error("états des conversations illisibles");
    return new Set(Object.entries(statuses).filter(([, s]) => isRecord(s) && (s.type === "busy" || s.type === "retry")).map(([id]) => id));
  };

  /**
   * L'appel d'outil qui a posé la demande est-il encore en cours ? Son message (GET /session/:id/message/:messageID) ne porte
   * pas d'erreur et sa partie « tool » (même callID) est « running ». Après un arrêt, opencode 1.18.30 passe cette partie en
   * « error » (« Tool execution aborted », metadata.interrupted, processor.ts:591-605) mais garde la demande en attente
   * jusqu'à une réponse ou un redémarrage, même quand un nouveau message fait retravailler la conversation.
   * Message introuvable (404) : false. opencode injoignable ou réponse illisible : erreur.
   */
  const toolCallRunning = async (sessionID: string, tool: PermissionTool, directory: string | null): Promise<boolean> => {
    if (!ID_RE.test(sessionID)) throw new Error("identifiant de conversation de la demande illisible");
    let message: unknown;
    try {
      message = await client.request<unknown>("GET", `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(tool.messageID)}`, {
        query: { directory },
        timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) return false;
      throw err;
    }
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) throw new Error("message de la demande illisible");
    if (message.info.error !== undefined && message.info.error !== null) return false;
    const part = message.parts.find((p) => isRecord(p) && p.type === "tool" && p.callID === tool.callID);
    return isRecord(part) && isRecord(part.state) && part.state.status === "running";
  };

  /**
   * File d'attente commune au « once » (vérification puis relais) et à l'arrêt (relais puis liste des demandes du nettoyage).
   * Sans elle, un arrêt relayé entre la vérification et le relais d'un « once » laisserait ce « once » arriver après
   * l'arrêt (sous-agent détaché, facturé, résultat perdu), et le nettoyage ne le verrait pas.
   */
  let replyGateTail: Promise<void> = Promise.resolve();
  const REPLY_GATE_MAX_HOLD_MS = 30_000;
  /** Attend son tour ; renvoie la fonction qui libère la place (sans effet au second appel). */
  const acquireReplyGate = async (): Promise<() => void> => {
    const previous = replyGateTail;
    let resolveTail: () => void = () => undefined;
    replyGateTail = new Promise<void>((resolve) => {
      resolveTail = () => resolve();
    });
    await previous;
    // Borne : un relais qu'opencode laisse sans réponse ne bloque pas indéfiniment les réponses et les arrêts suivants.
    const timer = setTimeout(() => {
      log.warn("file d'attente des réponses libérée : relais sans réponse d'opencode", { holdMs: REPLY_GATE_MAX_HOLD_MS });
      resolveTail();
    }, REPLY_GATE_MAX_HOLD_MS);
    timer.unref();
    return () => {
      clearTimeout(timer);
      resolveTail();
    };
  };

  type OnceVerdict = { ok: true } | { ok: false; status: 409 | 503; request: PendingPermission | null; orphan: boolean };

  /**
   * « once » n'est relayé que si la demande est encore en attente, que sa conversation travaille ET que l'appel d'outil qui
   * l'a posée est toujours en cours. Après un arrêt, un « once » tardif a lancé un sous-agent détaché, facturé, dont le
   * résultat a été perdu (la conversation ne reprend pas). `orphan` : demande d'une conversation au repos, à refuser pour
   * qu'elle ne revienne pas. Vérification impossible : 503, rien n'est relayé. Ne lève jamais.
   */
  const checkOnceReply = async (requestId: string, directory: string | null): Promise<OnceVerdict> => {
    try {
      const [pending, working] = await Promise.all([pendingPermissions(directory), workingSessions(directory)]);
      const request = pending.find((p) => p.id === requestId) ?? null;
      if (request === null) return { ok: false, status: 409, request, orphan: false };
      if (!working.has(request.sessionID)) return { ok: false, status: 409, request, orphan: true };
      if (request.tool === null) return { ok: true };
      if (request.tool === "invalid") throw new Error("appel d'outil de la demande illisible");
      // Conversation qui retravaille (nouveau message) : la demande doit venir d'un appel encore en cours.
      if (await toolCallRunning(request.sessionID, request.tool, directory)) return { ok: true };
      return { ok: false, status: 409, request, orphan: false };
    } catch (err) {
      log.warn("demande d'autorisation non vérifiable : réponse non relayée", { requestId, error: errorMessage(err) });
      return { ok: false, status: 503, request: null, orphan: false };
    }
  };

  /**
   * « Refuser » d'une demande orpheline (appel d'outil qui n'est plus en cours) alors que sa conversation retravaille :
   * opencode refuserait aussi toutes les demandes en attente de cette conversation (permission/index.ts:129-138), donc celles
   * de la réponse en cours, qui échouerait sans explication. Vérification impossible : false (le refus n'autorise rien).
   */
  const isOrphanOfWorkingSession = async (requestId: string, directory: string | null): Promise<boolean> => {
    try {
      const [pending, working] = await Promise.all([pendingPermissions(directory), workingSessions(directory)]);
      const request = pending.find((p) => p.id === requestId);
      if (!request || !working.has(request.sessionID) || request.tool === null || request.tool === "invalid") return false;
      return !(await toolCallRunning(request.sessionID, request.tool, directory));
    } catch (err) {
      log.warn("refus relayé sans vérification : opencode ne répond pas", { requestId, error: errorMessage(err) });
      return false;
    }
  };

  /** Descendants d'une conversation d'après le suivi du cockpit (table sessions, lue par root_id indexé), bornés. */
  const trackedDescendants = (sessionId: string, tree: Set<string>): void => {
    const known = deps.db.prepare("SELECT root_id FROM sessions WHERE id = ?").get(sessionId) as { root_id: string } | undefined;
    const rows = deps.db
      .prepare("SELECT id, parent_id FROM sessions WHERE root_id = ? AND parent_id IS NOT NULL LIMIT ?")
      .all(known?.root_id ?? sessionId, CLEANUP_MAX_SESSIONS * 10) as Array<{ id: string; parent_id: string }>;
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      const list = childrenOf.get(row.parent_id);
      if (list) list.push(row.id);
      else childrenOf.set(row.parent_id, [row.id]);
    }
    let frontier = [sessionId];
    for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of childrenOf.get(id) ?? []) {
          if (tree.has(child) || tree.size >= CLEANUP_MAX_SESSIONS) continue;
          tree.add(child);
          next.push(child);
        }
      }
      frontier = next;
    }
  };

  /** Complète avec GET /session/:id/children (sous-agent pas encore enregistré par le cockpit), borné. */
  const opencodeDescendants = async (sessionId: string, directory: string | null, tree: Set<string>): Promise<void> => {
    const visited = new Set<string>();
    let frontier = [sessionId];
    let calls = 0;
    for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        if (calls >= CLEANUP_MAX_CHILDREN_CALLS || tree.size >= CLEANUP_MAX_SESSIONS) return;
        visited.add(id);
        calls++;
        let children: unknown;
        try {
          children = await client.request<unknown>("GET", `/session/${encodeURIComponent(id)}/children`, {
            query: { directory },
            timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
          });
        } catch (err) {
          log.warn("arrêt : sous-agents d'une conversation illisibles", { sessionId: id, error: errorMessage(err) });
          continue;
        }
        if (!Array.isArray(children)) continue;
        for (const child of children) {
          const childId = isRecord(child) && typeof child.id === "string" && ID_RE.test(child.id) ? child.id : null;
          if (childId === null || visited.has(childId)) continue;
          tree.add(childId);
          next.push(childId);
        }
      }
      frontier = next;
    }
  };

  /**
   * Refuse (« reject ») des demandes orphelines. opencode 1.18.30 applique un refus à TOUTES les demandes en attente de la
   * même conversation (permission/index.ts:129-138) : l'état des conversations est relu juste avant l'envoi, et celles qui
   * travaillent de nouveau sont laissées de côté (la demande d'une nouvelle réponse échouerait sinon). États illisibles :
   * rien n'est envoyé. Au mieux : les erreurs sont journalisées.
   */
  const rejectOrphans = async (requests: PendingPermission[], directory: string | null, context: Record<string, unknown>): Promise<void> => {
    const candidates = requests.filter((p) => ID_RE.test(p.id));
    if (candidates.length === 0) return;
    let working: Set<string>;
    try {
      working = await workingSessions(directory);
    } catch (err) {
      log.warn("demandes d'autorisation orphelines non refusées : états des conversations illisibles", { ...context, error: errorMessage(err) });
      return;
    }
    let rejected = 0;
    let skipped = 0;
    for (const request of candidates) {
      if (working.has(request.sessionID)) {
        skipped++;
        continue;
      }
      try {
        await client.request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, {
          query: { directory },
          body: { reply: "reject" },
          timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
        });
        rejected++;
      } catch (err) {
        log.warn("demande d'autorisation orpheline non refusée", { ...context, requestId: request.id, error: errorMessage(err) });
      }
    }
    log.info("demandes d'autorisation orphelines refusées", { ...context, rejected, skipped, pending: candidates.length });
  };

  /**
   * Après un arrêt réussi : refuse (« reject ») les demandes d'autorisation restées en attente dans la conversation arrêtée
   * et dans ses sous-agents, pour qu'aucun « once » tardif ne lance un travail détaché. `releaseGate` libère la file
   * d'attente des réponses dès la liste lue. Au mieux : les erreurs sont journalisées et la réponse de l'arrêt ne change pas.
   */
  const rejectAbortedPermissions = async (sessionId: string, directory: string | null, releaseGate: () => void): Promise<void> => {
    let pending: PendingPermission[];
    try {
      pending = await pendingPermissions(directory);
    } finally {
      // Liste lue : un « once » qui attendait son tour verra la conversation arrêtée.
      releaseGate();
    }
    if (pending.length === 0) return;
    const tree = new Set([sessionId]);
    trackedDescendants(sessionId, tree);
    if (pending.some((p) => !tree.has(p.sessionID))) await opencodeDescendants(sessionId, directory, tree);
    const stale = pending.filter((p) => tree.has(p.sessionID)).slice(0, CLEANUP_MAX_REJECTS);
    await rejectOrphans(stale, directory, { cause: "arrêt", sessionId });
  };

  // --- Proxy vers opencode --------------------------------------------------------------

  app.all("/api/oc/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
    const sub = c.req.path.slice("/api/oc".length) || "/";
    const method = c.req.method.toUpperCase();
    const matched = PROXY_RULES.find((r) => r.method === method && r.pattern.test(sub));
    if (!matched) return fail(c, 404, "not-allowed", `Route opencode non autorisée : ${method} ${sub}`);
    // Configuration en cours d'application ou redémarrage : opencode couperait cette demande facturée.
    if (matched.guarded && (configApplying || control.restarting)) return fail(c, 409, "redemarrage-en-cours", MESSAGES.restartEnCours);

    const incoming = new URL(c.req.url);
    const target = client.url(sub);
    for (const [key, value] of incoming.searchParams) if (ALLOWED_QUERY.has(key)) target.searchParams.set(key, value);
    const directory = target.searchParams.get("directory");
    if (directory !== null && !projects.isAllowedDirectory(directory)) {
      return fail(c, 403, "forbidden-directory", "Ce dossier est hors du workspace monté.");
    }

    // Place dans la file d'attente des réponses (« once » vérifié, arrêt) : libérée au plus tard en sortant.
    let releaseGate: (() => void) | undefined;
    try {
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
        const replyTo = method === "POST" ? PERMISSION_REPLY_ROUTE.exec(sub)?.[1] : undefined;
        if (replyTo !== undefined) {
          const reply = parsePermissionReply(parsed);
          if (!reply.ok) return fail(c, reply.status, reply.error, reply.message);
          if (reply.value.reply === "once") {
            // Gardée jusqu'au relais : aucun arrêt ne peut s'intercaler entre la vérification et le « once ».
            releaseGate = await acquireReplyGate();
            const verdict = await checkOnceReply(replyTo, directory);
            if (!verdict.ok) {
              releaseGate();
              if (verdict.status === 503) return fail(c, 503, "verification-impossible", PERMISSION_MESSAGES.verificationImpossible);
              log.info("demande d'autorisation qui n'est plus active : « once » non relayé", { requestId: replyTo, found: verdict.request !== null });
              // Demande orpheline d'une conversation au repos : refusée, pour qu'elle ne redevienne pas autorisable plus tard.
              if (verdict.orphan && verdict.request) await rejectOrphans([verdict.request], directory, { cause: "réponse tardive", requestId: replyTo });
              return fail(c, 409, "demande-expiree", PERMISSION_MESSAGES.demandeExpiree);
            }
          } else if (await isOrphanOfWorkingSession(replyTo, directory)) {
            log.info("refus d'une demande orpheline non relayé : la conversation retravaille", { requestId: replyTo });
            return fail(c, 409, "demande-orpheline", PERMISSION_MESSAGES.demandeOrpheline);
          }
          // Corps réécrit : opencode reçoit exactement ce qui a été contrôlé (ni clé en double, ni champ ignoré).
          body = JSON.stringify(reply.value);
        }
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
          const enforced = await enforceTurn(c, sub, directory, body, parsed);
          if (enforced instanceof Response) return enforced;
          body = enforced;
        }
      }

      const abortId = method === "POST" ? SESSION_ABORT_ROUTE.exec(sub)?.[1] : undefined;
      // Arrêt : attend qu'un « once » en cours de vérification soit relayé, puis garde la file jusqu'à la liste du nettoyage.
      const abortGate = abortId !== undefined ? await acquireReplyGate() : undefined;
      if (abortGate !== undefined) releaseGate = abortGate;
      const upstream = await client.raw(method, target, {
        headers: {
          accept: c.req.header("accept") ?? "application/json",
          ...(body !== null ? { "content-type": "application/json" } : {}),
        },
        body: body === null || body === "" ? null : body,
        signal: c.req.raw.signal,
      });
      if (abortId !== undefined && abortGate !== undefined && upstream.ok) {
        // Sans attendre : la réponse de l'arrêt part tout de suite et reste celle d'opencode ; le nettoyage libère la file.
        releaseGate = undefined;
        void rejectAbortedPermissions(abortId, directory, abortGate).catch((err: unknown) =>
          log.warn("arrêt : demandes d'autorisation en attente non vérifiées", { sessionId: abortId, error: errorMessage(err) }),
        );
      }
      const headers = new Headers();
      const contentType = upstream.headers.get("content-type");
      // Jamais de document ni de script servi sous l'origine du cockpit, même si opencode (ou un faux serveur) le demandait.
      if (contentType) headers.set("content-type", PROXY_CONTENT_TYPE.test(contentType) ? contentType : "application/json");
      return new Response(upstream.body, { status: upstream.status, headers });
    } finally {
      releaseGate?.();
    }
  });

  // --- Chat : IA réellement utilisée (même résolution que le proxy) ------------------------

  app.post("/api/chat/resolve", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const req = resolveBody.parse(await c.req.json());
    if (!projects.isAllowedDirectory(req.directory)) return fail(c, 403, "forbidden-directory", "Ce dossier est hors du workspace monté.");
    let snapshot: OcLookupSnapshot;
    try {
      snapshot = await lookup.get(req.directory);
    } catch (err) {
      log.warn("résolution de l'IA impossible : opencode injoignable", { error: errorMessage(err) });
      return fail(c, 502, "opencode-unreachable", MESSAGES.opencodeInjoignable);
    }
    const s = settings.get();
    const lite = catalog.lite();
    const requested = snapshot.agents.find((a) => a.name === req.agent && a.mode !== "subagent");
    const agent = requested ?? defaultAgent(snapshot, s.chat.defaultAgent);
    const tier = req.tier ?? s.ai.chatDefaultTier;
    const res = tiers.resolve(tier);
    const plannedModel = tiers.definitions()[tier].candidates[0] ?? null;
    const override = s.ui.mode === "avance" ? req.override : undefined;
    if (override && !env.allowedProviders.includes(override.providerID)) return fail(c, 403, "fournisseur-refuse", MESSAGES.fournisseurRefuse);
    const chatTurn = resolveChatTurn({
      agent,
      tierModel: parseModelKey(res.model ?? plannedModel ?? ""),
      tierVariant: req.variant !== undefined ? req.variant : res.variant,
      override,
      allowOverride: s.ui.mode === "avance" && s.ai.allowModelOverride,
      catalog: lite,
    });
    let turn = chatTurn;
    if (req.command !== undefined) {
      const command = snapshot.commands.find((x) => x.name === req.command);
      if (!command) return fail(c, 404, "not-found", "Raccourci introuvable.");
      turn = resolveCommandTurn({ command, agents: snapshot.agents, chatAgent: agent, chatTurn, catalog: lite });
    }
    // Niveau « Indisponible » : l'IA prévue sert seulement à nommer le problème, rien ne part dessus.
    turn = withTierAvailability(turn, res.status);
    const agentTitle = (name: string) => assistants.agentTitle(name);
    const display = describeTurn(turn, {
      catalog: lite,
      agentTitle,
      tierOfModel: (model) => tiers.tierOfModel(model),
      priceOf: (model) => tiers.priceOf(model),
      size: assistants.taskSizeOf(agent.name) ?? "M",
      command: req.command ?? null,
      chatTier: agent.model ? null : { id: tier, status: res.status, plannedModel },
    });
    const response: ResolveResponse = {
      ...turn,
      agent: agent.name,
      agentTitle: agentTitle(agent.name),
      agentMissing: requested ? null : req.agent,
      tier: agent.model ? tiers.tierOfModel(modelKey(agent.model)) : tier,
      tierStatus: agent.model ? null : res.status,
      command: req.command ?? null,
      delegated: display.delegated,
      bodyModel: modelKey(turn.send.model),
      display,
    };
    return c.json(response);
  });

  app.get("/api/chat/choices/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    if (!SESSION_ID_RE.test(sessionId)) return fail(c, 400, "invalid", "Identifiant de conversation invalide.");
    return c.json(ledger.lastChatChoice(sessionId));
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
    const q = z
      .object({
        provider: z.string().min(1).max(100),
        model: z.string().min(1).max(200),
        agent: z.string().min(1).max(64).optional(),
        size: z.enum(TASK_SIZES).optional(),
      })
      .parse(c.req.query());
    const ref = { providerID: q.provider, modelID: q.model };
    // Moyenne observée de l'agent (5 demandes au moins), sinon profil S/M/L au prix effectif.
    const estimate = chooseEstimate(q.agent ? ledger.estimateAgent(q.agent, ref) : null, tiers.priceOf(modelKey(ref)), q.size ?? "M");
    return c.json({
      ...ledger.estimate(q.provider, q.model),
      guard: ledger.guard(ref, false),
      estimate: estimate ? { ...estimate, text: estimateText(estimate), detailText: estimateText(estimate, true) } : null,
    });
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

  /** Renommage dans le Studio : la ligne item_meta suit le fichier (une ligne orpheline au nouveau nom est remplacée). */
  const moveItemMeta = (kind: ItemKind, from: string, to: string) => {
    transaction(deps.db, () => {
      if (!deps.db.prepare("SELECT 1 FROM item_meta WHERE kind = ? AND name = ?").get(kind, from)) return;
      deps.db.prepare("DELETE FROM item_meta WHERE kind = ? AND name = ?").run(kind, to);
      deps.db.prepare("UPDATE item_meta SET name = ?, updated_at = ? WHERE kind = ? AND name = ?").run(to, Date.now(), kind, from);
    });
  };

  app.get("/api/studio/templates", (c) => c.json(TEMPLATES));

  app.get("/api/studio/instructions", async (c) => c.json(await studio.getInstructions(scopeOf(c))));

  app.put("/api/studio/instructions", advanced, bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(await c.req.json());
    await studio.saveInstructions(scopeOf(c), content);
    return c.json({ ok: true });
  });

  app.get("/api/studio/skills/:name/file", async (c) => {
    const content = await studio.readSkillFile(c.req.param("name"), c.req.query("file") ?? "", scopeOf(c));
    if (content === null) return fail(c, 404, "not-found", "Fichier introuvable.");
    return c.json({ content });
  });

  app.put("/api/studio/skills/:name/file", advanced, bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string() }).parse(await c.req.json());
    await studio.writeSkillFile(c.req.param("name"), c.req.query("file") ?? "", content, scopeOf(c));
    return c.json({ ok: true });
  });

  app.delete("/api/studio/skills/:name/file", advanced, async (c) => {
    await studio.deleteSkillFile(c.req.param("name"), c.req.query("file") ?? "", scopeOf(c));
    return c.json({ ok: true });
  });

  app.get("/api/studio/:kind", async (c) => c.json(await studio.list(kindOf(c), scopeOf(c))));

  app.get("/api/studio/:kind/:name", async (c) => {
    const item = await studio.get(kindOf(c), c.req.param("name"), scopeOf(c));
    if (!item) return fail(c, 404, "not-found", "Élément introuvable.");
    return c.json(item);
  });

  app.put("/api/studio/:kind/:name", advanced, bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
    const input = studioBody.parse(await c.req.json());
    const kind = kindOf(c);
    const scope = scopeOf(c);
    const item = await studio.save(kind, scope, {
      name: c.req.param("name"),
      previousName: input.previousName ?? null,
      frontmatter: input.frontmatter,
      body: input.body,
    });
    // item_meta n'a pas de portée : seuls les éléments globaux y sont suivis (renommage, niveau lié avec l'IA écrite).
    const metaKind: ItemKind | null = item.kind === "agents" || item.kind === "commands" ? item.kind : null;
    if (metaKind !== null && scope.type === "global") {
      try {
        if (input.previousName && input.previousName !== item.name) moveItemMeta(metaKind, input.previousName, item.name);
        const model = typeof item.frontmatter.model === "string" ? item.frontmatter.model : null;
        const variant = typeof item.frontmatter.variant === "string" ? item.frontmatter.variant : null;
        if (input.tier !== undefined) {
          assistants.bindLevel(metaKind, item.name, input.tier, model, variant);
        } else {
          // Ligne sans niveau (IA précise) : l'IA écrite ici devient l'IA appliquée, sinon la modification faite dans le
          // cockpit s'afficherait « Modifié hors du cockpit ». Une ligne liée à un niveau garde son IA appliquée.
          const row = deps.db.prepare("SELECT tier FROM item_meta WHERE kind = ? AND name = ?").get(metaKind, item.name) as { tier: string | null } | undefined;
          if (row?.tier === null) assistants.bindLevel(metaKind, item.name, null, model, variant);
        }
      } catch (err) {
        log.warn("métadonnées d'assistant non mises à jour pour cet élément", { kind, name: item.name, error: errorMessage(err) });
      }
    }
    await catalog.refresh().catch(() => undefined);
    hub.cockpit("studio.changed", { kind: item.kind, name: item.name });
    return c.json(item);
  });

  app.delete("/api/studio/:kind/:name", advanced, async (c) => {
    const kind = kindOf(c);
    const scope = scopeOf(c);
    const name = c.req.param("name");
    const deleted = await studio.remove(kind, name, scope);
    // Suppression voulue depuis le cockpit : la ligne item_meta part avec le fichier (sinon « Fichier introuvable »).
    if (deleted && kind !== "skills" && scope.type === "global") {
      try {
        deps.db.prepare("DELETE FROM item_meta WHERE kind = ? AND name = ?").run(kind, name);
      } catch (err) {
        log.warn("métadonnées d'assistant non supprimées", { kind, name, error: errorMessage(err) });
      }
    }
    hub.cockpit("studio.changed", { kind, name });
    return c.json({ deleted });
  });

  // --- Configuration opencode ------------------------------------------------------------

  const configFile = async () => {
    for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
      const file = path.join(env.opencodeConfigDir, name);
      if ((await readInside(env.opencodeConfigDir, file)) !== null) return file;
    }
    return path.join(env.opencodeConfigDir, "opencode.jsonc");
  };

  app.get("/api/opencode/config", async (c) => c.json(await client.request("GET", "/global/config", { timeoutMs: 15_000 })));

  /** Écriture qui retirerait le verrou « fournisseurs » d'opencode (enabled_providers, IA par défaut ou d'un agent). */
  const refuseProviders = (c: Context, issues: IssueLite[]) => fail(c, 422, "fournisseur-refuse", MESSAGES.providerLockRefused, { issues });

  app.patch("/api/opencode/config", advanced, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const patch = z.record(z.string(), z.unknown()).parse(await c.req.json());
    // Contrôle sur la configuration résultante : un correctif sans rapport reste refusé tant que le verrou manque.
    const current = await client.request<unknown>("GET", "/global/config", { timeoutMs: 15_000 });
    const issues = configProviderIssues(mergeConfigPatch(current, patch), env.allowedProviders, env.githubEnterpriseDomain);
    if (issues.length > 0) return refuseProviders(c, issues);
    const updated = await client.request("PATCH", "/global/config", { body: patch, timeoutMs: 30_000 });
    await client.request("POST", "/global/dispose", { timeoutMs: 20_000 }).catch(() => undefined);
    await catalog.refresh().catch(() => undefined);
    hub.cockpit("opencode.config.changed", {});
    return c.json(updated);
  });

  app.get("/api/opencode/config/raw", async (c) => {
    const file = await configFile();
    return c.json({ file: path.basename(file), content: (await readInside(env.opencodeConfigDir, file)) ?? "" });
  });

  /** Conversation en cours : un redémarrage d'opencode la couperait. */
  const sessionsBusy = () => probeSessionsBusy({ client, projects, db: deps.db });

  // Une application de configuration à la fois : chacune peut redémarrer opencode.
  let configQueue: Promise<unknown> = Promise.resolve();
  const oneConfigWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const run = configQueue.then(task, task);
    configQueue = run.catch(() => undefined);
    return run;
  };

  type ConfigFailure =
    | "sessions-busy"
    | "redemarrage-en-cours"
    | "opencode-injoignable"
    | "redemarrage-echoue"
    | "configuration-non-confirmee"
    | "rejected-by-opencode";
  type ConfigApply = { ok: true; restarted: boolean } | { ok: false; error: ConfigFailure; message: string; restarted: boolean };

  const restartInProgress = (): Extract<ConfigApply, { ok: false }> => ({
    ok: false,
    error: "redemarrage-en-cours",
    message: MESSAGES.restartEnCours,
    restarted: false,
  });
  const opencodeUnreachable = (): Extract<ConfigApply, { ok: false }> => ({
    ok: false,
    error: "opencode-injoignable",
    message: MESSAGES.opencodeInjoignable,
    restarted: false,
  });

  /**
   * Verdict d'opencode sur la configuration relue après un redémarrage : null si elle est acceptée, `refus` pour un 400
   * (ConfigInvalidError, comme la vérification du Studio), `incertain` si opencode répond mal trois fois de suite.
   */
  const configVerdict = async (): Promise<{ refus: string } | { incertain: string } | null> => {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3_000));
      try {
        await client.request("GET", "/global/config", { timeoutMs: 30_000 });
        await client.request("GET", "/agent", { timeoutMs: 30_000 });
        return null;
      } catch (err) {
        if (err instanceof OpencodeError && err.status === 400) return { refus: errorMessage(err) };
        last = errorMessage(err);
      }
    }
    return { incertain: last };
  };

  /** Remet la version précédente du fichier (supprimé s'il n'existait pas). */
  const restoreConfig = (file: string, backup: string | null) => (backup === null ? fs.rm(file, { force: true }) : writeFileAtomic(file, backup));

  /** Redémarrage qui applique le fichier déjà écrit, puis verdict ; version précédente remise sur refus ou échec. */
  const restartOnConfig = async (file: string, backup: string | null, what: string): Promise<ConfigApply> => {
    let refusal: string;
    try {
      const restart = await control.restartOpencode(`application : ${what}`);
      if (restart.ok) {
        const verdict = await configVerdict();
        if (verdict === null) {
          await catalog.refresh().catch(() => undefined);
          return { ok: true, restarted: true };
        }
        // opencode tourne avec ce fichier sans le confirmer : il est gardé (un fichier invalide l'arrête au démarrage ou donne un 400).
        if ("incertain" in verdict) {
          return { ok: false, error: "configuration-non-confirmee", message: `${MESSAGES.configNonConfirmee} (${verdict.incertain})`, restarted: true };
        }
        refusal = verdict.refus;
      } else if (restart.failure === "arrets-repetes") {
        // opencode répondait juste avant l'écriture (sondage des réponses en cours) : ses arrêts répétés viennent du fichier.
        refusal = restart.message;
      } else {
        await restoreConfig(file, backup);
        const hint = restart.failure === "delai-depasse" ? ` ${MESSAGES.redemarrerDepuisDiagnostic}` : "";
        return { ok: false, error: "redemarrage-echoue", message: `${restart.message} ${MESSAGES.configRemise}${hint}`, restarted: false };
      }
    } catch (err) {
      await restoreConfig(file, backup);
      return {
        ok: false,
        error: "redemarrage-echoue",
        message: `${errorMessage(err)} ${MESSAGES.configRemise} ${MESSAGES.redemarrerDepuisDiagnostic}`,
        restarted: false,
      };
    }
    await restoreConfig(file, backup);
    const back = await control.restartOpencode(`retour arrière : ${what}`).catch((err: unknown) => ({ ok: false, message: errorMessage(err) }));
    if (!back.ok) {
      return {
        ok: false,
        error: "redemarrage-echoue",
        message: `opencode a refusé ce fichier (${refusal}). ${MESSAGES.configRemise} Mais opencode ne redémarre pas : ${back.message}`,
        restarted: false,
      };
    }
    return { ok: false, error: "rejected-by-opencode", message: refusal, restarted: true };
  };

  /** Application de configuration en cours : les demandes facturées sont refusées (le redémarrage les couperait). */
  let configApplying = false;

  /**
   * Écrit la configuration globale puis redémarre opencode pour l'appliquer : opencode 1.18.30 la garde en mémoire et ne relit
   * pas une écriture directe du fichier, même après /global/dispose (mesuré). Jamais pendant une réponse ni un redémarrage.
   */
  const applyConfigFile = async (file: string, content: string, backup: string | null, what: string): Promise<ConfigApply> => {
    if (control.restarting) return restartInProgress();
    configApplying = true;
    try {
      let busy: boolean;
      try {
        busy = await sessionsBusy();
      } catch {
        return opencodeUnreachable();
      }
      if (busy) return { ok: false, error: "sessions-busy", message: MESSAGES.configRestartBusy, restarted: false };
      await writeFileAtomic(file, content);
      const outcome = await restartOnConfig(file, backup, what);
      // Après le dernier redémarrage : l'interface relit la configuration qui tourne vraiment.
      hub.cockpit("opencode.config.changed", {});
      return outcome;
    } finally {
      configApplying = false;
    }
  };

  const configFailure = (c: Context, result: Extract<ConfigApply, { ok: false }>, refused: string) => {
    switch (result.error) {
      case "sessions-busy":
      case "redemarrage-en-cours":
        return fail(c, 409, result.error, result.message);
      case "rejected-by-opencode":
        return fail(c, 422, result.error, `${refused} : ${result.message}`, { restarted: result.restarted });
      default:
        return fail(c, 503, result.error, result.message);
    }
  };

  app.put("/api/opencode/config/raw", advanced, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(await c.req.json());
    const issues = configProviderIssues(parseJsonc(content, [], { allowTrailingComma: true }), env.allowedProviders, env.githubEnterpriseDomain);
    if (issues.length > 0) return refuseProviders(c, issues);
    const root = env.opencodeConfigDir;
    const file = await assertInside(root, await configFile());
    const result = await oneConfigWrite(async (): Promise<ConfigApply> => {
      if (control.restarting) return restartInProgress();
      // Relue dans la file, sans suivre de lien : c'est la version remise en cas de refus.
      const backup = await readInside(root, file);
      return backup === content ? { ok: true, restarted: false } : applyConfigFile(file, content, backup, "fichier de configuration brut");
    });
    if (!result.ok) return configFailure(c, result, "opencode a refusé ce fichier");
    return c.json({ ok: true, restarted: result.restarted });
  });

  const permissionAction = z.enum(["ask", "allow", "deny"]);
  const permissionSchema = z.record(
    z.string().min(1).max(64),
    z.union([permissionAction, z.record(z.string().min(1).max(512), permissionAction)]),
  );

  type PermissionWrite =
    | ConfigApply
    | { ok: false; error: "permissions-non-appliquees"; message: string; restarted: boolean }
    | { ok: false; error: "fournisseur-refuse"; message: string; restarted: false; issues: IssueLite[] };

  // Remplace le bloc « permission » d'un seul tenant (commentaires du fichier conservés). Le PATCH d'opencode
  // fusionne clé par clé : il garderait d'anciennes règles et échoue quand une valeur texte devient un objet.
  const replacePermission = (permission: Record<string, unknown>, what: string): Promise<PermissionWrite> =>
    oneConfigWrite(async (): Promise<PermissionWrite> => {
      if (control.restarting) return restartInProgress();
      const root = env.opencodeConfigDir;
      const file = await assertInside(root, await configFile());
      // Sans suivre de lien : ce texte est réécrit dans le dossier partagé avec opencode.
      const backup = await readInside(root, file);
      const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
      let source = backup ?? "{}\n";
      // Clés « permission » en double : modify() changerait la première, opencode lit la dernière. Les premières sont retirées.
      for (let count = permissionKeyCount(source); count > 1; count--) source = applyEdits(source, modify(source, ["permission"], undefined, format));
      const content = applyEdits(source, modify(source, ["permission"], permission, format));
      // Le fichier obtenu est appliqué tel quel au redémarrage : il doit garder le verrou « fournisseurs », comme le fichier brut.
      const issues = configProviderIssues(parseJsonc(content, [], { allowTrailingComma: true }), env.allowedProviders, env.githubEnterpriseDomain);
      if (issues.length > 0) return { ok: false, error: "fournisseur-refuse", message: MESSAGES.providerLockRefused, restarted: false, issues };
      // Règles déjà appliquées par opencode : fichier mis au propre, sans redémarrage.
      const current = await client.request<unknown>("GET", "/global/config", { timeoutMs: 20_000 }).catch(() => undefined);
      if (current === undefined) return opencodeUnreachable();
      if (isRecord(current) && isDeepStrictEqual(current.permission, permission)) {
        if (content !== backup) await writeFileAtomic(file, content);
        return { ok: true, restarted: false };
      }
      const result = await applyConfigFile(file, content, backup, what);
      if (!result.ok) return result;
      // Règles réellement appliquées (opencode fusionne config.json, opencode.json puis opencode.jsonc) : jamais de faux succès.
      const effective = await client.request<unknown>("GET", "/global/config", { timeoutMs: 20_000 }).catch(() => null);
      if (isRecord(effective) && isDeepStrictEqual(effective.permission, permission)) return result;
      if (!isRecord(effective)) {
        return {
          ok: false,
          error: "permissions-non-appliquees",
          restarted: true,
          message: "Permissions écrites et opencode redémarré, mais les règles appliquées n'ont pas pu être relues. Rechargez la page pour vérifier.",
        };
      }
      const others: string[] = [];
      for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
        if (name !== path.basename(file) && (await readInside(root, path.join(root, name)).catch(() => "")) !== null) others.push(name);
      }
      const cause = others.length > 0 ? ` : ${others.join(", ")} y ajoute ou y change des règles` : "";
      return {
        ok: false,
        error: "permissions-non-appliquees",
        restarted: true,
        message: `Permissions écrites dans ${path.basename(file)}, mais opencode en applique d'autres${cause}. Corrigez la configuration (Paramètres › opencode) puis réessayez.`,
      };
    });

  const permissionFailure = (c: Context, result: Extract<PermissionWrite, { ok: false }>) => {
    if (result.error === "fournisseur-refuse") return refuseProviders(c, result.issues);
    if (result.error === "permissions-non-appliquees") return fail(c, 422, result.error, result.message);
    return configFailure(c, result, "opencode a refusé ces permissions");
  };

  app.put("/api/opencode/config/permission", advanced, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { permission } = z.object({ permission: permissionSchema }).parse(await c.req.json());
    const result = await replacePermission(permission, "permissions globales");
    if (!result.ok) return permissionFailure(c, result);
    return c.json({ ok: true, restarted: result.restarted });
  });

  // Paramètres › Sécurité (les deux modes) : revenir au profil Prudent, avec la même écriture vérifiée.
  app.post("/api/security/restore-prudent", bodyLimit({ maxSize: 4_096 }), async (c) => {
    z.strictObject({}).parse(await c.req.json().catch(() => null));
    const permission = presetPermission("prudent");
    const result = await replacePermission(permission, "profil Prudent");
    if (!result.ok) return permissionFailure(c, result);
    const response: RestorePrudentResponse = { ok: true, permission, restarted: result.restarted };
    return c.json(response);
  });

  // --- Paramètres du cockpit ------------------------------------------------------------

  app.get("/api/settings", (c) => c.json(settings.get()));

  /** Candidats de niveaux d'un correctif dont le fournisseur n'est pas autorisé (COCKPIT_ALLOWED_PROVIDERS). */
  const tierProviderIssues = (patch: unknown): IssueLite[] => {
    const tiersPatch = isRecord(patch) && isRecord(patch.ai) ? patch.ai.tiers : undefined;
    if (!isRecord(tiersPatch)) return [];
    const issues: IssueLite[] = [];
    for (const id of TIER_IDS) {
      const def = tiersPatch[id];
      const candidates: unknown[] = isRecord(def) && Array.isArray(def.candidates) ? def.candidates : [];
      candidates.forEach((candidate, index) => {
        if (typeof candidate === "string" && candidate.includes("/") && !env.allowedProviders.includes(providerOf(candidate))) {
          issues.push({ path: `ai.tiers.${id}.candidates.${index}`, message: MESSAGES.fournisseurRefuse });
        }
      });
    }
    return issues;
  };

  /** Réglages d'une seule IA hors niveaux (IA de classement, ancienne IA du chat) : même verrou que les niveaux. */
  const SINGLE_MODEL_SETTINGS = [
    ["classifier", "model"],
    ["chat", "defaultModel"],
  ] as const;

  // Mode Simple : seuls les chemins de SIMPLE_SETTINGS_PATHS peuvent changer (settingsPatchGuard, 403 mode-avance).
  app.put("/api/settings", bodyLimit({ maxSize: 256 * 1024 }), settingsPatchGuard(settings), async (c) => {
    const patch: unknown = await c.req.json();
    const changed = changedSettingsPaths(settings.get(), patch);
    const issues = changed.some((p) => p === "ai.tiers" || p.startsWith("ai.tiers.")) ? tierProviderIssues(patch) : [];
    for (const [section, key] of SINGLE_MODEL_SETTINGS) {
      const at = `${section}.${key}`;
      if (!changed.includes(at)) continue;
      const group = isRecord(patch) ? patch[section] : undefined;
      const value = isRecord(group) ? group[key] : undefined;
      if (typeof value === "string" && !env.allowedProviders.includes(providerOf(value))) issues.push({ path: at, message: MESSAGES.fournisseurRefuse });
    }
    if (issues.length > 0) return fail(c, 422, "validation", MESSAGES.fournisseurRefuse, { issues });
    const next = settings.update(patch);
    if (changed.some((p) => p === "ai" || p.startsWith("ai."))) hub.cockpit("ai.changed", { reason: "settings" });
    return c.json(next);
  });

  // Mode Simple : seule la section budget peut être réinitialisée (settingsResetGuard).
  app.post("/api/settings/reset", bodyLimit({ maxSize: 4_096 }), settingsResetGuard(settings), async (c) => {
    const { section } = z.object({ section: z.enum(RESET_SECTIONS) }).parse(await c.req.json());
    const next = settings.reset(section);
    if (section === "ai") hub.cockpit("ai.changed", { reason: "settings" });
    return c.json(next);
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
      copilot: copilotView(),
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

  // Test de la connexion Copilot (page Diagnostic) : joignabilité des adresses GitHub et Copilot à travers le proxy, sans
  // jeton, puis nouvelle lecture de la liste des IA (jeton envoyé seulement aux adresses officielles) et réalignement d'opencode.
  app.post("/api/system/copilot-check", bodyLimit({ maxSize: 4_096 }), async (c) => {
    deps.copilot.resetDiscovery();
    const hosts = await deps.copilot.probeHosts();
    const catalogError = await catalog.refresh().then(
      () => null,
      (err: unknown) => errorMessage(err),
    );
    const sync = await deps.copilotConfig.sync();
    return c.json({ hosts, catalogError, sync, copilot: copilotView() });
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

  for (const register of deps.routes ?? []) register(app);

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
