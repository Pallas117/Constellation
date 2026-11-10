package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Attention policy: every text to the phone passes one gate (Phone.SendAlert),
// whichever watcher raised it. The owner has a day job, so a text has to be
// worth an interruption. Measured 5-10 Nov 2026 on judith: 60-140 texts a day,
// round the clock, a third of them about power and a tenth "recovered".
//
//   urgent  text now, also in quiet hours (repeats of one topic: every 15 min)
//   warn    text now unless: quiet hours, the same topic already texted
//           recently, or more than perHour texts went out in the last hour
//   info    never texts by itself (recoveries, "OK" notes)
//
// Whatever is not texted is held, never dropped, and goes out as one digest:
// when quiet hours end, or once the oldest held alert is digestEvery old.

type AlertLevel int

const (
	AlertAuto AlertLevel = iota // classify from the title (callers that predate levels)
	AlertUrgent
	AlertWarn
	AlertInfo
)

func parseLevel(s string) (AlertLevel, error) {
	switch strings.ToLower(s) {
	case "", "auto":
		return AlertAuto, nil
	case "urgent":
		return AlertUrgent, nil
	case "warn":
		return AlertWarn, nil
	case "info":
		return AlertInfo, nil
	}
	return AlertAuto, errors.New("-level must be urgent, warn or info")
}

// Alert is one message for the owner. Key is the caller's rate-limit key, if any.
type Alert struct {
	Level AlertLevel
	Key   string
	Title string
	Msg   string
}

const (
	defaultQuietHours = "23:00-07:00"
	coarseTopicEvery  = 2 * time.Hour    // power, memory, disk: several watchers report each
	topicEvery        = 30 * time.Minute // any other topic
	urgentEvery       = 15 * time.Minute
	textsPerHour      = 4
	digestEvery       = 3 * time.Hour
	maxHeld           = 200
	digestLines       = 8
)

var (
	urgentRe = regexp.MustCompile(`(?i)\b(critical|emergency|shutting down|shut down)\b`)
	infoRe   = regexp.MustCompile(`(?i)\b(recovered|restored|back to normal|cleared|resolved|ok)\b|✅`)
	coarseRe = []struct {
		topic string
		re    *regexp.Regexp
	}{
		{"power", regexp.MustCompile(`(?i)\b(battery|charger|charging|power|plug)`)},
		{"memory", regexp.MustCompile(`(?i)\b(memory|swap|ram)\b`)},
		{"disk", regexp.MustCompile(`(?i)\b(disk|storage)\b`)},
	}
)

// level resolves AlertAuto from the title and key: "critical" is urgent, a
// recovery is info, everything else warns. Only the title decides info, so a
// message that mentions "cleared by itself" still warns.
func (a Alert) level() AlertLevel {
	if a.Level != AlertAuto {
		return a.Level
	}
	switch {
	case urgentRe.MatchString(a.Title + " " + a.Key):
		return AlertUrgent
	case infoRe.MatchString(a.Title):
		return AlertInfo
	}
	return AlertWarn
}

// topic groups alerts about the same thing, and says whether it is one of the
// coarse topics that several watchers report independently.
func (a Alert) topic() (string, bool) {
	for _, t := range coarseRe {
		if t.re.MatchString(a.Title + " " + a.Key) {
			return t.topic, true
		}
	}
	if a.Key != "" {
		return a.Key, false
	}
	words := strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) {
			return unicode.ToLower(r)
		}
		return ' '
	}, a.Title))
	return strings.Join(words, " "), false
}

// clockSpan is a daily window in minutes after midnight; From > To wraps midnight.
type clockSpan struct{ From, To int }

func parseClock(s string) (int, error) {
	h, m, ok := strings.Cut(strings.TrimSpace(s), ":")
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, fmt.Errorf("bad time %q (want HH:MM)", s)
	}
	return hh*60 + mm, nil
}

// parseQuietHours reads "23:00-07:00" or several windows separated by commas
// ("23:00-07:00,09:00-12:30"). "" means the default; "off" means none.
func parseQuietHours(s string) ([]clockSpan, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		s = defaultQuietHours
	}
	if strings.EqualFold(s, "off") {
		return nil, nil
	}
	var out []clockSpan
	for _, part := range strings.Split(s, ",") {
		a, b, ok := strings.Cut(part, "-")
		if !ok {
			return nil, fmt.Errorf("bad quiet hours %q (want HH:MM-HH:MM)", part)
		}
		from, err := parseClock(a)
		if err != nil {
			return nil, err
		}
		to, err := parseClock(b)
		if err != nil {
			return nil, err
		}
		if from != to {
			out = append(out, clockSpan{from, to})
		}
	}
	return out, nil
}

