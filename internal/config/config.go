// Package config loads and validates the proxy's environment-based configuration.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// Config holds all runtime configuration for the proxy.
type Config struct {
	// ListenAddr is the address the HTTP server binds to (e.g. ":8080").
	ListenAddr string
	// UpstreamBaseURL is the Anthropic API base URL requests are forwarded to.
	UpstreamBaseURL string
	// ProxyAPIKey is the static key consumers must present to call /v1/*.
	ProxyAPIKey string
	// CredentialsPath is the path to the externally-generated ~/.claude/.credentials.json.
	CredentialsPath string
	// CredentialsJSON is the full JSON content of ~/.claude/.credentials.json,
	// provided via the CLAUDE_CREDENTIALS_JSON env var. When set it takes
	// precedence over CredentialsPath and no credentials file is required
	// (intended for serverless deployments without a writable data dir).
	CredentialsJSON string
	// LogLevel is the zap log level (debug, info, warn, error).
	LogLevel string
	// ClaudeUserAgent is the User-Agent header sent to the upstream API.
	ClaudeUserAgent string
	// RefreshLeeway is how long before token expiry a refresh is triggered.
	RefreshLeeway time.Duration
	// AutoKeepalive enables the background token-refresh goroutine at startup.
	// It self-schedules: each rotation reports when the next one should happen.
	AutoKeepalive bool
}

// Load reads configuration from environment variables and validates it.
func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:      getEnv("LISTEN_ADDR", ":8080"),
		UpstreamBaseURL: strings.TrimRight(getEnv("UPSTREAM_BASE_URL", "https://api.anthropic.com"), "/"),
		ProxyAPIKey:     os.Getenv("PROXY_API_KEY"),
		CredentialsPath: getEnv("CREDENTIALS_PATH", "/data/.credentials.json"),
		CredentialsJSON: os.Getenv("CLAUDE_CREDENTIALS_JSON"),
		LogLevel:        strings.ToLower(getEnv("LOG_LEVEL", "info")),
		ClaudeUserAgent: getEnv("CLAUDE_UA", "claude-cli/2.1.44"),
		RefreshLeeway:   getEnvDuration("REFRESH_LEEWAY", 60*time.Second),
		AutoKeepalive:   getEnvBool("AUTO_KEEPALIVE", false),
	}

	if cfg.ProxyAPIKey == "" {
		return nil, fmt.Errorf("PROXY_API_KEY is required (consumers use it as their Anthropic API key)")
	}

	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return nil, fmt.Errorf("LOG_LEVEL must be one of debug, info, warn, error; got %q", cfg.LogLevel)
	}

	return cfg, nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

// getEnvBool parses a boolean env var, accepting common true/false spellings
// (1/true/yes/on and 0/false/no/off). Any other value falls back to def.
func getEnvBool(key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}
