import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/**
 * `loadConfig` reads the numeric overrides from `process.env` (the argument
 * only feeds the required keys and paths), so those are set here.
 */
const base = {
  PROXY_API_KEY: "key",
  CLAUDE_CODE_OAUTH_TOKEN: "token",
} as NodeJS.ProcessEnv;

function withFloor(value: string | undefined): number {
  const previous = process.env.MIN_CLI_OUTPUT_TOKENS;
  if (value === undefined) delete process.env.MIN_CLI_OUTPUT_TOKENS;
  else process.env.MIN_CLI_OUTPUT_TOKENS = value;
  try {
    return loadConfig(base).minCliOutputTokens;
  } finally {
    if (previous === undefined) delete process.env.MIN_CLI_OUTPUT_TOKENS;
    else process.env.MIN_CLI_OUTPUT_TOKENS = previous;
  }
}

test("the CLI output floor defaults to 16384 tokens", () => {
  assert.equal(withFloor(undefined), 16_384);
});

test("MIN_CLI_OUTPUT_TOKENS overrides or disables the floor", () => {
  assert.equal(withFloor("8192"), 8192);
  assert.equal(withFloor("0"), 0);
});

test("an invalid floor falls back to the default", () => {
  assert.equal(withFloor("-5"), 16_384);
  assert.equal(withFloor("not-a-number"), 16_384);
});
