# claude-sub-to-api

An **Anthropic Messages API-compatible HTTP server** backed by a **Claude subscription** (Pro/Max), using Anthropic's official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

Version 2 is a TypeScript rewrite. It no longer reverse-engineers Claude Code's HTTP requests or fakes its headers. Instead it runs the official Claude Code CLI through the Agent SDK; the CLI owns authentication, OAuth refresh, and the conversation with Anthropic.

```
your agent / SDK
  │  Anthropic Messages API (/v1/messages)
  ▼
claude-sub-to-api  (Node.js)
  │  Claude Agent SDK query()
  ▼
Claude Code CLI  (your login, your plan)
  │
  ▼
Anthropic
```

## How it works

- `POST /v1/messages` turns the Messages API request into one Agent SDK turn. The client's system prompt replaces Claude Code's prompt, built-in tools are disabled, project settings/skills/MCP servers are not loaded, and the session is not persisted.
- Conversation history is replayed as a transcript on every request (the server is stateless). The final user turn, including images and documents, is passed through natively.
- Client-defined `tools` are exposed to Claude as an in-process MCP server. When Claude calls one, the server returns a normal `tool_use` block and stops the turn. The client executes the tool and sends a follow-up request containing `tool_result`.
- `GET /v1/models` asks the signed-in CLI which models the account can use.
- Authentication is the CLI's own: a `.credentials.json` in a Claude config directory. The CLI refreshes the token in place.

## Requirements

- Node.js 20+ (the Docker image uses Node 24).
- A Claude Pro/Max subscription, signed in with the Claude Code CLI. The SDK bundles a compatible Claude Code binary, so a separate install is optional.
- The server is intended for personal, small-scale use. Do not expose it to the internet.

## Quick start (Docker)

1. Sign in with Claude Code (on the host, once):

   ```bash
   claude auth login --claudeai
   # check with: claude auth status
   ```

2. Give the proxy its own Claude config directory containing the credentials:

   ```bash
   mkdir -p ~/.config/claude-sub-to-api
   cp ~/.claude/.credentials.json ~/.config/claude-sub-to-api/.credentials.json
   chmod 600 ~/.config/claude-sub-to-api/.credentials.json
   ```

3. Configure and start:

   ```bash
   cp .env.example .env
   # set PROXY_API_KEY, HOST_UID and HOST_GID (id -u / id -g)
   docker compose up -d --build
   ```

The container mounts `~/.config/claude-sub-to-api` at `/data` and uses it as `CLAUDE_CONFIG_DIR`. That directory must stay writable: the CLI writes refreshed tokens and its config file there.

> **Credential copies:** an OAuth refresh rotates the refresh token. A host-side copy of the same credentials becomes stale once the proxy refreshes it. While the proxy runs, let it own that copy; after signing in again on the host, copy the file over again.

## Usage

```bash
export PROXY_API_KEY=your-key

# Non-streaming
curl http://localhost:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"Say hi in one word."}]}'

# Streaming
curl -N http://localhost:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -d '{"model":"claude-opus-5-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'

# Models
curl http://localhost:8080/v1/models -H "x-api-key: $PROXY_API_KEY"

# Health (no auth)
curl http://localhost:8080/healthz
```

For SDKs and agent harnesses:

```
ANTHROPIC_BASE_URL=http://localhost:8080
ANTHROPIC_API_KEY=<your PROXY_API_KEY>
```

The consumer key is accepted as `x-api-key: <key>` or `Authorization: Bearer <key>`.

## Endpoints

| Method | Path           | Auth | Description |
|--------|----------------|------|-------------|
| POST   | `/v1/messages` | yes  | Anthropic Messages API, streaming and non-streaming. |
| GET    | `/v1/models`   | yes  | Models reported by the signed-in CLI (cached 10 minutes). |
| GET    | `/healthz`     | no   | 200 when a credential is present, 503 otherwise. |
| GET    | `/`            | no   | Name/version metadata. |

## Tools

