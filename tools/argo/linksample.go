package main

// Shared signal map (REQ-ARG-050..051). Each device already measures its own
// link; this adds a small allowlisted block to the mesh report so /mesh can
// show, per network, where signal is good. Privacy: no GPS and no locations;
// the network is the same 12-hex fingerprint hash Argo already reports (never
// an SSID, and never other people's networks); the place is a short label the
// owner chose in config ("place"), nothing derived.

import "strings"

// placeLabel keeps a user-set place label to a short safe form.
func placeLabel(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == ' ', r == '-', r == '_':
			b.WriteRune(r)
		}
		if b.Len() >= 24 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

// linkSample is the block sent as "linkSample". bearer is the path the probe
// used to reach the hub: always "https" today (radio bearers carry bundles, not reports).
func linkSample(cfg Config, st State) map[string]any {
	class := st.Via
	if class == "" {
		class = "other"
	}
	s := map[string]any{
		"class": class, "bearer": "https", "lossPct": int(recentLoss(st.Low)*100 + 0.5),
		"rttMs": st.Net.RTTMs, "low": st.Low.On,
	}
	if st.Fingerprint != "" {
		s["network"] = st.Fingerprint
	}
	if p := placeLabel(cfg.Place); p != "" {
		s["place"] = p
	}
	if st.Net.Signal != "n/a" && st.Net.Signal != notMeasured && st.Net.RSSI != 0 {
		s["signalDbm"], s["noiseDbm"] = st.Net.RSSI, st.Net.Noise
	}
	return s
}

// addLowAndLink adds the low-signal, clock and link-sample fields to a report.
func addLowAndLink(report map[string]any, cfg Config, st State) {
	report["lowSignal"] = map[string]any{"on": st.Low.On, "chunkBytes": st.Low.ChunkBytes()}
	if st.Clock.Checked {
		report["clock"] = map[string]any{"fault": st.Clock.Fault, "skewSecs": st.Clock.SkewSecs, "sources": st.Clock.Sources}
	}
	if st.Class != Offline {
		report["linkSample"] = linkSample(cfg, st)
	}
}
