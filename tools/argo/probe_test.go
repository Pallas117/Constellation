package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The real HTTP probe against local servers: each way a request can fail must land in the
// class the classifier relies on, and certificate checks must stay on.

func deadAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a := l.Addr().String()
	_ = l.Close()
	return a
}

func TestProbeRefusesAnUntrustedCertificate(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	r, _ := httpGet(context.Background(), srv.URL)
	if r.OK || r.Err != ErrTLSUntrusted {
		t.Fatalf("self-signed server = %+v: TLS verification must stay on", r)
	}
}

func TestProbeErrorKinds(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()

	if r, _ := httpGet(context.Background(), "http://"+deadAddr(t)); r.Err != ErrRefused {
		t.Errorf("closed port = %+v, want %s", r, ErrRefused)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if r, _ := httpGet(ctx, slow.URL); r.Err != ErrTimeout {
		t.Errorf("stalled server = %+v, want %s", r, ErrTimeout)
	}
	// .invalid never resolves (RFC 6761); with no resolver reachable at all the lookup can
	// time out instead, which proves nothing here.
	switch r, _ := httpGet(context.Background(), "http://argo-no-such-host.invalid"); r.Err {
	case ErrDNS:
	case ErrTimeout:
		t.Log("no resolver reachable: DNS case not checked")
	default:
		t.Errorf("unknown host = %+v, want %s", r, ErrDNS)
	}
}

func TestProbeDoesNotFollowRedirectsOrProxies(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://"+deadAddr(t))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://portal.example/login", http.StatusFound)
	}))
	defer srv.Close()
	r, _ := httpGet(context.Background(), srv.URL)
	if !r.OK || r.Status != http.StatusFound {
		t.Fatalf("redirect = %+v: a portal's redirect is evidence, not something to follow", r)
	}
	if r.ConnectMs < 1 {
		t.Fatalf("connect time not measured: %+v", r)
	}
}

func TestProbeReadsAtMost64KB(t *testing.T) {
	big := make([]byte, 1<<20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(big) }))
	defer srv.Close()
	if _, body := httpGet(context.Background(), srv.URL); len(body) != 64<<10 {
		t.Fatalf("read %d bytes", len(body))
	}
}
