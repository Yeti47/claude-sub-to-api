// Package keepalive keeps the Claude OAuth token (and its refresh chain) alive
// by forcing real token rotations through the credentials manager, independent
// of the refresh leeway, and exposes one-shot and auto pulse controls. Rather
// than a fixed interval, each rotation reports the timestamp at which the next
// rotation should happen (the token expiry minus the refresh leeway, already
// factored in), so the auto loop schedules itself from the token's own
// lifetime. Auto keepalive is opt-in and idempotent: enabling or disabling it
// multiple times is safe.
package keepalive

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
)

// rotator is the minimal surface the keepalive service needs from the
// credentials manager: a method that forces a token rotation regardless of
// the configured refresh leeway and reports when the next rotation should
// happen.
type rotator interface {
	Refresh(ctx context.Context) (string, time.Time, error)
}

// retryDelay is how soon a failed rotation is retried. It is a safety backoff
// only — the steady-state cadence comes from the timestamp reported by each
// successful rotation.
const retryDelay = time.Minute

// Service periodically forces token rotation via the rotator, scheduling each
// next rotation from the timestamp returned by the previous one.
// Start/Stop are idempotent and safe to call concurrently.
type Service struct {
	rot rotator
	log *zap.Logger

	mu     sync.Mutex
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds a Service. A nil logger is replaced with a no-op logger.
func New(rot rotator, log *zap.Logger) *Service {
	if log == nil {
		log = zap.NewNop()
	}
	return &Service{rot: rot, log: log}
}

// Pulse forces a one-shot token rotation and returns the timestamp at which
// the next rotation should happen (leeway already factored in), or an error
// if the rotation could not be performed (e.g. upstream unreachable or
// credentials missing).
func (s *Service) Pulse(ctx context.Context) (time.Time, error) {
	_, next, err := s.rot.Refresh(ctx)
	return next, err
}

// Start begins the auto-keepalive goroutine. It is idempotent: a no-op if
// already running. An immediate rotation is issued first, then subsequent
// rotations are scheduled from the timestamps each one reports. The goroutine
// stops when Stop is called.
func (s *Service) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return // already running
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.wg.Add(1)
	go s.loop(ctx)
}

// Stop halts the auto-keepalive goroutine and waits for it to exit. It is
// idempotent: a no-op if not running.
func (s *Service) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		s.wg.Wait()
	}
}

// Enabled reports whether auto-keepalive is currently running.
func (s *Service) Enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel != nil
}

// nextFor returns when the next rotation should be attempted, guarding
// against a zero or past timestamp (e.g. after a failed rotation) so the loop
// never spins.
func (s *Service) nextFor(next time.Time) time.Time {
	if next.After(time.Now()) {
		return next
	}
	return time.Now().Add(retryDelay)
}

func (s *Service) loop(ctx context.Context) {
	defer s.wg.Done()

	s.log.Debug("auto-keepalive starting")
	for {
		next, err := s.Pulse(ctx)
		if err != nil {
			if ctx.Err() == nil {
				s.log.Warn("auto-keepalive rotation failed", zap.Error(err))
			}
			next = time.Time{}
		}
		timer := time.NewTimer(time.Until(s.nextFor(next)))
		select {
		case <-ctx.Done():
			timer.Stop()
			s.log.Debug("auto-keepalive stopped")
			return
		case <-timer.C:
		}
	}
}
