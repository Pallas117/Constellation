# QA Test Plan - Space Weather Monitor

## Overview

This document outlines the comprehensive quality assurance strategy for the Space Weather Monitor application, covering functional, performance, security, and reliability testing.

---

## 1. Functional Tests

### 1.1 Backend Data Handling

| Test ID | Description | Expected Result | Priority |
|---------|-------------|-----------------|----------|
| BE-001 | Backend returns valid JSON | Response matches schema | Critical |
| BE-002 | Backend handles NOAA timeout | Returns cached/fallback data | Critical |
| BE-003 | Backend handles NASA timeout | Returns cached/fallback data | Critical |
| BE-004 | Backend handles partial API failure | Returns available data with flags | High |
| BE-005 | Backend marks stale data correctly | `flags.stale = true` when cache > 5min | High |
| BE-006 | Backend validates incoming data | Rejects malformed API responses | Critical |
| BE-007 | Backend spike rejection works | Outliers > ±4σ filtered | High |

### 1.2 Frontend Rendering

| Test ID | Description | Expected Result | Priority |
|---------|-------------|-----------------|----------|
| FE-001 | Earth renders correctly | Sphere with atmosphere visible | Critical |
| FE-002 | Van Allen belts render | Toroidal glow visible | Critical |
| FE-003 | Magnetosphere renders | Parametric surface visible | Critical |
| FE-004 | Layer toggles work | Each layer hides/shows independently | High |
| FE-005 | HUD displays data | All metrics shown with correct units | Critical |
| FE-006 | Stale indicator appears | Visual cue when data is stale | High |
| FE-007 | Screenshot captures scene | PNG downloaded with visible content | Medium |

### 1.3 Data Flow

| Test ID | Description | Expected Result | Priority |
|---------|-------------|-----------------|----------|
| DF-001 | Data interpolates smoothly | No visible snapping between updates | Critical |
| DF-002 | Magnetopause compression responds | Shrinks with high solar wind | High |
| DF-003 | Belt intensity responds | Brightens with high flux | High |
| DF-004 | Reconnection visual responds | Effect visible with southward Bz | High |
| DF-005 | 8-12 second transition | Smooth EMA interpolation | High |

---

## 2. Performance Tests

### 2.1 Frame Rate

| Test ID | Description | Target | Minimum |
|---------|-------------|--------|---------|
| PERF-001 | Desktop Chrome FPS | 60fps | 30fps |
| PERF-002 | Desktop Firefox FPS | 60fps | 30fps |
| PERF-003 | Desktop Safari FPS | 60fps | 30fps |
| PERF-004 | Integrated GPU FPS | 30fps | 24fps |

### 2.2 Load Times

| Test ID | Description | Target | Maximum |
|---------|-------------|--------|---------|
| PERF-010 | Initial page load | < 2s | 4s |
| PERF-011 | 3D scene ready | < 3s | 5s |
| PERF-012 | First data display | < 4s | 6s |

### 2.3 Shader Performance

| Test ID | Description | Target | Maximum |
|---------|-------------|--------|---------|
| PERF-020 | Earth shader time | < 1ms | 2ms |
| PERF-021 | Van Allen belts time | < 5ms | 8ms |
| PERF-022 | Magnetosphere time | < 2ms | 4ms |
| PERF-023 | Field lines time | < 1ms | 2ms |
| PERF-024 | Total shader time | < 8ms | 12ms |

### 2.4 Memory

| Test ID | Description | Target | Maximum |
|---------|-------------|--------|---------|
| PERF-030 | Initial memory | < 100MB | 200MB |
| PERF-031 | After 1 hour | < 150MB | 250MB |
| PERF-032 | No memory leaks | Stable over time | - |

### Performance Test Procedure

```javascript
// Frame time measurement
const times = [];
function measureFrame() {
  const start = performance.now();
  renderer.render(scene, camera);
  times.push(performance.now() - start);
  
  if (times.length >= 100) {
    const avg = times.reduce((a, b) => a + b) / times.length;
    const max = Math.max(...times);
    console.log(`Avg: ${avg.toFixed(2)}ms, Max: ${max.toFixed(2)}ms`);
    times.length = 0;
  }
  requestAnimationFrame(measureFrame);
}
```

---

## 3. Security Tests

### 3.1 Transport Security

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-001 | HTTPS enforcement | HTTP redirects to HTTPS |
| SEC-002 | TLS version | TLS 1.2+ only |
| SEC-003 | Certificate valid | No warnings |

### 3.2 CORS Configuration

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-010 | CORS headers present | `Access-Control-Allow-Origin` set |
| SEC-011 | Preflight handled | OPTIONS returns 200 |
| SEC-012 | Unauthorized origin blocked | Request fails from unknown origin |

