package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testKey = "test-proxy-key"

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func doReq(t *testing.T, setHeaders func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	h := RequireAPIKey(testKey)(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	if setHeaders != nil {
		setHeaders(req)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestAuth_BearerAllowed(t *testing.T) {
	rr := doReq(t, func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testKey) })
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestAuth_XAPIKeyAllowed(t *testing.T) {
	rr := doReq(t, func(r *http.Request) { r.Header.Set("x-api-key", testKey) })
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestAuth_MissingKey(t *testing.T) {
	rr := doReq(t, nil)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestAuth_WrongKey(t *testing.T) {
	rr := doReq(t, func(r *http.Request) { r.Header.Set("Authorization", "Bearer wrong") })
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestAuth_ErrorShapeIsAnthropic(t *testing.T) {
	rr := doReq(t, nil)
	body := rr.Body.String()
	if !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, `"authentication_error"`) {
		t.Fatalf("error body not Anthropic-shaped: %s", body)
	}
}
