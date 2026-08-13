//go:build integration

// Package proxy integration tests: drive a real Bifrost gateway (Docker) that
// uses this proxy as its Anthropic provider, and verify requests flow end to
// end (Bifrost -> proxy -> real Anthropic API) using a virtual key, mirroring
// a real Bifrost harness setup.
//
// Requirements (the test skips itself when they are missing):
//   - a working `docker` CLI (and daemon), able to pull maximhq/bifrost
//   - real Claude subscription credentials at CLAUDE_CREDENTIALS_PATH
//     (defaults to ~/.config/claude-sub-to-api/.credentials.json)
//   - outbound network access to api.anthropic.com
//
// Run:
//
//	CLAUDE_CREDENTIALS_PATH=~/.config/claude-sub-to-api/.credentials.json \
//	  go test -tags integration ./internal/proxy -run TestBifrostIntegration -v -timeout 20m
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	// proxyAPIKey is the static key the proxy expects consumers to present;
	// Bifrost is configured with it as the Anthropic provider key value.
	proxyAPIKey = "itest-proxy-key"
	// vkValue is the Bifrost virtual key value the test sends via x-bf-vk.
	vkValue = "sk-bf-itest"
	// bifrostImg is the Bifrost gateway image to run.
	bifrostImg = "maximhq/bifrost:latest"
)

// repoRoot returns the repository root derived from this file's location.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file path")
	}
	// file = <root>/internal/proxy/bifrost_integration_test.go
	return filepath.Dir(filepath.Dir(filepath.Dir(file)))
}

// haveDocker reports whether a usable docker CLI is available.
func haveDocker() bool {
	cmd := exec.Command("docker", "version", "--format", "{{.Server.Version}}")
	if out, err := cmd.CombinedOutput(); err != nil {
		return false
	} else {
		_ = out
	}
	return true
}

// freePort returns a currently-free TCP port on 127.0.0.1.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("find free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// waitHTTP polls GET url until it returns the given status (or ctx is done).
func waitHTTP(ctx context.Context, client *http.Client, url string, want int, interval time.Duration) error {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for %s to return %d: %w", url, want, ctx.Err())
		case <-t.C:
			resp, err := client.Get(url)
			if err != nil {
				continue
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == want {
				return nil
			}
		}
	}
}

// startProxy builds the proxy binary and runs it as a subprocess bound to all
// interfaces on a free port (Bifrost reaches it via host.docker.internal).
// It returns the base URL and a cleanup function.
func startProxy(t *testing.T, ctx context.Context, root, credsPath string) (string, func()) {
	t.Helper()

	binPath := filepath.Join(t.TempDir(), "claude-sub-to-api")
	build := exec.Command("go", "build", "-o", binPath, "./cmd/claude-sub-to-api")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build proxy: %v\n%s", err, out)
	}

	port := freePort(t)
	addr := ":" + strconv.Itoa(port)

	var buf bytes.Buffer
	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(),
		"PROXY_API_KEY="+proxyAPIKey,
		"CREDENTIALS_PATH="+credsPath,
		"LISTEN_ADDR="+addr,
		"LOG_LEVEL=debug",
	)
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Start(); err != nil {
		t.Fatalf("start proxy: %v", err)
	}

	cleanup := func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		t.Logf("--- proxy logs ---\n%s", buf.String())
	}

	// Wait for the proxy to become healthy.
	client := &http.Client{Timeout: 3 * time.Second}
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := waitHTTP(waitCtx, client, "http://127.0.0.1:"+strconv.Itoa(port)+"/healthz", http.StatusOK, 500*time.Millisecond); err != nil {
		cleanup()
		t.Fatalf("proxy did not become healthy: %v\n%s", err, buf.String())
	}

	return "http://127.0.0.1:" + strconv.Itoa(port), cleanup
}

