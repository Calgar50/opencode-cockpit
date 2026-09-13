// Client de l'API du cockpit et du proxy opencode (/api/oc/*).
import { MODEL_OVERRIDE_HEADER } from "../../server/shared/assistant-rules.ts";
import type {
  AdoptRequest,
  AiView,
  ArchiveDetail,
  ArchiveList,
  ArchiveStats,
  AssistantModelChangedError,
  AssistantPreview,
  AssistantSaveRequest,
  AssistantsResponse,
  AssistantView,
  Bootstrap,
  BudgetGuardError,
  CatalogueItem,
  ChoicesResponse,
  Conversation,
  FicheInfo,
  FileDiff,
  ItemKind,
  KeepModelResponse,
  ModelInfo,
  PutTiersResponse,
  RealignRequest,
  RealignResponse,
  ResolveRequest,
  ResolveResponse,
  RestorePrudentResponse,
  SavedAssistant,
  TaskSize,
  Tier,
  TierDefs,
  UsageEstimate,
  OcAgent,
  OcCommand,
  OcMessageWithParts,
  OcSession,
  OcSessionStatus,
  PermissionRequest,
  PricingInfo,
  ProjectInfo,
  ProviderAuthMethod,
  ProviderAuthorization,
  QuestionRequest,
  QuotaSnapshot,
  SessionUsage,
  Settings,
  StudioItem,
  StudioKind,
  StudioTemplate,
  SystemStatus,
  Todo,
  UsageSummary,
  ValidationIssue,
} from "./types.ts";

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];
  readonly data: unknown;

  constructor(status: number, code: string, message: string, issues: ValidationIssue[] = [], data: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.data = data;
  }
}

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

interface RequestOptions {
  /** Confirme l'envoi malgré le garde-fou budgétaire (ou une action qui le demande, ex. réalignement). */
  confirm?: boolean;
  /** En-tête x-cockpit-model-override: 1 (mode Avancé + réglage : autre IA qu'un assistant, pour un message). */
  modelOverride?: boolean;
  signal?: AbortSignal;
}

async function request<T>(method: string, url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers["x-cockpit-csrf"] = "1";
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  if (options.confirm) headers["x-cockpit-confirm"] = "1";
  if (options.modelOverride) headers[MODEL_OVERRIDE_HEADER] = "1";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      credentials: "same-origin",
      signal: options.signal ?? null,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Le cockpit ne répond pas (conteneur arrêté ?).");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = (data && typeof data === "object" ? data : {}) as { error?: string; message?: string; issues?: ValidationIssue[] };
    if (res.status === 401) for (const listener of unauthorizedListeners) listener();
    throw new ApiError(res.status, d.error ?? "http", d.message ?? `Erreur ${res.status}`, d.issues ?? [], data);
  }
  return data as T;
}

export const http = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>("GET", url, undefined, signal ? { signal } : {}),
  post: <T>(url: string, body?: unknown, options?: RequestOptions) => request<T>("POST", url, body ?? {}, options),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
};

type QueryValue = string | number | boolean | undefined | null;

