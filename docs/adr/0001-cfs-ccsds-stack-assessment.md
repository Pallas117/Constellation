# ADR 0001: cFS / CCSDS stack assessment. Should Gauss migrate?

- **Status:** Proposed
- **Date:** 2026-10-10
- **Deciders:** Josh (Gauss/Lightbound)
- **Scope:** Ground segment (operator dashboard and backend) and a future onboard component

## 1. Context

Gauss is a space-weather situational-awareness system that is meant to become a
defence-grade onboard AI. The repo currently contains:

| Area | What it is today | Paths |
|---|---|---|
| Backend | Node 22 + TypeScript, Express on :3001, better-sqlite3, better-auth | `backend/server.ts`, `backend/auth.ts`, `backend/better-auth.ts` |
| Data adapters | NOAA SWPC, ESA HAPI, MMS CDAWeb/LASP, JAXA ERG (HTTP/JSON pulls) | `backend/adapters/*.ts` |
| Physics | MHD nowcast, reconnection, HEALPix, coordinates, deconvolution | `backend/physics/*.ts` |
| Native core | C++ MHD core via node-gyp / N-API | `backend/cpp/mhd_core.cpp`, `backend/cpp/mhd_native.cpp`, `binding.gyp` |
| ML | Python inference server (stdlib HTTP), model registry | `ml/infer/infer_server.py`, `ml/models/registry.json`, `backend/ml-client/client.ts` |
| Telemetry schema | Protobuf telemetry message and descriptor | `shared/proto/telemetry.proto`, `shared/proto/telemetry_descriptor.json` |
| Ingest | Polling ingest worker | `backend/worker/ingest-loop.ts` |
| Mesh / devices | Mesh router and store; device registry and auth; Go `argo` agent | `backend/mesh/*`, `backend/services/device-*.ts`, `tools/argo/` |
| Frontend | React 18 + Vite 7 + three.js 0.169 | `frontend/` |

Nothing in the repo uses CCSDS framing or packet formats, XTCE, or SDLS today
(grep for `ccsds` and `xtce` found nothing). Every external interface is HTTPS/JSON
or protobuf.

The question is whether Gauss should move to NASA cFS, F Prime, or another
"space-native" stack. If not, what should it adopt instead?

## 2. Research summary (as of 2026-10-10)

### 2.1 NASA core Flight System (cFS)

- **Latest release:** the latest public bundle is **cFS v7.0.1**. It ships with
  cFE 7.0.1 and OSAL 7.0.1, and v7.0.0 was codenamed "Draco". The `dev` branch
  advertises **v7.0.2rc1**, which drops Memory Manager from the open-source set.
  An "Equuleus" release cycle has an rc1 tag. GitHub shows the day and month but
  not the year for v7.0.1 (14 May), so check the release page before citing a
  date. In 2026 NASA/GSFC announced a significant cFS update, and a Government-use
  ("Distro C") cFS with extra security, AI and autonomy features is available
  only under a Software User Agreement. A UK company should not plan on getting it.
- **Architecture:**
  - **OSAL** (OS Abstraction Layer) gives tasks, queues, semaphores, file system and
    sockets the same API on every supported OS.
  - **PSP** (Platform Support Package) handles board and BSP specifics.
  - **cFE** (core Flight Executive) provides Executive Services (app lifecycle),
    Software Bus, Event Services, Time Services, Table Services and FS.
  - **Apps** are loaded on top: CI/TO (command ingest and telemetry output), SCH
    (scheduler), HK, HS (health and safety), DS (data storage), FM (file manager),
    LC (limit checker), SC (stored commands), MD (memory dwell), CS (checksum) and
    CF (CFDP 727.0-B-5).
- **Software Bus:** a publish/subscribe bus keyed by message ID. Messages are CCSDS
  Space Packets with cFE secondary headers, so the onboard message format is
  already CCSDS 133.0-B.
- **Table Services:** parameter tables are validated, double-buffered and
  ground-loadable. These are the natural home for ML model weights and
  thresholds that need to be updated in flight with integrity checks.
- **Supported OS/platforms (README):** Linux (`pc-linux`), RTEMS 5 (pc686 under
  QEMU, GR712 LEON3), VxWorks 7, Linux on Raspberry Pi, and Yocto / Space Grade
  Linux under QEMU.
