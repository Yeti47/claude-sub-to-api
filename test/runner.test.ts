import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeRunner, ApiError, ClientAbort } from "../src/claude/runner.js";
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
  sessionIdleMs: 0,
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
    conversationKey: "test",
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
  assert.equal(options?.maxTurns, undefined);
  assert.equal(options?.persistSession, true);
  assert.deepEqual(options?.settingSources, []);
  assert.equal(options?.verbatimPrompts, true);
  assert.deepEqual(options?.settings, { disableAllHooks: true });
  const env = options?.env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1024");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-test");
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal(env.DISABLE_AUTO_COMPACT, "1");
  assert.equal(env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY, "0");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  assert.equal(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, "1");
  assert.equal(env.MAX_MCP_OUTPUT_TOKENS, "200000");
  assert.equal(env.CLAUDE_CODE_POLISHED_DEWDROP, "drop");
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(env.MCP_TOOL_TIMEOUT, undefined);
  assert.deepEqual(options?.thinking, { type: "disabled" });
});

function persistentQuery(received: string[], counter: { calls: number }) {
  return (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    counter.calls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        let turn = 0;
        for await (const raw of params.prompt) {
          turn += 1;
          const message = raw as { message?: { content?: unknown } };
          const content = message.message?.content;
          received.push(
            Array.isArray(content)
              ? content
                  .map((block) => (block as { text?: string }).text ?? "")
                  .join("")
              : String(content ?? ""),
          );
          const id = `msg_${counter.calls}_${turn}`;
          yield { type: "stream_event", event: { type: "message_start", message: { id, session_id: "session-1", usage: { input_tokens: 1 } } } };
          yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply-${turn}` } } };
          yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
          yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };
          yield { type: "stream_event", event: { type: "message_stop" } };
          yield { type: "result", subtype: "success", is_error: false, result: `reply-${turn}`, stop_reason: "end_turn", session_id: "session-1", usage: { input_tokens: 1, output_tokens: 1 } };
        }
      },
      close() {},
    };
  };
}

test("reuses one live process for consecutive turns", async () => {
  const received: string[] = [];
  const counter = { calls: 0 };
  let planned = 0;
  let recorded = 0;
  const runner = new ClaudeRunner(
    { ...config, sessionIdleMs: 60_000 },
    createLogger("error"),
    persistentQuery(received, counter) as never,
  );

  const first = await runner.run({
    conversationKey: "conv",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "one" }] },
    signal: new AbortController().signal,
    requestId: "live-1",
    stream: false,
  });
  const second = await runner.run({
    conversationKey: "conv",
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply-1" },
        { role: "user", content: "two" },
      ],
    },
    signal: new AbortController().signal,
    requestId: "live-2",
    stream: false,
    plan: () => {
      planned += 1;
      return { sessionId: "session-1", fromIndex: 2 };
    },
    record: () => {
      recorded += 1;
    },
  });

  assert.equal(counter.calls, 1);
  assert.equal(planned, 1);
  assert.equal(recorded, 1);
  assert.deepEqual(received, ["one", "two"]);
  assert.equal(first.sessionId, "session-1");
  assert.equal(second.sessionId, "session-1");
  assert.equal(second.reused, true);
  assert.deepEqual(second.response.content, [{ type: "text", text: "reply-2" }]);
  runner.closeAll();
});

test("closes an idle process and resumes its session on the next turn", async () => {
  const received: string[] = [];
  const counter = { calls: 0 };
  let secondOptions: Record<string, unknown> | undefined;
  const queryFn = persistentQuery(received, counter);
  const runner = new ClaudeRunner(
    { ...config, sessionIdleMs: 10 },
    createLogger("error"),
    ((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      if (counter.calls === 1) secondOptions = params.options;
      return queryFn(params);
    }) as never,
  );

  await runner.run({
    conversationKey: "conv",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "one" }] },
    signal: new AbortController().signal,
    requestId: "idle-1",
    stream: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await runner.run({
    conversationKey: "conv",
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply-1" },
        { role: "user", content: "two" },
      ],
    },
    signal: new AbortController().signal,
    requestId: "idle-2",
    stream: false,
    resumeFromIndex: 2,
    resumeSessionId: "session-1",
  });

  assert.equal(counter.calls, 2);
  assert.equal(secondOptions?.resume, "session-1");
  assert.deepEqual(received, ["one", "two"]);
  runner.closeAll();
});

test("evicts an idle process when MAX_CONCURRENCY is reached", async () => {
  const received: string[] = [];
  const counter = { calls: 0 };
  const runner = new ClaudeRunner(
    { ...config, maxConcurrency: 1, sessionIdleMs: 60_000 },
    createLogger("error"),
    persistentQuery(received, counter) as never,
  );

  await runner.run({
    conversationKey: "a",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "one" }] },
    signal: new AbortController().signal,
    requestId: "cap-1",
    stream: false,
  });
  await runner.run({
    conversationKey: "b",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "two" }] },
    signal: new AbortController().signal,
    requestId: "cap-2",
    stream: false,
  });

  assert.equal(counter.calls, 2);
  assert.deepEqual(received, ["one", "two"]);
  runner.closeAll();
});

test("yields an idle process's slot to a queued conversation", async () => {
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let calls = 0;

  const queryFn = (params: { prompt: AsyncIterable<unknown> }) => {
    const call = ++calls;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of params.prompt) {
          if (call === 1) {
            resolveStarted();
            await gate;
          }
          yield { type: "stream_event", event: { type: "message_start", message: { id: `msg_${call}`, session_id: `session-${call}`, usage: { input_tokens: 1 } } } };
          yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply-${call}` } } };
          yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
          yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };
          yield { type: "stream_event", event: { type: "message_stop" } };
          yield { type: "result", subtype: "success", is_error: false, result: `reply-${call}`, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
          break;
        }
      },
      close() {},
    };
  };

  const runner = new ClaudeRunner(
    { ...config, maxConcurrency: 1, sessionIdleMs: 60_000 },
    createLogger("error"),
    queryFn as never,
  );

  const first = runner.run({
    conversationKey: "a",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "a" }] },
    signal: new AbortController().signal,
    requestId: "yield-1",
    stream: false,
  });
  await started;
  const second = runner.run({
    conversationKey: "b",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "b" }] },
    signal: new AbortController().signal,
    requestId: "yield-2",
    stream: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () =>
      runner.run({
        conversationKey: "a",
        request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "canceled" }] },
        signal: aborted.signal,
        requestId: "yield-3",
        stream: false,
      }),
    (error: unknown) => error instanceof ClientAbort,
  );
  resolveGate();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.deepEqual(a.response.content, [{ type: "text", text: "reply-1" }]);
  assert.deepEqual(b.response.content, [{ type: "text", text: "reply-2" }]);
  runner.closeAll();
});

