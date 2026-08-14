package keepalive

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeRotator counts Refresh calls, optionally blocking until ctx is done (to
// simulate an in-flight rotation during Stop), returning an error, and/or
// reporting a next-refresh timestamp. When next is zero, it reports a far
// future time (so scheduling produces no further pulses).
type fakeRotator struct {
	mu    sync.Mutex
	calls int
	err   error
	block time.Duration
	next  time.Time
}

func (f *fakeRotator) Refresh(ctx context.Context) (string, time.Time, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()

	if f.block > 0 {
		select {
		case <-time.After(f.block):
		case <-ctx.Done():
			return "", time.Time{}, ctx.Err()
		}
	}
	if f.err != nil {
		return "", time.Time{}, f.err
	}
	next := f.next
	if next.IsZero() {
		next = time.Now().Add(time.Hour)
	}
	return "rotated-token", next, nil
}

func (f *fakeRotator) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestPulse(t *testing.T) {
	fp := &fakeRotator{next: time.Now().Add(time.Minute)}
	s := New(fp, nil)

	next, err := s.Pulse(context.Background())
	if err != nil {
		t.Fatalf("Pulse: %v", err)
	}
	if got := fp.count(); got != 1 {
		t.Fatalf("Refresh calls = %d, want 1", got)
	}
	if next.IsZero() {
		t.Fatal("Pulse returned zero next-refresh time")
	}
}

func TestPulseErrorPropagates(t *testing.T) {
	want := errors.New("upstream down")
	fp := &fakeRotator{err: want}
	s := New(fp, nil)

	next, err := s.Pulse(context.Background())
	if !errors.Is(err, want) {
		t.Fatalf("Pulse err = %v, want %v", err, want)
	}
	if !next.IsZero() {
		t.Fatalf("Pulse next = %v, want zero on error", next)
	}
}

func TestStartStopIdempotent(t *testing.T) {
	fp := &fakeRotator{}
	s := New(fp, nil)

	s.Start()
	s.Start() // second Start must be a no-op
	if !s.Enabled() {
		t.Fatal("Enabled() = false after Start")
	}

	s.Stop()
	s.Stop() // second Stop must be a no-op
	if s.Enabled() {
		t.Fatal("Enabled() = true after Stop")
	}
}

func TestAutoSchedulesFromReportedTime(t *testing.T) {
	// The fake reports "rotate again in 80ms". After the immediate pulse there
	// must be NO further pulse before that deadline (no fixed interval), and a
	// second one must occur after it.
	fp := &fakeRotator{next: time.Now().Add(80 * time.Millisecond)}
	s := New(fp, nil)

	s.Start()
	defer s.Stop()

	// Wait for the immediate pulse to land.
	deadline := time.Now().Add(1 * time.Second)
	for fp.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	// Well before the reported next time, count must still be 1.
	time.Sleep(30 * time.Millisecond)
	if got := fp.count(); got != 1 {
		t.Fatalf("Refresh calls before reported next = %d, want 1 (self-scheduled, not fixed interval)", got)
	}
	// After the reported next time, a second pulse must have occurred.
	deadline = time.Now().Add(1 * time.Second)
	for fp.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := fp.count(); got < 2 {
		t.Fatalf("Refresh calls after reported next = %d, want >= 2", got)
	}
}

func TestStopStopsPulsing(t *testing.T) {
	// Short reported next so the loop would keep firing if not stopped.
	fp := &fakeRotator{next: time.Now().Add(10 * time.Millisecond)}
	s := New(fp, nil)

	s.Start()
	// Wait for at least the immediate pulse to land.
	deadline := time.Now().Add(1 * time.Second)
	for fp.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	s.Stop()

	before := fp.count()
	time.Sleep(40 * time.Millisecond)
	if after := fp.count(); after != before {
		t.Fatalf("Refresh calls changed after Stop: before=%d after=%d", before, after)
	}
}

func TestFailedRotationDoesNotHotLoop(t *testing.T) {
	// retryDelay is a minute, so after the immediate failed pulse there must
	// be no further call in the near term.
	fp := &fakeRotator{err: errors.New("down")}
	s := New(fp, nil)

	s.Start()
	defer s.Stop()

	deadline := time.Now().Add(1 * time.Second)
	for fp.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if got := fp.count(); got != 1 {
		t.Fatalf("Refresh calls after failed rotation = %d, want 1 (no hot loop)", got)
	}
}
