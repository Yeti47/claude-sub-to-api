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
- Prompts are delivered verbatim: Claude Code does not expand `@path` mentions, run slash commands, or inject its own per-turn context. Auto-compaction, CLAUDE.md discovery, user hooks, tool search, the advisor tool, away summaries, and the non-streaming/refusal fallbacks are disabled, so the response is shaped only by this proxy and the API client.
- Each conversation continues in a persisted Claude session, found by matching the request's history against recorded checkpoints. A live conversation keeps one Claude Code process alive between turns; it closes after `SESSION_IDLE_MS` idle and the next message resumes the saved session. Resuming it, together with `excludeDynamicSections`, keeps the harness prompt stable and produced real prompt-cache reads in testing.
- Conversation history is resumed from the bound Claude session when possible. Appended turns resume the session; a rewind or edit forks it at the last checkpoint whose complete history still matches, so earlier turns keep their transcript and prompt cache. With no matching checkpoint, the transcript is replayed into a fresh session. The final user turn, including images and documents, is passed through natively.
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

   The compose file publishes the port on `127.0.0.1` only. To reach the proxy from another machine, put a TLS reverse proxy in front of it or change the port mapping to `8080:8080`.

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
# Token estimate (see Limitations)
curl http://localhost:8080/v1/messages/count_tokens \
  -H "content-type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -d '{"model":"claude-opus-5-5","messages":[{"role":"user","content":"Say hi in one word."}]}'

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

The proxy finds the Claude session for a request by content. Each completed turn records a checkpoint in `STATE_PATH` (default `<claude config dir>/sub-to-api-sessions.json`): a fingerprint of the complete history through that turn (assistant replies included) and the transcript UUID of its final assistant message. A request continues from the latest checkpoint that matches a prefix of its `messages`, provided the model, system prompt and working directory are the same. No session header is needed for this, and requests that share a client session id but use another model or system prompt (title generation, subagents) get sessions of their own instead of displacing the main conversation's.

Requests also carry a conversation key: the `x-session-id`, `x-bf-session-id` or `x-claude-session-id` header, the `metadata.user_id.session_id` field, or finally a hash of the first user message, combined with the model and system prompt. It only orders requests: those with the same key run one at a time.

While a conversation is live, the proxy keeps one Claude process per session and pushes each new turn into its input stream. The process is closed after `SESSION_IDLE_MS` (5 minutes) of idle; the next request starts a new process and resumes the saved session. A request that changes the tools or `max_tokens` restarts the process on the same session; one that changes the model or system prompt starts a session of its own.

When a request extends the history of a session's last completed turn, the proxy resumes that session and sends only the new turn instead of replaying a reconstructed transcript. When the client rewinds, edits, retries or branches history, the proxy forks the session at the matching checkpoint and resumes the fork; earlier turns keep their transcript and prompt cache. A session is also forked, not resumed, while another request is still running on it. The same applies after a turn that failed, timed out or was aborted once its prompt had reached Claude: the transcript may then hold a partial exchange the client never saw, so the retry forks at the last completed turn instead of appending after it. Without a matching checkpoint (for example, the first user turn changed, or an earlier assistant reply was edited), it replays the transcript into a fresh session. Tool-result turns are handled by the parked-tool bridge below.

A checkpoint is written only when a turn completes. A turn that parks on a tool call adds no checkpoint; its continuation records one when it finishes. Checkpoints belong to the session that produced them and stay usable after a fork, so a later request can return to the original branch or fork an older session again. A conversation has no length limit; each session keeps its 100 most recent checkpoints, and the 300 most recently used sessions are kept for 30 days. The transcript of a session dropped from that list is deleted; a session that still has a live process is never dropped. State changes are written to `STATE_PATH` in the background, shortly after they happen, and once more on shutdown. If the proxy is killed instead of shut down, the last changes may be missing, so after such a start every stored session is forked at its checkpoint on next use rather than resumed.

