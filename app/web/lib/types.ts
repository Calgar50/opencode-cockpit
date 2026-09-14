// Types partagés par l'interface : API du cockpit et objets opencode relayés.
import type { AiSettings, EstimateView, TierView, UiSettings } from "../../server/shared/api-types.ts";
import type { Rule, Tier } from "../../server/shared/assistant-rules.ts";

// 0.2.0 « Assistants et niveaux d'IA » : types définis une seule fois dans server/shared (serveur et interface).
export type {
  Action,
  AgentLite,
  AssistantDraft,
  AssistantFile,
  AssistantIcon,
  CatalogLite,
  CommandLite,
  Estimate,
  ModelRef,
  Problem,
  ProblemCode,
  Reflection,
  RightLine,
  RightLineKind,
  RightsLabel,
  RightsProfile,
  Rule,
  Run,
  RunRole,
  RunSource,
  RunView,
  TaskSize,
  Tier,
  TierDef,
  TierDefs,
  TierResolution,
  TierStatus,
  Turn,
  TurnDisplay,
  TurnLock,
  UiMode,
  UseCase,
} from "../../server/shared/assistant-rules.ts";
export type {
  AdoptRequest,
  AiSettings,
  AiView,
  AssistantModelChangedError,
  AssistantOrigin,
  AssistantPreview,
  AssistantSaveRequest,
  AssistantState,
  AssistantsResponse,
  AssistantView,
  BudgetGuardError,
  BuiltinAssistantView,
  CatalogueItem,
  ChatTurnKind,
  ChoicesResponse,
  EstimateView,
  FicheInfo,
  InstallRequest,
  ItemKind,
  KeepModelRequest,
  KeepModelResponse,
  MissingItem,
  PutTiersRequest,
  PutTiersResponse,
  RealignRequest,
  RealignResponse,
  ResolveRequest,
  ResolveResponse,
  RestorePrudentResponse,
  SavedAssistant,
  TierView,
  ToCompleteItem,
  UiSettings,
  UpdateItem,
  UsageRow,
  UsageRowState,
  UsageRowType,
  UsedByError,
} from "../../server/shared/api-types.ts";

export interface PriceRates {
  input: number;
  cachedInput: number;
  cacheWrite: number | null;
  output: number;
}

export interface ModelPrice {
  rates: PriceRates;
  tiers?: Array<{ aboveInputTokens: number; rates: PriceRates }>;
  note?: string;
}

export interface ModelInfo {
  key: string;
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  price: ModelPrice | null;
  officialPrice: boolean;
  contextLimit: number | null;
  outputLimit: number | null;
  reasoning: boolean;
  attachment: boolean;
  variants: string[];
  /** Prix de sortie EFFECTIF (surcharges > grille > catalogue) au-delà de budget.guard.maxOutputPricePerM. */
  expensive: boolean;
  /** Statut opencode : active, beta, alpha, deprecated. */
  status: string;
  /** Sait utiliser les outils (sinon inutilisable par un assistant). */
  toolcall: boolean;
  /** Niveau dont c'est l'IA résolue, sinon null. */
  tier: Tier | null;
  /** Coût estimé d'une demande S / M / L au prix effectif, null sans prix. */
  taskCost: { S: number; M: number; L: number } | null;
  /** Groupe « Réservé (très cher) » : prix promotionnel ou sortie ≥ 30 $/M. */
  reserved: boolean;
}

export interface Category {
  id: string;
  label: string;
  emoji: string;
  color: string;
  description: string;
  keywords: string[];
}

export interface Settings {
  budget: {
    monthlyUsd: number;
    alertThresholds: number[];
    guard: { enabled: boolean; fromPercent: number; maxOutputPricePerM: number; blockAtLimit: boolean };
  };
  pricing: { preferTable: boolean; overrides: Record<string, ModelPrice> };
  classifier: {
    mode: "llm" | "heuristic" | "off";
    model: string | null;
    idleMinutes: number;
    reclassifyAfterPrompts: number;
    categories: Category[];
  };
  quotaSync: { enabled: boolean; intervalMinutes: number };
  /** `defaultModel` est obsolète depuis 0.2.0 (initialise ai.chatDefaultTier, ignoré en mode Simple). */
  chat: { defaultModel: string | null; defaultAgent: string | null; defaultDirectory: string | null };
  ai: AiSettings;
  ui: UiSettings;
}

export interface ProjectInfo {
  name: string;
  directory: string;
  isRoot: boolean;
  git: boolean;
  opencodeConfig: boolean;
  agentsMd: boolean;
  updatedAt: number;
}

export interface QuotaSnapshot {
  takenAt: number;
  plan: string | null;
  entitlement: number | null;
  remaining: number | null;
  percentRemaining: number | null;
  unlimited: boolean;
  overageCount: number | null;
}

