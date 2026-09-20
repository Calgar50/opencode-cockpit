import { redactSecrets } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Profondeur au plus des champs masqués un à un (objets simples et listes imbriqués). */
const FIELD_DEPTH_MAX = 4;

/**
 * Chaînes d'un champ masquées AVANT la mise en JSON : dans la ligne sérialisée, chaque guillemet d'un texte recopié (configuration
 * JSONC d'un message d'erreur d'opencode, par exemple) devient \" et les règles par clé de redact.ts ne le reconnaissent plus.
 * Objets qui ne sont pas simples (Error, Date…) : laissés à JSON.stringify, la ligne entière restant masquée ensuite.
 */
function redactField(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= FIELD_DEPTH_MAX || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactField(item, depth + 1));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactField(inner, depth + 1)]));
}

/**
 * Journal JSON sur la sortie standard (`out` : autre sortie, pour les tests) ; les chaînes des champs, puis chaque ligne, passent par
 * le masquage de secrets.
 */
export function createLogger(
  level: string | undefined = process.env.COCKPIT_LOG_LEVEL,
  out: (line: string) => void = (line) => void process.stdout.write(line),
): Logger {
  const min = ORDER[(level as LogLevel) in ORDER ? (level as LogLevel) : "info"];
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: message, ...(fields ? (redactField(fields) as Record<string, unknown>) : {}) });
    out(`${redactSecrets(line)}\n`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