This is the same mechanism [opencode-claude](https://github.com/openchamber/opencode-claude) uses. With the stable harness prompt (`excludeDynamicSections: true`) and resume, a live two-turn Haiku test showed real cache reuse:

- turn 1: `cache_read_input_tokens: 658`, `cache_creation_input_tokens: 2490`
- turn 2, resumed: `cache_read_input_tokens: 2813`, `cache_creation_input_tokens: 489`

An earlier build that replaced the harness prompt with a custom prompt reported no cache reads on resume. Keeping Claude Code's prompt and letting it move dynamic sections into the first message is what made the difference. It is still best-effort: the CLI controls breakpoint placement. Tool calls park the live turn, so the continuation keeps the same session and cache.

Prompt caching improves when:

- the client appends to history instead of rewriting it;
- the system prompt and model stay the same for the conversation;
- the conversation is not idle long enough for the cache to expire.

When Claude calls a client tool, the proxy does not end the CLI turn. The MCP handler blocks, the `tool_use` response is sent, and the process stays alive. The follow-up request is matched to that process by its `tool_use_id`s: it resolves the handlers and continues the same live turn, so the session and cache stay intact. The streamed `message_stop` of a tool-call message is sent only once the turn is parked, so results sent immediately always find it. A follow-up that answers only some of the calls is rejected with a 400 and the turn stays parked. A request whose history shows the client moved past a tool call without answering it closes the turn parked on that call. Tool results that arrive with a different model, system prompt or tool set than the parked turn was started with do not continue it; that turn is closed and the request is handled like a rewritten history. A turn nobody resumes is closed after `PARKED_TURN_TTL_MS` (30 minutes by default), or earlier when its process slot is needed (see `PARKED_EVICTABLE_AFTER_MS`).

## Compaction

Clients that compact their own history need nothing from the proxy: the rewritten history is replayed into a fresh session.

[On-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand) is supported. A request with `"compaction": {"type": "summarize"}` is answered with a single `compaction` block and `stop_reason: "compaction"` instead of a reply; `instructions` replaces the default summarization prompt. The summary is written by one more turn on the conversation's session, so it reads the history from the prompt cache, and that turn's usage is reported in `usage.iterations`. Send the block back first in `messages`, in place of the messages it summarizes; Claude then receives the summary there. The `anthropic-beta` header is not required.

As with the Messages API, no summary comes back when the turn is cut off, refused or calls a tool: the response is a `200` with empty `content` and the `stop_reason` the turn ended with. The request is rejected with a `400` when it is combined with `context_management`, `stop_sequences`, a `tool_choice` of `any` or `tool`, or `output_config.format`, or when the last assistant turn has a tool call without a result.

Differences from the Messages API:

- The block's `signature` is a checksum and is not verified. A block issued by the Messages API is accepted too.
- A streamed compaction sends `message_start` when the summarizing turn starts and the block when it is done.
- Threshold compaction (a `compact_20260112` edit in `context_management`) is not supported. The edit is ignored and logged once as a warning, so the conversation is never compacted for the client: it has to compact on demand or by itself before the context window fills up. Other `context_management` edits are ignored as well.

## Configuration

All configuration is environment-based.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_KEY` | — (required) | Static key consumers present. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — (required) | Long-lived token from `claude setup-token`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Writable directory for the CLI's `.claude.json`, session transcripts, and state. `/data` in Docker. |
| `LISTEN_ADDR` | `127.0.0.1:8080` | Bind address. Loopback only by default; the Docker image sets `:8080`. Use `:8080` or `0.0.0.0:8080` to accept connections from other machines, preferably behind a TLS reverse proxy. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `MAX_CONCURRENCY` | `4` | Maximum simultaneous live Claude Code processes. |
| `REQUEST_TIMEOUT_MS` | `900000` | Per-request upper bound. |
| `DEFAULT_MAX_TOKENS` | `8192` | Output ceiling when `max_tokens` is omitted (the Messages API requires it). |
| `CLAUDE_CWD` | process cwd | Working directory for the CLI. Use a neutral empty directory for an API-only setup; it keeps repository context out of the prompt. |
| `STATE_PATH` | `<claude config dir>/sub-to-api-sessions.json` | Persisted Claude sessions and their checkpoints. |
| `PARKED_TURN_TTL_MS` | `1800000` | How long a tool turn waits for `tool_result` before its process is closed (`0` disables). |
| `PARKED_EVICTABLE_AFTER_MS` | `60000` | How long a parked tool turn is safe from being closed to free a process for a waiting request (`0` never evicts). |
| `QUEUE_TIMEOUT_MS` | `30000` | How long a request waits for a free process before it gets a `529` (`0` waits until `REQUEST_TIMEOUT_MS`). |
| `SESSION_IDLE_MS` | `300000` | How long an idle conversation keeps its Claude process alive (`0` closes it immediately). |
| `CLAUDE_CODE_MAX_RETRIES` | `0` | CLI API retries. Keep `0` so one API request maps to one model response; clients own retries. |

## Limitations

- Authentication is a long-lived `CLAUDE_CODE_OAUTH_TOKEN`; the proxy does not refresh or persist it.
- Session resume and checkpoint forks are best-effort: a missing session file, a changed model/system prompt, or a rewrite with no matching checkpoint (including an edited earlier assistant reply) falls back to replaying the transcript. A failed fork also falls back to a fresh session. Cache reads still depend on the CLI's own cache-breakpoint placement.
- Sampling parameters (`temperature`, `top_p`, `top_k`) and `stop_sequences` are not exposed by the Agent SDK and are ignored. `max_tokens` sets the CLI's output ceiling; models that reason even with thinking disabled can spend part of that ceiling before answering, so the proxy gives short requests a 1024-token floor.
- Thinking blocks are returned only when the request asks for thinking. Some models reason internally even when it is off; those blocks are dropped.
- Errors use Anthropic's error body and status codes. A streaming request is not answered with `200` until its first event exists, so a failure before that (rate limit, authentication, an invalid request) is a normal HTTP error response, with `retry-after` on a `429` when the subscription's reset time is known. A failure after the stream started is sent as an `error` event.
- `POST /v1/messages/count_tokens` returns an estimate from the request's size (about 3 characters per token, a flat cost per image or document), not Claude's tokenizer. It is meant for clients that use the number to decide when to compact, and errs on the high side. It does not include the Claude Code harness prompt.
- Images and documents are passed through as native content blocks. An unprocessable attachment becomes a `400 invalid_request_error`.
- `metadata` is used only to derive a conversation key; it is not forwarded.
- The CLI attaches its own environment/account context (working directory, plan tokens, email) to the prompt. `CLAUDE_CWD` controls the directory it sees.
- One Claude Code process per active conversation, kept for `SESSION_IDLE_MS` (5 minutes) after a turn. `MAX_CONCURRENCY` caps live processes; a request that needs a process when none is free closes the least-recently-used idle one, or else a tool turn that has been parked for longer than `PARKED_EVICTABLE_AFTER_MS` (its tool results are then replayed into a fork of the session). Otherwise it waits, and after `QUEUE_TIMEOUT_MS` is answered with `529 overloaded_error` and `retry-after`. Memory is roughly a few hundred MB per live process.

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
