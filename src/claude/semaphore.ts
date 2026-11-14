/**
 * Bounded concurrency with FIFO hand-off.
 *
 * A released permit is transferred directly to the next waiter. It never
 * becomes briefly "free", which would let a fresh caller steal it and push
 * the number of holders above the limit.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly size: number) {}

  /** Number of callers waiting for a permit. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** A permit if one is free and nobody is waiting for it. */
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.size || this.waiters.length > 0) return undefined;
    this.active += 1;
    return this.makeRelease();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.active < this.size && this.waiters.length === 0) {
      this.active += 1;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {},
      };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      waiter.onAbort = () => {
        remove();
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) {
        this.active -= 1;
        return;
      }
      next.signal?.removeEventListener("abort", next.onAbort);
      // The permit moves from the releasing holder to the waiter. active
      // stays the same, so no third caller can observe a free slot.
      next.resolve(this.makeRelease());
    };
  }
}

interface Waiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}
