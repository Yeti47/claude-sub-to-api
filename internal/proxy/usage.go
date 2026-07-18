// Package proxy: helpers to extract token usage from streaming and non-streaming responses.
package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
)

// Usage holds the token usage and model extracted from a response.
type Usage struct {
	Model        string
	InputTokens  int64
	OutputTokens int64
}

// usageFields matches the `usage` object shape in Anthropic responses/events.
type usageFields struct {
	InputTokens  int64 `json:"input_tokens"`
	OutputTokens int64 `json:"output_tokens"`
}

// copyAndParseUsage copies a non-streaming JSON response to w and extracts usage.
func copyAndParseUsage(src io.Reader, dst io.Writer) (*Usage, error) {
	data, err := io.ReadAll(src)
	if err != nil {
		return nil, err
	}
	if _, err := dst.Write(data); err != nil {
		return nil, err
	}

	var body struct {
		Model string      `json:"model"`
		Usage usageFields `json:"usage"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, nil // not a usage-bearing body (e.g. an error); not fatal
	}
	if body.Model == "" && body.Usage.InputTokens == 0 && body.Usage.OutputTokens == 0 {
		return nil, nil
	}
	return &Usage{
		Model:        body.Model,
		InputTokens:  body.Usage.InputTokens,
		OutputTokens: body.Usage.OutputTokens,
	}, nil
}

// streamAndParseUsage copies an SSE stream to w line-by-line (flushing) while
// extracting usage from message_start and message_delta events.
func streamAndParseUsage(src io.Reader, dst io.Writer) *Usage {
	u := &Usage{}
	flusher, _ := dst.(interface{ Flush() })

	scanner := bufio.NewScanner(src)
	// SSE lines can be long (big content blocks); grow the buffer.
	scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)

	for scanner.Scan() {
		line := scanner.Bytes()
		parseSSELine(line, u)
		// Write the line back verbatim (including the trailing newline SSE expects).
		dst.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}
	if u.Model == "" && u.InputTokens == 0 && u.OutputTokens == 0 {
		return nil
	}
	return u
}

// parseSSELine inspects one SSE `data:` line and folds usage into u.
func parseSSELine(line []byte, u *Usage) {
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(line[len("data:"):])
	if len(payload) == 0 || payload[0] != '{' {
		return
	}

	var evt struct {
		Type    string `json:"type"`
		Model   string `json:"model"`
		Message struct {
			Model string      `json:"model"`
			Usage usageFields `json:"usage"`
		} `json:"message"`
		Delta json.RawMessage `json:"delta"`
		Usage usageFields     `json:"usage"`
	}
	if err := json.Unmarshal(payload, &evt); err != nil {
		return
	}

	switch evt.Type {
	case "message_start":
		if evt.Message.Model != "" {
			u.Model = evt.Message.Model
		}
		u.InputTokens = evt.Message.Usage.InputTokens
		u.OutputTokens = evt.Message.Usage.OutputTokens
	case "message_delta":
		// message_delta carries cumulative output token count.
		if evt.Usage.OutputTokens > 0 {
			u.OutputTokens = evt.Usage.OutputTokens
		}
	}
}
