import test from "node:test";
import assert from "node:assert/strict";
import { MessageAssembler } from "../src/claude/assembler.js";
import type { ToolBridge } from "../src/anthropic/tools.js";

const bridge: ToolBridge = {
  mcpServers: {},
  toClientName: new Map([["mcp__proxy__search", "search"]]),
  exposedNames: ["mcp__proxy__search"],
};

test("assembles a text message from stream events", () => {
  const events: Record<string, unknown>[] = [];
  const assembler = new MessageAssembler("claude-sonnet-5-5", undefined, (event) =>
    events.push(event),
  );

  assembler.handle({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: "msg_1", model: "internal-model", usage: { input_tokens: 12 } },
    },
  });
  assembler.handle({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  assembler.handle({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  });
  assembler.handle({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  assembler.handle({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  });
  assembler.handle({ type: "stream_event", event: { type: "message_stop" } });

  const response = assembler.response();
  assert.equal(response.id, "msg_1");
  assert.equal(response.model, "claude-sonnet-5-5");
  assert.equal(response.stop_reason, "end_turn");
  assert.deepEqual(response.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(response.content.length, 1);
  assert.deepEqual(response.content[0], { type: "text", text: "Hi" });
  assert.equal(events[0]?.type, "message_start");
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("maps MCP tool names and parses tool input", () => {
  const assembler = new MessageAssembler("claude-sonnet-5-5", bridge);
  assembler.handle({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5 } } },
  });
  assembler.handle({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "mcp__proxy__search" },
    },
  });
  assembler.handle({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
    },
  });
  assembler.handle({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  assembler.handle({
    type: "stream_event",
    event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
  });

  const response = assembler.response();
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content[0], {
    type: "tool_use",
    id: "toolu_1",
    name: "search",
    input: { query: "x" },
  });
});

test("falls back to complete assistant messages without partial events", () => {
  const assembler = new MessageAssembler("claude-opus-5-5", bridge);
  assembler.handle({
    type: "assistant",
    message: {
      id: "msg_3",
      model: "internal",
      stop_reason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 2 },
      content: [
        { type: "text", text: "one moment" },
        { type: "tool_use", id: "t1", name: "mcp__proxy__search", input: { q: 1 } },
      ],
    },
  });
  const response = assembler.response();
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content[1], {
    type: "tool_use",
    id: "t1",
    name: "search",
    input: { q: 1 },
  });
});
