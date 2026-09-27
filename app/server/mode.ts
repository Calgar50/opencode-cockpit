// Modes Simple / Avancé (conception 0.2.0 §8) : garde côté serveur des écritures risquées.
// Elle évite les accidents ; ce n'est pas une frontière de sécurité (chaque poste reste administré par son utilisateur).
import type { Context, MiddlewareHandler } from "hono";
import type { SettingsStore } from "./settings.ts";
import { changedSettingsPaths, MESSAGES, settingsPathsOutsideSimple } from "./shared/assistant-rules.ts";

type SettingsReader = Pick<SettingsStore, "get">;

export const MODE_AVANCE_ERROR = "mode-avance";

export function isAdvanced(settings: SettingsReader): boolean {
  return settings.get().ui.mode === "avance";
}

const refuse = (c: Context, extra: Record<string, unknown> = {}) =>
  c.json({ error: MODE_AVANCE_ERROR, message: MESSAGES.modeAvance, ...extra }, 403);

const invalidJson = (c: Context) => c.json({ error: "invalid-json", message: "Corps JSON invalide." }, 400);

/** Corps JSON de la requête (Hono le garde en cache : le gestionnaire de la route peut le relire). */
async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

/** 403 mode-avance en mode Simple. */
export function advancedOnly(settings: SettingsReader): MiddlewareHandler {
  return async (c, next) => {
    if (!isAdvanced(settings)) return refuse(c);
    await next();
  };
}

/** Réglage que PUT /api/settings ne change jamais, dans les deux modes (D-2b-11) : écrit par une activation confirmée seule. */
export const REGLAGE_FIXE_ERROR = "reglage-fixe";

/** Section des réglages de la Salle OMO : `dernierPlafondUsd` n'y est écrit que par une activation confirmée (omo-activation.ts). */
const OMO_BUDGET_PATH = "budget.omo";

const REGLAGE_FIXE_MESSAGE =
  "Réglage fixe : le dernier montant d'arrêt de la Salle OMO n'est enregistré que par une activation confirmée de la salle.";

/**
 * Chemin qui écrirait `budget.omo` : la section elle-même ou ce qu'elle contient. « budget » n'est pas un réglage remplacé en bloc
 * (SETTINGS_REPLACED_PATHS) : un corps qui remplacerait `budget`, ou le corps entier, par autre chose qu'un objet est refusé par le
 * schéma des réglages (422) et n'écrit rien — la garde ne le déguise donc pas en « réglage fixe ».
 */
function touchesOmoBudget(path: string): boolean {
  return path === OMO_BUDGET_PATH || path.startsWith(`${OMO_BUDGET_PATH}.`);
}

/**
 * PUT /api/settings : `budget.omo.*` n'est jamais écrit, DANS LES DEUX MODES (D-2b-11 : 403 « reglage-fixe ») ; renvoyer la valeur
 * en vigueur ne change rien et passe. Puis, en mode Simple, seuls les chemins de SIMPLE_SETTINGS_PATHS peuvent changer
 * (budget.monthlyUsd, budget.alertThresholds, ui.*, ai.chatDefaultTier, chat.defaultDirectory). Sinon 403 {paths}.
 */
export function settingsPatchGuard(settings: SettingsReader): MiddlewareHandler {
  return async (c, next) => {
    const advanced = isAdvanced(settings);
    const body = await readJson(c);
    // Mode Avancé : un corps illisible reste traité par la route, comme avant (aucun changement de comportement ici).
    if (!body.ok) return advanced ? next() : invalidJson(c);
    const fixes = changedSettingsPaths(settings.get(), body.value).filter(touchesOmoBudget);
    if (fixes.length > 0) return c.json({ error: REGLAGE_FIXE_ERROR, message: REGLAGE_FIXE_MESSAGE, paths: fixes.slice(0, 50) }, 403);
    if (advanced) return next();
    const paths = settingsPathsOutsideSimple(settings.get(), body.value);
    if (paths.length > 0) return refuse(c, { paths: paths.slice(0, 50) });
    await next();
  };
}

/** POST /api/settings/reset : en mode Simple, seule la section « budget » peut être réinitialisée. */
export function settingsResetGuard(settings: SettingsReader): MiddlewareHandler {
  return async (c, next) => {
    if (isAdvanced(settings)) return next();
    const body = await readJson(c);
    if (!body.ok) return invalidJson(c);
    const value = body.value;
    const section = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).section : undefined;
    if (section !== "budget") return refuse(c);
    await next();
  };
}
