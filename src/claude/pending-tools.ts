/**
 * Tool calls that are waiting for the API client to execute them.
 *
 * The MCP handler blocks on a promise. The runner returns the tool_use block
 * to the client, keeps the CLI process alive, and resolves the promise when
 * the follow-up request carrying the tool_result arrives.
 */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface PendingToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Anthropic tool_use id once the streamed block has been matched. */
  toolUseId?: string;
  result: Promise<CallToolResult>;
  resolve: (result: CallToolResult) => void;
  reject: (error: Error) => void;
}

interface Phase {
  registered: PendingToolCall[];
  waiting: Set<PendingToolCall>;
  byId: Map<string, PendingToolCall>;
  resolvers: Array<() => void>;
}

function newPhase(): Phase {
  return { registered: [], waiting: new Set(), byId: new Map(), resolvers: [] };
}

export class PendingToolRegistry {
  private phase = newPhase();

  /** Start collecting calls for the next assistant message. */
  beginPhase(): void {
    this.phase = newPhase();
  }

  register(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let resolve!: (result: CallToolResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<CallToolResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: PendingToolCall = {
      name,
      args: args ?? {},
      result,
      resolve: (value) => resolve(value),
      reject: (error) => reject(error),
    };
    const phase = this.phase;
    phase.registered.push(call);
    phase.waiting.add(call);
    for (const wake of phase.resolvers.splice(0)) wake();
    return result;
  }

  calls(): PendingToolCall[] {
    return this.phase.registered;
  }

  link(toolUseId: string, call: PendingToolCall): void {
    call.toolUseId = toolUseId;
    this.phase.byId.set(toolUseId, call);
  }

  pendingIds(): string[] {
    return [...this.phase.byId.keys()];
  }

  resolve(toolUseId: string, result: CallToolResult): boolean {
    const call = this.phase.byId.get(toolUseId);
    if (!call) return false;
    call.resolve(result);
    this.phase.byId.delete(toolUseId);
    this.phase.waiting.delete(call);
    return true;
  }

  /** Wait until `count` handlers have registered for the current message. */
  waitFor(count: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.phase.registered.length >= count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const phase = this.phase;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${count} tool handler(s)`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new Error("aborted while waiting for tool handlers"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const check = () => {
        if (phase.registered.length < count) {
          phase.resolvers.push(check);
          return;
        }
        cleanup();
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      phase.resolvers.push(check);
    });
  }

  rejectAll(error: Error): void {
    for (const call of this.phase.waiting) call.reject(error);
    this.phase.waiting.clear();
    this.phase.byId.clear();
  }
}
