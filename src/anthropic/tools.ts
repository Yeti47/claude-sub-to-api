/**
 * Expose client-defined Messages API tools to Claude Code as an in-process
 * MCP server.
 *
 * This server does not execute tools itself. Each handler blocks until the
 * API client returns a `tool_result`; the runner keeps the CLI turn parked
 * meanwhile, so the same session and prompt cache continue.
 */
import {
  createSdkMcpServer,
  tool as sdkTool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import type { PendingToolRegistry } from "../claude/pending-tools.js";

export const MCP_SERVER_NAME = "claude_sub_to_api";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export interface ToolBridge {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  /** SDK/CLI tool name -> name the API client used. */
  toClientName: Map<string, string>;
  /** Names as Claude Code will see them, for allowedTools. */
  exposedNames: string[];
}

/** MCP tool names are restricted; keep a reversible, collision-free mapping. */
export function sanitizeToolNames(tools: ToolDefinition[]): Map<string, string> {
  const used = new Set<string>();
  const mapping = new Map<string, string>(); // client name -> exposed short name
  for (const definition of tools) {
    const base =
      definition.name
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 48) || "tool";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base.slice(0, 44)}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    mapping.set(definition.name, candidate);
  }
  return mapping;
}

function inputShape(schema: Record<string, unknown> | undefined): unknown {
  try {
    const parsed = z.fromJSONSchema(
      (schema ?? { type: "object", properties: {} }) as never,
    );
    const loose = (parsed as { loose?: () => unknown }).loose;
    return typeof loose === "function" ? loose.call(parsed) : parsed;
  } catch {
    return z.object({}).catchall(z.any());
  }
}

export function buildToolBridge(
  tools: ToolDefinition[],
  pending: PendingToolRegistry,
): ToolBridge | undefined {
  if (tools.length === 0) return undefined;

  const shortNames = sanitizeToolNames(tools);
  const toClientName = new Map<string, string>();
  const exposedNames: string[] = [];

  const sdkTools = tools.map((definition) => {
    const short = shortNames.get(definition.name) ?? definition.name;
    const exposed = `${MCP_TOOL_PREFIX}${short}`;
    toClientName.set(exposed, definition.name);
    exposedNames.push(exposed);

    const shape = inputShape(definition.input_schema);
    return sdkTool(
      short,
      definition.description || definition.name,
      ((shape as { shape?: Record<string, unknown> }).shape ??
        shape) as any,
      async (args: any) => (await pending.register(definition.name, args ?? {})) as any,
      // The proxy never runs these tools, so marking them read-only lets the
      // CLI invoke parallel tool calls concurrently instead of serialising
      // them behind the first blocked handler.
      { alwaysLoad: true, annotations: { readOnlyHint: true } },
    );
  });

  // The SDK re-derives tools/list from the zod shape, which can drop
  // descriptions and narrow types. Serve the client's JSON Schema verbatim.
  const listed = tools.map((definition) => ({
    name: shortNames.get(definition.name) ?? definition.name,
    description: definition.description || definition.name,
    inputSchema: definition.input_schema ?? { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { "anthropic/alwaysLoad": true },
  }));

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: sdkTools,
    alwaysLoad: true,
  }) as McpSdkServerConfigWithInstance & {
    instance?: { server?: { setRequestHandler?: (schema: unknown, handler: unknown) => void } };
  };

  try {
    server.instance?.server?.setRequestHandler?.(
      z.object({ method: z.literal("tools/list"), params: z.any().optional() }),
      async () => ({ tools: listed }),
    );
  } catch {
    // Older SDKs don't expose the underlying server; the zod schema is used.
  }

  return {
    mcpServers: { [MCP_SERVER_NAME]: server },
    toClientName,
    exposedNames,
  };
}

/** Map a CLI tool name back to the client's original name. */
export function clientToolName(
  bridge: ToolBridge | undefined,
  sdkName: string,
): string {
  return bridge?.toClientName.get(sdkName) ?? sdkName;
}
