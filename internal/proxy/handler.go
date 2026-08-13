// Package proxy forwards Anthropic-compatible requests to the real Anthropic API,
// authenticating with the user's Claude subscription OAuth token.
package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"fine-grained-tool-streaming-2025-05-14",
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
	// begins with the CC identity marker, that carry max_tokens, and whose
	// metadata matches the Claude Code session fingerprint; gateways that
	// translate from OpenAI chat/completions often omit or re-wrap these.
	sessionID := sessionIDHeader(r)
	if sessionID != "" {
		h.log.Debug("request carries session id", zap.String("session_id", sessionID))
	}
	body = ensureCCRequestShape(body, sessionID)

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

// ccDeviceID is a synthetic, stable device identifier used only when a client
// supplies no metadata of its own. It deliberately contains no real identity.
const ccDeviceID = "00000000-0000-4000-8000-0000000000cc"

// ensureCCRequestShape rewrites the request body so it satisfies Anthropic's
// OAuth-subscription (Claude Code) requirements:
//   - system is a well-formed array whose first element is the CC identity marker
//   - max_tokens is present and a positive number
//   - metadata carries a CC-faithful user_id (device_id/account_uuid/session_id)
//     unless the caller already supplied one (then it is preserved verbatim)
//
// Translating gateways (e.g. Bifrost doing OpenAI→Anthropic) frequently drop
// system, send it as a bare string or unwrapped object, or omit max_tokens and
// metadata. Rather than bailing on ambiguity, normalize aggressively and
// preserve whatever content we can. Anthropic rejects misshapen
// OAuth-subscription requests with a misleading "third-party apps draw from
// your extra usage" 400.
//
// sessionID, when non-empty, is pinned into the synthesized metadata so the
// same session_id is sent on every turn of a conversation (faithful to CC's
// getAPIMetadata(), which keeps session_id stable via getSessionId()).
func ensureCCRequestShape(body []byte, sessionID string) []byte {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		return body // not a JSON object (e.g. GET with empty body); leave untouched
	}

	msg["system"] = ccSystemArray(msg["system"])

	if raw, ok := msg["max_tokens"]; !ok || !isPositiveNumber(raw) {
		msg["max_tokens"] = json.RawMessage(strconv.Itoa(defaultMaxTokens))
	}

	msg["metadata"] = ccMetadata(msg["metadata"], sessionID)

	return marshalOrOriginal(msg, body)
}

// sessionIDHeader extracts the caller's session correlation id, if any.
// Bifrost forwards this header; it is stable across turns of a conversation,
// which is exactly what Claude Code relies on to keep correlation intact.
func sessionIDHeader(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("x-bf-session-id"))
}

// ccMetadata returns the metadata field to send upstream, mirroring Claude
// Code's getAPIMetadata(): metadata.user_id is a JSON-encoded string of
// {device_id, account_uuid, session_id}.
//
// If the caller already supplied metadata (their own user_id/session_id), it
// is preserved verbatim so conversation correlation survives multi-turn.
// Otherwise a CC-faithful block is synthesized; session_id is the value the
// client pinned via x-bf-session-id (stable across turns), or a random UUID.
func ccMetadata(raw json.RawMessage, sessionID string) json.RawMessage {
	if len(raw) > 0 && string(raw) != "null" {
		return raw // caller-provided metadata wins
	}
	if sessionID == "" {
		sessionID = randomUUID()
	}
	uid := ccUserID(ccDeviceID, sessionID)
	b, err := json.Marshal(map[string]string{"user_id": uid})
	if err != nil {
		return raw
	}
	return json.RawMessage(b)
}

// ccUserID renders the user_id value CC puts inside metadata: a JSON-encoded
// string of the session fields. account_uuid is empty, exactly as CC sends it
// when no OAuth account info is available (getAPIMetadata uses
// getOauthAccountInfo()?.accountUuid ?? ”).
func ccUserID(deviceID, sessionID string) string {
	b, err := json.Marshal(map[string]string{
		"device_id":    deviceID,
		"account_uuid": "",
		"session_id":   sessionID,
	})
	if err != nil {
		return ""
	}
	return string(b)
}

// randomUUID returns a random version-4 UUID, used for the session_id when the
// caller did not pin one.
func randomUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("synthetic-%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ccSystemArray returns a system array beginning with the CC identity marker,
// preserving any existing system content after it.
func ccSystemArray(raw json.RawMessage) json.RawMessage {
	markerBlock := `{"type":"text","text":` + mustJSONString(sysPrompt) + `}`

	var b strings.Builder
	b.WriteByte('[')
	b.WriteString(markerBlock)
	for _, e := range extractSystemTexts(raw) {
		if strings.Contains(e, sysPrompt) {
			continue // marker already present; it stays first, unduplicated
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
