/**
 * Environment-based configuration for the v2 server.
 *
 * Authentication is owned by the Claude Code CLI that the Agent SDK spawns.
 * We only point it at a config directory: either an existing CLAUDE_CONFIG_DIR,
 * a directory containing the usual `.credentials.json`, or the JSON payload
 * supplied inline for serverless deployments.
 */
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  listenAddr: string;
  proxyApiKey: string;
  /** Claude Code config directory passed to the SDK/CLI. */
  claudeConfigDir?: string;
  /** Inline credentials JSON, written to a temporary config dir at boot. */
  credentialsJSON?: string;
  /** Path to an existing credentials file (used to derive the config dir). */
  credentialsPath: string;
  /** Working directory the CLI runs in. No project settings are loaded. */
  cwd: string;
  logLevel: LogLevel;
  /** Maximum number of concurrent SDK/CLI processes. */
  maxConcurrency: number;
  /** Upper bound for one HTTP request, including streaming. */
  requestTimeoutMs: number;
  /** Default output-token ceiling, matching the Anthropic API default. */
  defaultMaxTokens: number;
  /** Optional explicit path to the Claude Code executable. */
  pathToClaudeCodeExecutable?: string;
  /** Optional path for persisted conversation -> Claude session bindings. */
  statePath?: string;
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

export function loadConfig(envVars: NodeJS.ProcessEnv = process.env): Config {
  const proxyApiKey = envVars.PROXY_API_KEY?.trim();
  if (!proxyApiKey) {
    throw new Error(
      "PROXY_API_KEY is required (consumers use it as their Anthropic API key)",
    );
  }

  const rawLevel = (envVars.LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  const logLevel = LEVELS.includes(rawLevel) ? rawLevel : "info";

  const credentialsPath = envVars.CREDENTIALS_PATH?.trim() || "/data/.credentials.json";
  const explicitConfigDir = envVars.CLAUDE_CONFIG_DIR?.trim();

  return {
    listenAddr: envVars.LISTEN_ADDR?.trim() || ":8080",
    proxyApiKey,
    claudeConfigDir: explicitConfigDir || dirname(credentialsPath),
    credentialsJSON: envVars.CLAUDE_CREDENTIALS_JSON?.trim() || undefined,
    credentialsPath,
    cwd: envVars.CLAUDE_CWD?.trim() || process.cwd(),
    logLevel,
    maxConcurrency: intEnv("MAX_CONCURRENCY", 4, 1, 64),
    requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15 * 60_000, 10_000, 3_600_000),
    defaultMaxTokens: intEnv("DEFAULT_MAX_TOKENS", 8192, 1, 64_000),
    pathToClaudeCodeExecutable: envVars.CLAUDE_CODE_EXECUTABLE?.trim() || undefined,
    statePath: envVars.STATE_PATH?.trim() || undefined,
  };
}
