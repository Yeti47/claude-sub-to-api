import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeRunner, ApiError, ClientAbort, type RunResult } from "../src/claude/runner.js";
import { errorFor } from "../src/claude/errors.js";
import { PendingToolRegistry } from "../src/claude/pending-tools.js";
import { createLogger } from "../src/logger.js";
import type { Config } from "../src/config.js";
import { SessionStore, type ResumeDecision } from "../src/session/store.js";

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
  parkedEvictableAfterMs: 0,
  queueTimeoutMs: 0,
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
      return { kind: "resume", sessionId: "session-1", fromIndex: 2 };
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

test("forks at a checkpoint and resumes the forked session", async () => {
  let options: Record<string, unknown> | undefined;
  let forkArgs: unknown[] | undefined;
  let recorded: { result: RunResult; decision?: ResumeDecision } | undefined;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    ((params: { options: Record<string, unknown> }) => {
      options = params.options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "stream_event", event: { type: "message_start", message: { id: "msg_1", session_id: "fork-1", usage: { input_tokens: 1 } } } };
          yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
          yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } };
          yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
          yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };
          yield { type: "stream_event", event: { type: "message_stop" } };
          yield {
            type: "assistant",
            uuid: "leaf-9",
            parent_tool_use_id: null,
            session_id: "fork-1",
            message: { id: "msg_1", content: [{ type: "text", text: "ok" }], usage: {} },
          };
          yield { type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
        close() {},
      };
    }) as never,
    undefined,
    ((...args: unknown[]) => {
      forkArgs = args;
      return Promise.resolve({ sessionId: "fork-1" });
    }) as never,
  );

  const result = await runner.run({
    conversationKey: "conv",
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "edited" },
      ],
    },
    signal: new AbortController().signal,
    requestId: "fork-1",
    stream: false,
    plan: () => ({
      kind: "fork",
      sessionId: "session-1",
      upToMessageId: "leaf-1",
      fromIndex: 2,
    }),
    record: (value, decision) => {
      recorded = { result: value, decision };
    },
  });

  assert.deepEqual(forkArgs, ["session-1", { upToMessageId: "leaf-1", dir: config.cwd }]);
  assert.equal(options?.resume, "fork-1");
  assert.equal(result.forked, true);
  assert.equal(result.resumed, true);
  assert.equal(result.sessionId, "fork-1");
  assert.equal(result.leafUuid, "leaf-9");
  assert.equal(recorded?.decision?.kind, "fork");
  assert.equal(recorded?.result.leafUuid, "leaf-9");
  runner.closeAll();
});

test("replays history in a fresh session when forking fails", async () => {
  let options: Record<string, unknown> | undefined;
  let decision: ResumeDecision | undefined;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery(textEvents, (value) => (options = value)) as never,
    undefined,
    (() => Promise.reject(new Error("transcript missing"))) as never,
  );

  const result = await runner.run({
    conversationKey: "conv",
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "edited" },
      ],
    },
    signal: new AbortController().signal,
    requestId: "fork-fail",
    stream: false,
    plan: () => ({
      kind: "fork",
      sessionId: "session-1",
      upToMessageId: "leaf-1",
      fromIndex: 2,
    }),
    record: (_result, value) => {
      decision = value;
    },
  });

  assert.equal(options?.resume, undefined);
  assert.equal(result.forked, undefined);
  assert.equal(result.resumed, undefined);
  assert.equal(decision?.kind, "fresh");
  runner.closeAll();
});

test("does not fork when the plan resumes", async () => {
  let forks = 0;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery(textEvents) as never,
    undefined,
    (() => {
      forks += 1;
      return Promise.resolve({ sessionId: "fork-1" });
    }) as never,
  );

  await runner.run({
    conversationKey: "conv",
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "two" },
      ],
    },
    signal: new AbortController().signal,
    requestId: "resume-only",
    stream: false,
    plan: () => ({ kind: "resume", sessionId: "session-1", fromIndex: 2 }),
  });

  assert.equal(forks, 0);
  runner.closeAll();
});

test("replays history when a resumed session no longer exists", async () => {
  let calls = 0;
  let secondOptions: Record<string, unknown> | undefined;
  const queryFn = (params: { options: Record<string, unknown> }) => {
    const call = ++calls;
    if (call === 2) secondOptions = params.options;
    return {
      async *[Symbol.asyncIterator]() {
        if (call === 1) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["No conversation found with session ID: session-1"],
            stop_reason: null,
            usage: {},
          };
          return;
        }
        for (const event of textEvents) yield event;
      },
      close() {},
    };
  };
  const runner = new ClaudeRunner(config, createLogger("error"), queryFn as never);

  const result = await runner.run({
    conversationKey: "conv",
    request: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] },
    signal: new AbortController().signal,
    requestId: "missing-session",
    stream: false,
    plan: () => ({ kind: "resume", sessionId: "session-1", fromIndex: 0 }),
  });

  assert.equal(calls, 2);
  assert.equal(secondOptions?.resume, undefined);
  assert.equal(result.response.content[0]?.type, "text");
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

