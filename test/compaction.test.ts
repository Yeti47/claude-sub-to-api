import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionResponse,
  compactionStreamEnd,
  summarizeTurn,
  validateCompaction,
  wantsThresholdCompaction,
} from "../src/anthropic/compaction.js";
import { estimateInputTokens } from "../src/anthropic/count.js";
import { prepareTurn } from "../src/anthropic/translate.js";
import { historyFingerprint } from "../src/session/hashes.js";
import type { Message, MessagesRequest, MessagesResponse } from "../src/anthropic/types.js";

const history: Message[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
];

function request(extra: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: "claude-sonnet-5-5",
    messages: history,
    compaction: { type: "summarize" },
    ...extra,
  };
}

function reply(extra: Partial<MessagesResponse> = {}): MessagesResponse {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "The summary." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 30 },
    ...extra,
  };
}

test("accepts a plain compaction request and rejects what the Messages API rejects", () => {
  assert.equal(validateCompaction(request()), null);
  assert.equal(validateCompaction(request({ compaction: { type: "summarize", instructions: "Keep names." } })), null);

  assert.match(validateCompaction(request({ compaction: { type: "other" } })) ?? "", /summarize/);
  assert.match(
    validateCompaction(request({ compaction: { type: "summarize", instructions: "x".repeat(16_385) } })) ?? "",
    /16384/,
  );
  assert.match(
    validateCompaction(request({ context_management: { edits: [{ type: "compact_20260112" }] } })) ?? "",
    /context_management/,
  );
  assert.match(validateCompaction(request({ stop_sequences: ["END"] })) ?? "", /stop_sequences/);
  assert.match(validateCompaction(request({ tool_choice: { type: "any" } })) ?? "", /tool_choice/);
  assert.match(
    validateCompaction(request({ output_config: { format: { type: "json_schema" } } })) ?? "",
    /output_config\.format/,
  );
});

test("a compaction request needs every tool call answered and at most one block", () => {
  const call: Message = {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }],
  };
  const result: Message = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
  };
  assert.match(
    validateCompaction(request({ messages: [...history, { role: "user", content: "go" }, call] })) ?? "",
    /tool_result/,
  );
  assert.equal(
    validateCompaction(request({ messages: [...history, { role: "user", content: "go" }, call, result] })),
    null,
  );

  const block: Message = { role: "assistant", content: [{ type: "compaction", content: "Old." }] };
  assert.equal(validateCompaction(request({ messages: [block, ...history] })), null);
  assert.match(
    validateCompaction(request({ messages: [block, block, ...history] })) ?? "",
    /one compaction block/,
  );
});

test("the summarizing turn is the conversation followed by the instructions", () => {
  const turn = summarizeTurn(request());
  assert.equal(turn.compaction, undefined);
  assert.equal(turn.messages.length, 3);
  assert.deepEqual(turn.messages.slice(0, 2), history);
  assert.match(String(turn.messages[2]?.content), /summary/i);
  assert.equal(turn.messages[2]?.role, "user");

  const custom = summarizeTurn(request({ compaction: { type: "summarize", instructions: "Keep names." } }));
  assert.equal(custom.messages[2]?.content, "Keep names.");
  // Blank instructions fall back to the default prompt.
  const blank = summarizeTurn(request({ compaction: { type: "summarize", instructions: "  " } }));
  assert.equal(blank.messages[2]?.content, turn.messages[2]?.content);
});

test("a completed summary becomes a single compaction block", () => {
  const response = compactionResponse(
    reply({
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "The summary." },
      ],
    }),
  );
  assert.equal(response.stop_reason, "compaction");
  assert.equal(response.content.length, 1);
  const block = response.content[0] as { type: string; content: string; signature: string };
  assert.equal(block.type, "compaction");
  assert.equal(block.content, "The summary.");
  assert.ok(block.signature.length > 0);
  assert.deepEqual(response.usage, {
    input_tokens: 0,
    output_tokens: 0,
    iterations: [
      { type: "compaction", input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 30 },
    ],
  });

  const events = compactionStreamEnd(response).map((event) => event.type);
  assert.deepEqual(events, ["content_block_start", "content_block_stop", "message_delta", "message_stop"]);
});

test("no summary is returned when the turn was cut off, refused or called a tool", () => {
  const cut = compactionResponse(reply({ stop_reason: "max_tokens" }));
  assert.deepEqual(cut.content, []);
  assert.equal(cut.stop_reason, "max_tokens");

  const refused = compactionResponse(reply({ content: [], stop_reason: "refusal" }));
  assert.deepEqual(refused.content, []);
  assert.equal(refused.stop_reason, "refusal");

  const called = compactionResponse(
    reply({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "lookup", input: {} },
      ],
      stop_reason: "tool_use",
    }),
  );
  assert.deepEqual(called.content, []);
  assert.equal(called.stop_reason, "tool_use");
  assert.equal(called.usage.iterations?.length, 1);
  assert.deepEqual(
    compactionStreamEnd(called).map((event) => event.type),
    ["message_delta", "message_stop"],
  );
});

test("a compaction block sent back reaches Claude as the summary it holds", () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "compaction", content: "They agreed on X.", signature: "sig" }] },
    { role: "user", content: "next" },
  ];
  const prepared = prepareTurn({ model: "claude-sonnet-5-5", messages });
  const text = (prepared.prompt.message.content as Array<{ text?: string }>)
    .map((block) => block.text ?? "")
    .join("\n");
  assert.match(text, /<conversation_summary>[\s\S]*They agreed on X\.[\s\S]*<\/conversation_summary>/);
  assert.doesNotMatch(text, /"type":"compaction"/);
  assert.doesNotMatch(text, /sig/);
  assert.match(text, /<current_message>\nnext\n<\/current_message>/);

  // The block counts as its text, and fingerprints by it alone.
  assert.equal(estimateInputTokens({ model: "claude-sonnet-5-5", messages }), 6 + 4 + 2 + 4);
  const cached: Message[] = [
    {
      role: "assistant",
      content: [{ type: "compaction", content: "They agreed on X.", cache_control: { type: "ephemeral" } }],
    },
    messages[1]!,
  ];
  assert.equal(historyFingerprint(cached), historyFingerprint(messages));
});

test("recognizes a threshold compaction edit", () => {
  assert.equal(wantsThresholdCompaction(request({ context_management: { edits: [{ type: "compact_20260112" }] } })), true);
  assert.equal(wantsThresholdCompaction(request({ context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } })), false);
  assert.equal(wantsThresholdCompaction(request()), false);
});
