# CyberTiger Compliance Baseline

## Scope and Disclaimer

This baseline documents **technical control alignment** for the CyberTiger daemon integration in this repository.
It is **not a formal certification** of compliance with NIST, ISO/IEC 27001, or space-mission frameworks.
Formal conformity requires organizational policy, governance evidence, independent assessment, and audit artifacts.

## Implemented Countermeasures (Code)

- Access control and RBAC (`viewer`, `operator`, `admin`) through Supabase auth metadata.
- Security middleware for API requests:
  - request inspection
  - signature detection
  - IP-based rate limiting
  - automatic temporary IP blocking
- Security event/audit trail:
  - authorization failures
  - block/unblock actions
  - high-risk request signatures
- Administrative counter-actions:
  - blocklist and unblock API endpoints for admins
- Security headers:
  - `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`

## NIST/ISO/Space Mapping

### NIST Cybersecurity Framework (CSF 2.0)

- `PR.AA` (Identity management, authentication, authorization):
  - enforced RBAC + authenticated API boundary.
- `PR.PS` (Platform security):
  - hardening headers and request controls.
- `DE.CM` (Continuous monitoring):
  - event stream and daemon status telemetry.
- `RS.AN` / `RS.MI` (Response analysis/mitigation):
  - automatic and manual IP blocking workflows.

### NIST SP 800-53 Rev. 5 (selected controls)

- `AC-2` / `AC-3`: account and access enforcement via role-gated endpoints.
- `AU-2` / `AU-6`: audit event generation and operational review APIs.
- `IA-2`: token-based user authentication.
- `SC-7`: boundary protection through request filtering and rate limiting.
- `SI-4`: monitoring and detection of suspicious request signatures.
- `IR-4`: response actions (auto-block/manual block).

### ISO/IEC 27001:2022 Annex A (selected controls)

- `A.5.15` Access control.
- `A.5.16` Identity management.
- `A.8.15` Logging.
- `A.8.16` Monitoring activities.
- `A.8.20` Network security.

### Satellite and Space Cybersecurity Guidance

- `NISTIR 8270` (Introduction to Cybersecurity for Commercial Satellite Operations).
- `NISTIR 8401` (Satellite Ground Segment: Applying the Cybersecurity Framework to Assure Satellite Command and Control).
- `NISTIR 8441` (Satellite Cybersecurity Risk Assessment).
- `ECSS-E-ST-80C` (Space engineering - Software product assurance).

## Gaps to Close for Full Assurance

- Cryptographic key rotation enforcement and secure secret storage attestation.
- Vulnerability management/SBOM workflow tied to release gates.
- Incident response runbooks with operational ownership and SLA evidence.
- Secure software supply-chain controls and signed artifact provenance.
- Space-link specific protections (TT&C command authentication, anti-spoof controls, link-level crypto verification).

## Evidence Pointers

- `/Users/josh/Documents/lightbound/Gauss/Gauss Aurora V0.1/backend/cybertiger/daemon.ts`
- `/Users/josh/Documents/lightbound/Gauss/Gauss Aurora V0.1/backend/server.ts`
- `/Users/josh/Documents/lightbound/Gauss/Gauss Aurora V0.1/backend/scripts/security-compliance-check.ts`

## Reference Sources

- NIST CSF 2.0: https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20
- NIST SP 800-53 Rev. 5 family: https://csrc.nist.gov/pubs/sp/800/53/a/r5/final
- NISTIR 8270: https://csrc.nist.gov/pubs/ir/8270/final
- NISTIR 8401: https://csrc.nist.gov/pubs/ir/8401/final
- NISTIR 8441: https://csrc.nist.gov/pubs/ir/8441/final
- ISO/IEC 27001:2022: https://www.iso.org/standard/27001
- ECSS-Q-ST-80C Rev.2: https://ecss.nl/standard/ecss-q-st-80c-rev-2-software-product-assurance-30-april-2025/
