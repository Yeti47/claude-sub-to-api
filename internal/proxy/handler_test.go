package proxy

import (
	"context"
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
	var gotAuth, gotUA, gotBeta, gotXAPIKey, gotVersion, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotUA = r.Header.Get("User-Agent")
		gotBeta = r.Header.Get("anthropic-beta")
		gotXAPIKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
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
	// Required betas plus the client's passthrough beta, de-duplicated.
	for _, want := range []string{"oauth-2025-04-20", "claude-code-20250219",
		"interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14",
		"prompt-caching-2024-07-31"} {
		if !strings.Contains(gotBeta, want) {
			t.Fatalf("anthropic-beta missing %q: %q", want, gotBeta)
		}
	}
	// Claude Code identity marker must be injected into the forwarded body.
	if !strings.Contains(gotBody, sysPrompt) {
		t.Fatalf("upstream body missing Claude Code system marker: %s", gotBody)
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
	for _, b := range []string{"interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14"} {
		if seen[b] != 1 {
			t.Fatalf("missing required beta %q in %q", b, got)
		}
	}
}

func TestEnsureClaudeCodeSystemPrompt(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"no system field", `{"model":"m","messages":[]}`},
		{"system as string", `{"system":"You are a helpful assistant.","messages":[]}`},
		{"system as array", `{"system":[{"type":"text","text":"Be terse."}],"messages":[]}`},
		{"empty array", `{"system":[],"messages":[]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := ensureSysPrompt([]byte(tc.in))
			s := string(out)
			idx := strings.Index(s, sysPrompt)
			if idx < 0 {
				t.Fatalf("marker not injected: %s", s)
			}
			// Marker must be the first text of the system array.
			sysIdx := strings.Index(s, `"system"`)
			if sysIdx < 0 || idx < sysIdx {
				t.Fatalf("marker not within system array: %s", s)
			}
			// Original content preserved.
			if strings.Contains(tc.in, "helpful assistant") && !strings.Contains(s, "helpful assistant") {
				t.Fatalf("original system text lost: %s", s)
			}
			if strings.Contains(tc.in, "Be terse") && !strings.Contains(s, "Be terse") {
				t.Fatalf("original system entry lost: %s", s)
			}
		})
	}

	t.Run("already present", func(t *testing.T) {
		in := `{"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],"messages":[]}`
		out := ensureSysPrompt([]byte(in))
		if strings.Count(string(out), sysPrompt) != 1 {
			t.Fatalf("marker duplicated: %s", out)
		}
	})

	t.Run("invalid json untouched", func(t *testing.T) {
		in := `not json`
		if string(ensureSysPrompt([]byte(in))) != in {
			t.Fatalf("invalid json should be returned unchanged")
		}
	})
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
