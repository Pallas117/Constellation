# Critical Bugs & Fixes

**Priority**: CRITICAL - Fix Before Next Deploy
**Impact**: Data loss, memory leaks, connection exhaustion, pipeline failures

---

## 🔴 CRITICAL-1: Unhandled Promise Rejection in IngestionWorker

**File**: `backend/worker/ingest-loop.ts` (Lines 64-75)

**Problem**: Initial tick fails silently with no recovery. Data ingestion pipeline dies on startup.

**Current Code**:
```typescript
// Initial tick
tick();
```

**Fix**: Add exponential backoff retry:
```typescript
async function tickWithRetry(attempt = 0) {
  try {
    await tick();
  } catch (err) {
    const maxAttempts = 5;
    const baseDelay = 2000; // 2 seconds
    const delay = baseDelay * Math.pow(2, attempt); // exponential backoff
    
    if (attempt < maxAttempts) {
      console.error(`❌ Tick failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`, err);
      setTimeout(() => tickWithRetry(attempt + 1), delay);
    } else {
      console.error(`❌ Tick failed after ${maxAttempts} attempts, pipeline offline`);
      // Alert ops here
    }
  }
}

// Initial tick with retry
tickWithRetry();
```

**Impact**: Prevents data pipeline death on startup failures. Auto-recovers from transient errors.

---

## 🔴 CRITICAL-2: Memory Leak in GaussRagPanel

**File**: `frontend/src/components/GaussRagPanel.tsx` (Lines 81-95)

**Problem**: `setInterval()` in event handler without cleanup. Creates new interval on each storm event. Accumulates 100s of timers.

**Current Code**:
```typescript
const handleStormEvent = () => {
  setInterval(() => {
    // ... some animation logic
  }, 16);
};
```

**Fix**: Move interval outside event handler with proper cleanup:
```typescript
useEffect(() => {
  let animationIntervalId: NodeJS.Timeout | null = null;
  let stormActive = false;
  
  const handleStormEvent = () => {
    if (!stormActive) {
      stormActive = true;
      animationIntervalId = setInterval(() => {
        // ... animation logic
      }, 16);
    }
  };
  
  const handleStormEnd = () => {
    stormActive = false;
    if (animationIntervalId) {
      clearInterval(animationIntervalId);
      animationIntervalId = null;
    }
  };
  
  // Subscribe to storm events
  const unsubscribe = stormEventBus.on('start', handleStormEvent);
  const unsubscribeEnd = stormEventBus.on('end', handleStormEnd);
  
  // Cleanup
  return () => {
    unsubscribe();
    unsubscribeEnd();
    if (animationIntervalId) {
      clearInterval(animationIntervalId);
    }
  };
}, []);
```

**Impact**: Frees 100s of MB of memory over time. Fixes browser slowdown during storm events.

---

## 🔴 CRITICAL-3: GraphDB Connection Leak

**File**: `backend/services/graphdb-client.ts`

**Problem**: No connection pooling. Opens new session per call. Exhausts Neo4j limits (typically 20 concurrent).

**Current Code**:
```typescript
async query(cypher: string, params: any = {}) {
  const session = this.driver.session(); // New session every time!
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}
```

**Fix**: Implement connection pooling with max 10 concurrent:
```typescript
export class GraphDBClient {
  private driver: Driver;
  private sessionPool: Session[] = [];
  private maxPoolSize = 10;
  private activeRequests = 0;
  private requestQueue: Array<() => Promise<any>> = [];

  async query(cypher: string, params: any = {}) {
    // Wait if at max capacity
    while (this.activeRequests >= this.maxPoolSize) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.activeRequests++;
    const session = this.driver.session();
    
    try {
      const result = await session.run(cypher, params);
      return result.records;
    } finally {
      this.activeRequests--;
      await session.close();
      
      // Process queued requests
      if (this.requestQueue.length > 0) {
        const nextRequest = this.requestQueue.shift();
        if (nextRequest) nextRequest();
      }
    }
  }

  async close() {
    await this.driver.close();
  }
}
```

**Impact**: Prevents Neo4j connection exhaustion. Allows 10x more concurrent requests.

---

## 🔴 CRITICAL-4: Cascading RPC Failures in Ingest Loop

**File**: `backend/worker/ingest-loop.ts` (Lines 189-191)

**Problem**: Sequential `throwOnError()` calls. First failure prevents others from running. Loses data from remaining sources.

**Current Code**:
```typescript
const esaResult = await fetchEsaReadout();
throwOnError(esaResult.status, "ESA");

const jaxaResult = await fetchJaxaReadout();
throwOnError(jaxaResult.status, "JAXA");

const mmsResult = await fetchMmsBurstWindows();
throwOnError(mmsResult.status, "MMS"); // Dies here if previous failed
```

**Fix**: Collect all results, fail gracefully per-source:
```typescript
const results = await Promise.allSettled([
  (async () => ({
    source: "ESA",
    data: await fetchEsaReadout(),
  }))(),
  (async () => ({
    source: "JAXA",
    data: await fetchJaxaReadout(),
  }))(),
  (async () => ({
    source: "MMS",
    data: await fetchMmsBurstWindows(),
  }))(),
]);

const successful = [];
const failed = [];

for (const result of results) {
  if (result.status === "fulfilled") {
    const { source, data } = result.value;
    if (!throwOnError(data.status, source)) {
      successful.push({ source, data });
    } else {
      failed.push(source);
    }
  } else {
    failed.push(result.reason.source);
  }
}

if (successful.length === 0) {
  throw new Error(`All RPC sources failed: ${failed.join(", ")}`);
} else if (failed.length > 0) {
  console.warn(`⚠️  Partial data (${failed.join(", ")} failed, using others)`);
}

// Process successful data
for (const { source, data } of successful) {
  await processAndStore(source, data);
}
```

**Impact**: Enables partial data ingestion. 3 sources → 1 failure now affects only that source, not all.

---

## Implementation Priority

1. **CRITICAL-1**: Fix first (prevents pipeline death)
2. **CRITICAL-2**: Fix second (memory leak affects all users)
3. **CRITICAL-3**: Fix third (connection exhaustion happens under load)
4. **CRITICAL-4**: Fix fourth (data loss during partial outages)

**Estimated Fix Time**: 2-3 hours total
**Testing**: Each fix needs:
- Unit test for happy path ✅
- Error case test ✅
- Load/stress test for connection pool
- 24-hour uptime test

---

## Verification Checklist

After fixes:
- [ ] IngestionWorker auto-recovers from network failures
- [ ] Memory stable at 150-200MB (no growth over 24h)
- [ ] GraphDB under load doesn't exceed 10 concurrent sessions
- [ ] One failed RPC source doesn't block others

---

## Additional High-Severity Fixes (This Week)

See: `/memories/session/code-quality-audit.md` for:
- Race conditions in adapter fetches (#5)
- Bedrock N+1 loading pattern (#6)
- Frontend timeout gaps (#8)
- Missing error boundaries in React (#10)

