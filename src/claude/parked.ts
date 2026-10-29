/** A live Claude turn stopped on a tool call, waiting for client results. */
import type { ToolResultBlock } from "../anthropic/types.js";
import type { RunInput, RunResult } from "./runner.js";
import type { PendingToolRegistry } from "./pending-tools.js";
import type { Logger } from "../logger.js";

export interface ResumeParkedInput extends RunInput {
  toolResults: Map<string, ToolResultBlock>;
  /** Text the client sent alongside tool results, if any. */
  steeringText: string;
}

export interface ParkedTurnHooks {
  resume(input: ResumeParkedInput): Promise<RunResult>;
  close(reason: string): void;
}

export class ParkedTurn {
  readonly id: string;
  readonly createdAt = Date.now();
  lastUsed = Date.now();

  constructor(
    id: string,
    readonly sessionId: string | undefined,
    readonly pending: PendingToolRegistry,
    private readonly hooks: ParkedTurnHooks,
  ) {
    this.id = id;
  }

  pendingIds(): string[] {
    return this.pending.pendingIds();
  }

  resume(input: ResumeParkedInput): Promise<RunResult> {
    this.lastUsed = Date.now();
    return this.hooks.resume(input);
  }

  close(reason: string): void {
    this.hooks.close(reason);
  }
}

export class ParkedTurnStore {
  private readonly turns = new Map<string, ParkedTurn>();
  private readonly reaper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly ttlMs: number,
  ) {
    if (ttlMs > 0) {
      this.reaper = setInterval(() => this.reap(), Math.min(60_000, ttlMs));
      this.reaper.unref?.();
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const [key, turn] of this.turns) {
      if (now - turn.lastUsed <= this.ttlMs) continue;
      this.logger.info("closing parked tool turn past its TTL", { key, turnId: turn.id });
      this.turns.delete(key);
      turn.close("Parked tool turn expired");
    }
  }

  add(key: string, turn: ParkedTurn): void {
    // One live turn per conversation.
    const previous = this.turns.get(key);
    if (previous && previous.id !== turn.id) previous.close("Superseded by a newer parked turn");
    this.turns.set(key, turn);
  }

  take(key: string): ParkedTurn | undefined {
    const turn = this.turns.get(key);
    if (!turn) return undefined;
    this.turns.delete(key);
    return turn;
  }

  remove(turn: ParkedTurn): void {
    for (const [key, current] of this.turns) {
      if (current.id === turn.id) this.turns.delete(key);
    }
  }

  /** Match a turn by conversation key, then by any tool_use id in the request. */
  find(key: string, toolUseIds: string[]): ParkedTurn | undefined {
    const direct = this.turns.get(key);
    if (direct && toolUseIds.some((id) => direct.pendingIds().includes(id))) return direct;
    for (const turn of this.turns.values()) {
      if (toolUseIds.some((id) => turn.pendingIds().includes(id))) return turn;
    }
    return undefined;
  }

  close(key: string, reason: string): void {
    const turn = this.turns.get(key);
    if (!turn) return;
    this.turns.delete(key);
    turn.close(reason);
  }

  closeAll(reason: string): void {
    for (const [key, turn] of this.turns) {
      this.turns.delete(key);
      turn.close(reason);
    }
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
  }
}
