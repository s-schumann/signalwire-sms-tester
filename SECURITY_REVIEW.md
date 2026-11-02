# Security review handoff — 2026-11-02

Prepared for an independent Claude Code review of release **0.1.6**, against
baseline `v0.1.5`. This is an audit record and review brief, not a claim that the
application is free of security defects. Final image digests and publication
checks are recorded in `IMPLEMENTATION.md` and the dated evidence directory.

## CVE assessment

The application uses Node built-ins and has no npm runtime or development
dependencies. `npm audit` alone would not assess the shipped Node binary or
copied Alpine libraries, so this audit used image scanners and vendor advisories.

| Component | Installed / decision | Evidence |
| --- | --- | --- |
| Node.js | Keep **22.23.4**; it is the latest 22.x release in the official index checked on 2026-11-02 and includes the October security release | [Release index](https://nodejs.org/dist/index.json), [October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), `node-release-index.json` |
| musl | Keep Alpine **3.24** package **1.2.6-r3** or newer from that branch | [Alpine CVE-2026-107891 tracker](https://security.alpinelinux.org/vuln/CVE-2026-107891), [3.24 secdb](https://secdb.alpinelinux.org/v3.24/main.json), `alpine-secdb.json` |
| Other shipped OS packages | Refresh the build's package installation and rescan `libgcc`, `libstdc++`, and `ca-certificates-bundle` | Raw Trivy reports in the evidence directory |

The baseline Node runtime reports OpenSSL 3.5.9, Undici 6.29.1, c-ares 1.34.9 and
SQLite 3.53.4. The October Node release addresses DNS/TLS, HTTP, Brotli and other
issues, including CVE-2026-105482, CVE-2026-106069 and CVE-2026-111497. Bundled
component versions may include backported patches; correlate them with Node's
security release rather than inferring exposure solely from component numbers.

### Scanner disagreement: CVE-2026-107891

Baseline image index:
`sha256:725fa639788c713a0586796dbfdd8c14b6123cbd9825c9d93838f2dd49202ee6`.

Docker Scout 1.27.0 reports one unscored musl finding, requiring `1.2.6-r6`.
Its reported package is explicitly Alpine 3.24.3 / musl 1.2.6-r3. Alpine's
authoritative tracker and 3.24 secdb both identify **1.2.6-r3 as fixed on 3.24**;
`1.2.6-r6` is the fix revision on **edge**. The finding is therefore triaged as
a distribution-branch mismatch. Do not mix edge packages into the stable image
to satisfy that comparison. No scanner findings are hidden or globally ignored.

Trivy **0.76.1**, with database updated **2026-11-02 13:15:56 UTC**, reports zero
known vulnerabilities in the baseline's four OS packages and application manifest.
Its `node-pkg` result is **signalwire-sms-tester**, not the Node.js executable:
this result must not be described as a complete Node-runtime CVE scan. The runtime
assessment additionally uses the executable's version/component inventory and the
official Node release index/security advisory above.
Final ARM64 and AMD64 reports must be checked independently. This does not cover
unknown CVEs, all possible statically bundled component detection, or application
logic; the manual review and vendor release check complement the scanners.

## Application and image changes

1. **Bound log output under load.** Public webhook traffic could create an
   unbounded promise/write backlog despite bounded recent events and file
   rotation. Pending writes now have a 1 MiB / 1000-event cap, honor stdout
   backpressure, and emit a payload-free `log_dropped` count when capacity returns.
   Overload can lose audit events but cannot alter SMS test evidence or outcomes.
   `flush()` waits for overload diagnostics as well as ordinary writes.
2. **Constrain diagnostic identifiers.** Status `test_id` must be a UUID v4 when
   supplied; arbitrary query text no longer enters unmatched-status diagnostics.
   Message SIDs reject all trailing line terminators and remain bounded to 128
   ASCII letters/digits/underscore/dash. Known-SID fallback without `test_id`
   remains supported; unknown or conflicting IDs never fall back to another run.
3. **Protect application files.** Image source and package metadata are owned by
   root and cannot be written by runtime UID/GID 1000. Only the data directory is
   owned by that user. Smoke tests verify source write denial and mounted writes.
4. **Refresh and rescan packaging.** The current supported Node/base pin remains;
   builds use fresh package installation and final images are scanned per
   architecture. Review evidence is excluded from the Docker build context.

These application hardening changes have no assigned CVE. They must not be
represented as newly discovered upstream CVEs.

## Threat model and intentional configuration

- Operational reads and all SMS sends require the server's API key. Send targets
  are complete E.164 allowlist entries; sender, upstream API, credentials and
  callback URLs are server-controlled. Accepted sends are billable and are never
  retried automatically. Cooldown and active-test slots are reserved before I/O.
- The two public webhook routes enforce project identity, body limits and
  signatures by default. Form HMAC verification uses the project Signing Key,
  exact configured public URL/query and every form field; host/forwarded headers
  cannot select the signed URL. Redirects on authenticated outbound API calls
  are rejected.
- The user currently opts into `SIGNALWIRE_VERIFY_WEBHOOKS=off` for flat JSON
  callbacks. Such callbacks are **not cryptographically authenticated**. This is
  a known deployment risk, not equivalent to signature verification. Verified
  JSON is unimplemented and fails closed with 415; changing this needs a verified
  provider JSON-signing contract. Report residual risk explicitly.
- `IGNORE_SENDER_FROM=true` deliberately skips only inbound sender validation and
  equality. It does not skip the exact UUID/nonce body, receiver To, project,
  SID/dedup, direction/media, deadline or active-state requirements. Ignored From
  is not retained. Outbound status sender/SID matching remains strict.
- Success still requires API creation, a recognized outbound callback and exact
  inbound receipt. `REQUIRE_DELIVERED_STATUS=true` additionally requires delivered.
  Failure states fail the run; finished outcomes are immutable. A status payload
  carrying Body never satisfies inbound receipt.
- Deploy one process/replica. State is in memory; JSONL is an audit log and is not
  replayed as authoritative state. Data-directory permissions, ingress access
  control/rate limits, TLS termination and secret handling are deployment concerns.
- The provider's approved callback proxy is configured using
  `SIGNALWIRE_STATUS_WEBHOOK_URL`; it must forward POST body, query (`test_id`) and
  signature headers. Live proxy configuration and a full real SMS/status test
  have not been established by this security audit.

## Reproduction and review commands

Use a supported patched Node runtime and **never source a live `.env`** for tests:

```sh
npm run check
npm test
git diff v0.1.5..v0.1.6 -- src test Dockerfile scripts

docker build --pull --no-cache --platform linux/arm64 -t signalwire-sms-tester:local .
docker build --pull --no-cache --platform linux/amd64 -t signalwire-sms-tester:local-amd64 .
node scripts/container-smoke.js signalwire-sms-tester:local
node scripts/container-smoke.js signalwire-sms-tester:local-amd64
```

The smoke script uses a synthetic service key and no provider credentials. It
checks non-root execution, read-only application files, authenticated reads,
health, persistent mounted logs, HTTPS to nodejs.org, no shell and SIGTERM exit 0.
AMD64 checks on the preparing ARM64 host run under emulation.

Scanner used: `aquasec/trivy:0.76.1` at immutable index digest
`sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c`.
Use that image's `image --image-src remote --platform linux/arm64 --scanners vuln
--format json` command against the final immutable release digest, and repeat
for AMD64. Docker Scout's complementary command is:

```sh
docker scout cves --platform linux/arm64 --format sarif \
  --output scout-arm64.sarif.json registry://schumann/signalwire-sms-tester:0.1.6
```

Raw baseline/final reports and tool metadata are in
[`security/review-2026-11-02/`](security/review-2026-11-02/). Secret scanning uses
only a Git-exported source snapshot and history patch, never the working tree's
untracked environment files. Inspect its redacted summary, not raw secret values.

## Independent reviewer focus

Review authentication/signature bypasses, alias/repeated-parameter ambiguity,
body/SID correlation and early-event races, parser/regex boundary cases, public
webhook resource exhaustion, secret disclosure, log saturation/backpressure,
provider request SSRF/redirect/timeout handling, and container file ownership.
Recheck failure/timeout immutability and the two intentionally weaker deployment
options above. Treat scanner disagreements as claims to verify with vendor data.

Use synthetic reproductions for findings. Provide exact source lines, realistic
preconditions and impacts, and distinguish mock/container checks from real-route
verification. Do not publish changes, use live credentials, or contact
provider/deployment APIs during review. Advisory/database downloads and the
documented nodejs.org certificate probe are permitted.

A Claude Code review has **not yet been run**. Suggested initial prompt:

> Read CLAUDE.md and SECURITY_REVIEW.md. Independently review the source and the
> security changes since v0.1.5. Return actionable findings with severity,
> file/line, a synthetic reproducer and mitigation; then list residual risks and
> verification gaps. Do not read live environment files or perform live SMS calls.