export interface EventsStatus {
  connected: boolean;
  lastEventAt: number;
  lastError: string | null;
  backfilling: boolean;
}

export interface UsageLite {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  percent: number;
  projectedUsd: number;
  remainingUsd: number;
}

export interface Bootstrap {
  version: string;
  opencode: { reachable: boolean; version: string | null; events: EventsStatus; restarting: boolean; supervisor: boolean };
  security: {
    tlsInsecure: boolean;
    caFiles: number | null;
    proxy: boolean;
    projectConfig: boolean;
    /** Verrou « fournisseurs » de la configuration globale d'opencode (configProviderIssues) ; null : opencode injoignable. */
    providerIssues: Array<{ path: string; message: string }> | null;
  };
  workspace: { hostDir: string | null; root: string };
  projects: ProjectInfo[];
  settings: Settings;
  copilotConnected: boolean;
  models: ModelInfo[];
  modelDefaults: Record<string, string>;
  catalogLoadedAt: number;
  usage: UsageLite;
  quota: QuotaSnapshot | null;
  pricing: { asOf: string; sourceUrl: string; usdPerCredit: number };
  /** 0.2.0 : copie de settings.ui (mode d'affichage, règles acceptées, notice). */
  ui: UiSettings;
  /** 0.2.0 : niveaux résolus sur le catalogue Copilot de ce poste. */
  ai: { tiers: TierView[]; chatDefaultTier: Tier; allowModelOverride: boolean };
  /** RULES_VERSION du serveur : fenêtre « Avant de commencer » tant que ui.rulesAcceptedVersion est inférieur. */
  rulesVersion: number;
  /** COCKPIT_ALLOWED_PROVIDERS ; toute valeur autre que ["github-copilot"] affiche le bandeau « Mode test ». */
  allowedProviders: string[];
}

/** GET /api/usage/estimate (avec `agent` et `size` facultatifs depuis 0.2.0). */
export interface UsageEstimate {
  price: ModelPrice | null;
  avgUsd: number | null;
  samples: number;
  guard: GuardDecision;
  /** Moyenne observée de l'agent (≥ 5 demandes) sinon profil S/M/L au prix effectif ; null sans prix. */
  estimate: EstimateView | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageSummary {
  month: string;
  isCurrentMonth: boolean;
  startsAt: number;
  endsAt: number;
  generatedAt: number;
  budgetUsd: number;
  spentUsd: number;
  spentCredits: number;
  remainingUsd: number;
  percent: number;
  daysInMonth: number;
  daysElapsed: number;
  dailyBurnUsd: number;
  projectedUsd: number;
  daysUntilExhausted: number | null;
  prompts: number;
  calls: number;
  tokens: TokenTotals;
  byDay: Array<{ day: string; cost: number; calls: number }>;
  byModel: Array<{ providerID: string; modelID: string; cost: number; calls: number; tokensIn: number; tokensOut: number }>;
  byAgent: Array<{ agent: string; cost: number; calls: number }>;
  byPurpose: Array<{ purpose: string; cost: number; calls: number }>;
  byProject: Array<{ directory: string; cost: number; calls: number }>;
  byCategory: Array<{ category: string; cost: number; conversations: number }>;
  bySource: Array<{ source: string; cost: number; calls: number }>;
  topSessions: Array<{ rootId: string; title: string; directory: string; category: string | null; cost: number; calls: number; lastAt: number }>;
  months: string[];
  quota: QuotaSnapshot | null;
}

export interface GuardDecision {
  allowed: boolean;
  code?: "expensive-model" | "budget-exhausted";
  message?: string;
  percent: number;
  outputPricePerM: number | null;
}

export interface SessionUsage {
  cost: number;
  calls: number;
  tokens: TokenTotals;
  byModel: Array<{ providerID: string; modelID: string; cost: number; calls: number }>;
}

export interface Conversation {
  sessionId: string;
  directory: string;
  project: string;
  title: string;
  titleManual: boolean;
  category: string;
  tags: string[];
  summary: string;
  classifiedBy: "none" | "heuristic" | "llm" | "manual" | string;
  confidence: number | null;
  classifiedAt: number | null;
  promptsAtClassification: number;
  createdAt: number;
  updatedAt: number;
  promptCount: number;
  messageCount: number;
  cost: number;
  models: string[];
  tools: Record<string, number>;
  files: string[];
  additions: number;
  deletions: number;
  archivePath: string | null;
  pinned: boolean;
  deletedInOpencode: boolean;
  /** Extrait de recherche ; les passages trouvés sont encadrés par les caractères 2 et 3. */
  snippet?: string;
}

export interface ArchiveList {
  items: Conversation[];
  total: number;
}

export interface ArchiveStats {
  categories: Array<{ category: string; conversations: number; cost: number; lastAt: number | null }>;
  projects: string[];
}

export interface ArchiveDetail {
  conversation: Conversation;
  transcript: string;
  usage: SessionUsage;
}

export type StudioKind = "agents" | "commands" | "skills";

export interface StudioItem {
  kind: StudioKind;
  name: string;
  scope: "global" | "project";
  project: string | null;
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
  error: string | null;
  files: string[];
  updatedAt: number;
  /** Agents (0.2.0) : réglages inconnus déjà présents dans le fichier, tolérés avec cet avertissement. */
  warnings?: string[];
}

export interface StudioTemplate {
  kind: StudioKind;
  name: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** 0.2.0 : niveau conseillé (badge « Niveau conseillé : … ») ; null = l'IA vient de son assistant. */
  tier?: Tier | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface SystemStatus {
  version: string;
  node: string;
  uptimeSeconds: number;
  opencode: { reachable: boolean; version: string | null; url: string; supervisor: boolean; restarting: boolean };
  events: EventsStatus;
  browsers: number;
  security: {
    tlsInsecure: boolean;
    caFiles: number | null;
    httpProxy: boolean;
    httpsProxy: boolean;
    noProxy: string;
    allowedHosts: string[];
    projectConfig: boolean;
  };
  copilotConnected: boolean;
  catalog: { models: number; providers: string[]; loadedAt: number };
  quota: { latest: QuotaSnapshot | null; lastError: string | null };
  database: { sessions: number; usage: number; prompts: number; conversations: number };
  paths: { workspace: string; archives: string };
}

export interface PricingInfo {
  asOf: string;
  sourceUrl: string;
  usdPerCredit: number;
  table: Record<string, ModelPrice>;
  overrides: Record<string, ModelPrice>;
  catalog: Array<{ key: string; name: string; price: ModelPrice | null }>;
}

// --- Objets opencode -------------------------------------------------------------------

export interface OcTokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface OcSession {
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  cost?: number;
  tokens?: Omit<OcTokens, "total">;
  summary?: { additions: number; deletions: number; files: number };
  time: { created: number; updated: number; archived?: number; compacting?: number };
}

export interface OcError {
  name: string;
  data?: { message?: string; [key: string]: unknown };
}

export interface OcUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
}

export interface OcAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  error?: OcError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  cost: number;
  tokens: OcTokens;
  finish?: string;
  variant?: string;
}

