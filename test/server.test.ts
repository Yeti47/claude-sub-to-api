import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import type { Config } from "../src/config.js";
import type { MessagesResponse } from "../src/anthropic/types.js";

const config: Config = {
  listenAddr: ":0",
  proxyApiKey: "secret",
  claudeConfigDir: "/tmp/does-not-matter",
  credentialsPath: "/tmp/does-not-matter/.credentials.json",
  cwd: process.cwd(),
  logLevel: "error",
  maxConcurrency: 1,
  requestTimeoutMs: 60_000,
  defaultMaxTokens: 100,
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

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
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
        return response;
      },
    } as never,
    models: { list: async () => [{ type: "model", id: "claude-sonnet-5-5", display_name: "Sonnet", created_at: "2025-01-01T00:00:00Z" }] } as never,
    auth: { status: async () => ({ ok: true, detail: "test" }), cleanup: async () => {} },
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
