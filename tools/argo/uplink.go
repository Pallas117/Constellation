package main

import (
	"context"
	"net"
	"time"
)

// Dead uplink vs DNS (GAU-247). On 2026-11-18 the dorm Wi-Fi stayed associated with a working
// gateway for 9.6 h while nothing beyond it answered. The system lookup and the 1.1.1.1:53 lookup
// both timed out, so Argo called it DNS and suggested flushing the resolver cache 22 times, while
// mesh-heal's IP-literal check (https://1.1.1.1) failed in 306 of 307 runs over the same hours.
// A DNS failure only means DNS when IP traffic still flows, so when both lookups fail Argo now
// dials a few anycast addresses by IP. None answering is a stalled uplink: the network, not DNS.

// ipAnchors are independent anycast resolvers, dialled by address on 443 so neither DNS nor a
// port-53 filter is involved. Any one answering proves IP traffic gets out.
var ipAnchors = []string{"1.1.1.1:443", "9.9.9.9:443", "8.8.8.8:443"}

const anchorTimeout = 2 * time.Second

// dialFunc opens a TCP connection; tests replace it.
type dialFunc func(ctx context.Context, addr string) (net.Conn, error)

func tcpDial(ctx context.Context, addr string) (net.Conn, error) {
	d := net.Dialer{Timeout: anchorTimeout}
	return d.DialContext(ctx, "tcp", addr)
}

// ipReachable dials every anchor at once and reports whether any accepted (at most anchorTimeout).
func ipReachable(ctx context.Context, dial dialFunc) bool {
	ctx, cancel := context.WithTimeout(ctx, anchorTimeout+500*time.Millisecond)
	defer cancel()
	res := make(chan bool, len(ipAnchors))
	for _, a := range ipAnchors {
		go func() {
			c, err := dial(ctx, a)
			if err == nil {
				c.Close()
			}
			res <- err == nil
		}()
	}
	up := false
	for range ipAnchors {
		if <-res {
			up = true
			cancel() // the others can stop
		}
	}
	return up
}

// uplinkDead: the IP anchors were dialled and none answered. nil (not measured: older
// fixtures, or DNS was fine) is never dead.
func uplinkDead(s Snapshot) bool { return s.IPUp != nil && !*s.IPUp }

func boolPtr(b bool) *bool { return &b }
