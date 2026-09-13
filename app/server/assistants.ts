// Assistants (conception 0.2.0 §7) : un vrai fichier d'agent opencode (portée globale) + une ligne item_meta.
// Liste, catalogue, aperçu, enregistrement, adoption, suppression, fiches, inventaire des niveaux et réalignement.
// Toute écriture de fichier passe par StudioService (vérification par opencode et retour arrière).
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CATALOGUE, CATALOGUE_FICHES, type CatalogueFiche, REVIEW_BANNER } from "./assistants-catalogue.ts";
import type { ModelCatalog } from "./catalog.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import { type ItemMetaRow, params, transaction } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { stringifyFrontmatter } from "./frontmatter.ts";
import type { EventHub } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import { isAdvanced } from "./mode.ts";
import type { OcLookup, OcLookupSnapshot } from "./oc-lookup.ts";
import type { OpencodeClient } from "./opencode.ts";
import type { ProjectsService } from "./projects.ts";
import type { SettingsStore } from "./settings.ts";
import type {
  AssistantOrigin,
  AssistantPreview,
  AssistantState,
  AssistantsResponse,
  AssistantView,
  BuiltinAssistantView,
  CatalogueItem,
  EstimateView,
  FicheInfo,
  IssueLite,
  ItemKind,
  KeepModelResponse,
  MissingItem,
  RealignRequest,
  RealignResponse,
  SavedAssistant,
  ToCompleteItem,
  UpdateItem,
  UsageRow,
  UsageRowState,
  UsageRowType,
} from "./shared/api-types.ts";
import {
  ASSISTANT_ICONS,
  type AssistantDraft,
  type AssistantFile,
  assistantPermission,
  BUILTIN_ASSISTANTS,
  buildAssistantFile,
  type CatalogLite,
  catalogEntry,
  chooseEstimate,
  DRAFT_LIMITS,
  detectRights,
  draftVariant,
  type Estimate,
  effectiveAgentRules,
  effectiveTiers,
  estimateTaskCost,
  estimateText,
  expensiveGuardNote,
  FICHE_NAME_RE,
  fallbackText,
  isSubtask,
  MESSAGES,
  modelKey,
  modelName,
  NAME_RE,
  parseModelKey,
  providerOf,
  REFLECTIONS,
  RIGHTS_PROFILES,
  type RightLine,
  rightLines,
  slugifyName,
  stripCommonRules,
  TASK_SIZES,
  TASK_STEPS,
  type TaskSize,
  TIER_IDS,
  TIER_LABELS,
  type Tier,
  type TierDefs,
  type TierResolution,
  type TierStatus,
  tierOfModel,
  USE_CASE_INFO,
  USE_CASES,
  uniqueName,
  variantLabel,
} from "./shared/assistant-rules.ts";
import { StudioApplyError, type StudioItem, type StudioScope, type StudioService, StudioValidationError } from "./studio.ts";
import { issuesFrom, modelRefSchema, nameSchema } from "./studio-schema.ts";
import { TEMPLATES } from "./templates.ts";
import type { TierService } from "./tiers.ts";

// --- Validation -------------------------------------------------------------------------------

const ficheNameSchema = z
  .string()
  .max(64, "Nom de fiche trop long (64 caractères au plus).")
  .regex(FICHE_NAME_RE, "Nom de fiche invalide : minuscules, chiffres et tirets.");

const DRAFT_SHAPE = {
  title: z
    .string()
    .trim()
    .min(DRAFT_LIMITS.titleMin, "Donnez un nom à l'assistant (3 caractères au moins).")
    .max(DRAFT_LIMITS.titleMax, "Nom de l'assistant trop long (80 caractères au plus)."),
  description: z
    .string()
    .trim()
    .min(DRAFT_LIMITS.descriptionMin, "Cette phrase est obligatoire : elle explique son rôle à l'IA.")
    .max(DRAFT_LIMITS.descriptionMax, "Phrase trop longue (500 caractères au plus)."),
  useCase: z.enum(USE_CASES, { error: "Type de tâche inconnu." }),
  rights: z.enum(RIGHTS_PROFILES, { error: "Profil de droits inconnu." }),
  web: z.boolean({ error: "Choix « Consulter Internet » invalide." }),
  tier: z.enum(TIER_IDS, { error: "Niveau d'IA inconnu." }).nullable(),
  model: modelRefSchema.nullable().optional(),
  reflection: z.enum(REFLECTIONS, { error: "Réflexion inconnue." }),
  taskSize: z.enum(TASK_SIZES, { error: "Taille de demande inconnue." }),
  instructions: z
    .string()
    .trim()
    .min(DRAFT_LIMITS.instructionsMin, "Les consignes sont trop courtes (20 caractères au moins).")
    .max(DRAFT_LIMITS.instructionsMax, "Les consignes sont trop longues (20 000 caractères au plus)."),
  fiches: z.array(ficheNameSchema).max(DRAFT_LIMITS.fichesMax, "10 fiches au plus."),
  examples: z
    .array(z.string().trim().max(DRAFT_LIMITS.exampleMax, "Exemple trop long (200 caractères au plus)."))
    .max(DRAFT_LIMITS.examplesMax, "3 exemples au plus.")
    .transform((list) => list.filter((example) => example.length > 0)),
  icon: z.enum(ASSISTANT_ICONS, { error: "Icône inconnue." }),
  name: nameSchema.optional(),
};

const strictObjectError = {
  error: (issue: { code?: string }) => (issue.code === "unrecognized_keys" ? "Champ non accepté." : undefined),
};

/** Brouillon d'assistant (zod strict, bornes DRAFT_LIMITS, noms de fiches FICHE_NAME_RE). */
export const assistantDraftSchema = z.strictObject(DRAFT_SHAPE, strictObjectError) satisfies z.ZodType<AssistantDraft>;

/** Corps de PUT /api/assistants/:name et de l'aperçu : brouillon + ancien nom. */
export const assistantSaveSchema = z.strictObject({ ...DRAFT_SHAPE, previousName: nameSchema.nullable().optional() }, strictObjectError);

const adoptSchema = z.strictObject({ title: DRAFT_SHAPE.title, useCase: DRAFT_SHAPE.useCase, taskSize: DRAFT_SHAPE.taskSize }, strictObjectError);

