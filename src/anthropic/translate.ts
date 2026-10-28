/**
 * Translating an Anthropic Messages API request into an Agent SDK turn.
 *
 * The SDK runs an agent session, not a stateless completion endpoint, so the
 * Messages API's message array is turned into one user prompt: the history is
 * serialized as a transcript and the final user turn is passed natively
 * (including images and documents). Tool use is exposed to Claude through an
 * in-process MCP server; see tools.ts.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlock,
  ImageBlock,
  DocumentBlock,
  Message,
  MessagesRequest,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export interface PreparedTurn {
  system: string | undefined;
  prompt: SDKUserMessage;
  /** Original tools that were actually exposed (tool_choice=none filters them). */
  tools: ToolDefinition[];
  /** Instruction appended to the system prompt for tool_choice forcing. */
  toolChoiceNote?: string;
}

export function contentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

export function systemText(system: unknown): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.trim() || undefined;
  if (!Array.isArray(system)) return undefined;
  const text = system
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Text + media for one content block. Media is returned separately so it can
 * be placed into the prompt as a real image/document block.
 */
function blockParts(block: ContentBlock, role: "user" | "assistant"): {
  text: string;
  media: Array<ImageBlock | DocumentBlock>;
} {
  switch (block.type) {
    case "text":
      return { text: block.text, media: [] };
    case "thinking":
    case "redacted_thinking":
      // Replaying chain-of-thought from a previous API call is neither
      // necessary nor desirable for a fresh agent session.
      return { text: "", media: [] };
    case "image":
      return { text: "", media: [block] };
    case "document":
      return { text: "", media: [block] };
    case "tool_use": {
      const tool = block as ToolUseBlock;
      return {
        text: `[tool call] ${tool.name} (id: ${tool.id})\n${safeStringify(tool.input)}`,
        media: [],
      };
    }
    case "tool_result": {
      const result = block as ToolResultBlock;
      const inner = contentBlocks(result.content ?? "");
      const parts = inner.map((item) => blockParts(item, "user"));
      const text = parts
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");
      return {
        text: `[tool result for ${result.tool_use_id}]${result.is_error ? " (error)" : ""}${
          text ? `\n${text}` : ""
        }`,
        media: parts.flatMap((part) => part.media),
      };
    }
    default:
      return { text: `[${role} content: ${safeStringify(block)}]`, media: [] };
  }
}

type SdkBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageBlock["source"] }
  | { type: "document"; source: DocumentBlock["source"]; title?: string; media_type?: string };

function mediaBlock(media: ImageBlock | DocumentBlock): SdkBlock {
  if (media.type === "image") {
    return { type: "image", source: media.source };
  }
  const block: SdkBlock = { type: "document", source: media.source };
  if (media.title) block.title = media.title;
  if (media.media_type) block.media_type = media.media_type;
  return block;
}

function messageToBlocks(message: Message): SdkBlock[] {
  const blocks = contentBlocks(message.content);
  if (blocks.length === 0) return [];
  const out: SdkBlock[] = [];
  for (const block of blocks) {
    const { text, media } = blockParts(block, message.role);
    if (text) out.push({ type: "text", text });
    for (const item of media) out.push(mediaBlock(item));
  }
  return out;
}

function hasRichContent(message: Message): boolean {
  return contentBlocks(message.content).some(
    (block) => block.type === "image" || block.type === "document",
  );
}

/**
 * A single-turn text request is passed through untouched, which is both the
 * common case and the shortest possible prompt. Anything with history is
 * wrapped in explicit transcript markers so Claude answers the final turn
 * rather than continuing the transcript.
 */
export function prepareTurn(request: MessagesRequest): PreparedTurn {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const allTools = request.tools ?? [];
  const choice = request.tool_choice;
  let tools = allTools.slice();
  if (choice?.type === "none") tools = [];
  else if (choice?.type === "tool") tools = allTools.filter((tool) => tool.name === choice.name);

  const system = systemText(request.system);
  let direct = messages.length === 1 && messages[0]?.role === "user" && !hasRichContent(messages[0]!)
    ? messageToBlocks(messages[0]!)
    : null;

  if (!direct) {
    const blocks: SdkBlock[] = [];
    const history = messages.slice(0, -1);
    const last = messages.at(-1);

    if (history.length > 0) {
      blocks.push({ type: "text", text: "<conversation_history>" });
      for (const message of history) {
        blocks.push({ type: "text", text: `<${message.role}>` });
        blocks.push(...messageToBlocks(message));
        blocks.push({ type: "text", text: `</${message.role}>` });
      }
      blocks.push({ type: "text", text: "</conversation_history>" });
    }

    if (last) {
      blocks.push({ type: "text", text: "<current_message>" });
      blocks.push(...messageToBlocks(last));
      blocks.push({ type: "text", text: "</current_message>" });
    }

    if (history.length > 0 || last?.role === "assistant") {
      blocks.push({
        type: "text",
        text:
          last?.role === "assistant"
            ? "Continue the assistant message above. Reply with the assistant's continuation only."
            : "Reply as the assistant to the current message only. Do not repeat the transcript.",
      });
    }

    direct = blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
  }

  const prompt = {
    type: "user" as const,
    message: { role: "user" as const, content: direct },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;

  return {
    system,
    prompt,
    tools,
    toolChoiceNote: toolChoiceNote(request),
  };
}

function toolChoiceNote(request: MessagesRequest): string | undefined {
  const choice = request.tool_choice;
  if (!choice) return undefined;
  if (choice.type === "any") {
    return "You must call one of the available tools in this turn.";
  }
  if (choice.type === "tool") {
    return "You must call the only available tool in this turn.";
  }
  return undefined;
}

/** First text block of the last user message, used for logging and keys. */
export function lastUserText(request: MessagesRequest): string {
  const last = [...(request.messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return contentBlocks(last.content)
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Stable conversation key: explicit metadata session, else a history digest. */
export function conversationKey(request: MessagesRequest, headerSession?: string): string {
  if (headerSession) return `header:${headerSession}`;
  const metadata = request.metadata?.user_id;
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { session_id?: unknown };
      if (typeof parsed.session_id === "string" && parsed.session_id) {
        return `session:${parsed.session_id}`;
      }
    } catch {
      return `user:${metadata}`;
    }
  }
  const first = contentBlocks(request.messages?.[0]?.content ?? "")
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .slice(0, 200);
  return `history:${first.length}:${first}`;
}
