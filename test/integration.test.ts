import test from "node:test";
import assert from "node:assert/strict";

/**
 * Optional live test against a running server (and therefore a real Claude
 * subscription). Run it with:
 *
 *   CLAUDE_SUB_TO_API_BASE_URL=http://localhost:8080 \
 *   CLAUDE_SUB_TO_API_KEY=$PROXY_API_KEY \
 *   node --import tsx --test test/integration.test.ts
 */
const base = process.env.CLAUDE_SUB_TO_API_BASE_URL;
const key = process.env.CLAUDE_SUB_TO_API_KEY ?? process.env.PROXY_API_KEY;
const skip = !base || !key ? "set CLAUDE_SUB_TO_API_BASE_URL and CLAUDE_SUB_TO_API_KEY" : false;

const request = {
  model: process.env.CLAUDE_SUB_TO_API_MODEL || "claude-haiku-5-5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Reply with exactly: pong" }],
};

test("live non-streaming message", { skip }, async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key! },
    body: JSON.stringify(request),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
  };
  assert.equal(json.stop_reason, "end_turn");
  assert.match(json.content.map((block) => block.text ?? "").join(""), /pong/i);
});

test("live streaming message", { skip }, async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key! },
    body: JSON.stringify({ ...request, stream: true }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.equal(text.match(/event: message_stop/g)?.length, 1);
});

test("live models", { skip }, async () => {
  const res = await fetch(`${base}/v1/models`, { headers: { "x-api-key": key! } });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { data: unknown[] };
  assert.ok(json.data.length > 0);
});

test("live compaction and continuing from the block", { skip }, async () => {
  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key! },
      body: JSON.stringify({ model: request.model, ...payload }),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as {
      content: Array<{ type: string; text?: string; content?: string }>;
      stop_reason: string;
    };
  };
  const summary = await post({
    max_tokens: 2048,
    messages: [
      { role: "user", content: "Remember this code word: heliotrope. Reply with OK." },
      { role: "assistant", content: "OK" },
    ],
    compaction: { type: "summarize" },
  });
  assert.equal(summary.stop_reason, "compaction");
  assert.equal(summary.content.length, 1);
  assert.equal(summary.content[0]?.type, "compaction");
  assert.match(summary.content[0]?.content ?? "", /heliotrope/i);

  const next = await post({
    max_tokens: 64,
    messages: [
      { role: "assistant", content: summary.content },
      { role: "user", content: "What is the code word? Reply with the word only." },
    ],
  });
  assert.match(next.content.map((block) => block.text ?? "").join(""), /heliotrope/i);
});
