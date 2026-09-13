// Outils partagés du Studio : noms, en-têtes, comparaison de brouillons, modèles.
import type { ModelInfo, StudioItem, StudioKind, ValidationIssue } from "../../lib/types.ts";

/** Mêmes règles que le serveur (studio-schema.ts). */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MODEL_RE = /^[A-Za-z0-9][\w.-]*\/\S+$/;
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const SKILL_FILE_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/){0,3}[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export const THEME_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"] as const;

export type StudioTab = StudioKind | "instructions";

export const KIND_LABELS: Record<StudioKind, { one: string; many: string; article: string }> = {
  agents: { one: "agent", many: "agents", article: "un agent" },
  skills: { one: "skill", many: "skills", article: "un skill" },
  commands: { one: "commande", many: "commandes", article: "une commande" },
};

export interface Draft {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface NewSeed extends Draft {
  /** Identifiant local pour réinitialiser l'éditeur à chaque nouvel élément. */
  seq: number;
}

export function nameError(name: string): string | null {
  if (!name) return "Le nom est obligatoire.";
  if (name.length > 64) return "64 caractères maximum.";
  if (!NAME_RE.test(name)) return "Minuscules, chiffres et tirets uniquement (ex. revue-securite).";
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON à clés triées : compare deux brouillons sans dépendre de l'ordre des clés. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Copie profonde d'un en-tête (valeurs JSON uniquement). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Remplace ou supprime une clé sans toucher aux autres (clés inconnues conservées). */
export function withKey(record: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = { ...record };
  if (value === undefined || value === null || value === "") delete next[key];
  else next[key] = value;
  return next;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function draftFromItem(item: StudioItem): Draft {
  return { name: item.name, frontmatter: cloneJson(item.frontmatter), body: item.body };
}

export function emptyDraft(kind: StudioKind): Draft {
  if (kind === "agents") return { name: "", frontmatter: { description: "", mode: "primary" }, body: "" };
  if (kind === "commands") return { name: "", frontmatter: { description: "" }, body: "" };
  return { name: "", frontmatter: { description: "" }, body: "" };
}

/** Nom libre dérivé de `base` (base, base-2, base-3…). */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

export interface ModelGroup {
  providerID: string;
  label: string;
  models: ModelInfo[];
}

export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    let group = groups.get(model.providerID);
    if (!group) {
      group = { providerID: model.providerID, label: model.providerName || model.providerID, models: [] };
      groups.set(model.providerID, group);
    }
    group.models.push(model);
  }
  const list = [...groups.values()];
  for (const g of list) g.models.sort((a, b) => a.name.localeCompare(b.name));
  return list.sort((a, b) => (a.providerID === "github-copilot" ? -1 : b.providerID === "github-copilot" ? 1 : a.label.localeCompare(b.label)));
}

const PERMISSION_ACTIONS = new Set(["ask", "allow", "deny"]);

/** Contrôles locaux avant envoi ; le serveur puis opencode revalident de toute façon. */
export function validateDraft(kind: StudioKind, draft: Draft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fm = draft.frontmatter;
  const nameIssue = nameError(draft.name);
  if (nameIssue) issues.push({ path: "nom", message: nameIssue });
  const description = str(fm.description).trim();
  if ((kind === "agents" || kind === "skills") && !description) {
    issues.push({ path: "description", message: "La description est obligatoire." });
  }
  if (description.length > 1024) issues.push({ path: "description", message: "1 024 caractères maximum." });
  if (fm.model !== undefined && (typeof fm.model !== "string" || !MODEL_RE.test(fm.model))) {
    issues.push({ path: "modèle", message: "Format attendu : fournisseur/modèle." });
  }
  if (kind === "agents") {
    if (fm.temperature !== undefined && (typeof fm.temperature !== "number" || fm.temperature < 0 || fm.temperature > 2)) {
      issues.push({ path: "température", message: "Nombre entre 0 et 2." });
    }
    if (fm.steps !== undefined && (typeof fm.steps !== "number" || !Number.isInteger(fm.steps) || fm.steps < 1 || fm.steps > 10_000)) {
      issues.push({ path: "étapes", message: "Nombre entier entre 1 et 10 000." });
    }
    if (fm.color !== undefined) {
      const ok = typeof fm.color === "string" && (HEX_RE.test(fm.color) || (THEME_COLORS as readonly string[]).includes(fm.color));
      if (!ok) issues.push({ path: "couleur", message: "Couleur du thème ou code hexadécimal (#rrggbb)." });
    }
    const permission = fm.permission;
    if (isRecord(permission)) {
      for (const [key, rule] of Object.entries(permission)) {
        if (typeof rule === "string") {
          if (!PERMISSION_ACTIONS.has(rule)) issues.push({ path: `permission.${key}`, message: "Action inconnue." });
        } else if (isRecord(rule)) {
          for (const [pattern, action] of Object.entries(rule)) {
            if (!pattern.trim()) issues.push({ path: `permission.${key}`, message: "Motif vide." });
            if (typeof action !== "string" || !PERMISSION_ACTIONS.has(action)) {
              issues.push({ path: `permission.${key}`, message: `Action inconnue pour « ${pattern} ».` });
            }
          }
        }
      }
    }
  }
  if (kind === "skills" && fm.license !== undefined && str(fm.license).length > 200) {
    issues.push({ path: "licence", message: "200 caractères maximum." });
  }
  if ((kind === "commands" || kind === "skills") && !draft.body.trim()) {
    issues.push({ path: "corps", message: kind === "commands" ? "Le modèle de la commande est obligatoire." : "Les instructions du skill sont obligatoires." });
  }
  return issues;
}