export class AssistantServiceError extends Error {
  override name = "AssistantServiceError";
  readonly status: 400 | 403 | 404 | 409 | 422 | 428;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: 400 | 403 | 404 | 409 | 422 | 428, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface AssistantServiceDeps {
  db: DatabaseSync;
  env: AppEnv;
  client: OpencodeClient;
  studio: StudioService;
  lookup: OcLookup;
  tiers: TierService;
  ledger: Ledger;
  settings: SettingsStore;
  catalog: ModelCatalog;
  projects: ProjectsService;
  hub: EventHub;
  log: Logger;
}

// --- Constantes et petits utilitaires ----------------------------------------------------------

const GLOBAL: StudioScope = { type: "global" };

/** Agents natifs d'opencode 1.18.30 : un fichier du même nom les remplacerait. */
const NATIVE_AGENTS = ["build", "plan", "general", "explore", "compaction", "title", "summary"] as const;

/** Règles approximatives des assistants intégrés quand GET /agent est injoignable (repli signalé effectiveRules: false). */
const BUILTIN_FALLBACK_PERMISSION: Readonly<Record<"build" | "plan", Record<string, unknown>>> = {
  build: {},
  plan: { edit: { "*": "deny" } },
};

const USAGE_STATE_TEXT: Readonly<Record<UsageRowState, string>> = {
  "a-jour": "À jour",
  "mise-a-jour": "Mise à jour disponible",
  "modifie-hors-cockpit": "Modifié hors du cockpit",
  "a-ranger": "À ranger",
  introuvable: "Fichier introuvable",
  aucun: "—",
};

const USAGE_TYPE_LABELS: Readonly<Record<UsageRowType, string>> = {
  assistant: "Assistant",
  raccourci: "Raccourci",
  agent: "Agent",
  integre: "Intégré",
};

/** Fenêtre des sessions récentes dont le dossier est interrogé avant un réalignement. */
const RECENT_SESSION_MS = 24 * 3_600_000;

const GLOBAL_CONFIG_UNREACHABLE =
  "Le moteur de l'assistant ne répond pas : les droits affichés ne tiennent pas compte de la configuration globale.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (values as readonly string[]).includes(v);

const isTier = oneOf(TIER_IDS);
const isTaskSize = oneOf(TASK_SIZES);
const isUseCase = oneOf(USE_CASES);
const isIcon = oneOf(ASSISTANT_ICONS);

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const validName = (name: string) => name.length <= 64 && NAME_RE.test(name);

function assertName(name: string, message = "Nom d'assistant invalide."): void {
  if (!validName(name)) throw new AssistantServiceError(400, "invalid", message);
}

const notFound = (message: string) => new AssistantServiceError(404, "not-found", message);

const sessionsBusyError = () => new AssistantServiceError(409, "sessions-busy", MESSAGES.sessionsBusy);

function tierUnavailableMessage(tier: Tier): string {
  return `Aucune IA de niveau ${TIER_LABELS[tier]} n'est disponible sur votre compte Copilot. Choisissez un autre niveau ou demandez l'accès à votre administrateur Copilot.`;
}

function nameTakenMessage(name: string): string {
  return `Le nom « ${name} » est déjà utilisé par un autre agent.`;
}

function usedByMessage(commands: readonly string[]): string {
  return commands.map((command) => `Le raccourci /${command} utilise cet assistant : il ne fonctionnera plus.`).join(" ");
}

function estimateView(estimate: Estimate | null): EstimateView | null {
  return estimate ? { ...estimate, text: estimateText(estimate), detailText: estimateText(estimate, true) } : null;
}

function parseExamples(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((e): e is string => typeof e === "string").slice(0, DRAFT_LIMITS.examplesMax) : [];
  } catch {
    return [];
  }
}

/** Décisions affichées (id + ✓/✗/?) : base de la comparaison aperçu / règles réellement appliquées. */
function sameDecisions(a: readonly RightLine[], b: readonly RightLine[]): boolean {
  const key = (lines: readonly RightLine[]) => lines.map((l) => `${l.id}:${l.kind}`).join("|");
  return key(a) === key(b);
}

function takenNames(agents: ReadonlyMap<string, StudioItem>, snapshot: OcLookupSnapshot | null): Set<string> {
  return new Set([...agents.keys(), ...(snapshot?.agents.map((a) => a.name) ?? []), ...NATIVE_AGENTS, CLASSIFIER_AGENT]);
}

/** Brouillon « au mieux » quand le corps est invalide : l'aperçu reste affichable avec ses erreurs. */
function lenientRequest(input: unknown): { draft: AssistantDraft; previousName: string | null } {
  const raw = isRecord(input) ? input : {};
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const result = schema.safeParse(value);
    return result.success ? result.data : fallback;
  };
  const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const draft: AssistantDraft = {
    title: clip(raw.title, DRAFT_LIMITS.titleMax),
    description: clip(raw.description, DRAFT_LIMITS.descriptionMax),
    useCase: pick(DRAFT_SHAPE.useCase, raw.useCase, "autre"),
    rights: pick(DRAFT_SHAPE.rights, raw.rights, "lecture"),
    web: raw.web === true,
    tier: pick(DRAFT_SHAPE.tier, raw.tier, "equilibre"),
    model: pick(DRAFT_SHAPE.model, raw.model, null) ?? null,
    reflection: pick(DRAFT_SHAPE.reflection, raw.reflection, "standard"),
    taskSize: pick(DRAFT_SHAPE.taskSize, raw.taskSize, "M"),
    instructions: clip(raw.instructions, DRAFT_LIMITS.instructionsMax),
    fiches: Array.isArray(raw.fiches)
      ? [...new Set(raw.fiches.filter((f): f is string => ficheNameSchema.safeParse(f).success))].slice(0, DRAFT_LIMITS.fichesMax)
      : [],
    examples: Array.isArray(raw.examples)
      ? raw.examples
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim().slice(0, DRAFT_LIMITS.exampleMax))
          .filter((e) => e.length > 0)
          .slice(0, DRAFT_LIMITS.examplesMax)
      : [],
    icon: pick(DRAFT_SHAPE.icon, raw.icon, "sparkle"),
  };
  const name = nameSchema.safeParse(raw.name);
  if (name.success) draft.name = name.data;
  const previous = nameSchema.safeParse(raw.previousName);
  return { draft, previousName: previous.success ? previous.data : null };
}

/** Fiche livrée par le catalogue, sinon exemple de fiche du Studio (avec le bandeau de relecture). */
function ficheSource(name: string): CatalogueFiche | null {
  const shipped = CATALOGUE_FICHES.find((f) => f.name === name);
  if (shipped) return shipped;
  const template = TEMPLATES.find((t) => t.kind === "skills" && t.name === name);
  if (!template) return null;
  const description = typeof template.frontmatter.description === "string" ? template.frontmatter.description : template.title;
  const body = template.body.startsWith(REVIEW_BANNER) ? template.body : `${REVIEW_BANNER}\n\n${template.body}`;
  return { name, description, body };
}

/**
 * true si une conversation n'est pas au repos (GET /session/status?directory=…). Avec `db`, seuls l'instance par défaut
 * et les dossiers de sessions récentes sont interrogés : chaque `directory` démarre une instance d'opencode.
 */
export async function probeSessionsBusy(deps: { client: OpencodeClient; projects: ProjectsService; db?: DatabaseSync }): Promise<boolean> {
  const directories = new Set<string | null>([null]);
  if (deps.db) {
    const rows = deps.db
      .prepare("SELECT DISTINCT directory FROM sessions WHERE deleted_at IS NULL AND directory != '' AND updated_at >= ? LIMIT 100")
      .all(Date.now() - RECENT_SESSION_MS) as Array<{ directory: string }>;
    for (const row of rows) if (deps.projects.isAllowedDirectory(row.directory)) directories.add(row.directory);
  } else {
    for (const project of await deps.projects.list()) directories.add(project.directory);
  }
  const answers = await Promise.all(
    [...directories].map((directory) =>
      deps.client.request<unknown>("GET", "/session/status", { ...(directory ? { directory } : {}), timeoutMs: 10_000 }),
    ),
  );
  // Une session absente de la réponse est au repos ; toute autre forme que { type: "idle" } compte comme occupée.
  return answers.some((status) => isRecord(status) && Object.values(status).some((s) => !isRecord(s) || s.type !== "idle"));
}

