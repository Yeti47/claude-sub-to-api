// Package creds also provides a Manager that keeps the OAuth access token fresh.
package creds

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.uber.org/zap"
)

// tokenEndpoint is Anthropic's OAuth token endpoint used for refreshes.
const tokenEndpoint = "https://console.anthropic.com/v1/oauth/token"

// oauthClientID is the public Claude Code OAuth client identifier.
const oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

// refreshRequest is the JSON body sent to the token endpoint.
type refreshRequest struct {
	GrantType    string `json:"grant_type"`
	RefreshToken string `json:"refresh_token"`
	ClientID     string `json:"client_id"`
}

// refreshResponse is the JSON body returned by the token endpoint.
type refreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"` // seconds
}

// httpClient is the minimal interface for token refresh, enabling test fakes.
type httpClient interface {
	Do(req *http.Request) (*http.Response, error)
}

// Manager returns a valid access token, refreshing it before expiry and
// persisting the rotated credentials back to disk.
type Manager struct {
	path    string
	leeway  time.Duration
	client  httpClient
	now     func() time.Time
	log     *zap.Logger
	persist bool // false when creds came from an env var (no file to write back to)

	mu       sync.Mutex
	creds    *File
	lastMod  time.Time
	lastSize int64
}

// NewManager loads the credentials at path and returns a Manager.
func NewManager(path string, leeway time.Duration, log *zap.Logger) (*Manager, error) {
	m := &Manager{
		path:    path,
		leeway:  leeway,
		client:  &http.Client{Timeout: 30 * time.Second},
		now:     time.Now,
		log:     log,
		persist: true,
	}
	if err := m.reloadFromDisk(); err != nil {
		return nil, err
	}
	return m, nil
}

// NewManagerFromJSON loads credentials from a JSON payload (the contents of
// ~/.claude/.credentials.json) supplied via an env var, e.g. for serverless
// deployments (Azure ACA, etc.) where there is no writable credentials file.
// Refreshed tokens are rotated in memory only and never persisted.
func NewManagerFromJSON(jsonData string, leeway time.Duration, log *zap.Logger) (*Manager, error) {
	f, err := LoadJSON([]byte(jsonData))
	if err != nil {
		return nil, err
	}
	return &Manager{
		leeway:  leeway,
		client:  &http.Client{Timeout: 30 * time.Second},
		now:     time.Now,
		log:     log,
		persist: false,
		creds:   f,
	}, nil
}

// AccessToken returns a valid access token, refreshing it if it is within the
// leeway of expiring. It also re-reads the file if it changed on disk so an
// external `claude login` re-auth is picked up without a restart.
func (m *Manager) AccessToken(ctx context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Pick up external re-auth (file-backed creds only; env-var creds are static).
	if m.persist {
		if changed, err := m.fileChangedLocked(); err == nil && changed {
			_ = m.reloadFromDiskLocked()
		}
	}

	if m.creds == nil {
		return "", fmt.Errorf("no credentials loaded")
	}

	if !m.tokenExpiredLocked() {
		m.logger().Debug("using cached access token",
			zap.Time("expires_at", time.UnixMilli(m.creds.ClaudeAiOauth.ExpiresAt)),
			zap.Duration("valid_for", time.Until(time.UnixMilli(m.creds.ClaudeAiOauth.ExpiresAt))),
		)
		return m.creds.ClaudeAiOauth.AccessToken, nil
	}

	m.logger().Info("access token expired or within leeway, refreshing",
		zap.Time("expires_at", time.UnixMilli(m.creds.ClaudeAiOauth.ExpiresAt)),
	)
	if err := m.refreshLocked(ctx); err != nil {
		return "", err
	}
	m.logger().Info("refreshed access token",
		zap.Time("new_expires_at", time.UnixMilli(m.creds.ClaudeAiOauth.ExpiresAt)),
	)
	return m.creds.ClaudeAiOauth.AccessToken, nil
}

// logger returns the configured logger, or a no-op one if unset (e.g. in tests).
func (m *Manager) logger() *zap.Logger {
	if m.log == nil {
		return zap.NewNop()
	}
	return m.log
}

// tokenExpiredLocked reports whether the current token is expired or within the leeway.
func (m *Manager) tokenExpiredLocked() bool {
	expiresAt := time.UnixMilli(m.creds.ClaudeAiOauth.ExpiresAt)
	return m.now().Add(m.leeway).After(expiresAt)
}

// refreshLocked calls the token endpoint and persists the rotated credentials.
func (m *Manager) refreshLocked(ctx context.Context) error {
	o := m.creds.ClaudeAiOauth
	body, err := json.Marshal(refreshRequest{
		GrantType:    "refresh_token",
		RefreshToken: o.RefreshToken,
		ClientID:     oauthClientID,
	})
	if err != nil {
		return fmt.Errorf("marshal refresh request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build refresh request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return fmt.Errorf("refresh token request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read refresh response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("refresh token failed: status %d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	var rr refreshResponse
	if err := json.Unmarshal(respBody, &rr); err != nil {
		return fmt.Errorf("parse refresh response: %w", err)
	}
	if rr.AccessToken == "" {
		return fmt.Errorf("refresh response missing access_token")
	}

	// Rotate tokens; a new refresh token is issued on each refresh.
	m.creds.ClaudeAiOauth.AccessToken = rr.AccessToken
	if rr.RefreshToken != "" {
		m.creds.ClaudeAiOauth.RefreshToken = rr.RefreshToken
	}
	if rr.ExpiresIn > 0 {
		m.creds.ClaudeAiOauth.ExpiresAt = m.now().Add(time.Duration(rr.ExpiresIn) * time.Second).UnixMilli()
	}

	if err := m.saveLocked(); err != nil {
		return fmt.Errorf("persist refreshed credentials: %w", err)
	}
	return nil
}

// reloadFromDisk reads and validates the credentials file (public, used at startup).
func (m *Manager) reloadFromDisk() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reloadFromDiskLocked()
}

func (m *Manager) reloadFromDiskLocked() error {
	f, err := Load(m.path)
	if err != nil {
		return err
	}
	m.creds = f
	m.noteFileStatLocked()
	return nil
}

// fileChangedLocked reports whether the credentials file's mtime/size changed.
func (m *Manager) fileChangedLocked() (bool, error) {
	st, err := os.Stat(m.path)
	if err != nil {
		return false, err
	}
	if st.ModTime() != m.lastMod || st.Size() != m.lastSize {
		return true, nil
	}
	return false, nil
}

func (m *Manager) noteFileStatLocked() {
	if !m.persist {
		return
	}
	if st, err := os.Stat(m.path); err == nil {
		m.lastMod = st.ModTime()
		m.lastSize = st.Size()
	}
}

// saveLocked writes the credentials back to disk atomically (tmp + rename), mode 0600.
// When creds came from an env var there is nowhere to write them, so the
// rotation is kept in memory only.
func (m *Manager) saveLocked() error {
	if !m.persist {
		m.logger().Debug("skipping persist of rotated credentials (env-var source, no file)")
		return nil
	}
	data, err := json.MarshalIndent(m.creds, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}

	dir := filepath.Dir(m.path)
	tmp, err := os.CreateTemp(dir, ".credentials-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, m.path); err != nil {
		return fmt.Errorf("rename temp file: %w", err)
	}

	m.noteFileStatLocked()
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
