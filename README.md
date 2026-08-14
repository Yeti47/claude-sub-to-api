# claude-sub-to-api

A small Dockerized Go proxy that lets you use a **Claude subscription** (Max/Pro) through an **Anthropic-compatible HTTP API** — so any agent harness that expects an Anthropic API key can run on your subscription instead.

The proxy does **not** perform the OAuth login itself. You authenticate externally (Claude Code CLI or the VS Code extension), which writes `~/.claude/.credentials.json`, and you drop that file into the proxy's data volume. The proxy keeps the token refreshed automatically.

## How it works

1. You log in with Claude Code (`claude login`) or the VS Code extension → this writes `~/.claude/.credentials.json`.
2. You copy that file into the proxy's data volume.
3. The proxy serves `POST /v1/messages` (streaming + non-streaming) and `GET /v1/models`, injecting your OAuth token and the required `anthropic-beta` headers, forwarding to `https://api.anthropic.com`, and refreshing the token transparently.
4. Consumers authenticate to the proxy with a single static API key (`PROXY_API_KEY`).

## Quick start

```bash
# 1. Authenticate externally (one of):
claude login                                   # Claude Code CLI
# or sign in via the Claude VS Code extension

# 2. Copy your credentials into the proxy data directory
mkdir -p ~/.config/claude-sub-to-api
cp ~/.claude/.credentials.json ~/.config/claude-sub-to-api/.credentials.json
chmod 600 ~/.config/claude-sub-to-api/.credentials.json

# 3. Configure the consumer API key and host UID/GID (needed so the
#    container can read the bind-mounted credentials file)
cp .env.example .env
# edit .env – set PROXY_API_KEY and HOST_UID/HOST_GID (run id -u / id -g)

# 4. Run
docker compose up -d --build
```

If you keep the credentials elsewhere, update the bind-mount path in
`docker-compose.yml` (the `volumes:` section) to point to your directory.

## Usage

Point any Anthropic-compatible client at the proxy. For example with `curl`:

```bash
export PROXY_API_KEY=your-key

# Non-streaming
curl http://localhost:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-8","max_tokens":64,"messages":[{"role":"user","content":"Say hi in one word."}]}'

# Streaming
curl http://localhost:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-8","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Count to three."}]}'

# Models
curl http://localhost:8080/v1/models -H "x-api-key: $PROXY_API_KEY"

# Health (no auth)
curl http://localhost:8080/healthz
```

For SDKs / agent harnesses, set:

```
ANTHROPIC_BASE_URL=http://localhost:8080
ANTHROPIC_API_KEY=<your PROXY_API_KEY>
```

The consumer key is accepted as `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Endpoints

| Method | Path                    | Auth | Description                                   |
|--------|-------------------------|------|-----------------------------------------------|
| POST   | `/v1/messages`          | yes  | Anthropic Messages API (stream + non-stream). |
| GET    | `/v1/models`            | yes  | Model list (proxied from upstream).           |
| GET    | `/v1/keepalive`         | yes  | One-shot forced token rotation (pulse).       |
| POST   | `/v1/keepalive/auto`    | yes  | Enable auto-keepalive (idempotent).           |
| DELETE | `/v1/keepalive/auto`    | yes  | Disable auto-keepalive (idempotent).          |
| GET    | `/healthz`              | no   | Liveness probe. Reports 503 if the token is missing or invalid. |

## Keepalive

Normal request handling refreshes the OAuth token **lazily**: only when a
request needs it and the token is within `REFRESH_LEEWAY` of expiring.
Keepalive is different — every pulse performs a **real token rotation** at the
OAuth token endpoint (`https://console.anthropic.com/v1/oauth/token`),
**independent of `REFRESH_LEEWAY`**. This keeps the token and its refresh-token
chain perpetually fresh even while the proxy is completely idle (e.g. to keep
an external re-auth session alive).

Two options:

- **One-shot pulse** — `GET /v1/keepalive` forces a single token rotation
  (returns `503` if the rotation fails). Useful for cron/Uptime-Kuma style
  schedulers. It also reports when the token should be rotated again.
- **Auto-keepalive** — a background goroutine forces a rotation immediately on
  enable, then self-schedules: each rotation reports the timestamp at which the
  next one should happen (the token's expiry minus `REFRESH_LEEWAY`, already
  factored in), so the cadence follows the token's own lifetime rather than a
  fixed interval. It can be enabled at startup via `AUTO_KEEPALIVE=true`, or
  toggled at runtime:

  ```bash
  export PROXY_API_KEY=your-key

  # Enable (idempotent)
  curl -X POST http://localhost:8080/v1/keepalive/auto -H "x-api-key: $PROXY_API_KEY"

  # Status / one-shot pulse
  curl http://localhost:8080/v1/keepalive -H "x-api-key: $PROXY_API_KEY"

  # Disable (idempotent)
  curl -X DELETE http://localhost:8080/v1/keepalive/auto -H "x-api-key: $PROXY_API_KEY"
  ```

  All three endpoints return `{"status":"ok","auto_keepalive":<bool>}`; the
  pulse response also includes `next_refresh_at` (RFC3339), the time at which
  the token should be rotated again.