- **Licence:** **Apache 2.0** for the open-source bundle (confirmed in the nasa/cFS
  README and release notes). Contributions need a NASA CLA.
- **Ecosystem:**
  - **cFS Basecamp** is a lightweight learning and app-development distro. It uses
    CCSDS Electronic Data Sheets (EDS) to generate both flight and ground artefacts
    and has a Python GUI.
  - **NOS3** (NASA IV&V) is a cFS distribution plus hardware simulators, 42
    dynamics and COSMOS/OpenC3 ground, running in Docker on Linux. It is used as a
    "software digital twin" and hosts OnAIR ML experiments.
  - **OnAIR** (NASA GSFC) is a Python framework for onboard-AI research that
    subscribes to the cFS Software Bus. It is under NOSA, not Apache, so check the
    licence before reusing any code.
  - **CryptoLib** (NASA) is an open-source software implementation of SDLS / SDLS-EP
    for cFS and ground.

### 2.2 F´ (F Prime, NASA/JPL)

- **Latest:** **v4.4.1** (GitHub, 7 Oct; v4.4.0 was 30 Sep). v4.0.0 (Aug 2025)
  added CCSDS uplink and downlink (SpacePacketFramer, TM/TC framing) and a
  CfdpManager. The licence is Apache 2.0, the same as cFS. Confirm the LICENSE
  file at the version you pin.
- **Model:** a component/port architecture in C++ with code generation from
  FPP models. It has strong typed interfaces and unit-test harnesses and was
  flight-proven on Ingenuity. Its ground system (F´ GDS) is Python.
- **Compared with cFS:** F´ is better suited to a small team building a single
  focused payload in modern C++, and it handles CCSDS framing natively from v4.
  cFS has the larger app ecosystem (CF, HS, LC, SC, DS), greater heritage in
  GSFC/defence programmes, CryptoLib, and NOS3/OnAIR for AI test-beds.

### 2.3 CCSDS standards relevant to Gauss

| Standard | Current issue found | Relevance |
|---|---|---|
| Space Packet Protocol 133.0-B | **B-2** (cited by F´ v4.x, `spacepackets`) | Unit of TM/TC. Use it at the ground boundary and onboard. |
| TM SDLP 132.0-B / TC SDLP 232.0-B / AOS 732.0-B | current Blue Books | Frame layers over RF. Gauss handles packets and leaves frames to the ground station or radio. |
| USLP 732.1-B | **B-2** (cited by `spacepackets`) | Unified link protocol. Prefer it for new missions. |
| SDLS 355.0-B / SDLS-EP 355.1-B | **B-1 / B-1** (no B-2 found) | Authenticated encryption on transfer frames, key and SA management. Required for any commandable onboard asset. |
| CFDP 727.0-B | **B-5** (Jul 2020) | Reliable file transfer (model and table uploads, product downlink). cFS CF and F´ CfdpManager implement it. |
| Mission Operations (MO) 520.x / 521.x / 522.x | MO concept 520.0-G-3, MAL / COM / M&C Blue Books | Service-oriented ground/space interfaces. Low priority: little adoption outside ESA. |
| XTCE (OMG; CCSDS 660.x) | **OMG XTCE 1.3** (Jul 2025). CCSDS 660 Blue Book lags; check public.ccsds.org | TM/TC database exchange format. Most COSMOS/OpenC3, Yamcs and SCOS-class ground systems ingest it. |
| SOIS (850.x) / Electronic Data Sheets (876.0-B) | verify the current issue | Onboard device and interface services. EDS is what cFS Basecamp and cFS-EDS generate from. |

## 3. Decision

### 3.1 Ground segment (operator dashboard, backend, ML server): **do not migrate**

Keep Node 22 / TypeScript / React / three.js / Go `argo` / Python ML.

1. cFS and F´ are **flight** frameworks. Their ground tools are bare: cFS
   Ground System is a demo, and F´ GDS is mission-specific. Nothing in either would
   replace a multi-user, authenticated web dashboard with 3D visualisation.
2. The ground systems that do speak CCSDS natively are **Yamcs** (Java), **OpenC3
   COSMOS** (Ruby/Python) and ESA SCOS-2000/EGS-CC. Operations teams use one of
   these to run the spacecraft. Gauss should feed them, not compete with them.
3. Rewrite cost is high, and the only benefit (CCSDS compliance) can be had more
   cheaply with a boundary layer (3.2).

