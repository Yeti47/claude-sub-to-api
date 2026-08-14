// Command claude-sub-to-api exposes an Anthropic-compatible API backed by a Claude subscription.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.uber.org/zap"

	"github.com/Yeti47/claude-sub-to-api/internal/auth"
	"github.com/Yeti47/claude-sub-to-api/internal/config"
	"github.com/Yeti47/claude-sub-to-api/internal/creds"
	"github.com/Yeti47/claude-sub-to-api/internal/keepalive"
	"github.com/Yeti47/claude-sub-to-api/internal/proxy"
)

func main() {
	if err := run(); err != nil {
		// Fall back to a plain print in case the logger wasn't built yet.
		println("fatal:", err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger, err := buildLogger(cfg.LogLevel)
	if err != nil {
		return err
	}
	defer logger.Sync()

	var mgr *creds.Manager
	if cfg.CredentialsJSON != "" {
		mgr, err = creds.NewManagerFromJSON(cfg.CredentialsJSON, cfg.RefreshLeeway, logger)
		if err != nil {
			return err
		}
		logger.Info("loaded Claude subscription credentials from CLAUDE_CREDENTIALS_JSON env var")
	} else {
		mgr, err = creds.NewManager(cfg.CredentialsPath, cfg.RefreshLeeway, logger)
		if err != nil {
			return err
		}
		logger.Info("loaded Claude subscription credentials", zap.String("path", cfg.CredentialsPath))
	}

	handler := proxy.NewHandler(cfg.UpstreamBaseURL, mgr, cfg.ClaudeUserAgent, logger)

	// Keepalive: forces OAuth token rotation on demand and (optionally) on a
	// self-scheduled loop, independent of the lazy leeway-based refresh used
	// for requests. Each rotation reports when the next one should happen.
	keep := keepalive.New(mgr, logger)
	if cfg.AutoKeepalive {
		keep.Start()
		logger.Info("auto-keepalive enabled at startup")
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", healthzHandler(mgr))

	// Anthropic-compatible API surface, gated by the consumer API key.
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAPIKey(cfg.ProxyAPIKey))
		r.Post("/v1/messages", handler.ServeHTTP)
		r.Get("/v1/models", handler.ServeHTTP)

		// Keepalive control plane.
		r.Get("/v1/keepalive", func(w http.ResponseWriter, r *http.Request) {
			next, err := keep.Pulse(r.Context())
			if err != nil {
				http.Error(w, "token refresh failed: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			writeKeepaliveJSON(w, keep.Enabled(), next)
		})
		r.Post("/v1/keepalive/auto", func(w http.ResponseWriter, _ *http.Request) {
			keep.Start() // idempotent
			writeKeepaliveJSON(w, keep.Enabled(), time.Time{})
		})
		r.Delete("/v1/keepalive/auto", func(w http.ResponseWriter, _ *http.Request) {
			keep.Stop() // idempotent
			writeKeepaliveJSON(w, keep.Enabled(), time.Time{})
		})
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           r,
		ReadHeaderTimeout: 30 * time.Second,
		// No WriteTimeout: streaming responses can be long-lived.
		IdleTimeout: 120 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", zap.String("addr", cfg.ListenAddr), zap.String("upstream", cfg.UpstreamBaseURL))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
		keep.Stop() // idempotent; stops the auto-keepalive goroutine
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		keep.Stop()
		return err
	}
}

// healthzHandler returns the liveness handler. It reports 200 when credentials
// are loaded and the token is valid, and 503 when the token is missing or
// invalid. It never triggers a token rotation and makes no upstream calls, so
// probes cannot accidentally force a refresh.
func healthzHandler(mgr *creds.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if !mgr.Healthy() {
			http.Error(w, "unhealthy: credentials missing or token invalid", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}
}

// writeKeepaliveJSON writes the shared keepalive control-plane response.
// next, when non-zero, is included as next_refresh_at (RFC3339, UTC): the
// timestamp at which the token should be rotated again (leeway factored in).
func writeKeepaliveJSON(w http.ResponseWriter, autoEnabled bool, next time.Time) {
	resp := map[string]any{
		"status":         "ok",
		"auto_keepalive": autoEnabled,
	}
	if !next.IsZero() {
		resp["next_refresh_at"] = next.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

func buildLogger(level string) (*zap.Logger, error) {
	lvl, err := zap.ParseAtomicLevel(level)
	if err != nil {
		return nil, err
	}
	cfg := zap.NewProductionConfig()
	cfg.Level = lvl
	return cfg.Build()
}
