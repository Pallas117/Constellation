package main

// Meshtastic (LoRa mesh) bearer, behind a flag (ARGO_MESHTASTIC_URL).
//
// Argo talks to a Meshtastic node through the node's own local HTTP API
// (https://meshtastic.org/docs/development/device/http-api/): PUT
// /api/v1/toradio takes one ToRadio protobuf per request and GET
// /api/v1/fromradio returns one FromRadio per request (empty when none). The
// same protobuf also travels over the node's serial or TCP stream with a
// 4-byte frame header 0x94 0xC3 LEN_HI LEN_LO (client API doc,
// https://meshtastic.org/docs/development/device/client-api/); those helpers
// are here too, for a serial or TCP transport later.
//
// Field numbers are from meshtastic/protobufs mesh.proto (checked 18 Nov
// 2026): ToRadio.packet=1; MeshPacket from=1, to=2, channel=3, decoded=4,
// id=6, hop_limit=9, want_ack=10; Data portnum=1, payload=2;
// FromRadio.id=1, packet=2; Constants.DATA_PAYLOAD_LEN=233. PRIVATE_APP=256
// is from portnums.proto (not re-fetched: UNVERIFIED). The protobuf wire
// format is the public one (varint, length-delimited, fixed32), written by hand
// so the module stays standard-library only. Meshtastic's firmware and
// protobufs are open source (GPL-3.0 firmware; protobuf definitions are
// published at github.com/meshtastic/protobufs, no licence header in
// mesh.proto: UNVERIFIED terms, used only to read field numbers).
//
// What the radio carries: Argo frames (bearer.go) holding BPSec-protected
// bundles. Meshtastic's own channel encryption is a second layer, not the
// one Argo relies on.
//
// Local link only: the node must be on this LAN (a private, loopback or
// link-local address, or a .local name). Plain HTTP to a LAN node is the
// Meshtastic default; TLS verification is never turned off, so an https URL
// to a node with a self-signed certificate simply fails.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	portPrivateApp = 256
	meshMTU        = 200 // below DATA_PAYLOAD_LEN (233): room for the PKI/encryption overhead (UNVERIFIED)
	meshOverhead   = 22  // 16-byte radio header + Data protobuf overhead around our payload
)

// ---- protobuf, just enough ----

func pbVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func pbTag(b []byte, field, wire int) []byte { return pbVarint(b, uint64(field<<3|wire)) }

func pbBytes(b []byte, field int, v []byte) []byte {
	return append(pbVarint(pbTag(b, field, 2), uint64(len(v))), v...)
}

func pbFixed32(b []byte, field int, v uint32) []byte {
	return append(pbTag(b, field, 5), byte(v), byte(v>>8), byte(v>>16), byte(v>>24))
}

// toRadioPacket builds ToRadio{packet: MeshPacket{to, decoded: Data{PRIVATE_APP, payload}}}.
// to 0xffffffff is the broadcast address; hop 3 is Meshtastic's default hop limit.
func toRadioPacket(to, id uint32, payload []byte) []byte {
	data := pbBytes(pbVarint(pbTag(nil, 1, 0), portPrivateApp), 2, payload)
	var pkt []byte
	pkt = pbFixed32(pkt, 2, to)
	pkt = pbBytes(pkt, 4, data)
	pkt = pbFixed32(pkt, 6, id)
	pkt = pbVarint(pbTag(pkt, 9, 0), 3)
	return pbBytes(nil, 1, pkt)
}

type pbReader struct {
	b   []byte
	val uint64 // the value of the last varint field read
}

func (r *pbReader) varint() (uint64, bool) {
	var v uint64
	for i := 0; i < 10 && i < len(r.b); i++ {
		v |= uint64(r.b[i]&0x7f) << (7 * i)
		if r.b[i] < 0x80 {
			r.b = r.b[i+1:]
			return v, true
		}
	}
	return 0, false
}

// field returns the next field number and, for length-delimited fields, its bytes.
func (r *pbReader) field() (num int, data []byte, ok bool) {
	tag, ok := r.varint()
	if !ok {
		return 0, nil, false
	}
	num = int(tag >> 3)
	switch tag & 7 {
	case 0:
		r.val, ok = r.varint()
		return num, nil, ok
	case 1:
		if len(r.b) < 8 {
			return 0, nil, false
		}
		r.b = r.b[8:]
		return num, nil, true
	case 2:
		n, ok := r.varint()
		if !ok || n > uint64(len(r.b)) {
			return 0, nil, false
		}
		data, r.b = r.b[:n], r.b[n:]
		return num, data, true
	case 5:
		if len(r.b) < 4 {
			return 0, nil, false
		}
		r.b = r.b[4:]
		return num, nil, true
	}
	return 0, nil, false
}