> **Note:** every pulse hits the OAuth token endpoint and issues a fresh access
> token plus a brand-new refresh token, invalidating the previous refresh
> token. If another process (e.g. Claude Code CLI) shares the same credentials
> file, each rotation can invalidate that process's refresh token — an
> unavoidable consequence of keeping the session perpetually fresh.

## Configuration

All configuration is via environment variables.

| Variable            | Default                     | Description                                            |
|---------------------|-----------------------------|--------------------------------------------------------|
| `PROXY_API_KEY`     | — (required)                | Static key consumers must present.                     |
| `LISTEN_ADDR`       | `:8080`                     | Address the server binds to.                           |
| `UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Anthropic API base URL.                                |
| `CREDENTIALS_PATH`  | `/data/.credentials.json`   | Path to the externally-generated credentials file.     |
| `CLAUDE_CREDENTIALS_JSON` | —                    | Full JSON content of `~/.claude/.credentials.json`, for serverless deployments (Azure ACA, etc.) with no writable credentials file. Takes precedence over `CREDENTIALS_PATH` when set. |
| `LOG_LEVEL`         | `info`                      | `debug`, `info`, `warn`, or `error`.                   |
| `CLAUDE_UA`         | `claude-cli/2.1.44`         | User-Agent sent to the upstream API.                   |
| `REFRESH_LEEWAY`    | `60s`                       | How long before token expiry a refresh is triggered.   |
| `AUTO_KEEPALIVE`    | `false`                     | Start the auto-keepalive goroutine at boot (`true`/`1`).|

The auto-keepalive cadence is not configured: each rotation reports when the
next one should happen (expiry minus `REFRESH_LEEWAY`), so it follows the
token's own lifetime.

## Token refresh & re-auth

- The proxy refreshes the OAuth access token automatically before it expires and writes the rotated credentials back to the file.
- If you re-run `claude login` externally while the proxy is running, the proxy detects the changed file and picks up the new credentials without a restart.

## Serverless deployments (env-var credentials)

For serverless containers without a writable credentials file (e.g. Azure
Container Apps), you can pass the entire contents of
`~/.claude/.credentials.json` via the `CLAUDE_CREDENTIALS_JSON` env var. When
set, it takes precedence over `CREDENTIALS_PATH` and no data volume is needed:

```bash
CLAUDE_CREDENTIALS_JSON='{"claudeAiOauth":{"accessToken":"sk-ant-oat...","refreshToken":"sk-ant-ort...","expiresAt":1893456000000}}' \
  PROXY_API_KEY=dev-key go run ./cmd/claude-sub-to-api
```

Notes:
- Set it directly from the file: `CLAUDE_CREDENTIALS_JSON="$(cat ~/.claude/.credentials.json)"`.
- Refreshed tokens are rotated **in memory only** — they are not written back
  to the env var. If the container restarts, it will use the original tokens
  from the env var again (the access token is simply re-refreshed on demand).
- File re-auth detection does not apply; restart the container with updated env
  vars to pick up new credentials.

## Local development

```bash
# Build
go build ./...

# Vet + tests
go vet ./...
go test ./...

# Run locally (needs a credentials file)
PROXY_API_KEY=dev-key CREDENTIALS_PATH=~/.claude/.credentials.json go run ./cmd/claude-sub-to-api
```

## Integration tests (Bifrost gateway)

There's an end-to-end integration test that runs the proxy against a real
[Bifrost](https://github.com/maximhq/bifrost) gateway (in Docker) that is
configured to use the proxy as its Anthropic provider, with a **virtual key**
(governance) — mirroring a real Bifrost harness setup. It exercises both the
unified OpenAI-compatible surface (`/v1/chat/completions` with
`anthropic/<model>`) and the native Anthropic surface
(`/anthropic/v1/messages`).

Each surface is tested in **non-streaming** and **streaming** (`stream: true`)
modes, so SSE forwarding is covered end to end.

Prerequisites: `docker`, and your Claude subscription credentials file. The
test skips itself if either is missing.

```bash
CLAUDE_CREDENTIALS_PATH=~/.config/claude-sub-to-api/.credentials.json \
  go test -tags integration ./internal/proxy -run TestBifrostIntegration -v -timeout 20m
```

The test pulls `maximhq/bifrost:latest` on first run and downloads the model
catalog, so the first run can take a few minutes; subsequent runs are faster.

## Disclaimer

**This is an unofficial, community-maintained project.** It is **not** created by, endorsed by, sponsored by, or affiliated with Anthropic PBC or claude.ai in any way. "Claude" and "Anthropic" are trademarks of Anthropic PBC.

This project is intended for **small-scale, experimental, and research purposes only** — e.g. prototyping tool integrations, exploring agent architectures, or personal tinkering. It is **not** designed for production workloads, high-throughput usage, or anything that would compete with Anthropic's own API offerings.

This tool proxies your personal Claude subscription through Anthropic's OAuth flow. **We strongly advise you to review and comply with [Anthropic's Terms of Service](https://www.anthropic.com/legal/terms) and [Acceptable Use Policy](https://www.anthropic.com/legal/aup) before using this software.** Use it only for personal, permitted purposes — any usage that violates Anthropic's terms is your own responsibility.

If you need reliable, scalable programmatic access to Claude, you should acquire the appropriate API license directly from Anthropic. See [Anthropic's API plans & pricing](https://www.anthropic.com/pricing) to choose the tier that fits your needs.
