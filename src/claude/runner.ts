/**
 * Runs Messages API turns through the Claude Agent SDK.
 *
 * The runner owns every live Claude process and routes each request to one:
 * tool results continue the parked turn that asked for them, an appended
 * message goes to the idle process of its session, and anything else starts
 * a process (resuming, forking or replaying as the session plan says).
 */
import { randomUUID } from "node:crypto";
import {
  forkSession as sdkForkSession,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";
import type {
  MessagesRequest,
  MessagesResponse,
  ToolResultBlock,
  ToolUseBlock,
} from "../anthropic/types.js";
import {
  contentBlocks,
  lastToolResults,
  prepareTurn,
  type PreparedTurn,
} from "../anthropic/translate.js";
import { buildToolBridge } from "../anthropic/tools.js";
import { MessageAssembler } from "./assembler.js";
import { Semaphore } from "./semaphore.js";
import {
  PendingToolRegistry,
  type CallToolResult,
  type McpContent,
  type PendingToolCall,
} from "./pending-tools.js";
import { TurnInput } from "./turn-input.js";
import { KeyedLock } from "./keyed-lock.js";
import { LiveProcess, type QueryHandle } from "./process.js";
import { ApiError, ClientAbort, ResumeFailed, errorFor, isMissingSession } from "./errors.js";
import {
  launchKey,
  queryOptions,
  stableStringify,
  turnIdentity,
  wantsThinking,
} from "./options.js";
import type { ResumeDecision } from "../session/store.js";

export { ApiError, ClientAbort } from "./errors.js";

export interface RunInput {
  /**
   * Conversation identity. Requests with the same key run one at a time; the
   * session a request continues is found by its history, not by this key.
   */
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
  /**
   * Compute the resume/fork decision inside the conversation lock, and claim
   * the session it names.
   */
  plan?: () => ResumeDecision;
  /**
   * Give back a claimed session whose turn never reached its process. Once
   * the prompt was sent, a failed turn may have left a partial exchange in
   * the transcript, so the claim stays and a retry forks at the checkpoint.
   */
  release?: (decision: ResumeDecision) => void;
  /** Drop a session whose transcript turned out to be missing. */
  forget?: (sessionId: string) => void;
  /**
   * Persist the turn before the conversation lock is released. `decision` is
   * the plan that started the turn, or undefined for a tool continuation.
   */
  record?: (result: RunResult, decision?: ResumeDecision) => void;
}

export interface RunResult {
  response: MessagesResponse;
  sessionId?: string;
  /** The turn stopped on a tool call and its process waits for the results. */
  parked?: boolean;
  /** Transcript UUID of the final main-chain assistant message. */
  leafUuid?: string;
  /** Whether this turn reused an already-running Claude process. */
  reused?: boolean;
  /** Whether this turn started a new process from a resumed session. */
  resumed?: boolean;
  /** Whether this turn resumed a session forked from an earlier checkpoint. */
  forked?: boolean;
}

/** The SDK's session-fork operation, injectable for tests. */
export type ForkSession = (
  sessionId: string,
  options?: { upToMessageId?: string; dir?: string },
) => Promise<{ sessionId: string }>;

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => QueryHandle;

/** Whether a turn's prompt was handed to a Claude process. */
interface Delivery {
  sent: boolean;
}

/** How a new process is launched. */
interface Launch {
  prepared: PreparedTurn;
  launchKey: string;
  resumeSessionId?: string;
}

export class ClaudeRunner {
  private readonly limit: Semaphore;
  private readonly processes = new Set<LiveProcess>();
  private readonly locks = new KeyedLock();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly queryFn: QueryFactory = sdkQuery as unknown as QueryFactory,
    private readonly createPending: () => PendingToolRegistry = () => new PendingToolRegistry(),
    private readonly forkFn: ForkSession = sdkForkSession,
  ) {
    this.limit = new Semaphore(config.maxConcurrency);
  }

  async run(input: RunInput): Promise<RunResult> {
    let release: (() => void) | undefined;
    try {
      release = await this.locks.acquire(input.conversationKey, input.signal);
    } catch {
      throw new ClientAbort();
    }
    try {
      return await this.runLocked(input);
    } finally {
      release();
    }
  }

  closeAll(reason = "Server shutting down"): void {
    for (const process of [...this.processes]) process.close(reason);
  }

  private async runLocked(input: RunInput): Promise<RunResult> {
    if (input.signal.aborted) throw new ClientAbort();

    const toolResults = lastToolResults(input.request.messages);
    const parked = this.findParked([...toolResults.results.keys()]);
    if (parked) {
      // Only the final message matters here; the history is already in the turn.
      const prepared = prepareTurn(input.request, {
        resumeFromIndex: input.request.messages.length - 1,
      });
      if (parked.identity === turnIdentity(input.request, prepared)) {
        return this.continueParked(parked, input, toolResults);
      }
      // The client changed the model, system prompt or tools between the
      // tool call and its results. The parked turn would answer with the old
      // ones, so it is dropped and the request is planned like any other.
      this.logger.warn("tool results do not match the parked turn's configuration", {
        requestId: input.requestId,
        sessionId: parked.sessionId,
      });
      parked.close("Configuration changed before the tool results arrived");
    }

    // The client moved past a tool call without answering it in its final
    // message, so the turn waiting for that answer is dead. Other parked
    // turns stay: agents running in parallel may share a conversation key.
    const called = toolUseIds(input.request.messages);
    for (const process of [...this.processes]) {
      if (
        process.status === "parked" &&
        process.pending.pendingIds().some((id) => called.has(id))
      ) {
        process.close("Superseded by a new request");
      }
    }

    // Planning happens under the conversation lock, so a concurrent request
    // cannot reuse a plan computed against an older committed history.
    const decision: ResumeDecision = input.plan
      ? input.plan()
      : input.resumeSessionId !== undefined && input.resumeFromIndex !== undefined
        ? {
            kind: "resume",
            sessionId: input.resumeSessionId,
            fromIndex: input.resumeFromIndex,
          }
        : { kind: "fresh" };

    const delivery: Delivery = { sent: false };
    try {
      return await this.runDecided(input, decision, delivery);
    } catch (error) {
      if (!delivery.sent) input.release?.(decision);
      throw error;
    }
  }

  /** The parked process waiting for any of these tool results. */
  private findParked(toolUseIds: string[]): LiveProcess | undefined {
    if (toolUseIds.length === 0) return undefined;
    for (const process of this.processes) {
      if (process.status !== "parked") continue;
      const pending = process.pending.pendingIds();
      if (toolUseIds.some((id) => pending.includes(id))) return process;
    }
    return undefined;
  }

  private async continueParked(
    process: LiveProcess,
    input: RunInput,
    toolResults: ReturnType<typeof lastToolResults>,
  ): Promise<RunResult> {
    const ids = process.pending.pendingIds();
    // An incomplete answer leaves the turn parked for a corrected request.
    const missing = ids.filter((id) => !toolResults.results.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        400,
        "invalid_request_error",
        `missing tool_result for ${missing.join(", ")}`,
      );
    }

    process.begin();
    const lastId = ids.at(-1);
    for (const id of ids) {
      const block = toolResults.results.get(id)!;
      process.pending.resolve(
        id,
        toMcpResult(block, id === lastId ? toolResults.steeringText : ""),
      );
    }
    process.pending.beginPhase();
    const result = { ...(await this.consume(process, input, false)), reused: true };
    input.record?.(result);
    return result;
  }

  private async runDecided(
    input: RunInput,
    planned: ResumeDecision,
    delivery: Delivery,
  ): Promise<RunResult> {
    let decision = planned;
    // This conversation moved to a fork, so its idle process on the source
    // session is superseded. Closing it also keeps the CLI from appending to
    // the transcript while it is copied.
    if (decision.kind === "fork") {
      for (const live of [...this.processes]) {
        if (
          live.key === input.conversationKey &&
          live.sessionId === decision.sessionId &&
          live.status === "idle"
        ) {
          live.close("Forking the conversation history");
        }
      }
    }

    let resumeSessionId: string | undefined;
    let resumeFromIndex: number | undefined;
    let forked = false;
    if (decision.kind === "resume") {
      resumeSessionId = decision.sessionId;
      resumeFromIndex = decision.fromIndex;
    } else if (decision.kind === "fork") {
      const forkedId = await this.fork(decision);
      if (forkedId) {
        resumeSessionId = forkedId;
        resumeFromIndex = decision.fromIndex;
        forked = true;
      } else {
        input.forget?.(decision.sessionId);
        decision = { kind: "fresh" };
      }
    }

    const prepared = prepareTurn(input.request, { resumeFromIndex });
    const launch: Launch = {
      prepared,
      launchKey: launchKey(this.config, input.request, prepared),
      resumeSessionId,
    };

    // The live process that owns the resumed session, if there is one. A
    // claimed session has no running turn, so a process that cannot take this
    // turn (different model, system prompt or tools) is closed, not shared.
    let live = resumeSessionId
      ? [...this.processes].find((process) => process.sessionId === resumeSessionId)
      : undefined;
    if (live && (live.status !== "idle" || live.launchKey !== launch.launchKey)) {
      live.close("Session configuration changed");
      live = undefined;
    }

    try {
      if (live) {
        if (input.signal.aborted) throw new ClientAbort();
        live.begin();
        live.pending.beginPhase();
        live.input.push({ ...prepared.prompt, uuid: randomUUID() } as SDKUserMessage);
        delivery.sent = true;
        const result = { ...(await this.consume(live, input, false)), reused: true, forked };
        input.record?.(result, decision);
        return result;
      }
      const result = await this.startProcess(input, launch, delivery);
      if (resumeSessionId !== undefined) result.resumed = true;
      if (forked) result.forked = true;
      input.record?.(result, decision);
      return result;
    } catch (error) {
      if (!(error instanceof ResumeFailed)) throw error;
      this.logger.warn("Claude session could not be resumed; replaying history", {
        requestId: input.requestId,
        sessionId: resumeSessionId,
      });
      if (resumeSessionId) input.forget?.(resumeSessionId);
      const replay = prepareTurn(input.request);
      const result = await this.startProcess(
        input,
        { prepared: replay, launchKey: launchKey(this.config, input.request, replay) },
        delivery,
      );
      input.record?.(result, { kind: "fresh" });
      return result;
    }
  }

  /**
   * Fork the session at a checkpoint. A missing or unreadable transcript must
   * not fail the request: the caller replays the history into a fresh session
   * instead.
   */
  private async fork(
    decision: Extract<ResumeDecision, { kind: "fork" }>,
  ): Promise<string | undefined> {
    try {
      const result = await this.forkFn(decision.sessionId, {
        upToMessageId: decision.upToMessageId,
        dir: this.config.cwd,
      });
      this.logger.debug("forked Claude session at checkpoint", {
        sessionId: decision.sessionId,
        forkedSessionId: result.sessionId,
        upToMessageId: decision.upToMessageId,
      });
      return result.sessionId;
    } catch (error) {
      this.logger.warn("could not fork Claude session; replaying history", {
        sessionId: decision.sessionId,
        upToMessageId: decision.upToMessageId,
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private async startProcess(
    input: RunInput,
    launch: Launch,
    delivery: Delivery,
  ): Promise<RunResult> {
    const release = await this.acquireSlot(input.signal);
    if (input.signal.aborted) {
      release();
      throw new ClientAbort();
    }
    let process: LiveProcess | undefined;
    try {
      const { request, requestId } = input;
      const pending = this.createPending();
      const bridge = buildToolBridge(launch.prepared.tools, pending);
      const controller = new AbortController();
      const inputQueue = new TurnInput();
      const handle = this.queryFn({
        prompt: inputQueue,
        options: queryOptions({
          config: this.config,
          request,
          prepared: launch.prepared,
          bridge,
          controller,
          persistSession: input.persistSession !== false,
          resumeSessionId: launch.resumeSessionId,
          onStderr: (line) => this.logger.debug("claude stderr", { requestId, line }),
        }),
      });
      process = new LiveProcess({
        key: input.conversationKey,
        model: request.model,
        launchKey: launch.launchKey,
        identity: turnIdentity(request, launch.prepared),
        includeThinking: wantsThinking(request),
        bridge,
        pending,
        input: inputQueue,
        handle,
        controller,
        sessionId: launch.resumeSessionId,
        onClose: (closed) => {
          this.processes.delete(closed);
          release();
        },
      });
      this.processes.add(process);
      inputQueue.push({ ...launch.prepared.prompt, uuid: randomUUID() } as SDKUserMessage);
      delivery.sent = true;
    } catch (error) {
      if (process) process.close("Failed to start turn");
      else release();
      throw error;
    }
    return this.consume(process, input, launch.resumeSessionId !== undefined);
  }

  /**
   * Wait for a process slot. While every slot is taken, processes nobody is
   * actively using are closed to make room; a request that still has no slot
   * after `queueTimeoutMs` is turned away so the client can back off.
   */
  private async acquireSlot(signal: AbortSignal): Promise<() => void> {
    const wait = new AbortController();
    const onAbort = () => wait.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timeout =
      this.config.queueTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            wait.abort();
          }, this.config.queueTimeoutMs)
        : undefined;
    timeout?.unref?.();
    // A parked turn becomes evictable as it ages, so keep looking.
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const makeRoom = () => {
      recheck = setTimeout(makeRoom, this.evict() ? 50 : this.nextEvictionMs());
      recheck.unref?.();
    };
    if (this.processes.size >= this.config.maxConcurrency) makeRoom();
    try {
      const release = await this.limit.acquire(wait.signal);
      return release;
    } catch {
      if (!timedOut || signal.aborted) throw new ClientAbort();
      throw new ApiError(
        529,
        "overloaded_error",
        `All ${this.config.maxConcurrency} Claude processes are busy. Retry shortly.`,
        QUEUE_RETRY_AFTER_SECONDS,
      );
    } finally {
      clearTimeout(timeout);
      clearTimeout(recheck);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Close the process that costs least to lose: the least recently used idle
   * one (its session resumes later), else the parked turn that has waited
   * longest past its grace period (its tool results are replayed into a fork).
   */
  private evict(): boolean {
    const oldest = (status: LiveProcess["status"]) =>
      [...this.processes]
        .filter((process) => process.status === status)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    const idle = oldest("idle");
    if (idle) {
      idle.close("Evicted idle session");
      return true;
    }
    const grace = this.config.parkedEvictableAfterMs;
    const parked = oldest("parked");
    if (grace > 0 && parked && Date.now() - parked.lastUsed >= grace) {
      this.logger.info("evicted a parked tool turn to free a process slot", {
        sessionId: parked.sessionId,
        parkedMs: Date.now() - parked.lastUsed,
      });
      parked.close("Evicted parked tool turn");
      return true;
    }
    return false;
  }

  /** When to look for an evictable process again. */
  private nextEvictionMs(): number {
    const grace = this.config.parkedEvictableAfterMs;
    if (grace <= 0) return 1000;
    const now = Date.now();
    const waits = [...this.processes]
      .filter((process) => process.status === "parked")
      .map((process) => process.lastUsed + grace - now);
    return Math.min(1000, Math.max(10, ...(waits.length ? [Math.min(...waits)] : [1000])));
  }

  /**
   * Read the running turn of a process until it completes or stops on tool
   * calls. Any failure closes the process.
   */
  private async consume(
    process: LiveProcess,
    input: RunInput,
    resuming: boolean,
  ): Promise<RunResult> {
    if (input.signal.aborted) {
      process.close("Client aborted");
      throw new ClientAbort();
    }
    const assembler = new MessageAssembler(
      process.model,
      process.bridge,
      input.stream ? input.onEvent : undefined,
      process.includeThinking,
    );
    const onAbort = () => {
      this.logger.debug("client aborted turn", { requestId: input.requestId });
      process.controller.abort();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    let lastMessage: Record<string, unknown> | undefined;
    let ended = false;

    try {
      while (true) {
        const next = await process.iterator.next();
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
        if (assembler.sessionId) process.sessionId = assembler.sessionId;

        if (assembler.sawToolUse && assembler.sawMessageStop) {
          const response = assembler.response();
          const blocks = response.content.filter(
            (block): block is ToolUseBlock => block.type === "tool_use",
          );
          await process.pending.waitFor(blocks.length, 15_000, input.signal);
          if (!matchToolCalls(blocks, process.pending.calls(), process.pending)) {
            throw new ApiError(502, "api_error", "Claude requested a tool the bridge could not match");
          }
          // Park first, then let the client see the message end: its tool
          // results can arrive immediately and must find the parked turn.
          process.park(this.config.parkedTurnTtlMs);
          assembler.flush();
          return {
            response,
            sessionId: process.sessionId,
            leafUuid: assembler.leafUuid,
            parked: true,
          };
        }
        if (lastMessage.type === "result") break;
      }
    } catch (error) {
      process.close("Turn failed");
      if (input.signal.aborted) throw new ClientAbort();
      if (error instanceof ApiError || error instanceof ResumeFailed || error instanceof ClientAbort) {
        throw error;
      }
      if (resuming && !assembler.sawStreamEvents) {
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

    const failed =
      assembler.resultError && (assembler.fatalError || assembler.content.length === 0);
    if (failed) {
      process.close("Turn failed");
      // A missing session on a resume is retryable by replaying the
      // transcript, so it is surfaced as ResumeFailed instead of a 502.
      const error = assembler.resultError!;
      if (resuming && !assembler.sawStreamEvents && isMissingSession(error.message)) {
        throw new ResumeFailed(error.message);
      }
      throw errorFor(error);
    }
    if (assembler.content.length === 0 && typeof lastMessage?.result === "string") {
      assembler.content = [{ type: "text", text: lastMessage.result }];
    }
    if (
      assembler.content.length === 0 &&
      assembler.stopReason !== "max_tokens" &&
      assembler.stopReason !== "refusal"
    ) {
      process.close("Empty response");
      throw new ApiError(502, "api_error", "Claude Code returned an empty response");
    }
    const response = assembler.response();
    // A message that stopped on a tool call but never reached the park above
    // (the process ended first) still owes the client its closing events.
    assembler.flush();
    process.sessionId = assembler.sessionId ?? process.sessionId;
    if (ended) process.close("Claude process ended");
    else if (this.limit.waiting > 0) {
      process.close("Yielded capacity to a waiting conversation");
    } else process.rest(this.config.sessionIdleMs);
    return {
      response,
      sessionId: process.sessionId,
      leafUuid: assembler.leafUuid,
    };
  }
}

/** Seconds a client turned away for lack of a free process should wait. */
const QUEUE_RETRY_AFTER_SECONDS = 10;

/** Every tool call the request's history contains. */
function toolUseIds(messages: MessagesRequest["messages"]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const block of contentBlocks(message.content)) {
      if (block.type === "tool_use") ids.add(block.id);
    }
  }
  return ids;
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