const lookupTool = {
  name: "lookup",
  input_schema: { type: "object", properties: { q: { type: "string" } } },
};

function toolResultMessage(ids: string[], text?: string) {
  return {
    role: "user" as const,
    content: [
      ...ids.map((id) => ({ type: "tool_result" as const, tool_use_id: id, content: "42" })),
      ...(text ? [{ type: "text" as const, text }] : []),
    ],
  };
}

/**
 * A process whose first message calls `lookup` once per id and then blocks,
 * like the CLI does, until every handler has its result.
 */
function toolQuery(
  ids: string[],
  state: { calls: number; pending?: PendingToolRegistry; results: unknown[] },
  thenIds: string[] = [],
) {
  return (params: { options: Record<string, unknown> }) => {
    state.calls += 1;
    const hooks = params.options.hooks as
      | { PreToolUse?: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }> }
      | undefined;
    async function* round(roundIds: string[], messageId: string) {
      for (const id of roundIds) {
        void hooks?.PreToolUse?.[0]?.hooks[0]?.({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__claude_sub_to_api__lookup",
          tool_use_id: id,
        });
      }
      yield { type: "stream_event", event: { type: "message_start", message: { id: messageId, usage: { input_tokens: 4 } } } };
      for (const [index, id] of roundIds.entries()) {
        yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__claude_sub_to_api__lookup" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } } };
        yield { type: "stream_event", event: { type: "content_block_stop", index } };
      }
      yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } } };
      // Simulate the CLI invoking the MCP handlers after message_stop.
      const calls: Array<Promise<unknown>> = [];
      setTimeout(() => {
        for (const _ of roundIds) {
          const call = state.pending!.register("lookup", { q: "x" });
          call.catch(() => {});
          calls.push(call);
        }
      }, 0);
      yield { type: "stream_event", event: { type: "message_stop" } };
      state.results.push(...(await Promise.all(calls)));
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield* round(ids, "msg_10");
        if (thenIds.length > 0) yield* round(thenIds, "msg_12");
        yield { type: "stream_event", event: { type: "message_start", message: { id: "msg_11", usage: { input_tokens: 6 } } } };
        yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
        yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } };
        yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
        yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } };
        yield { type: "stream_event", event: { type: "message_stop" } };
        yield { type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn", usage: { input_tokens: 6, output_tokens: 1 } };
      },
      close() {},
    };
  };
}

function toolRunner(ids: string[], overrides: Partial<Config> = {}, thenIds: string[] = []) {
  const state: { calls: number; pending?: PendingToolRegistry; results: unknown[] } = {
    calls: 0,
    results: [],
  };
  const runner = new ClaudeRunner(
    { ...config, ...overrides },
    createLogger("error"),
    toolQuery(ids, state, thenIds) as never,
    () => (state.pending = new PendingToolRegistry()),
  );
  const first = { role: "user" as const, content: "find x" };
  const call = {
    role: "assistant" as const,
    content: ids.map((id) => ({ type: "tool_use" as const, id, name: "lookup", input: { q: "x" } })),
  };
  const run = (
    requestId: string,
    answered: string[] | undefined,
    extra: Partial<Parameters<ClaudeRunner["run"]>[0]> = {},
  ) =>
    runner.run({
      request: {
        model: "claude-sonnet-5-5",
        messages: answered ? [first, call, toolResultMessage(answered)] : [first],
        tools: [lookupTool],
      },
      conversationKey: "test",
      signal: new AbortController().signal,
      requestId,
      stream: false,
      ...extra,
    });
  return { runner, state, run };
}

