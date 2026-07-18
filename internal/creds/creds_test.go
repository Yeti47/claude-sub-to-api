package creds

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validCreds = `{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-abc",
    "refreshToken": "sk-ant-ort01-xyz",
    "expiresAt": 1893456000000,
    "scopes": ["user:inference"],
    "subscriptionType": "max"
  }
}`

func writeTemp(t *testing.T, contents string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".credentials.json")
	if err := os.WriteFile(p, []byte(contents), 0o600); err != nil {
		t.Fatalf("write temp creds: %v", err)
	}
	return p
}

func TestLoad_Valid(t *testing.T) {
	f, err := Load(writeTemp(t, validCreds))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	o := f.ClaudeAiOauth
	if o.AccessToken != "sk-ant-oat01-abc" || o.RefreshToken != "sk-ant-ort01-xyz" {
		t.Fatalf("unexpected tokens: %+v", o)
	}
	if o.ExpiresAt != 1893456000000 {
		t.Fatalf("unexpected expiresAt: %d", o.ExpiresAt)
	}
}

func TestLoad_MissingFile(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestLoad_MalformedJSON(t *testing.T) {
	if _, err := Load(writeTemp(t, "{not json")); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestLoad_MissingAccessToken(t *testing.T) {
	bad := strings.Replace(validCreds, `"accessToken": "sk-ant-oat01-abc",`, "", 1)
	if _, err := Load(writeTemp(t, bad)); err == nil {
		t.Fatal("expected error for missing accessToken")
	}
}

func TestLoad_WrongPrefix(t *testing.T) {
	bad := strings.Replace(validCreds, "sk-ant-oat01-abc", "sk-ant-api03-abc", 1)
	if _, err := Load(writeTemp(t, bad)); err == nil {
		t.Fatal("expected error for non-OAuth token prefix")
	}
}
