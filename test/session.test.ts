import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const toolResult: Message = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
};

function store(): SessionStore {
  return new SessionStore(undefined, logger);
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "sessions-")), "sessions.json");
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
  sessions.record({ sessionId, ...base, history, leafUuid, ...extra });
}

function plan(sessions: SessionStore, messages: Message[], extra: Partial<typeof base> = {}) {
  return sessions.plan({ ...base, ...extra, messages });
}

function saved(
  sessions: SessionStore,
  path: string,
): Record<string, { tip: string; checkpoints: Checkpoint[] }> {
  sessions.flush();
  return (JSON.parse(readFileSync(path, "utf8")) as { sessions: never }).sessions;
}

function checkpoint(history: Message[], leafUuid: string): Checkpoint {
  return { historyHash: historyFingerprint(history), leafUuid };
}

test("plans a resume when the history is an extension", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  assert.deepEqual(plan(sessions, [...first, u("two")]), {
    kind: "resume",
    sessionId: "s1",
    fromIndex: 2,
    historyHash: historyFingerprint(first),
  });
});

test("starts fresh when history diverges and no checkpoint matches", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  assert.deepEqual(plan(sessions, [u("different"), u("next")]), { kind: "fresh" });
});

test("does not resume a tool-result turn, but forks at the previous checkpoint", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  assert.deepEqual(plan(sessions, [...first, toolResult]), {
    kind: "fork",
    sessionId: "s1",
    upToMessageId: "leaf-1",
    fromIndex: 2,
  });
});

test("starts fresh when the model, system prompt or directory changes", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  const messages = [u("one"), a("reply"), u("two")];
  assert.deepEqual(plan(sessions, messages, { model: "other" }), { kind: "fresh" });
  assert.deepEqual(plan(sessions, messages, { systemHash: "other" }), { kind: "fresh" });
  assert.deepEqual(plan(sessions, messages, { cwd: "/other" }), { kind: "fresh" });
});

test("a request with another model or system prompt leaves the session resumable", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  // A title request for the same conversation: same messages, other prompt.
  assert.deepEqual(plan(sessions, first, { systemHash: "title" }), { kind: "fresh" });
  record(sessions, [u("one"), a("A title")], "s2", "leaf-t", { systemHash: "title" });

  assert.equal(plan(sessions, [...first, u("two")]).kind, "resume");
});

test("two conversations with the same opening each resume their own session", () => {
  const sessions = store();
  const one = [u("hi"), a("reply to one")];
  const two = [u("hi"), a("reply to two")];
  record(sessions, one, "s1", "leaf-1");
  record(sessions, two, "s2", "leaf-2");

  const first = plan(sessions, [...one, u("next")]);
  const second = plan(sessions, [...two, u("next")]);
  assert.equal(first.kind, "resume");
  assert.equal(second.kind, "resume");
  if (first.kind !== "resume" || second.kind !== "resume") return;
  assert.equal(first.sessionId, "s1");
  assert.equal(second.sessionId, "s2");
});

test("does not fork a retry with no new user turn", () => {
  const sessions = store();
  record(sessions, [u("one"), a("reply")], "s1", "leaf-1");
  assert.deepEqual(plan(sessions, [u("one")]), { kind: "fresh" });
});

test("forks at the latest checkpoint when the last user turn is rewritten", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("two"), a("reply")], "s1", "leaf-2");

  assert.deepEqual(plan(sessions, [...first, u("edited")]), {
    kind: "fork",
    sessionId: "s1",
    upToMessageId: "leaf-1",
    fromIndex: 2,
  });
});

test("forks at the checkpoint before the rewrite, then sends the remaining turns", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("two"), a("reply-2")], "s1", "leaf-2");

  assert.deepEqual(plan(sessions, [...first, u("edited"), a("reply-3"), u("three")]), {
    kind: "fork",
    sessionId: "s1",
    upToMessageId: "leaf-1",
    fromIndex: 2,
  });
});

test("does not resume when an earlier assistant reply was edited", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("two"), a("reply-2")], "s1", "leaf-2");

  assert.deepEqual(
    plan(sessions, [u("one"), a("edited reply-1"), u("two"), a("reply-2"), u("three")]),
    { kind: "fresh" },
  );
});