Tools are always executed by the client, never by the proxy. Send definitions in `tools`; Claude's calls come back as `tool_use` blocks with `stop_reason: "tool_use"`. Append the assistant message and a `user` message containing `tool_result` blocks to the next request.

Tool names are translated to MCP-safe names internally and mapped back in responses, so clients see their original names and schemas.

`tool_choice` is supported as follows: `none` hides tools, `auto` is the normal behavior, and `any` / `tool` add a strong instruction but cannot force the underlying CLI's tool-selection mode.

## Configuration

All configuration is environment-based.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_KEY` | — (required) | Static key consumers present. |
| `LISTEN_ADDR` | `:8080` | Bind address. |
| `CREDENTIALS_PATH` | `/data/.credentials.json` | Credentials file; its directory becomes the Claude config dir. |
| `CLAUDE_CONFIG_DIR` | dirname of `CREDENTIALS_PATH` | Explicit Claude Code config directory. |
| `CLAUDE_CREDENTIALS_JSON` | — | Full credentials JSON, written to a temporary config dir. Takes precedence over `CREDENTIALS_PATH`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Long-lived token from `claude setup-token`, instead of a credentials file. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `MAX_CONCURRENCY` | `4` | Maximum simultaneous Claude Code processes. |
| `REQUEST_TIMEOUT_MS` | `900000` | Per-request upper bound. |
| `DEFAULT_MAX_TOKENS` | `8192` | Output ceiling when `max_tokens` is omitted (the Messages API requires it). |
| `CLAUDE_CWD` | process cwd | Working directory for the CLI. No project settings are loaded. |
| `CLAUDE_CODE_EXECUTABLE` | SDK default | Path to a specific Claude Code executable. |

## Migrating from v1

- Keep `PROXY_API_KEY`, `CREDENTIALS_PATH` and `CLAUDE_CREDENTIALS_JSON`; they mean the same thing.
- `UPSTREAM_BASE_URL`, `CLAUDE_UA`, `REFRESH_LEEWAY`, and `AUTO_KEEPALIVE` are gone. The SDK talks to Anthropic itself and the CLI refreshes the token.
- The `/v1/keepalive` endpoints are gone. They existed only to keep the reverse-engineered OAuth token chain warm.
- The container now needs a writable Claude config directory, not just a readable credentials file, because the CLI writes refreshed tokens there.
- Model IDs are whatever your account's CLI reports. `GET /v1/models` is authoritative.

## Differences from v1 / limitations

- No OAuth token endpoint calls, keepalive endpoints, or header/identity spoofing. The CLI owns authentication and refresh, so keepalive is unnecessary.
- No cross-request Claude session resume: each request is stateless and replays history. This is simple and correct, but does not keep Anthropic's prompt cache warm between requests.
- Sampling parameters (`temperature`, `top_p`, `top_k`) and `stop_sequences` are not exposed by the Agent SDK and are ignored. `max_tokens` sets the CLI's output ceiling.
- `metadata` is accepted but not forwarded.
- One Claude Code process is started per request. The first token latency includes process startup; memory use is roughly a few hundred MB per concurrent request.

## Local development

```bash
npm ci
npm run build
npm test
npm run typecheck

# Run locally against a credentials file
PROXY_API_KEY=dev-key \
  CREDENTIALS_PATH=$HOME/.claude/.credentials.json \
  LOG_LEVEL=debug \
  npm run dev
```

## Disclaimer

**This is an unofficial, community-maintained project.** It is not created, endorsed, sponsored by, or affiliated with Anthropic PBC. "Claude", "Claude Code", and "Anthropic" are trademarks of Anthropic PBC.

Anthropic documents third-party use of the Claude Agent SDK with a Claude plan in [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Such usage counts toward your plan's limits, and Anthropic has said billing for third-party apps may change. Review [Anthropic's Terms of Service](https://www.anthropic.com/legal/terms) and [Acceptable Use Policy](https://www.anthropic.com/legal/aup), and use this only for personal, permitted purposes. You are responsible for your own account.
