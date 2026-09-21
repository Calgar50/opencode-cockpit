// Application HTTP : API du cockpit, proxy filtré vers opencode, flux SSE et fichiers de l'interface.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ArchiveService } from "./archive.ts";
import { probeSessionsBusy, probeSessionsBusyStrict } from "./assistants.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { Classifier } from "./classifier.ts";
import { type BillRefusal, billRefusal, ConfigWriteQueue } from "./config-queue.ts";
import type { InternalAgentsPort, PermissionGate } from "./contracts-11.ts";
import type { ControlService, RestartResult } from "./control.ts";
import type { CopilotApi } from "./copilot.ts";
import { transaction } from "./db.ts";
import { type AppEnv, omoOf } from "./env.ts";
import { assertInside, PathError, readIfExists, readInside, writeFileAtomic } from "./fsutil.ts";
import { applyEdits, modify, parse as parseJsonc, parseTree } from "jsonc-parser";
import type { BrowserEvent, EventHub } from "./hub.ts";
import { createInstanceRouter } from "./instance-router.ts";
import { type Ledger, MONTH_RE, monthKey } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import { advancedOnly, MODE_AVANCE_ERROR, settingsPatchGuard, settingsResetGuard } from "./mode.ts";
import {
  examining,
  forMethods,
  reloadGuard,
  type ReloadGuardDeps,
  type ReloadGuardOptions,
  reloadOccupancy,
  type ReloadRefusal,
  reloadRefusal,
} from "./reload-guard.ts";
import type { CopilotConfigSync } from "./oc-copilot-config.ts";
import type { OcAgentInfo, OcLookup, OcLookupSnapshot } from "./oc-lookup.ts";
import { createOcProxy, isRecord, PROXY_RULES, PROXY_RULES_OMO, type ProxyHooks, refusMontageSalle } from "./oc-proxy.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { COPILOT_PRICES, type ModelPrice, PRICING_AS_OF, PRICING_SOURCE_URL, USD_PER_CREDIT } from "./pricing.ts";
import type { EventProcessor } from "./processor.ts";
import type { ProjectsService } from "./projects.ts";
import type { QuotaSync } from "./quota.ts";
import {
  AuthTickets,
  attemptLogin,
  attemptTicketLogin,
  authGuard,
  CONFIRM_HEADER,
  clearSessionCookie,
  csrfGuard,
  healthProof,
  hostGuard,
  isGeneratedToken,
  isHealthChallenge,
  isValidSession,
  LoginLimiter,
  newSessionSecret,
  securityHeaders,
  sessionValue,
  setSessionCookie,
} from "./security.ts";
import type { LocalTls } from "./server-start.ts";
import { SessionTracker } from "./sessions.ts";
import { type Settings, SettingsError, type SettingsStore } from "./settings.ts";
import type {
  AssistantModelChangedError,
  BootstrapLocalAccess,
  ChatTurnKind,
  HealthBody,
  IssueLite,
  ItemKind,
  ResolveResponse,
  RestorePrudentResponse,
  StatusLocalAccess,
  TierView,
  TlsStatus,
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
import type { BootstrapAutonomy } from "./shared/autonomy-types.ts";
import { ID, SESSION_ID_RE } from "./shared/ids.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { BootstrapOmo } from "./shared/omo-types.ts";
import { isReservedTitle } from "./shared/session-purpose.ts";
import { StudioApplyError, type StudioScope, type StudioService, StudioValidationError } from "./studio.ts";
import type { StudioKind } from "./studio-schema.ts";
import { TEMPLATES } from "./templates.ts";
import { ACTIVATION_OUVERTE, SALLE_OUVERTE } from "./wiring-11.ts";

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

// Proxy opencode (oc-proxy.ts, L18b) : la liste blanche, les filtres de corps et la lecture d'une réponse d'autorisation ont
// quitté ce fichier sans changer. Réexportés ici : les appelants et les tests de la 1.0.x les importent de http.ts.
export { forbiddenAttachment, forbiddenPartType, PERMISSION_MESSAGES, parsePermissionReply, PROXY_RULES } from "./oc-proxy.ts";
export type { PermissionReply, ProxyHooks } from "./oc-proxy.ts";

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
  /** Adresse de l'API Copilot imposée à opencode ; « synchro due » posée par chaque écriture ou redémarrage, lue par le proxy avec sa raison. */
  copilotConfig: Pick<CopilotConfigSync, "status" | "sync" | "syncDue" | "dueReason" | "markDue">;
  /** File d'écriture de la configuration d'opencode, partagée avec CopilotConfigSync (une instance propre si absente). */
  configQueue?: ConfigWriteQueue;
  /** Routes supplémentaires (assistants, niveaux d'IA, puis routes 1.1 d'app-factory), enregistrées juste avant le 404 de /api/*. */
  routes?: Array<(app: Hono) => void>;
  /** 1.1 : portillon des accords partagé (app-factory) ; absent : une instance propre à cette application. */
  gate?: PermissionGate;
  /** 1.1 : crochets du proxy rangés par wiring-11 (app-factory) ; absents : comportement 1.0. */
  proxyHooks?: ProxyHooks;
  /** 1.1 : agents internes (ports.internalAgents), installés après un redémarrage réussi ; absent : agent de classement seul. */
  internalAgents?: Pick<InternalAgentsPort, "ensureAll">;
  /** 1.1 : décision en examen (Cockpit11.reloadBusy) : la garde de rechargement répond « busy » ; absent : jamais. */
  reloadBusy?: () => boolean;
  /** 1.0.5 : certificat servi en HTTPS (fichier public et poignées refusées) ; null en mode HTTP. */
  tls: LocalTls | null;
  /** 1.0.5 : tickets de connexion à usage unique émis par /api/health (une instance propre si absente). */
  tickets?: AuthTickets;
  /** 1.1 : suivi des sessions, lu pour savoir à quelle instance appartient une conversation (P11) ; absent : une instance propre. */
  sessions?: SessionTracker;
  /**
   * 1.1, Salle OMO (L18a, app-factory) : dépendances de l'instance de la salle. null ou absente = salle coupée — /api/omo/oc/*
   * refuse tout sans rien relayer, et aucune conversation n'est rattachée à la salle.
   */
  omo?: InstanceDeps | null;
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
 * - titre de conversation qui commence par « [cockpit] », réservé aux sessions du cockpit (shared/session-purpose.ts, P12) ;
 * - « Résumer » avec autre chose que providerID/modelID : `auto: true` ferait enchaîner par opencode un tour d'agent avec
 *   outils (« Continue if you have next steps », compaction.ts:468-548), hors de tout contrôle ;
 * - connexion GitHub Enterprise vers un domaine autre que COCKPIT_GITHUB_ENTERPRISE_DOMAIN : opencode y
 *   enverrait toutes les demandes et le jeton sous l'identité « github-copilot » ;
 * - 1.1 (F17, E6) : champ « system » d'une demande facturée, qui remplacerait les consignes de l'assistant ; référence @nom d'un
 *   assistant dans les arguments d'un raccourci, qu'opencode transforme en travail confié à cet assistant
 *   (session/prompt.ts:157-178). `agentNames` : assistants vus par opencode dans ce dossier (null : liste illisible, toute
 *   référence @ refusée) ; absent : contrôle non demandé (autres routes).
 */
export function forbiddenProxyBody(
  method: string,
  sub: string,
  body: unknown,
  enterpriseDomain: string | null,
  agentNames?: ReadonlySet<string> | null,
): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if ((method === "POST" && sub === "/session") || (method === "PATCH" && /^\/session\/[^/]+$/.test(sub))) {
    const extra = Object.keys(record).filter((key) => key !== "title");
    if (extra.length > 0) return `Champ non accepté pour une conversation : ${extra.join(", ").slice(0, 80)}.`;
    if (typeof record.title === "string" && isReservedTitle(record.title)) {
      return "Titre refusé : « [cockpit] » en début de titre est réservé au classement fait par le cockpit. Choisissez un autre titre.";
    }
  }
  if (method === "POST" && /^\/session\/[^/]+\/summarize$/.test(sub)) {
    const extra = Object.keys(record).filter((key) => key !== "providerID" && key !== "modelID");
    if (extra.length > 0) return `Champ non accepté pour « Résumer » : ${extra.join(", ").slice(0, 80)}.`;
  }
  if (/^\/session\/[^/]+\/(prompt_async|command|summarize)$/.test(sub) && ("tools" in record || "permission" in record)) {
    return "Les champs « tools » et « permission » ne sont pas acceptés : les permissions se règlent dans Paramètres › opencode.";
  }
  if (/^\/session\/[^/]+\/(prompt_async|command|summarize)$/.test(sub) && Object.hasOwn(record, "system")) {
    return "Le champ « system » n'est pas accepté : il remplacerait les consignes de l'assistant, hors du contrôle du cockpit.";
  }
  if (agentNames !== undefined && method === "POST" && /^\/session\/[^/]+\/command$/.test(sub) && typeof record.arguments === "string") {
    for (const match of record.arguments.matchAll(FILE_REFERENCE)) {
      const ref = match[1] ?? "";
      if (!ref) continue;
      if (agentNames === null) {
        return "Références @ refusées pour le moment : la liste des assistants d'opencode est illisible, impossible de vérifier qu'elles ne désignent pas un assistant. Réessayez dans un instant.";
      }
      if (agentNames.has(ref)) {
        return `Référence @${ref.slice(0, 64)} refusée : elle désigne un assistant, auquel opencode confierait le travail. Choisissez l'assistant dans la conversation, ou retirez le « @ ».`;
      }
    }
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
  // Une application de configuration à la fois (chacune peut libérer ou redémarrer opencode), synchro de l'adresse Copilot comprise.
  const configQueue = deps.configQueue ?? new ConfigWriteQueue();
  const advanced = advancedOnly(settings);
  // Garde « réponse en cours » avant tout rechargement ou redémarrage d'opencode (Studio, assistants, redémarrage). Demande
  // facturée admise par le proxy mais pas encore visible dans /session/status : réponse en cours aussi (comme applyConfigFile).
  // Dossier illisible alors qu'opencode répond : réponses en cours non vérifiables, refus distinct ; seul opencode injoignable
  // laisse passer. Redémarrage d'opencode (le remède) : confirmation acceptée dans ce cas, même en mode Simple (§3.11).
  // 1.1 : décision en examen (reloadBusy) → « busy », jamais « non vérifiable ».
  const reloadGuardDeps: ReloadGuardDeps = {
    settings,
    control,
    occupancy: reloadOccupancy({
      queue: configQueue,
      reloadBusy: deps.reloadBusy,
      probe: () => probeSessionsBusyStrict({ client, projects, db: deps.db, log }),
    }),
    reachable: async () => (await client.health()) !== null,
    log,
  };
  // Studio et assistants : garde tenue (vérification refaite après l'attente dans la file, applying posé jusqu'au rechargement).
  const guardReload = reloadGuard(reloadGuardDeps, { hold: configQueue });
  const RESTART_GUARD: ReloadGuardOptions = { confirmUnverifiable: true };
  const guardRestart = reloadGuard(reloadGuardDeps, RESTART_GUARD);
  // Portillon des accords : « once » vérifié, file commune aux réponses et aux arrêts, nettoyage après un arrêt, registre des
  // réponses émises. Partagé avec les modules 1.1 quand app-factory le fournit.
  const sessions = deps.sessions ?? new SessionTracker(deps.db, client);
  const gate = deps.gate ?? createPermissionGate({ client, db: deps.db, log, hub, sessions });
  const proxyHooks = deps.proxyHooks;
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
  const tickets = deps.tickets ?? new AuthTickets();

  const fail = (c: Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, message, ...extra }, status as ContentfulStatusCode);

  /** Certificat servi (HTTPS) pour la page Diagnostic ; jamais la clé, jamais un contenu reçu d'un client. */
  const tlsStatus = (): TlsStatus | null => {
    if (deps.tls === null) return null;
    const { info, refusals } = deps.tls;
    return {
      source: info.source,
      sha256: info.sha256,
      spkiSha256Base64: info.spkiSha256Base64,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      daysLeft: Math.floor((Date.parse(info.notAfter) - Date.now()) / 86_400_000),
      san: info.san,
      ignoredHosts: info.ignoredHosts,
      generatedAt: info.generatedAt,
      previousSha256: info.previousSha256,
      refusals24h: refusals.count24h(),
      internalTraffic: "http-docker",
    };
  };
  const localAccessStatus = (): StatusLocalAccess => ({
    localScheme: env.localScheme,
    localHttpConfirmedAt: env.localHttpConfirmedAt,
    tls: tlsStatus(),
  });
  const localAccessBootstrap = (): BootstrapLocalAccess => {
    const status = tlsStatus();
    return {
      localScheme: env.localScheme,
      localHttpConfirmedAt: env.localHttpConfirmedAt,
      tls: status === null ? null : { sha256: status.sha256, notAfter: status.notAfter, daysLeft: status.daysLeft },
    };
  };

  /** Mode HTTP : le jeton ne se saisit jamais dans une page (il y circulerait en clair) ; refus avant le corps et le limiteur. */
  const loginDisabledOverHttp: MiddlewareHandler = async (c, next) => {
    if (env.localScheme === "http") return fail(c, 403, "login-disabled", "Mode HTTP local : ouvrez le cockpit avec .\\cockpit.ps1 open.");
    await next();
  };

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
  app.use("*", hostGuard(env.allowedHosts, env.localScheme));
  app.use("*", authGuard(validSession));
  app.use("*", csrfGuard(env.localScheme));

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

  // Santé (healthcheck Docker, scripts). Avec un défi : preuve du jeton, puis ticket de connexion sur demande signée par le jeton
  // (route publique : un appelant sans jeton n'obtient ni n'évince aucun ticket). Ni le défi, ni la demande, ni le ticket ne sont
  // journalisés.
  app.get("/api/health", (c) => {
    const body: HealthBody = { ok: true, version: env.version, scheme: env.localScheme };
    const challenge = c.req.query("challenge");
    if (challenge !== undefined) {
      if (!isHealthChallenge(challenge)) return fail(c, 400, "invalid", "challenge : 64 caractères hexadécimaux attendus.");
      // Jeton choisi à la main : aucune preuve servie, donc aucun oracle hors ligne contre lui (install.ps1 en génère un).
      if (!isGeneratedToken(env.token)) {
        body.proof = null;
        return c.json(body);
      }
      body.proof = healthProof(env.token, challenge);
      const request = c.req.query("ticket");
      if (request !== undefined) {
        const outcome = tickets.request(env.token, challenge, request);
        if (!outcome.ok) {
          const reason = outcome.reason === "replayed" ? "défi déjà utilisé" : "demande non signée par le jeton";
          return fail(c, 403, "ticket-refused", `Ticket de connexion refusé : ${reason}.`);
        }
        body.ticket = outcome.ticket;
      }
    }
    return c.json(body);
  });

  app.get("/auth", async (c) => {
    // Lien à ouvrir directement (installateur, barre d'adresse). Refuser les requêtes émises par une
    // autre page (image, iframe…) évite qu'un site tiers épuise le limiteur et bloque la connexion.
    const site = c.req.header("sec-fetch-site");
    const dest = c.req.header("sec-fetch-dest");
    if ((site && site !== "none" && site !== "same-origin") || (dest && dest !== "document")) {
      return c.text("Ouvrez ce lien directement dans la barre d'adresse du navigateur.", 403);
    }
    const link = c.req.query("k");
    // Lien d'une version antérieure à 1.0.5 (jeton permanent dans l'adresse) : jamais comparé, aucun cookie.
    if (link === undefined && c.req.query("t") !== undefined) return c.redirect("/?auth=ancien-lien", 303);
    const outcome = await attemptTicketLogin(limiter, link ?? "", env.token, tickets);
    if (outcome === "blocked") return c.text("Trop de tentatives, réessayez dans quelques minutes.", 429);
    if (outcome === "refused") return c.redirect("/?auth=failed", 303);
    setSessionCookie(c, sessionValue(env.token, sessionSecret));
    return c.redirect("/", 303);
  });

  app.post("/api/login", loginDisabledOverHttp, bodyLimit({ maxSize: 4_096 }), async (c) => {
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
    const omoEnv = omoOf(env);
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
        ...localAccessBootstrap(),
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
      // 1.1 (E3) : interrupteur COCKPIT_AUTONOMY et porte I1.
      autonomy: { interrupteur: env.autonomy, activationOuverte: ACTIVATION_OUVERTE } satisfies BootstrapAutonomy,
      // 1.1, Salle OMO : trois drapeaux, faux par défaut (salle livrée coupée), et AUCUN secret. Champ absent quand
      // l'environnement n'a pas été lu (AppEnv construit à la main) : l'interface lit alors exactement la 1.0.x.
      ...(env.omo === undefined
        ? {}
        : { omo: { enabled: omoEnv.enabled, imageChargee: omoEnv.image !== "", salleOuverte: SALLE_OUVERTE } satisfies BootstrapOmo }),
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
        // Salle OMO (§3.16) : rien d'elle ne part vers le navigateur en mode Simple, où elle n'existe pas. Étiquette de
        // l'enveloppe (BrowserEvent.instance, T3c) : un événement sans étiquette est celui de l'instance principale.
        if (event.instance === "omo" && settings.get().ui.mode !== "avance") return;
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
    /** Agents et raccourcis de l'instance visée : une demande de la salle n'interroge JAMAIS l'opencode principal (P11). */
    lookup: OcLookup;
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
        compaction = (await r.lookup.get(r.directory)).agents.find((a) => a.name === "compaction");
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
      snapshot = await r.lookup.get(r.directory);
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
   * chat_turns. Renvoie la réponse de refus, ou le corps à relayer (réflexion fixée par le serveur). `inst` : instance visée —
   * son catalogue et ses assistants, pour qu'une demande de la salle ne soit jamais résolue sur l'opencode principal (P11).
   */
  const enforceTurn = async (
    inst: InstanceDeps,
    c: Context,
    sub: string,
    directory: string | null,
    body: string,
    parsed: unknown,
  ): Promise<Response | string> => {
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

    const lite = inst.catalog.lite();
    const names = { agentTitle: (name: string) => assistants.agentTitle(name), modelName: (model: string) => modelName(model, lite) };
    const bodyVariant = typeof record.variant === "string" && record.variant.length > 0 ? record.variant : undefined;
    const resolved = await resolveProxyTurn(c, { kind, directory, record, bodyModel, bodyVariant, lite, names, lookup: inst.lookup });
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

  // --- Proxy vers opencode --------------------------------------------------------------

  // Instance principale servie par le proxy (L18b) : son compteur de demandes facturées reste celui de la file de
  // configuration, que la garde de rechargement lit (une demande en vol vaut « réponse en cours »). Celui de la salle est
  // propre à son instance (InstanceDeps, L18a) : un envoi de la salle en vol ne bloque ni le Studio ni le redémarrage.
  const instancePrincipale: InstanceDeps = {
    instance: "principale",
    client,
    gate,
    lookup,
    catalog,
    processor,
    billRefusal: () => billRefusal({ queue: configQueue, control, copilotConfig: deps.copilotConfig }),
    beginBilled: () => configQueue.beginBilled(),
    isAllowedDirectory: (directory) => projects.isAllowedDirectory(directory),
  };
  // Routeur d'instances des DEUX montages : il lit sessions.instance (T3c) pour la cloison P11. app-factory garde le sien pour
  // les modules 1.1 ; celui-ci porte l'instance principale du proxy, avec son vrai compteur facturé.
  const instances = createInstanceRouter({ principale: instancePrincipale, omo: deps.omo ?? null, sessions });
  const proxyCommun = { env, log, projects, hooks: proxyHooks, instanceOf: (id: string) => instances.instanceOf(id), forbiddenProxyBody, forbiddenCommandArguments };
  app.all(
    "/api/oc/*",
    bodyLimit({ maxSize: 25 * 1024 * 1024 }),
    createOcProxy({
      ...proxyCommun,
      instance: instancePrincipale,
      prefix: "/api/oc",
      rules: PROXY_RULES,
      enforceTurn: (c, sub, directory, body, parsed) => enforceTurn(instancePrincipale, c, sub, directory, body, parsed),
    }),
  );

  // --- Proxy de la Salle OMO ---------------------------------------------------------------

  // Second montage, réservé à la salle (§3.9 l.331) : mode Avancé, COCKPIT_OMO=on, SALLE_OUVERTE et instance présente, sinon
  // 403 sans rien relayer — en mode Simple, aucun envoi ne part vers une conversation de la salle. Les phrases sont celles du
  // contrat (omo-room-texts.ts), les mêmes que les routes /api/omo/* de L18c, montées après.
  const instanceSalle = instances.omo;
  const proxySalle =
    instanceSalle === null
      ? null
      : createOcProxy({
          ...proxyCommun,
          instance: instanceSalle,
          prefix: "/api/omo/oc",
          rules: PROXY_RULES_OMO,
          enforceTurn: (c, sub, directory, body, parsed) => enforceTurn(instanceSalle, c, sub, directory, body, parsed),
        });
  app.all("/api/omo/oc/*", bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
    const refus = refusMontageSalle({
      salleOuverte: SALLE_OUVERTE,
      omoActif: omoOf(env).enabled,
      instancePresente: proxySalle !== null,
      mode: settings.get().ui.mode,
    });
    if (refus !== null || proxySalle === null) {
      const code = refus ?? "salle-coupee";
      return fail(c, 403, code === "mode-avance" ? MODE_AVANCE_ERROR : code, phraseRefusActivation(code));
    }
    return proxySalle(c);
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

  // Écritures d'assistants (routes-assistants.ts, enregistrées plus loin) : fichiers d'agents réécrits puis opencode rechargé.
  // « Adopter » n'écrit que dans la base du cockpit : non gardé.
  app.use("/api/assistants/catalogue/:id/install", forMethods(["POST"], guardReload));
  app.use("/api/assistants/:name", forMethods(["PUT", "DELETE"], guardReload));

  app.get("/api/studio/templates", (c) => c.json(TEMPLATES));

  app.get("/api/studio/instructions", async (c) => c.json(await studio.getInstructions(scopeOf(c))));

  app.put("/api/studio/instructions", advanced, guardReload, bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
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

  app.put("/api/studio/:kind/:name", advanced, guardReload, bodyLimit({ maxSize: 300 * 1024 }), async (c) => {
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

  app.delete("/api/studio/:kind/:name", advanced, guardReload, async (c) => {
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

  app.get("/api/opencode/config/raw", async (c) => {
    const file = await configFile();
    return c.json({ file: path.basename(file), content: (await readInside(env.opencodeConfigDir, file)) ?? "" });
  });

  /** Conversation en cours : un redémarrage d'opencode la couperait. */
  const sessionsBusy = () => probeSessionsBusy({ client, projects, db: deps.db });
  /**
   * Garde des routes de configuration, dans la file et applying posé, sans dérogation : demande facturée admise par le proxy juste
   * avant l'indicateur (réponse en cours que la sonde ne voit pas encore), décision en examen (reloadBusy), ou réponse lue en cours.
   */
  const configBusy = async (): Promise<boolean> => configQueue.billedInFlight > 0 || examining(deps.reloadBusy) || (await sessionsBusy());

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

  /**
   * Écriture de la configuration d'opencode ou redémarrage faits : « synchro due » posée DANS la tâche de la file, avant la
   * libération d'applying (aucun intervalle où le proxy admettrait une demande facturée vers une adresse non revérifiée). La synchro
   * relancée après la tâche (resyncCopilot) la lève à sa fin. Jamais sans écriture ni redémarrage réels.
   */
  const copilotSyncDue = (cause: string): void => {
    deps.copilotConfig.markDue(cause);
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

  /**
   * Écrit la configuration globale puis redémarre opencode pour l'appliquer : opencode 1.18.30 la garde en mémoire et ne relit
   * pas une écriture directe du fichier, même après /global/dispose (mesuré). Jamais pendant une réponse ni un redémarrage.
   * Pendant l'application, les demandes facturées sont refusées (le redémarrage les couperait).
   */
  const applyConfigFile = async (file: string, content: string, backup: string | null, what: string): Promise<ConfigApply> => {
    if (control.restarting) return restartInProgress();
    return configQueue.applyingWhile(async (): Promise<ConfigApply> => {
      let busy: boolean;
      try {
        busy = await configBusy();
      } catch {
        return opencodeUnreachable();
      }
      if (busy) return { ok: false, error: "sessions-busy", message: MESSAGES.reloadBusy, restarted: false };
      await writeFileAtomic(file, content);
      const outcome = await restartOnConfig(file, backup, what);
      // Redémarrage fait (fichier appliqué ou retour arrière) : nouveau processus, qui a pu perdre l'adresse imposée.
      if (outcome.restarted) copilotSyncDue(`redémarrage d'opencode (${what})`);
      // Après le dernier redémarrage : l'interface relit la configuration qui tourne vraiment.
      hub.cockpit("opencode.config.changed", {});
      return outcome;
    });
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

  /**
   * Adresse de l'API Copilot revérifiée dans chaque dossier (et réécrite s'il le faut) après un redémarrage d'opencode ou une
   * écriture de sa configuration. Toujours APRÈS la tâche de la file et sans l'attendre : sync() passe par la même file, l'attendre
   * depuis la tâche la bloquerait. Plusieurs appels rapprochés se fondent en une seule synchro relancée.
   */
  const resyncCopilot = (): void => {
    void deps.copilotConfig.sync().catch(() => undefined);
  };

  /** Issue du correctif de configuration du mode Avancé ; `cause` : erreur d'opencode, journalisée seulement. */
  type ConfigPatch =
    | { ok: true; updated: unknown }
    | { ok: false; issues: IssueLite[] }
    | { ok: false; status: 409 | 503; error: string; message: string; wrote: boolean; cause?: string };

  // Correctif de la configuration globale (mode Avancé) : écrit par opencode (PATCH, qui met aussi à jour son cache), puis instances
  // libérées pour l'appliquer. Dans la file partagée et jamais pendant une réponse : la libération la couperait sans erreur.
  app.patch("/api/opencode/config", advanced, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const patch = z.record(z.string(), z.unknown()).parse(await c.req.json());
    // Journal : clés de premier niveau du correctif seulement, jamais leurs valeurs (adresses, consignes, règles).
    const keys = Object.keys(patch)
      .sort()
      .slice(0, 50)
      .map((key) => key.slice(0, 100));
    /** Configuration écrite ou peut-être écrite : relue par l'interface, adresse de l'API Copilot revérifiée après la tâche de la file. */
    const afterWrite = async () => {
      await catalog.refresh().catch(() => undefined);
      hub.cockpit("opencode.config.changed", {});
      // Un correctif peut toucher l'adresse de l'API Copilot : la synchro la rétablit, lancée après la tâche de la file.
      resyncCopilot();
    };
    // PATCH en erreur ou hors délai : opencode a pu écrire quand même (« synchro due » posée dans la tâche).
    let uncertain = false;
    const result = await configQueue.run(async (): Promise<ConfigPatch> => {
      if (control.restarting) return { ok: false, status: 409, error: "redemarrage-en-cours", message: MESSAGES.restartEnCours, wrote: false };
      // Contrôle sur la configuration résultante : un correctif sans rapport reste refusé tant que le verrou manque.
      const current = await client.request<unknown>("GET", "/global/config", { timeoutMs: 15_000 });
      const issues = configProviderIssues(mergeConfigPatch(current, patch), env.allowedProviders, env.githubEnterpriseDomain);
      if (issues.length > 0) return { ok: false, issues };
      return configQueue.applyingWhile(async (): Promise<ConfigPatch> => {
        let busy: boolean;
        try {
          busy = await configBusy();
        } catch (err) {
          return { ok: false, status: 503, error: "opencode-injoignable", message: MESSAGES.opencodeInjoignable, wrote: false, cause: errorMessage(err) };
        }
        if (busy) return { ok: false, status: 409, error: "sessions-busy", message: MESSAGES.reloadBusy, wrote: false };
        if (control.restarting) return { ok: false, status: 409, error: "redemarrage-en-cours", message: MESSAGES.restartEnCours, wrote: false };
        let updated: unknown;
        try {
          updated = await client.request("PATCH", "/global/config", { body: patch, timeoutMs: 30_000 });
        } catch (err) {
          // Refus, erreur ou délai dépassé : opencode a pu écrire quand même, l'adresse de l'API Copilot est à revérifier.
          copilotSyncDue("correctif de configuration (mode Avancé) : écriture incertaine");
          uncertain = true;
          throw err;
        }
        // Écrit : le PATCH libère déjà les instances en tâche de fond, l'adresse de l'API Copilot est à revérifier.
        copilotSyncDue("correctif de configuration (mode Avancé)");
        try {
          await client.request("POST", "/global/dispose", { timeoutMs: 20_000 });
        } catch (err) {
          const message = `Configuration écrite, mais opencode n'a pas libéré ses instances (${errorMessage(err)}) : elle n'est peut-être pas encore appliquée. ${MESSAGES.redemarrerDepuisDiagnostic}`;
          return { ok: false, status: 503, error: "liberation-echouee", message, wrote: true, cause: errorMessage(err) };
        }
        return { ok: true, updated };
      });
    }).catch(async (err: unknown) => {
      if (uncertain) {
        log.warn("configuration d'opencode peut-être corrigée (mode Avancé) : écriture en erreur ou hors délai, adresse de l'API Copilot revérifiée", { keys });
        await afterWrite();
      }
      throw err;
    });
    if (result.ok) {
      log.info("configuration d'opencode corrigée (mode Avancé) : écrite, instances libérées", { keys });
    } else if ("error" in result && (result.error === "liberation-echouee" || result.error === "opencode-injoignable")) {
      const title =
        result.error === "liberation-echouee"
          ? "configuration d'opencode corrigée (mode Avancé) : écrite, mais instances non libérées"
          : "configuration d'opencode non corrigée (mode Avancé) : opencode injoignable";
      log.warn(title, { keys, error: result.error, ...(result.cause ? { cause: result.cause } : {}) });
    }
    if (result.ok || ("wrote" in result && result.wrote)) await afterWrite();
    if (result.ok) return c.json(result.updated);
    if ("issues" in result) return refuseProviders(c, result.issues);
    return fail(c, result.status, result.error, result.message);
  });

  app.put("/api/opencode/config/raw", advanced, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const { content } = z.object({ content: z.string().max(256 * 1024) }).parse(await c.req.json());
    const issues = configProviderIssues(parseJsonc(content, [], { allowTrailingComma: true }), env.allowedProviders, env.githubEnterpriseDomain);
    if (issues.length > 0) return refuseProviders(c, issues);
    const root = env.opencodeConfigDir;
    const file = await assertInside(root, await configFile());
    const result = await configQueue.run(async (): Promise<ConfigApply> => {
      if (control.restarting) return restartInProgress();
      // Relue dans la file, sans suivre de lien : c'est la version remise en cas de refus.
      const backup = await readInside(root, file);
      return backup === content ? { ok: true, restarted: false } : applyConfigFile(file, content, backup, "fichier de configuration brut");
    });
    // Redémarrage fait (fichier appliqué ou retour arrière) : nouveau processus, qui a pu perdre l'adresse imposée.
    if (result.restarted) resyncCopilot();
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
    configQueue.run(async (): Promise<PermissionWrite> => {
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
    // Après la tâche de la file : un redémarrage fait (appliqué, refusé ou non confirmé) relance la synchro de l'adresse Copilot.
    if (result.restarted) resyncCopilot();
    if (!result.ok) return permissionFailure(c, result);
    return c.json({ ok: true, restarted: result.restarted });
  });

  // Paramètres › Sécurité (les deux modes) : revenir au profil Prudent, avec la même écriture vérifiée.
  app.post("/api/security/restore-prudent", bodyLimit({ maxSize: 4_096 }), async (c) => {
    z.strictObject({}).parse(await c.req.json().catch(() => null));
    const permission = presetPermission("prudent");
    const result = await replacePermission(permission, "profil Prudent");
    if (result.restarted) resyncCopilot();
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
        ...localAccessStatus(),
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

  app.post("/api/system/restart-opencode", guardRestart, async (c) => {
    const request = { confirmed: c.req.header(CONFIRM_HEADER) === "1", path: c.req.path };
    // Dans la file partagée : jamais pendant une application (PATCH, libération des instances) ; « synchro due » posée avant la
    // libération d'applying, levée par la synchro lancée après la tâche. Garde refaite une fois la place obtenue, applying posé,
    // avec les mêmes règles (dérogation, décision du 15/09) : une réponse commencée pendant l'attente n'est jamais coupée.
    const result = await configQueue.run(() =>
      configQueue.applyingWhile(async (): Promise<RestartResult | { refused: ReloadRefusal }> => {
        const refused = await reloadRefusal(reloadGuardDeps, RESTART_GUARD, request);
        if (refused) return { refused };
        const restart = await control.restartOpencode("demande depuis l'interface");
        if (restart.ok) copilotSyncDue("redémarrage d'opencode (page Diagnostic)");
        return restart;
      }),
    );
    if ("refused" in result) return c.json(result.refused, 409);
    if (result.ok) {
      await catalog.refresh().catch(() => undefined);
      // Nouveau processus : l'adresse de l'API Copilot est revérifiée dans chaque dossier (et réécrite s'il le faut).
      await deps.copilotConfig.sync().catch(() => undefined);
      // Agents internes réinstallés (ports.internalAgents d'app-factory ; sans lui, l'agent de classement comme en 1.0).
      await (deps.internalAgents ? deps.internalAgents.ensureAll() : studio.ensureClassifierAgent()).catch(() => undefined);
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
