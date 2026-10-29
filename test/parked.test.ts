import test from "node:test";
import assert from "node:assert/strict";
import { ParkedTurn, ParkedTurnStore } from "../src/claude/parked.js";
import { PendingToolRegistry } from "../src/claude/pending-tools.js";
import { createLogger } from "../src/logger.js";

function turn(id: string, closed: { value: boolean }): ParkedTurn {
  const pending = new PendingToolRegistry();
  const call = pending.register("lookup", { key: "x" });
  void call;
  pending.link("t1", pending.calls()[0]!);
  return new ParkedTurn(id, "session", pending, {
    resume: async () => {
      throw new Error("not used");
    },
    close: () => {
      closed.value = true;
    },
  });
}

test("finds, takes, and closes parked turns", () => {
  const store = new ParkedTurnStore(createLogger("error"), 0);
  const closed = { value: false };
  const parked = turn("turn-1", closed);
  store.add("conversation", parked);

  assert.equal(store.find("conversation", ["t1"]), parked);
  assert.equal(store.take("conversation"), parked);
  assert.equal(store.find("conversation", ["t1"]), undefined);

  store.add("other", parked);
  store.close("other", "done");
  assert.equal(closed.value, true);
  store.stop();
});

test("reaps a parked turn after its TTL", async () => {
  const store = new ParkedTurnStore(createLogger("error"), 20);
  const closed = { value: false };
  store.add("conversation", turn("turn-2", closed));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(closed.value, true);
  assert.equal(store.find("conversation", ["t1"]), undefined);
  store.stop();
});
