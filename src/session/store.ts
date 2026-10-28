/**
 * Persisted conversation -> Claude session bindings.
 *
 * Resuming the same Claude session is what keeps Anthropic's prompt cache
 * warm: the CLI sends the new user message on top of the exact transcript it
 * already has, instead of re-sending a reconstructed history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../anthropic/types.js";
import { hasToolResult, userMessageHashes } from "./hashes.js";
import type { Logger } from "../logger.js";

interface Binding {
  sessionId: string;
  model: string;
  cwd: string;
  systemHash: string;
  userHashes: string[];
  updatedAt: number;
}

export interface ResumePlan {
  sessionId: string;
  /** Index in the request's messages where the session's new turns start. */
  fromIndex: number;
  /** How many user messages the session has already answered. */
  matchedUsers: number;
}

const MAX_BINDINGS = 300;
const MAX_HASHES = 500;
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

  /**
   * Decide whether this request continues the bound session. Returns null
   * when the history diverged, the model/prompt changed, this is a retry with
   * no new user turn, or the new turn is a tool result (handled by the tool
   * bridge rather than a resume).
   */
  plan(input: {
    key: string;
    messages: Message[];
    model: string;
    cwd: string;
    systemHash: string;
    now?: number;
  }): ResumePlan | null {
    const binding = this.data[input.key];
    if (!binding) return null;
    if (input.now !== undefined && input.now - binding.updatedAt > MAX_AGE_MS) {
      delete this.data[input.key];
      this.dirty = true;
      return null;
    }
    if (
      binding.model !== input.model ||
      binding.cwd !== input.cwd ||
      binding.systemHash !== input.systemHash
    ) {
      return null;
    }

    const hashes = userMessageHashes(input.messages);
    if (hashes.length <= binding.userHashes.length) return null;
    for (let index = 0; index < binding.userHashes.length; index += 1) {
      if (hashes[index] !== binding.userHashes[index]) return null;
    }

    // Find where the session's first new user message begins.
    let seen = 0;
    let fromIndex = -1;
    for (let index = 0; index < input.messages.length; index += 1) {
      if (input.messages[index]?.role !== "user") continue;
      seen += 1;
      if (seen === binding.userHashes.length + 1) {
        fromIndex = index;
        break;
      }
    }
    if (fromIndex < 0) return null;

    const newTurns = input.messages.slice(fromIndex);
    if (newTurns.some(hasToolResult)) return null;

    return {
      sessionId: binding.sessionId,
      fromIndex,
      matchedUsers: binding.userHashes.length,
    };
  }

  record(input: {
    key: string;
    sessionId: string;
    model: string;
    cwd: string;
    systemHash: string;
    userHashes: string[];
  }): void {
    if (input.userHashes.length > MAX_HASHES) return;
    this.data[input.key] = {
      sessionId: input.sessionId,
      model: input.model,
      cwd: input.cwd,
      systemHash: input.systemHash,
      userHashes: input.userHashes,
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