### 3.2 Add a CCSDS interoperability layer at the ground boundary

Gauss needs to be able to:

- **Export** its products (alerts, nowcasts, risk indices) as **CCSDS Space Packets
  (133.0-B-2)** with a published **XTCE 1.3** definition, so Yamcs, COSMOS and
  primes' MCS can ingest them without custom code.
- **Ingest** spacecraft housekeeping TM (radiation monitors, SEU counters,
  magnetometers) as Space Packets described by the mission's XTCE. This is the
  input an onboard or ground "health vs space weather" model needs.
- Optionally move model and table files over **CFDP**.

`shared/proto/telemetry.proto` stays the internal canonical schema. XTCE is
**generated** from it, so XTCE is never hand-maintained in a second place.

### 3.3 Onboard component (if and when Gauss flies): **cFS app in C (OSAL), not Node**

- Node.js, V8, better-sqlite3 and Python are not acceptable onboard: they bring
  non-deterministic GC, a large attack surface, and no RTOS support.
- Host Gauss onboard inference as **one or more cFS apps** on Linux (Yocto/SGL)
  first and RTEMS later if the processor demands it.
  - Inputs come from the Software Bus (sensor HK, magnetometer, particle counts).
  - Outputs are Space Packets and events (alerts, confidence, model version).
  - Model weights and thresholds live in **cFE Tables**, uploaded via **CF/CFDP**,
    CRC-checked by **CS**, and watched by **HS/LC**.
  - Inference uses a C-callable runtime with static memory: TFLite Micro, ONNX
    Runtime with a C API on Linux targets, or code-generated C from the model.
- **Use F´ instead** only if the host is a payload computer that a partner runs on F´,
  or if the team strongly prefers C++ component modelling. Using F´ does not
  change the ground-side decision.
- The C++ MHD core (`backend/cpp/mhd_core.cpp`) is the best candidate to port first.
  It is already C++ with no Node dependency apart from `mhd_native.cpp`. Wrap it
  behind a plain C ABI usable from both N-API and a cFS app.

### 3.4 Security (non-negotiable)

- **Ground:** never weaken TLS on any HTTPS/WebSocket path, and keep tokens out of
  URLs and logs (existing rules). Wrapping data in CCSDS does not replace TLS.
  Packet export to external MCS runs over TLS or mTLS, or over a defined
  air-gapped transfer.
- **Space link:** any uplink to a Gauss onboard app must be protected by
  **SDLS / SDLS-EP (355.0-B-1 / 355.1-B-1)**:
  - authenticated encryption (AES-GCM),
  - anti-replay sequence numbers,
  - key and SA management through EP procedures.

  NASA **CryptoLib** is the reference implementation to evaluate. Keys never live
  in the repo or Gauss DB, and an HSM or crypto unit holds them in flight.
- **Onboard app hardening:**
  - Validate command lengths and ranges in the app, and reject unknown function
    codes.
  - Tables must pass the validation callback before activation.
  - The model version and hash are reported in HK.
  - Add a "safe" fallback mode so that if the model fails, the app degrades to
    reporting thresholds only.
- **Supply chain:** pin cFS and F´ by tag and commit hash, verify tags (several cFS
  pre-release signing keys are listed as expired), and vendor through a reviewed
  fork.

## 4. Module mapping

| Repo module | Ground (keep) | CCSDS boundary (add) | Onboard (future) |
|---|---|---|---|
| `shared/proto/telemetry.proto` | canonical schema | source for XTCE generator | source for cFS msg/EDS definitions |
| `backend/adapters/*` | stays (HTTP science feeds) | n/a | n/a (onboard uses local sensors) |
| `backend/worker/ingest-loop.ts` | stays | add a Space Packet ingest path | n/a |
| `backend/physics/mhd-nowcast.ts` + `backend/cpp/mhd_core.cpp` | stays (N-API) | n/a | port to a C ABI, then the `GAUSS_MHD` cFS app |
| `backend/physics/{reconnection,coordinates,healpix}.ts` | stays | n/a | port selectively if needed onboard (C) |
| `ml/infer/infer_server.py`, `ml/models/registry.json` | stays (training and ground inference) | export model artefacts plus hash for CFDP upload | `GAUSS_INFER` cFS app; weights in cFE Table |
| `backend/ml-client/client.ts` | stays | n/a | n/a |
| `backend/mesh/*`, `tools/argo/` | stays (ground/edge networking) | n/a | n/a. Do not fly the mesh. |
| `backend/services/device-*.ts`, auth | stays | role gate on any command export | n/a |
| `frontend/` | stays | display decoded packet-sourced TM | n/a |

