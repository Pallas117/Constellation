# Memory sidecar (Cosmic Brain)

Gauss's evidence memory runs as a separate local service from the private repo
`Pallas117/gauss-brain`. This backend talks to it only through `backend/memory/client.ts`.

```
browser ──/api/rag/*──▶ Constellation backend (:3001, role policy in rbac.ts)
                              │ loopback only
                              ▼
                        memory service (127.0.0.1:3002, no auth of its own)
                              │
                        catalog for ONE audience (public | member | operator)
```

## What it does here

| Route | Policy | Behaviour |
|---|---|---|
| `GET /api/rag/status` | operator | Document, chunk and graph counts plus last index time. No local paths. 503 with a reason when the service is down |
| `POST /api/rag/query` | operator | `{query, topK?}` (max 2,000 chars) returns `{answer, sources}`. Only checksum-verified sources, and absolute paths are reduced to file names. The answer abstains ("Unknown/insufficient evidence") when nothing verified matches |

Indexing and memory changes (`remember`, `compact`, `forget`) have **no route here**. They are
operator tasks on the memory host (`scripts/run-memory.sh <audience> --index`, approval tooling
in gauss-brain). An internet-facing API should not be able to change what Gauss remembers.

## Configuration

`GAUSS_MEMORY_URL` (default `http://127.0.0.1:3002`, `off` to disable). Only a loopback http
URL is accepted. Anything else is treated as not configured.

**On an internet-facing host, point it at the public instance only.** Each audience is a
separate process with its own database files, so the public instance physically cannot
return member or operator documents.

## Running it next to the backend

```bash
cd ~/Documents/Documents/lightbound/Gauss/Gauss\ AI/gauss-brain
scripts/run-memory.sh public --index   # build data/public from corpus/public's approved documents
scripts/run-memory.sh public           # serve on 127.0.0.1:3002
```

A document reaches the public catalog only when a person approves it as `public`, at the
checksum they approved (`scripts/memory/corpus_manifest.py approve …`). Apply GAU-12 before
approving: no unsupported flight, qualification, dose, damage, customer or QPIN claims.

## Cosmic Garden (staff portal)

`/garden` (staff and up) draws the brain's markdown export as a graph of linked notes.
gauss-brain's `scripts/memory/export-garden.sh` rebuilds the vault hourly; set
`GAUSS_GARDEN_DIR` (absolute path) in the live checkout's `.env` to show it. The backend
(`backend/memory/garden.ts`) reads only the exporter's `Cosmic Brain/` folder, never follows
symlinks, and filters every note by audience, like the brain's separate catalogs:

| Notes | Who sees them |
|---|---|
| `Corpus/member/` and its map | staff and up |
| `Corpus/operator/` and its map | operator and up |
| `Memory/`, the memory maps, `Home` | admin only |
| anything else | nobody |

Links to notes above the caller's role are dropped from the graph and shown as plain text
in a note, without the hidden note's name. The page loads on open and on Refresh; it never
polls.

## Not yet

- The service is evidence-only: `GAUSS_BRAIN_URL` (a local model) is unset, so answers
  abstain. The Gauss AI orchestrator (next PR) turns evidence into cited answers with Claude.
- It runs as LaunchAgents installed from gauss-brain (`scripts/memory-services.sh install public`: memory on :3002, local answer model on :3032). `scripts/ops/gauss-services.sh check` reports both. To serve the operator corpus instead, run `scripts/memory-services.sh install operator` (:3022) and put `GAUSS_MEMORY_URL=http://127.0.0.1:3022` in the live checkout's `.env`; the backend and `check` both read it there.
- Retrieval always returns its nearest chunks, even for unrelated questions. Callers must
  judge relevance before citing.
