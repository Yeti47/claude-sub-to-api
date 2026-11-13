import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type Checkpoint } from "../src/session/store.js";
import {
  deriveConversationKey,
  historyFingerprint,
  userMessageHashes,
} from "../src/session/hashes.js";
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

function record(
  sessions: SessionStore,
  history: Message[],
  sessionId: string,
  leafUuid?: string,
  extra: Partial<Parameters<SessionStore["record"]>[0]> = {},
): void {
  sessions.record({
    key: "k",
    sessionId,
    ...base,
    history,
    leafUuid,
    ...extra,
  });
}

function checkpoints(path: string): Checkpoint[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    { checkpoints?: Checkpoint[] }
  >;
  return data.k?.checkpoints ?? [];
}

function checkpoint(
  history: Message[],
  sessionId: string,
  leafUuid: string,
): Checkpoint {
  const users = userMessageHashes(history);
  return {
    count: users.length,
    hash: users[users.length - 1]!,
    historyHash: historyFingerprint(history),
    sessionId,
    leafUuid,
  };
}

test("plans a resume when the user history is an extension", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  const plan = sessions.plan({ key: "k", messages: [...first, u("two")], ...base });
  assert.deepEqual(plan, {
    kind: "resume",
    sessionId: "s1",
    fromIndex: 2,
    matchedUsers: 1,
  });
});

test("starts fresh when history diverges and no checkpoint matches", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  assert.deepEqual(
    sessions.plan({ key: "k", messages: [u("different"), u("next")], ...base }),
    { kind: "fresh" },
  );
});

test("does not resume a tool-result turn, but forks at the previous checkpoint", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  const messages: Message[] = [
    ...first,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
    },
  ];
  const plan = sessions.plan({ key: "k", messages, ...base });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
  assert.equal(plan.fromIndex, 2);
});

test("starts fresh when the model or system prompt changes", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  const messages = [u("one"), a("reply"), u("two")];
  assert.deepEqual(sessions.plan({ key: "k", messages, ...base, model: "other" }), {
    kind: "fresh",
  });
  assert.deepEqual(sessions.plan({ key: "k", messages, ...base, systemHash: "other" }), {
    kind: "fresh",
  });
});

test("does not fork a retry with no new user turn", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  assert.deepEqual(
    sessions.plan({ key: "k", messages: [u("one")], ...base }),
    { kind: "fresh" },
  );
});

test("forks at the latest checkpoint when the last user turn is rewritten", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  const second = [...first, u("two"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");

  const plan = sessions.plan({
    key: "k",
    messages: [u("one"), a("reply"), u("edited")],
    ...base,
  });
  assert.deepEqual(plan, {
    kind: "fork",
    sessionId: "s1",
    upToMessageId: "leaf-1",
    fromIndex: 2,
    matchedUsers: 1,
  });
});

test("forks at the checkpoint before the rewrite, then sends the remaining turns", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  const second = [...first, u("two"), a("reply-2")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");

  const plan = sessions.plan({
    key: "k",
    messages: [u("one"), a("reply-1"), u("edited"), a("reply-3"), u("three")],
    ...base,
  });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
  assert.equal(plan.fromIndex, 2);
  assert.equal(plan.matchedUsers, 1);
});

test("does not fork when the first user turn itself changed", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  assert.deepEqual(
    sessions.plan({ key: "k", messages: [u("different")], ...base }),
    { kind: "fresh" },
  );
});

test("does not resume when an earlier assistant reply was edited", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  const second = [...first, u("two"), a("reply-2")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");

  const plan = sessions.plan({
    key: "k",
    messages: [
      u("one"),
      a("edited reply-1"),
      u("two"),
      a("reply-2"),
      u("three"),
    ],
    ...base,
  });
  assert.deepEqual(plan, { kind: "fresh" });
});

test("forks at the checkpoint before an edited assistant reply", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  const second = [...first, u("two"), a("reply-2")];
  const third = [...second, u("three"), a("reply-3")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");
  record(sessions, third, "s1", "leaf-3");

  const plan = sessions.plan({
    key: "k",
    messages: [u("one"), a("reply-1"), u("two"), a("edited reply-2"), u("three")],
    ...base,
  });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
  assert.equal(plan.fromIndex, 2);
});

