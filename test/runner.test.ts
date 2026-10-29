import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeRunner, ApiError } from "../src/claude/runner.js";
import { PendingToolRegistry } from "../src/claude/pending-tools.js";
import { createLogger } from "../src/logger.js";
import type { Config } from "../src/config.js";

const config: Config = {
  listenAddr: ":0",
  proxyApiKey: "secret",
  claudeConfigDir: "/tmp/claude-test",
  claudeConfigDirExplicit: true,
  cwd: process.cwd(),
  logLevel: "error",
  maxConcurrency: 1,
  requestTimeoutMs: 60_000,
  defaultMaxTokens: 100,
  parkedTurnTtlMs: 0,
};

function fakeQuery(messages: unknown[], capture?: (options: Record<string, unknown>) => void) {
  return (params: { options: Record<string, unknown> }) => {
    capture?.(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
      close() {},
    };
  };
}

const textEvents = [
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_9", usage: { input_tokens: 4 } } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } },
];

test("runs a text turn and configures a constrained SDK session", async () => {
  let options: Record<string, unknown> | undefined;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery(textEvents, (value) => (options = value)) as never,
  );
  const { response: result } = await runner.run({
    request: {
      model: "claude-sonnet-5-5",
      max_tokens: 16,
      system: "Be brief.",
      messages: [{ role: "user", content: "hi" }],
    },
    signal: new AbortController().signal,
    requestId: "r1",
    stream: false,
  });

  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.stop_reason, "end_turn");
  const systemPrompt = options?.systemPrompt as {
    type?: string;
    preset?: string;
    excludeDynamicSections?: boolean;
    append?: string;
  };
  assert.equal(systemPrompt.type, "preset");
  assert.equal(systemPrompt.preset, "claude_code");
  assert.equal(systemPrompt.excludeDynamicSections, true);
  assert.match(systemPrompt.append ?? "", /claude-sub-to-api/);
  assert.match(systemPrompt.append ?? "", /Be brief\./);
  assert.deepEqual(options?.tools, []);
  assert.equal(options?.permissionMode, "dontAsk");
  assert.equal(options?.maxTurns, 1);
  assert.equal(options?.persistSession, true);
  assert.deepEqual(options?.settingSources, []);
  assert.equal((options?.env as Record<string, string>).CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1024");
  assert.equal((options?.env as Record<string, string>).CLAUDE_CONFIG_DIR, "/tmp/claude-test");
});

test("parks a tool_use turn and resumes it with the client result", async () => {
  let pending: PendingToolRegistry | undefined;
  const toolEvents = [
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_10", usage: { input_tokens: 4 } } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "mcp__claude_sub_to_api__lookup" },
      },
    },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } } },
    { type: "stream_event", event: { type: "message_stop" } },
  ];
  const continuation = [
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_11", usage: { input_tokens: 6 } } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn", usage: { input_tokens: 6, output_tokens: 1 } },
  ];

  const queryFn = () => ({
    async *[Symbol.asyncIterator]() {
      let call: Promise<unknown> | undefined;
      for (const event of toolEvents) {
        if (
          event.type === "stream_event" &&
          (event.event as { type?: string }).type === "message_stop"
        ) {
          // Simulate the CLI invoking the MCP handler after message_stop.
          setTimeout(() => {
            call = pending!.register("lookup", { q: "x" });
          }, 0);
        }
        yield event;
      }
      await call;
      for (const event of continuation) yield event;
    },
    close() {},
  });

  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    queryFn as never,
    () => (pending = new PendingToolRegistry()),
  );
  const streamed: string[] = [];
  const first = await runner.run({
    request: {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "find x" }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    },
    signal: new AbortController().signal,
    requestId: "r2",
    stream: true,
    onEvent: (event) => streamed.push(String(event.type)),
  });

  assert.ok(first.parked);
  assert.equal(first.response.stop_reason, "tool_use");
  assert.deepEqual(first.response.content[0], {
    type: "tool_use",
    id: "t1",
    name: "lookup",
    input: { q: "x" },
  });
  assert.ok(streamed.includes("content_block_start"));

  const second = await first.parked!.resume({
    request: {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "find x" }],
    },
    signal: new AbortController().signal,
    requestId: "r3",
    stream: false,
    toolResults: new Map([
      ["t1", { type: "tool_result", tool_use_id: "t1", content: "42" }],
    ]),
    steeringText: "",
  });
  assert.equal(second.parked, undefined);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
});

test("turns an SDK rate-limit result into a 429", async () => {
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery([
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["rate_limit"], stop_reason: null, usage: {} },
    ]) as never,
  );
  await assert.rejects(
    () =>
      runner.run({
        request: { model: "m", messages: [{ role: "user", content: "hi" }] },
        signal: new AbortController().signal,
        requestId: "r3",
        stream: false,
      }),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
});
