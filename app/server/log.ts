import { redactSecrets } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Journal JSON sur la sortie standard ; chaque ligne passe par le masquage de secrets. */
export function createLogger(level: string | undefined = process.env.COCKPIT_LOG_LEVEL): Logger {
  const min = ORDER[(level as LogLevel) in ORDER ? (level as LogLevel) : "info"];
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: message, ...fields });
    process.stdout.write(`${redactSecrets(line)}\n`);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
