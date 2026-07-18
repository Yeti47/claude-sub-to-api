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
		path:   p,
		leeway: 60 * time.Second,
		client: srv.Client(),
		now:    time.Now,
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