## 5. Migration steps

| # | Step | Effort | Notes |
|---|---|---|---|
| 1 | Add `backend/ccsds/` with a Space Packet encoder/decoder (primary header, APID, sequence count, CRC-16 option) and golden-vector tests against `spacepackets` (Python) output | **S** | No new runtime deps required. Write it in TS with `Buffer`, or use a vetted library. |
| 2 | Write an XTCE 1.3 generator from `telemetry_descriptor.json`, and add a CI-local test that validates against the OMG XSD | **S-M** | Output: `shared/xtce/gauss.xml`. |
| 3 | Add an export endpoint or stream: Gauss alerts as Space Packets over TLS (TCP or WebSocket), plus a Yamcs/OpenC3 smoke test in docker-compose | **M** | Proves interoperability with a real MCS. |
| 4 | Ingest spacecraft HK as Space Packets using a mission-supplied XTCE, with a mapping into the internal proto | **M** | Required before "AI on spacecraft health". |
| 5 | Refactor `mhd_core.cpp` behind a C ABI (`gauss_mhd.h`) used by both N-API and native tests, and remove `std::cout` and dynamic alloc from the hot path | **S-M** | Pays off for both ground and flight. |
| 6 | Stand up **NOS3** (or cFS Basecamp to start) locally in Docker, and build a skeleton `GAUSS_INFER` cFS app: SB subscribe, table-loaded thresholds, HK and alert packets | **M** | Use Linux `pc-linux` PSP first. |
| 7 | Choose an inference runtime for C (TFLite Micro or ONNX RT C API), quantise the model, and benchmark on target-class hardware (e.g. LEON/ARM in QEMU) | **M-L** | Determinism and memory bounds are the key results. |
| 8 | Add CFDP model upload (cFS CF) and a table validation callback that checks hash, shape and version | **M** | |
| 9 | Integrate SDLS-EP via CryptoLib on the NOS3 link, with key management design and a threat model | **L** | Needs a crypto and export review first (section 6). |
| 10 | Flight qualification: NPR 7150.2 / ECSS-E-ST-40C-style process, static analysis (MISRA C), coverage, IV&V | **L** | Only once a flight opportunity is real. |

Steps 1-5 are worth doing now. They are low cost and make Gauss legible to any
satellite operator. Steps 6-8 are the "onboard demonstrator" track, sized for an
ESA BIC / Innovate UK proposal. Steps 9-10 should be gated on a customer.

## 6. Licensing and export control

Seek legal advice before shipping onboard or crypto code. The notes below are not
legal advice.

- **cFS (open-source bundle):** Apache 2.0, so commercial and closed derivatives
  are allowed. Keep the NOTICE file, state your changes, and note that the licence
  includes a patent grant. **Distro C** (Government-use) is not available to us.
- **F´:** Apache 2.0 (verify the LICENSE at the pinned tag).
- **OnAIR:** NASA Open Source Agreement (NOSA). It is more restrictive and not
  OSI-identical to Apache, so do not copy code without review.
- **NOS3, CryptoLib:** check each repo's licence at the pinned tag before vendoring.
- **ITAR / EAR:** NASA's openly published cFS source is generally "publicly
  available" and outside EAR/ITAR as published. **Gauss's own derivatives are not
  automatically covered.**
  - A space-qualified onboard AI for defence spacecraft could fall under:
    - UK Strategic Export Controls (Military List ML11/ML21, or dual-use 9D/9E for
      spacecraft software), and
    - US controls (USML Cat XV / EAR 9x515) if US-origin controlled technical data
      or US persons are involved.
  - Cryptography in SDLS triggers **dual-use Cat 5 Part 2** (UK and EU) and EAR
    5D002 considerations.
- **Operating from Malaysia:** add Malaysia's Strategic Trade Act 2010 to the
  checklist if controlled tech is developed or transferred there.
- **Practical rule:**
  - Keep defence-specific models, thresholds and keys **out of the public repo**.
  - Keep the open repo to the generic framework and integration code.
  - Get a classification (UK ECJU control list classification advice) before
    sharing the onboard app with non-UK partners.

## 7. Consequences

