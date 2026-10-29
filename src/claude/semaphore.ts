/** Bounded concurrency, so a burst cannot spawn unlimited Claude Code processes. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.active >= this.size) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("aborted"));
        };
        this.waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}
