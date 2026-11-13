import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/claude/semaphore.js";
import { KeyedLock } from "../src/claude/keyed-lock.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a released permit is transferred to the first waiter, not exposed", async () => {
  const semaphore = new Semaphore(1);
  const releaseA = await semaphore.acquire();
  let bAcquired = false;
  let cAcquired = false;
  const b = semaphore.acquire().then((release) => {
    bAcquired = true;
    return release;
  });
  const c = semaphore.acquire().then((release) => {
    cAcquired = true;
    return release;
  });

  assert.equal(semaphore.waiting, 2);
  releaseA();
  await tick();
  assert.equal(bAcquired, true);
  assert.equal(cAcquired, false);
  assert.equal(semaphore.waiting, 1);

  const releaseB = await b;
  releaseB();
  await tick();
  assert.equal(cAcquired, true);
  const releaseC = await c;
  releaseC();
  assert.equal(semaphore.waiting, 0);
});

test("an aborted waiter leaves the queue without taking a permit", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(semaphore.waiting, 0);
  release();

  const next = await semaphore.acquire();
  next();
});

test("a canceled queued request does not block later requests on the same key", async () => {
  const locks = new KeyedLock();
  const release = await locks.acquire("conversation");

  const controller = new AbortController();
  const waiting = locks.acquire("conversation", controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);

  const queued = locks.acquire("conversation");
  release();
  const releaseNext = await queued;
  releaseNext();

  const final = await locks.acquire("conversation");
  final();
});