export function query(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

export interface ArchiveQuery {
  q?: string;
  category?: string;
  project?: string;
  from?: number;
  to?: number;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export const api = {
  login: (token: string) => http.post<{ ok: boolean }>("/api/login", { token }),
  logout: () => http.post<{ ok: boolean }>("/api/logout"),
  bootstrap: () => http.get<Bootstrap>("/api/bootstrap"),
  projects: () => http.get<ProjectInfo[]>("/api/projects"),
  models: () => http.get<{ models: ModelInfo[]; defaults: Record<string, string>; loadedAt: number }>("/api/models"),
  refreshModels: () => http.post<{ models: ModelInfo[]; defaults: Record<string, string>; loadedAt: number }>("/api/models/refresh"),

  usageSummary: (month?: string) => http.get<UsageSummary>(`/api/usage/summary${query({ month })}`),
  usageExportUrl: (month: string) => `/api/usage/export.csv${query({ month })}`,
  /** `agent` : moyenne observée de cet agent (≥ 5 demandes) ; `size` : profil S/M/L (défaut M). */
  usageEstimate: (provider: string, model: string, options: { agent?: string; size?: TaskSize } = {}) =>
    http.get<UsageEstimate>(`/api/usage/estimate${query({ provider, model, agent: options.agent, size: options.size })}`),
  sessionUsage: (rootId: string) => http.get<SessionUsage>(`/api/usage/session/${enc(rootId)}`),
  recompute: (month?: string) => http.post<{ updated: number }>(`/api/usage/recompute${query({ month })}`),
  quota: () => http.get<{ latest: QuotaSnapshot | null; lastError: string | null; enabled: boolean }>("/api/quota"),
  syncQuota: () => http.post<QuotaSnapshot>("/api/quota/sync"),

  archiveList: (params: ArchiveQuery) =>
    http.get<ArchiveList>(`/api/archive${query({ ...params, pinned: params.pinned ? "1" : undefined })}`),
  archiveStats: () => http.get<ArchiveStats>("/api/archive/stats"),
  archiveGet: (id: string) => http.get<ArchiveDetail>(`/api/archive/${enc(id)}`),
  archivePatch: (id: string, patch: Partial<Pick<Conversation, "category" | "tags" | "title" | "summary" | "pinned">>) =>
    http.patch<Conversation>(`/api/archive/${enc(id)}`, patch),
  archiveClassify: (id: string) => http.post<Conversation>(`/api/archive/${enc(id)}/classify`),
  archiveRefresh: (id: string) => http.post<Conversation>(`/api/archive/${enc(id)}/refresh`),
  archiveDelete: (id: string) => http.del<{ deleted: boolean }>(`/api/archive/${enc(id)}`),
  archiveRescan: () => http.post<{ started: boolean }>("/api/archive/rescan"),
  archiveExportUrl: (id: string) => `/api/archive/${enc(id)}/export.md`,

  templates: () => http.get<StudioTemplate[]>("/api/studio/templates"),
  studioList: (kind: StudioKind, project?: string | null) => http.get<StudioItem[]>(`/api/studio/${kind}${query({ project })}`),
  studioGet: (kind: StudioKind, name: string, project?: string | null) =>
    http.get<StudioItem>(`/api/studio/${kind}/${enc(name)}${query({ project })}`),
  /**
   * `tier` (0.2.0, agents et commandes) : niveau choisi dans LevelField, enregistré dans item_meta avec l'IA écrite
   * (`undefined` = liaison inchangée, `null` = IA précise ou aucune). Mode Avancé uniquement (403 mode-avance).
   */
  studioSave: (
    kind: StudioKind,
    name: string,
    input: { frontmatter: Record<string, unknown>; body: string; previousName?: string | null; tier?: Tier | null },
    project?: string | null,
  ) => http.put<StudioItem>(`/api/studio/${kind}/${enc(name)}${query({ project })}`, input),
  studioDelete: (kind: StudioKind, name: string, project?: string | null) =>
    http.del<{ deleted: boolean }>(`/api/studio/${kind}/${enc(name)}${query({ project })}`),
  instructions: (project?: string | null) => http.get<{ content: string; exists: boolean }>(`/api/studio/instructions${query({ project })}`),
  saveInstructions: (content: string, project?: string | null) =>
    http.put<{ ok: boolean }>(`/api/studio/instructions${query({ project })}`, { content }),
  skillFile: (name: string, file: string, project?: string | null) =>
    http.get<{ content: string }>(`/api/studio/skills/${enc(name)}/file${query({ file, project })}`),
  saveSkillFile: (name: string, file: string, content: string, project?: string | null) =>
    http.put<{ ok: boolean }>(`/api/studio/skills/${enc(name)}/file${query({ file, project })}`, { content }),
  deleteSkillFile: (name: string, file: string, project?: string | null) =>
    http.del<{ ok: boolean }>(`/api/studio/skills/${enc(name)}/file${query({ file, project })}`),

  opencodeConfig: () => http.get<Record<string, unknown>>("/api/opencode/config"),
  patchOpencodeConfig: (patch: Record<string, unknown>) => http.patch<Record<string, unknown>>("/api/opencode/config", patch),
  /** Remplace d'un bloc les permissions globales (la fusion de PATCH garderait d'anciennes règles). */
  putOpencodePermission: (permission: Record<string, unknown>) => http.put<{ ok: boolean }>("/api/opencode/config/permission", { permission }),
  opencodeConfigRaw: () => http.get<{ file: string; content: string }>("/api/opencode/config/raw"),
  saveOpencodeConfigRaw: (content: string) => http.put<{ ok: boolean }>("/api/opencode/config/raw", { content }),

  settings: () => http.get<Settings>("/api/settings"),
  saveSettings: (patch: unknown) => http.put<Settings>("/api/settings", patch),
  resetSettings: (section: keyof Settings) => http.post<Settings>("/api/settings/reset", { section }),
  pricing: () => http.get<PricingInfo>("/api/pricing"),

  systemStatus: () => http.get<SystemStatus>("/api/system/status"),
  restartOpencode: () => http.post<{ ok: boolean; durationMs: number; message: string }>("/api/system/restart-opencode"),
  logs: (lines = 400) => http.get<{ content: string }>(`/api/system/logs${query({ lines })}`),
  backfill: () => http.post<{ ok: boolean }>("/api/system/backfill"),

  // --- 0.2.0 : assistants ----------------------------------------------------------------
  assistants: () => http.get<AssistantsResponse>("/api/assistants"),
  assistantsCatalogue: () => http.get<CatalogueItem[]>("/api/assistants/catalogue"),
  /** Idempotent : renvoie l'assistant déjà installé depuis cette entrée. 409 name-taken si `name` est pris. */
  installCatalogueAssistant: (id: string, name?: string) =>
    http.post<AssistantView>(`/api/assistants/catalogue/${enc(id)}/install`, name ? { name } : {}),
  /** N'écrit rien. À appeler avec un délai (300 ms) et un AbortSignal pour ignorer les réponses dépassées. */
  previewAssistant: (draft: AssistantSaveRequest, signal?: AbortSignal) =>
    http.post<AssistantPreview>("/api/assistants/preview", draft, signal ? { signal } : {}),
  saveAssistant: (name: string, input: AssistantSaveRequest) => http.put<SavedAssistant>(`/api/assistants/${enc(name)}`, input),
  adoptAssistant: (name: string, input: AdoptRequest) => http.post<AssistantView>(`/api/assistants/${enc(name)}/adopt`, input),
  /** 409 used-by (data: UsedByError) si un raccourci l'utilise, sauf `force`. */
  deleteAssistant: (name: string, force = false) =>
    http.del<{ deleted: boolean }>(`/api/assistants/${enc(name)}${query({ force: force ? 1 : undefined })}`),
  /** Retire une ligne « Fichier introuvable ». */
  deleteAssistantMeta: (name: string, kind: ItemKind = "agents") =>
    http.del<{ deleted: boolean }>(`/api/assistants/${enc(name)}/meta${query({ kind })}`),
  fiches: () => http.get<FicheInfo[]>("/api/assistants/fiches"),

  // --- 0.2.0 : niveaux d'IA --------------------------------------------------------------
  ai: () => http.get<AiView>("/api/ai"),
  /** Mode Avancé. `null` = revenir à la recommandation livrée. Ne réécrit aucun fichier. */
  putTiers: (tiers: TierDefs | null) => http.put<PutTiersResponse>("/api/ai/tiers", { tiers }),
  /** Réécrit les éléments liés (tous ceux « Mise à jour disponible » si `items` est absent) ; envoie x-cockpit-confirm. */
  realign: (items?: RealignRequest["items"]) =>
    http.post<RealignResponse>("/api/ai/realign", items ? { items } : {}, { confirm: true }),
  /** « Garder cette IA précise » (deux modes) : l'élément ne suit plus son niveau, aucun fichier réécrit. */
  keepModel: (kind: ItemKind, name: string) => http.post<KeepModelResponse>("/api/ai/keep-model", { kind, name }),

  // --- 0.2.0 : chat et sécurité ----------------------------------------------------------
  /** Même résolution que le proxy : IA réellement utilisée, puces et problèmes en français. */
  resolveChat: (input: ResolveRequest, signal?: AbortSignal) =>
    http.post<ResolveResponse>("/api/chat/resolve", input, signal ? { signal } : {}),
  /** Derniers choix (message, jamais raccourci) d'une conversation, ou null. */
  chatChoices: (sessionId: string) => http.get<ChoicesResponse>(`/api/chat/choices/${enc(sessionId)}`),
  /** Réapplique le profil de droits Prudent (permission globale d'opencode). */
  restorePrudent: () => http.post<RestorePrudentResponse>("/api/security/restore-prudent"),
};

/** Corps 409 « assistant-model-changed » d'un ApiError, sinon null (le client renvoie une fois avec ce modèle). */
export function assistantModelChanged(err: unknown): AssistantModelChangedError | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "assistant-model-changed") return null;
  const data = err.data as Partial<AssistantModelChangedError> | null;
  return data && typeof data.agent === "string" && data.model && typeof data.model.modelID === "string"
    ? (data as AssistantModelChangedError)
    : null;
}

