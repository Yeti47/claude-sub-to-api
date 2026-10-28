# claude-sub-to-api

An **Anthropic Messages API-compatible HTTP server** backed by a **Claude subscription** (Pro/Max), running the official Claude Code CLI through Anthropic's [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

The only credential is a long-lived `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. The proxy does not read, copy, or refresh `.credentials.json` files.

```
your agent / SDK
  │  Anthropic Messages API (/v1/messages)
  ▼
claude-sub-to-api  (Node.js)
  │  Claude Agent SDK query()
  ▼
Claude Code CLI  (your setup-token, your plan)
  │
  ▼
Anthropic
```

## How it works

- `POST /v1/messages` turns the Messages API request into one Agent SDK turn. Claude runs with its normal Claude Code harness prompt; the client's system prompt is appended as turn instructions and takes precedence for that request. Built-in tools are disabled, and project settings/skills/MCP servers are not loaded.
- The model is told plainly that it runs in `claude-sub-to-api` through the Claude Code harness, and that the tools come from the API client. Nothing pretends to be the Anthropic API or hides the harness.
- Each conversation is bound to a persisted Claude session when possible. Resuming it, together with `excludeDynamicSections`, keeps the harness prompt stable and produced real prompt-cache reads in testing.
- Conversation history is resumed from the bound Claude session when possible; otherwise it is replayed as a transcript. The final user turn, including images and documents, is passed through natively.
- Client-defined `tools` are exposed to Claude as an in-process MCP server. When Claude calls one, the server returns a normal `tool_use` block and stops the turn. The client executes the tool and sends a follow-up request containing `tool_result`.
- `GET /v1/models` asks the signed-in CLI which models the account can use.
- Authentication is a single `CLAUDE_CODE_OAUTH_TOKEN`. The config directory only holds the CLI's onboarding flag, session transcripts, and local state.

## Requirements

- Node.js 20+ (the Docker image uses Node 24).
- A Claude Pro/Max subscription and a token from `claude setup-token`. Run it once on a machine with browser access; no Claude Code login is needed on the proxy host.
- The server is intended for personal, small-scale use. Do not expose it to the internet.

## Quick start (Docker)

1. Create a long-lived token on a machine with browser access:

   ```bash
   claude setup-token
   # if the CLI is not installed: npm install -g @anthropic-ai/claude-code
   ```

   Complete the browser login and copy the token. It lasts about a year; run the command again when it expires. The proxy does not refresh it.

2. Configure the proxy:

   ```bash
   mkdir -p ~/.config/claude-sub-to-api
   cp .env.example .env
   # set PROXY_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, HOST_UID and HOST_GID
   # (run id -u / id -g for the UID/GID)
   ```

3. Start it:

   ```bash
   docker compose up -d --build
   ```

The container mounts `~/.config/claude-sub-to-api` at `/data` and uses it as `CLAUDE_CONFIG_DIR`. The token is passed in the environment, not written to disk. The proxy writes `.claude.json` in that directory (`/data/.claude.json`) with `"hasCompletedOnboarding": true` so the CLI starts headlessly; the same directory also holds session transcripts used for resume. It must stay writable.

When `CLAUDE_CONFIG_DIR` is not set (for example in local development), the CLI keeps `.claude.json` in `$HOME` and its state in `~/.claude`; the proxy follows the same layout.

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

## No disguise

This is a community proxy, not Anthropic software. The model is told that plainly:

- It runs in **claude-sub-to-api**, through the **Claude Code harness**.
- Claude Code's built-in tools (Bash, Read, Edit, …) are disabled. Tools in a request come from the API client, which executes them and returns the results in a later message.
- If asked what it is running in, it should say so rather than claim to be Claude Code or imply the API client is Claude Code.

The proxy does not fake Claude Code headers, does not send a synthetic Claude Code identity marker, and does not replace Claude Code's system prompt. It uses the normal harness prompt and appends the client's instructions. Tool definitions are exposed to the model as `mcp__claude_sub_to_api__<name>`; responses map them back to the names the client sent.

One consequence is that the harness prompt is coding-oriented and the CLI attaches workspace context. With no client system prompt, Claude may talk about the working directory or repository. Set `CLAUDE_CWD` to a neutral directory if that is not wanted.

## Session resume and prompt caching

Every request carries a conversation key: the `x-session-id`, `x-bf-session-id` or `x-claude-session-id` header, the `metadata.user_id.session_id` field, or finally a hash of the first user message. The server persists a binding from that key to the Claude Code session id in `STATE_PATH` (default `<claude config dir>/sub-to-api-sessions.json`).

When the next request's user turns extend the bound history, the proxy resumes the same Claude session and sends only the new turn instead of replaying a reconstructed transcript. A changed model, system prompt, shortened/edited history, retry with no new user turn, or a tool-result turn starts a fresh session and falls back to the transcript path.

This is the same mechanism [opencode-claude](https://github.com/openchamber/opencode-claude) uses. With the stable harness prompt (`excludeDynamicSections: true`) and resume, a live two-turn Haiku test showed real cache reuse:

- turn 1: `cache_read_input_tokens: 658`, `cache_creation_input_tokens: 2490`
- turn 2, resumed: `cache_read_input_tokens: 2813`, `cache_creation_input_tokens: 489`

An earlier build that replaced the harness prompt with a custom prompt reported no cache reads on resume. Keeping Claude Code's prompt and letting it move dynamic sections into the first message is what made the difference. It is still best-effort: the CLI controls breakpoint placement, and a tool-result turn starts a fresh session today.

Prompt caching improves when:

- the client sends a stable session header (much better than the first-message hash);
- the system prompt and model stay the same for the conversation;
- the client appends to history instead of rewriting it;
- the conversation is not idle long enough for the cache to expire.

Tool-result turns currently start a fresh session because the tool call is ended before the client returns the result. A future step is to park the tool call and resume the same live turn, which is what opencode-claude's bridge does.

## Configuration

All configuration is environment-based.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_KEY` | — (required) | Static key consumers present. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — (required) | Long-lived token from `claude setup-token`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Writable directory for the CLI's `.claude.json`, session transcripts, and state. `/data` in Docker. |
| `LISTEN_ADDR` | `:8080` | Bind address. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `MAX_CONCURRENCY` | `4` | Maximum simultaneous Claude Code processes. |
| `REQUEST_TIMEOUT_MS` | `900000` | Per-request upper bound. |
| `DEFAULT_MAX_TOKENS` | `8192` | Output ceiling when `max_tokens` is omitted (the Messages API requires it). |
| `CLAUDE_CWD` | process cwd | Working directory for the CLI. Use a neutral empty directory for an API-only setup; it keeps repository context out of the prompt. |
| `CLAUDE_CODE_EXECUTABLE` | SDK default | Path to a specific Claude Code executable. |
| `STATE_PATH` | `<claude config dir>/sub-to-api-sessions.json` | Persisted conversation → Claude session bindings. |
| `CLAUDE_CODE_MAX_RETRIES` | `0` | CLI API retries. Keep `0` so one API request maps to one model response; clients own retries. |

