/**
 * Persisted Claude sessions and their checkpoints.
 *
 * Resuming the same Claude session is what keeps Anthropic's prompt cache
 * warm. Each completed turn records a checkpoint: a fingerprint of the
 * complete history through that turn and the Claude transcript UUID at its
 * end. A request is matched to a session by content: the longest prefix of
 * its history that equals a checkpoint decides where it continues. When that
 * checkpoint is the end of its transcript the session is resumed; otherwise
 * (a rewind, an edit, a branch, a turn still running) it is forked there.
 *
 * Nothing here depends on a conversation key, so requests that share a key
 * but differ in model or system prompt cannot overwrite each other, and two
 * conversations that happen to share a key still find their own sessions.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../anthropic/types.js";
import { hasToolResult, historyFingerprint, historyPrefixHashes } from "./hashes.js";
import type { Logger } from "../logger.js";

export interface Checkpoint {
  /** Fingerprint of the complete history through this turn. */
  historyHash: string;
  /** Transcript UUID at the end of the turn. */
  leafUuid: string;
}

/** What a session was launched with; a checkpoint only matches inside it. */
export interface SessionScope {
  model: string;
  cwd: string;
  systemHash: string;
}

interface SessionEntry extends SessionScope {
  /**
   * The checkpoint the transcript currently ends at, by history fingerprint.
   * Empty while a turn is running or parked on a tool call, because the
   * transcript then extends past the last checkpoint.
   */
  tip: string;
  checkpoints: Checkpoint[];
  updatedAt: number;
}

interface StateFile {
  version: 2;
  sessions: Record<string, SessionEntry>;
}

export type ResumeDecision =
  | {
      kind: "resume";
      sessionId: string;
      /** Index in the request's messages where the new turns start. */
      fromIndex: number;
      /** Fingerprint of the checkpoint the session is resumed at. */
      historyHash?: string;
    }
  | {
      kind: "fork";
      sessionId: string;
      upToMessageId: string;
      fromIndex: number;
    }
  | { kind: "fresh" };

const MAX_SESSIONS = 300;
const MAX_CHECKPOINTS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function scopeKey(scope: SessionScope): string {
  return JSON.stringify([scope.model, scope.cwd, scope.systemHash]);
}

