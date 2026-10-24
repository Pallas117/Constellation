package main

// The Gauss hub as a convergence layer: HTTP over the tailnet with the
// device token Argo already uses for reports. The hub stores ciphertext and
// public keys only (backend/mesh/bundles.ts). Like pushToGauss, it refuses
// any URL that isn't this Mac or a tailnet address, never uses a proxy, and
// keeps TLS verification on when the URL is https.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var bundleKeyRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

type httpHub struct {
	base  *url.URL
	token string
	c     *http.Client
}

func newHTTPHub(cfg Config) (*httpHub, error) {
	u, err := tailnetOnly(cfg.GaussURL)
	if err != nil {
		return nil, err
	}
	tok, err := os.ReadFile(filepath.Join(configDir(), "token"))
	if err != nil {
		return nil, errors.New("no Gauss device token; run `argo enroll` first")
	}
	return &httpHub{base: u, token: strings.TrimSpace(string(tok)),
		c: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil}}}, nil
}

func (h *httpHub) do(ctx context.Context, method, path string, body []byte, ctype string, limit int64) ([]byte, int, error) {
	u := *h.base
	u.Path = path
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	resp, err := h.c.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("hub unreachable: %w", err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if int64(len(out)) > limit {
		return nil, resp.StatusCode, errors.New("hub reply too large")
	}
	return out, resp.StatusCode, nil
}

// hubError turns a status into an error: refusals are final, the rest are
// retried. Only a JSON refusal from the bundle routes counts as final; a bare
// 404 means a Gauss too old to have them, which a redeploy fixes.
func hubError(code int, body []byte) error {
	var e struct {
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) != nil || e.OK == nil {
		return fmt.Errorf("HTTP %d: this Gauss does not offer bundle relay yet", code)
	}
	msg := fmt.Sprintf("HTTP %d %s", code, safeName(e.Error))
	switch code {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: %s", errHubRefused, msg)
	case http.StatusConflict:
		return fmt.Errorf("%w: %s", errHubConflict, msg)
	}
	return errors.New(msg)
}

func (h *httpHub) Put(ctx context.Context, raw []byte) error {
	body, code, err := h.do(ctx, http.MethodPost, "/api/mesh/bundles", raw, "application/octet-stream", 4<<10)
	if err != nil {
		return err
	}
	if code == http.StatusOK || code == http.StatusCreated {
		return nil
	}
	return hubError(code, body)
}

func (h *httpHub) List(ctx context.Context) ([]hubItem, error) {
	body, code, err := h.do(ctx, http.MethodGet, "/api/mesh/bundles", nil, "", 1<<20)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, hubError(code, body)
	}
	var r struct {
		Bundles []hubItem `json:"bundles"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	out := r.Bundles[:0]
	for _, b := range r.Bundles {
		if bundleKeyRE.MatchString(b.Key) {
			out = append(out, b)
		}
	}
	return out, nil
}

func (h *httpHub) Get(ctx context.Context, key string) ([]byte, error) {
	if !bundleKeyRE.MatchString(key) {
		return nil, errors.New("bad bundle id")
	}
	body, code, err := h.do(ctx, http.MethodGet, "/api/mesh/bundles/"+key, nil, "", 2*chunkSize+64<<10)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, hubError(code, body)
	}
	return body, nil
}

func (h *httpHub) Ack(ctx context.Context, key string) error {
	if !bundleKeyRE.MatchString(key) {
		return errors.New("bad bundle id")
	}
	body, code, err := h.do(ctx, http.MethodDelete, "/api/mesh/bundles/"+key, nil, "", 4<<10)
	if err != nil {
		return err
	}
	if code != http.StatusNoContent && code != http.StatusOK && code != http.StatusNotFound {
		return hubError(code, body)
	}
	return nil
}

func (h *httpHub) Status(ctx context.Context, keys []string) (map[string]string, error) {
	req, _ := json.Marshal(map[string][]string{"ids": append([]string{}, keys...)})
	body, code, err := h.do(ctx, http.MethodPost, "/api/mesh/bundles/status", req, "application/json", 1<<20)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, hubError(code, body)
	}
	var r struct {
		Status map[string]string `json:"status"`
	}
	return r.Status, json.Unmarshal(body, &r)
}

func (h *httpHub) Directory(ctx context.Context) ([]PeerKey, error) {
	body, code, err := h.do(ctx, http.MethodGet, "/api/mesh/directory", nil, "", 1<<20)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, hubError(code, body)
	}
	var r struct {
		Keys []PeerKey `json:"keys"`
	}
	return r.Keys, json.Unmarshal(body, &r)
}

func (h *httpHub) Publish(ctx context.Context, k PeerKey) error {
	req, _ := json.Marshal(k)
	body, code, err := h.do(ctx, http.MethodPost, "/api/mesh/keys", req, "application/json", 4<<10)
	if err != nil {
		return err
	}
	if code == http.StatusOK || code == http.StatusCreated {
		return nil
	}
	return hubError(code, body)
}
