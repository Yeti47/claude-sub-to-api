package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/Yeti47/claude-sub-to-api/internal/creds"
)

// writeTestCreds writes a credentials file with the given expiry (unix ms).
func writeTestCreds(t *testing.T, expiresAt int64) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	data := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-test","refreshToken":"sk-ant-ort01-test","expiresAt":` +
		strconv.FormatInt(expiresAt, 10) + `}}`
	if err := os.WriteFile(p, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func doHealth(t *testing.T, mgr *creds.Manager) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()
	healthzHandler(mgr).ServeHTTP(rr, req)
	return rr
}

func TestHealthz_Healthy(t *testing.T) {
	mgr, err := creds.NewManager(writeTestCreds(t, time.Now().Add(2*time.Hour).UnixMilli()), time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	rr := doHealth(t, mgr)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if rr.Body.String() != "ok" {
		t.Fatalf("body = %q, want %q", rr.Body.String(), "ok")
	}
}

func TestHealthz_ExpiredToken(t *testing.T) {
	mgr, err := creds.NewManager(writeTestCreds(t, 1), time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	rr := doHealth(t, mgr)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}

func TestHealthz_NoCreds(t *testing.T) {
	mgr := &creds.Manager{}
	rr := doHealth(t, mgr)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}
