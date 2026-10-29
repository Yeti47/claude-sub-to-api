import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session/store.js";
import { deriveConversationKey, userMessageHashes } from "../src/session/hashes.js";
import { createLogger } from "../src/logger.js";
import type { Message } from "../src/anthropic/types.js";

const logger = createLogger("error");
const u = (text: string): Message => ({ role: "user", content: text });
const a = (text: string): Message => ({ role: "assistant", content: text });

function store(): SessionStore {
  return new SessionStore(undefined, logger);
}

const base = {
  model: "claude-sonnet-5-5",
  cwd: "/tmp",
  systemHash: "system",
};

test("plans a resume when the user history is an extension", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  sessions.record({
    key: "k",
    sessionId: "s1",
    ...base,
    userHashes: userMessageHashes(first),
  });

  const plan = sessions.plan({ key: "k", messages: [...first, u("two")], ...base });
  assert.equal(plan?.sessionId, "s1");
  assert.equal(plan?.fromIndex, 2);
  assert.equal(plan?.matchedUsers, 1);
});

test("does not resume when history diverges", () => {
  const sessions = store();
  sessions.record({ key: "k", sessionId: "s1", ...base, userHashes: ["a"] });
  assert.equal(
    sessions.plan({ key: "k", messages: [u("different"), u("next")], ...base }),
    null,
  );
});

test("does not resume a tool-result turn", () => {
  const sessions = store();
  const first = [u("one")];
  sessions.record({ key: "k", sessionId: "s1", ...base, userHashes: userMessageHashes(first) });
  const messages: Message[] = [
    ...first,
    a("calling"),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
    },
  ];
  assert.equal(sessions.plan({ key: "k", messages, ...base }), null);
});

test("does not resume when the model or system prompt changes", () => {
  const sessions = store();
  sessions.record({ key: "k", sessionId: "s1", ...base, userHashes: ["a"] });
  const messages = [u("one"), u("two")];
  assert.equal(
    sessions.plan({ key: "k", messages, ...base, model: "other" }),
    null,
  );
  assert.equal(
    sessions.plan({ key: "k", messages, ...base, systemHash: "other" }),
    null,
  );
});

test("does not resume a retry with no new user turn", () => {
  const sessions = store();
  const first = [u("one")];
  sessions.record({ key: "k", sessionId: "s1", ...base, userHashes: userMessageHashes(first) });
  assert.equal(sessions.plan({ key: "k", messages: first, ...base }), null);
});

test("derives a stable key from the header, metadata, or first user turn", () => {
  const messages = [u("hello"), a("hi")];
  assert.equal(deriveConversationKey(messages, "h"), "header:h");
  assert.equal(
    deriveConversationKey(messages, undefined, JSON.stringify({ session_id: "s" })),
    "session:s",
  );
  assert.equal(
    deriveConversationKey(messages),
    `first:${userMessageHashes(messages)[0]}`,
  );
  assert.equal(deriveConversationKey(messages), deriveConversationKey(messages));
});
