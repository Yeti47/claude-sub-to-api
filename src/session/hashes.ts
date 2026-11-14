/** Stable fingerprints used to decide whether a Claude session can be resumed. */
import { createHash } from "node:crypto";
import type { ContentBlock, Message } from "../anthropic/types.js";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/** Starting value of the rolling history fingerprint. */
const HISTORY_SEED = sha1("claude-sub-to-api:history");

function hashContent(content: Message["content"]): string {
  if (typeof content === "string") return sha1(`text:${content}`);
  if (!Array.isArray(content)) return sha1(JSON.stringify(content ?? null));
  const parts = content.map((block) => hashBlock(block as ContentBlock));
  return sha1(parts.join("\u0000"));
}

function hashBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text:${block.text}`;
    case "image":
      return `image:${block.source.type}:${sha1(JSON.stringify(block.source))}`;
    case "document":
      return `document:${block.source.type}:${sha1(JSON.stringify(block.source))}`;
    case "tool_use":
      return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input ?? {})}`;
    case "tool_result":
      return `tool_result:${block.tool_use_id}:${block.is_error ? 1 : 0}:${hashContent(
        block.content ?? "",
      )}`;
    case "thinking":
      return `thinking:${block.thinking}`;
    case "redacted_thinking":
      return `redacted_thinking:${block.data}`;
    case "compaction":
      return `compaction:${block.content ?? ""}`;
    default:
      return sha1(JSON.stringify(block));
  }
}

/** One hash per user message, in order. */
export function userMessageHashes(messages: Message[]): string[] {
  return (messages ?? [])
    .filter((message) => message?.role === "user")
    .map((message) => hashContent(message.content));
}

/**
 * Hash one message's content for a complete-history fingerprint. Unlike the
 * user-message hashes, thinking blocks are ignored: clients may drop them,
 * they are not replayed into the model's transcript, and they are not part of
 * the visible reply. Strings and single text blocks are normalized so the
 * same content fingerprints identically either way.
 */
function historyContentHash(content: Message["content"]): string {
  const blocks: ContentBlock[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? (content as ContentBlock[])
        : [];
  const parts = blocks
    .map((block) =>
      block.type === "thinking" || block.type === "redacted_thinking"
        ? ""
        : hashBlock(block),
    )
    .filter((part) => part.length > 0);
  return sha1(parts.join("\u0000"));
}

/**
 * Rolling fingerprint of each message-history prefix. Index i is the
 * fingerprint through message i, so a checkpoint ending before message index
 * `boundary` compares against `hashes[boundary - 1]`.
 */
export function historyPrefixHashes(messages: Message[]): string[] {
  const hashes: string[] = [];
  let hash = HISTORY_SEED;
  for (const message of messages ?? []) {
    hash = sha1(`${hash}\u0000${message.role}:${historyContentHash(message.content)}`);
    hashes.push(hash);
  }
  return hashes;
}

/**
 * Fingerprint of a complete message history, including assistant replies.
 *
 * Checkpoints use this instead of user-message hashes alone so an edit to an
 * earlier assistant reply is detected: resuming or forking at a checkpoint
 * whose transcript contains the original reply would give Claude history the
 * client did not send.
 */
export function historyFingerprint(messages: Message[]): string {
  return historyPrefixHashes(messages).at(-1) ?? HISTORY_SEED;
}

/** Hash the system prompt, so a changed prompt starts a fresh session. */
export function systemHash(system: unknown): string {
  return sha1(JSON.stringify(system ?? null));
}

/** Stable key for a conversation without requiring a session header. */
export function deriveConversationKey(
  messages: Message[],
  headerSession?: string,
  metadataUserId?: string,
): string {
  if (headerSession) return `header:${headerSession}`;
  if (metadataUserId) {
    try {
      const parsed = JSON.parse(metadataUserId) as { session_id?: unknown };
      if (typeof parsed.session_id === "string" && parsed.session_id) {
        return `session:${parsed.session_id}`;
      }
    } catch {
      return `user:${metadataUserId}`;
    }
  }
  const firstUser = userMessageHashes(messages)[0];
  if (firstUser) return `first:${firstUser}`;
  const first = messages?.[0];
  return first ? `first:${hashContent(first.content)}` : "empty";
}

/** Whether a new user message contains tool results (handled separately). */
export function hasToolResult(message: Message): boolean {
  const blocks = typeof message.content === "string" ? [] : message.content ?? [];
  return blocks.some((block) => block?.type === "tool_result");
}
