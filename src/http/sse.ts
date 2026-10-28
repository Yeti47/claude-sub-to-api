import type { ServerResponse } from "node:http";

/** Writes Anthropic-style server-sent events and keeps the connection warm. */
export class SseWriter {
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private lastType = "";

  constructor(
    private readonly res: ServerResponse,
    heartbeatMs = 15_000,
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.heartbeat = setInterval(() => this.event({ type: "ping" }), heartbeatMs);
    this.heartbeat.unref?.();
  }

  event(payload: Record<string, unknown>): void {
    if (this.closed) return;
    const type = typeof payload.type === "string" ? payload.type : "message";
    this.lastType = type;
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Anthropic streams end with exactly one message_stop. */
  finish(): void {
    if (this.lastType !== "message_stop") this.event({ type: "message_stop" });
    this.end();
  }

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
