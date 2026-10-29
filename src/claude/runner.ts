/** Runs one Messages API turn through the Claude Agent SDK. */
import { randomUUID } from "node:crypto";
import { query as sdkQuery, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";
import type {
  MessagesRequest,
  MessagesResponse,
  ToolResultBlock,
  ToolUseBlock,
} from "../anthropic/types.js";
import { contentBlocks, prepareTurn } from "../anthropic/translate.js";
import { buildToolBridge, type ToolBridge } from "../anthropic/tools.js";
import { MessageAssembler } from "./assembler.js";
import { Semaphore } from "./semaphore.js";
import {
  PendingToolRegistry,
  type CallToolResult,
  type McpContent,
  type PendingToolCall,
} from "./pending-tools.js";
import { ParkedTurn, type ResumeParkedInput } from "./parked.js";

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
  /** Set when the turn stopped on a tool call and waits for client results. */
  parked?: ParkedTurn;
}

interface TurnState {
  model: string;
  bridge?: ToolBridge;
  pending: PendingToolRegistry;
  handle: QueryHandle;
  iterator: AsyncIterator<SDKMessage>;
  controller: AbortController;
  includeThinking: boolean;
  release: () => void;
  sessionId?: string;
  closed: boolean;
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

const RUNTIME_NOTE = [
  "<runtime_info>",
  "You are running in claude-sub-to-api, an Anthropic-compatible HTTP API backed by a Claude subscription, through the Claude Code harness.",
  "The built-in Claude Code tools (Bash, Read, Edit, and so on) are disabled. The only tools available are the ones defined in this request; they are provided by the API client, which executes them, and their results come back in a later message.",
  "If you are asked what you are running in, say this plainly. Do not claim to be Claude Code itself, and do not imply the API client is Claude Code.",
  "</runtime_info>",
].join("\n");

function systemPromptOption(clientSystem: string | undefined): Record<string, unknown> {
  const append = [
    RUNTIME_NOTE,
    clientSystem
      ? `# API client instructions\n\nThe API client that sent this request supplied the following instructions. Follow them for this turn; they take precedence over the harness's coding-specific guidance.\n\n${clientSystem}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    type: "preset",
    preset: "claude_code",
    // Keeps cwd, memory path and git status out of the system prompt, so it
    // stays stable across sessions and can be read from the prompt cache.
    excludeDynamicSections: true,
    append,
  };
}

export class ClaudeRunner {
  private readonly limit: Semaphore;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly queryFn: QueryFactory = sdkQuery as unknown as QueryFactory,
    private readonly createPending: () => PendingToolRegistry = () => new PendingToolRegistry(),
  ) {
    this.limit = new Semaphore(config.maxConcurrency);
  }

  private childEnv(maxTokens: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (this.config.claudeConfigDirExplicit) {
      env.CLAUDE_CONFIG_DIR = this.config.claudeConfigDir;
    } else {
      delete env.CLAUDE_CONFIG_DIR;
    }
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
    let result: RunResult;
    try {
      try {
        result = await this.runInner(input, release);
      } catch (error) {
        if (error instanceof ResumeFailed) {
          this.logger.warn("Claude session could not be resumed; replaying history", {
            requestId: input.requestId,
            sessionId: input.resumeSessionId,
          });
          result = await this.runInner(
            { ...input, resumeSessionId: undefined, resumeFromIndex: undefined },
            release,
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      release();
      throw error;
    }
    // A parked turn keeps its CLI process and concurrency slot alive until
    // the client returns tool results or the TTL closes it.
    if (!result.parked) release();
    return result;
  }

  private async runInner(input: RunInput, release: () => void): Promise<RunResult> {
    const { request, signal, requestId, stream, onEvent } = input;
    const prepared = prepareTurn(request, {
      resumeFromIndex: input.resumeFromIndex,
    });
    const pending = this.createPending();
    const bridge = buildToolBridge(prepared.tools, pending);
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

    const system = prepared.system;
    const systemOption = systemPromptOption(system);
    const controller = new AbortController();

    const options: Record<string, unknown> = {
      cwd: this.config.cwd,
      env: this.childEnv(cliMaxTokens),
      model: request.model,
      includePartialMessages: true,
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
    if (systemOption) options.systemPrompt = systemOption;
    const effort = request.output_config?.effort;
    if (
      typeof effort === "string" &&
      ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ) {
      options.effort = effort;
    }
    if (bridge) {
      options.mcpServers = bridge.mcpServers;
      // The CLI must be allowed to call the in-process handlers; they block
      // until the API client returns the tool result.
      options.allowedTools = bridge.exposedNames;
    } else {
      // A text-only turn needs exactly one assistant message.
      options.maxTurns = 1;
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

    const handle = this.queryFn({ prompt: singlePrompt(prepared.prompt), options });
    const state: TurnState = {
      model: request.model,
      bridge,
      pending,
      handle,
      iterator: handle[Symbol.asyncIterator](),
      controller,
      includeThinking:
        request.thinking?.type === "enabled" || request.thinking?.type === "adaptive",
      release,
      closed: false,
    };
    return this.consume(state, input);
  }

  private async consume(state: TurnState, input: RunInput): Promise<RunResult> {
    const assembler = new MessageAssembler(
      state.model,
      state.bridge,
      input.stream ? input.onEvent : undefined,
      state.includeThinking,
    );
    const onAbort = () => {
      this.logger.debug("client aborted turn", { requestId: input.requestId });
      state.controller.abort();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    let lastMessage: Record<string, unknown> | undefined;

    try {
      while (true) {
        const next = await state.iterator.next();
        if (next.done) break;
        const message = next.value;
        lastMessage = message as Record<string, unknown>;
        this.logger.debug("sdk message", {
          requestId: input.requestId,
          type: lastMessage.type,
          subtype: lastMessage.subtype,
          event:
            lastMessage.type === "stream_event"
              ? (lastMessage.event as { type?: unknown } | undefined)?.type
              : undefined,
        });
        assembler.handle(message);
        if (assembler.sessionId) state.sessionId = assembler.sessionId;

        if (assembler.sawToolUse && assembler.sawMessageStop) {
          const response = assembler.response();
          const blocks = response.content.filter(
            (block): block is ToolUseBlock => block.type === "tool_use",
          );
          await state.pending.waitFor(blocks.length, 15_000, input.signal);
          if (!matchToolCalls(blocks, state.pending.calls(), state.pending)) {
            throw new ApiError(502, "api_error", "Claude requested a tool the bridge could not match");
          }
          return { response, sessionId: state.sessionId, parked: this.makeParked(state) };
        }
        if (lastMessage.type === "result") break;
      }
    } catch (error) {
      this.closeState(state, "Turn failed");
      if (input.signal.aborted) throw new ClientAbort();
      if (error instanceof ApiError || error instanceof ResumeFailed || error instanceof ClientAbort) {
        throw error;
      }
      if (input.resumeSessionId && !assembler.sawStreamEvents) {
        const reason = assembler.resultError?.message ?? errorMessage(error);
        if (isMissingSession(reason)) throw new ResumeFailed(reason);
      }
      if (assembler.resultError) throw errorFor(assembler.resultError);
      this.logger.error("claude turn failed", {
        requestId: input.requestId,
        error: errorMessage(error),
      });
      throw new ApiError(502, "api_error", `Claude Code turn failed: ${errorMessage(error)}`);
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }

    if (assembler.fatalError && assembler.resultError) {
      this.closeState(state, "Turn failed");
      throw errorFor(assembler.resultError);
    }
    if (assembler.resultError && assembler.content.length === 0) {
      this.closeState(state, "Turn failed");
      throw errorFor(assembler.resultError);
    }
    if (assembler.content.length === 0 && typeof lastMessage?.result === "string") {
      assembler.content = [{ type: "text", text: lastMessage.result }];
    }
    if (assembler.content.length === 0) {
      if (assembler.stopReason !== "max_tokens" && assembler.stopReason !== "refusal") {
        this.closeState(state, "Empty response");
        throw new ApiError(502, "api_error", "Claude Code returned an empty response");
      }
    }
    const response = assembler.response();
    this.closeState(state, "Turn finished");
    return { response, sessionId: state.sessionId };
  }

  private makeParked(state: TurnState): ParkedTurn {
    return new ParkedTurn(randomUUID(), state.sessionId, state.pending, {
      resume: (input) => this.resumeParked(state, input),
      close: (reason) => {
        this.closeState(state, reason);
        state.release();
      },
    });
  }

  private async resumeParked(state: TurnState, input: ResumeParkedInput): Promise<RunResult> {
    const ids = state.pending.pendingIds();
    for (const id of ids) {
      if (!input.toolResults.has(id)) {
        throw new ApiError(400, "invalid_request_error", `missing tool_result for ${id}`);
      }
    }
    const lastId = ids.at(-1);
    for (const id of ids) {
      const block = input.toolResults.get(id)!;
      state.pending.resolve(id, toMcpResult(block, id === lastId ? input.steeringText : ""));
    }
    state.pending.beginPhase();
    try {
      const result = await this.consume(state, input);
      if (!result.parked) state.release();
      return result;
    } catch (error) {
      this.closeState(state, "Tool continuation failed");
      state.release();
      throw error;
    }
  }

  private closeState(state: TurnState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    state.pending.rejectAll(new Error(reason));
    try {
      state.handle.close?.();
    } catch {
      // already closed
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function matchToolCalls(
  blocks: ToolUseBlock[],
  calls: PendingToolCall[],
  pending: PendingToolRegistry,
): boolean {
  const remaining = [...calls];
  for (const block of blocks) {
    let index = remaining.findIndex(
      (call) =>
        call.name === block.name && stableStringify(call.args) === stableStringify(block.input),
    );
    if (index < 0) {
      // The MCP layer may normalise argument types; fall back to name order.
      index = remaining.findIndex((call) => call.name === block.name);
    }
    if (index < 0) return false;
    const call = remaining.splice(index, 1)[0]!;
    pending.link(block.id, call);
  }
  return true;
}

function toMcpResult(block: ToolResultBlock, steeringText: string): CallToolResult {
  const content: McpContent[] = [];
  for (const part of contentBlocks(block.content ?? "")) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image" && part.source.type === "base64") {
      content.push({
        type: "image",
        data: part.source.data,
        mimeType: part.source.media_type,
      });
    } else if (part.type === "document") {
      content.push({
        type: "text",
        text:
          part.source.type === "url"
            ? `[document: ${part.source.url}]`
            : `[document: ${part.title ?? part.media_type ?? "attachment"}]`,
      });
    } else {
      content.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  if (steeringText.trim()) content.push({ type: "text", text: steeringText });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, isError: block.is_error === true };
}
