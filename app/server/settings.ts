import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DEFAULT_TIERS, TIER_IDS, UI_MODES } from "./shared/assistant-rules.ts";

export {
  changedSettingsPaths,
  isSimpleSettingsPath,
  RULES_VERSION,
  SIMPLE_SETTINGS_PATHS,
  settingsPathsOutsideSimple,
} from "./shared/assistant-rules.ts";

const modelKeyRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][\w.-]*\/\S+$/, "IA au format fournisseur/modèle (ex. github-copilot/claude-sonnet-5).");

/** Niveau d'IA : candidats dans l'ordre de préférence et réflexion (conception 0.2.0 §6). */
export const tierDefSchema = z.strictObject({
  candidates: z
    .array(modelKeyRef)
    .min(1)
    .max(4)
    .refine((list) => new Set(list).size === list.length, "Candidat en double."),
  variant: z.string().min(1).max(40).nullable(),
});

export const tierDefsSchema = z.strictObject({ rapide: tierDefSchema, equilibre: tierDefSchema, expert: tierDefSchema });

const rates = z.object({
  input: z.number().min(0).max(10_000),
  cachedInput: z.number().min(0).max(10_000),
  cacheWrite: z.number().min(0).max(10_000).nullable(),
  output: z.number().min(0).max(10_000),
});

const modelPrice = z.object({
  rates,
  tiers: z.array(z.object({ aboveInputTokens: z.number().int().positive(), rates })).max(5).optional(),
  note: z.string().max(200).optional(),
});

const category = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/, "Identifiant : minuscules, chiffres, tirets."),
  label: z.string().trim().min(1).max(40),
  emoji: z.string().max(16),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  description: z.string().max(300),
  keywords: z.array(z.string().trim().min(2).max(40)).max(80),
});

