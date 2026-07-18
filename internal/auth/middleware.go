// Package auth provides middleware that gates /v1/* behind a static consumer API key.
package auth

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

// anthropicError is the error body shape the Anthropic API returns.
type anthropicError struct {
	Type  string             `json:"type"`
	Error anthropicErrorBody `json:"error"`
}

type anthropicErrorBody struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// RequireAPIKey returns middleware that rejects requests lacking the expected key.
// The key is accepted either as `Authorization: Bearer <key>` or `x-api-key: <key>`.
func RequireAPIKey(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !validKey(r, key) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(anthropicError{
					Type: "error",
					Error: anthropicErrorBody{
						Type:    "authentication_error",
						Message: "invalid or missing API key",
					},
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func validKey(r *http.Request, want string) bool {
	got := bearerToken(r.Header.Get("Authorization"))
	if got == "" {
		got = r.Header.Get("x-api-key")
	}
	if got == "" || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func bearerToken(h string) string {
	const prefix = "Bearer "
	if strings.HasPrefix(h, prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}
