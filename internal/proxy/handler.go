// Package proxy forwards Anthropic-compatible requests to the real Anthropic API,
// authenticating with the user's Claude subscription OAuth token.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.uber.org/zap"
)

// tokenProvider supplies a valid OAuth access token.
type tokenProvider interface {
	AccessToken(ctx context.Context) (string, error)
}

// Handler proxies /v1/* requests to the upstream Anthropic API.
type Handler struct {
	upstreamBase string
	tp           tokenProvider
	userAgent    string
	client       *http.Client
	log          *zap.Logger
}

// NewHandler builds a Handler.
func NewHandler(upstreamBase string, tp tokenProvider, userAgent string, log *zap.Logger) *Handler {
	return &Handler{
		upstreamBase: strings.TrimRight(upstreamBase, "/"),
		tp:           tp,
		userAgent:    userAgent,
		client:       &http.Client{Timeout: 0}, // no overall timeout; streaming can be long-lived
		log:          log,
	}
}

// requiredBetas must always be present for OAuth-subscription requests to be accepted.
// Mirrors the genuine Claude Code request fingerprint.
var requiredBetas = []string{
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
}

// anthropicVersion is the API version genuine Claude Code clients send.
const anthropicVersion = "2023-06-01"

// claudeCodeSystemPrompt is the identity marker Anthropic requires as the first
// element of the system array for OAuth-subscription (Claude Code) requests.
const claudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."

// ServeHTTP forwards the request upstream and streams the response back.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	// Read the body so we can replay it on a 401 retry.
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "invalid_request_error", "could not read request body")
		return
	}
	defer r.Body.Close()

	stream := isStreamRequest(body)

	// Anthropic's subscription endpoint only accepts requests whose system array
	// begins with the Claude Code identity marker; inject it before forwarding.
	body = ensureClaudeCodeSystemPrompt(body)

	status, usage, errBody, err := h.forward(w, r, body, stream)
	if err != nil {
		h.log.Error("upstream request failed", zap.Error(err), zap.String("path", r.URL.Path))
		h.writeError(w, http.StatusBadGateway, "api_error", "upstream request failed: "+err.Error())
		return
	}

	// One transparent retry after a forced token refresh on 401.
	if status == http.StatusUnauthorized {
		h.log.Info("upstream returned 401, refreshing token and retrying once", zap.String("path", r.URL.Path))
		// Re-fetch a token; the manager re-reads the file / refreshes as needed.
		status, usage, errBody, err = h.forward(w, r, body, stream)
		if err != nil {
			h.log.Error("upstream retry failed", zap.Error(err), zap.String("path", r.URL.Path))
			h.writeError(w, http.StatusBadGateway, "api_error", "upstream request failed: "+err.Error())
			return
		}
	}

	fields := []zap.Field{
		zap.String("method", r.Method),
		zap.String("path", r.URL.Path),
		zap.Int("status", status),
		zap.Bool("stream", stream),
		zap.Duration("latency", time.Since(start)),
	}
	if usage != nil {
		fields = append(fields,
			zap.Int64("input_tokens", usage.InputTokens),
			zap.Int64("output_tokens", usage.OutputTokens),
			zap.String("model", usage.Model),
		)
	}
	if len(errBody) > 0 {
		// Upstream error body explains 4xx/5xx causes (rate limit type, model gating, etc.).
		fields = append(fields, zap.String("upstream_error", truncateStr(string(errBody), 500)))
	}
	h.log.Info("request completed", fields...)
}