test("forks at the checkpoint before an edited assistant reply", () => {
  const sessions = store();
  const first = [u("one"), a("reply-1")];
  const second = [...first, u("two"), a("reply-2")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");
  record(sessions, [...second, u("three"), a("reply-3")], "s1", "leaf-3");

  const decision = plan(sessions, [...first, u("two"), a("edited reply-2"), u("three")]);
  assert.equal(decision.kind, "fork");
  if (decision.kind !== "fork") return;
  assert.equal(decision.upToMessageId, "leaf-1");
  assert.equal(decision.fromIndex, 2);
});

test("a fork keeps the source session's checkpoints usable", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  const second = [...first, u("two"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, second, "s1", "leaf-2");

  // The conversation is rewound and continues in a forked session.
  const forked = [...first, u("edited"), a("edited reply")];
  record(sessions, forked, "s2", "leaf-3");

  assert.equal(plan(sessions, [...forked, u("next")]).kind, "resume");
  // Returning to the original branch still finds the original transcript.
  const original = plan(sessions, [...second, u("three")]);
  assert.equal(original.kind, "resume");
  if (original.kind === "resume") assert.equal(original.sessionId, "s1");
  // Rewinding further forks the first session again.
  const rewound = plan(sessions, [...first, u("another")]);
  assert.equal(rewound.kind, "fork");
  if (rewound.kind === "fork") assert.equal(rewound.sessionId, "s1");
});

test("a claimed session is forked, not resumed, until its turn is recorded", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  const messages = [...first, u("two")];
  record(sessions, first, "s1", "leaf-1");

  const decision = plan(sessions, messages);
  assert.equal(decision.kind, "resume");
  sessions.claim(decision);
  assert.equal(plan(sessions, messages).kind, "fork");

  record(sessions, [...messages, a("reply")], "s1", "leaf-2");
  assert.equal(plan(sessions, [...messages, a("reply"), u("three")]).kind, "resume");
});

test("releasing a claim makes the session resumable again", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  const messages = [...first, u("two")];
  record(sessions, first, "s1", "leaf-1");

  const decision = plan(sessions, messages);
  sessions.claim(decision);
  sessions.release(decision);
  assert.equal(plan(sessions, messages).kind, "resume");
});

test("records and replaces a checkpoint for the same history", () => {
  const path = tempPath();
  const sessions = new SessionStore(path, logger);
  const history = [u("one"), a("reply")];
  record(sessions, history, "s1", "leaf-1");
  record(sessions, history, "s1", "leaf-2");
  assert.deepEqual(saved(sessions, path).s1?.checkpoints, [checkpoint(history, "leaf-2")]);
});

test("a parked tool turn moves the session past its last checkpoint", () => {
  const path = tempPath();
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");

  const parked = [...first, u("two"), a("tool")];
  record(sessions, parked, "s1", "leaf-2", { parked: true });
  assert.deepEqual(saved(sessions, path).s1?.checkpoints, [checkpoint(first, "leaf-1")]);
  assert.equal(saved(sessions, path).s1?.tip, "");

  // With the parked turn gone, the tool exchange is replayed into a fork.
  assert.deepEqual(plan(sessions, [...parked, toolResult]), {
    kind: "fork",
    sessionId: "s1",
    upToMessageId: "leaf-1",
    fromIndex: 2,
  });
});

test("keeps recording checkpoints in a long conversation", () => {
  const sessions = store();
  const history: Message[] = [];
  for (let turn = 0; turn < 600; turn += 1) {
    history.push(u(`question ${turn}`), a(`answer ${turn}`));
    record(sessions, [...history], "s1", `leaf-${turn}`);
  }
  assert.deepEqual(plan(sessions, [...history, u("next")]), {
    kind: "resume",
    sessionId: "s1",
    fromIndex: 1200,
    historyHash: historyFingerprint(history),
  });
});

