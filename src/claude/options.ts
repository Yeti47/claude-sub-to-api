/** Agent SDK options for one Claude process, built from a Messages API request. */
import type { Config, SystemPromptMode } from "../config.js";
import type { MessagesRequest } from "../anthropic/types.js";
import type { PreparedTurn } from "../anthropic/translate.js";
import type { ToolBridge } from "../anthropic/tools.js";

function thinkingOption(request: MessagesRequest, maxTokens: number): Record<string, unknown> {
  const thinking = request.thinking;
  if (!thinking || thinking.type === "disabled") return { type: "disabled" };
  if (thinking.type === "adaptive") return { type: "adaptive", display: "summarized" };
  const budget = Number(thinking.budget_tokens ?? 0);
  // Leave room for the reply itself: a budget that covers the whole ceiling
  // would let reasoning consume the turn and answer with nothing.
  const limit = maxTokens - Math.max(1, Math.min(1024, Math.floor(maxTokens / 2)));
  if (budget <= 0 || limit < 1024) return { type: "adaptive", display: "summarized" };
  return {
    type: "enabled",
    budgetTokens: Math.min(Math.max(1024, budget), limit),
    display: "summarized",
  };
}

/**
 * One line, the same shape Claude Code hosts such as OpenCode use. It names
 * the proxy so the model does not claim to be Claude Code, without turning the
 * harness prompt into a description of a third-party API.
 */
const RUNTIME_NOTE =
  "<runtime_info>You are running in claude-sub-to-api through the Claude Code harness. Mention this only when asked.</runtime_info>";

function systemPromptOption(
  clientSystem: string | undefined,
  mode: SystemPromptMode,
): Record<string, unknown> {
  const append = [RUNTIME_NOTE];
  if (mode === "full" && clientSystem) {
    append.push(
      `# API client instructions\n\nThe API client that sent this request supplied the following instructions. Follow them for this turn; they take precedence over the harness's coding-specific guidance.\n\n${clientSystem}`,
    );
  }

  return {
    type: "preset",
    preset: "claude_code",
    // Keeps cwd, memory path and git status out of the system prompt, so it
    // stays stable across sessions and can be read from the prompt cache.
    excludeDynamicSections: true,
    // Like the Claude Code hosts, render the prompt on every request instead
    // of recording it in the session, so a prompt change (or a switch of
    // SYSTEM_PROMPT_MODE) applies without waiting for compaction.
    snapshot: false,
    append: append.join("\n\n"),
  };
}

/** The environment every Claude Code child starts from. */
export function baseEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (config.claudeConfigDirExplicit) {
    env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  // The key API clients present to this proxy is no business of the CLI.
  delete env.PROXY_API_KEY;
  return env;
}

export function childEnv(config: Config, maxTokens: number): Record<string, string> {
  const env = baseEnv(config);
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = "8192";
  // Claude Code features that duplicate this proxy's own behavior, or that
  // would change the response shape without the API client knowing.
  env.DISABLE_AUTO_COMPACT = "1";
  env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY = "0";
  env.ENABLE_TOOL_SEARCH = "false";
  env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
  env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1";
  env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
  env.MAX_MCP_OUTPUT_TOKENS = "200000";
  // A resumed session may see a different system prompt or tools; drop
  // thinking blocks bound to the old prompt instead of failing the request.
  env.CLAUDE_CODE_POLISHED_DEWDROP = "drop";
  delete env.CLAUDE_CODE_SIMPLE;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.MCP_TOOL_TIMEOUT;
  // The API client owns retries. Hidden CLI retries would produce several
  // model messages for one API request, which cannot be represented as one
  // Anthropic response (especially in a stream).
  if (!env.CLAUDE_CODE_MAX_RETRIES) env.CLAUDE_CODE_MAX_RETRIES = "0";
  // The CLI is driven by an API client, not a terminal user.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function requestMaxTokens(config: Config, request: MessagesRequest): number {
  return Math.min(Math.max(1, request.max_tokens ?? config.defaultMaxTokens), 64_000);
}

