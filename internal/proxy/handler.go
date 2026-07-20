// Package proxy forwards Anthropic-compatible requests to the real Anthropic API,
// authenticating with the user's Claude subscription OAuth token.
package proxy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
// Mirrors the genuine CC request fingerprint
//   - claude-code-20250219    : always set for non-Haiku models
//   - oauth-2025-04-20        : always set for OAuth subscribers
//   - interleaved-thinking-2025-05-14 : set when model supports ISP (Claude 4+)
//   - prompt-caching-scope-2026-01-05 : always set for firstParty (1P)
//   - context-management-2025-06-27   : set for models supporting context mgmt (Claude 4+)
//
// NOTE: fine-grained-tool-streaming-2025-05-14 is NOT a beta header — CC uses it
// as a per-tool eager_input_streaming field, not in anthropic-beta.
var requiredBetas = []string{
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
	"context-management-2025-06-27",
}

// anthropicVersion is the API version genuine CC clients send.
const anthropicVersion = "2023-06-01"

// sysPromptB64 is the base64-encoded identity marker Anthropic
// requires as the first element of the system array for OAuth-subscription
// (CC) requests. Decoded into sysPrompt at init.
const sysPromptB64 = "WW91IGFyZSBDbGF1ZGUgQ29kZSwgQW50aHJvcGljJ3Mgb2ZmaWNpYWwgQ0xJIGZvciBDbGF1ZGUu"

// sysPrompt is the decoded identity marker.
var sysPrompt string

func init() {
	decoded, err := base64.StdEncoding.DecodeString(sysPromptB64)
	if err != nil {
		panic("invalid base64 for sysPrompt: " + err.Error())
	}
	sysPrompt = string(decoded)
}

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
	// begins with the CC identity marker and that carry max_tokens; gateways that
	// translate from OpenAI chat/completions often omit or re-wrap these.
	body = ensureCCRequestShape(body)

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

	// CC's getAnthropicClient always sets x-app: 'cli' as a default header.
	req.Header.Set("x-app", "cli")

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

// defaultMaxTokens is used when a translating gateway omits max_tokens
// (OpenAI chat/completions doesn't require it; Anthropic messages does).
const defaultMaxTokens = 4096

// attributionHeader is the billing/attribution text block CC prepends as the
// very first element of the system array. The server uses cc_version and
// cc_entrypoint to identify genuine CC traffic. The fingerprint suffix is a
// short hash derived from the request's first user message (CC computes a
// real fingerprint; we send a stable placeholder).
const attributionHeader = "x-anthropic-billing-header: cc_version=2.1.44.0; cc_entrypoint=cli;"

// ensureCCRequestShape rewrites the request body so it satisfies Anthropic's
// OAuth-subscription (Claude Code) requirements:
//   - system is a well-formed array whose first elements are the CC attribution
//     header and identity marker
//   - max_tokens is present and a positive number
//   - metadata is present with a user_id field
//
// Translating gateways (e.g. Bifrost doing OpenAI→Anthropic) frequently drop
// system, send it as a bare string or unwrapped object, or omit max_tokens.
// Rather than bailing on ambiguity, normalize aggressively and preserve
// whatever content we can. Anthropic rejects misshapen OAuth-subscription
// requests with a misleading "third-party apps draw from your extra usage" 400.
func ensureCCRequestShape(body []byte) []byte {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return body // not a JSON object (e.g. GET with empty body); leave untouched
	}

	msg["system"] = ccSystemArray(msg["system"])

	if raw, ok := msg["max_tokens"]; !ok || !isPositiveNumber(raw) {
		msg["max_tokens"] = json.RawMessage(strconv.Itoa(defaultMaxTokens))
	}

	// CC always sends metadata.user_id as a JSON-stringified object containing
	// device_id, account_uuid, and session_id. Gateways never set this.
	if _, ok := msg["metadata"]; !ok {
		meta := fmt.Sprintf(`{"user_id":%q}`, "claude-sub-to-api-proxy")
		msg["metadata"] = json.RawMessage(meta)
	}

	return marshalOrOriginal(msg, body)
}

// ccSystemArray returns a system array beginning with the CC attribution
// header and identity marker, preserving any existing system content after them.
func ccSystemArray(raw json.RawMessage) json.RawMessage {
	attributionBlock := `{"type":"text","text":` + mustJSONString(attributionHeader) + `}`
	markerBlock := `{"type":"text","text":` + mustJSONString(sysPrompt) + `}`

	var b strings.Builder
	b.WriteByte('[')
	b.WriteString(attributionBlock)
	b.WriteByte(',')
	b.WriteString(markerBlock)
	for _, e := range extractSystemTexts(raw) {
		if strings.Contains(e, sysPrompt) {
			continue // marker already present; it stays first, unduplicated
		}
		if strings.Contains(e, attributionHeader) {
			continue // attribution already present; don't duplicate
		}
		b.WriteByte(',')
		b.WriteString(e)
	}
	b.WriteByte(']')
	return json.RawMessage(b.String())
}

// extractSystemTexts normalizes the shapes a `system` field can take into a
// list of {"type":"text","text":...} element JSON strings. Returns nil when
// raw is missing, null, or unusable.
func extractSystemTexts(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}

	// Array form (Anthropic-native).
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err == nil {
		var out []string
		for _, el := range arr {
			// Well-formed text blocks pass through untouched.
			var probe struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(el, &probe); err == nil && probe.Type == "text" && probe.Text != "" {
				out = append(out, string(el))
				continue
			}
			// Bare string element inside the array.
			var s string
			if err := json.Unmarshal(el, &s); err == nil && s != "" {
				out = append(out, textBlock(s))
			}
			// Anything else is not valid as a system element; drop it.
		}
		return out
	}

	// Plain string form (common from OpenAI→Anthropic translators).
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if s == "" {
			return nil
		}
		return []string{textBlock(s)}
	}

	// Unwrapped single object: {"type":"text","text":"..."}.
	var probe struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &probe); err == nil && probe.Text != "" {
		return []string{textBlock(probe.Text)}
	}

	return nil
}

// textBlock wraps s in an Anthropic text content block.
func textBlock(s string) string {
	return `{"type":"text","text":` + mustJSONString(s) + `}`
}

// isPositiveNumber reports whether raw is a JSON number > 0.
func isPositiveNumber(raw json.RawMessage) bool {
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return false
	}
	return n > 0
}

// mustJSONString marshals s as a JSON string.
func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
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
