package server

import "sync"

type revisionHub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[revisionScope]map[uint64]revisionSubscription
	latest      map[revisionScope]int64
}

type revisionScope struct {
	userID     string
	generation int64
}

type revisionSubscription struct {
	channel   chan int64
	sessionID string
	deviceID  string
}

func newRevisionHub() *revisionHub {
	return &revisionHub{
		subscribers: make(map[revisionScope]map[uint64]revisionSubscription),
		latest:      make(map[revisionScope]int64),
	}
}

func (h *revisionHub) subscribe(userID string, generation int64, credentials ...string) (<-chan int64, func()) {
	var sessionID, deviceID string
	if len(credentials) > 0 {
		sessionID = credentials[0]
	}
	if len(credentials) > 1 {
		deviceID = credentials[1]
	}
	scope := revisionScope{userID: userID, generation: generation}
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	channel := make(chan int64, 1)
	if h.subscribers[scope] == nil {
		h.subscribers[scope] = make(map[uint64]revisionSubscription)
	}
	h.subscribers[scope][id] = revisionSubscription{channel: channel, sessionID: sessionID, deviceID: deviceID}
	h.mu.Unlock()
	return channel, func() {
		h.mu.Lock()
		delete(h.subscribers[scope], id)
		if len(h.subscribers[scope]) == 0 {
			delete(h.subscribers, scope)
		}
		h.mu.Unlock()
	}
}

func (h *revisionHub) publish(userID string, generation, revision int64) {
	scope := revisionScope{userID: userID, generation: generation}
	h.mu.Lock()
	defer h.mu.Unlock()
	if revision <= h.latest[scope] {
		return
	}
	h.latest[scope] = revision
	for _, subscription := range h.subscribers[scope] {
		channel := subscription.channel
		select {
		case channel <- revision:
		default:
			select {
			case <-channel:
			default:
			}
			select {
			case channel <- revision:
			default:
			}
		}
	}
}

func (h *revisionHub) disconnect(userID string, generation int64) {
	scope := revisionScope{userID: userID, generation: generation}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, subscription := range h.subscribers[scope] {
		close(subscription.channel)
	}
	delete(h.subscribers, scope)
	delete(h.latest, scope)
}

func (h *revisionHub) disconnectSession(userID string, generation int64, sessionID string) {
	h.disconnectMatching(userID, generation, func(subscription revisionSubscription) bool {
		return subscription.sessionID == sessionID
	})
}

func (h *revisionHub) disconnectDevice(userID string, generation int64, deviceID string) {
	h.disconnectMatching(userID, generation, func(subscription revisionSubscription) bool {
		return subscription.deviceID == deviceID
	})
}

func (h *revisionHub) disconnectMatching(userID string, generation int64, matches func(revisionSubscription) bool) {
	scope := revisionScope{userID: userID, generation: generation}
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, subscription := range h.subscribers[scope] {
		if !matches(subscription) {
			continue
		}
		close(subscription.channel)
		delete(h.subscribers[scope], id)
	}
	if len(h.subscribers[scope]) == 0 {
		delete(h.subscribers, scope)
	}
}
