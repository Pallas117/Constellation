package main

import (
	"context"
	"os"
	"path/filepath"
)

// radioSync is the radio half of a sync: take in what the bearers delivered,
// hand small unsent bundles to the scheduler, send what the duty budget allows.
// It runs before the hub steps and does not need the hub: that is the point.
// Receipts and key offers go out as soon as they are queued; file chunks never do.
func (r *Relay) radioSync(ctx context.Context, st *relayState, rep *SyncReport) {
	if r.Radio == nil {
		return
	}
	path := filepath.Join(r.Dir, "radio.json")
	r.Radio.Now = r.now
	r.Radio.Rand = r.Rand
	r.Radio.Load(path)
	for _, raw := range r.Radio.Poll(ctx) {
		b, err := ParseBundle(raw)
		if err != nil || b.Dest.Node() != r.me() {
			continue // someone else's, or damaged: the mesh carries it on without us
		}
		switch res, err := r.accept(ctx, st, raw); res {
		case acceptFile, acceptChunk:
			rep.Received++
		case acceptReceipt:
			rep.Delivered++
		case acceptRejected:
			rep.Rejected++
			rep.Errors = append(rep.Errors, "radio: "+Mask(err.Error()))
		}
	}
	now := r.now()
	for _, it := range pending(st, stateQueued) {
		if it.priority() > 1 || (!it.RadioAt.IsZero() && now.Sub(it.RadioAt) < radioResend) {
			continue
		}
		raw, err := os.ReadFile(r.outPath(it.Key))
		if err != nil {
			continue
		}
		prio := RadioStatus
		if it.Receipt {
			prio = RadioAlert
		}
		if err := r.Radio.Submit(it.Key, prio, raw, it.Expires); err == nil || err == errTooBig || err == errNotProtect {
			it.RadioAt = now // sent, or never can be: don't ask again before the resend time
		}
	}
	r.Radio.Pump(ctx)
	if err := r.Radio.Save(path); err != nil {
		rep.Errors = append(rep.Errors, "radio state: "+Mask(err.Error()))
	}
}
