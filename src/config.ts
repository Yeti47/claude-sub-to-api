/**
 * Environment-based configuration.
 *
 * Authentication uses one long-lived token from `claude setup-token`, passed
 * as CLAUDE_CODE_OAUTH_TOKEN. The Claude Code CLI still needs a writable config
 * directory for its onboarding file, sessions, and other local state.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  listenAddr: string;
  proxyApiKey: string;
  /** Claude Code config directory passed to the SDK/CLI. */
  claudeConfigDir: string;
  /** Whether CLAUDE_CONFIG_DIR was supplied explicitly. */
  claudeConfigDirExplicit: boolean;
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

  if (!envVars.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is required. Run `claude setup-token` on a machine " +
        "with browser access and put the token in the environment.",
    );
  }

  const rawLevel = (envVars.LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  const logLevel = LEVELS.includes(rawLevel) ? rawLevel : "info";
  const explicitConfigDir = envVars.CLAUDE_CONFIG_DIR?.trim();

  return {
    listenAddr: envVars.LISTEN_ADDR?.trim() || ":8080",
    proxyApiKey,
    claudeConfigDir: explicitConfigDir || join(homedir(), ".claude"),
    claudeConfigDirExplicit: Boolean(explicitConfigDir),
    cwd: envVars.CLAUDE_CWD?.trim() || process.cwd(),
    logLevel,
    maxConcurrency: intEnv("MAX_CONCURRENCY", 4, 1, 64),
    requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 15 * 60_000, 10_000, 3_600_000),
    defaultMaxTokens: intEnv("DEFAULT_MAX_TOKENS", 8192, 1, 64_000),
    pathToClaudeCodeExecutable: envVars.CLAUDE_CODE_EXECUTABLE?.trim() || undefined,
    statePath: envVars.STATE_PATH?.trim() || undefined,
  };
}
