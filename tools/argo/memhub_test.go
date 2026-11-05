package main

import (
	"context"
	"errors"
	"sort"
	"time"
)

// memHubServer is an in-memory stand-in for the Gauss hub with the same
// rules as backend/mesh/bundles.ts: the uploader must be the bundle's source,
// the destination must be enrolled, duplicates are idempotent, and a picked-up
// bundle leaves a tombstone so its sender can see it was taken.
type memHubServer struct {
	now      func() time.Time
	enrolled map[string]bool
	queues   map[string]map[string]memEntry // dest → key → entry
	taken    map[string]time.Time           // key → expiry (tombstones)
	keys     map[string]PeerKey
	down     bool
	puts     int
}

type memEntry struct {
	raw     []byte
	from    string
	expires time.Time
}

func newMemHub(now func() time.Time, devices ...string) *memHubServer {
	s := &memHubServer{now: now, enrolled: map[string]bool{}, queues: map[string]map[string]memEntry{}, taken: map[string]time.Time{}, keys: map[string]PeerKey{}}
	for _, d := range devices {
		s.enrolled[d] = true
	}
	return s
}

// wipe loses every stored bundle and tombstone, like a hub restored from an old backup.
func (s *memHubServer) wipe() {
	s.queues = map[string]map[string]memEntry{}
	s.taken = map[string]time.Time{}
}

func (s *memHubServer) client(device string) *memHub { return &memHub{s: s, device: device} }

type memHub struct {
	s      *memHubServer
	device string
}

var errHubDown = errors.New("hub unreachable")

func (h *memHub) Put(_ context.Context, raw []byte) error {
	if h.s.down {
		return errHubDown
	}
	b, err := ParseBundle(raw)
	if err != nil || b.Source.NodeName() != h.device || !h.s.enrolled[b.Dest.NodeName()] {
		return errHubRefused
	}
	key := b.Key()
	if _, ok := h.s.taken[key]; ok {
		return nil
	}
	q := h.s.queues[b.Dest.NodeName()]
	if q == nil {
		q = map[string]memEntry{}
		h.s.queues[b.Dest.NodeName()] = q
	}
	h.s.puts++
	q[key] = memEntry{raw: append([]byte(nil), raw...), from: h.device, expires: b.Expires()}
	return nil
}

func (h *memHub) List(context.Context) ([]hubItem, error) {
	if h.s.down {
		return nil, errHubDown
	}
	var out []hubItem
	for k, e := range h.s.queues[h.device] {
		if h.s.now().After(e.expires) {
			delete(h.s.queues[h.device], k)
			continue
		}
		out = append(out, hubItem{Key: k, From: e.from, Size: len(e.raw)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (h *memHub) Get(_ context.Context, key string) ([]byte, error) {
	if h.s.down {
		return nil, errHubDown
	}
	e, ok := h.s.queues[h.device][key]
	if !ok {
		return nil, errors.New("not found")
	}
	return e.raw, nil
}

func (h *memHub) Ack(_ context.Context, key string) error {
	if h.s.down {
		return errHubDown
	}
	if e, ok := h.s.queues[h.device][key]; ok {
		h.s.taken[key] = e.expires
		delete(h.s.queues[h.device], key)
	}
	return nil
}

func (h *memHub) Status(_ context.Context, keys []string) (map[string]string, error) {
	if h.s.down {
		return nil, errHubDown
	}
	out := map[string]string{}
	for _, k := range keys {
		out[k] = "unknown"
		if _, ok := h.s.taken[k]; ok {
			out[k] = "picked-up"
		}
		for _, q := range h.s.queues {
			if e, ok := q[k]; ok && e.from == h.device {
				out[k] = "queued"
			}
		}
	}
	return out, nil
}

func (h *memHub) Directory(context.Context) ([]PeerKey, error) {
	if h.s.down {
		return nil, errHubDown
	}
	var out []PeerKey
	for _, k := range h.s.keys {
		out = append(out, k)
	}
	return out, nil
}

func (h *memHub) Publish(_ context.Context, k PeerKey) error {
	if h.s.down {
		return errHubDown
	}
	if k.Node != h.device {
		return errHubRefused
	}
	if old, ok := h.s.keys[k.Node]; ok && old.Fingerprint() != k.Fingerprint() {
		return errHubConflict
	}
	h.s.keys[k.Node] = k
	return nil
}
