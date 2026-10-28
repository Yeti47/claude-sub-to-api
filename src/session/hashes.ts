/** Stable fingerprints used to decide whether a Claude session can be resumed. */
import { createHash } from "node:crypto";
import type { ContentBlock, Message } from "../anthropic/types.js";

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

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
