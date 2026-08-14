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

func TestManager_RefreshForcesRotationWhenFresh(t *testing.T) {
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

	// Token is fresh (far in the future): AccessToken would serve the cache,
	// but Refresh must rotate regardless of the leeway.
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(future)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{
		path:    p,
		leeway:  60 * time.Second,
		now:     time.Now,
		persist: true,
	}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	c := srv.Client()
	c.Transport = rewriteTransport{base: srv.URL, rt: c.Transport}
	m.client = c

	tok, next, err := m.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if tok != "sk-ant-oat01-new" {
		t.Fatalf("got token %q, want rotated", tok)
	}
	if gotRefresh != "sk-ant-ort01-ref" {
		t.Fatalf("refresh token sent = %q", gotRefresh)
	}

	// ExpiresIn=3600, leeway=60s -> the reported next refresh should be
	// ~now+3540s (expiry minus leeway, already factored in).
	if !next.After(time.Now().Add(3500 * time.Second)) {
		t.Fatalf("next = %v, want ~expiry - leeway in the future", next)
	}
	if !next.Before(time.Now().Add(3600 * time.Second)) {
		t.Fatalf("next = %v, want ~expiry - leeway in the future", next)
	}

	// Rotated creds persisted to disk.
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

func TestManager_RefreshFloorsStaleExpiry(t *testing.T) {
	// Fake token endpoint omits ExpiresIn, so refreshLocked keeps the stored
	// (past) expiry. Refresh must floor the reported next-refresh time instead
	// of handing back a past timestamp.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(refreshResponse{
			AccessToken:  "sk-ant-oat01-new",
			RefreshToken: "sk-ant-ort01-newref",
			// ExpiresIn omitted -> 0 -> ExpiresAt stays stale.
		})
	}))
	defer srv.Close()

	// Credentials whose token is already expired.
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(1)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{
		path:    p,
		leeway:  60 * time.Second,
		now:     time.Now,
		persist: true,
	}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	c := srv.Client()
	c.Transport = rewriteTransport{base: srv.URL, rt: c.Transport}
	m.client = c

	tok, next, err := m.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if tok != "sk-ant-oat01-new" {
		t.Fatalf("got token %q, want rotated", tok)
	}
	// Stale expiry must be floored to ~minNextRefresh in the future.
	if !next.After(time.Now().Add(30 * time.Second)) {
		t.Fatalf("next = %v, want floored ~1m in the future", next)
	}
	if !next.Before(time.Now().Add(2 * time.Minute)) {
		t.Fatalf("next = %v, want floored ~1m in the future", next)
	}
}

func TestManager_RefreshErrorsWithoutCreds(t *testing.T) {
	m := &Manager{}
	if _, _, err := m.Refresh(context.Background()); err == nil {
		t.Fatal("expected error when no credentials loaded")
	}
}

func TestManager_Healthy_ValidToken(t *testing.T) {
	// Expires far in the future: Healthy must be true without any HTTP client
	// (proving it never attempts a rotation or network call).
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(future)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{path: p, leeway: 60 * time.Second, now: time.Now, persist: true}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	if !m.Healthy() {
		t.Fatal("Healthy() = false, want true for a valid, non-expired token")
	}
}

func TestManager_Healthy_WithinLeewayStillHealthy(t *testing.T) {
	// Token expires in 30s, leeway is 60s: within-leeway tokens remain usable
	// (AccessToken would refresh on demand) and must NOT be reported unhealthy.
	soon := time.Now().Add(30 * time.Second).UnixMilli()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(soon)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{path: p, leeway: 60 * time.Second, now: time.Now, persist: true}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	if !m.Healthy() {
		t.Fatal("Healthy() = false, want true for a within-leeway (still valid) token")
	}
}

func TestManager_Healthy_ExpiredToken(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(expiringCreds(1)), 0o600); err != nil {
		t.Fatal(err)
	}

	m := &Manager{path: p, leeway: 60 * time.Second, now: time.Now, persist: true}
	if err := m.reloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	if m.Healthy() {
		t.Fatal("Healthy() = true, want false for an expired token")
	}
}

func TestManager_Healthy_NoCreds(t *testing.T) {
	m := &Manager{}
	if m.Healthy() {
		t.Fatal("Healthy() = true, want false when no credentials are loaded")
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
