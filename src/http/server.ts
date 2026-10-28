import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { isAuthorized } from "../auth/api-key.js";
import type { PreparedAuth } from "../auth/claude-auth.js";
import type { MessagesRequest } from "../anthropic/types.js";
import { effectiveSystemPrompt } from "../anthropic/translate.js";
import { ApiError, ClientAbort, ClaudeRunner } from "../claude/runner.js";
import type { ModelCatalog } from "../claude/models.js";
import type { SessionStore } from "../session/store.js";
import { deriveConversationKey, systemHash, userMessageHashes } from "../session/hashes.js";
import { SseWriter } from "./sse.js";

const MAX_BODY = 32 << 20;
const SESSION_HEADERS = ["x-session-id", "x-bf-session-id", "x-claude-session-id"];

interface Deps {
  config: Config;
  logger: Logger;
  runner: ClaudeRunner;
  models: ModelCatalog;
  auth: PreparedAuth;
  sessions: SessionStore;
}

function sessionHeader(req: IncomingMessage): string | undefined {
  for (const name of SESSION_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function createHandler(deps: Deps) {
  const { config, logger } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    res.setHeader("request-id", requestId);
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    if (req.method === "GET" && (path === "/healthz" || path === "/health")) {
      const status = await deps.auth.status();
      res.writeHead(status.ok ? 200 : 503, { "content-type": "text/plain" });
      res.end(status.ok ? "ok" : `unhealthy: ${status.detail}`);
      return;
    }

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "claude-sub-to-api", version: 2 }));
      return;
    }

    if (path !== "/v1/messages" && path !== "/v1/models") {
      return sendError(res, 404, "not_found_error", `Unknown endpoint ${path}`);
    }

    if (!isAuthorized(req, config.proxyApiKey)) {
      return sendError(res, 401, "authentication_error", "Invalid API key");
    }

    if (path === "/v1/models") {
      if (req.method !== "GET") return sendError(res, 405, "invalid_request_error", "Use GET");
      const rows = await deps.models.list();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: rows,
          has_more: false,
          first_id: rows[0]?.id ?? null,
          last_id: rows.at(-1)?.id ?? null,
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      return sendError(res, 405, "invalid_request_error", "Use POST");
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, "invalid_request_error", (error as Error).message);
    }

    const request = body as MessagesRequest;
    const invalid = validate(request);
    if (invalid) return sendError(res, 400, "invalid_request_error", invalid);

    const stream = request.stream === true;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.requestTimeoutMs);
    timer.unref?.();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let writer: SseWriter | undefined;
    if (stream) writer = new SseWriter(res);

    const key = deriveConversationKey(
      request.messages,
      sessionHeader(req),
      request.metadata?.user_id,
    );
    const hashes = userMessageHashes(request.messages);
    const promptHash = systemHash(effectiveSystemPrompt(request.system));
    const plan = deps.sessions.plan({
      key,
      messages: request.messages,
      model: request.model,
      cwd: config.cwd,
      systemHash: promptHash,
      now: Date.now(),
    });
    if (plan) {
      logger.debug("resuming Claude session", {
        requestId,
        sessionId: plan.sessionId,
        matchedUsers: plan.matchedUsers,
      });
    }

    try {
      const result = await deps.runner.run({
        request,
        signal: controller.signal,
        requestId,
        stream,
        onEvent: writer ? (event) => writer!.event(event) : undefined,
        resumeSessionId: plan?.sessionId,
        resumeFromIndex: plan?.fromIndex,
        persistSession: true,
      });
      const response = result.response;
      if (result.sessionId) {
        deps.sessions.record({
          key,
          sessionId: result.sessionId,
          model: request.model,
          cwd: config.cwd,
          systemHash: promptHash,
          userHashes: hashes,
        });
      }
      if (writer) {
        writer.finish();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }
      logger.info("request completed", {
        requestId,
        model: request.model,
        stream,
        status: 200,
        resumed: Boolean(plan),
        sessionId: result.sessionId,
        ms: Date.now() - started,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      });
    } catch (error) {
      if (error instanceof ClientAbort) {
        if (timedOut) {
          const message = `Request exceeded ${config.requestTimeoutMs} ms`;
          logger.error("request timed out", { requestId, model: request.model });
          if (writer) {
            writer.error(504, "api_error", message);
            writer.end();
          } else if (!res.headersSent) {
            sendError(res, 504, "api_error", message);
          }
        } else {
          writer?.end();
        }
        return;
      }
      const apiError =
        error instanceof ApiError ? error : new ApiError(500, "api_error", String(error));
      logger.error("request failed", {
        requestId,
        model: request.model,
        status: apiError.status,
        error: apiError.message,
        ms: Date.now() - started,
      });
      if (writer) {
        writer.error(apiError.status, apiError.type, apiError.message);
        writer.end();
      } else if (!res.headersSent) {
        sendError(res, apiError.status, apiError.type, apiError.message);
      } else {
        res.end();
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

function validate(request: MessagesRequest): string | null {
  if (!request || typeof request !== "object") return "Request body must be a JSON object";
  if (typeof request.model !== "string" || !request.model.trim())
    return "model is required";
  if (!Array.isArray(request.messages) || request.messages.length === 0)
    return "messages must be a non-empty array";
  for (const message of request.messages) {
    if (message?.role !== "user" && message?.role !== "assistant")
      return "every message needs role user or assistant";
    if (message.content === undefined || message.content === null)
      return "every message needs content";
  }
  if (request.max_tokens !== undefined) {
    if (typeof request.max_tokens !== "number" || request.max_tokens < 1)
      return "max_tokens must be a positive number";
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) return "tools must be an array";
    for (const tool of request.tools) {
      if (typeof tool?.name !== "string" || !tool.name) return "every tool needs a name";
      if (!tool.input_schema || typeof tool.input_schema !== "object")
        return `tool ${tool.name} needs input_schema`;
    }
  }
  return null;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}
