import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { prepareClaudeAuth } from "./auth/claude-auth.js";
import { ClaudeRunner } from "./claude/runner.js";
import { ModelCatalog } from "./claude/models.js";
import { createHandler } from "./http/server.js";
import { SessionStore } from "./session/store.js";
import { ParkedTurnStore } from "./claude/parked.js";
import { join } from "node:path";

function listenOptions(addr: string): { host?: string; port: number } {
  if (addr.startsWith(":")) return { port: Number(addr.slice(1)) };
  const split = addr.lastIndexOf(":");
  if (split > 0) {
    return { host: addr.slice(0, split), port: Number(addr.slice(split + 1)) };
  }
  return { port: Number(addr) };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const auth = await prepareClaudeAuth(config, logger);
  try {
    await mkdir(config.cwd, { recursive: true });
  } catch (error) {
    logger.warn("CLAUDE_CWD is not usable; falling back to the process directory", {
      cwd: config.cwd,
      error: String(error),
    });
    config.cwd = process.cwd();
  }
  const runner = new ClaudeRunner(config, logger);
  const models = new ModelCatalog(config, logger);
  const statePath =
    config.statePath ??
    (config.claudeConfigDir ? join(config.claudeConfigDir, "sub-to-api-sessions.json") : undefined);
  const sessions = new SessionStore(statePath, logger);
  const parked = new ParkedTurnStore(logger, config.parkedTurnTtlMs);
  const handler = createHandler({ config, logger, runner, models, auth, sessions, parked });

  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      logger.error("unhandled request error", { error: String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal error" } }));
      } else {
        res.end();
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const listen = listenOptions(config.listenAddr);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  logger.info("listening", {
    addr: address ? `${address.address}:${address.port}` : config.listenAddr,
    configDir: config.claudeConfigDir,
    maxConcurrency: config.maxConcurrency,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    const force = setTimeout(() => {
      logger.warn("closing remaining connections");
      server.closeAllConnections();
    }, 15_000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(force);
    parked.closeAll("Server shutting down");
    parked.stop();
    await auth.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
