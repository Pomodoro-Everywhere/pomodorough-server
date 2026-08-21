package server

import (
	"sync"
	"time"
)

type windowRateEntry struct {
	startedAt time.Time
	count     int
}

type windowRateLimiter struct {
	mu       sync.Mutex
	limit    int
	window   time.Duration
	entries  map[string]windowRateEntry
	requests uint64
}

func newWindowRateLimiter(limit int, window time.Duration) *windowRateLimiter {
	return &windowRateLimiter{limit: limit, window: window, entries: make(map[string]windowRateEntry)}
}

func (l *windowRateLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests++
	entry, exists := l.entries[key]
	if !exists && len(l.entries) >= 4096 {
		for existingKey, existing := range l.entries {
			if now.Before(existing.startedAt) || !now.Before(existing.startedAt.Add(l.window)) {
				delete(l.entries, existingKey)
			}
		}
		if len(l.entries) >= 4096 {
			return false, l.window
		}
	}
	if !exists || now.Before(entry.startedAt) || !now.Before(entry.startedAt.Add(l.window)) {
		l.entries[key] = windowRateEntry{startedAt: now, count: 1}
		l.prune(now)
		return true, 0
	}
	if entry.count >= l.limit {
		return false, entry.startedAt.Add(l.window).Sub(now)
	}
	entry.count++
	l.entries[key] = entry
	l.prune(now)
	return true, 0
}

func (l *windowRateLimiter) prune(now time.Time) {
	if l.requests%256 != 0 {
		return
	}
	for key, entry := range l.entries {
		if now.Sub(entry.startedAt) >= l.window || now.Before(entry.startedAt) {
			delete(l.entries, key)
		}
	}
}

type concurrentLimiter struct {
	mu     sync.Mutex
	limit  int
	active map[string]int
}

func newConcurrentLimiter(limit int) *concurrentLimiter {
	return &concurrentLimiter{limit: limit, active: make(map[string]int)}
}

func (l *concurrentLimiter) acquire(key string) (func(), bool) {
	l.mu.Lock()
	if l.active[key] >= l.limit {
		l.mu.Unlock()
		return nil, false
	}
	l.active[key]++
	l.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.active[key]--
			if l.active[key] == 0 {
				delete(l.active, key)
			}
			l.mu.Unlock()
		})
	}, true
}