export type OcMessage = OcUserMessage | OcAssistantMessage;

interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
}

export interface OcTextPart extends PartBase {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
}

export interface OcReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
  time?: { start: number; end?: number };
}

export type OcToolState =
  | { status: "pending"; input: Record<string, unknown>; raw?: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed";
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number; compacted?: number };
    }
  | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } };

export interface OcToolPart extends PartBase {
  type: "tool";
  callID: string;
  tool: string;
  state: OcToolState;
  metadata?: Record<string, unknown>;
}

export interface OcFilePart extends PartBase {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface OcStepFinishPart extends PartBase {
  type: "step-finish";
  reason: string;
  cost: number;
  tokens: OcTokens;
}

export interface OcPatchPart extends PartBase {
  type: "patch";
  hash: string;
  files: string[];
}

export interface OcSubtaskPart extends PartBase {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
}

export interface OcRetryPart extends PartBase {
  type: "retry";
  attempt: number;
  error: OcError;
  time: { created: number };
}

export interface OcCompactionPart extends PartBase {
  type: "compaction";
  auto: boolean;
  overflow?: boolean;
}

export interface OcOtherPart extends PartBase {
  type: "step-start" | "snapshot" | "agent";
  [key: string]: unknown;
}

export type OcPart =
  | OcTextPart
  | OcReasoningPart
  | OcToolPart
  | OcFilePart
  | OcStepFinishPart
  | OcPatchPart
  | OcSubtaskPart
  | OcRetryPart
  | OcCompactionPart
  | OcOtherPart;

export interface OcMessageWithParts {
  info: OcMessage;
  parts: OcPart[];
}

export type OcSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority: string;
}

export interface FileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export interface OcAgent {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  color?: string;
  model?: { modelID: string; providerID: string };
  variant?: string;
  /** Règles effectives (défauts, configuration globale, agent) dans l'ordre d'évaluation (agent/agent.ts:35-55). */
  permission?: Rule[];
  /** Consignes (corps du fichier d'agent). */
  prompt?: string;
}

export interface OcCommand {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: "command" | "mcp" | "skill";
  template: string;
  subtask?: boolean;
  hints: string[];
}

export interface ProviderAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string; hint?: string }>;
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: ProviderAuthPrompt[];
}

export interface ProviderAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export interface OcEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export type BrowserEvent =
  | { kind: "opencode"; directory?: string; event: OcEvent }
  | { kind: "cockpit"; type: string; data: unknown };

export interface BudgetAlert {
  month: string;
  threshold: number;
  percent: number;
  spentUsd: number;
  budgetUsd: number;
}
