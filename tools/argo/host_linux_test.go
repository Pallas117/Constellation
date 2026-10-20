//go:build linux

package main

import "testing"

// Recorded from a Linux host on a home router (gateway 192.168.1.1 = 0101A8C0).
const procRoute = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	0001A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
eth0	00000000	0101A8C0	0003	0	0	100	00000000	0	0	0
`

const procARP = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.50     0x1         0x0         00:00:00:00:00:00     *        eth0
192.168.1.1      0x1         0x2         BC:62:CE:11:22:33     *        eth0
`

func TestLinuxDefaultRouteAndARP(t *testing.T) {
	iface, gw, ok := linuxDefaultRoute(procRoute)
	if !ok || iface != "eth0" || gw != "192.168.1.1" {
		t.Fatalf("route: %q %q %v", iface, gw, ok)
	}
	if mac := linuxARP(procARP, gw); mac != "bc:62:ce:11:22:33" {
		t.Fatalf("arp: %q", mac)
	}
	if mac := linuxARP(procARP, "192.168.1.50"); mac != "" {
		t.Fatalf("incomplete entry gave %q", mac)
	}
	if _, _, ok := linuxDefaultRoute("Iface\tDestination\neth0\t0001A8C0\t00000000\n"); ok {
		t.Fatal("no default route should be offline")
	}
}

func TestLinuxHasNoPhoneOrDesktop(t *testing.T) {
	if newPhoneFor(Config{PhoneTo: "+60123456789"}) != nil {
		t.Fatal("phone alerts must be off on Linux")
	}
	if openURL("http://captive.apple.com") == nil {
		t.Fatal("openURL should report unsupported")
	}
}