test("ignores a checkpoint without a complete-history fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const history = [u("one"), a("reply")];
  writeFileSync(
    path,
    JSON.stringify({
      k: {
        sessionId: "s1",
        ...base,
        userHashes: userMessageHashes(history),
        checkpoints: [
          {
            count: 1,
            hash: userMessageHashes(history)[0],
            sessionId: "s1",
            leafUuid: "leaf-1",
          },
        ],
        updatedAt: Date.now(),
      },
    }),
  );

  const sessions = new SessionStore(path, logger);
  assert.deepEqual(
    sessions.plan({ key: "k", messages: [...history, u("two")], ...base }),
    { kind: "fresh" },
  );
});

test("records and replaces a checkpoint at the same user count", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const sessions = new SessionStore(path, logger);
  const history = [u("one"), a("reply")];
  record(sessions, history, "s1", "leaf-1");
  record(sessions, history, "s1", "leaf-2");
  assert.deepEqual(checkpoints(path), [checkpoint(history, "s1", "leaf-2")]);
});

test("a fresh decision clears old checkpoints", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("two"), a("reply")], "s1", "leaf-2");
  record(sessions, first, "s2", "leaf-3", { decision: { kind: "fresh" } });
  assert.deepEqual(checkpoints(path), [checkpoint(first, "s2", "leaf-3")]);
});

test("a fork decision keeps only checkpoints up to the fork point", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  const second = [...first, u("two"), a("reply")];
  const third = [...second, u("three"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");
  record(sessions, third, "s1", "leaf-3");

  const forked = [u("one"), a("reply"), u("edited"), a("edited reply")];
  record(sessions, forked, "s2", "leaf-4", {
    decision: {
      kind: "fork",
      sessionId: "s1",
      upToMessageId: "leaf-1",
      fromIndex: 2,
      matchedUsers: 1,
    },
  });

  assert.deepEqual(checkpoints(path), [
    checkpoint(first, "s1", "leaf-1"),
    checkpoint(forked, "s2", "leaf-4"),
  ]);
});

test("a parked tool turn updates the binding but records no checkpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  const parked = [...first, u("two"), a("tool")];
  record(sessions, parked, "s1", "leaf-2", { parked: true });
  assert.deepEqual(checkpoints(path), [checkpoint(first, "s1", "leaf-1")]);

  const plan = sessions.plan({ key: "k", messages: parked, ...base });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
});

test("a continuation drops checkpoints from an unrelated session", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  const continued = [...first, u("two"), a("reply")];
  record(sessions, continued, "s2", "leaf-2");
  assert.deepEqual(checkpoints(path), [checkpoint(continued, "s2", "leaf-2")]);

  assert.deepEqual(
    sessions.plan({
      key: "k",
      messages: [u("one"), a("reply"), u("edited")],
      ...base,
    }),
    { kind: "fresh" },
  );
});

test("forks before a tool exchange when the parked turn is gone", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("look it up"), a("tool")], "s1", "leaf-2", {
    parked: true,
  });

  const plan = sessions.plan({
    key: "k",
    messages: [
      ...first,
      u("look it up"),
      a("tool"),
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
      },
    ],
    ...base,
  });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
  assert.equal(plan.fromIndex, 2);
});

test("reloads checkpoints from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  const path = join(dir, "sessions.json");
  const first = new SessionStore(path, logger);
  const one = [u("one"), a("reply")];
  record(first, one, "s1", "leaf-1");
  record(first, [...one, u("two"), a("reply")], "s1", "leaf-2");

  const second = new SessionStore(path, logger);
  const plan = second.plan({
    key: "k",
    messages: [u("one"), a("reply"), u("edited")],
    ...base,
  });
  assert.equal(plan.kind, "fork");
  if (plan.kind !== "fork") return;
  assert.equal(plan.upToMessageId, "leaf-1");
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
