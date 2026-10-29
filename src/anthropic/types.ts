/**
 * Types for the subset of the Anthropic Messages API this server implements.
 * They are intentionally structural: unknown fields are tolerated and ignored.
 */

export interface CacheControl {
  type: "ephemeral";
  ttl?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
  citations?: unknown[];
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
  cache_control?: CacheControl;
}

export interface DocumentBlock {
  type: "document";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "text"; media_type: "text/plain"; data: string };
  media_type?: string;
  title?: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
  type?: string;
}

export type ToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface ThinkingConfig {
  type: "enabled" | "disabled" | "adaptive";
  budget_tokens?: number;
}

export interface MessagesRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  system?: string | TextBlock[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  thinking?: ThinkingConfig;
  service_tier?: string;
  output_config?: { effort?: string; [key: string]: unknown };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
}

export const STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
] as const;

export function normalizeStopReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "tool_use":
    case "pause_turn":
    case "refusal":
      return value;
    case "max_output_tokens":
      return "max_tokens";
    case "tool_deferred":
      return "tool_use";
    default:
      return "end_turn";
  }
}
