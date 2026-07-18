package proxy

import (
	"strings"
	"testing"
)

func TestCopyAndParseUsage(t *testing.T) {
	body := `{"id":"msg_1","type":"message","model":"claude-opus-4-8","usage":{"input_tokens":42,"output_tokens":9}}`
	var sb strings.Builder
	u, err := copyAndParseUsage(strings.NewReader(body), &sb)
	if err != nil {
		t.Fatalf("copyAndParseUsage: %v", err)
	}
	if sb.String() != body {
		t.Fatal("body not copied verbatim")
	}
	if u == nil || u.InputTokens != 42 || u.OutputTokens != 9 || u.Model != "claude-opus-4-8" {
		t.Fatalf("unexpected usage: %+v", u)
	}
}

func TestStreamAndParseUsage(t *testing.T) {
	sse := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":25,"output_tokens":1}}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	}, "\n")

	var sb strings.Builder
	u := streamAndParseUsage(strings.NewReader(sse), &sb)

	// The scanner drops the final empty token after the trailing newline, so the
	// output is exactly the input (no extra newline added for the last empty line).
	if sb.String() != sse {
		t.Fatalf("stream not forwarded verbatim.\nGot:\n%q\nWant:\n%q", sb.String(), sse)
	}
	if u == nil {
		t.Fatal("expected usage, got nil")
	}
	if u.Model != "claude-opus-4-8" {
		t.Fatalf("model = %q", u.Model)
	}
	if u.InputTokens != 25 {
		t.Fatalf("input tokens = %d", u.InputTokens)
	}
	if u.OutputTokens != 3 {
		t.Fatalf("output tokens = %d (want latest message_delta)", u.OutputTokens)
	}
}