### 3.3 Content Security Policy

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-020 | CSP header present | `Content-Security-Policy` set |
| SEC-021 | Inline scripts blocked | CSP violation reported |
| SEC-022 | External scripts blocked | Only whitelisted sources |

### 3.4 Input Validation

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-030 | Malformed JSON rejected | 400 response |
| SEC-031 | Oversized payload rejected | 413 response |
| SEC-032 | SQL injection safe | No database errors |
| SEC-033 | XSS in data safe | Data escaped properly |

### 3.5 Rate Limiting

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-040 | Rate limit enforced | 429 after 60 req/min |
| SEC-041 | Rate limit resets | Requests allowed after window |

---

## 4. Data Reliability Tests

### 4.1 Outage Simulation

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| REL-001 | NOAA outage (5 min) | Cache serves data, stale flag set |
| REL-002 | NOAA outage (30 min) | Fallback values, clear indicator |
| REL-003 | NASA outage (5 min) | Partial data returned |
| REL-004 | Complete outage | Graceful degradation, no crash |

### 4.2 Spike Injection

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| REL-010 | Solar wind spike 10x | Spike filtered, smooth transition |
| REL-011 | Bz spike to -100 nT | Spike filtered |
| REL-012 | Kp spike to 15 | Value clamped to 9 |
| REL-013 | Negative flux values | Clamped to 0 |

### 4.3 Decay Logic

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| REL-020 | Values decay toward baseline | Exponential decay visible |
| REL-021 | Decay rate correct | Half-life ~5 minutes |
| REL-022 | Decay stops at baseline | Values stabilize |

### Outage Simulation Procedure

```javascript
// Mock API failure in tests
const mockFetch = (shouldFail) => {
  if (shouldFail) {
    return Promise.reject(new Error('Network error'));
  }
  return originalFetch();
};

// Test decay behavior
async function testDecay() {
  // Record initial value
  const initial = getCurrentData();
  
  // Simulate outage
  enableOutageSimulation();
  
  // Check decay over time
  for (let i = 0; i < 10; i++) {
    await sleep(60000); // 1 minute
    const current = getCurrentData();
    assert(current < initial, 'Value should decay');
  }
}
```

---

## 5. Cross-Browser Tests

### 5.1 Browser Matrix

| Browser | Version | Priority |
|---------|---------|----------|
| Chrome | Latest, Latest-1 | Critical |
| Firefox | Latest, Latest-1 | Critical |
| Safari | Latest | High |
| Edge | Latest | Medium |

### 5.2 GPU Compatibility

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| GPU-001 | NVIDIA discrete | Full quality, 60fps |
| GPU-002 | AMD discrete | Full quality, 60fps |
| GPU-003 | Intel integrated | Reduced quality, 30fps |
| GPU-004 | Apple M1/M2 | Full quality, 60fps |
| GPU-005 | WebGL blacklisted | Graceful fallback message |

### 5.3 Fallback Modes

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| FALL-001 | WebGL disabled | Informative error message |
| FALL-002 | WebGL 1 only | Degraded but functional |
| FALL-003 | Low-end device detected | Reduced particle count |
| FALL-004 | FPS drops below 24 | Auto quality reduction |

---

## 6. Test Automation

### 6.1 Unit Tests (Vitest)

```typescript
describe('useSpaceWeather', () => {
  it('interpolates smoothly', () => {
    const { result } = renderHook(() => useSpaceWeather());
    // Test interpolation logic
  });
  
  it('handles stale data', () => {
    // Mock stale response
  });
  
  it('rejects spikes', () => {
    // Inject spike values
  });
});
```

### 6.2 Integration Tests

```typescript
describe('Data Flow', () => {
  it('fetches and displays data', async () => {
    render(<SpaceWeatherVisualization />);
    await waitFor(() => {
      expect(screen.getByText(/km\/s/)).toBeInTheDocument();
    });
  });
});
```

### 6.3 Visual Regression Tests

```typescript
describe('Visual Regression', () => {
  it('matches Earth snapshot', async () => {
    const screenshot = await page.screenshot();
    expect(screenshot).toMatchImageSnapshot();
  });
});
```

---

## 7. Test Schedule

| Phase | Tests | Trigger |
|-------|-------|---------|
| Pre-commit | Unit tests | Git hook |
| PR | Unit + Integration | CI pipeline |
| Nightly | Full suite | Scheduled |
| Release | Full + Manual | Before deploy |

---

## 8. Acceptance Criteria

### Must Pass (Critical)
- All BE-00x tests
- All FE-00x tests
- All SEC-00x tests
- PERF-001 ≥ 30fps

### Should Pass (High)
- All DF-00x tests
- All PERF-02x within maximum
- All REL-00x tests

### May Fail (Medium)
- PERF targets (can meet minimum)
- Some GPU-00x on edge cases
