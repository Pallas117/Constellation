package main

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// Fixes from the phone (2026-11-01, Josh: texts "need more utility to decide to fix things").
// Texts and Slack only send; the phone reaches this Mac over SSH (Termius, gauss-phone). So a
// text names the step and `gauss-phone fix` shows `argo fix --list` and runs `argo fix <step>`.
// Only steps that need no sudo and can be undone run this way, each with its fixed command;
// everything else stays advice. No ports, tokens or third-party services are involved.

// phoneSteps are the plan steps `argo fix <step>` may run.
var phoneSteps = map[string]bool{
	"open-portal":    true, // opens the Wi-Fi login page on the Mac's screen
	"check-magicdns": true, // tailscale set --accept-dns=false (undo: --accept-dns=true)
	"restart-daemon": true, // claude daemon stop --any (it restarts on the next session)
	"exit-node":      true, // only nodes on the exit-node allowlist reach the plan
}

// runnable is true when a plan step may run from the phone.
func runnable(a Action) bool {
	return phoneSteps[a.ID] && !a.Admin && a.Command != "" && !strings.ContainsAny(a.Command, ";|&`$<>\\\n")
}

// fixList prints the current problem's plan, numbered, marking what can run from the phone.
func fixList(out io.Writer, class Class, reason string, plan []Action) {
	fmt.Fprintf(out, "%s  %s\n", class, reason)
	if !class.Blocking() && len(plan) == 0 {
		fmt.Fprintln(out, "Nothing to fix.")
		return
	}
	for i, a := range plan {
		tag := "advice"
		if runnable(a) {
			tag = "run: argo fix " + a.ID
		} else if a.Admin {
			tag = "needs sudo at the Mac"
		}
		fmt.Fprintf(out, "%d. %s\n   [%s]\n", i+1, a.Say, tag)
	}
}

// fixStep runs one plan step by ID, if the current plan has it and it is phone-runnable.
func fixStep(ctx context.Context, out io.Writer, plan []Action, id string, run func(name string, args ...string) error) error {
	for _, a := range plan {
		if a.ID != id {
			continue
		}
		if !runnable(a) {
			return fmt.Errorf("%s can't run from the phone (needs sudo, or is advice only)", id)
		}
		f := strings.Fields(a.Command)
		if f[0] == "open" { // the login page opens on the Mac's own screen
			if err := openURL(strings.Join(f[1:], " ")); err != nil {
				return err
			}
		} else if err := run(f[0], f[1:]...); err != nil {
			return fmt.Errorf("%s failed: %v", id, err)
		}
		fmt.Fprintf(out, "ran %s: %s\n", id, a.Command)
		return nil
	}
	return fmt.Errorf("%s is not a step for the current problem; see argo fix --list", id)
}

// planNow probes once and returns the class, reason and plan, as a tick would see them.
func planNow(ctx context.Context, l Loop) (Class, string, []Action) {
	snap := l.Prober.Probe(ctx)
	class, reason := Classify(snap)
	st := l.Store.Load()
	return class, reason, Plan(class, snap, st.Networks[netFingerprint(snap)].Fixes[class])
}

// fixHint is added to incident texts when the phone can act on them.
func fixHint(plan []Action) string {
	for _, a := range plan {
		if runnable(a) {
			return "\nFix from Termius: gauss-phone fix"
		}
	}
	return ""
}
