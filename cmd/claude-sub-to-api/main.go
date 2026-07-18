// Command claude-sub-to-api exposes an Anthropic-compatible API backed by a Claude subscription.
package main

import (
	"context"
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

	mgr, err := creds.NewManager(cfg.CredentialsPath, cfg.RefreshLeeway, logger)
	if err != nil {
		return err
	}
	logger.Info("loaded Claude subscription credentials", zap.String("path", cfg.CredentialsPath))

	handler := proxy.NewHandler(cfg.UpstreamBaseURL, mgr, cfg.ClaudeUserAgent, logger)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Anthropic-compatible API surface, gated by the consumer API key.
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAPIKey(cfg.ProxyAPIKey))
		r.Post("/v1/messages", handler.ServeHTTP)
		r.Get("/v1/models", handler.ServeHTTP)
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
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
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
