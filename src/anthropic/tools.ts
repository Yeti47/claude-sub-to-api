/**
 * Expose client-defined Messages API tools to Claude Code as an in-process
 * MCP server.
 *
 * This server never executes a tool. A handler exists only so Claude can emit
 * a complete `tool_use` block; the runner stops the turn as soon as the block
 * is complete and returns it to the API client, which executes the tool and
 * sends a follow-up request with the result.
 */
import {
  createSdkMcpServer,
  tool as sdkTool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const MCP_SERVER_NAME = "proxy";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export class ToolCallParked extends Error {
  constructor(
    readonly toolName: string,
    readonly args: Record<string, unknown>,
  ) {
    super(`Tool call ${toolName} is executed by the API client`);
    this.name = "ToolCallParked";
  }
}

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

export function buildToolBridge(tools: ToolDefinition[]): ToolBridge | undefined {
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
      async (args: any) => {
        throw new ToolCallParked(definition.name, args ?? {});
      },
      { alwaysLoad: true },
    );
  });

  // The SDK re-derives tools/list from the zod shape, which can drop
  // descriptions and narrow types. Serve the client's JSON Schema verbatim.
  const listed = tools.map((definition) => ({
    name: shortNames.get(definition.name) ?? definition.name,
    description: definition.description || definition.name,
    inputSchema: definition.input_schema ?? { type: "object", properties: {} },
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
