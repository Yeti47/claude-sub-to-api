import test from "node:test";
import assert from "node:assert/strict";
import { buildToolBridge, sanitizeToolNames, MCP_TOOL_PREFIX } from "../src/anthropic/tools.js";

test("sanitizes invalid tool names without collisions", () => {
  const names = sanitizeToolNames([
    { name: "read file", input_schema: { type: "object" } },
    { name: "read_file", input_schema: { type: "object" } },
    { name: "read-file", input_schema: { type: "object" } },
  ]);
  const values = [...names.values()];
  assert.equal(new Set(values).size, 3);
  assert.ok(values.every((value) => /^[a-zA-Z0-9_-]+$/.test(value)));
});

test("builds an in-process MCP server and a reverse name map", () => {
  const bridge = buildToolBridge([
    {
      name: "lookup",
      description: "Look something up",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  ]);
  assert.ok(bridge);
  assert.deepEqual(bridge?.exposedNames, [`${MCP_TOOL_PREFIX}lookup`]);
  assert.equal(bridge?.toClientName.get(`${MCP_TOOL_PREFIX}lookup`), "lookup");
  assert.ok(bridge?.mcpServers.proxy);
});

test("empty tool lists produce no MCP server", () => {
  assert.equal(buildToolBridge([]), undefined);
});
