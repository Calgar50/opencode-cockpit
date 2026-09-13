// Modes Simple / Avancé (conception 0.2.0 §8) : garde côté serveur des écritures risquées.
// Elle évite les accidents ; ce n'est pas une frontière de sécurité (chaque poste reste administré par son utilisateur).
import type { Context, MiddlewareHandler } from "hono";
import type { SettingsStore } from "./settings.ts";
import { MESSAGES, settingsPathsOutsideSimple } from "./shared/assistant-rules.ts";

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

/**
 * PUT /api/settings : en mode Simple, seuls les chemins de SIMPLE_SETTINGS_PATHS peuvent changer
 * (budget.monthlyUsd, budget.alertThresholds, ui.*, ai.chatDefaultTier, chat.defaultDirectory). Sinon 403 {paths}.
 */
export function settingsPatchGuard(settings: SettingsReader): MiddlewareHandler {
  return async (c, next) => {
    if (isAdvanced(settings)) return next();
    const body = await readJson(c);
    if (!body.ok) return invalidJson(c);
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
