// Package creds reads and validates an externally-generated ~/.claude/.credentials.json file,
// either from disk or from an in-memory JSON payload (e.g. an env var).
package creds

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// File mirrors the on-disk shape of ~/.claude/.credentials.json.
type File struct {
	ClaudeAiOauth OAuthBlock `json:"claudeAiOauth"`
}

// OAuthBlock holds the OAuth tokens for the Claude subscription.
type OAuthBlock struct {
	AccessToken      string   `json:"accessToken"`
	RefreshToken     string   `json:"refreshToken"`
	ExpiresAt        int64    `json:"expiresAt"` // unix milliseconds
	Scopes           []string `json:"scopes,omitempty"`
	SubscriptionType string   `json:"subscriptionType,omitempty"`
}

// Load reads and validates the credentials file at path.
func Load(path string) (*File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read credentials file %q: %w", path, err)
	}
	f, err := LoadJSON(data)
	if err != nil {
		return nil, fmt.Errorf("invalid credentials file %q: %w", path, err)
	}
	return f, nil
}

// LoadJSON parses and validates credentials from an in-memory JSON payload,
// e.g. the contents of ~/.claude/.credentials.json supplied via an env var.
func LoadJSON(data []byte) (*File, error) {
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse credentials JSON: %w", err)
	}
	if err := f.Validate(); err != nil {
		return nil, fmt.Errorf("invalid credentials JSON: %w", err)
	}
	return &f, nil
}

// Validate checks that the credentials contain a usable OAuth token pair.
func (f *File) Validate() error {
	o := f.ClaudeAiOauth
	if o.AccessToken == "" {
		return fmt.Errorf("missing claudeAiOauth.accessToken")
	}
	if o.RefreshToken == "" {
		return fmt.Errorf("missing claudeAiOauth.refreshToken")
	}
	if o.ExpiresAt <= 0 {
		return fmt.Errorf("missing or invalid claudeAiOauth.expiresAt")
	}
	if !strings.HasPrefix(o.AccessToken, "sk-ant-oat") {
		return fmt.Errorf("accessToken does not look like a Claude OAuth token (expected prefix sk-ant-oat)")
	}
	return nil
}
