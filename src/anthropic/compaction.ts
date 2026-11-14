/**
 * On-demand compaction: a request with `compaction: { type: "summarize" }` is
 * answered with a summary of its conversation instead of a reply.
 *
 * The summary is written by an ordinary turn on the conversation's session,
 * so it reads the history from the prompt cache. The client then sends the
 * returned `compaction` block in place of the messages it summarizes.
 */
import { createHash } from "node:crypto";
import type { CompactionBlock, MessagesRequest, MessagesResponse } from "./types.js";
import { contentBlocks } from "./translate.js";

const MAX_INSTRUCTIONS = 16_384;

const DEFAULT_INSTRUCTIONS = [
  "Write a summary of the conversation so far. The summary will replace the conversation: the next turn continues from it alone, without access to the messages above.",
  "Include everything needed to carry on: the goal, the decisions made, the current state, open questions and next steps, and the exact names, values and code that later turns depend on.",
  "Do not call tools. Reply with the summary text only.",
].join(" ");

export function wantsCompaction(request: MessagesRequest): boolean {
  return request.compaction !== undefined && request.compaction !== null;
}

/** Whether the request asks the API to compact at a token threshold, which this server does not do. */
export function wantsThresholdCompaction(request: MessagesRequest): boolean {
  const edits = request.context_management?.edits;
  return Array.isArray(edits) && edits.some((edit) => edit?.type === "compact_20260112");
}

/** Why a compaction request cannot be served, in the cases the Messages API rejects too. */
export function validateCompaction(request: MessagesRequest): string | null {
  const compaction = request.compaction;
  if (!compaction || typeof compaction !== "object" || compaction.type !== "summarize")
    return 'compaction.type must be "summarize"';
  const instructions = compaction.instructions;
  if (instructions !== undefined && instructions !== null) {
    if (typeof instructions !== "string") return "compaction.instructions must be a string";
    if (instructions.length > MAX_INSTRUCTIONS)
      return `compaction.instructions must be at most ${MAX_INSTRUCTIONS} characters`;
  }
  if (request.context_management)
    return "compaction cannot be combined with context_management";
  if (request.stop_sequences?.length) return "compaction cannot be combined with stop_sequences";
  if (request.tool_choice?.type === "any" || request.tool_choice?.type === "tool")
    return `compaction cannot be combined with tool_choice ${request.tool_choice.type}`;
  if (request.output_config?.format !== undefined)
    return "compaction cannot be combined with output_config.format";

  let blocks = 0;
  let unanswered = new Set<string>();
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "assistant" && request.messages[index - 1]?.role !== "assistant")
      unanswered = new Set();
    for (const block of contentBlocks(message.content)) {
      if (block.type === "compaction") blocks += 1;
      else if (block.type === "tool_use") unanswered.add(block.id);
      else if (block.type === "tool_result") unanswered.delete(block.tool_use_id);
    }
  }
  if (blocks > 1) return "messages must contain at most one compaction block";
  if (unanswered.size > 0)
    return "the last assistant turn ends in a tool call with no result; send its tool_result before compacting";
  return null;
}

/** The turn that writes the summary: the conversation, then the request for it. */
export function summarizeTurn(request: MessagesRequest): MessagesRequest {
  const instructions = request.compaction?.instructions?.trim() || DEFAULT_INSTRUCTIONS;
  return {
    ...request,
    compaction: undefined,
    messages: [...request.messages, { role: "user", content: instructions }],
  };
}

/**
 * Turn the summarizing turn's reply into the compaction response. A summary
 * exists only when the turn ended normally with text and no tool call;
 * otherwise the content is empty and `stop_reason` says how the turn ended.
 */
export function compactionResponse(reply: MessagesResponse): MessagesResponse {
  const toolCall = reply.content.some((block) => block.type === "tool_use");
  const summary = reply.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  const complete = !toolCall && reply.stop_reason === "end_turn" && summary.length > 0;
  const block: CompactionBlock = {
    type: "compaction",
    content: summary,
    // The Messages API signs the block. Here it is a plain checksum, never
    // verified: the client owns its history either way.
    signature: createHash("sha256").update(summary).digest("base64"),
  };
  return {
    ...reply,
    content: complete ? [block] : [],
    stop_reason: complete ? "compaction" : toolCall ? "tool_use" : reply.stop_reason,
    // No reply was generated; the summarization call is reported on its own.
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [{ ...reply.usage, type: "compaction" }],
    },
  };
}

/** The opening event of a streamed compaction response. */
export function compactionStreamStart(id: string, model: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

/** The rest of a streamed compaction response. The block arrives whole, without deltas. */
export function compactionStreamEnd(response: MessagesResponse): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  response.content.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: response.stop_reason, stop_sequence: null },
    usage: response.usage,
  });
  events.push({ type: "message_stop" });
  return events;
}
