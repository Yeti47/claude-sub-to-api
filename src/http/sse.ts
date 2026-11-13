import type { ServerResponse } from "node:http";

/**
 * Writes Anthropic-style server-sent events and keeps the connection warm.
 *
 * The response is not committed until the first event. A turn that fails
 * before producing one (rate limit, authentication, no capacity) can still
 * be answered with a real HTTP status, which is what client SDKs base their
 * retry and backoff on.
 */
export class SseWriter {
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private lastType = "";

  constructor(
    private readonly res: ServerResponse,
    private readonly heartbeatMs = 15_000,
  ) {}

  /** Whether the 200 status and stream headers were sent. */
  get started(): boolean {
    return this.res.headersSent;
  }

  private start(): void {
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.heartbeat = setInterval(() => this.event({ type: "ping" }), this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  event(payload: Record<string, unknown>): void {
    if (this.closed) return;
    if (!this.started) this.start();
    const type = typeof payload.type === "string" ? payload.type : "message";
    this.lastType = type;
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Anthropic streams end with exactly one message_stop. */
  finish(): void {
    if (this.lastType !== "message_stop") this.event({ type: "message_stop" });
    this.end();
  }

  /** Report a failure inside a stream that has already started. */
  error(status: number, type: string, message: string): void {
    this.event({ type: "error", error: { type, message }, status });
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.res.end();
  }
}
