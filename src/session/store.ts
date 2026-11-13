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
import {
  hasToolResult,
  historyFingerprint,
  historyPrefixHashes,
  userMessageHashes,
} from "./hashes.js";
import type { Logger } from "../logger.js";

export interface Checkpoint {
  /** Number of user messages the session had answered at this point. */
  count: number;
  /** Hash of the last user message in that turn. */
  hash: string;
  /** Fingerprint of the complete history through this turn. */
  historyHash: string;
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

    const userIndices: number[] = [];
    for (let index = 0; index < input.messages.length; index += 1) {
      if (input.messages[index]?.role === "user") userIndices.push(index);
    }
    if (userIndices.length === 0) return { kind: "fresh" };

    // One rolling pass gives the history fingerprint at every message index.
    const prefixHashes = historyPrefixHashes(input.messages);

    // A checkpoint is usable only when the client's complete history through
    // that turn, assistant replies included, still matches the history the
    // checkpoint recorded. User-only matching would miss an edited reply and
    // resume a transcript the client no longer has.
    const matching = (binding.checkpoints ?? [])
      .filter((checkpoint) => {
        if (checkpoint.count <= 0 || checkpoint.count >= userIndices.length) return false;
        if (!checkpoint.leafUuid || !checkpoint.sessionId) return false;
        if (typeof checkpoint.historyHash !== "string" || !checkpoint.historyHash) {
          // Legacy checkpoint without a full-history fingerprint.
          return false;
        }
        const boundary = userIndices[checkpoint.count]!;
        return prefixHashes[boundary - 1] === checkpoint.historyHash;
      })
      .sort((a, b) => b.count - a.count);

    const latest = matching[0];

    // The normal case: the client appended a turn after the last completed
    // one, and that turn's history still matches exactly.
    if (
      latest &&
      latest.count === binding.userHashes.length &&
      latest.sessionId === binding.sessionId &&
      userIndices.length > latest.count
    ) {
      const fromIndex = userIndices[latest.count]!;
      if (!input.messages.slice(fromIndex).some(hasToolResult)) {
        return {
          kind: "resume",
          sessionId: binding.sessionId,
          fromIndex,
          matchedUsers: latest.count,
        };
      }
    }

    // A rewrite, rewind or retry: fork at the latest checkpoint whose complete
    // history still matches, then send the remaining turns.
    if (latest) {
      return {
        kind: "fork",
        sessionId: latest.sessionId,
        upToMessageId: latest.leafUuid,
        fromIndex: userIndices[latest.count]!,
        matchedUsers: latest.count,
      };
    }

    return { kind: "fresh" };
  }

  record(input: {
    key: string;
    sessionId: string;
    model: string;
    cwd: string;
    systemHash: string;
    /** Complete history through this turn, including the assistant reply. */
    history: Message[];
    /** Transcript UUID of the final assistant message of this turn. */
    leafUuid?: string;
    /** A tool turn is not a completed checkpoint yet. */
    parked?: boolean;
    /** Decision that started this turn, for checkpoint retention. */
    decision?: ResumeDecision | null;
  }): void {
    const userHashes = userMessageHashes(input.history);
    if (userHashes.length > MAX_HASHES) return;
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
        existing.userHashes.length <= userHashes.length &&
        existing.userHashes.every((hash, index) => hash === userHashes[index])
          ? [...(existing.checkpoints ?? [])]
          : [];
    }

    if (!input.parked && input.leafUuid && userHashes.length > 0) {
      const checkpoint: Checkpoint = {
        count: userHashes.length,
        hash: userHashes[userHashes.length - 1]!,
        historyHash: historyFingerprint(input.history),
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
      userHashes,
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
