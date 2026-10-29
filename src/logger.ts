import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Minimal structured logger: one JSON object per line, safe for containers. */
export function createLogger(level: LogLevel): Logger {
  const threshold = RANK[level];
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (RANK[lvl] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (lvl === "error" || lvl === "warn") process.stderr.write(line);
    else process.stdout.write(line);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
