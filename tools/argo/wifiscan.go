package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Networks in range (GAU-234). ArgoWiFi.app (wifihelper/) scans with CoreWLAN under Location
// Services; Argo ranks what it finds against this Mac's saved networks and Josh's public allowlist,
// and when the Mac is offline joins the best one before falling back to a Wi-Fi restart (#202).
// Network names never leave the Mac: they are not in state.json, reports or texts.

// NearNet is one network from the helper's scan.
type NearNet struct {
	SSID     string `json:"ssid"`
	RSSI     int    `json:"rssi"`
	Channel  int    `json:"channel"`
	Band     string `json:"band"`
	Security string `json:"security"`
}

// Candidate is a network Argo may join, with why.
type Candidate struct {
	NearNet
	Saved  bool
	Public bool
	Score  int
}

const (
	minJoinRSSI = -80              // weaker than this drops again soon
	scanTimeout = 70 * time.Second // the helper waits up to a minute for the one-time Location prompt
)

func helperApp() string {
	for _, p := range []string{filepath.Join(os.Getenv("HOME"), "Applications", "ArgoWiFi.app"), "/Applications/ArgoWiFi.app"} {
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
	}
	return ""
}

// scanNearby runs the helper once; nil when it isn't installed or Location access is off.
func scanNearby(ctx context.Context) []NearNet {
	app := helperApp()
	if app == "" {
		return nil
	}
	f, err := os.CreateTemp("", "argo-scan-*.json")
	if err != nil {
		return nil
	}
	out := f.Name()
	f.Close()
	defer os.Remove(out)
	ctx, cancel := context.WithTimeout(ctx, scanTimeout)
	defer cancel()
	_ = exec.CommandContext(ctx, "open", "-W", "-g", "-a", app, "--args", "scan", "--out", out).Run()
	b, err := os.ReadFile(out)
	if err != nil {
		return nil
	}
	var nets []NearNet
	if json.Unmarshal(b, &nets) != nil {
		return nil
	}
	return nets
}

// parsePreferred reads `networksetup -listpreferredwirelessnetworks <dev>`: one tab-indented name per line.
func parsePreferred(out string) map[string]bool {
	saved := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "\t") {
			if name := strings.TrimSpace(line); name != "" {
				saved[name] = true
			}
		}
	}
	return saved
}

// publicAllowlist reads ~/.config/argo/public-wifi.txt: one network name per line, # comments.
func publicAllowlist() map[string]bool {
	pub := map[string]bool{}
	b, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".config", "argo", "public-wifi.txt"))
	if err != nil {
		return pub
	}
	for _, line := range strings.Split(string(b), "\n") {
		if l := strings.TrimSpace(line); l != "" && !strings.HasPrefix(l, "#") {
			pub[l] = true
		}
	}
	return pub
}

// rankCandidates keeps saved and allowlisted networks with a usable signal, best first. An open
// or WEP network qualifies only when allowlisted (the Wi-Fi shield then turns WARP on).
func rankCandidates(nets []NearNet, saved, public map[string]bool) []Candidate {
	best := map[string]Candidate{}
	for _, n := range nets {
		if n.SSID == "" || n.RSSI < minJoinRSSI {
			continue
		}
		c := Candidate{NearNet: n, Saved: saved[n.SSID], Public: public[n.SSID]}
		weak := weakWiFi(n.Security) || n.Security == "WEP"
		if !(c.Saved || c.Public) || (weak && !c.Public) {
			continue
		}
		c.Score = n.RSSI
		if strings.HasPrefix(n.Security, "WPA3") || strings.Contains(n.Security, "/WPA3") {
			c.Score += 3
		}
		if n.Band == "5" || n.Band == "6" {
			c.Score += 2 // less crowded, when the signal is otherwise close
		}
		if old, ok := best[n.SSID]; !ok || c.Score > old.Score {
			best[n.SSID] = c // several access points of one network: keep the strongest
		}
	}
	out := make([]Candidate, 0, len(best))
	for _, c := range best {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].SSID < out[j].SSID
	})
	return out
}

// joinCandidates is what the offline probe calls: scan, then rank against saved and allowlisted networks.
func joinCandidates(ctx context.Context, dev string) []Candidate {
	nets := scanNearby(ctx)
	if len(nets) == 0 {
		return nil
	}
	return rankCandidates(nets, parsePreferred(run(ctx, "networksetup", "-listpreferredwirelessnetworks", dev)), publicAllowlist())
}

// printNetworks is `argo networks`: what is in range and what Argo would join.
func printNetworks(ctx context.Context, w io.Writer) error {
	dev := parseWiFiDevice(run(ctx, "networksetup", "-listallhardwareports"))
	if dev == "" {
		return fmt.Errorf("no Wi-Fi interface")
	}
	if helperApp() == "" {
		return fmt.Errorf("ArgoWiFi.app is not installed: bash tools/argo/wifihelper/build.sh")
	}
	nets := scanNearby(ctx)
	if len(nets) == 0 {
		return fmt.Errorf("no networks from the helper (Location Services off for ArgoWiFi?)")
	}
	saved := parsePreferred(run(ctx, "networksetup", "-listpreferredwirelessnetworks", dev))
	cands := rankCandidates(nets, saved, publicAllowlist())
	fmt.Fprintf(w, "%d networks in range; %d Argo would join (saved or allowlisted, signal ≥ %d dBm), best first:\n", len(nets), len(cands), minJoinRSSI)
	for i, c := range cands {
		why := "saved"
		if c.Public {
			why = "public allowlist (WARP on)"
		}
		fmt.Fprintf(w, "%2d. %-32s %4d dBm  %-4s GHz ch %-3d %-10s %s\n", i+1, c.SSID, c.RSSI, c.Band, c.Channel, c.Security, why)
	}
	return nil
}