type heldAlert struct {
	At    time.Time `json:"at"`
	Topic string    `json:"topic"`
	Title string    `json:"title"`
	Quiet bool      `json:"quiet,omitempty"` // held because of quiet hours
}

type attentionState struct {
	Sent   map[string]time.Time `json:"sent,omitempty"`   // topic → last text
	Recent []time.Time          `json:"recent,omitempty"` // non-urgent texts in the last hour
	Held   []heldAlert          `json:"held,omitempty"`
}

// Attention is the policy and its state file. The caller holds the phone
// queue lock, which also serialises this file.
type Attention struct {
	Path  string
	Quiet []clockSpan
}

func newAttention(stateDir, quietHours string) *Attention {
	quiet, err := parseQuietHours(quietHours)
	if err != nil { // a typo in config must not silence or flood the phone
		quiet, _ = parseQuietHours(defaultQuietHours)
	}
	return &Attention{Path: filepath.Join(stateDir, "attention.json"), Quiet: quiet}
}

func (at *Attention) inQuiet(now time.Time) bool {
	m := now.Hour()*60 + now.Minute()
	for _, q := range at.Quiet {
		if (q.From < q.To && m >= q.From && m < q.To) || (q.From > q.To && (m >= q.From || m < q.To)) {
			return true
		}
	}
	return false
}

func (at *Attention) load() attentionState {
	var st attentionState
	if b, err := os.ReadFile(at.Path); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Sent == nil {
		st.Sent = map[string]time.Time{}
	}
	return st
}

func (at *Attention) save(st attentionState) {
	b, _ := json.Marshal(st)
	_ = os.MkdirAll(filepath.Dir(at.Path), 0o700)
	_ = os.WriteFile(at.Path, b, 0o600) // if this fails the next alert texts again: louder, never silent
}

// admit reports whether the alert texts the phone now. If not, it is held for the digest.
func (at *Attention) admit(a Alert, now time.Time) bool {
	st := at.load()
	defer func() { at.save(st) }()
	for k, t := range st.Sent {
		if now.Sub(t) > 24*time.Hour {
			delete(st.Sent, k)
		}
	}
	recent := st.Recent[:0]
	for _, t := range st.Recent {
		if now.Sub(t) < time.Hour {
			recent = append(recent, t)
		}
	}
	st.Recent = recent

	topic, coarse := a.topic()
	hold := func(quiet bool) bool {
		st.Held = append(st.Held, heldAlert{At: now, Topic: topic, Title: Mask(a.Title), Quiet: quiet})
		if len(st.Held) > maxHeld {
			st.Held = st.Held[len(st.Held)-maxHeld:]
		}
		return false
	}
	switch a.level() {
	case AlertUrgent:
		if last, ok := st.Sent["urgent:"+topic]; ok && now.Sub(last) < urgentEvery {
			return hold(false)
		}
		st.Sent["urgent:"+topic] = now
		return true
	case AlertInfo:
		return hold(at.inQuiet(now))
	}
	every := topicEvery
	if coarse {
		every = coarseTopicEvery
	}
	switch last, seen := st.Sent[topic]; {
	case at.inQuiet(now):
		return hold(true)
	case seen && now.Sub(last) < every:
		return hold(false)
	case len(st.Recent) >= textsPerHour:
		return hold(false)
	}
	st.Sent[topic] = now
	st.Recent = append(st.Recent, now)
	return true
}