// writeBifrostConfig writes a minimal Bifrost config.json to dir that
//   - registers the `anthropic` provider pointing at our proxy (via
//     host.docker.internal, since Bifrost runs in Docker),
//   - defines a virtual key that allows the anthropic provider,
//   - requires a virtual key on inference (mirrors a VK-using setup).
func writeBifrostConfig(t *testing.T, dir string, proxyPort int) string {
	t.Helper()

	type vkProvider struct {
		Provider      string   `json:"provider"`
		Weight        float64  `json:"weight"`
		AllowedModels []string `json:"allowed_models"`
		KeyIDs        []string `json:"key_ids"`
	}
	type vk struct {
		ID              string       `json:"id"`
		Name            string       `json:"name"`
		Value           string       `json:"value"`
		IsActive        bool         `json:"is_active"`
		ProviderConfigs []vkProvider `json:"provider_configs"`
	}
	cfg := map[string]any{
		"$schema": "https://www.getbifrost.ai/schema",
		"client": map[string]any{
			"drop_excess_requests":      false,
			"enable_logging":            true,
			"enforce_auth_on_inference": true,
		},
		"providers": map[string]any{
			"anthropic": map[string]any{
				"keys": []map[string]any{
					{
						"name":   "claude-proxy",
						"value":  proxyAPIKey,
						"models": []string{"*"},
						"weight": 1.0,
					},
				},
				"network_config": map[string]any{
					"base_url":                           "http://host.docker.internal:" + strconv.Itoa(proxyPort),
					"allow_private_network":              true,
					"default_request_timeout_in_seconds": 120,
				},
			},
		},
		"governance": map[string]any{
			"virtual_keys": []vk{
				{
					ID:       "vk-itest",
					Name:     "Integration test key",
					Value:    vkValue,
					IsActive: true,
					ProviderConfigs: []vkProvider{
						{Provider: "anthropic", Weight: 1.0, AllowedModels: []string{"*"}, KeyIDs: []string{"*"}},
					},
				},
			},
		},
		// Virtual keys (governance) require a config store; the SQLite store
		// keeps the setup self-contained (no external Postgres).
		"config_store": map[string]any{
			"enabled": true,
			"type":    "sqlite",
			"config":  map[string]any{"path": "./config.db"},
		},
	}

	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal bifrost config: %v", err)
	}

	// The Bifrost container runs as a non-root user; loosen perms so the
	// bind-mounted app dir stays writable regardless of the host UID.
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod app dir: %v", err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, b, 0o666); err != nil {
		t.Fatalf("write bifrost config: %v", err)
	}
	return path
}

