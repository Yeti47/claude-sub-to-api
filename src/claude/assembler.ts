/** Accumulates Claude Code stream events into one Anthropic message. */
import type {
  ContentBlock,
  MessagesResponse,
  Usage,
} from "../anthropic/types.js";
import { normalizeStopReason } from "../anthropic/types.js";
import { clientToolName, type ToolBridge } from "../anthropic/tools.js";

interface BlockState {
  block: ContentBlock;
  partialJson: string;
  isToolUse: boolean;
}

function usageOf(raw: unknown): Partial<Usage> {
  const value = (raw ?? {}) as Record<string, unknown>;
  const usage: Partial<Usage> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ] as const) {
    if (typeof value[key] === "number") usage[key] = value[key] as number;
  }
  return usage;
}

function classifySynthetic(text: string): string {
  const lower = text.toLowerCase();
  if (/authenticat|oauth|credential|login|sign in|sign-in/.test(lower)) return "authentication_failed";
  if (/rate limit|429/.test(lower)) return "rate_limit";
  if (/overload|529/.test(lower)) return "overloaded";
  if (/model_not_found|model not found/.test(lower)) return "model_not_found";
  if (/image|unprocessable|invalid|not supported/.test(lower)) return "invalid_request";
  return "api_error";
}

export class MessageAssembler {
  id = `msg_${Date.now().toString(36)}`;
  model: string;
  content: ContentBlock[] = [];
  stopReason: string | null = null;
  stopSequence: string | null = null;
  usage: Usage = { input_tokens: 0, output_tokens: 0 };
  sawToolUse = false;
  sawMessageStop = false;
  sawStreamEvents = false;
  sessionId?: string;
  resultError: { type: string; message: string } | null = null;
  /** A CLI-level notice (not model output) that must fail the request. */
  fatalError = false;
  private blocks = new Map<number, BlockState>();
  private indexMap = new Map<number, number>();
  private suppressed = new Set<number>();
  private nextIndex = 0;

  constructor(
    readonly requestedModel: string,
    private readonly bridge: ToolBridge | undefined,
    private readonly onEvent?: (event: Record<string, unknown>) => void,
    private readonly includeThinking = true,
  ) {
    this.model = requestedModel;
  }

  private emit(event: Record<string, unknown>): void {
    this.onEvent?.(event);
  }

  handle(message: unknown): void {
    const msg = message as Record<string, unknown>;
    if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
    switch (msg.type) {
      case "stream_event":
        this.handleStreamEvent(msg.event as Record<string, unknown>);
        break;
      case "assistant":
        this.handleAssistant(msg);
        break;
      case "result":
        this.handleResult(msg);
        break;
      case "system":
        if (msg.subtype === "model_refusal_no_fallback") {
          // A refusal is a normal 200 response with stop_reason "refusal".
          this.stopReason = "refusal";
        }
        break;
      default:
        break;
    }
  }

  private handleStreamEvent(event: Record<string, unknown> | undefined): void {
    if (!event || typeof event.type !== "string") return;
    this.sawStreamEvents = true;
    const type = event.type;

    if (type === "message_start") {
      // A retried or follow-up API message starts over; the response must
      // describe the final message, not a concatenation of attempts.
      this.blocks.clear();
      this.indexMap.clear();
      this.suppressed.clear();
      this.nextIndex = 0;
      this.content = [];
      this.stopReason = null;
      this.stopSequence = null;
      this.sawToolUse = false;
      this.sawMessageStop = false;
      const message = (event.message ?? {}) as Record<string, unknown>;
      if (typeof message.id === "string") this.id = message.id;
      this.usage = { input_tokens: 0, output_tokens: 0, ...usageOf(message.usage) };
      this.emit({
        type: "message_start",
        message: {
          ...message,
          id: this.id,
          model: this.model,
          role: "assistant",
          content: [],
          usage: this.usage,
        },
      });
      return;
    }

    if (type === "content_block_start") {
      const sdkIndex = Number(event.index ?? this.blocks.size);
      const raw = (event.content_block ?? {}) as Record<string, unknown>;
      if (
        !this.includeThinking &&
        (raw.type === "thinking" || raw.type === "redacted_thinking")
      ) {
        this.suppressed.add(sdkIndex);
        return;
      }
      const index = this.nextIndex++;
      this.indexMap.set(sdkIndex, index);
      const block = this.startBlock(raw);
      this.blocks.set(index, { block, partialJson: "", isToolUse: block.type === "tool_use" });
      if (block.type === "tool_use") this.sawToolUse = true;
      this.emit({ ...event, index, content_block: block });
      return;
    }

    if (type === "content_block_delta") {
      const sdkIndex = Number(event.index ?? -1);
      if (this.suppressed.has(sdkIndex)) return;
      const index = this.indexMap.get(sdkIndex) ?? sdkIndex;
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      this.applyDelta(index, delta);
      this.emit({ ...event, index });
      return;
    }

    if (type === "content_block_stop") {
      const sdkIndex = Number(event.index ?? -1);
      if (this.suppressed.has(sdkIndex)) return;
      const index = this.indexMap.get(sdkIndex) ?? sdkIndex;
      this.finishBlock(index);
      this.emit({ ...event, index });
      return;
    }

    if (type === "message_delta") {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (delta.stop_reason !== undefined) {
        this.stopReason = normalizeStopReason(delta.stop_reason);
        delta.stop_reason = this.stopReason;
      }
      if (delta.stop_sequence !== undefined) {
        this.stopSequence = (delta.stop_sequence as string) ?? null;
      }
      this.usage = { ...this.usage, ...usageOf(event.usage) };
      this.emit(event);
      return;
    }

    if (type === "message_stop") {
      this.sawMessageStop = true;
      this.emit(event);
      return;
    }

    if (type === "ping") this.emit(event);
  }

