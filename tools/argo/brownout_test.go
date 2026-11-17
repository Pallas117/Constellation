package main

import (
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestBrownoutHysteresis(t *testing.T) {
	plugged := func(pct int, charging bool, w float64) Sample {
		s := calm()
		s.Batt = &Battery{Present: true, Pct: pct, OnAC: true, Charging: charging, AdapterW: w}
		return s
	}
	behind := Assessment{ChargerBehind: true}
	for _, tc := range []struct {
		name     string
		s        Sample
		a        Assessment
		shedding bool
		want     bool
	}{
		{"weak charger, 60%", plugged(60, false, 8), behind, false, false},
		{"weak charger, 35%: shed", plugged(35, false, 8), behind, false, true},
		{"charging at 35% on a good charger", plugged(35, true, 45), Assessment{}, false, false},
		{"shed, recovered to 45%: still shed", plugged(45, true, 8), Assessment{}, true, true},
		{"shed, back to 50%: restore", plugged(50, true, 8), Assessment{}, true, false},
		{"shed, a 45 W charger arrives: restore", plugged(36, true, 45), Assessment{}, true, false},
		{"on battery: eclipse decides", Sample{Batt: &Battery{Present: true, Pct: 20}}, behind, false, false},
		{"desktop", calm(), Assessment{}, false, false},
	} {
		if got := brownout(tc.s, tc.a, tc.shedding); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestBrownoutShedsAndRestoresARunningJob: on a weak charger a job pauses at 35% and resumes
// once the battery is back at 50%.
func TestBrownoutShedsAndRestoresARunningJob(t *testing.T) {
	var pct atomic.Int32
	pct.Store(60)
	r := fakeRunner(t, assess(nil, calm()))
	r.maxPause = time.Minute
	r.assess = func() (Sample, Assessment) {
		s := calm()
		p := int(pct.Load())
		s.Batt = &Battery{Present: true, Pct: p, OnAC: true, Charging: p >= 36, AdapterW: 8}
		return s, Assessment{ChargerBehind: p < 36}
	}
	out := filepath.Join(t.TempDir(), "ticks")
	script := `i=0; while [ $i -lt 60 ]; do echo $i >> "$0"; i=$((i+1)); sleep 0.01; done`
	done := make(chan int, 1)
	go func() {
		code, _ := r.run(0, 0, 0, []string{"sh", "-c", script, out})
		done <- code
	}()
	time.Sleep(100 * time.Millisecond)
	pct.Store(35)
	time.Sleep(150 * time.Millisecond)
	before := lines(t, out)
	pct.Store(45) // charging while shed, not yet restored
	time.Sleep(300 * time.Millisecond)
	if got := lines(t, out); got != before || before >= 60 {
		t.Fatalf("job ran during brownout: %d -> %d lines", before, got)
	}
	pct.Store(50)
	select {
	case code := <-done:
		if code != 0 || lines(t, out) != 60 {
			t.Fatalf("exit %d, %d lines", code, lines(t, out))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job never resumed at 50%")
	}
}
