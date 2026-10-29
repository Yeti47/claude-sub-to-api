import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOnboarding } from "../src/auth/claude-auth.js";
import { loadConfig } from "../src/config.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "claude-sub-to-api-test-"));
}

test("creates .claude.json with the onboarding flag", async () => {
  const path = await dir();
  try {
    await ensureOnboarding(join(path, ".claude.json"));
    const parsed = JSON.parse(await readFile(join(path, ".claude.json"), "utf8")) as {
      hasCompletedOnboarding?: boolean;
    };
    assert.equal(parsed.hasCompletedOnboarding, true);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("preserves existing .claude.json fields", async () => {
  const path = await dir();
  try {
    await writeFile(join(path, ".claude.json"), JSON.stringify({ theme: "dark" }));
    await ensureOnboarding(join(path, ".claude.json"));
    const parsed = JSON.parse(await readFile(join(path, ".claude.json"), "utf8")) as {
      theme?: string;
      hasCompletedOnboarding?: boolean;
    };
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.hasCompletedOnboarding, true);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("does not overwrite an invalid .claude.json", async () => {
  const path = await dir();
  try {
    await writeFile(join(path, ".claude.json"), "{not json");
    await assert.rejects(() => ensureOnboarding(join(path, ".claude.json")), /cannot read/);
    assert.equal(await readFile(join(path, ".claude.json"), "utf8"), "{not json");
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("requires CLAUDE_CODE_OAUTH_TOKEN", () => {
  assert.throws(
    () => loadConfig({ PROXY_API_KEY: "proxy" }),
    /CLAUDE_CODE_OAUTH_TOKEN is required/,
  );
  const config = loadConfig({
    PROXY_API_KEY: "proxy",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
  });
  assert.equal(config.proxyApiKey, "proxy");
  assert.ok(config.claudeConfigDir.endsWith(".claude"));
  assert.equal(config.claudeConfigDirExplicit, false);

  const explicit = loadConfig({
    PROXY_API_KEY: "proxy",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
    CLAUDE_CONFIG_DIR: "/tmp/claude-config",
  });
  assert.equal(explicit.claudeConfigDir, "/tmp/claude-config");
  assert.equal(explicit.claudeConfigDirExplicit, true);
});
