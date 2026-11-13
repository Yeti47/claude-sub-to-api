/**
 * One live Claude Code process and the state of its conversation.
 *
 *   running --(turn completes)--------> idle
 *   running --(model calls a tool)----> parked
 *   idle ----(next turn)--------------> running
 *   parked --(client sends results)---> running
 *   any -----(error, timeout, evict)--> closed
 *
 * An idle process waits for the conversation's next message. A parked one
 * has a turn in flight: its tool handlers block until the API client returns
 * the results. Both hold a concurrency slot and are closed by a timer when
 * nothing arrives, or earlier when another request needs the slot: an idle
 * process at once, a parked one after a grace period.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolBridge } from "../anthropic/tools.js";
import type { PendingToolRegistry } from "./pending-tools.js";
import type { TurnInput } from "./turn-input.js";

export type ProcessStatus = "running" | "idle" | "parked" | "closed";

export interface QueryHandle extends AsyncIterable<SDKMessage> {
  close?: () => void;
}

export interface LiveProcessInit {
  key: string;
  model: string;
  launchKey: string;
  includeThinking: boolean;
  bridge: ToolBridge | undefined;
  pending: PendingToolRegistry;
  input: TurnInput;
  handle: QueryHandle;
  controller: AbortController;
  sessionId?: string;
  /** Runs once when the process closes: frees its slot, drops it from the pool. */
  onClose: (process: LiveProcess) => void;
}

export class LiveProcess {
  /** Conversation key of the request this process last served. */
  key: string;
  readonly model: string;
  readonly launchKey: string;
  readonly includeThinking: boolean;
  readonly bridge: ToolBridge | undefined;
  readonly pending: PendingToolRegistry;
  readonly input: TurnInput;
  readonly controller: AbortController;
  readonly iterator: AsyncIterator<SDKMessage>;
  sessionId: string | undefined;
  lastUsed = Date.now();

  private current: ProcessStatus = "running";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly handle: QueryHandle;
  private readonly onClose: (process: LiveProcess) => void;

  constructor(init: LiveProcessInit) {
    this.key = init.key;
    this.model = init.model;
    this.launchKey = init.launchKey;
    this.includeThinking = init.includeThinking;
    this.bridge = init.bridge;
    this.pending = init.pending;
    this.input = init.input;
    this.controller = init.controller;
    this.handle = init.handle;
    this.iterator = init.handle[Symbol.asyncIterator]();
    this.sessionId = init.sessionId;
    this.onClose = init.onClose;
  }

  get status(): ProcessStatus {
    return this.current;
  }

  /** Take the next turn, or continue the parked one. */
  begin(): void {
    if (this.current !== "idle" && this.current !== "parked") {
      throw new Error(`cannot start a turn on a ${this.current} process`);
    }
    this.clearTimer();
    this.current = "running";
    this.lastUsed = Date.now();
  }

  /** The turn completed; wait up to `idleMs` for the next one. */
  rest(idleMs: number): void {
    if (this.current !== "running") return;
    if (idleMs <= 0) {
      this.close("Idle session closed");
      return;
    }
    this.current = "idle";
    this.lastUsed = Date.now();
    this.arm(idleMs, "Idle session closed");
  }

  /** The turn stopped on tool calls; wait for the client's results. */
  park(ttlMs: number): void {
    if (this.current !== "running") return;
    this.current = "parked";
    this.lastUsed = Date.now();
    if (ttlMs > 0) this.arm(ttlMs, "Parked tool turn expired");
  }

  close(reason: string): void {
    if (this.current === "closed") return;
    this.current = "closed";
    this.clearTimer();
    this.pending.rejectAll(new Error(reason));
    this.input.end();
    try {
      this.handle.close?.();
    } catch {
      // already closed
    }
    this.onClose(this);
  }

  private arm(ms: number, reason: string): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.close(reason);
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