/**
 * The ceiling the CLI actually gets. The client's `max_tokens` caps the reply
 * it asked for, but a Claude Code turn also spends output tokens on reasoning
 * and tool-call JSON, and a harness that sets a small cap (4096, say) would
 * otherwise cut the turn off before its first text block. The configured
 * floor keeps such a turn alive; 1024 remains the absolute minimum.
 */
function cliMaxTokens(config: Config, request: MessagesRequest): number {
  const client = requestMaxTokens(config, request);
  return Math.min(64_000, Math.max(client, 1024, config.minCliOutputTokens));
}

export function wantsThinking(request: MessagesRequest): boolean {
  return request.thinking?.type === "enabled" || request.thinking?.type === "adaptive";
}

export interface QueryOptionsInput {
  config: Config;
  request: MessagesRequest;
  prepared: PreparedTurn;
  bridge: ToolBridge | undefined;
  controller: AbortController;
  /** Persist the CLI transcript so a later request can resume it. */
  persistSession: boolean;
  /** Resume this Claude session instead of starting a new one. */
  resumeSessionId?: string;
  onStderr: (line: string) => void;
}

export function queryOptions(input: QueryOptionsInput): Record<string, unknown> {
  const { config, request, prepared, bridge } = input;
  // The client's cap is a lower bound for the CLI, not the CLI's ceiling: one
  // turn may have to reason before it answers (see cliMaxTokens).
  const maxTokens = cliMaxTokens(config, request);

  const options: Record<string, unknown> = {
    cwd: config.cwd,
    env: childEnv(config, maxTokens),
    model: request.model,
    includePartialMessages: true,
    persistSession: input.persistSession,
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    tools: [],
    permissionMode: "dontAsk",
    thinking: thinkingOption(request, maxTokens),
    // Deliver prompts exactly as sent: do not expand @paths, run /commands,
    // or inject Claude Code's own per-turn context.
    verbatimPrompts: true,
    settings: { disableAllHooks: true },
    abortController: input.controller,
    stderr: input.onStderr,
    systemPrompt: systemPromptOption(prepared.system, config.systemPromptMode),
  };
  const effort = request.output_config?.effort;
  if (
    typeof effort === "string" &&
    ["low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    options.effort = effort;
  }
  if (bridge) {
    options.mcpServers = bridge.mcpServers;
    options.allowedTools = bridge.exposedNames;
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            async (hook: Record<string, unknown>) => {
              if (
                hook.hook_event_name === "PreToolUse" &&
                typeof hook.tool_name === "string" &&
                typeof hook.tool_use_id === "string"
              ) {
                bridge.beforeToolUse(hook.tool_name, hook.tool_use_id);
              }
              return {};
            },
          ],
        },
      ],
    };
  }
  if (input.resumeSessionId) options.resume = input.resumeSessionId;
  return options;
}

/**
 * Everything a process is launched with. A live process can only take a turn
 * whose launch key equals its own.
 */
export function launchKey(config: Config, request: MessagesRequest, prepared: PreparedTurn): string {
  const maxTokens = cliMaxTokens(config, request);
  return stableStringify({
    model: request.model,
    system: prepared.system ?? null,
    tools: prepared.tools,
    maxTokens,
    thinking: thinkingOption(request, maxTokens),
    effort: request.output_config?.effort ?? null,
    cwd: config.cwd,
    configDir: config.claudeConfigDir,
  });
}

/**
 * What a turn in flight cannot change: the model, system prompt and tools it
 * was started with. Tool results only continue a parked turn with the same
 * identity.
 */
export function turnIdentity(request: MessagesRequest, prepared: PreparedTurn): string {
  return stableStringify({
    model: request.model,
    system: prepared.system ?? null,
    tools: prepared.tools,
  });
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