test("parks a tool_use turn and continues it with the client's tool results", async () => {
  const { runner, state, run } = toolRunner(["t1"]);
  const streamed: string[] = [];
  const records: Array<[RunResult, ResumeDecision | undefined]> = [];
  const record = (result: RunResult, decision?: ResumeDecision) => {
    records.push([result, decision]);
  };
  const first = await run("r2", undefined, {
    stream: true,
    onEvent: (event) => streamed.push(String(event.type)),
    record,
  });

  assert.equal(first.parked, true);
  assert.equal(records[0]?.[0].parked, true);
  assert.equal(records[0]?.[0].leafUuid, undefined);
  assert.equal(first.response.stop_reason, "tool_use");
  assert.deepEqual(first.response.content[0], {
    type: "tool_use",
    id: "t1",
    name: "lookup",
    input: { q: "x" },
  });
  assert.deepEqual(streamed.slice(-2), ["message_delta", "message_stop"]);

  let planned = 0;
  const second = await run("r3", ["t1"], {
    record,
    plan: () => {
      planned += 1;
      return { kind: "fresh" };
    },
  });
  assert.equal(state.calls, 1);
  assert.equal(planned, 0);
  assert.equal(second.parked, undefined);
  assert.equal(second.reused, true);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
  assert.deepEqual(state.results, [{ content: [{ type: "text", text: "42" }], isError: false }]);
  // A continuation is recorded without a plan.
  assert.equal(records[1]?.[1], undefined);
  runner.closeAll();
});

test("tool results sent the moment the message ends find the parked turn", async () => {
  const { runner, state, run } = toolRunner(["t1"], { maxConcurrency: 2 });
  let followUp: Promise<RunResult> | undefined;
  await run("r1", undefined, {
    stream: true,
    onEvent: (event) => {
      // Another conversation key, so only the parked state can route it.
      if (event.type === "message_stop") {
        followUp = run("r2", ["t1"], { conversationKey: "other" });
      }
    },
  });

  const second = await followUp!;
  assert.equal(state.calls, 1);
  assert.equal(second.reused, true);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
  runner.closeAll();
});

test("tool results reach a parked turn while their own key waits for its slot", async () => {
  const { runner, state, run } = toolRunner(["t1"], { maxConcurrency: 1 });
  await run("r1", undefined);

  // An unrelated request holds its key's lock while it waits for the slot.
  const queued = run("r2", undefined, { conversationKey: "other" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.calls, 1);

  const second = await run("r3", ["t1"], { conversationKey: "other" });
  assert.equal(second.reused, true);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
  // The finished turn yields its slot to the waiting request.
  assert.equal((await queued).parked, true);
  assert.equal(state.calls, 2);
  runner.closeAll();
});

test("a turn continued under another key belongs to that key when it parks again", async () => {
  const { runner, state, run } = toolRunner(["t1"], { maxConcurrency: 1 }, ["t2"]);
  await run("r1", undefined);
  const second = await run("r2", ["t1"], { conversationKey: "other" });
  assert.equal(second.parked, true);
  const rejected = state.pending!.calls()[0]!.result.then(
    () => false,
    () => true,
  );

  // A new message under the continuing key supersedes the parked turn.
  await run("r3", undefined, { conversationKey: "other" });
  assert.equal(await rejected, true);
  assert.equal(state.calls, 2);
  runner.closeAll();
});

test("an incomplete set of tool results leaves the turn parked", async () => {
  const { runner, state, run } = toolRunner(["t1", "t2"]);
  await run("r1", undefined);

  await assert.rejects(
    () => run("r2", ["t1"]),
    (error: unknown) =>
      error instanceof ApiError && error.status === 400 && /missing tool_result for t2/.test(error.message),
  );
  const second = await run("r3", ["t1", "t2"]);
  assert.equal(state.calls, 1);
  assert.equal(state.results.length, 2);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
  runner.closeAll();
});

test("a parked turn is closed when its results do not arrive in time", async () => {
  const { runner, state, run } = toolRunner(["t1"], { parkedTurnTtlMs: 20 });
  await run("r1", undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The process is gone and its slot is free: the results start a new turn.
  const second = await run("r2", ["t1"]);
  assert.equal(state.calls, 2);
  assert.equal(second.reused, undefined);
  runner.closeAll();
});

test("a request that moved past a tool call closes the turn parked on it", async () => {
  const { runner, state, run } = toolRunner(["t1"]);
  await run("r1", undefined);
  const rejected = state.pending!.calls()[0]!.result.then(
    () => false,
    () => true,
  );
  // The user interrupted the tool and wrote a new message instead.
  await run("r2", undefined, {
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "find x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: "never mind" },
      ],
      tools: [lookupTool],
    },
  });
  assert.equal(await rejected, true);
  assert.equal(state.calls, 2);
  runner.closeAll();
});

test("an unrelated request with the same key leaves a parked turn alone", async () => {
  const { runner, state, run } = toolRunner(["t1"], { maxConcurrency: 2 });
  await run("r1", undefined);
  // A second agent of the same client session starts its own turn.
  await run("r2", undefined);
  const second = await run("r3", ["t1"]);
  assert.equal(second.reused, true);
  assert.deepEqual(second.response.content[0], { type: "text", text: "done" });
  assert.equal(state.calls, 2);
  runner.closeAll();
});

