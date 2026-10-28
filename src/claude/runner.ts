/** Runs one Messages API turn through the Claude Agent SDK. */
import { query as sdkQuery, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";
import type { MessagesRequest, MessagesResponse } from "../anthropic/types.js";
import { effectiveSystemPrompt, prepareTurn } from "../anthropic/translate.js";
import { buildToolBridge } from "../anthropic/tools.js";
import { MessageAssembler } from "./assembler.js";
import { Semaphore } from "./semaphore.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class ClientAbort extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbort";
  }
}

class ResumeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeFailed";
  }
}

function isMissingSession(error: unknown): boolean {
  const message = errorMessage(error);
  return /no conversation found|session.*(not found|does not exist)|could not find.*session/i.test(
    message,
  );
}

export interface RunInput {
  request: MessagesRequest;
  signal: AbortSignal;
  requestId: string;
  stream: boolean;
  onEvent?: (event: Record<string, unknown>) => void;
  /** Resume this Claude session instead of replaying the transcript. */
  resumeSessionId?: string;
  /** Index in request.messages where the resumed session's new turns start. */
  resumeFromIndex?: number;
  /** Persist the CLI transcript so a later request can resume it. */
  persistSession?: boolean;
}

export interface RunResult {
  response: MessagesResponse;
  sessionId?: string;
}

interface QueryHandle extends AsyncIterable<SDKMessage> {
  close?: () => void;
}

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => QueryHandle;

