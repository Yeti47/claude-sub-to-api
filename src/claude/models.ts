/** Lists the models the signed-in account can use, straight from the CLI. */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";

export interface ModelRow {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
}

const CACHE_MS = 10 * 60_000;
const CREATED_AT = "2025-01-01T00:00:00Z";

const FALLBACK: ModelRow[] = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
].map(([id, name]) => ({
  type: "model" as const,
  id: id!,
  display_name: name!,
  created_at: CREATED_AT,
}));

export class ModelCatalog {
  private cached: { at: number; rows: ModelRow[] } | undefined;
  private inflight: Promise<ModelRow[]> | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async list(now = Date.now()): Promise<ModelRow[]> {
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.rows;
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetch(): Promise<ModelRow[]> {
    try {
      const rows = await this.fetchFromCli(20_000);
      const result = rows.length > 0 ? rows : FALLBACK;
      this.cached = { at: Date.now(), rows: result };
      return result;
    } catch (error) {
      this.logger.warn("could not list models from Claude Code; using fallback", {
        error: errorMessage(error),
      });
      return FALLBACK;
    }
  }

  private async fetchFromCli(timeoutMs: number): Promise<ModelRow[]> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (this.config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = this.config.claudeConfigDir;

    let release: () => void = () => {};
    const idle = (async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })();

    const options: Record<string, unknown> = {
      cwd: this.config.cwd,
      env,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
    };
    if (this.config.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.config.pathToClaudeCodeExecutable;
    }

    const handle = query({ prompt: idle, options }) as unknown as {
      supportedModels?: () => Promise<
        Array<{ value?: string; displayName?: string; resolvedModel?: string }>
      >;
      close?: () => void;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (typeof handle.supportedModels !== "function") return [];
      const models = await Promise.race([
        handle.supportedModels(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (!models) return [];
      const byId = new Map<string, ModelRow>();
      for (const model of models) {
        const id = model.resolvedModel || model.value;
        if (!id) continue;
        const row: ModelRow = {
          type: "model",
          id,
          display_name: model.displayName || id,
          created_at: CREATED_AT,
        };
        // Prefer a concrete alias's display name over "Default (recommended)".
        if (!byId.has(id) || model.value !== "default") byId.set(id, row);
      }
      return [...byId.values()];
    } finally {
      if (timer) clearTimeout(timer);
      release();
      try {
        handle.close?.();
      } catch {
        // already closed
      }
    }
  }
}
