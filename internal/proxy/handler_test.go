package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"
)

// staticToken is a tokenProvider that always returns the same token.
type staticToken struct{ tok string }

func (s staticToken) AccessToken(context.Context) (string, error) { return s.tok, nil }

func TestProxy_InjectsHeadersAndStripsClientAuth(t *testing.T) {
	var gotAuth, gotUA, gotBeta, gotXAPIKey, gotVersion, gotBody, gotXApp string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotUA = r.Header.Get("User-Agent")
		gotBeta = r.Header.Get("anthropic-beta")
		gotXAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		gotXApp = r.Header.Get("x-app")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"id":"msg_1","type":"message","model":"claude-opus-4-8","usage":{"input_tokens":12,"output_tokens":7}}`)
	}))
	defer upstream.Close()

	h := NewHandler(upstream.URL, staticToken{"sk-ant-oat01-live"}, "claude-cli/2.1.44", zap.NewNop())

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"model":"claude-opus-4-8","max_tokens":10,"messages":[]}`))
	req.Header.Set("Authorization", "Bearer consumer-key")
	req.Header.Set("x-api-key", "consumer-key")
	req.Header.Set("anthropic-beta", "prompt-caching-2024-07-31")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if gotAuth != "Bearer sk-ant-oat01-live" {
		t.Fatalf("upstream Authorization = %q, want OAuth bearer", gotAuth)
	}
	if gotXAPIKey != "" {
		t.Fatalf("x-api-key should have been stripped, got %q", gotXAPIKey)
	}
	if gotUA != "claude-cli/2.1.44" {
		t.Fatalf("upstream User-Agent = %q", gotUA)
	}
	if gotVersion != anthropicVersion {
		t.Fatalf("upstream anthropic-version = %q, want %q", gotVersion, anthropicVersion)
	}
	if gotXApp != "cli" {
		t.Fatalf("upstream x-app = %q, want %q", gotXApp, "cli")
	}
	// Required betas plus the client's passthrough beta, de-duplicated.
	for _, want := range []string{"oauth-2025-04-20", "claude-code-20250219",
		"interleaved-thinking-2025-05-14", "prompt-caching-scope-2026-01-05",
		"context-management-2025-06-27",
		"prompt-caching-2024-07-31"} {
		if !strings.Contains(gotBeta, want) {
			t.Fatalf("anthropic-beta missing %q: %q", want, gotBeta)
		}
	}
	// fine-grained-tool-streaming is NOT a beta header (it's a per-tool field).
	if strings.Contains(gotBeta, "fine-grained-tool-streaming") {
		t.Fatalf("fine-grained-tool-streaming should not be in anthropic-beta: %q", gotBeta)
	}
	// Claude Code identity marker must be injected into the forwarded body.
	if !strings.Contains(gotBody, sysPrompt) {
		t.Fatalf("upstream body missing Claude Code system marker: %s", gotBody)
	}
	// Attribution header must be injected as first system block.
	if !strings.Contains(gotBody, attributionHeader) {
		t.Fatalf("upstream body missing attribution header: %s", gotBody)
	}
	// metadata must be injected.
	if !strings.Contains(gotBody, `"metadata"`) {
		t.Fatalf("upstream body missing metadata: %s", gotBody)
	}
}

func TestMergeBetas(t *testing.T) {
	got := mergeBetas("foo-1, oauth-2025-04-20", requiredBetas)
	parts := strings.Split(got, ",")
	seen := map[string]int{}
	for _, p := range parts {
		seen[p]++
	}
	if seen["oauth-2025-04-20"] != 1 {
		t.Fatalf("duplicate required beta in %q", got)
	}
	if seen["foo-1"] != 1 || seen["claude-code-20250219"] != 1 {
		t.Fatalf("missing beta entries in %q", got)
	}
	for _, b := range []string{"interleaved-thinking-2025-05-14", "prompt-caching-scope-2026-01-05", "context-management-2025-06-27"} {
		if seen[b] != 1 {
			t.Fatalf("missing required beta %q in %q", b, got)
		}
	}
	if seen["fine-grained-tool-streaming-2025-05-14"] != 0 {
		t.Fatalf("fine-grained-tool-streaming should not be in betas: %q", got)
	}
}

