/**
 * Headless authentication.
 *
 * The only credential is CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
 * The Claude Code CLI still needs a config directory for its onboarding flag,
 * session transcripts, and other local state, but no `.credentials.json` is
 * read or copied.
 */
import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";

export interface AuthStatus {
  ok: boolean;
  detail: string;
}

export interface PreparedAuth {
  status(): Promise<AuthStatus>;
  cleanup(): Promise<void>;
}

interface ClaudeJson {
  hasCompletedOnboarding?: unknown;
  [key: string]: unknown;
}

const ONBOARDING_FILE = ".claude.json";

/**
 * The CLI skips its first-run onboarding only when this flag is present.
 * Merge it into the existing file so the rest of the CLI's state survives.
 */
export async function ensureOnboarding(path: string): Promise<void> {
  let parsed: ClaudeJson = {};
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as ClaudeJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `cannot read ${path}: ${errorMessage(error)}. Fix or remove the file; ` +
          "the proxy will not overwrite it.",
      );
    }
  }

  if (parsed.hasCompletedOnboarding === true) return;

  parsed.hasCompletedOnboarding = true;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * The CLI keeps `.claude.json` at the root of its config directory when
 * CLAUDE_CONFIG_DIR is set, and in the home directory when it is not.
 */
export function onboardingPath(config: Config): string {
  return config.claudeConfigDirExplicit
    ? join(config.claudeConfigDir, ONBOARDING_FILE)
    : join(homedir(), ONBOARDING_FILE);
}

export async function prepareClaudeAuth(
  config: Config,
  logger: Logger,
): Promise<PreparedAuth> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is required. Run `claude setup-token` on a machine " +
        "with browser access and put the token in the environment.",
    );
  }
  if (!token.startsWith("sk-ant-oat")) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN does not look like a token from `claude setup-token` " +
        "(expected prefix sk-ant-oat). Do not use a console API key here.",
    );
  }

  await mkdir(config.claudeConfigDir, { recursive: true });
  await access(config.claudeConfigDir, constants.W_OK);
  const file = onboardingPath(config);
  await ensureOnboarding(file);

  logger.info("using CLAUDE_CODE_OAUTH_TOKEN", {
    configDir: config.claudeConfigDir,
    onboarding: file,
  });

  return {
    async status(): Promise<AuthStatus> {
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        return { ok: false, detail: "CLAUDE_CODE_OAUTH_TOKEN is missing" };
      }
      try {
        const file = JSON.parse(
          await readFile(onboardingPath(config), "utf8"),
        ) as ClaudeJson;
        return file.hasCompletedOnboarding === true
          ? { ok: true, detail: "oauth-token" }
          : { ok: false, detail: "onboarding flag is missing" };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },
    async cleanup(): Promise<void> {},
  };
}
