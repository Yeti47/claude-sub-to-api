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
import { TurnInput } from "./turn-input.js";

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
  /** Stable conversation identity; one live process per key. */
  conversationKey: string;
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
  /** Whether this turn reused an already-running Claude process. */
  reused?: boolean;
}

interface TurnState {
  key: string;
  model: string;
  bridge?: ToolBridge;
  pending: PendingToolRegistry;
  input: TurnInput;
  handle: QueryHandle;
  iterator: AsyncIterator<SDKMessage>;
  controller: AbortController;
  includeThinking: boolean;
  release: () => void;
  sessionId?: string;
  launchKey: string;
  busy: boolean;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

interface QueryHandle extends AsyncIterable<SDKMessage> {
  close?: () => void;
}

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => QueryHandle;

function thinkingOption(request: MessagesRequest, maxTokens: number): Record<string, unknown> {
  const thinking = request.thinking;
  if (!thinking || thinking.type === "disabled") return { type: "disabled" };
  if (thinking.type === "adaptive") return { type: "adaptive", display: "summarized" };
  const budget = Number(thinking.budget_tokens ?? 0);
  const limit = maxTokens - 1;
  if (budget <= 0 || limit < 1024) return { type: "adaptive", display: "summarized" };
  return {
    type: "enabled",
    budgetTokens: Math.min(Math.max(1024, budget), limit),
    display: "summarized",
  };
}

function errorFor(result: {
  type: string;
  message: string;
  status?: number;
  resetAt?: number;
}): ApiError {
  const type = result.type.toLowerCase();
  const haystack = `${type} ${result.message}`.toLowerCase();
  const reset = result.resetAt
    ? ` Resets at ${new Date(result.resetAt).toISOString()}.`
    : "";
  const message = `${result.message}${reset}`;

  if (result.status !== undefined) {
    if (result.status === 401) return new ApiError(401, "authentication_error", message);
    if (result.status === 403) return new ApiError(403, "permission_error", message);
    if (result.status === 404) return new ApiError(404, "not_found_error", message);
    if (result.status === 429) return new ApiError(429, "rate_limit_error", message);
    if (result.status === 529) return new ApiError(529, "overloaded_error", message);
    if (result.status >= 500) return new ApiError(502, "api_error", message);
    if (result.status >= 400) return new ApiError(400, "invalid_request_error", message);
  }

  if (haystack.includes("rate_limit")) return new ApiError(429, "rate_limit_error", message);
  if (haystack.includes("overloaded")) return new ApiError(529, "overloaded_error", message);
  if (
    haystack.includes("authentication") ||
    haystack.includes("authenticate") ||
    haystack.includes("oauth") ||
    haystack.includes("credential") ||
    haystack.includes("login")
  )
    return new ApiError(401, "authentication_error", message);
  if (haystack.includes("permission")) return new ApiError(403, "permission_error", message);
  if (type.includes("model_not_found")) return new ApiError(404, "not_found_error", message);
  if (type.includes("invalid_request")) return new ApiError(400, "invalid_request_error", message);
  if (type.includes("refusal")) return new ApiError(400, "invalid_request_error", message);
  return new ApiError(502, "api_error", message);
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

  private readonly processes = new Map<string, TurnState>();
  private readonly locks = new Map<string, Promise<void>>();

  async run(input: RunInput): Promise<RunResult> {
    return this.withLock(input.conversationKey, () => this.runLocked(input));
  }

  private async runLocked(input: RunInput): Promise<RunResult> {
    if (input.signal.aborted) throw new ClientAbort();
    let prepared = prepareTurn(input.request, {
      resumeFromIndex: input.resumeFromIndex,
    });
    let launchKey = this.launchKey(input.request, prepared);
    let state = this.processes.get(input.conversationKey);

    if (state) {
      const sameSession =
        !input.resumeSessionId || !state.sessionId || state.sessionId === input.resumeSessionId;
      const compatible =
        !state.closed &&
        state.launchKey === launchKey &&
        input.resumeFromIndex !== undefined &&
        sameSession;
      if (!compatible) {
        this.closeState(state, "Session configuration or history changed");
        state = undefined;
      }
    }

    try {
      if (state) {
        this.cancelIdle(state);
        if (input.signal.aborted) throw new ClientAbort();
        state.busy = true;
        state.lastUsed = Date.now();
        state.pending.beginPhase();
        state.input.push({ ...prepared.prompt, uuid: randomUUID() } as SDKUserMessage);
        const result = await this.consume(state, { ...input, resumeSessionId: undefined });
        return { ...result, reused: true };
      }
      return await this.startProcess(input, prepared, launchKey);
    } catch (error) {
      if (error instanceof ResumeFailed) {
        this.logger.warn("Claude session could not be resumed; replaying history", {
          requestId: input.requestId,
          sessionId: input.resumeSessionId,
        });
        const fresh = {
          ...input,
          resumeSessionId: undefined,
          resumeFromIndex: undefined,
        };
        prepared = prepareTurn(input.request);
        launchKey = this.launchKey(input.request, prepared);
        return this.startProcess(fresh, prepared, launchKey);
      }
      throw error;
    }
  }

  private async startProcess(
    input: RunInput,
    prepared: ReturnType<typeof prepareTurn>,
    launchKey: string,
  ): Promise<RunResult> {
    const release = await this.acquireSlot(input.signal);
    let state: TurnState | undefined;
    try {
      const pending = this.createPending();
      const bridge = buildToolBridge(prepared.tools, pending);
      const controller = new AbortController();
      const inputQueue = new TurnInput();
      const options = this.queryOptions(input, prepared, bridge, controller);
      const handle = this.queryFn({ prompt: inputQueue, options });
      state = {
        key: input.conversationKey,
        model: input.request.model,
        bridge,
        pending,
        input: inputQueue,
        handle,
        iterator: handle[Symbol.asyncIterator](),
        controller,
        includeThinking:
          input.request.thinking?.type === "enabled" ||
          input.request.thinking?.type === "adaptive",
        release,
        sessionId:
          input.resumeSessionId && input.resumeFromIndex !== undefined
            ? input.resumeSessionId
            : undefined,
        launchKey,
        busy: true,
        lastUsed: Date.now(),
        closed: false,
      };
      this.processes.set(input.conversationKey, state);
      inputQueue.push({ ...prepared.prompt, uuid: randomUUID() } as SDKUserMessage);
      return await this.consume(state, input);
    } catch (error) {
      if (state) this.closeState(state, "Failed to start turn");
      else release();
      throw error;
    }
  }

  private queryOptions(
    input: RunInput,
    prepared: ReturnType<typeof prepareTurn>,
    bridge: ToolBridge | undefined,
    controller: AbortController,
  ): Record<string, unknown> {
    const { request, requestId } = input;
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
      // Deliver prompts exactly as sent: do not expand @paths, run /commands,
      // or inject Claude Code's own per-turn context.
      verbatimPrompts: true,
      settings: { disableAllHooks: true },
      abortController: controller,
      stderr: (line: string) => this.logger.debug("claude stderr", { requestId, line }),
    };
    const systemOption = systemPromptOption(prepared.system);
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
      options.allowedTools = bridge.exposedNames;
      options.hooks = {
        PreToolUse: [
          {
            hooks: [
              async (input: Record<string, unknown>) => {
                if (
                  input.hook_event_name === "PreToolUse" &&
                  typeof input.tool_name === "string" &&
                  typeof input.tool_use_id === "string"
                ) {
                  bridge.beforeToolUse(input.tool_name, input.tool_use_id);
                }
                return {};
              },
            ],
          },
        ],
      };
    }
    if (input.resumeSessionId && input.resumeFromIndex !== undefined) {
      options.resume = input.resumeSessionId;
    }
    return options;
  }

  private launchKey(
    request: MessagesRequest,
    prepared: ReturnType<typeof prepareTurn>,
  ): string {
    const maxTokens = Math.min(
      Math.max(1, request.max_tokens ?? this.config.defaultMaxTokens),
      64_000,
    );
    return stableStringify({
      model: request.model,
      system: prepared.system ?? null,
      tools: prepared.tools,
      maxTokens,
      thinking: thinkingOption(request, maxTokens),
      effort: request.output_config?.effort ?? null,
      cwd: this.config.cwd,
      configDir: this.config.claudeConfigDir,
    });
  }

  private async acquireSlot(signal: AbortSignal): Promise<() => void> {
    if (this.processes.size >= this.config.maxConcurrency) {
      const idle = [...this.processes.values()]
        .filter((state) => !state.busy && !state.closed)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) this.closeState(idle, "Evicted idle session");
    }
    try {
      return await this.limit.acquire(signal);
    } catch {
      throw new ClientAbort();
    }
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private cancelIdle(state: TurnState): void {
    if (!state.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private armIdle(state: TurnState): void {
    this.cancelIdle(state);
    if (state.closed || state.busy) return;
    if (this.config.sessionIdleMs <= 0) {
      this.closeState(state, "Idle session closed");
      return;
    }
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (!state.busy && !state.closed) this.closeState(state, "Idle session closed");
    }, this.config.sessionIdleMs);
    state.idleTimer.unref?.();
  }

  closeAll(reason = "Server shutting down"): void {
    for (const state of [...this.processes.values()]) this.closeState(state, reason);
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
    let ended = false;

    try {
      while (true) {
        const next = await state.iterator.next();
        if (next.done) {
          ended = true;
          break;
        }
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
          state.busy = true;
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
    state.sessionId = assembler.sessionId ?? state.sessionId;
    state.busy = false;
    state.lastUsed = Date.now();
    if (ended) this.closeState(state, "Claude process ended");
    else this.armIdle(state);
    return { response, sessionId: state.sessionId };
  }

  private makeParked(state: TurnState): ParkedTurn {
    return new ParkedTurn(randomUUID(), state.sessionId, state.pending, {
      resume: (input) =>
        this.withLock(state.key, () => this.resumeParked(state, input)),
      close: (reason) => this.closeState(state, reason),
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
      const result = await this.consume(state, { ...input, resumeSessionId: undefined });
      return { ...result, reused: true };
    } catch (error) {
      this.closeState(state, "Tool continuation failed");
      throw error;
    }
  }

  private closeState(state: TurnState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    this.cancelIdle(state);
    state.pending.rejectAll(new Error(reason));
    state.input.end();
    try {
      state.handle.close?.();
    } catch {
      // already closed
    }
    if (this.processes.get(state.key) === state) this.processes.delete(state.key);
    state.release();
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
  const linked = new Set(calls.map((call) => call.toolUseId).filter(Boolean));
  const remaining = calls.filter((call) => !call.toolUseId);
  for (const block of blocks) {
    if (linked.has(block.id)) continue;
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
