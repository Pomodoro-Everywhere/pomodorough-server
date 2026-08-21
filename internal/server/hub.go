package server

import "sync"

type revisionHub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[string]map[uint64]chan int64
	latest      map[string]int64
}

func newRevisionHub() *revisionHub {
	return &revisionHub{subscribers: make(map[string]map[uint64]chan int64), latest: make(map[string]int64)}
}

func (h *revisionHub) subscribe(userID string) (<-chan int64, func()) {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	channel := make(chan int64, 1)
	if h.subscribers[userID] == nil {
		h.subscribers[userID] = make(map[uint64]chan int64)
	}
	h.subscribers[userID][id] = channel
	h.mu.Unlock()
	return channel, func() {
		h.mu.Lock()
		delete(h.subscribers[userID], id)
		if len(h.subscribers[userID]) == 0 {
			delete(h.subscribers, userID)
		}
		h.mu.Unlock()
	}
}

func (h *revisionHub) publish(userID string, revision int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if revision <= h.latest[userID] {
		return
	}
	h.latest[userID] = revision
	for _, channel := range h.subscribers[userID] {
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

func (h *revisionHub) disconnect(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, channel := range h.subscribers[userID] {
		close(channel)
	}
	delete(h.subscribers, userID)
	delete(h.latest, userID)
}