  private startBlock(raw: Record<string, unknown>): ContentBlock {
    if (raw.type === "tool_use") {
      return {
        type: "tool_use",
        id: typeof raw.id === "string" ? raw.id : `toolu_${Date.now().toString(36)}`,
        name: clientToolName(this.bridge, String(raw.name ?? "")),
        input: {},
      } as ContentBlock;
    }
    if (raw.type === "thinking") {
      return { type: "thinking", thinking: "", signature: "" };
    }
    if (raw.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: String(raw.data ?? "") };
    }
    return { type: "text", text: String(raw.text ?? "") };
  }

  private applyDelta(index: number, delta: Record<string, unknown>): void {
    const state = this.blocks.get(index);
    if (!state) return;
    if (delta.type === "text_delta" && state.block.type === "text") {
      state.block.text += String(delta.text ?? "");
    } else if (delta.type === "thinking_delta" && state.block.type === "thinking") {
      state.block.thinking += String(delta.thinking ?? "");
    } else if (delta.type === "signature_delta" && state.block.type === "thinking") {
      state.block.signature = String(delta.signature ?? "");
    } else if (delta.type === "input_json_delta") {
      state.partialJson += String(delta.partial_json ?? "");
    }
  }

  private finishBlock(index: number): void {
    const state = this.blocks.get(index);
    if (!state) return;
    if (state.isToolUse && state.block.type === "tool_use" && state.partialJson) {
      try {
        state.block.input = JSON.parse(state.partialJson) as Record<string, unknown>;
      } catch {
        state.block.input = {};
      }
    }
    this.blocks.set(index, state);
    this.syncContent();
  }

  private syncContent(): void {
    this.content = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, state]) => state.block);
  }

  private handleAssistant(msg: Record<string, unknown>): void {
    const message = (msg.message ?? {}) as Record<string, unknown>;
    // The CLI reports some failures (expired OAuth, API errors) as a
    // synthetic assistant message with a 200 result. Surface them as errors
    // instead of returning the notice as model output.
    if (message.model === "<synthetic>") {
      const text = Array.isArray(message.content)
        ? (message.content as Record<string, unknown>[])
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => String(block.text))
            .join("\n")
        : "";
      if (text) {
        // Hitting the output-token ceiling is a normal response boundary,
        // not a request failure. Keep whatever content was streamed.
        if (/exceeded .*output token|max_output_tokens|max_tokens/i.test(text)) {
          this.stopReason = "max_tokens";
          return;
        }
        this.resultError = { type: classifySynthetic(text), message: text };
        this.fatalError = true;
        return;
      }
    }
    if (typeof message.id === "string" && !this.sawStreamEvents) this.id = message.id;
    if (Array.isArray(message.usage)) return;
    if (message.usage && typeof message.usage === "object") {
      this.usage = { ...this.usage, ...usageOf(message.usage) };
    }
    if (typeof message.stop_reason === "string") {
      this.stopReason = normalizeStopReason(message.stop_reason);
    }
    if (typeof msg.error === "string") {
      this.resultError = { type: msg.error, message: `Claude returned ${msg.error}` };
    }
    if (this.sawStreamEvents) return;
    if (Array.isArray(message.content)) {
      this.content = (message.content as Record<string, unknown>[]).map((block) => {
        if (block.type === "tool_use") {
          this.sawToolUse = true;
          return {
            type: "tool_use",
            id: String(block.id ?? ""),
            name: clientToolName(this.bridge, String(block.name ?? "")),
            input: (block.input ?? {}) as Record<string, unknown>,
          } as ContentBlock;
        }
        return block as unknown as ContentBlock;
      });
      if (!this.includeThinking) {
        this.content = this.content.filter(
          (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
        );
      }
    }
  }

  private handleResult(msg: Record<string, unknown>): void {
    if (msg.usage) this.usage = { ...this.usage, ...usageOf(msg.usage) };
    if (typeof msg.stop_reason === "string") {
      this.stopReason = normalizeStopReason(msg.stop_reason);
    }
    if (msg.is_error === true || msg.subtype !== "success") {
      const errors = Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
      const message =
        errors || String(msg.result ?? this.resultError?.message ?? "Claude failed to complete the turn");
      this.resultError = {
        type: this.resultError?.type ?? String(msg.subtype ?? "error_during_execution"),
        message,
      };
    }
  }

  response(): MessagesResponse {
    if (this.sawToolUse) this.stopReason = "tool_use";
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.content,
      stop_reason: this.stopReason ?? (this.sawToolUse ? "tool_use" : "end_turn"),
      stop_sequence: this.stopSequence,
      usage: this.usage,
    };
  }
}