function indexKey(scope: SessionScope, historyHash: string): string {
  return `${scopeKey(scope)}\u0000${historyHash}`;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  /** Scope and history fingerprint -> the session holding that checkpoint. */
  private index = new Map<string, string>();

  constructor(
    private readonly path: string | undefined,
    private readonly logger: Logger,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      const sessions =
        (parsed as StateFile).version === 2
          ? Object.entries((parsed as StateFile).sessions ?? {})
          : migrateBindings(parsed as Record<string, LegacyBinding>);
      // Oldest first, so the newest session wins a shared checkpoint.
      sessions.sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
      for (const [sessionId, entry] of sessions) {
        if (!validEntry(entry)) continue;
        this.sessions.set(sessionId, entry);
        for (const checkpoint of entry.checkpoints) {
          this.index.set(indexKey(entry, checkpoint.historyHash), sessionId);
        }
      }
    } catch {
      this.logger.warn("could not read session state", { path: this.path });
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      const file: StateFile = { version: 2, sessions: Object.fromEntries(this.sessions) };
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch (error) {
      this.logger.warn("could not write session state", {
        path: this.path,
        error: String(error),
      });
    }
  }

  /**
   * Decide how a request continues. The latest checkpoint matching a prefix
   * of its history wins; everything after it is sent as new turns.
   */
  plan(input: SessionScope & { messages: Message[]; now?: number }): ResumeDecision {
    const userIndices: number[] = [];
    for (let index = 0; index < input.messages.length; index += 1) {
      if (input.messages[index]?.role === "user") userIndices.push(index);
    }
    if (userIndices.length < 2) return { kind: "fresh" };

    // One rolling pass gives the history fingerprint at every message index.
    const prefixHashes = historyPrefixHashes(input.messages);

    // A checkpoint ends a turn, so it can only sit right before a user
    // message. The complete history through it must match, assistant replies
    // included: user-only matching would miss an edited reply and resume a
    // transcript the client no longer has.
    for (let count = userIndices.length - 1; count >= 1; count -= 1) {
      const fromIndex = userIndices[count]!;
      const historyHash = prefixHashes[fromIndex - 1]!;
      const sessionId = this.index.get(indexKey(input, historyHash));
      if (!sessionId) continue;
      const session = this.sessions.get(sessionId);
      const checkpoint = session?.checkpoints.find((item) => item.historyHash === historyHash);
      if (!session || !checkpoint) continue;
      if (input.now !== undefined && input.now - session.updatedAt > MAX_AGE_MS) {
        this.forget(sessionId);
        continue;
      }

      // The normal case: the client appended a turn after the last completed
      // one, and nothing else has continued that transcript since.
      if (
        session.tip === historyHash &&
        !input.messages.slice(fromIndex).some(hasToolResult)
      ) {
        return { kind: "resume", sessionId, fromIndex, historyHash };
      }
      // A rewrite, rewind, retry or branch: fork at the checkpoint, then send
      // the remaining turns.
      return { kind: "fork", sessionId, upToMessageId: checkpoint.leafUuid, fromIndex };
    }

    return { kind: "fresh" };
  }

  /**
   * Take the session a decision is about to use. A resumed session stops
   * being resumable until its turn is recorded, so two requests can never
   * append to one transcript at the same time.
   */
  claim(decision: ResumeDecision): void {
    if (decision.kind === "fresh") return;
    const session = this.sessions.get(decision.sessionId);
    if (!session) return;
    session.updatedAt = Date.now();
    if (decision.kind === "resume") session.tip = "";
  }

  /**
   * Undo a claim whose turn never reached the session. A turn that did reach
   * it and then failed keeps the claim: the transcript may hold a partial
   * exchange the client never saw, so the next request forks at the last
   * checkpoint instead of appending after it.
   */
  release(decision: ResumeDecision): void {
    if (decision.kind !== "resume" || !decision.historyHash) return;
    const session = this.sessions.get(decision.sessionId);
    if (!session || session.tip !== "") return;
    if (session.checkpoints.some((item) => item.historyHash === decision.historyHash)) {
      session.tip = decision.historyHash;
    }
  }

  record(
    input: SessionScope & {
      sessionId: string;
      /** Complete history through this turn, including the assistant reply. */
      history: Message[];
      /** Transcript UUID of the final assistant message of this turn. */
      leafUuid?: string;
      /** A tool turn is not a completed checkpoint yet. */
      parked?: boolean;
    },
  ): void {
    let session = this.sessions.get(input.sessionId);
    if (session && scopeKey(session) !== scopeKey(input)) {
      this.forget(input.sessionId, false);
      session = undefined;
    }
    if (!session) {
      session = {
        model: input.model,
        cwd: input.cwd,
        systemHash: input.systemHash,
        tip: "",
        checkpoints: [],
        updatedAt: 0,
      };
      this.sessions.set(input.sessionId, session);
    }

    session.tip = "";
    if (!input.parked && input.leafUuid && input.history.some((m) => m.role === "user")) {
      const checkpoint: Checkpoint = {
        historyHash: historyFingerprint(input.history),
        leafUuid: input.leafUuid,
      };
      session.checkpoints = session.checkpoints.filter(
        (item) => item.historyHash !== checkpoint.historyHash,
      );
      session.checkpoints.push(checkpoint);
      while (session.checkpoints.length > MAX_CHECKPOINTS) {
        this.unindex(input.sessionId, session, session.checkpoints.shift()!);
      }
      this.index.set(indexKey(session, checkpoint.historyHash), input.sessionId);
      session.tip = checkpoint.historyHash;
    }
    session.updatedAt = Date.now();

    this.prune();
    this.save();
  }

  /** Drop a session whose transcript is gone. */
  forget(sessionId: string, save = true): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const checkpoint of session.checkpoints) this.unindex(sessionId, session, checkpoint);
    this.sessions.delete(sessionId);
    if (save) this.save();
  }

  private unindex(sessionId: string, session: SessionEntry, checkpoint: Checkpoint): void {
    const key = indexKey(session, checkpoint.historyHash);
    // A newer session may hold the same history; leave its entry alone.
    if (this.index.get(key) === sessionId) this.index.delete(key);
  }

  private prune(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const oldest = [...this.sessions.entries()]
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
      .slice(0, this.sessions.size - MAX_SESSIONS);
    for (const [sessionId] of oldest) this.forget(sessionId, false);
  }
}

function validEntry(entry: SessionEntry): boolean {
  return (
    Boolean(entry) &&
    typeof entry.model === "string" &&
    typeof entry.cwd === "string" &&
    typeof entry.systemHash === "string" &&
    typeof entry.tip === "string" &&
    typeof entry.updatedAt === "number" &&
    Array.isArray(entry.checkpoints) &&
    entry.checkpoints.every(
      (item) => typeof item?.historyHash === "string" && typeof item.leafUuid === "string",
    )
  );
}

/** The state file before version 2: one binding per conversation key. */
interface LegacyBinding extends SessionScope {
  sessionId: string;
  userHashes?: string[];
  checkpoints?: Array<{
    count?: number;
    historyHash?: string;
    sessionId?: string;
    leafUuid?: string;
  }>;
  updatedAt: number;
}

function migrateBindings(bindings: Record<string, LegacyBinding>): Array<[string, SessionEntry]> {
  const sessions = new Map<string, SessionEntry>();
  for (const binding of Object.values(bindings)) {
    if (!binding || typeof binding !== "object" || !Array.isArray(binding.checkpoints)) continue;
    for (const checkpoint of binding.checkpoints) {
      // Checkpoints without a full-history fingerprint cannot be matched.
      if (!checkpoint?.historyHash || !checkpoint.leafUuid || !checkpoint.sessionId) continue;
      let session = sessions.get(checkpoint.sessionId);
      if (!session) {
        session = {
          model: binding.model,
          cwd: binding.cwd,
          systemHash: binding.systemHash,
          tip: "",
          checkpoints: [],
          updatedAt: Number(binding.updatedAt) || 0,
        };
        sessions.set(checkpoint.sessionId, session);
      }
      session.checkpoints.push({
        historyHash: checkpoint.historyHash,
        leafUuid: checkpoint.leafUuid,
      });
      // The binding's own session ends at its last checkpoint unless a tool
      // turn had moved past it.
      if (
        checkpoint.sessionId === binding.sessionId &&
        checkpoint.count === binding.userHashes?.length
      ) {
        session.tip = checkpoint.historyHash;
      }
    }
  }
  return [...sessions.entries()];
}
