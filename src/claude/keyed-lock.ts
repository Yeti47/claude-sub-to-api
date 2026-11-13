/**
 * One FIFO lock per conversation key.
 *
 * Waiters carry the request's AbortSignal: a queued request that times out
 * or disconnects is removed from the queue instead of delaying unrelated
 * work until the current holder finishes.
 */
export class KeyedLock {
  private readonly locks = new Map<string, LockState>();

  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    let state = this.locks.get(key);
    if (!state) {
      state = { locked: false, queue: [] };
      this.locks.set(key, state);
    }
    if (!state.locked) {
      state.locked = true;
      return this.makeRelease(key);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, onAbort: () => {} };
      const remove = () => {
        const index = state!.queue.indexOf(waiter);
        if (index >= 0) state!.queue.splice(index, 1);
      };
      waiter.onAbort = () => {
        remove();
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private makeRelease(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = this.locks.get(key);
      if (!state) return;
      const next = state.queue.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(this.makeRelease(key));
        return;
      }
      state.locked = false;
      if (state.queue.length === 0) this.locks.delete(key);
    };
  }
}

interface LockState {
  locked: boolean;
  queue: Waiter[];
}

interface Waiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}