test("forgetting one of two sessions with the same history keeps the other", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, first, "s2", "leaf-2");

  sessions.forget("s2");
  const decision = plan(sessions, [...first, u("two")]);
  assert.equal(decision.kind, "resume");
  if (decision.kind === "resume") assert.equal(decision.sessionId, "s1");

  sessions.forget("s1");
  assert.deepEqual(plan(sessions, [...first, u("two")]), { kind: "fresh" });
});

test("a forgotten session no longer matches", () => {
  const sessions = store();
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  sessions.forget("s1");
  assert.deepEqual(plan(sessions, [...first, u("two")]), { kind: "fresh" });
});

test("reloads sessions from disk", () => {
  const path = tempPath();
  const first = new SessionStore(path, logger);
  const one = [u("one"), a("reply")];
  record(first, one, "s1", "leaf-1");
  record(first, [...one, u("two"), a("reply")], "s1", "leaf-2");
  first.flush();

  const second = new SessionStore(path, logger);
  assert.equal(plan(second, [...one, u("two"), a("reply"), u("three")]).kind, "resume");
  const rewound = plan(second, [...one, u("edited")]);
  assert.equal(rewound.kind, "fork");
  if (rewound.kind === "fork") assert.equal(rewound.upToMessageId, "leaf-1");
});

test("migrates bindings written before version 2", () => {
  const path = tempPath();
  const one = [u("one"), a("reply")];
  const two = [...one, u("two"), a("reply")];
  writeFileSync(
    path,
    JSON.stringify({
      "header:abc": {
        sessionId: "s2",
        ...base,
        userHashes: userMessageHashes(two),
        checkpoints: [
          { count: 1, hash: "x", historyHash: historyFingerprint(one), sessionId: "s1", leafUuid: "leaf-1" },
          { count: 2, hash: "y", historyHash: historyFingerprint(two), sessionId: "s2", leafUuid: "leaf-2" },
          // Written before checkpoints had a full-history fingerprint.
          { count: 3, hash: "z", sessionId: "s2", leafUuid: "leaf-3" },
        ],
        updatedAt: Date.now(),
      },
    }),
  );

  const sessions = new SessionStore(path, logger);
  assert.deepEqual(plan(sessions, [...two, u("three")]), {
    kind: "resume",
    sessionId: "s2",
    fromIndex: 4,
    historyHash: historyFingerprint(two),
  });
  const rewound = plan(sessions, [...one, u("edited")]);
  assert.equal(rewound.kind, "fork");
  if (rewound.kind === "fork") assert.equal(rewound.sessionId, "s1");
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

test("writes changes to disk on its own, after a short delay", async () => {
  const path = tempPath();
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  record(sessions, first, "s1", "leaf-1");
  record(sessions, [...first, u("two"), a("reply")], "s1", "leaf-2");
  assert.equal(existsSync(path), false);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const file = JSON.parse(readFileSync(path, "utf8")) as { sessions: Record<string, { checkpoints: unknown[] }> };
  assert.equal(file.sessions.s1?.checkpoints.length, 2);
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("a claim survives a restart", () => {
  const path = tempPath();
  const sessions = new SessionStore(path, logger);
  const first = [u("one"), a("reply")];
  const messages = [...first, u("two")];
  record(sessions, first, "s1", "leaf-1");
  sessions.claim(plan(sessions, messages));
  sessions.flush();

  assert.equal(plan(new SessionStore(path, logger), messages).kind, "fork");
});

test("reports sessions dropped for the session limit or for age", () => {
  const pruned: string[] = [];
  const sessions = new SessionStore(undefined, logger, (sessionId) => pruned.push(sessionId));
  for (let index = 0; index <= 300; index += 1) {
    record(sessions, [u(`question ${index}`), a("reply")], `s${index}`, "leaf");
  }
  assert.equal(pruned.length, 1);

  const old = [u("old"), a("reply")];
  record(sessions, old, "aged", "leaf");
  const later = Date.now() + 31 * 24 * 60 * 60_000;
  assert.deepEqual(sessions.plan({ ...base, messages: [...old, u("next")], now: later }), {
    kind: "fresh",
  });
  assert.ok(pruned.includes("aged"));
});