export const settingsSchema = z
  .object({
    budget: z.object({
      monthlyUsd: z.number().min(0).max(100_000),
      alertThresholds: z.array(z.number().int().min(1).max(200)).max(10),
      guard: z.object({
        enabled: z.boolean(),
        /** À partir de ce pourcentage du budget, les modèles chers demandent confirmation. */
        fromPercent: z.number().min(0).max(200),
        /** Prix de sortie (USD / M tokens) au-delà duquel un modèle est « cher ». */
        maxOutputPricePerM: z.number().min(0).max(1_000),
        /** Budget atteint : tout modèle payant demande confirmation. */
        blockAtLimit: z.boolean(),
      }),
    }),
    pricing: z.object({
      preferTable: z.boolean(),
      overrides: z.record(z.string().max(200).regex(/^[A-Za-z0-9][\w.-]*\/\S+$/), modelPrice),
    }),
    classifier: z.object({
      mode: z.enum(["llm", "heuristic", "off"]),
      /** null : choix automatique du modèle connecté le moins cher. */
      model: z.string().max(200).nullable(),
      idleMinutes: z.number().min(0).max(1_440),
      reclassifyAfterPrompts: z.number().int().min(1).max(100),
      categories: z.array(category).min(1).max(30),
    }),
    quotaSync: z.object({
      /** Lit le solde réel via l'endpoint GitHub non documenté copilot_internal/user. */
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(5).max(1_440),
    }),
    chat: z.object({
      /** Obsolète depuis 0.2.0 : sert seulement à initialiser ai.chatDefaultTier, ignoré en mode Simple. */
      defaultModel: z.string().max(200).nullable(),
      defaultAgent: z.string().max(64).nullable(),
      defaultDirectory: z.string().max(1_000).nullable(),
    }),
    ai: z.object({
      /** null : recommandation livrée avec le cockpit (DEFAULT_TIERS), mise à jour avec le cockpit. */
      tiers: tierDefsSchema.nullable(),
      /** Niveau de l'Assistant général et des nouvelles conversations. */
      chatDefaultTier: z.enum(TIER_IDS),
      /** Mode Avancé : autoriser à changer l'IA d'un assistant pour un message. */
      allowModelOverride: z.boolean(),
    }),
    ui: z.object({
      mode: z.enum(UI_MODES),
      /** Version des règles d'utilisation acceptée (RULES_VERSION) ; 0 = jamais. */
      rulesAcceptedVersion: z.number().int().min(0).max(1_000_000),
      /** Version dont la notice unique « Nouveau : mode Simple » a été vue. */
      noticeSeen: z.string().max(20).nullable(),
    }),
  })
  .superRefine((s, ctx) => {
    const ids = s.classifier.categories.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["classifier", "categories"], message: "Identifiants de catégories en double." });
    }
    if (!ids.includes("other")) {
      ctx.addIssue({ code: "custom", path: ["classifier", "categories"], message: "La catégorie « other » est obligatoire." });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;
export type Category = Settings["classifier"]["categories"][number];

export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: "debug",
    label: "Débogage",
    emoji: "🐛",
    color: "#e5484d",
    description: "Corriger un bug, une erreur, un crash ou un comportement inattendu.",
    keywords: ["bug", "erreur", "error", "exception", "crash", "fix", "corrige", "plante", "stacktrace", "traceback", "ne marche pas", "fonctionne pas", "broken", "failed", "échoue", "undefined", "nullreference"],
  },
  {
    id: "feature",
    label: "Fonctionnalité",
    emoji: "✨",
    color: "#8e4ec6",
    description: "Créer ou étendre une fonctionnalité, écrire du nouveau code.",
    keywords: ["ajoute", "ajouter", "créer", "crée", "implémente", "implement", "feature", "fonctionnalité", "nouveau", "nouvelle", "add", "create", "endpoint", "écran", "formulaire"],
  },
  {
    id: "refactor",
    label: "Refactoring",
    emoji: "♻️",
    color: "#0090ff",
    description: "Restructurer, nettoyer, renommer ou simplifier sans changer le comportement.",
    keywords: ["refactor", "refacto", "nettoie", "cleanup", "renomme", "rename", "simplifie", "simplify", "restructure", "extraire", "extract", "dette technique", "lisibilité"],
  },
  {
    id: "review",
    label: "Revue de code",
    emoji: "🔍",
    color: "#12a594",
    description: "Relire du code, une PR ou un diff et donner un avis qualité.",
    keywords: ["review", "revue", "relis", "relecture", "pull request", "merge request", "diff", "avis sur", "critique", "qualité du code"],
  },
  {
    id: "tests",
    label: "Tests",
    emoji: "🧪",
    color: "#30a46c",
    description: "Écrire, lancer ou réparer des tests.",
    keywords: ["test", "tests", "unitaire", "unit test", "jest", "vitest", "pytest", "junit", "xunit", "nunit", "mock", "coverage", "couverture", "e2e", "playwright", "cypress"],
  },
  {
    id: "question",
    label: "Question / Explication",
    emoji: "💬",
    color: "#ffb224",
    description: "Comprendre un concept ou du code existant, sans rien modifier.",
    keywords: ["pourquoi", "comment", "explique", "expliquer", "c'est quoi", "qu'est-ce", "what is", "how does", "why", "différence", "difference", "comprendre", "signifie"],
  },
  {
    id: "docs",
    label: "Documentation",
    emoji: "📝",
    color: "#978365",
    description: "Rédiger un README, des commentaires, une doc technique ou une spécification.",
    keywords: ["documentation", "readme", "commentaire", "jsdoc", "docstring", "spécification", "rédige", "wiki", "changelog"],
  },
  {
    id: "data",
    label: "Data / SQL",
    emoji: "🗄️",
    color: "#3e63dd",
    description: "Requêtes SQL, modèles de données, migrations, ETL, BI.",
    keywords: ["sql", "requête", "query", "select", "jointure", "join", "base de données", "database", "migration", "schéma", "index", "power bi", "dax", "etl", "dataframe", "pandas"],
  },
  {
    id: "devops",
    label: "DevOps / Infra",
    emoji: "⚙️",
    color: "#6e56cf",
    description: "CI/CD, Docker, Kubernetes, déploiement, scripts d'infrastructure.",
    keywords: ["docker", "compose", "kubernetes", "k8s", "helm", "pipeline", "github actions", "azure devops", "jenkins", "terraform", "ansible", "deploy", "déploie", "nginx", "powershell"],
  },
  {
    id: "security",
    label: "Sécurité",
    emoji: "🔐",
    color: "#dc3e42",
    description: "Vulnérabilités, secrets, authentification, durcissement, audit.",
    keywords: ["sécurité", "security", "vulnérabilité", "vulnerability", "cve", "xss", "injection", "csrf", "secret", "oauth", "owasp", "chiffrement", "encryption", "durcissement"],
  },
  {
    id: "exploration",
    label: "Exploration / Idée",
    emoji: "💡",
    color: "#f76b15",
    description: "Brainstorming, architecture, choix techniques, prototypage.",
    keywords: ["idée", "idea", "architecture", "conception", "brainstorm", "choisir", "comparer", "compare", "alternative", "prototype", "poc", "approche", "stratégie"],
  },
  {
    id: "other",
    label: "Autre",
    emoji: "📦",
    color: "#8b8d98",
    description: "Tout ce qui n'entre dans aucune autre catégorie.",
    keywords: [],
  },
];