// digest returns the one text that covers everything held, or "" when it is
// not time: never in quiet hours; otherwise as soon as quiet hours have ended
// with something held from them, or once the oldest held alert is digestEvery old.
func (at *Attention) digest(now time.Time) string {
	st := at.load()
	if len(st.Held) == 0 || at.inQuiet(now) {
		return ""
	}
	due := now.Sub(st.Held[0].At) >= digestEvery
	for _, h := range st.Held {
		due = due || h.Quiet
	}
	if !due {
		return ""
	}
	type group struct {
		title string
		n     int
		last  time.Time
	}
	groups := map[string]*group{}
	var order []string
	for _, h := range st.Held {
		g := groups[h.Topic]
		if g == nil {
			g = &group{}
			groups[h.Topic] = g
			order = append(order, h.Topic)
		}
		g.n, g.title, g.last = g.n+1, h.Title, h.At
	}
	sort.SliceStable(order, func(i, j int) bool { return groups[order[i]].n > groups[order[j]].n })
	var b strings.Builder
	fmt.Fprintf(&b, "%d alerts held since %s, none urgent:", len(st.Held), st.Held[0].At.Format("15:04"))
	for i, t := range order {
		if i == digestLines {
			fmt.Fprintf(&b, "\n+ %d more topics", len(order)-digestLines)
			break
		}
		g := groups[t]
		fmt.Fprintf(&b, "\n%d× %s (last %s)", g.n, g.title, g.last.Format("15:04"))
	}
	st.Held = nil
	at.save(st)
	return b.String()
}

// held is how many alerts wait for the next digest.
func (at *Attention) held() int { return len(at.load().Held) }

// egressTextRe splits a logged text back into title, device, clock and message.
var egressTextRe = regexp.MustCompile(`(?s)^(.*?) on (\S+) \((\d\d:\d\d)\)\n(.*)$`)

// attentionReplay runs a sent-texts log (egress.jsonl) through the policy and
// counts, per day, what was texted then and what would be texted now. It is
// how a change to the policy is checked against real days before it ships.
func attentionReplay(egressLog string, quiet []clockSpan) (string, error) {
	f, err := os.Open(egressLog)
	if err != nil {
		return "", err
	}
	defer f.Close()
	dir, err := os.MkdirTemp("", "argo-attention-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	at := &Attention{Path: filepath.Join(dir, "attention.json"), Quiet: quiet}
	type day struct{ before, now, urgent, digests, night int }
	days := map[string]*day{}
	var order []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		var e EgressEntry
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.Via != "messages" {
			continue
		}
		m := egressTextRe.FindStringSubmatch(e.Text)
		if m == nil || strings.HasPrefix(m[1], "Argo digest") {
			continue
		}
		key := e.At.Format("2006-01-02")
		d := days[key]
		if d == nil {
			d = &day{}
			days[key] = d
			order = append(order, key)
		}
		d.before++
		if at.digest(e.At) != "" { // the tick before this alert
			d.digests++
		}
		a := Alert{Title: m[1], Msg: m[4]}
		if at.admit(a, e.At) {
			d.now++
			if a.level() == AlertUrgent {
				d.urgent++
			}
			if h := e.At.Hour(); h < 7 || h >= 23 {
				d.night++
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("day         sent then  texts now (urgent, 23-07h)  digests\n")
	for _, k := range order {
		d := days[k]
		fmt.Fprintf(&b, "%s  %9d  %9d (%d, %d)  %14d\n", k, d.before, d.now, d.urgent, d.night, d.digests)
	}
	return b.String(), nil
}

// attentionCmd: `argo attention` shows the policy and what is held;
// `argo attention replay [egress.jsonl]` checks it against the sent-texts log.
func attentionCmd(args []string, cfg Config, s Store) error {
	quiet, err := parseQuietHours(cfg.QuietHours)
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "replay" {
		log := s.path("egress.jsonl")
		if len(args) > 1 {
			log = args[1]
		}
		out, err := attentionReplay(log, quiet)
		if err != nil {
			return err
		}
		fmt.Print(out)
		return nil
	}
	if len(args) > 0 {
		return errors.New("usage: argo attention [replay [egress.jsonl]]")
	}
	q := cfg.QuietHours
	if q == "" {
		q = defaultQuietHours
	}
	at := &Attention{Path: s.path("attention.json"), Quiet: quiet}
	fmt.Printf("quiet hours: %s (urgent alerts still text; set \"quiet_hours\" in config.json, \"off\" for none)\n", q)
	fmt.Printf("per topic: one text per %s (power, memory, disk: %s); at most %d texts an hour\n", topicEvery, coarseTopicEvery, textsPerHour)
	fmt.Printf("held for the next digest: %d (sent when quiet hours end, or after %s)\n", at.held(), digestEvery)
	return nil
}
