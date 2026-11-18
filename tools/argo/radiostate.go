package main

// The radio's state between runs. Argo runs once a minute as a fresh process,
// and a frame read from a node is gone from the node, so partial bundles, the
// send queue with its progress and the duty-cycle log must survive a restart.
// Bounded: at most maxPartials partials of at most maxFragments frames, a
// queue of radioQueue items, and a spend log pruned to the window.

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"time"
)

type diskItem struct {
	ID      string             `json:"id"`
	Prio    int                `json:"prio"`
	Raw     []byte             `json:"raw"`
	Expires time.Time          `json:"expires"`
	Next    map[string]int     `json:"next,omitempty"`
	Loss    map[string]float64 `json:"loss,omitempty"`
}

type diskAsm struct {
	ID     string         `json:"id"`
	N      int            `json:"n"`
	G      int            `json:"g"`
	Total  int            `json:"total"`
	Data   map[int][]byte `json:"data,omitempty"`
	Parity map[int][]byte `json:"parity,omitempty"`
	At     time.Time      `json:"at"`
}

type radioDisk struct {
	Queue   []diskItem           `json:"queue,omitempty"`
	Partial []diskAsm            `json:"partial,omitempty"`
	Done    map[string]time.Time `json:"done,omitempty"`
	Spend   map[string][]spend   `json:"spend,omitempty"`
	Holds   map[string]time.Time `json:"holds,omitempty"`
	Fails   map[string]int       `json:"fails,omitempty"`
}

// Load reads state saved by Save; a missing or damaged file starts empty.
func (r *Radio) Load(path string) {
	r.init()
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 4<<20 {
		return
	}
	var d radioDisk
	if json.Unmarshal(b, &d) != nil {
		return
	}
	for name, log := range d.Spend {
		r.budgets[name] = &DutyBudget{Window: time.Hour, log: log}
	}
	for k, v := range d.Holds {
		r.holds[k] = v
	}
	for k, v := range d.Fails {
		r.fails[k] = v
	}
	r.queue = nil
	for _, di := range d.Queue {
		if len(r.queue) >= radioQueue {
			break
		}
		it := &radioItem{id: di.ID, prio: di.Prio, raw: di.Raw, expires: di.Expires, per: map[string]*progress{}, loss: di.Loss}
		for _, b := range r.Bearers {
			if next, ok := di.Next[b.Name()]; ok {
				if fr, err := fragment(di.Raw, b.MTU(), di.Loss[b.Name()]); err == nil && next <= len(fr) {
					it.per[b.Name()] = &progress{frames: fr, next: next}
				}
			}
		}
		r.queue = append(r.queue, it)
	}
	r.Reasm.partial, r.Reasm.done = map[[4]byte]*asm{}, map[[4]byte]time.Time{}
	for _, da := range d.Partial {
		var id [4]byte
		if raw, err := hex.DecodeString(da.ID); err != nil || len(raw) != 4 || len(r.Reasm.partial) >= maxPartials {
			continue
		} else {
			copy(id[:], raw)
		}
		a := &asm{n: da.N, g: da.G, total: da.Total, data: da.Data, parity: da.Parity, at: da.At}
		if a.data == nil {
			a.data = map[int][]byte{}
		}
		if a.parity == nil {
			a.parity = map[int][]byte{}
		}
		r.Reasm.partial[id] = a
	}
	for k, t := range d.Done {
		if raw, err := hex.DecodeString(k); err == nil && len(raw) == 4 && len(r.Reasm.done) < maxDone {
			var id [4]byte
			copy(id[:], raw)
			r.Reasm.done[id] = t
		}
	}
}

// Save writes the state atomically with mode 0600.
func (r *Radio) Save(path string) error {
	d := radioDisk{Spend: map[string][]spend{}, Holds: r.holds, Fails: r.fails, Done: map[string]time.Time{}}
	now := r.now()
	for name, b := range r.budgets {
		b.used(now) // prune
		if len(b.log) > 0 {
			d.Spend[name] = b.log
		}
	}
	for _, it := range r.queue {
		di := diskItem{ID: it.id, Prio: it.prio, Raw: it.raw, Expires: it.expires, Next: map[string]int{}, Loss: it.loss}
		for name, p := range it.per {
			di.Next[name] = p.next
		}
		d.Queue = append(d.Queue, di)
	}
	for id, a := range r.Reasm.partial {
		d.Partial = append(d.Partial, diskAsm{ID: hex.EncodeToString(id[:]), N: a.n, G: a.g, Total: a.total, Data: a.data, Parity: a.parity, At: a.at})
	}
	for id, t := range r.Reasm.done {
		d.Done[hex.EncodeToString(id[:])] = t
	}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, b)
}
