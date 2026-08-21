package server

import (
	"fmt"
	"testing"
	"time"
)

func TestWindowRateLimiterReturnsRetryAfterAndResets(t *testing.T) {
	limiter := newWindowRateLimiter(2, time.Minute)
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	for attempt := 1; attempt <= 2; attempt++ {
		allowed, retryAfter := limiter.allow("198.51.100.10", now)
		if !allowed || retryAfter != 0 {
			t.Fatalf("attempt %d allowed=%v retryAfter=%v", attempt, allowed, retryAfter)
		}
	}
	allowed, retryAfter := limiter.allow("198.51.100.10", now.Add(10*time.Second))
	if allowed || retryAfter != 50*time.Second {
		t.Fatalf("limited request allowed=%v retryAfter=%v, want false/50s", allowed, retryAfter)
	}
	allowed, retryAfter = limiter.allow("198.51.100.10", now.Add(time.Minute))
	if !allowed || retryAfter != 0 {
		t.Fatalf("reset request allowed=%v retryAfter=%v", allowed, retryAfter)
	}
}

func TestWindowRateLimiterPrunesExpiredKeys(t *testing.T) {
	limiter := newWindowRateLimiter(1, time.Second)
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	for index := 0; index < 4096; index++ {
		limiter.allow(fmt.Sprintf("client-%d", index), now)
	}
	limiter.allow("fresh", now.Add(2*time.Second))
	if got := len(limiter.entries); got != 1 {
		t.Fatalf("entry count after prune = %d, want 1", got)
	}
}

func TestConcurrentLimiterCapsAndReleasesPerKey(t *testing.T) {
	limiter := newConcurrentLimiter(2)
	releaseA, ok := limiter.acquire("account")
	if !ok {
		t.Fatal("first acquire rejected")
	}
	releaseB, ok := limiter.acquire("account")
	if !ok {
		t.Fatal("second acquire rejected")
	}
	if _, ok := limiter.acquire("account"); ok {
		t.Fatal("third acquire accepted")
	}
	releaseA()
	releaseA()
	if _, ok := limiter.acquire("account"); !ok {
		t.Fatal("slot was not released idempotently")
	}
	releaseB()
}