test("a waiting request evicts a parked turn once its grace period is over", async () => {
  const { runner, state, run } = toolRunner(["t1"], { parkedEvictableAfterMs: 40 });
  await run("r1", undefined);
  const parked = state.pending!;
  const started = Date.now();
  await run("r2", undefined, { conversationKey: "other" });
  assert.ok(Date.now() - started >= 30);
  assert.equal(state.calls, 2);
  assert.deepEqual(parked.pendingIds(), []);
  runner.closeAll();
});

test("an idle process is evicted before a parked turn", async () => {
  const received: string[] = [];
  const counter = { calls: 0 };
  const tools = { calls: 0, results: [] as unknown[], pending: undefined as PendingToolRegistry | undefined };
  const toolProcess = toolQuery(["t1"], tools);
  const textProcess = persistentQuery(received, counter);
  const runner = new ClaudeRunner(
    { ...config, maxConcurrency: 2, sessionIdleMs: 60_000, parkedEvictableAfterMs: 1 },
    createLogger("error"),
    ((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      params.options.mcpServers ? toolProcess(params) : textProcess(params)) as never,
    () => (tools.pending = new PendingToolRegistry()),
  );
  const run = (key: string, request: Record<string, unknown>) =>
    runner.run({
      conversationKey: key,
      request: { model: "claude-sonnet-5-5", ...request } as never,
      signal: new AbortController().signal,
      requestId: key,
      stream: false,
    });

  await run("tools", { messages: [{ role: "user", content: "find x" }], tools: [lookupTool] });
  const parked = tools.pending!;
  await run("idle", { messages: [{ role: "user", content: "one" }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await run("third", { messages: [{ role: "user", content: "two" }] });

  assert.deepEqual(parked.pendingIds(), ["t1"]);
  assert.equal(counter.calls, 2);
  runner.closeAll();
});

test("a request that finds no free process in time gets a 529 with retry-after", async () => {
  const { runner, run } = toolRunner(["t1"], { queueTimeoutMs: 30 });
  await run("r1", undefined);
  await assert.rejects(
    () => run("r2", undefined, { conversationKey: "other" }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 529 &&
      error.type === "overloaded_error" &&
      error.retryAfter === 10,
  );
  runner.closeAll();
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

test("a request with another configuration leaves the conversation's process alive", async () => {
  const received: string[] = [];
  const counter = { calls: 0 };
  const runner = new ClaudeRunner(
    { ...config, maxConcurrency: 2, sessionIdleMs: 60_000 },
    createLogger("error"),
    persistentQuery(received, counter) as never,
  );
  const run = (requestId: string, request: Record<string, unknown>, plan?: () => ResumeDecision) =>
    runner.run({
      conversationKey: "conv",
      request: { model: "claude-sonnet-5-5", ...request } as never,
      signal: new AbortController().signal,
      requestId,
      stream: false,
      plan,
    });

  await run("main-1", { messages: [{ role: "user", content: "one" }] });
  // Same conversation key, different system prompt: a title request.
  await run("title", { system: "Write a title.", messages: [{ role: "user", content: "one" }] });
  const second = await run(
    "main-2",
    {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "reply-1" },
        { role: "user", content: "two" },
      ],
    },
    () => ({ kind: "resume", sessionId: "session-1", fromIndex: 2 }),
  );

  assert.equal(counter.calls, 2);
  assert.equal(second.reused, true);
  assert.deepEqual(received, ["one", "one", "two"]);
  runner.closeAll();
});

test("keeps a session claimed when its turn fails, and forgets a missing one", async () => {
  const released: ResumeDecision[] = [];
  const decision: ResumeDecision = { kind: "resume", sessionId: "session-1", fromIndex: 0 };
  const failing = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery([
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["rate_limit"], stop_reason: null, usage: {} },
    ]) as never,
  );
  // The prompt reached the process, so the transcript may be dirty.
  await assert.rejects(() =>
    failing.run({
      conversationKey: "conv",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
      signal: new AbortController().signal,
      requestId: "release",
      stream: false,
      plan: () => decision,
      release: (value) => released.push(value),
    }),
  );
  assert.deepEqual(released, []);

  // Only a fork that failed because the transcript is gone drops the source.
  const forgotten: string[] = [];
  for (const [sessionId, message] of [
    ["gone", "Session gone not found in project directory for /tmp"],
    ["healthy", "ENOSPC: no space left on device, write"],
  ]) {
    const forking = new ClaudeRunner(
      config,
      createLogger("error"),
      fakeQuery(textEvents) as never,
      undefined,
      (() => Promise.reject(new Error(message))) as never,
    );
    const result = await forking.run({
      conversationKey: "conv",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
      signal: new AbortController().signal,
      requestId: "forget",
      stream: false,
      plan: () => ({ kind: "fork", sessionId: sessionId!, upToMessageId: "leaf", fromIndex: 0 }),
      forget: (id) => forgotten.push(id),
    });
    assert.equal(result.forked, undefined);
  }
  assert.deepEqual(forgotten, ["gone"]);
});

test("releases a claimed session when the turn never reached a process", async () => {
  const { runner, run } = toolRunner(["t1"]);
  // The parked turn holds the only slot.
  await run("r1", undefined);

  const released: ResumeDecision[] = [];
  const decision: ResumeDecision = { kind: "resume", sessionId: "session-9", fromIndex: 0 };
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(
    () =>
      run("r2", undefined, {
        conversationKey: "other",
        signal: abort.signal,
        plan: () => decision,
        release: (value) => released.push(value),
      }),
    ClientAbort,
  );
  assert.deepEqual(released, [decision]);
  runner.closeAll();
});

test("a retry after a failed turn forks at the last checkpoint", async () => {
  const sessions = new SessionStore(undefined, createLogger("error"));
  const scope = { model: "claude-sonnet-5-5", cwd: "/tmp", systemHash: "s" };
  const history = [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: "reply" },
  ];
  sessions.record({ ...scope, sessionId: "session-1", history, leafUuid: "leaf-1" });
  const messages = [...history, { role: "user" as const, content: "two" }];

  const decisions: ResumeDecision[] = [];
  const forks: Array<[string, string | undefined]> = [];
  let fail = true;
  const queryFn = (params: { options: Record<string, unknown> }) =>
    fail
      ? fakeQuery([
          { type: "result", subtype: "error_during_execution", is_error: true, errors: ["rate_limit"], stop_reason: null, usage: {} },
        ])(params)
      : fakeQuery(textEvents)(params);
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    queryFn as never,
    undefined,
    ((sessionId: string, options?: { upToMessageId?: string }) => {
      forks.push([sessionId, options?.upToMessageId]);
      return Promise.resolve({ sessionId: "fork-1" });
    }) as never,
  );
  const attempt = (requestId: string) =>
    runner.run({
      conversationKey: "conv",
      request: { model: scope.model, messages },
      signal: new AbortController().signal,
      requestId,
      stream: false,
      plan: () => {
        const decision = sessions.plan({ ...scope, messages });
        sessions.claim(decision);
        decisions.push(decision);
        return decision;
      },
      release: (decision) => sessions.release(decision),
    });

  await assert.rejects(() => attempt("first"));
  fail = false;
  const retry = await attempt("retry");

  assert.deepEqual(decisions.map((decision) => decision.kind), ["resume", "fork"]);
  assert.deepEqual(forks, [["session-1", "leaf-1"]]);
  assert.equal(retry.forked, true);
  runner.closeAll();
});

test("a rate limit with a known reset time carries retry-after", () => {
  const error = errorFor({ type: "rate_limit", message: "limit", resetAt: Date.now() + 90_000 });
  assert.equal(error.status, 429);
  assert.ok(error.retryAfter !== undefined && error.retryAfter >= 89 && error.retryAfter <= 90);
  assert.equal(errorFor({ type: "rate_limit", message: "limit" }).retryAfter, undefined);
});

test("tool results sent with another system prompt do not continue the parked turn", async () => {
  const { runner, state, run } = toolRunner(["t1"]);
  await run("r1", undefined);
  const parked = state.pending!;

  const second = await run("r2", undefined, {
    request: {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "find x" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }] },
        toolResultMessage(["t1"]),
      ],
      system: "A different prompt.",
      tools: [lookupTool],
    },
  });
  assert.deepEqual(parked.pendingIds(), []);
  assert.equal(state.calls, 2);
  assert.equal(second.reused, undefined);
  runner.closeAll();
});

test("the proxy's own API key is not passed to the Claude process", async () => {
  process.env.PROXY_API_KEY = "proxy-secret";
  let env: Record<string, string> | undefined;
  const runner = new ClaudeRunner(
    config,
    createLogger("error"),
    fakeQuery(textEvents, (options) => {
      env = options.env as Record<string, string>;
    }) as never,
  );
  try {
    await runner.run({
      conversationKey: "conv",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
      signal: new AbortController().signal,
      requestId: "env",
      stream: false,
    });
  } finally {
    delete process.env.PROXY_API_KEY;
  }
  assert.ok(env);
  assert.equal(env.PROXY_API_KEY, undefined);
  runner.closeAll();
});
