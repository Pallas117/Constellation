package main

// Time integrity (REQ-ARG-049). TLS certificate validity and BPSec bundle
// lifetimes both depend on this machine's clock, and a spoofed or drifting
// clock breaks both quietly. Argo cross-checks the system clock against
// several independent HTTPS Date headers (RFC 9110 section 6.6.1, one-second
// resolution) and the hub's own Date. A disagreement is a fault ("time source
// disagreement") shown in `argo status` and the mesh report. Argo never sets
// the clock: that is an admin action.
//
// What this is not: a time server. The Date header has 1 s resolution and the
// request takes a round trip, so the limit is two minutes, far larger than the
// measurement error and far smaller than anything that breaks TLS.

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

const (
	clockLimit      = 2 * time.Minute
	clockMinSources = 3
	clockEvery      = 30 * time.Minute
)

// clockHosts are independent operators; nothing is sent but a HEAD request.
var clockHosts = []string{"https://www.cloudflare.com/", "https://www.google.com/", "https://www.apple.com/", "https://github.com/"}

// ClockSample is one source's idea of the time relative to this machine's
// clock: positive when the source is ahead.
type ClockSample struct {
	Source string        `json:"source"`
	Skew   time.Duration `json:"skew"`
}

// ClockVerdict is what status and the report show.
type ClockVerdict struct {
	Checked  bool      `json:"checked"`
	Fault    bool      `json:"fault,omitempty"`
	SkewSecs int       `json:"skew_secs,omitempty"` // median skew of the sources, signed
	Sources  int       `json:"sources,omitempty"`
	Agree    int       `json:"agree,omitempty"` // sources within the limit of this clock
	At       time.Time `json:"at,omitempty"`
}

// judgeClock decides from the samples. Fewer than three sources is "not
// enough to tell", never a fault. A fault needs most sources to disagree with
// this clock; one odd source alone (a spoofed path or a broken server) is not.
func judgeClock(samples []ClockSample, now time.Time) ClockVerdict {
	v := ClockVerdict{At: now, Sources: len(samples)}
	if len(samples) < clockMinSources {
		return v
	}
	v.Checked = true
	skews := make([]time.Duration, 0, len(samples))
	for _, s := range samples {
		skews = append(skews, s.Skew)
		if s.Skew > -clockLimit && s.Skew < clockLimit {
			v.Agree++
		}
	}
	sort.Slice(skews, func(i, j int) bool { return skews[i] < skews[j] })
	v.SkewSecs = int(skews[len(skews)/2] / time.Second)
	v.Fault = v.Agree*2 <= len(samples)
	return v
}

func (v ClockVerdict) String() string {
	if !v.Fault {
		return ""
	}
	return fmt.Sprintf("time source disagreement: this clock differs from %d of %d sources (median %+d s). Argo does not change the clock; check Date & Time settings and the network", v.Sources-v.Agree, v.Sources, v.SkewSecs)
}

// clockSample asks one host for its Date header. TLS is verified as usual
// and redirects are not followed.
func clockSample(ctx context.Context, c *http.Client, url string) (ClockSample, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return ClockSample{}, false
	}
	t0 := time.Now()
	resp, err := c.Do(req)
	t1 := time.Now()
	if err != nil {
		return ClockSample{}, false
	}
	resp.Body.Close()
	d, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return ClockSample{}, false
	}
	mid := t0.Add(t1.Sub(t0) / 2)
	return ClockSample{Source: req.URL.Hostname(), Skew: d.Sub(mid)}, true
}

// checkClock queries the hosts (and the hub, when given) in parallel.
func checkClock(ctx context.Context, urls []string, now time.Time) ([]ClockSample, ClockVerdict) {
	c := &http.Client{Timeout: 6 * time.Second, Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var mu sync.Mutex
	var wg sync.WaitGroup
	var got []ClockSample
	for _, u := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, ok := clockSample(ctx, c, u); ok {
				mu.Lock()
				got = append(got, s)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	sort.Slice(got, func(i, j int) bool { return got[i].Source < got[j].Source })
	return got, judgeClock(got, now)
}

// clockTick re-checks the clock at most every clockEvery (four times less
// often in low-signal mode) and keeps the verdict in the state file, so
// `argo status` and the mesh report show it. It reads and writes state under
// the Argo lock and never touches the clock.
func clockTick(ctx context.Context, cfg Config, store Store, now time.Time) {
	st := store.Load()
	every := clockEvery
	if st.Low.On {
		every *= 4
	}
	if st.CheckedAt.IsZero() || st.Class == Offline || now.Sub(st.Clock.At) < every {
		return
	}
	urls := append([]string(nil), clockHosts...)
	if cfg.GaussURL != "" {
		urls = append(urls, cfg.GaussURL) // the hub's own time
	}
	_, v := checkClock(ctx, urls, now)
	_ = withLock(store, func() {
		cur := store.Load()
		cur.Clock = v
		_ = store.Save(cur)
	})
	countOwnEgress(store.Dir, "clock check", "time sources", 400*len(urls), now)
}