**Positive**
- No rewrite of a working ground stack. CCSDS/XTCE makes Gauss pluggable into
  Yamcs, COSMOS and prime MCSs, which is a strong procurement signal.
- A credible onboard path on the most widely flown open framework, with heritage
  apps for file transfer, health and safety, and table management.
- One schema source (proto) drives ground JSON, XTCE and onboard message definitions.

**Negative / risks**
- **Two language worlds** (TS/Python on the ground, C onboard). Mitigate with the
  shared schema, golden test vectors, and a C-ABI physics core.
- **cFS release cadence is irregular.** The public tags show long rc cycles, and the
  security-hardened features sit in the Gov-only distro. Mitigate by pinning v7.0.x
  and owning the fork.
- **ML determinism onboard.** Quantisation can drift from ground models. Mitigate
  with bit-exact regression vectors run on the ground and in NOS3.
- **SDLS and crypto complexity** and export-control exposure: see section 6.
- **CCSDS documents get revised.** Pin issue numbers (133.0-B-2, 727.0-B-5,
  355.0-B-1, 355.1-B-1, XTCE 1.3) and re-check public.ccsds.org yearly.

## 8. Alternatives considered

| Option | Verdict |
|---|---|
| Rewrite ground in cFS or F´ GDS | **Rejected.** These are not ground/dashboard frameworks. |
| Rebase ground on Yamcs or OpenC3 COSMOS | **Rejected as a migration** (it would lose the web UX, auth and mesh). **Adopted as an integration target** in step 3. |
| Rewrite the backend in Go/Rust for "defence-grade" | **Rejected for now.** The language does not fix the risk. Revisit only if certification demands it. |
| Onboard in F´ instead of cFS | **Viable alternative.** Pick F´ if the host partner uses it. |
| Onboard in Python (OnAIR-style) | **Research only.** Acceptable in NOS3 experiments and not for flight. |

## Sources

- https://github.com/nasa/cFS (README: components, platforms, Apache 2.0, Distro C)
- https://github.com/nasa/cFS/releases (v7.0.1, v7.0.0 Draco, equuleus-rc1)
- https://etd.gsfc.nasa.gov/capabilities/core-flight-system/
- https://software.nasa.gov/software/GSC-18719-1 (cFS Framework)
- https://directory.elisa.tech/workshops/2024-12-Maryland/cFS-Overview-Richard-Landau-NASA.pdf
- https://github.com/nasa/fprime/releases (v4.4.1)
- https://fprime.jpl.nasa.gov/news/2025/08/07/f-prime-v400-released
- https://fprime.jpl.nasa.gov/v4.1.0/Svc/Ccsds/SpacePacketFramer/docs/sdd
- https://fprime.jpl.nasa.gov/devel/Svc/Ccsds/CfdpManager/docs/sdd/
- https://github.com/nasa/nos3 ; https://nos3.readthedocs.io/en/v1_07_03/
- https://ntrs.nasa.gov/citations/20240004699 ; https://ntrs.nasa.gov/citations/20250001688
- https://ntrs.nasa.gov/citations/20240012527 (OnAIR) ; https://ojs.aaai.org/index.php/AAAI/article/view/35156
- https://awesome.ecosyste.ms/projects/140687 (cFS Basecamp index)
- https://releasealert.dev/github/nasa/CryptoLib/collections (CryptoLib, SDLS-EP)
- https://en.wikipedia.org/wiki/CCSDS_File_Delivery_Protocol (727.0-B-5)
- https://github.com/thnkslprpt/CF (cFS CF app, 727.0-B-5)
- https://docs.rs/spacepackets ; https://spacepackets.readthedocs.io/ (133.0-B-2, USLP 732.1-B-2)
- https://www.sanaregistry.org/oid/1.3.112.4.58 (USLP protocol IDs)
- https://ecss.nl/wp-content/uploads/2023/01/ECSS-E-AS-50-22C-Rev.1(13January2023).pdf (SDLS / SDLS-EP adoption)
- https://www.sjac.or.jp/pdf/std/std_uchu/uchu20233.pdf (CCSDS issue list incl. 355.0-B-1)
- https://www.omg.org/spec/XTCE (XTCE 1.3, Jul 2025)
- https://www.iso.org/standard/61742.html (MO MAL, ISO 18202)
- https://public.ccsds.org/Publications/BlueBooks.aspx (authoritative current issues; re-verify)