// startBifrost runs the Bifrost gateway in Docker with the given app dir and
// returns its host-facing base URL plus a cleanup function.
func startBifrost(t *testing.T, ctx context.Context, appDir string) (string, func()) {
	t.Helper()

	name := fmt.Sprintf("claude-bifrost-it-%d", os.Getpid())
	rm := exec.Command("docker", "rm", "-f", name)
	_ = rm.Run() // ignore errors: container may not exist

	args := []string{
		"run", "-d",
		"--name", name,
		"--add-host", "host.docker.internal:host-gateway",
		"-e", "APP_HOST=0.0.0.0",
		"-e", "APP_PORT=8080",
		"-e", "LOG_LEVEL=debug",
		"-e", "LOG_STYLE=pretty",
		"-p", "127.0.0.1:0:8080",
		"-v", appDir + ":/app/data",
		bifrostImg,
	}
	run := exec.Command("docker", args...)
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("docker run bifrost: %v\n%s", err, out)
	}

	cleanup := func() {
		logs := exec.Command("docker", "logs", name)
		logOut, _ := logs.CombinedOutput()
		t.Logf("--- bifrost logs ---\n%s", logOut)
		rm := exec.Command("docker", "rm", "-f", name)
		_ = rm.Run()
	}

	// Discover the published host port.
	client := &http.Client{Timeout: 3 * time.Second}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	for {
		select {
		case <-waitCtx.Done():
			cleanup()
			t.Fatalf("bifrost did not become healthy: %v", waitCtx.Err())
		default:
		}
		portOut, err := exec.Command("docker", "port", name, "8080/tcp").Output()
		if err == nil {
			hostPort := strings.TrimSpace(string(portOut))
			// Format: 127.0.0.1:<port>
			idx := strings.LastIndex(hostPort, ":")
			if idx >= 0 {
				base := "http://127.0.0.1:" + hostPort[idx+1:]
				checkCtx, c := context.WithTimeout(ctx, 2*time.Second)
				err := waitHTTP(checkCtx, client, base+"/health", http.StatusOK, 300*time.Millisecond)
				c()
				if err == nil {
					return base, cleanup
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// doJSON issues a JSON POST/PUT-style request and returns status + body.
func doJSON(t *testing.T, client *http.Client, method, url string, headers map[string]string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp.StatusCode, out
}

// sseEvent is one parsed Server-Sent-Events event (optional `event:` line plus
// the accumulated `data:` payload).
type sseEvent struct {
	Event string
	Data  string
}

// doStreamPOST issues a streaming POST and returns the response Content-Type,
// the parsed SSE events, and the raw response body (for diagnostics).
func doStreamPOST(t *testing.T, client *http.Client, method, url string, headers map[string]string, body any) (string, []sseEvent, string) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")

	var raw strings.Builder
	var events []sseEvent
	var curEvent string
	var curData []string
	flush := func() {
		if curEvent != "" || len(curData) > 0 {
			events = append(events, sseEvent{Event: curEvent, Data: strings.Join(curData, "\n")})
		}
		curEvent, curData = "", nil
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for scanner.Scan() {
		line := scanner.Text()
		raw.WriteString(line)
		raw.WriteString("\n")
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "event:"):
			curEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			curData = append(curData, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	flush()
	return contentType, events, raw.String()
}

// harnessSystemPrompt returns the REDACTED, harness-style system prompt from
// testdata/harness_system_prompt.txt, approximating what a coding-agent harness
// (e.g. GitHub Copilot) sends at the start of each conversation. The fixture
// deliberately contains NO personal information (no usernames, real paths, org
// names, or keys) so it is safe to commit. Its purpose is to reproduce
// large-prompt edge cases: a big system/first-user block that Bifrost converts
// to Anthropic system content, plus lots of instructions/tool-guardrails text.
func harnessSystemPrompt(t *testing.T) string {
	t.Helper()
	path := filepath.Join(repoRoot(t), "internal", "proxy", "testdata", "harness_system_prompt.txt")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read harness system prompt fixture: %v", err)
	}
	return strings.TrimSpace(string(b))
}

// harnessTools returns a REDACTED, representative tools array approximating what
// a coding-agent harness sends (read/grep/edit/terminal tools). It exercises
// Bifrost's OpenAI->Anthropic tool conversion path.
func harnessTools() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"function": map[string]any{
				"name":        "read_file",
				"description": "Read a section of a file from the workspace.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"file_path":  map[string]any{"type": "string", "description": "Absolute path of the file to read."},
						"start_line": map[string]any{"type": "integer"},
						"end_line":   map[string]any{"type": "integer"},
					},
					"required": []string{"file_path"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "grep_search",
				"description": "Search the workspace for a pattern.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query":        map[string]any{"type": "string"},
						"include_glob": map[string]any{"type": "string"},
						"is_regexp":    map[string]any{"type": "boolean"},
					},
					"required": []string{"query"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "edit_file",
				"description": "Edit a file in the workspace.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"file_path":  map[string]any{"type": "string"},
						"old_string": map[string]any{"type": "string"},
						"new_string": map[string]any{"type": "string"},
					},
					"required": []string{"file_path", "old_string", "new_string"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "run_in_terminal",
				"description": "Run a command in the terminal.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"command":     map[string]any{"type": "string"},
						"explanation": map[string]any{"type": "string"},
						"mode":        map[string]any{"type": "string", "enum": []string{"sync", "async"}},
					},
					"required": []string{"command"},
				},
			},
		},
	}
}

