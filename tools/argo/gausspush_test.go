package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeGauss answers /api/mesh/report with the given status and counts calls.
func fakeGauss(t *testing.T, status *atomic.Int32) (Config, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/mesh/report" || r.Header.Get("Authorization") != "Bearer argo_test" {
			t.Errorf("unexpected request %s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		calls.Add(1)
		w.WriteHeader(int(status.Load()))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir(), "token"), []byte("argo_test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Config{GaussURL: srv.URL, Device: "judith"}, &calls
}

func TestRefusedTokenPausesReports(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusUnauthorized)
	cfg, calls := fakeGauss(t, &status)
	s := Store{Dir: t.TempDir()}
	st := State{Class: "OK", CheckedAt: t0}

	pushAt(cfg, st, s, t0)
	for m := 1; m < 60; m++ { // a tick a minute for the next hour
		pushAt(cfg, st, s, t0.Add(time.Duration(m)*time.Minute))
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("%d reports in the hour after a 401, want 1", n)
	}
	if gaussStatus(s, t0.Add(time.Minute)) != " gauss:token-refused" {
		t.Error("status line doesn't say the token was refused")
	}

	status.Store(http.StatusOK) // a new token, or the device re-enrolled
	pushAt(cfg, st, s, t0.Add(61*time.Minute))
	if n := calls.Load(); n != 2 {
		t.Fatalf("no retry after the pause: %d calls", n)
	}
	if _, refused := s.loadRefused(); refused || gaussStatus(s, t0.Add(62*time.Minute)) != "" {
		t.Error("an accepted report should clear the refusal")
	}

	status.Store(http.StatusBadRequest) // a class this Gauss doesn't know: not an auth failure, no pause
	pushAt(cfg, st, s, t0.Add(63*time.Minute))
	pushAt(cfg, st, s, t0.Add(64*time.Minute))
	if n := calls.Load(); n != 4 {
		t.Errorf("a 400 paused reporting: %d calls, want 4", n)
	}
}

func TestEnrollOutcome(t *testing.T) {
	cases := []struct {
		code int
		err  error
		want string
	}{
		{200, nil, ""},
		{429, nil, ""}, // a report already landed in the last 10 s
		{401, nil, "refused the token"},
		{403, nil, "refused the token"},
		{400, nil, "different versions"},
		{0, errors.New("dial tcp: connection refused"), "didn't answer"},
	}
	for _, c := range cases {
		err := enrollOutcome(c.code, c.err)
		if (c.want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Errorf("HTTP %d / %v: %v, want %q", c.code, c.err, err, c.want)
		}
	}
}

func TestSendReportCarriesGuardAndBattery(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 1<<16)
		n, _ := r.Body.Read(b)
		got = string(b[:n])
	}))
	defer srv.Close()
	t.Setenv("HOME", t.TempDir())
	_ = os.MkdirAll(configDir(), 0o700)
	_ = os.WriteFile(filepath.Join(configDir(), "token"), []byte("argo_test\n"), 0o600)
	g := GuardState{Report: GuardReport{At: time.Now(), Level: "watch", Admission: "limited", Slots: 1, Reasons: []string{"on-battery"}},
		Batt: &Battery{Present: true, Pct: 64}}
	if err := DefaultStore().saveGuard(g); err != nil {
		t.Fatal(err)
	}
	if code, err := sendReport(Config{GaussURL: srv.URL, Device: "judith"}, State{Class: "OK"}); err != nil || code != 200 {
		t.Fatalf("send: %d %v", code, err)
	}
	for _, want := range []string{`"guard":{`, `"admission":"limited"`, `"battery":{`, `"external":false`, `"level":64`} {
		if !strings.Contains(got, want) {
			t.Errorf("report lacks %s: %s", want, got)
		}
	}
	for _, never := range []string{"cycles", "condition", "adapterW", "guard.jsonl"} {
		if strings.Contains(got, never) {
			t.Errorf("report leaks %s: %s", never, got)
		}
	}
}