## Limitations

- Authentication is a long-lived `CLAUDE_CODE_OAUTH_TOKEN`; the proxy does not refresh or persist it.
- Session resume is best-effort: a missing session file, a changed model/system prompt, edited history, or a tool-result turn falls back to replaying the transcript. Cache reads still depend on the CLI's own cache-breakpoint placement.
- Sampling parameters (`temperature`, `top_p`, `top_k`) and `stop_sequences` are not exposed by the Agent SDK and are ignored. `max_tokens` sets the CLI's output ceiling; models that reason even with thinking disabled can spend part of that ceiling before answering, so the proxy gives short requests a 1024-token floor.
- Thinking blocks are returned only when the request asks for thinking. Some models reason internally even when it is off; those blocks are dropped.
- Images and documents are passed through as native content blocks. An unprocessable attachment becomes a `400 invalid_request_error`.
- `metadata` is used only to derive a conversation key; it is not forwarded.
- The CLI attaches its own environment/account context (working directory, plan tokens, email) to the prompt. `CLAUDE_CWD` controls the directory it sees.
- One Claude Code process is started per request. The first token latency includes process startup; memory use is roughly a few hundred MB per concurrent request.

## Secret scanning

CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on pushes, pull requests, and on demand. The rule set and the two historical allowlists are in `.gitleaks.toml`.

To scan locally (requires the `gitleaks` CLI):

```bash
npm run secrets
# or
gitleaks detect --source . --config .gitleaks.toml --redact --verbose
```

## Local development

```bash
npm ci
npm run build
npm test
npm run typecheck

# Run locally with a setup-token
PROXY_API_KEY=dev-key \
  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
  LOG_LEVEL=debug \
  npm run dev
```

## Disclaimer

**This is an unofficial, community-maintained project.** It is not created, endorsed, sponsored by, or affiliated with Anthropic PBC. "Claude", "Claude Code", and "Anthropic" are trademarks of Anthropic PBC.

Anthropic documents third-party use of the Claude Agent SDK with a Claude plan in [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Such usage counts toward your plan's limits, and Anthropic has said billing for third-party apps may change. Review [Anthropic's Terms of Service](https://www.anthropic.com/legal/terms) and [Acceptable Use Policy](https://www.anthropic.com/legal/aup), and use this only for personal, permitted purposes. You are responsible for your own account.
