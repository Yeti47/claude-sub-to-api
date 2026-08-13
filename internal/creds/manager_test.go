package creds

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// expiringCreds returns a credentials file whose token is already within the leeway.
func expiringCreds(expiresAt int64) string {
	return `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-old","refreshToken":"sk-ant-ort01-ref","expiresAt":` +
		jsonNumber(expiresAt) + `}}`
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestManager_RefreshesAndPersists(t *testing.T) {
	// Fake token endpoint issues a new token.
	var gotRefresh, gotClientID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req refreshRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotRefresh = req.RefreshToken
		gotClientID = req.ClientID
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(refreshResponse{
			AccessToken:  "sk-ant-oat01-new",
			RefreshToken: "sk-ant-ort01-newref",
			ExpiresIn:    3600,
		})
	}))
	defer srv.Close()

	// Token already expired → forces refresh.
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(1)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{
		path:    p,
		leeway:  60 * time.Second,
		client:  srv.Client(),
		now:     time.Now,
		persist: true,
	}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}

	// Point the manager at the fake token endpoint by rewriting request URLs.
	c := srv.Client()
	c.Transport = rewriteTransport{base: srv.URL, rt: c.Transport}
	m.client = c

	tok, err := m.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("AccessToken: %v", err)
	}
	if tok != "sk-ant-oat01-new" {
		t.Fatalf("got token %q, want refreshed", tok)
	}
	if gotRefresh != "sk-ant-ort01-ref" {
		t.Fatalf("refresh token sent = %q", gotRefresh)
	}
	if gotClientID != oauthClientID {
		t.Fatalf("client_id = %q", gotClientID)
	}

	// Rotated credentials persisted to disk.
	reloaded, err := Load(p)
	if err != nil {
		t.Fatalf("reload persisted creds: %v", err)
	}
	if reloaded.ClaudeAiOauth.AccessToken != "sk-ant-oat01-new" {
		t.Fatalf("persisted access token = %q", reloaded.ClaudeAiOauth.AccessToken)
	}
	if reloaded.ClaudeAiOauth.RefreshToken != "sk-ant-ort01-newref" {
		t.Fatalf("persisted refresh token = %q", reloaded.ClaudeAiOauth.RefreshToken)
	}
}

func TestManager_ReturnsCachedWhenFresh(t *testing.T) {
	// Expires far in the future.
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(future)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{path: p, leeway: 60 * time.Second, now: time.Now}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	// No HTTP client set: a refresh attempt would nil-pointer, so a successful
	// return proves the cached token was used.
	tok, err := m.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("AccessToken: %v", err)
	}
	if tok != "sk-ant-oat01-old" {
		t.Fatalf("expected cached token, got %q", tok)
	}
}

func TestManagerFromJSON_RefreshesInMemoryOnly(t *testing.T) {
	// Fake token endpoint issues a new token.
	var gotRefresh string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req refreshRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotRefresh = req.RefreshToken
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(refreshResponse{
			AccessToken:  "sk-ant-oat01-new",
			RefreshToken: "sk-ant-ort01-newref",
			ExpiresIn:    3600,
		})
	}))
	defer srv.Close()

	// Expired token forces a refresh. persist=false: nothing may be written to disk.
	m, err := NewManagerFromJSON(expiringCreds(1), 60*time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := srv.Client()
	c.Transport = rewriteTransport{base: srv.URL, rt: c.Transport}
	m.client = c

	tok, err := m.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("AccessToken: %v", err)
	}
	if tok != "sk-ant-oat01-new" {
		t.Fatalf("got token %q, want refreshed in-memory token", tok)
	}
	if gotRefresh != "sk-ant-ort01-ref" {
		t.Fatalf("refresh token sent = %q", gotRefresh)
	}
	// Rotation kept in memory (persist=false), not on disk.
	if m.creds.ClaudeAiOauth.RefreshToken != "sk-ant-ort01-newref" {
		t.Fatalf("in-memory refresh token = %q", m.creds.ClaudeAiOauth.RefreshToken)
	}
	if m.creds.ClaudeAiOauth.AccessToken != "sk-ant-oat01-new" {
		t.Fatalf("in-memory access token = %q", m.creds.ClaudeAiOauth.AccessToken)
	}

	// Cached token served on the next call without another refresh.
	tok2, err := m.AccessToken(context.Background())
	if err != nil {
		t.Fatalf("AccessToken (2nd): %v", err)
	}
	if tok2 != "sk-ant-oat01-new" {
		t.Fatalf("second call got %q, want cached refreshed token", tok2)
	}
}

func TestNewManagerFromJSON_Invalid(t *testing.T) {
	if _, err := NewManagerFromJSON("{not json", 60*time.Second, nil); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestNewManagerFromJSON_MissingToken(t *testing.T) {
	bad := `{"claudeAiOauth":{"refreshToken":"sk-ant-ort01-ref","expiresAt":1893456000000}}`
	if _, err := NewManagerFromJSON(bad, 60*time.Second, nil); err == nil {
		t.Fatal("expected error for missing accessToken")
	}
}

// rewriteTransport rewrites any request URL to point at base (the test server).
type rewriteTransport struct {
	base string
	rt   http.RoundTripper
}

func (rw rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = rw.base[len("http://"):]
	rt := rw.rt
	if rt == nil {
		rt = http.DefaultTransport
	}
	return rt.RoundTrip(req)
}
