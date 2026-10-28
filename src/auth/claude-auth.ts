/**
 * Claude Code authentication setup.
 *
 * The Agent SDK spawns the official CLI, which owns the OAuth token and its
 * refresh cycle. We only give it a config directory: the same
 * `.credentials.json` layout the CLI itself uses, so a file produced by
 * `claude login` works unchanged (and keeps getting refreshed in place).
 */
import { access, chmod, constants, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
}

async function readCredentials(path: string): Promise<CredentialsFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
  } catch {
    return null;
  }
}

function tokenPresent(file: CredentialsFile | null): boolean {
  return typeof file?.claudeAiOauth?.accessToken === "string" && file.claudeAiOauth.accessToken.length > 0;
}

export async function prepareClaudeAuth(
  config: Config,
  logger: Logger,
): Promise<PreparedAuth> {
  let configDir = config.claudeConfigDir;
  let tempDir: string | undefined;

  if (config.credentialsJSON) {
    let parsed: CredentialsFile;
    try {
      parsed = JSON.parse(config.credentialsJSON) as CredentialsFile;
    } catch {
      throw new Error("CLAUDE_CREDENTIALS_JSON is not valid JSON");
    }
    if (!tokenPresent(parsed)) {
      throw new Error("CLAUDE_CREDENTIALS_JSON has no claudeAiOauth.accessToken");
    }
    tempDir = await mkdtemp(join(tmpdir(), "claude-sub-to-api-creds-"));
    const file = join(tempDir, ".credentials.json");
    await writeFile(file, JSON.stringify(parsed), { mode: 0o600 });
    await chmod(file, 0o600);
    configDir = tempDir;
    logger.info("using credentials from CLAUDE_CREDENTIALS_JSON", { configDir });
  } else if (configDir) {
    try {
      await mkdir(configDir, { recursive: true });
      await access(configDir, constants.W_OK);
    } catch (error) {
      // A token-only setup needs no credentials file, but the CLI still wants
      // a writable config directory. Fall back to a temp one when possible.
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        throw new Error(
          `Claude config directory ${configDir} is not writable: ${errorMessage(error)}`,
        );
      }
      tempDir = await mkdtemp(join(tmpdir(), "claude-sub-to-api-config-"));
      configDir = tempDir;
    }
    logger.info("using Claude Code config directory", { configDir });
  }

  // The runner and model catalog read the resolved directory from config.
  config.claudeConfigDir = configDir;

  const credentialsPath = join(configDir ?? "", ".credentials.json");
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const initial = tokenPresent(await readCredentials(credentialsPath));
  if (initial) {
    await access(credentialsPath, constants.W_OK).catch(() => {
      logger.warn("credentials file is not writable; OAuth refresh may fail", {
        credentialsPath,
      });
    });
  }

  if (!initial && !oauthToken) {
    throw new Error(
      `No Claude subscription credentials found at ${credentialsPath}. ` +
        "Run `claude auth login` or copy .credentials.json into the config directory.",
    );
  }

  return {
    async status(): Promise<AuthStatus> {
      if (oauthToken) return { ok: true, detail: "oauth-token-env" };
      const file = await readCredentials(credentialsPath);
      return tokenPresent(file)
        ? { ok: true, detail: "credentials-file" }
        : { ok: false, detail: `missing access token in ${credentialsPath}` };
    },
    async cleanup(): Promise<void> {
      if (tempDir) {
        await import("node:fs/promises").then((fs) => fs.rm(tempDir!, { recursive: true, force: true }));
      }
    },
  };
}

export function describeAuthError(error: unknown): string {
  return errorMessage(error);
}