func TestEnsureCCRequestShape(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"no system field", `{"model":"m","messages":[]}`},
		{"system null", `{"system":null,"messages":[]}`},
		{"system as string", `{"system":"You are a helpful assistant.","messages":[]}`},
		{"system as array", `{"system":[{"type":"text","text":"Be terse."}],"messages":[]}`},
		{"system as bare string in array", `{"system":["Be terse."],"messages":[]}`},
		{"system as unwrapped object", `{"system":{"type":"text","text":"Be terse."},"messages":[]}`},
		{"empty array", `{"system":[],"messages":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := ensureCCRequestShape([]byte(tc.in))
			s := string(out)

			// Marker must be present and be the first element of the system array.
			var msg map[string]json.RawMessage
			if err := json.Unmarshal(out, &msg); err != nil {
				t.Fatalf("output is not valid JSON: %v: %s", err, s)
			}
			var arr []map[string]json.RawMessage
			if err := json.Unmarshal(msg["system"], &arr); err != nil {
				t.Fatalf("system is not an array of objects: %s", s)
			}
			if len(arr) < 2 {
				t.Fatalf("system array should have at least 2 elements (attribution + marker): %s", s)
			}
			// First element must be the attribution header.
			var first struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(mustRaw(arr[0]), &first); err != nil {
				t.Fatalf("first system element not an object: %s", s)
			}
			if first.Type != "text" || !strings.HasPrefix(first.Text, "x-anthropic-billing-header:") {
				t.Fatalf("first system element = %+v, want attribution header", first)
			}
			// Second element must be the CC identity marker.
			var second struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(mustRaw(arr[1]), &second); err != nil {
				t.Fatalf("second system element not an object: %s", s)
			}
			if second.Type != "text" || second.Text != sysPrompt {
				t.Fatalf("second system element = %+v, want CC marker", second)
				t.Fatalf("original system text lost: %s", s)
			}
			if strings.Contains(tc.in, "Be terse") && !strings.Contains(s, "Be terse") {
				t.Fatalf("original system entry lost: %s", s)
			}

			// max_tokens defaulted when absent.
			if !strings.Contains(tc.in, "max_tokens") && !strings.Contains(s, `"max_tokens"`) {
				t.Fatalf("max_tokens not defaulted: %s", s)
			}
		})
	}

	t.Run("max_tokens preserved", func(t *testing.T) {
		in := `{"model":"m","max_tokens":1024,"messages":[]}`
		out := ensureCCRequestShape([]byte(in))
		if !strings.Contains(string(out), `"max_tokens":1024`) {
			t.Fatalf("max_tokens overwritten: %s", out)
		}
	})

	t.Run("max_tokens null replaced", func(t *testing.T) {
		in := `{"model":"m","max_tokens":null,"messages":[]}`
		out := ensureCCRequestShape([]byte(in))
		if strings.Contains(string(out), `"max_tokens":null`) {
			t.Fatalf("max_tokens left null: %s", out)
		}
	})

	t.Run("already present", func(t *testing.T) {
		in := `{"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],"messages":[]}`
		out := ensureCCRequestShape([]byte(in))
		if strings.Count(string(out), sysPrompt) != 1 {
			t.Fatalf("marker duplicated: %s", out)
		}
		if strings.Count(string(out), attributionHeader) != 1 {
			t.Fatalf("attribution header duplicated or missing: %s", out)
		}
	})

	t.Run("invalid json untouched", func(t *testing.T) {
		in := `not json`
		if string(ensureCCRequestShape([]byte(in))) != in {
			t.Fatalf("invalid json should be returned unchanged")
		}
	})
}

// mustRaw re-marshals a decoded map element back to raw JSON for further decoding.
func mustRaw(v map[string]json.RawMessage) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func TestIsStreamRequest(t *testing.T) {
	if !isStreamRequest([]byte(`{"stream": true}`)) {
		t.Fatal("should detect stream:true")
	}
	if !isStreamRequest([]byte(`{"stream":true}`)) {
		t.Fatal("should detect stream:true without space")
	}
	if isStreamRequest([]byte(`{"stream": false}`)) {
		t.Fatal("should not detect stream:false")
	}
}
