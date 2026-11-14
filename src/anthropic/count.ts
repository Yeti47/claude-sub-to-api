/**
 * Token estimate for `POST /v1/messages/count_tokens`.
 *
 * The subscription has no token-counting endpoint, so this is an estimate
 * from the request's size, not Claude's tokenizer. Clients use the number to
 * decide when to compact their context, so it errs on the high side.
 */
import type { ContentBlock, MessagesRequest } from "./types.js";
import { contentBlocks, systemText } from "./translate.js";

/** English prose is near 4 characters per token; code and JSON are denser. */
const CHARS_PER_TOKEN = 3;
/** An image costs about (width x height) / 750 tokens; this is a large one. */
const IMAGE_TOKENS = 1600;
/** A PDF costs tokens per page; the page count is not known here. */
const DOCUMENT_TOKENS = 3000;
/** Role markers and block framing. */
const MESSAGE_OVERHEAD = 4;

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return textTokens(block.text);
    case "thinking":
      return textTokens(block.thinking);
    case "redacted_thinking":
      return textTokens(block.data);
    case "image":
      return IMAGE_TOKENS;
    case "document":
      return DOCUMENT_TOKENS;
    case "tool_use":
      return textTokens(block.name) + textTokens(JSON.stringify(block.input ?? {}));
    case "tool_result": {
      let total = 0;
      for (const part of contentBlocks(block.content ?? "")) total += blockTokens(part);
      return total;
    }
    default:
      return textTokens(JSON.stringify(block));
  }
}

export function estimateInputTokens(request: MessagesRequest): number {
  let total = textTokens(systemText(request.system) ?? "");
  for (const message of request.messages) {
    total += MESSAGE_OVERHEAD;
    for (const block of contentBlocks(message.content)) total += blockTokens(block);
  }
  for (const tool of request.tools ?? []) {
    total +=
      textTokens(tool.name) +
      textTokens(tool.description ?? "") +
      textTokens(JSON.stringify(tool.input_schema ?? {}));
  }
  return Math.max(1, total);
}
