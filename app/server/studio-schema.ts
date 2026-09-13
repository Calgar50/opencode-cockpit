// Schémas de validation des fichiers d'agents, commandes et skills.
// Ils reproduisent les règles d'opencode 1.18 : un fichier refusé par opencode
// bloque TOUT le serveur jusqu'à son redémarrage, d'où la validation en amont.
import { z } from "zod";

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAME_RE, "Nom : minuscules, chiffres et tirets uniquement (ex. revue-securite).");

const action = z.enum(["ask", "allow", "deny"]);
const rule = z.union([action, z.record(z.string().min(1).max(500), action)]);
/** Clés de permission qui n'acceptent qu'une action simple, pas de motifs. */
const ACTION_ONLY = new Set(["todowrite", "question", "webfetch", "websearch", "doom_loop"]);

export const permissionSchema = z.union([
  action,
  z.record(z.string().regex(/^[a-z_*][a-z0-9_*]*$/, "Clé de permission invalide."), rule).superRefine((value, ctx) => {
    for (const [key, v] of Object.entries(value)) {
      if (ACTION_ONLY.has(key) && typeof v !== "string") {
        ctx.addIssue({ code: "custom", path: [key], message: `« ${key} » accepte seulement ask, allow ou deny.` });
      }
    }
  }),
]);

const modelRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][\w.-]*\/\S+$/, "Modèle au format fournisseur/modèle (ex. github-copilot/claude-sonnet-5).");

const THEME_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"] as const;

export const agentFrontmatterSchema = z.looseObject({
  description: z.string().trim().min(1, "La description est obligatoire.").max(1024),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  model: modelRef.optional(),
  variant: z.string().min(1).max(40).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  steps: z.number().int().positive().max(10_000).optional(),
  maxSteps: z.number().int().positive().max(10_000).optional(),
  disable: z.boolean().optional(),
  hidden: z.boolean().optional(),
  color: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.enum(THEME_COLORS)]).optional(),
  prompt: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  permission: permissionSchema.optional(),
});

/** opencode refuse toute clé inconnue dans une commande : schéma strict. */
export const commandFrontmatterSchema = z.strictObject({
  description: z.string().trim().max(1024).optional(),
  agent: z.string().min(1).max(64).optional(),
  model: modelRef.optional(),
  variant: z.string().min(1).max(40).optional(),
  subtask: z.boolean().optional(),
});

export const skillFrontmatterSchema = z.looseObject({
  name: nameSchema,
  description: z.string().trim().min(1, "La description est obligatoire.").max(1024),
  license: z.string().max(200).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const MAX_DOC_BYTES = 256 * 1024;
export const bodySchema = z.string().max(MAX_DOC_BYTES, "Contenu trop volumineux (256 Ko max).");

/** Chemin relatif d'un fichier annexe de skill : pas de `..`, pas de fichier caché, 4 niveaux max. */
export const SKILL_FILE_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/){0,3}[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export type StudioKind = "agents" | "commands" | "skills";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesFrom(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(racine)", message: i.message }));
}
