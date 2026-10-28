import test from "node:test";
import assert from "node:assert/strict";
import { prepareTurn, systemText, conversationKey } from "../src/anthropic/translate.js";

function promptContent(request: Parameters<typeof prepareTurn>[0]): unknown[] {
  return (prepareTurn(request).prompt.message.content as unknown[]) ?? [];
}

test("passes a single text turn through without transcript markers", () => {
  const prepared = prepareTurn({
    model: "claude-sonnet-5-5",
    messages: [{ role: "user", content: "Say hi" }],
  });
  assert.deepEqual(promptContent({
    model: "claude-sonnet-5-5",
    messages: [{ role: "user", content: "Say hi" }],
  }), [{ type: "text", text: "Say hi" }]);
  assert.equal(prepared.system, undefined);
});

test("joins system blocks and appends a forced tool-choice instruction", () => {
  const prepared = prepareTurn({
    model: "claude-sonnet-5-5",
    system: [{ type: "text", text: "Be terse." }, { type: "text", text: "Use JSON." }],
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: "lookup" },
  });
  assert.equal(prepared.system, "Be terse.\n\nUse JSON.");
  assert.match(prepared.toolChoiceNote ?? "", /only available tool/);
  assert.equal(prepared.tools.length, 1);
});

test("serializes history and the current turn", () => {
  const content = promptContent({
    model: "claude-sonnet-5-5",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ],
  });
  const text = (content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("\n");
  assert.match(text, /<conversation_history>/);
  assert.match(text, /<user>\nfirst\n<\/user>/);
  assert.match(text, /<assistant>\nanswer\n<\/assistant>/);
  assert.match(text, /<current_message>\nsecond\n<\/current_message>/);
  assert.match(text, /Reply as the assistant/);
});

test("renders tool calls and tool results as transcript text", () => {
  const content = promptContent({
    model: "claude-sonnet-5-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "v" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }],
      },
    ],
  });
  const text = (content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? "")
    .join("\n");
  assert.match(text, /\[tool call\] lookup \(id: t1\)/);
  assert.match(text, /\[tool result for t1\]\nfound/);
});

test("tool_choice none hides tools", () => {
  const prepared = prepareTurn({
    model: "claude-sonnet-5-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "a", input_schema: { type: "object" } }],
    tool_choice: { type: "none" },
  });
  assert.equal(prepared.tools.length, 0);
});

test("systemText tolerates strings and ignores non-text blocks", () => {
  assert.equal(systemText("  hello  "), "hello");
  assert.equal(
    systemText([
      { type: "text", text: "a" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "text", text: "b" },
    ]),
    "a\n\nb",
  );
});

test("conversationKey prefers header then metadata session", () => {
  const request = {
    model: "m",
    messages: [{ role: "user" as const, content: "hi" }],
    metadata: { user_id: JSON.stringify({ session_id: "s1" }) },
  };
  assert.equal(conversationKey(request, "h1"), "header:h1");
  assert.equal(conversationKey(request), "session:s1");
});