// forward performs a single upstream round-trip. On success it writes the response
// to w and returns the upstream status, (optionally) parsed usage, and the upstream
// error body (only populated for status >= 400, for diagnostics).
func (h *Handler) forward(w http.ResponseWriter, r *http.Request, body []byte, stream bool) (int, *Usage, []byte, error) {
	token, err := h.tp.AccessToken(r.Context())
	if err != nil {
		return 0, nil, nil, fmt.Errorf("obtain access token: %w", err)
	}

	upstreamURL := h.upstreamBase + r.URL.RequestURI()
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("build upstream request: %w", err)
	}

	// Copy inbound headers, then override auth/identity.
	copyHeaders(req.Header, r.Header)
	req.Header.Del("Authorization")
	req.Header.Del("X-Api-Key")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", h.userAgent)
	req.Header.Set("anthropic-version", anthropicVersion)
	req.Header.Set("anthropic-beta", mergeBetas(r.Header.Get("anthropic-beta"), requiredBetas))

	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("call upstream: %w", err)
	}
	defer resp.Body.Close()

	// Copy response headers.
	copyHeaders(w.Header(), resp.Header)
	if stream && resp.StatusCode < 400 {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
	}
	w.WriteHeader(resp.StatusCode)

	// For error responses, buffer the body so it can be logged for diagnosis,
	// while still forwarding it verbatim to the client.
	if resp.StatusCode >= 400 {
		errBody, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if rerr != nil {
			return resp.StatusCode, nil, nil, fmt.Errorf("read upstream error body: %w", rerr)
		}
		_, _ = w.Write(errBody)
		return resp.StatusCode, nil, errBody, nil
	}

	var usage *Usage
	if stream {
		usage = streamAndParseUsage(resp.Body, w)
	} else {
		usage, err = copyAndParseUsage(resp.Body, w)
		if err != nil {
			return resp.StatusCode, nil, nil, fmt.Errorf("read upstream response: %w", err)
		}
	}
	return resp.StatusCode, usage, nil, nil
}

// ensureClaudeCodeSystemPrompt prepends the Claude Code identity marker to the
// request's system array if it is not already present. Anthropic rejects
// OAuth-subscription requests that lack it. On any parse ambiguity it returns
// the body unchanged.
func ensureClaudeCodeSystemPrompt(body []byte) []byte {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return body
	}
	marker := json.RawMessage(`{"type":"text","text":"` + claudeCodeSystemPrompt + `"}`)

	raw, hasSystem := msg["system"]
	if !hasSystem || len(raw) == 0 || string(raw) == "null" {
		msg["system"] = json.RawMessage(`[` + string(marker) + `]`)
		return marshalOrOriginal(msg, body)
	}

	// system as an array: prepend the marker unless already first.
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		if len(arr) > 0 && strings.Contains(string(arr[0]), claudeCodeSystemPrompt) {
			return body // already present
		}
		arr = append([]json.RawMessage{marker}, arr...)
		b, err := json.Marshal(arr)
		if err != nil {
			return body
		}
		msg["system"] = b
		return marshalOrOriginal(msg, body)
	}

	// system as a plain string: convert to [marker, original-text].
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return body
	}
	if strings.Contains(s, claudeCodeSystemPrompt) {
		return body
	}
	txt, _ := json.Marshal(s)
	msg["system"] = json.RawMessage(`[` + string(marker) + `,{"type":"text","text":` + string(txt) + `}]`)
	return marshalOrOriginal(msg, body)
}

func marshalOrOriginal(msg map[string]json.RawMessage, orig []byte) []byte {
	b, err := json.Marshal(msg)
	if err != nil {
		return orig
	}
	return b
}

// truncateStr shortens s to at most n bytes for logging.
func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// isStreamRequest detects `"stream": true` in the request body.
func isStreamRequest(body []byte) bool {
	return bytes.Contains(body, []byte(`"stream":true`)) ||
		bytes.Contains(body, []byte(`"stream": true`))
}

// mergeBetas returns the client's betas plus any required ones, de-duplicated.
func mergeBetas(clientBeta string, required []string) string {
	seen := map[string]bool{}
	var out []string
	for _, b := range required {
		if !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	for _, b := range strings.Split(clientBeta, ",") {
		b = strings.TrimSpace(b)
		if b != "" && !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	return strings.Join(out, ",")
}

var hopByHop = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		if hopByHop[http.CanonicalHeaderKey(k)] {
			continue
		}
		dst.Del(k)
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// writeError emits an Anthropic-shaped error. If headers were already sent it is a no-op.
func (h *Handler) writeError(w http.ResponseWriter, status int, errType, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"type":"error","error":{"type":%q,"message":%q}}`, errType, msg)
}