export const DEFAULT_SETTINGS: Settings = {
  budget: {
    monthlyUsd: 150,
    alertThresholds: [50, 75, 90, 100],
    guard: { enabled: true, fromPercent: 80, maxOutputPricePerM: 15, blockAtLimit: true },
  },
  pricing: { preferTable: false, overrides: {} },
  classifier: { mode: "llm", model: null, idleMinutes: 2, reclassifyAfterPrompts: 3, categories: DEFAULT_CATEGORIES },
  quotaSync: { enabled: false, intervalMinutes: 15 },
  chat: { defaultModel: null, defaultAgent: null, defaultDirectory: null },
  ai: { tiers: null, chatDefaultTier: "equilibre", allowModelOverride: false },
  // Mode Simple pour toute installation, y compris celles qui viennent de 0.1.x.
  ui: { mode: "simple", rulesAcceptedVersion: 0, noticeSeen: null },
};

const REPLACED_PATHS = new Set(["pricing.overrides", "classifier.categories", "budget.alertThresholds", "ai.tiers"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 0.1.x → 0.2.0 : tant qu'aucune section `ai` n'est enregistrée, un `chat.defaultModel` qui est une IA d'un niveau
 * livré choisit `ai.chatDefaultTier`. Rien n'est écrit : la valeur est recalculée jusqu'au premier enregistrement.
 */
export function seedLegacySettings(stored: unknown): unknown {
  if (!isPlainObject(stored) || Object.hasOwn(stored, "ai")) return stored;
  const chat = stored.chat;
  const legacy = isPlainObject(chat) && typeof chat.defaultModel === "string" ? chat.defaultModel : null;
  const tier = legacy === null ? undefined : TIER_IDS.find((id) => DEFAULT_TIERS[id].candidates.includes(legacy));
  return tier ? { ...stored, ai: { chatDefaultTier: tier } } : stored;
}

/** Fusion récursive : les objets se fusionnent, tableaux et dictionnaires listés sont remplacés. */
export function mergeSettings(base: unknown, patch: unknown, at = ""): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch) || REPLACED_PATHS.has(at)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = mergeSettings(base[key], value, at ? `${at}.${key}` : key);
  }
  return out;
}

export class SettingsError extends Error {
  override name = "SettingsError";
  readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }>) {
    super(message);
    this.issues = issues;
  }
}

export class SettingsStore {
  #cache: Settings | null = null;
  readonly #listeners = new Set<(s: Settings) => void>();

  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(): Settings {
    if (this.#cache) return this.#cache;
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'cockpit'").get() as { value: string } | undefined;
    let candidate: unknown = DEFAULT_SETTINGS;
    if (row) {
      try {
        candidate = mergeSettings(DEFAULT_SETTINGS, seedLegacySettings(JSON.parse(row.value)));
      } catch {
        candidate = DEFAULT_SETTINGS;
      }
    }
    const parsed = settingsSchema.safeParse(candidate);
    this.#cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    return this.#cache;
  }

  update(patch: unknown): Settings {
    const merged = mergeSettings(this.get(), patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new SettingsError(
        "Paramètres invalides.",
        parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
      );
    }
    this.#db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('cockpit', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(parsed.data), Date.now());
    this.#cache = parsed.data;
    for (const listener of this.#listeners) listener(parsed.data);
    return parsed.data;
  }

  reset(section: keyof Settings): Settings {
    return this.update({ [section]: DEFAULT_SETTINGS[section] });
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
