import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError } from "../src/claude/errors.js";
import { createHandler } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import type { Config } from "../src/config.js";
import type { MessagesResponse } from "../src/anthropic/types.js";
import { SessionStore, type ResumeDecision } from "../src/session/store.js";
import type { RunResult } from "../src/claude/runner.js";

const config: Config = {
  listenAddr: ":0",
  proxyApiKey: "secret",
  claudeConfigDir: "/tmp/does-not-matter",
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

const response: MessagesResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

async function withServer(
  run: (base: string) => Promise<void>,
  overrides: Partial<Parameters<typeof createHandler>[0]> = {},
): Promise<void> {
  const handler = createHandler({
    config,
    logger: createLogger("error"),
    runner: {
      run: async (input: { stream: boolean; onEvent?: (event: Record<string, unknown>) => void }) => {
        if (input.onEvent) {
          input.onEvent({ type: "message_start", message: { id: "msg_1" } });
          input.onEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          input.onEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
          input.onEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        }
        return { response, sessionId: "session-test" };
      },
    } as never,
    models: { list: async () => [{ type: "model", id: "claude-sonnet-5-5", display_name: "Sonnet", created_at: "2025-01-01T00:00:00Z" }] } as never,
    auth: { status: async () => ({ ok: true, detail: "test" }), cleanup: async () => {} },
    sessions: new SessionStore(undefined, createLogger("error")),
    ...overrides,
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const body = JSON.stringify({
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  messages: [{ role: "user", content: "hi" }],
});

test("health is public and reports auth status", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });
});

test("rejects a missing or wrong API key", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/v1/messages`, { method: "POST", body })).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": "nope" }, body })).status,
      401,
    );
  });
});

test("validates the request body", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: { type: string } };
    assert.equal(json.error.type, "invalid_request_error");
  });
});

test("returns a non-streaming message", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as MessagesResponse;
    assert.equal(json.content[0]?.type, "text");
  });
});

test("streams SSE with exactly one message_stop", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(body), stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.equal(text.match(/event: message_stop/g)?.length, 1);
  });
});

test("lists models for an authorized caller", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/models`, { headers: { "x-api-key": "secret" } });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    assert.equal(json.data[0]?.id, "claude-sonnet-5-5");
  });
});

test("plans a resume for an appended turn and a fork for a rewritten one", async () => {
  const sessions = new SessionStore(undefined, createLogger("error"));
  const plans: ResumeDecision[] = [];
  const runner = {
    run: async (input: {
      plan?: () => ResumeDecision;
      record?: (result: RunResult, decision?: ResumeDecision) => void;
    }) => {
      const decision = input.plan?.() ?? { kind: "fresh" };
      plans.push(decision);
      const result: RunResult = { response, sessionId: "session-test", leafUuid: "leaf-1" };
      input.record?.(result, decision);
      return result;
    },
  };

  await withServer(
    async (base) => {
      const send = (messages: unknown[]) =>
        fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": "secret",
            "x-session-id": "record-1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages }),
        });

      assert.equal((await send([{ role: "user", content: "hi" }])).status, 200);
      assert.equal(
        (
          await send([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "again" },
          ])
        ).status,
        200,
      );
      assert.equal(
        (
          await send([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "edited" },
          ])
        ).status,
        200,
      );
    },
    { runner: runner as never, sessions },
  );

  assert.equal(plans[0]?.kind, "fresh");
  assert.equal(plans[1]?.kind, "resume");
  assert.equal(plans[2]?.kind, "fork");
  if (plans[2]?.kind === "fork") {
    assert.equal(plans[2].sessionId, "session-test");
    assert.equal(plans[2].upToMessageId, "leaf-1");
    assert.equal(plans[2].fromIndex, 2);
  }
});

test("a stream that fails before its first event gets the real HTTP status", async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "secret", "content-type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(body), stream: true }),
      });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "120");
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const json = (await res.json()) as { type: string; error: { type: string; message: string } };
      assert.equal(json.type, "error");
      assert.equal(json.error.type, "rate_limit_error");
    },
    {
      runner: {
        run: async () => {
          throw new ApiError(429, "rate_limit_error", "limit reached", 120);
        },
      } as never,
    },
  );
});

test("a stream that fails after it started reports the error as an event", async () => {
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "secret", "content-type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(body), stream: true }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /event: message_start/);
      assert.match(text, /event: error\ndata: .*overloaded_error/);
      assert.doesNotMatch(text, /event: message_stop/);
    },
    {
      runner: {
        run: async (input: { onEvent?: (event: Record<string, unknown>) => void }) => {
          input.onEvent?.({ type: "message_start", message: { id: "msg_1" } });
          throw new ApiError(529, "overloaded_error", "overloaded");
        },
      } as never,
    },
  );
});

test("estimates input tokens without running a turn", async () => {
  let runs = 0;
  await withServer(
    async (base) => {
      const count = async (payload: Record<string, unknown>) => {
        const res = await fetch(`${base}/v1/messages/count_tokens`, {
          method: "POST",
          headers: { "x-api-key": "secret", "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { status: res.status, json: (await res.json()) as { input_tokens?: number } };
      };
      const small = await count({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "x".repeat(300) }],
      });
      assert.equal(small.status, 200);
      assert.equal(small.json.input_tokens, 104);

      const large = await count({
        model: "claude-sonnet-5-5",
        system: "y".repeat(300),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "x".repeat(300) },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(90_000) } },
            ],
          },
        ],
        tools: [{ name: "lookup", description: "Look something up", input_schema: { type: "object" } }],
      });
      // The image counts as an image, not as 90,000 characters of text.
      assert.ok(large.json.input_tokens! > 1800 && large.json.input_tokens! < 2000);

      assert.equal((await count({ model: "claude-sonnet-5-5", messages: [] })).status, 400);
      assert.equal(
        (await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).status,
        401,
      );
    },
    {
      runner: {
        run: async () => {
          runs += 1;
          throw new Error("must not run");
        },
      } as never,
    },
  );
  assert.equal(runs, 0);
});