/** Corps 409 « budget-guard » d'un ApiError, sinon null. */
export function budgetGuard(err: unknown): BudgetGuardError | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "budget-guard") return null;
  return (err.data as BudgetGuardError | null) ?? null;
}

/** Appels opencode via le proxy filtré du cockpit. */
export const oc = {
  sessions: (directory: string) => http.get<OcSession[]>(`/api/oc/session${query({ directory, roots: true, limit: 300 })}`),
  session: (id: string, directory?: string) => http.get<OcSession>(`/api/oc/session/${enc(id)}${query({ directory })}`),
  createSession: (directory: string, title?: string) =>
    http.post<OcSession>(`/api/oc/session${query({ directory })}`, title ? { title } : {}),
  updateSession: (id: string, directory: string, patch: { title?: string }) =>
    http.patch<OcSession>(`/api/oc/session/${enc(id)}${query({ directory })}`, patch),
  deleteSession: (id: string, directory: string) => http.del<boolean>(`/api/oc/session/${enc(id)}${query({ directory })}`),
  messages: (id: string, directory?: string) =>
    http.get<OcMessageWithParts[]>(`/api/oc/session/${enc(id)}/message${query({ directory })}`),
  children: (id: string, directory?: string) => http.get<OcSession[]>(`/api/oc/session/${enc(id)}/children${query({ directory })}`),
  todo: (id: string, directory?: string) => http.get<Todo[]>(`/api/oc/session/${enc(id)}/todo${query({ directory })}`),
  diff: (id: string, directory?: string) => http.get<FileDiff[]>(`/api/oc/session/${enc(id)}/diff${query({ directory })}`),
  status: (directory?: string) => http.get<Record<string, OcSessionStatus>>(`/api/oc/session/status${query({ directory })}`),
  /**
   * `modelOverride` : envoie x-cockpit-model-override: 1 pour utiliser une autre IA que celle de l'assistant, pour ce
   * message (accepté seulement en mode Avancé avec ai.allowModelOverride). Sur 409 assistant-model-changed
   * (voir assistantModelChanged), renvoyer UNE fois avec le modèle et la réflexion reçus.
   */
  promptAsync: (id: string, directory: string, body: unknown, confirm = false, modelOverride = false) =>
    http.post<void>(`/api/oc/session/${enc(id)}/prompt_async${query({ directory })}`, body, { confirm, modelOverride }),
  command: (id: string, directory: string, body: unknown, confirm = false) =>
    http.post<unknown>(`/api/oc/session/${enc(id)}/command${query({ directory })}`, body, { confirm }),
  abort: (id: string, directory: string) => http.post<boolean>(`/api/oc/session/${enc(id)}/abort${query({ directory })}`),
  summarize: (id: string, directory: string, model: { providerID: string; modelID: string }, confirm = false) =>
    http.post<boolean>(`/api/oc/session/${enc(id)}/summarize${query({ directory })}`, model, { confirm }),
  permissions: (directory?: string) => http.get<PermissionRequest[]>(`/api/oc/permission${query({ directory })}`),
  replyPermission: (requestID: string, directory: string | undefined, reply: "once" | "always" | "reject", message?: string) =>
    http.post<boolean>(`/api/oc/permission/${enc(requestID)}/reply${query({ directory })}`, message ? { reply, message } : { reply }),
  questions: (directory?: string) => http.get<QuestionRequest[]>(`/api/oc/question${query({ directory })}`),
  replyQuestion: (requestID: string, directory: string | undefined, answers: string[][]) =>
    http.post<boolean>(`/api/oc/question/${enc(requestID)}/reply${query({ directory })}`, { answers }),
  rejectQuestion: (requestID: string, directory: string | undefined) =>
    http.post<boolean>(`/api/oc/question/${enc(requestID)}/reject${query({ directory })}`),
  agents: (directory?: string) => http.get<OcAgent[]>(`/api/oc/agent${query({ directory })}`),
  commands: (directory?: string) => http.get<OcCommand[]>(`/api/oc/command${query({ directory })}`),
  findFiles: (directory: string, text: string) => http.get<string[]>(`/api/oc/find/file${query({ directory, query: text, limit: 30 })}`),
  providerAuth: () => http.get<Record<string, ProviderAuthMethod[]>>("/api/oc/provider/auth"),
  oauthAuthorize: (providerID: string, method: number, inputs: Record<string, string>) =>
    http.post<ProviderAuthorization>(`/api/oc/provider/${enc(providerID)}/oauth/authorize`, { method, inputs }),
  oauthCallback: (providerID: string, method: number, code?: string) =>
    http.post<boolean>(`/api/oc/provider/${enc(providerID)}/oauth/callback`, code ? { method, code } : { method }),
  logoutProvider: (providerID: string) => http.del<boolean>(`/api/oc/auth/${enc(providerID)}`),
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.issues.map((i) => `${i.path} : ${i.message}`).join(" · ");
    return details ? `${err.message} (${details})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
