/**
 * Persisted conversation -> Claude session bindings.
 *
 * Resuming the same Claude session is what keeps Anthropic's prompt cache
 * warm. Each completed turn also records a checkpoint: the user-message count
 * and the Claude transcript UUID at the end of that turn. When the client
 * rewinds or edits history, the session is forked at the latest matching
 * checkpoint instead of being discarded.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../anthropic/types.js";
import { hasToolResult, userMessageHashes } from "./hashes.js";
import type { Logger } from "../logger.js";

export interface Checkpoint {
  /** Number of user messages the session had answered at this point. */
  count: number;
  /** Hash of the last user message in that turn. */
  hash: string;
  /** Claude session containing this checkpoint. */
  sessionId: string;
  /** Transcript UUID at the end of the turn. */
  leafUuid: string;
}

interface Binding {
  sessionId: string;
  model: string;
  cwd: string;
  systemHash: string;
  userHashes: string[];
  checkpoints?: Checkpoint[];
  updatedAt: number;
}

export type ResumeDecision =
  | {
      kind: "resume";
      sessionId: string;
      fromIndex: number;
      matchedUsers: number;
    }
  | {
      kind: "fork";
      sessionId: string;
      upToMessageId: string;
      fromIndex: number;
      matchedUsers: number;
    }
  | { kind: "fresh" };

const MAX_BINDINGS = 300;
const MAX_HASHES = 500;
const MAX_CHECKPOINTS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function fromIndexFor(messages: Message[], matchedUsers: number): number {
  let seen = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue;
    seen += 1;
    if (seen === matchedUsers + 1) return index;
  }
  return -1;
}

export class SessionStore {
  private data: Record<string, Binding> = {};
  private dirty = false;

  constructor(
    private readonly path: string | undefined,
    private readonly logger: Logger,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Binding>;
      if (parsed && typeof parsed === "object") this.data = parsed;
    } catch {
      this.logger.warn("could not read session bindings", { path: this.path });
    }
  }

  private save(): void {
    if (!this.path || !this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (error) {
      this.logger.warn("could not write session bindings", {
        path: this.path,
        error: String(error),
      });
    }
  }

  plan(input: {
    key: string;
    messages: Message[];
    model: string;
    cwd: string;
    systemHash: string;
    now?: number;
  }): ResumeDecision {
    const binding = this.data[input.key];
    if (!binding) return { kind: "fresh" };
    if (input.now !== undefined && input.now - binding.updatedAt > MAX_AGE_MS) {
      delete this.data[input.key];
      this.dirty = true;
      return { kind: "fresh" };
    }
    if (
      binding.model !== input.model ||
      binding.cwd !== input.cwd ||
      binding.systemHash !== input.systemHash
    ) {
      return { kind: "fresh" };
    }

    const hashes = userMessageHashes(input.messages);
    if (hashes.length === 0) return { kind: "fresh" };

    const matches = (count: number): boolean => {
      if (count === 0) return true;
      if (binding.userHashes.length < count || hashes.length < count) return false;
      for (let index = 0; index < count; index += 1) {
        if (binding.userHashes[index] !== hashes[index]) return false;
      }
      return true;
    };

    // The normal case: the client appended a new turn to the bound history.
    if (
      hashes.length > binding.userHashes.length &&
      matches(binding.userHashes.length)
    ) {
      const fromIndex = fromIndexFor(input.messages, binding.userHashes.length);
      if (fromIndex >= 0 && !input.messages.slice(fromIndex).some(hasToolResult)) {
        return {
          kind: "resume",
          sessionId: binding.sessionId,
          fromIndex,
          matchedUsers: binding.userHashes.length,
        };
      }
    }

    // A rewrite, rewind or retry: fork at the last checkpoint that still
    // matches the incoming history, then send the remaining turns.
    const target = hashes.length - 1;
    if (target >= 0) {
      const checkpoints = [...(binding.checkpoints ?? [])]
        .filter(
          (checkpoint) =>
            checkpoint.count <= target &&
            checkpoint.leafUuid.length > 0 &&
            checkpoint.sessionId.length > 0 &&
            matches(checkpoint.count),
        )
        .sort((a, b) => b.count - a.count);
      for (const checkpoint of checkpoints) {
        const fromIndex = fromIndexFor(input.messages, checkpoint.count);
        if (fromIndex < 0) continue;
        return {
          kind: "fork",
          sessionId: checkpoint.sessionId,
          upToMessageId: checkpoint.leafUuid,
          fromIndex,
          matchedUsers: checkpoint.count,
        };
      }
    }

    return { kind: "fresh" };
  }

  record(input: {
    key: string;
    sessionId: string;
    model: string;
    cwd: string;
    systemHash: string;
    userHashes: string[];
    /** Transcript UUID of the final assistant message of this turn. */
    leafUuid?: string;
    /** A tool turn is not a completed checkpoint yet. */
    parked?: boolean;
    /** Decision that started this turn, for checkpoint retention. */
    decision?: ResumeDecision | null;
  }): void {
    if (input.userHashes.length > MAX_HASHES) return;
    const existing = this.data[input.key];
    const decision = input.decision;
    let checkpoints: Checkpoint[];
    if (decision?.kind === "fresh") {
      checkpoints = [];
    } else if (decision?.kind === "fork") {
      checkpoints = (existing?.checkpoints ?? []).filter(
        (checkpoint) => checkpoint.count <= decision.matchedUsers,
      );
    } else {
      checkpoints =
        existing &&
        existing.sessionId === input.sessionId &&
        existing.model === input.model &&
        existing.cwd === input.cwd &&
        existing.systemHash === input.systemHash &&
        existing.userHashes.length <= input.userHashes.length &&
        existing.userHashes.every((hash, index) => hash === input.userHashes[index])
          ? [...(existing.checkpoints ?? [])]
          : [];
    }

    if (!input.parked && input.leafUuid && input.userHashes.length > 0) {
      const checkpoint: Checkpoint = {
        count: input.userHashes.length,
        hash: input.userHashes[input.userHashes.length - 1]!,
        sessionId: input.sessionId,
        leafUuid: input.leafUuid,
      };
      checkpoints = checkpoints.filter((item) => item.count !== checkpoint.count);
      checkpoints.push(checkpoint);
      checkpoints.sort((a, b) => a.count - b.count);
      if (checkpoints.length > MAX_CHECKPOINTS) {
        checkpoints = checkpoints.slice(-MAX_CHECKPOINTS);
      }
    }

    this.data[input.key] = {
      sessionId: input.sessionId,
      model: input.model,
      cwd: input.cwd,
      systemHash: input.systemHash,
      userHashes: input.userHashes,
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
      updatedAt: Date.now(),
    };
    this.prune();
    this.dirty = true;
    this.save();
  }

  clear(key: string): void {
    if (!this.data[key]) return;
    delete this.data[key];
    this.dirty = true;
    this.save();
  }

  private prune(): void {
    const entries = Object.entries(this.data);
    if (entries.length <= MAX_BINDINGS) return;
    entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    this.data = Object.fromEntries(entries.slice(0, MAX_BINDINGS));
  }
}