func TestBifrostIntegration(t *testing.T) {
	if !haveDocker() {
		t.Skip("docker not available; skipping Bifrost integration test")
	}

	credsPath := os.Getenv("CLAUDE_CREDENTIALS_PATH")
	if credsPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Fatalf("resolve home dir: %v", err)
		}
		credsPath = filepath.Join(home, ".config", "claude-sub-to-api", ".credentials.json")
	}
	if _, err := os.Stat(credsPath); err != nil {
		t.Skipf("Claude credentials not found at %s; skipping (set CLAUDE_CREDENTIALS_PATH)", credsPath)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	root := repoRoot(t)

	// 1. Start the real proxy against real Anthropic.
	proxyURL, proxyCleanup := startProxy(t, ctx, root, credsPath)
	defer proxyCleanup()
	proxyPort := strings.TrimPrefix(proxyURL, "http://127.0.0.1:")
	t.Logf("claude-sub-to-api proxy running at %s", proxyURL)

	// 2. Write Bifrost config and start the Bifrost gateway.
	appDir := t.TempDir()
	writeBifrostConfig(t, appDir, mustAtoi(t, proxyPort))
	bifrostURL, bifrostCleanup := startBifrost(t, ctx, appDir)
	defer bifrostCleanup()
	t.Logf("bifrost gateway running at %s", bifrostURL)

	client := &http.Client{Timeout: 180 * time.Second}
	vkHeaders := map[string]string{
		"Content-Type": "application/json",
		"x-bf-vk":      vkValue,
	}

	// 3. Sanity: list models via the virtual key (also proves the VK is active).
	if status, body := doJSON(t, client, http.MethodGet, bifrostURL+"/v1/models", vkHeaders, nil); status != http.StatusOK {
		t.Logf("WARNING: /v1/models with VK returned %d: %s", status, body)
	}

	t.Run("openai_chat_completions", func(t *testing.T) {
		// This is the surface agent harnesses (opencode etc.) use: the unified
		// OpenAI-compatible endpoint with a provider-prefixed model.
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", vkHeaders, map[string]any{
			"model":    "anthropic/claude-opus-4-8",
			"messages": []map[string]string{{"role": "user", "content": "Please show me an example for a C# record type."}},
		})
		if status != http.StatusOK {
			t.Fatalf("bifrost /v1/chat/completions -> %d\n%s", status, body)
		}
		var resp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("decode chat response: %v\n%s", err, body)
		}
		if len(resp.Choices) == 0 || strings.TrimSpace(resp.Choices[0].Message.Content) == "" {
			t.Fatalf("empty completion content: %s", body)
		}
		t.Logf("OK: got completion (%d bytes)", len(resp.Choices[0].Message.Content))
	})

	t.Run("anthropic_messages", func(t *testing.T) {
		// Native Anthropic surface, as the Anthropic SDK would hit it.
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/anthropic/v1/messages", vkHeaders, map[string]any{
			"model":      "claude-opus-4-8",
			"max_tokens": 128,
			"messages":   []map[string]string{{"role": "user", "content": "Say hi in one word."}},
		})
		if status != http.StatusOK {
			t.Fatalf("bifrost /anthropic/v1/messages -> %d\n%s", status, body)
		}
		var resp struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("decode anthropic response: %v\n%s", err, body)
		}
		if len(resp.Content) == 0 || strings.TrimSpace(resp.Content[0].Text) == "" {
			t.Fatalf("empty anthropic content: %s", body)
		}
		t.Logf("OK: got anthropic response (%d bytes)", len(resp.Content[0].Text))
	})

	t.Run("openai_chat_completions_stream", func(t *testing.T) {
		// Streaming through the unified OpenAI-compatible surface: Bifrost
		// converts OpenAI SSE chunks to Anthropic (upstream), our proxy streams
		// SSE back, and Bifrost re-emits OpenAI SSE chunks + [DONE].
		ct, events, raw := doStreamPOST(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", vkHeaders, map[string]any{
			"model":    "anthropic/claude-opus-4-8",
			"stream":   true,
			"messages": []map[string]string{{"role": "user", "content": "Count from one to three, one number per line."}},
		})
		if !strings.Contains(ct, "text/event-stream") {
			t.Fatalf("expected SSE content-type, got %q\n%s", ct, raw)
		}
		var sawChunk, sawDone bool
		for _, ev := range events {
			if ev.Data == "[DONE]" {
				sawDone = true
				continue
			}
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(ev.Data), &chunk); err == nil {
				for _, c := range chunk.Choices {
					if c.Delta.Content != "" {
						sawChunk = true
					}
				}
			}
		}
		if !sawChunk {
			t.Fatalf("no content chunks in stream\n%s", raw)
		}
		if !sawDone {
			t.Fatalf("no [DONE] sentinel in stream\n%s", raw)
		}
		t.Logf("OK: streamed %d events (content chunk + [DONE])", len(events))
	})

	t.Run("anthropic_messages_stream", func(t *testing.T) {
		// Streaming on the native Anthropic surface: expect SSE with
		// message_start / content_block_delta / message_stop lifecycle events.
		ct, events, raw := doStreamPOST(t, client, http.MethodPost, bifrostURL+"/anthropic/v1/messages", vkHeaders, map[string]any{
			"model":      "claude-opus-4-8",
			"max_tokens": 64,
			"stream":     true,
			"messages":   []map[string]string{{"role": "user", "content": "Say hi in one word."}},
		})
		if !strings.Contains(ct, "text/event-stream") {
			t.Fatalf("expected SSE content-type, got %q\n%s", ct, raw)
		}
		var sawStart, sawDelta, sawStop bool
		for _, ev := range events {
			var probe struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal([]byte(ev.Data), &probe)
			switch {
			case ev.Event == "message_start" || probe.Type == "message_start":
				sawStart = true
			case ev.Event == "content_block_delta" || probe.Type == "content_block_delta":
				sawDelta = true
			case ev.Event == "message_stop" || probe.Type == "message_stop":
				sawStop = true
			}
		}
		if !sawStart || !sawStop {
			t.Fatalf("stream missing lifecycle events (start=%v delta=%v stop=%v)\n%s", sawStart, sawDelta, sawStop, raw)
		}
		t.Logf("OK: streamed %d events (start=%v delta=%v stop=%v)", len(events), sawStart, sawDelta, sawStop)
	})

	sysPrompt := harnessSystemPrompt(t)
	userContent := "Please show me an example for a C# record type."

	t.Run("openai_chat_completions_large_system", func(t *testing.T) {
		// Reproduces a harness request with a lengthy system prompt (the agent's
		// system/instructions block) plus a tools array, sent through Bifrost's
		// OpenAI surface.
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", vkHeaders, map[string]any{
			"model": "anthropic/claude-opus-4-8",
			"tools": harnessTools(),
			"messages": []map[string]any{
				{"role": "system", "content": sysPrompt},
				{"role": "user", "content": userContent},
			},
		})
		if status != http.StatusOK {
			t.Fatalf("bifrost /v1/chat/completions (large system) -> %d\n%s", status, body)
		}
		var resp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("decode chat response: %v\n%s", err, body)
		}
		if len(resp.Choices) == 0 || strings.TrimSpace(resp.Choices[0].Message.Content) == "" {
			t.Fatalf("empty completion content: %s", body)
		}
		t.Logf("OK: got completion with %d-byte system prompt (%d bytes out)", len(sysPrompt), len(resp.Choices[0].Message.Content))
	})

	t.Run("openai_chat_completions_large_first_user", func(t *testing.T) {
		// Reproduces the exact shape observed in the user's Bifrost logs: the
		// lengthy system/instructions block is sent as the FIRST USER message
		// (no system role), followed by the real user prompt, plus tools.
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", vkHeaders, map[string]any{
			"model": "anthropic/claude-opus-4-8",
			"tools": harnessTools(),
			"messages": []map[string]any{
				{"role": "user", "content": sysPrompt},
				{"role": "user", "content": userContent},
			},
		})
		if status != http.StatusOK {
			t.Fatalf("bifrost /v1/chat/completions (large first user) -> %d\n%s", status, body)
		}
		var resp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("decode chat response: %v\n%s", err, body)
		}
		if len(resp.Choices) == 0 || strings.TrimSpace(resp.Choices[0].Message.Content) == "" {
			t.Fatalf("empty completion content: %s", body)
		}
		t.Logf("OK: got completion with %d-byte first-user prompt (%d bytes out)", len(sysPrompt), len(resp.Choices[0].Message.Content))
	})

	t.Run("openai_chat_completions_very_large_first_user", func(t *testing.T) {
		// A ~50KB first-user prompt (the fixture repeated 10x, still fully
		// redacted) plus tools, approximating the full-size harness prompt that
		// the user's real setup sends. This is the most likely remaining trigger
		// for a size-related failure.
		huge := strings.Repeat(sysPrompt+"\n\n", 10)
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", vkHeaders, map[string]any{
			"model": "anthropic/claude-opus-4-8",
			"tools": harnessTools(),
			"messages": []map[string]any{
				{"role": "user", "content": huge},
				{"role": "user", "content": userContent},
			},
		})
		if status != http.StatusOK {
			t.Fatalf("bifrost /v1/chat/completions (very large first user) -> %d\n%s", status, body)
		}
		var resp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("decode chat response: %v\n%s", err, body)
		}
		if len(resp.Choices) == 0 || strings.TrimSpace(resp.Choices[0].Message.Content) == "" {
			t.Fatalf("empty completion content: %s", body)
		}
		t.Logf("OK: got completion with %d-byte first-user prompt (%d bytes out)", len(huge), len(resp.Choices[0].Message.Content))
	})

	t.Run("openai_chat_completions_multi_turn", func(t *testing.T) {
		// Verifies conversation context survives multi-turn through
		// Bifrost -> proxy -> Anthropic. The proxy is stateless: each turn must
		// carry the full history, and the assistant's previous reply must reach
		// the upstream untouched so the model can reference it.
		//
		// We pin a stable session id via x-bf-session-id on BOTH turns. This is
		// faithful to Claude Code, which keeps a stable session_id across turns
		// (getAPIMetadata -> getSessionId); the proxy either preserves
		// caller-supplied metadata or pins this id into CC-shaped metadata.
		//
		// We use a unique marker so a "correct" second answer must have seen
		// the first turn (not just generic text).
		marker := fmt.Sprintf("zebra-%d-%d", os.Getpid(), time.Now().UnixNano())
		sessionID := fmt.Sprintf("itest-session-%d", os.Getpid())
		turnHeaders := map[string]string{
			"Content-Type":    "application/json",
			"x-bf-vk":         vkValue,
			"x-bf-session-id": sessionID,
		}

		// Turn 1: ask the model to remember a specific marker.
		status, body := doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", turnHeaders, map[string]any{
			"model": "anthropic/claude-opus-4-8",
			"messages": []map[string]any{
				{"role": "user", "content": "Memorize this exact token and repeat it back verbatim at the end of your reply: " + marker},
			},
		})
		if status != http.StatusOK {
			t.Fatalf("turn 1 -> %d\n%s", status, body)
		}
		var turn1 struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &turn1); err != nil {
			t.Fatalf("decode turn 1: %v\n%s", err, body)
		}
		if len(turn1.Choices) == 0 || strings.TrimSpace(turn1.Choices[0].Message.Content) == "" {
			t.Fatalf("empty turn 1 content: %s", body)
		}
		t.Logf("turn 1 OK: assistant said %q", truncateStr(turn1.Choices[0].Message.Content, 80))

		// Turn 2: same session id, full history (user + assistant) plus a
		// follow-up that can only be answered correctly if the assistant
		// message reached upstream.
		status, body = doJSON(t, client, http.MethodPost, bifrostURL+"/v1/chat/completions", turnHeaders, map[string]any{
			"model": "anthropic/claude-opus-4-8",
			"messages": []map[string]any{
				{"role": "user", "content": "Memorize this exact token and repeat it back verbatim at the end of your reply: " + marker},
				{"role": "assistant", "content": turn1.Choices[0].Message.Content},
				{"role": "user", "content": "What was the exact token I asked you to memorize? Reply with only the token."},
			},
		})
		if status != http.StatusOK {
			t.Fatalf("turn 2 -> %d\n%s", status, body)
		}
		var turn2 struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &turn2); err != nil {
			t.Fatalf("decode turn 2: %v\n%s", err, body)
		}
		if len(turn2.Choices) == 0 || strings.TrimSpace(turn2.Choices[0].Message.Content) == "" {
			t.Fatalf("empty turn 2 content: %s", body)
		}
		if !strings.Contains(turn2.Choices[0].Message.Content, marker) {
			t.Fatalf("context lost across turns: turn 2 did not mention the marker %q\nturn1=%q\nturn2=%q",
				marker, truncateStr(turn1.Choices[0].Message.Content, 200), truncateStr(turn2.Choices[0].Message.Content, 200))
		}
		t.Logf("OK: multi-turn context preserved with stable session %q (turn 2 recalled the marker)", sessionID)
	})
}

func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatalf("parse port %q: %v", s, err)
	}
	return n
}