/** One-message streaming input; the SDK requires an iterable for rich content. */
async function* singlePrompt(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

function thinkingOption(request: MessagesRequest, maxTokens: number): Record<string, unknown> {
  const thinking = request.thinking;
  if (!thinking || thinking.type === "disabled") return { type: "disabled" };
  if (thinking.type === "adaptive") return { type: "adaptive" };
  const budget = Number(thinking.budget_tokens ?? 0);
  const limit = maxTokens - 1;
  if (budget <= 0 || limit < 1024) return { type: "adaptive" };
  return { type: "enabled", budgetTokens: Math.min(Math.max(1024, budget), limit) };
}

function errorFor(result: { type: string; message: string }): ApiError {
  const type = result.type.toLowerCase();
  const haystack = `${type} ${result.message}`.toLowerCase();
  if (haystack.includes("rate_limit")) return new ApiError(429, "rate_limit_error", result.message);
  if (haystack.includes("overloaded")) return new ApiError(529, "overloaded_error", result.message);
  if (
    haystack.includes("authentication") ||
    haystack.includes("authenticate") ||
    haystack.includes("oauth") ||
    haystack.includes("credential") ||
    haystack.includes("login")
  )
    return new ApiError(401, "authentication_error", result.message);
  if (type.includes("model_not_found")) return new ApiError(404, "not_found_error", result.message);
  if (type.includes("invalid_request")) return new ApiError(400, "invalid_request_error", result.message);
  if (type.includes("refusal")) return new ApiError(400, "invalid_request_error", result.message);
  return new ApiError(502, "api_error", result.message);
}

export class ClaudeRunner {
  private readonly limit: Semaphore;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly queryFn: QueryFactory = sdkQuery as unknown as QueryFactory,
  ) {
    this.limit = new Semaphore(config.maxConcurrency);
  }

  private childEnv(maxTokens: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (this.config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = this.config.claudeConfigDir;
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = "8192";
    // The API client owns retries. Hidden CLI retries would produce several
    // model messages for one API request, which cannot be represented as one
    // Anthropic response (especially in a stream).
    if (!env.CLAUDE_CODE_MAX_RETRIES) env.CLAUDE_CODE_MAX_RETRIES = "0";
    // The CLI is driven by an API client, not a terminal user.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  async run(input: RunInput): Promise<RunResult> {
    let release: (() => void) | undefined;
    try {
      release = await this.limit.acquire(input.signal);
    } catch {
      throw new ClientAbort();
    }
    try {
      try {
        return await this.runInner(input);
      } catch (error) {
        if (error instanceof ResumeFailed) {
          this.logger.warn("Claude session could not be resumed; replaying history", {
            requestId: input.requestId,
            sessionId: input.resumeSessionId,
          });
          return await this.runInner({
            ...input,
            resumeSessionId: undefined,
            resumeFromIndex: undefined,
          });
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  private async runInner(input: RunInput): Promise<RunResult> {
    const { request, signal, requestId, stream, onEvent } = input;
    const prepared = prepareTurn(request, {
      resumeFromIndex: input.resumeFromIndex,
    });
    const bridge = buildToolBridge(prepared.tools);
    const maxTokens = Math.min(
      Math.max(1, request.max_tokens ?? this.config.defaultMaxTokens),
      64_000,
    );
    // Some models reason even when thinking is off; that reasoning spends
    // the CLI's output budget. Give short requests headroom so the answer is
    // not cut off before it starts.
    const cliMaxTokens =
      request.thinking?.type === "enabled" || request.thinking?.type === "adaptive"
        ? maxTokens
        : Math.max(maxTokens, 1024);

    const system = [effectiveSystemPrompt(request.system), prepared.toolChoiceNote]
      .filter(Boolean)
      .join("\n\n");
    const controller = new AbortController();
    const onAbort = () => {
      this.logger.debug("client aborted turn", { requestId });
      controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const options: Record<string, unknown> = {
      cwd: this.config.cwd,
      env: this.childEnv(cliMaxTokens),
      model: request.model,
      includePartialMessages: true,
      maxTurns: 1,
      persistSession: input.persistSession !== false,
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      tools: [],
      permissionMode: "dontAsk",
      thinking: thinkingOption(request, maxTokens),
      abortController: controller,
      stderr: (line: string) => this.logger.debug("claude stderr", { requestId, line }),
    };
    if (system) options.systemPrompt = system;
    const effort = request.output_config?.effort;
    if (
      typeof effort === "string" &&
      ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ) {
      options.effort = effort;
    }
    if (bridge) {
      options.mcpServers = bridge.mcpServers;
      // Deliberately do NOT add the MCP tools to allowedTools. `dontAsk`
      // refuses every tool that is not explicitly allowed, so Claude can
      // emit a tool_use block but the CLI never executes it. `maxTurns: 1`
      // then ends the turn; the API client owns execution.
    }
    if (this.config.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = this.config.pathToClaudeCodeExecutable;
    }
    if (input.resumeSessionId && input.resumeFromIndex !== undefined) {
      options.resume = input.resumeSessionId;
    }
    // The CLI hides reasoning by default; when the client asked for thinking,
    // ask for summaries so the thinking blocks are not empty.
    if (request.thinking?.type === "enabled" || request.thinking?.type === "adaptive") {
      options.settings = { showThinkingSummaries: true };
      options.extraArgs = { "thinking-display": "summarized" };
    }

    const assembler = new MessageAssembler(
      request.model,
      bridge,
      stream ? onEvent : undefined,
      request.thinking?.type === "enabled" || request.thinking?.type === "adaptive",
    );
    const handle = this.queryFn({ prompt: singlePrompt(prepared.prompt), options });
    let internalStop = false;
    let lastMessage: Record<string, unknown> | undefined;

    try {
      for await (const message of handle) {
        lastMessage = message as Record<string, unknown>;
        this.logger.debug("sdk message", {
          requestId,
          type: lastMessage.type,
          subtype: lastMessage.subtype,
          event:
            lastMessage.type === "stream_event"
              ? (lastMessage.event as { type?: unknown } | undefined)?.type
              : undefined,
        });
        assembler.handle(message);
        if (assembler.sawToolUse && assembler.sawMessageStop) {
          internalStop = true;
          controller.abort();
          break;
        }
        if (lastMessage.type === "result") break;
      }
    } catch (error) {
      if (signal.aborted) throw new ClientAbort();
      if (input.resumeSessionId && !assembler.sawStreamEvents) {
        const reason = assembler.resultError?.message ?? errorMessage(error);
        if (isMissingSession(reason)) throw new ResumeFailed(reason);
      }
      if (assembler.resultError) throw errorFor(assembler.resultError);
      if (!internalStop) {
        this.logger.error("claude turn failed", { requestId, error: errorMessage(error) });
        throw new ApiError(502, "api_error", `Claude Code turn failed: ${errorMessage(error)}`);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        handle.close?.();
      } catch {
        // already closed
      }
    }

    if (assembler.fatalError && assembler.resultError) {
      throw errorFor(assembler.resultError);
    }
    if (assembler.resultError && assembler.content.length === 0) {
      throw errorFor(assembler.resultError);
    }
    if (assembler.content.length === 0 && typeof lastMessage?.result === "string") {
      assembler.content = [{ type: "text", text: lastMessage.result }];
    }
    if (assembler.content.length === 0) {
      // A max_tokens or refusal stop can legitimately have no content.
      if (assembler.stopReason === "max_tokens" || assembler.stopReason === "refusal") {
        return { response: assembler.response(), sessionId: assembler.sessionId };
      }
      throw new ApiError(502, "api_error", "Claude Code returned an empty response");
    }
    return { response: assembler.response(), sessionId: assembler.sessionId };
  }
}