// --- Service -----------------------------------------------------------------------------------

type MetaInput = Omit<ItemMetaRow, "created_at" | "updated_at">;

interface ViewContext {
  rows: ItemMetaRow[];
  agents: Map<string, StudioItem>;
  commands: Map<string, StudioItem>;
  snapshot: OcLookupSnapshot | null;
  globalPermission: unknown;
  catalog: CatalogLite[];
  defs: TierDefs;
  resolved: Record<Tier, TierResolution>;
}

interface Prepared {
  preview: AssistantPreview;
  /** Brouillon validé (sans erreur) ou reconstitué au mieux (avec erreurs). */
  draft: AssistantDraft;
  previousName: string | null;
  agents: Map<string, StudioItem>;
  taken: Set<string>;
  fiches: string[];
  steps: number;
}

export class AssistantService {
  readonly #d: AssistantServiceDeps;

  constructor(deps: AssistantServiceDeps) {
    this.#d = deps;
  }

  // --- Base item_meta -----------------------------------------------------------------------

  #rows(kind?: ItemKind): ItemMetaRow[] {
    const { db } = this.#d;
    return (
      kind
        ? db.prepare("SELECT * FROM item_meta WHERE kind = ? ORDER BY name").all(kind)
        : db.prepare("SELECT * FROM item_meta ORDER BY kind, name").all()
    ) as unknown as ItemMetaRow[];
  }

  #row(kind: ItemKind, name: string): ItemMetaRow | undefined {
    return this.#d.db.prepare("SELECT * FROM item_meta WHERE kind = ? AND name = ?").get(kind, name) as unknown as ItemMetaRow | undefined;
  }

  #deleteRow(kind: ItemKind, name: string): number {
    return Number(this.#d.db.prepare("DELETE FROM item_meta WHERE kind = ? AND name = ?").run(kind, name).changes);
  }

  #upsert(row: MetaInput, now = Date.now()): void {
    this.#d.db
      .prepare(
        `INSERT INTO item_meta (kind, name, title, use_case, icon, tier, rights, task_size, examples, origin, catalog_id,
           catalog_version, applied_model, applied_variant, created_at, updated_at)
         VALUES (:kind, :name, :title, :use_case, :icon, :tier, :rights, :task_size, :examples, :origin, :catalog_id,
           :catalog_version, :applied_model, :applied_variant, :now, :now)
         ON CONFLICT(kind, name) DO UPDATE SET
           title = excluded.title, use_case = excluded.use_case, icon = excluded.icon, tier = excluded.tier,
           rights = excluded.rights, task_size = excluded.task_size, examples = excluded.examples, origin = excluded.origin,
           catalog_id = excluded.catalog_id, catalog_version = excluded.catalog_version, applied_model = excluded.applied_model,
           applied_variant = excluded.applied_variant, updated_at = excluded.updated_at`,
      )
      .run(
        params({
          kind: row.kind,
          name: row.name,
          title: row.title,
          use_case: row.use_case,
          icon: row.icon,
          tier: row.tier,
          rights: row.rights,
          task_size: row.task_size,
          examples: row.examples,
          origin: row.origin,
          catalog_id: row.catalog_id,
          catalog_version: row.catalog_version,
          applied_model: row.applied_model,
          applied_variant: row.applied_variant,
          now,
        }),
      );
  }

  // --- Lectures (fichiers, opencode) ----------------------------------------------------------

  async #files(kind: ItemKind | "skills"): Promise<Map<string, StudioItem>> {
    const items = await this.#d.studio.list(kind, GLOBAL);
    return new Map(items.map((item) => [item.name, item]));
  }

  async #snapshot(): Promise<OcLookupSnapshot | null> {
    try {
      return await this.#d.lookup.get(null);
    } catch (err) {
      this.#d.log.warn("agents d'opencode indisponibles : repli sur les fichiers", { error: errorMessage(err) });
      return null;
    }
  }

  async #globalPermission(): Promise<{ permission: unknown; ok: boolean }> {
    try {
      const config = await this.#d.client.request<unknown>("GET", "/global/config", { timeoutMs: 10_000 });
      return { permission: isRecord(config) ? (config.permission ?? {}) : {}, ok: true };
    } catch (err) {
      this.#d.log.warn("configuration globale d'opencode indisponible", { error: errorMessage(err) });
      return { permission: {}, ok: false };
    }
  }

  async #context(options: { defs?: TierDefs | null; snapshot?: boolean; global?: boolean } = {}): Promise<ViewContext> {
    const [agents, commands, snapshot, global] = await Promise.all([
      this.#files("agents"),
      this.#files("commands"),
      options.snapshot === false ? Promise.resolve(null) : this.#snapshot(),
      options.global === false ? Promise.resolve({ permission: {}, ok: false }) : this.#globalPermission(),
    ]);
    const { tiers } = this.#d;
    return {
      rows: this.#rows(),
      agents,
      commands,
      snapshot,
      globalPermission: global.permission,
      catalog: this.#d.catalog.lite(),
      defs: options.defs === undefined ? tiers.definitions() : effectiveTiers(options.defs),
      resolved: tiers.resolveAll(options.defs),
    };
  }

  #observed(agent: string, model: string): { avgUsd: number | null; samples: number } | null {
    try {
      return this.#d.ledger.estimateAgent(agent, parseModelKey(model));
    } catch (err) {
      this.#d.log.warn("moyenne observée indisponible", { agent, error: errorMessage(err) });
      return null;
    }
  }

  #guardNote(model: string | null): string | null {
    return model && this.#d.tiers.isExpensive(model) ? expensiveGuardNote(this.#d.settings.get().budget.guard.fromPercent) : null;
  }

  // --- Vues ------------------------------------------------------------------------------------

  /** Élément lié à un niveau dont le fichier n'utilise pas l'IA résolue du niveau (ou réalignement forcé). */
  #updateFor(row: ItemMetaRow, file: StudioItem, ctx: Pick<ViewContext, "catalog" | "defs" | "resolved">, force = false): UpdateItem | null {
    if (!isTier(row.tier)) return null;
    const tier = row.tier;
    const res = ctx.resolved[tier];
    // Catalogue non chargé (« non vérifié ») ou niveau indisponible : aucune mise à jour proposée.
    if ((res.status !== "ok" && res.status !== "secours") || !res.model) return null;
    const from = text(file.frontmatter.model);
    if (res.model === from && !force) return null;
    const fileVariant = text(file.frontmatter.variant);
    const offered = catalogEntry(ctx.catalog, res.model)?.variants ?? [];
    // Une réflexion propre à l'élément (≠ celle du niveau) est gardée si la nouvelle IA la propose.
    const own = fileVariant !== null && fileVariant !== ctx.defs[tier].variant ? fileVariant : null;
    const variant = own !== null && offered.includes(own) ? own : res.variant;
    const size = isTaskSize(row.task_size) ? row.task_size : "M";
    const cost = (model: string | null) => {
      const price = model ? this.#d.tiers.priceOf(model) : null;
      return price ? estimateTaskCost(price, size) : null;
    };
    const fromUsd = cost(from);
    const toUsd = cost(res.model);
    return {
      kind: row.kind,
      name: row.name,
      title: row.title ?? (row.kind === "commands" ? `/${row.name}` : row.name),
      tier,
      from,
      fromName: from ? modelName(from, ctx.catalog) : null,
      to: res.model,
      toName: modelName(res.model, ctx.catalog),
      variant,
      fromUsd,
      toUsd,
      ratio: fromUsd !== null && toUsd !== null && fromUsd > 0 ? Math.round((toUsd / fromUsd) * 100) / 100 : null,
    };
  }

  #updates(ctx: ViewContext): UpdateItem[] {
    const out: UpdateItem[] = [];
    for (const row of ctx.rows) {
      const file = (row.kind === "agents" ? ctx.agents : ctx.commands).get(row.name);
      const update = file ? this.#updateFor(row, file, ctx) : null;
      if (update) out.push(update);
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, "fr"));
  }

  #usedBy(name: string, ctx: Pick<ViewContext, "commands" | "snapshot">): string[] {
    const names = new Set<string>();
    for (const [command, file] of ctx.commands) if (file.frontmatter.agent === name) names.add(command);
    for (const command of ctx.snapshot?.commands ?? []) {
      if (command.agent === name && (command.source === undefined || command.source === "command")) names.add(command.name);
    }
    return [...names].sort();
  }

  #view(row: ItemMetaRow, file: StudioItem, ctx: ViewContext): AssistantView {
    const fm = file.frontmatter;
    const model = text(fm.model);
    const variant = text(fm.variant);
    const steps = typeof fm.steps === "number" ? fm.steps : typeof fm.maxSteps === "number" ? fm.maxSteps : null;
    const detected = detectRights(fm.permission);
    const taskSize = isTaskSize(row.task_size) ? row.task_size : "M";
    const oc = ctx.snapshot?.agents.find((a) => a.name === row.name);
    const rules = oc ? oc.permission : effectiveAgentRules(ctx.globalPermission, fm.permission);
    const update = this.#updateFor(row, file, ctx);
    const unavailable = ctx.catalog.length > 0 && model !== null && !catalogEntry(ctx.catalog, model);
    const modified = model !== row.applied_model || variant !== row.applied_variant;
    const state: AssistantState = unavailable ? "ia-indisponible" : modified ? "modifie-hors-cockpit" : update ? "mise-a-jour" : "ok";
    const estimate = model ? chooseEstimate(this.#observed(row.name, model), this.#d.tiers.priceOf(model), taskSize) : null;
    const expensive = model ? this.#d.tiers.isExpensive(model) : false;
    return {
      name: row.name,
      title: row.title ?? row.name,
      description: typeof fm.description === "string" ? fm.description : "",
      useCase: isUseCase(row.use_case) ? row.use_case : null,
      icon: isIcon(row.icon) ? row.icon : null,
      origin: row.origin,
      catalogId: row.catalog_id,
      catalogVersion: row.catalog_version,
      tier: isTier(row.tier) ? row.tier : null,
      taskSize,
      rights: detected.rights,
      web: detected.web,
      fiches: detected.fiches,
      examples: parseExamples(row.examples),
      instructions: stripCommonRules(file.body),
      model,
      modelName: model ? modelName(model, ctx.catalog) : null,
      variant,
      variantLabel: variantLabel(variant),
      steps,
      appliedModel: row.applied_model,
      appliedVariant: row.applied_variant,
      state,
      update,
      estimate: estimateView(estimate),
      expensive,
      guardNote: this.#guardNote(model),
      rightLines: rightLines(rules, detected.fiches, steps),
      effectiveRules: Boolean(oc),
      usedBy: this.#usedBy(row.name, ctx),
      mode: fm.mode === "primary" || fm.mode === "subagent" || fm.mode === "all" ? fm.mode : "all",
      hidden: fm.hidden === true,
      file: file.file,
      updatedAt: file.updatedAt,
    };
  }

  async #viewOf(name: string): Promise<AssistantView> {
    const ctx = await this.#context();
    const row = ctx.rows.find((r) => r.kind === "agents" && r.name === name && r.title !== null);
    const file = ctx.agents.get(name);
    if (!row || !file) throw notFound("Assistant introuvable.");
    return this.#view(row, file, ctx);
  }

  #builtins(ctx: ViewContext): BuiltinAssistantView[] {
    const tier = this.#d.settings.get().ai.chatDefaultTier;
    const res = ctx.resolved[tier];
    const out: BuiltinAssistantView[] = [];
    for (const name of ["build", "plan"] as const) {
      const oc = ctx.snapshot?.agents.find((a) => a.name === name);
      // Absent de GET /agent : assistant intégré désactivé (disable: true).
      if (ctx.snapshot && !oc) continue;
      const model = oc?.model ? modelKey(oc.model) : res.model;
      const rules = oc ? oc.permission : effectiveAgentRules(ctx.globalPermission, BUILTIN_FALLBACK_PERMISSION[name]);
      const estimate = model ? chooseEstimate(this.#observed(name, model), this.#d.tiers.priceOf(model), "M") : null;
      out.push({
        name,
        title: BUILTIN_ASSISTANTS[name].title,
        help: BUILTIN_ASSISTANTS[name].help,
        tier,
        model,
        modelName: model ? modelName(model, ctx.catalog) : null,
        rightLines: rightLines(rules, [], oc?.steps ?? null),
        effectiveRules: Boolean(oc),
        estimate: estimateView(estimate),
      });
    }
    return out;
  }

  #toComplete(ctx: ViewContext): ToCompleteItem[] {
    const titled = new Set(ctx.rows.filter((r) => r.kind === "agents" && r.title !== null).map((r) => r.name));
    const out: ToCompleteItem[] = [];
    for (const [name, file] of ctx.agents) {
      if (titled.has(name) || name === CLASSIFIER_AGENT) continue;
      const fm = file.frontmatter;
      const oc = ctx.snapshot?.agents.find((a) => a.name === name);
      // Présent sur disque mais absent de GET /agent : désactivé ou refusé par opencode.
      if (ctx.snapshot && !oc) continue;
      const mode = oc ? oc.mode : fm.mode === "primary" || fm.mode === "subagent" ? fm.mode : "all";
      if (mode === "subagent" || (oc ? oc.hidden === true : fm.hidden === true) || oc?.native || fm.disable === true) continue;
      const model = oc?.model ? modelKey(oc.model) : text(fm.model);
      const detected = detectRights(fm.permission);
      const rules = oc ? oc.permission : effectiveAgentRules(ctx.globalPermission, fm.permission);
      out.push({
        name,
        description: oc?.description ?? (typeof fm.description === "string" ? fm.description : ""),
        mode,
        model,
        modelName: model ? modelName(model, ctx.catalog) : null,
        variant: oc?.variant ?? text(fm.variant),
        inferredTier: model ? tierOfModel(model, ctx.resolved) : null,
        rights: detected.rights,
        rightLines: rightLines(rules, detected.fiches, typeof fm.steps === "number" ? fm.steps : null),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  #missing(ctx: ViewContext): MissingItem[] {
    return ctx.rows
      .filter((row) => !(row.kind === "agents" ? ctx.agents : ctx.commands).has(row.name))
      .map((row) => ({ kind: row.kind, name: row.name, title: row.title, tier: isTier(row.tier) ? row.tier : null }));
  }

  // --- API ---------------------------------------------------------------------------------------

  async list(): Promise<AssistantsResponse> {
    const ctx = await this.#context();
    const assistants = ctx.rows
      .filter((row) => row.kind === "agents" && row.title !== null && ctx.agents.has(row.name))
      .map((row) => this.#view(row, ctx.agents.get(row.name) as StudioItem, ctx))
      .sort((a, b) => a.title.localeCompare(b.title, "fr"));
    return { assistants, builtins: this.#builtins(ctx), toComplete: this.#toComplete(ctx), updates: this.#updates(ctx), missing: this.#missing(ctx) };
  }

  async catalogue(): Promise<CatalogueItem[]> {
    const [agents, skills, global] = await Promise.all([this.#files("agents"), this.#files("skills"), this.#globalPermission()]);
    const rows = this.#rows("agents");
    const catalog = this.#d.catalog.lite();
    return CATALOGUE.map((entry): CatalogueItem => {
      const installed = rows.find((row) => row.catalog_id === entry.id && agents.has(row.name));
      const res = this.#d.tiers.resolve(entry.tier);
      const price = res.model ? this.#d.tiers.priceOf(res.model) : null;
      const permission = assistantPermission(entry.rights, entry.web, entry.fiches);
      return {
        id: entry.id,
        version: entry.version,
        title: entry.title,
        description: entry.description,
        useCase: entry.useCase,
        icon: entry.icon,
        rights: entry.rights,
        web: entry.web,
        tier: entry.tier,
        taskSize: entry.taskSize,
        fiches: [...entry.fiches],
        examples: [...entry.examples],
        instructions: entry.instructions,
        installed: Boolean(installed),
        installedName: installed?.name ?? null,
        newFiches: entry.fiches.filter((fiche) => !skills.has(fiche)),
        model: res.model,
        modelName: res.model ? modelName(res.model, catalog) : null,
        tierStatus: res.status,
        estimate: estimateView(chooseEstimate(null, price, entry.taskSize)),
        expensive: res.model ? this.#d.tiers.isExpensive(res.model) : false,
        rightLines: rightLines(effectiveAgentRules(global.permission, permission), entry.fiches, TASK_STEPS[entry.taskSize]),
        review: MESSAGES.catalogueReview,
      };
    });
  }

  /** Crée une fiche manquante ; une fiche existante n'est jamais écrasée. */
  async #installFiche(name: string): Promise<void> {
    const { studio, hub, log } = this.#d;
    if (await studio.get("skills", name, GLOBAL)) return;
    const source = ficheSource(name);
    if (!source) {
      log.warn("fiche du catalogue introuvable dans le cockpit", { fiche: name });
      return;
    }
    try {
      await studio.save("skills", GLOBAL, { name, frontmatter: { description: source.description }, body: source.body, createOnly: true });
      hub.cockpit("studio.changed", { kind: "skills", name });
    } catch (err) {
      // Créée entre-temps par quelqu'un d'autre : on la garde telle quelle.
      if (err instanceof StudioValidationError && (await studio.get("skills", name, GLOBAL))) return;
      throw err;
    }
  }

  async install(id: string, requestedName?: string): Promise<AssistantView> {
    const entry = CATALOGUE.find((e) => e.id === id);
    if (!entry) throw notFound("Assistant du catalogue introuvable.");
    const agents = await this.#files("agents");
    const already = this.#rows("agents").find((row) => row.catalog_id === entry.id && row.title !== null && agents.has(row.name));
    if (already) return this.#viewOf(already.name);
    if (requestedName !== undefined) assertName(requestedName);
    const taken = takenNames(agents, await this.#snapshot());
    if (requestedName !== undefined && taken.has(requestedName)) {
      throw new AssistantServiceError(409, "name-taken", nameTakenMessage(requestedName), { name: requestedName });
    }
    if (!this.#d.catalog.loaded) throw new AssistantServiceError(409, "catalogue-indisponible", MESSAGES.catalogueIndisponible);
    const res = this.#d.tiers.resolve(entry.tier);
    if (!res.model || (res.status !== "ok" && res.status !== "secours")) {
      throw new AssistantServiceError(422, "ia-indisponible", tierUnavailableMessage(entry.tier), { tier: entry.tier });
    }
    const name = requestedName ?? uniqueName(entry.id, taken);
    for (const fiche of entry.fiches) await this.#installFiche(fiche);
    const variant = draftVariant("standard", res.variant, catalogEntry(this.#d.catalog.lite(), res.model)?.variants ?? null);
    const draft: AssistantDraft = {
      title: entry.title,
      description: entry.description,
      useCase: entry.useCase,
      rights: entry.rights,
      web: entry.web,
      tier: entry.tier,
      reflection: "standard",
      taskSize: entry.taskSize,
      instructions: entry.instructions,
      fiches: [...entry.fiches],
      examples: [...entry.examples],
      icon: entry.icon,
      name,
    };
    const file = buildAssistantFile(draft, { model: res.model, variant });
    const item = await this.#d.studio.save("agents", GLOBAL, { name, frontmatter: file.frontmatter, body: file.body, createOnly: true });
    this.#upsert({
      kind: "agents",
      name,
      title: entry.title,
      use_case: entry.useCase,
      icon: entry.icon,
      tier: entry.tier,
      rights: entry.rights,
      task_size: entry.taskSize,
      examples: JSON.stringify(entry.examples),
      origin: "catalogue",
      catalog_id: entry.id,
      catalog_version: entry.version,
      applied_model: text(item.frontmatter.model),
      applied_variant: text(item.frontmatter.variant),
    });
    this.#d.lookup.invalidate();
    this.#d.hub.cockpit("studio.changed", { kind: "agents", name });
    return this.#viewOf(name);
  }

  /** Aperçu et contrôles communs à POST /api/assistants/preview et PUT /api/assistants/:name. N'écrit rien. */
  async #prepare(input: unknown, pathName: string | null): Promise<Prepared> {
    const parsed = assistantSaveSchema.safeParse(input);
    const issues: IssueLite[] = parsed.success ? [] : issuesFrom(parsed.error);
    let draft: AssistantDraft;
    let previousName: string | null;
    if (parsed.success) {
      const { previousName: previous, ...rest } = parsed.data;
      draft = rest;
      previousName = previous ?? null;
    } else {
      ({ draft, previousName } = lenientRequest(input));
    }

    const { tiers, catalog, settings, env } = this.#d;
    const [agents, snapshot, global] = await Promise.all([this.#files("agents"), this.#snapshot(), this.#globalPermission()]);
    const warnings: string[] = [];
    if (!global.ok) warnings.push(GLOBAL_CONFIG_UNREACHABLE);
    const taken = takenNames(agents, snapshot);
    const name = pathName ?? previousName ?? draft.name ?? uniqueName(slugifyName(draft.title), taken);
    if (pathName === null && previousName === null && draft.name !== undefined && taken.has(draft.name)) {
      issues.push({ path: "name", message: nameTakenMessage(draft.name) });
    }

    const lite = catalog.lite();
    let model: string | null = null;
    let status: TierStatus = "ok";
    let tierVariant: string | null = null;
    if (draft.tier !== null) {
      const res = tiers.resolve(draft.tier);
      status = res.status;
      tierVariant = res.variant;
      if (res.status === "indisponible" || !res.model) {
        issues.push({ path: "tier", message: tierUnavailableMessage(draft.tier) });
      } else {
        model = res.model;
        if (res.status === "non-verifie") issues.push({ path: "tier", message: MESSAGES.catalogueIndisponible });
        if (res.status === "secours") {
          const planned = tiers.definitions()[draft.tier].candidates[0];
          if (planned) warnings.push(fallbackText(modelName(planned, lite), modelName(res.model, lite)));
        }
        warnings.push(...res.warnings.filter((w) => w.endsWith("réflexion standard utilisée.")));
      }
    } else if (!draft.model) {
      issues.push({ path: "tier", message: "Choisissez un niveau d'IA." });
      status = "indisponible";
    } else {
      model = draft.model;
      if (!isAdvanced(settings)) issues.push({ path: "model", message: MESSAGES.modeAvance });
      if (!env.allowedProviders.includes(providerOf(model))) {
        issues.push({ path: "model", message: MESSAGES.fournisseurRefuse });
        status = "indisponible";
      } else if (!catalog.loaded) {
        issues.push({ path: "model", message: MESSAGES.catalogueIndisponible });
        status = "non-verifie";
      } else if (!catalogEntry(lite, model)) {
        issues.push({ path: "model", message: MESSAGES.iaAbsenteDuCompte });
        status = "indisponible";
      }
    }

    const offered = model && lite.length > 0 ? (catalogEntry(lite, model)?.variants ?? []) : null;
    const variant = model ? draftVariant(draft.reflection, tierVariant, offered) : null;
    if (model && draft.reflection === "poussee" && variant !== "high") {
      warnings.push("Cette IA ne propose pas la réflexion poussée : réflexion standard utilisée.");
    }

    let file: AssistantFile;
    try {
      file = buildAssistantFile({ ...draft, name }, { model: model ?? "", variant });
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      issues.push({ path: "name", message: err.message });
      file = buildAssistantFile({ ...draft, name: "assistant", fiches: [] }, { model: model ?? "", variant });
    }
    if (!model) delete file.frontmatter.model;

    const steps = TASK_STEPS[draft.taskSize];
    const lines = rightLines(effectiveAgentRules(global.permission, file.frontmatter.permission), draft.fiches, steps);
    const estimate = model ? chooseEstimate(this.#observed(name, model), tiers.priceOf(model), draft.taskSize) : null;
    const preview: AssistantPreview = {
      name,
      frontmatter: file.frontmatter,
      body: file.body,
      file: stringifyFrontmatter(file.frontmatter, file.body),
      rightLines: lines,
      model,
      modelName: model ? modelName(model, lite) : null,
      variant,
      status,
      estimate: estimateView(estimate),
      guardNote: this.#guardNote(model),
      issues,
      warnings,
    };
    return { preview, draft, previousName, agents, taken, fiches: draft.fiches, steps };
  }

  async preview(input: unknown): Promise<AssistantPreview> {
    return (await this.#prepare(input, null)).preview;
  }

  async save(name: string, input: unknown): Promise<SavedAssistant> {
    assertName(name);
    const prepared = await this.#prepare(input, name);
    const { preview, previousName } = prepared;
    if (preview.issues.length > 0) throw new AssistantServiceError(422, "validation", "Contenu invalide.", { issues: preview.issues });
    // Un fichier existant ne peut être remplacé que par lui-même (Modifier, Compléter) ; un agent natif ou défini
    // dans opencode.jsonc ne peut pas être masqué par un fichier du même nom.
    if (prepared.agents.has(name) ? previousName !== name : prepared.taken.has(name)) {
      throw new AssistantServiceError(409, "name-taken", nameTakenMessage(name), { name });
    }
    const renaming = previousName !== null && previousName !== name;
    const existing = (renaming ? this.#row("agents", previousName) : undefined) ?? this.#row("agents", name);

    const item = await this.#d.studio.save("agents", GLOBAL, {
      name,
      previousName: renaming ? previousName : null,
      frontmatter: preview.frontmatter,
      body: preview.body,
    });

    const { draft } = prepared;
    const origin: AssistantOrigin = existing && existing.origin !== "studio" ? existing.origin : "assistant";
    transaction(this.#d.db, () => {
      if (renaming) this.#deleteRow("agents", previousName);
      this.#upsert({
        kind: "agents",
        name,
        title: draft.title,
        use_case: draft.useCase,
        icon: draft.icon,
        tier: draft.tier,
        rights: draft.rights,
        task_size: draft.taskSize,
        examples: JSON.stringify(draft.examples),
        origin,
        catalog_id: existing && existing.origin !== "studio" ? existing.catalog_id : null,
        catalog_version: existing && existing.origin !== "studio" ? existing.catalog_version : null,
        applied_model: text(item.frontmatter.model),
        applied_variant: text(item.frontmatter.variant),
      });
    });

    // Règles réellement appliquées par opencode (GET /agent) comparées à l'aperçu.
    this.#d.lookup.invalidate();
    this.#d.hub.cockpit("studio.changed", { kind: "agents", name });
    const ctx = await this.#context();
    const row = ctx.rows.find((r) => r.kind === "agents" && r.name === name);
    const file = ctx.agents.get(name) ?? item;
    if (!row) throw notFound("Assistant introuvable.");
    const oc = ctx.snapshot?.agents.find((a) => a.name === name);
    const rulesDiffer = oc ? !sameDecisions(rightLines(oc.permission, prepared.fiches, prepared.steps), preview.rightLines) : false;
    return { ...this.#view(row, file, ctx), rulesDiffer };
  }

  async adopt(name: string, input: unknown): Promise<AssistantView> {
    assertName(name, "Nom d'agent invalide.");
    const body = adoptSchema.safeParse(input);
    if (!body.success) throw new AssistantServiceError(400, "validation", "Requête invalide.", { issues: issuesFrom(body.error) });
    const file = name === CLASSIFIER_AGENT ? null : await this.#d.studio.get("agents", name, GLOBAL);
    if (!file) throw notFound("Agent introuvable.");
    const existing = this.#row("agents", name);
    if (existing?.title) throw new AssistantServiceError(409, "already-assistant", "Cet agent est déjà un assistant.");
    const model = text(file.frontmatter.model);
    const bound = existing && isTier(existing.tier) ? existing.tier : null;
    this.#upsert({
      kind: "agents",
      name,
      title: body.data.title,
      use_case: body.data.useCase,
      icon: USE_CASE_INFO[body.data.useCase].icon,
      tier: bound ?? (model ? this.#d.tiers.tierOfModel(model) : null),
      rights: detectRights(file.frontmatter.permission).rights,
      task_size: body.data.taskSize,
      examples: "[]",
      origin: "adopte",
      catalog_id: null,
      catalog_version: null,
      applied_model: model,
      applied_variant: text(file.frontmatter.variant),
    });
    this.#d.hub.cockpit("studio.changed", { kind: "agents", name });
    return this.#viewOf(name);
  }

  async #commandsUsing(name: string): Promise<string[]> {
    const [commands, snapshot] = await Promise.all([this.#files("commands"), this.#snapshot()]);
    return this.#usedBy(name, { commands, snapshot });
  }

  async remove(name: string, force: boolean): Promise<{ deleted: boolean }> {
    assertName(name);
    // Seuls les assistants passent par cette route (utilisable en mode Simple) : les autres agents restent au Studio.
    const row = this.#row("agents", name);
    const file = row?.title ? await this.#d.studio.get("agents", name, GLOBAL) : null;
    if (!row?.title || !file) throw notFound("Assistant introuvable.");
    const commands = await this.#commandsUsing(name);
    if (commands.length > 0 && !force) throw new AssistantServiceError(409, "used-by", usedByMessage(commands), { commands });
    await this.#d.studio.remove("agents", name, GLOBAL);
    this.#deleteRow("agents", name);
    this.#d.lookup.invalidate();
    this.#d.hub.cockpit("studio.changed", { kind: "agents", name });
    return { deleted: true };
  }

  async removeMeta(kind: ItemKind, name: string): Promise<{ deleted: boolean }> {
    if (kind !== "agents" && kind !== "commands") throw new AssistantServiceError(400, "invalid", "Type inconnu (agents ou commands).");
    assertName(name, "Nom invalide.");
    if (await this.#d.studio.get(kind, name, GLOBAL)) {
      throw new AssistantServiceError(409, "file-exists", "Le fichier existe toujours : supprimez l'élément depuis sa page.");
    }
    return { deleted: this.#deleteRow(kind, name) > 0 };
  }

  async fiches(): Promise<FicheInfo[]> {
    let list: FicheInfo[];
    try {
      const raw = await this.#d.client.request<unknown>("GET", "/skill", { timeoutMs: 15_000 });
      if (!Array.isArray(raw)) throw new Error("Réponse inattendue d'opencode pour la liste des fiches.");
      list = raw.flatMap((item) =>
        isRecord(item) && typeof item.name === "string"
          ? [{ name: item.name, description: typeof item.description === "string" ? item.description.slice(0, 1_024) : "" }]
          : [],
      );
    } catch (err) {
      this.#d.log.warn("fiches d'opencode indisponibles : repli sur les fichiers", { error: errorMessage(err) });
      list = [...(await this.#files("skills")).values()].map((item) => ({
        name: item.name,
        description: typeof item.frontmatter.description === "string" ? item.frontmatter.description : "",
      }));
    }
    // Seules les fiches dont le nom est utilisable dans un bloc `skill` d'assistant sont proposées.
    const unique = new Map<string, FicheInfo>();
    for (const fiche of list) if (fiche.name.length <= 64 && FICHE_NAME_RE.test(fiche.name) && !unique.has(fiche.name)) unique.set(fiche.name, fiche);
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Éléments liés qui passeraient à une autre IA ; `tiers` : définitions à essayer (null = recommandation livrée). */
  async updates(tiers?: TierDefs | null): Promise<UpdateItem[]> {
    return this.#updates(await this.#context({ defs: tiers, snapshot: false, global: false }));
  }

  /** Inventaire « Qui utilise quel niveau ? ». */
  async usage(): Promise<UsageRow[]> {
    const ctx = await this.#context({ global: false });
    const meta = new Map(ctx.rows.map((row) => [`${row.kind}/${row.name}`, row]));
    const levelText = (tier: Tier | null, model: string | null) =>
      tier ? TIER_LABELS[tier] : model ? `IA précise (${parseModelKey(model).modelID || model})` : "Niveau de la conversation";
    const stateOf = (row: ItemMetaRow, file: StudioItem): UsageRowState => {
      if (text(file.frontmatter.model) !== row.applied_model || text(file.frontmatter.variant) !== row.applied_variant) return "modifie-hors-cockpit";
      return this.#updateFor(row, file, ctx) ? "mise-a-jour" : "a-jour";
    };
    const row = (r: Omit<UsageRow, "typeLabel" | "stateText">): UsageRow => ({
      ...r,
      typeLabel: USAGE_TYPE_LABELS[r.type],
      stateText: USAGE_STATE_TEXT[r.state],
    });

    const assistants: UsageRow[] = [];
    const agents: UsageRow[] = [];
    for (const [name, file] of ctx.agents) {
      const m = meta.get(`agents/${name}`);
      const model = text(file.frontmatter.model);
      const tier = m && isTier(m.tier) ? m.tier : null;
      if (m?.title) {
        assistants.push(row({ kind: "agents", name, label: m.title, type: "assistant", tier, model, levelText: levelText(tier, model), state: stateOf(m, file) }));
      } else if (m && tier) {
        agents.push(row({ kind: "agents", name, label: name, type: "agent", tier, model, levelText: levelText(tier, model), state: stateOf(m, file) }));
      } else if (model) {
        agents.push(row({ kind: "agents", name, label: name, type: "agent", tier: null, model, levelText: levelText(null, model), state: "a-ranger" }));
      }
    }

    const agentInfo = (name: string): { model: string | null; mode: "primary" | "subagent" | "all" } | null => {
      const oc = ctx.snapshot?.agents.find((a) => a.name === name);
      if (oc) return { model: oc.model ? modelKey(oc.model) : null, mode: oc.mode };
      const file = ctx.agents.get(name);
      if (!file) return null;
      const mode = file.frontmatter.mode;
      return { model: text(file.frontmatter.model), mode: mode === "primary" || mode === "subagent" ? mode : "all" };
    };
    const commands: UsageRow[] = [];
    for (const [name, file] of ctx.commands) {
      const m = meta.get(`commands/${name}`);
      const fm = file.frontmatter;
      const model = text(fm.model);
      const tier = m && isTier(m.tier) ? m.tier : null;
      const label = `/${name}`;
      if (m && tier) {
        commands.push(row({ kind: "commands", name, label, type: "raccourci", tier, model, levelText: levelText(tier, model), state: stateOf(m, file) }));
        continue;
      }
      if (model) {
        commands.push(row({ kind: "commands", name, label, type: "raccourci", tier: null, model, levelText: levelText(null, model), state: "a-ranger" }));
        continue;
      }
      const agentName = text(fm.agent);
      const agent = agentName ? agentInfo(agentName) : null;
      if (!agent?.model) continue;
      const delegated = isSubtask(agent, { subtask: typeof fm.subtask === "boolean" ? fm.subtask : undefined });
      commands.push(
        row({
          kind: "commands",
          name,
          label,
          type: "raccourci",
          tier: null,
          model: agent.model,
          levelText: delegated ? "IA de l'assistant délégué" : "IA de l'assistant du raccourci",
          state: "aucun",
        }),
      );
    }

    const builtins = this.#builtins(ctx).map((b) =>
      row({ kind: "builtin", name: b.name, label: b.title, type: "integre", tier: null, model: null, levelText: "Niveau de la conversation", state: "aucun" }),
    );

    const missing = this.#missing(ctx).map((m) => {
      const r = meta.get(`${m.kind}/${m.name}`);
      const applied = r?.applied_model ?? null;
      return row({
        kind: m.kind,
        name: m.name,
        label: m.title ?? (m.kind === "commands" ? `/${m.name}` : m.name),
        type: m.title ? "assistant" : m.kind === "commands" ? "raccourci" : "agent",
        tier: m.tier,
        model: applied,
        levelText: levelText(m.tier, applied),
        state: "introuvable",
      });
    });

    const byLabel = (a: UsageRow, b: UsageRow) => a.label.localeCompare(b.label, "fr");
    return [...assistants.sort(byLabel), ...commands.sort(byLabel), ...agents.sort(byLabel), ...builtins, ...missing.sort(byLabel)];
  }

  async realign(items: RealignRequest["items"]): Promise<RealignResponse> {
    const { catalog, studio, db, hub, lookup } = this.#d;
    if (!catalog.loaded) throw new AssistantServiceError(409, "catalogue-indisponible", MESSAGES.catalogueIndisponible);
    const busy = () => probeSessionsBusy({ client: this.#d.client, projects: this.#d.projects, db });
    if (await busy()) throw sessionsBusyError();

    const ctx = await this.#context({ snapshot: false, global: false });
    let targets: UpdateItem[];
    if (items === undefined) {
      targets = this.#updates(ctx);
    } else {
      targets = [];
      const seen = new Set<string>();
      for (const item of items) {
        const key = `${item.kind}/${item.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = ctx.rows.find((r) => r.kind === item.kind && r.name === item.name);
        const file = (item.kind === "agents" ? ctx.agents : ctx.commands).get(item.name);
        if (!row || !file || !isTier(row.tier)) throw notFound(`Élément introuvable : ${item.kind}/${item.name}.`);
        const res = ctx.resolved[row.tier];
        if (res.status === "indisponible" || !res.model) {
          throw new AssistantServiceError(422, "ia-indisponible", tierUnavailableMessage(row.tier), { tier: row.tier });
        }
        // « Réaligner » un élément modifié hors du cockpit réécrit aussi l'IA du niveau quand elle est déjà la même.
        const modified = text(file.frontmatter.model) !== row.applied_model || text(file.frontmatter.variant) !== row.applied_variant;
        const update = this.#updateFor(row, file, ctx, modified);
        if (update) targets.push(update);
      }
    }
    if (targets.length === 0) return { updated: [] };

    try {
      await studio.applyModels(
        targets.map((t) => ({ kind: t.kind, name: t.name, model: t.to, variant: t.variant })),
        async () => {
          if (await busy()) throw sessionsBusyError();
        },
      );
    } catch (err) {
      if (err instanceof StudioApplyError) {
        throw new AssistantServiceError(422, "rejected-by-opencode", MESSAGES.rejectedByOpencode, {
          issues: err.issues,
          restored: true,
          restarted: err.restarted,
        });
      }
      throw err;
    }

    const now = Date.now();
    transaction(db, () => {
      const update = db.prepare("UPDATE item_meta SET applied_model = ?, applied_variant = ?, updated_at = ? WHERE kind = ? AND name = ?");
      for (const t of targets) update.run(t.to, t.variant, now, t.kind, t.name);
    });
    lookup.invalidate();
    hub.cockpit("ai.changed", { reason: "realign" });
    for (const t of targets) hub.cockpit("studio.changed", { kind: t.kind, name: t.name });
    return { updated: targets };
  }

  /**
   * « Garder cette IA précise » (élément « Modifié hors du cockpit », deux modes) : aucun fichier n'est réécrit. La ligne
   * item_meta n'est plus liée à un niveau et l'IA du fichier devient l'IA appliquée (plus de « Mise à jour disponible »).
   */
  async keepModel(kind: ItemKind, name: string): Promise<KeepModelResponse> {
    if (kind !== "agents" && kind !== "commands") throw new AssistantServiceError(400, "invalid", "Type inconnu (agents ou commands).");
    assertName(name, "Nom invalide.");
    const row = this.#row(kind, name);
    const file = (await this.#files(kind)).get(name);
    if (!row || !file) throw notFound(`Élément introuvable : ${kind}/${name}.`);
    const model = text(file.frontmatter.model);
    const variant = text(file.frontmatter.variant);
    if (model !== null && !this.#d.env.allowedProviders.includes(providerOf(model))) {
      throw new AssistantServiceError(422, "fournisseur-refuse", MESSAGES.fournisseurRefuse);
    }
    this.#d.db
      .prepare("UPDATE item_meta SET tier = NULL, applied_model = ?, applied_variant = ?, updated_at = ? WHERE kind = ? AND name = ?")
      .run(model, variant, Date.now(), kind, name);
    this.#d.hub.cockpit("ai.changed", { reason: "keep-model" });
    return { kind, name, model, variant };
  }

  // --- Accès synchrones (passés comme fonctions de rappel : fonctions fléchées) ---------------------

  /** Titre affiché : titre d'assistant, sinon titre d'un assistant intégré, sinon le nom. */
  readonly agentTitle = (name: string): string => {
    const row = this.#row("agents", name);
    if (row?.title) return row.title;
    if (name === "build" || name === "plan") return BUILTIN_ASSISTANTS[name].title;
    return name;
  };

  readonly taskSizeOf = (name: string): TaskSize | null => {
    const row = this.#row("agents", name);
    return row && isTaskSize(row.task_size) ? row.task_size : null;
  };

  /**
   * Liaison à un niveau après un enregistrement du Studio (tier undefined = liaison inchangée, non appelé).
   * `previousName` : renommage, la ligne suit l'élément.
   */
  readonly bindLevel = (
    kind: ItemKind,
    name: string,
    tier: Tier | null,
    model: string | null,
    variant: string | null,
    previousName?: string | null,
  ): void => {
    if ((kind !== "agents" && kind !== "commands") || !validName(name) || (tier !== null && !isTier(tier))) return;
    transaction(this.#d.db, () => {
      let row = this.#row(kind, name);
      if (previousName && previousName !== name && validName(previousName)) {
        const old = this.#row(kind, previousName);
        if (old) {
          this.#deleteRow(kind, previousName);
          row ??= { ...old, name };
        }
      }
      if (!row && tier === null) return;
      this.#upsert({
        kind,
        name,
        title: row?.title ?? null,
        use_case: row?.use_case ?? null,
        icon: row?.icon ?? null,
        tier,
        rights: row?.rights ?? null,
        task_size: row?.task_size ?? null,
        examples: row?.examples ?? "[]",
        origin: row?.origin ?? "studio",
        catalog_id: row?.catalog_id ?? null,
        catalog_version: row?.catalog_version ?? null,
        applied_model: model,
        applied_variant: variant,
      });
    });
  };
}

