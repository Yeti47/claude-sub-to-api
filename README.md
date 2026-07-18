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

| Method | Path           | Auth | Description                                   |
|--------|----------------|------|-----------------------------------------------|
| POST   | `/v1/messages` | yes  | Anthropic Messages API (stream + non-stream). |
| GET    | `/v1/models`   | yes  | Model list (proxied from upstream).           |
| GET    | `/healthz`     | no   | Liveness probe.                               |

## Configuration

All configuration is via environment variables.

| Variable            | Default                     | Description                                            |
|---------------------|-----------------------------|--------------------------------------------------------|
| `PROXY_API_KEY`     | — (required)                | Static key consumers must present.                     |
| `LISTEN_ADDR`       | `:8080`                     | Address the server binds to.                           |
| `UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Anthropic API base URL.                                |
| `CREDENTIALS_PATH`  | `/data/.credentials.json`   | Path to the externally-generated credentials file.     |
| `LOG_LEVEL`         | `info`                      | `debug`, `info`, `warn`, or `error`.                   |
| `CLAUDE_UA`         | `claude-cli/2.1.44`         | User-Agent sent to the upstream API.                   |
| `REFRESH_LEEWAY`    | `60s`                       | How long before token expiry a refresh is triggered.   |

## Token refresh & re-auth

- The proxy refreshes the OAuth access token automatically before it expires and writes the rotated credentials back to the file.
- If you re-run `claude login` externally while the proxy is running, the proxy detects the changed file and picks up the new credentials without a restart.

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

## Scope & limitations

- **Single account.** One credentials file = one subscription.
- **Full pass-through** of Anthropic request features (thinking, tool use, prompt caching, custom `anthropic-beta` headers).
- Not included (by design, for a first version): multi-account rotation, rate limiting, per-key usage metering, an OpenAI-compatible endpoint, or a web UI.

## Disclaimer

This proxies your personal Claude subscription through Anthropic's OAuth flow. Review Anthropic's terms of service before using it for anything beyond personal, permitted use.