// privatePayload pulls the PRIVATE_APP payload out of a FromRadio, if it holds one.
func privatePayload(fromRadio []byte) ([]byte, bool) {
	r := pbReader{b: fromRadio}
	for len(r.b) > 0 {
		num, pkt, ok := r.field()
		if !ok {
			return nil, false
		}
		if num != 2 || pkt == nil { // FromRadio.packet
			continue
		}
		p := pbReader{b: pkt}
		for len(p.b) > 0 {
			n2, data, ok := p.field()
			if !ok {
				return nil, false
			}
			if n2 != 4 || data == nil { // MeshPacket.decoded
				continue
			}
			var port uint64
			var payload []byte
			d := pbReader{b: data}
			for len(d.b) > 0 {
				n3, v, ok := d.field()
				if !ok {
					return nil, false
				}
				switch {
				case n3 == 1 && v == nil: // portnum is a varint
					port = d.val
				case n3 == 2:
					payload = v
				}
			}
			if port == portPrivateApp && len(payload) > 0 {
				return payload, true
			}
		}
	}
	return nil, false
}

// serialFrame wraps one protobuf for a serial or TCP stream (client API).
func serialFrame(pb []byte) ([]byte, error) {
	if len(pb) > 512 {
		return nil, errors.New("meshtastic frame over 512 bytes")
	}
	return append([]byte{0x94, 0xc3, byte(len(pb) >> 8), byte(len(pb))}, pb...), nil
}

// readSerialFrame reads one frame, skipping bytes until the 0x94 0xC3 start.
// A length over 512 is a desync, not data: it resyncs instead of allocating.
func readSerialFrame(r io.Reader) ([]byte, error) {
	var one [1]byte
	for {
		if _, err := io.ReadFull(r, one[:]); err != nil {
			return nil, err
		}
		if one[0] != 0x94 {
			continue
		}
		if _, err := io.ReadFull(r, one[:]); err != nil {
			return nil, err
		}
		if one[0] != 0xc3 {
			continue
		}
		var l [2]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			return nil, err
		}
		n := int(l[0])<<8 | int(l[1])
		if n > 512 {
			continue
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return buf, nil
	}
}

// ---- the bearer ----

// Meshtastic is the LoRa mesh bearer over the node's local HTTP API.
type Meshtastic struct {
	Base *url.URL
	C    *http.Client
	// LoRa settings of the node's modem preset, for airtime. Meshtastic's
	// LONG_FAST default is SF11, 250 kHz, coding rate 4/5, 16-symbol preamble.
	SF, CR, Preamble int
	BW               float64
	// DutyFraction is the time-on-air share Argo allows itself. The default
	// is 1%, the strictest figure in the regional rules, whatever the node's
	// own region setting says (see docs/ARGO_DTN.md).
	DutyFraction float64
	seq          uint32
}

// meshtasticFor builds the bearer from the flag value, or nil when unset.
func meshtasticFor(raw string) (*Meshtastic, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("ARGO_MESHTASTIC_URL must be http(s)://host of a Meshtastic node on this network")
	}
	if !localHost(u.Hostname()) {
		return nil, errors.New("the Meshtastic node must be on this LAN (private address or .local name)")
	}
	u.Path, u.RawQuery, u.Fragment = "", "", ""
	return &Meshtastic{Base: u, SF: 11, BW: 250000, CR: 1, Preamble: 16, DutyFraction: 0.01,
		C: &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// localHost accepts loopback, private and link-local addresses and mDNS names.
func localHost(h string) bool {
	if strings.HasSuffix(strings.ToLower(h), ".local") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

func (m *Meshtastic) Name() string { return "meshtastic" }
func (m *Meshtastic) MTU() int     { return meshMTU }
func (m *Meshtastic) Cost() int    { return 1 }
func (m *Meshtastic) Duty() float64 {
	if m.DutyFraction <= 0 {
		return 0.01
	}
	return m.DutyFraction
}

// Airtime counts the radio header and protobuf overhead around our bytes.
func (m *Meshtastic) Airtime(n int) time.Duration {
	return loraAirtime(n+meshOverhead, m.SF, m.BW, m.CR, m.Preamble)
}

func (m *Meshtastic) call(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	u := *m.Base
	if i := strings.IndexByte(path, '?'); i >= 0 {
		u.RawQuery, path = path[i+1:], path[:i]
	}
	u.Path = path
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-protobuf")
	resp, err := m.C.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	return b, resp.StatusCode, err
}

func (m *Meshtastic) Send(ctx context.Context, frame []byte) error {
	if len(frame) > meshMTU {
		return errTooBig
	}
	m.seq++
	_, code, err := m.call(ctx, http.MethodPut, "/api/v1/toradio", toRadioPacket(0xffffffff, m.seq, frame))
	if err != nil {
		return err
	}
	if code/100 != 2 {
		return fmt.Errorf("meshtastic node answered HTTP %d", code)
	}
	return nil
}

// Recv drains the node's queue, at most 32 messages a call, keeping the
// PRIVATE_APP payloads. Other traffic on the mesh is ignored and not stored.
func (m *Meshtastic) Recv(ctx context.Context) ([][]byte, error) {
	var out [][]byte
	for range 32 {
		b, code, err := m.call(ctx, http.MethodGet, "/api/v1/fromradio?all=false", nil)
		if err != nil {
			return out, err
		}
		if code/100 != 2 || len(b) == 0 {
			return out, nil
		}
		if p, ok := privatePayload(b); ok {
			out = append(out, p)
		}
	}
	return out, nil
}