test("uses summarized adaptive thinking when requested", async () => {
  let options: Record<string, unknown> | undefined;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery(textEvents, (value) => (options = value)) as never,
  );
  await runner.run({
    request: {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    },
    conversationKey: "test",
    signal: new AbortController().signal,
    requestId: "r-thinking",
    stream: false,
  });
  assert.deepEqual(options?.thinking, { type: "adaptive", display: "summarized" });
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

  const queryFn = (params: { options: Record<string, unknown> }) => {
    const hooks = params.options.hooks as
      | { PreToolUse?: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }> }
      | undefined;
    void hooks?.PreToolUse?.[0]?.hooks[0]?.({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__claude_sub_to_api__lookup",
      tool_use_id: "t1",
    });
    return {
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
    };
  };

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
    conversationKey: "test",
    signal: new AbortController().signal,
    requestId: "r2",
    stream: true,
    onEvent: (event) => streamed.push(String(event.type)),
  });

  assert.ok(first.parked);
  assert.equal(pending!.calls()[0]?.toolUseId, "t1");
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
    conversationKey: "test",
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

test("maps upstream HTTP statuses to Anthropic error statuses", async () => {
  const cases: Array<[number, number, string]> = [
    [529, 529, "overloaded_error"],
    [401, 401, "authentication_error"],
    [404, 404, "not_found_error"],
    [400, 400, "invalid_request_error"],
  ];
  for (const [upstream, expected, type] of cases) {
    const runner = new ClaudeRunner(
      config,
      createLogger("error"),
      fakeQuery([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          api_error_status: upstream,
          result: `upstream ${upstream}`,
          stop_reason: null,
          usage: {},
        },
      ]) as never,
    );
    await assert.rejects(
      () =>
        runner.run({
          request: { model: "m", messages: [{ role: "user", content: "hi" }] },
          conversationKey: "test",
    signal: new AbortController().signal,
          requestId: `r-${upstream}`,
          stream: false,
        }),
      (error: unknown) =>
        error instanceof ApiError && error.status === expected && error.type === type,
    );
  }
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
        conversationKey: "test",
    signal: new AbortController().signal,
        requestId: "r3",
        stream: false,
      }),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
});
