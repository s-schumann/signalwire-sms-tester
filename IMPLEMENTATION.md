# Implementation handoff — 2026-11-02

The service described by `HANDOVER.md` is implemented as an independent Node.js
ES module project, initially version **0.1.0**, followed by the **0.1.1** JSON
compatibility and **0.1.2** alphanumeric sender patches. The **0.1.3** callback
parsing/diagnostics patch is described below. The original handover remains the
brief; `README.md` describes the delivered behavior and operator setup.

## Delivered

- Dependency-free Compatibility Messages API creation with bounded transport and
  response reads, no redirects/retries, safe errors and uncertain-outcome labels.
- Authenticated test/check/raw-send/inspection APIs, complete destination matching,
  fixed provider configuration, shared cooldown and atomic active-test reservation.
- Separate project-aware signed inbound/status webhooks. Exact generated body,
  numbers and deadline are required for receipt; status Body never proves receipt.
- Early callback staging/reconciliation, duplicate handling, immutable terminal
  results, expiry without polling, optional delivered requirement and explicit
  failed/undelivered outcomes.
- Independent HTTP wait budgets, disconnect cleanup and continued tracking of
  accepted sends. Diagnostic raw bodies cannot replay the reserved test format.
- Bounded records/deduplication/event references, temporary-test isolation,
  redacted serialized rotating JSONL logs and bounded signal shutdown.
- Configuration template, API/provider/monitor setup, scratch Docker deployment,
  smoke-test script, MIT license, agent guidance and release conventions.

## Verification actually completed

| Check | Result |
| --- | --- |
| `npm run check` | Passed on local Node 24.22.2 |
| `npm test` | **40/40 passed**, local Node 24.22.2 |
| Same mocked suite in original local container | **40/40 passed**, Node 22.22.3, source mounted read-only with temporary `/tmp`; refreshed release validation is recorded below |
| `docker build --platform linux/arm64` | Passed; local image `signalwire-sms-tester:local` |
| `docker build --platform linux/amd64` | Passed; local image `signalwire-sms-tester:local-amd64` |
| ARM64 smoke test | Passed natively on the local Docker ARM64 host |
| AMD64 smoke test | Passed under local Docker emulation; not a native x64 host test |
| Live SignalWire SMS | **Not performed**; no real credentials/numbers/receiver setup supplied |

Both scratch images ran Node 22.22.3 as UID/GID 1000:1000. Smoke validation checked
unconfigured-provider `/health`, authenticated `GET /`, unauthenticated rejection,
the actual shell-free Docker healthcheck command, named-volume writes, persisted
JSONL across a second container, absence of `/bin/sh`, validated HTTPS access to
nodejs.org, SIGTERM exit 0 and absence of send events. Smoke containers and their
temporary volumes were removed. Local images remain available; nothing was pushed.

The mocked tests use no live `.env`, real provider transport or SMS. They cover
body/number/project mismatches, status-only false-pass prevention, callbacks in
both orders and before the API response, strict delivery, explicit failures,
SID conflicts, deadlines/late traffic, old tokens, duplicates, separate receiver
keys, fixed/encoded callback URLs, both signature headers and a fixed independent
signature vector. They also exercise API validation, no-send-on-rejection,
concurrency/cooldown, short waits during/after creation, client disconnect,
provider ambiguity/timeouts, bounded retention, redaction/rotation and empty cXML.

## Remaining operator acceptance

1. Fill `.env` with a strong service key, outbound project/Messaging-scoped token,
   project Signing Keys, owned distinct SMS-capable A/B numbers, allowlist and
   reachable canonical HTTPS URLs. Verify route/account eligibility.
2. Expose the service and configure B's **messaging Compatibility/cXML POST**
   handler to the exact inbound URL. Record the dashboard labels/settings used.
   A separate receiver project needs its own ID/Signing Key, not an API token.
3. Run one manual SMS test without automatic retries. Verify distinct outbound
   and inbound SIDs, exact body/A/B, valid signatures, outbound status, `ok:true`
   and no missing evidence. This actual route remains unverified by mocks.
4. Configure the external monitor with header authentication, five-minute initial
   interval, retries off and sufficient HTTP/proxy timeout. Use `/health` for probes.

One process/replica is required. In-memory state is lost at restart; JSONL is only
an audit log. Deploy between checks and persist `/app/data`. The remaining live
check proves only this configured SignalWire A-to-B path.

## Initial release preparation

The user authorized Docker Hub publication to
`schumann/signalwire-sms-tester`. Release `0.1.0` uses local Git tag `v0.1.0`,
with image aliases `0.1.0`, `v0.1.0`, `latest` and the full release commit SHA.
The release targets Linux AMD64 and ARM64, with SBOM and max-mode provenance.

Before publication the Docker base was changed from the previously tested
Node 22.22.3 image to security-patched **Node 22.23.4 / Alpine 3.24**, pinned at
`sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`.
Runtime musl/C++/certificate libraries are upgraded before copying, and the
final image retains OS/library package metadata for container scanners.

Release validation passed: syntax checks and 40/40 mocked tests on local
Node 24.22.2 and the updated Node 22.23.4 container runtime. Rebuilt Linux ARM64
and AMD64 candidates passed the full existing container smoke script (AMD64
under emulation), including HTTPS validation, UID/GID, healthcheck, mounted log
persistence and clean shutdown. No live provider configuration was used.

The repository still has no remote/CI platform configured; publishing the
container does not push the Git source. No provider provisioning, live SMS sends
or phone-number changes are part of publication. Calling-project compatibility
was checked against its template/source, without reading or copying its live
`.env`; the exact migration differences are now in `README.md`.

## Publication verified — 0.1.0

Published to Docker Hub on 2026-11-02:

- Repository: `schumann/signalwire-sms-tester`
- Release source commit: `a808039ca3e878ff2c70a63ff663365b319fd573`
- Local Git release tag: `v0.1.0`
- Image aliases: `0.1.0`, `v0.1.0`, `latest`, and the full source commit SHA
- Shared image index digest:
  `sha256:9fca65b0e1e955939653a5958a84890cc7c60790fb7099acacc74b82544dde9f`
- Platforms: `linux/amd64` and `linux/arm64`
- Both architecture attestations contain SBOM and provenance; publication used
  `--provenance=mode=max --sbom=true` in one Buildx invocation for all aliases.

Registry inspection confirmed that all four aliases resolve to the same index.
The actual published ARM64 image and AMD64 image were pulled by immutable digest
and both passed the container smoke script (AMD64 under local emulation).
Both run Node 22.23.4 and retain the tested non-root, HTTPS, liveness,
authenticated read, mounted log persistence and clean shutdown behavior.

The release evidence above is a post-publication documentation update; the
immutable release tag and image continue to identify source commit `a808039`.
No Git source was pushed and no live SMS was sent.

## JSON compatibility patch — 0.1.1

The running deployment receives Compatibility fields as JSON. Per the user's
instruction, JSON parsing is added for the existing explicit verification-off
setting; JSON signing is deferred. Both inbound and outbound status routes accept
flat JSON, retain form support, and preserve the existing project/number/body,
media, deadline, deduplication and terminal-state checks. JSON with verification
on fails closed with `415`; signed form verification remains available.

The reported payload shape is covered with synthetic numbers/IDs in tests.
Unrelated `Body: "Test"` receives empty cXML but cannot pass a test. Only the
server-generated unique body can match. Counts and error codes may be integer
JSON values; other fields must be strings. Malformed/oversized/unsupported
payloads retain the existing error status behavior.

Syntax checks and all **45** mocked tests passed on local Node 24.22.2 before
release preparation. Publication continues to target the authorized
`schumann/signalwire-sms-tester` repository. No live SMS is sent during checks.

The **0.1.1** patch is published and verified:

- Release source/tag: `3cb1c6b7c696fa3312aeb884c693d3223bb5745c` / `v0.1.1`.
- Aliases `0.1.1`, `v0.1.1`, `latest` and the full SHA all resolve to
  `sha256:021a2b07d978833a46ec7eb7f791e97f1c4d5814f85a0a871364f60635007712`.
- Linux AMD64 and ARM64 are present, each with SBOM/provenance attestations.
- All 45 mocked tests also pass on the Node 22.23.4 container runtime. Both
  rebuilt architecture candidates pass the existing health/HTTPS/authentication,
  persistent-log and shutdown smoke script (AMD64 under emulation).
- Both actual published images were pulled by immutable digest. A separate
  external-network-disabled probe started their real server entry point with
  verification off, posted the reported flat JSON shape with synthetic IDs and
  numbers, verified empty XML acknowledgment, no created test/pass and clean
  shutdown. These are container/application checks, not live SMS verification.

Redeploy using `schumann/signalwire-sms-tester:0.1.1` (or pull/recreate `latest`),
keep the user's explicit `SIGNALWIRE_VERIFY_WEBHOOKS=off`, then start a fresh
round-trip check so the received SMS contains its generated correlation body.
JSON signing remains deferred. The Git remote is still unset; no source push,
provider resource change or live SMS send was performed by this patch release.

## Alphanumeric sender patch — 0.1.2

The user requested alphanumeric `SIGNALWIRE_FROM` support. Configuration and
both webhook routes now accept an E.164 phone sender or a 1–11 character ASCII
sender ID containing letters, digits and internal spaces, with at least one
letter. Sending preserves the exact configured ID; inbound/status correlation
remains case-sensitive and exact. `to`, `DEFAULT_TO` and allowlist entries stay
strict E.164, and callers still cannot override the configured sender.

Syntax checks and all **49** mocked tests passed locally on Node 24.22.2,
including signed form and verification-off JSON flows using an alphanumeric
sender. Wrong case, prefixes and alternate numeric senders cannot satisfy
receipt evidence. Existing JSON verification-off behavior is retained; JSON
signing remains deferred as requested. No live sender-ID route has been tested.

The **0.1.2** patch is published and verified:

- Source/tag: `51a59291b4a6b14a7bdf83c7e3b280fa399f505b` / `v0.1.2`.
- Aliases `0.1.2`, `v0.1.2`, `latest` and the full SHA resolve to
  `sha256:e9b98a4486fdbdefde0bc16112907f1ac62cb653a1401c8fc60eb12976b6a18f`.
- Linux AMD64/ARM64 manifests and both SBOM/provenance attestations are present.
- All 49 mocked tests also pass on Node 22.23.4 in the container. Both architecture
  candidates pass the existing health, HTTPS, auth, log persistence and shutdown
  checks (AMD64 under emulation).
- Both published images were pulled by immutable digest and tested with external
  networking disabled. Their real server entry point sent `From=My Brand2` to a
  local fake provider, accepted matching JSON status/inbound evidence, rejected
  mismatched-case receipt evidence, returned a complete mocked round-trip pass,
  and refused alphanumeric destinations without a second provider request.

Redeploy `schumann/signalwire-sms-tester:0.1.2` and set `SIGNALWIRE_FROM` to the
desired valid sender ID. The user's existing JSON verification-off setting is
retained. No live SMS or provider resource change was performed, and Git source
has not been pushed to any remote.

## Status callback parsing and diagnostics — 0.1.3

Live read-only inspection confirmed a pending test with creation and inbound
evidence present but `signalWireStatus` absent; it then expired specifically for
that missing callback. A local held-request reproduction returned immediately
once a matching mocked status callback arrived. The user explicitly chose to
keep the outbound status callback required; no completion criterion was relaxed.

The JSON normalizer had a reproducible compatibility issue: optional
`ErrorCode: null` / `ErrorMessage: null` caused HTTP 400 before status evaluation.
These fields now normalize to empty error metadata, while required fields stay
strict. It is not confirmed that these null fields were present in the user's
actual gateway callback; the deployed callback payload was not available.

Previously, webhook HTTP validation failures did not appear in event logs.
`webhook_rejected` now records route, HTTP code, safe reason and recognized
metadata without raw payloads, secrets or query values. `inbound_matched` includes
the remaining `missing` evidence, making a receipt-only pending run explicit.

Syntax checks and all **52** mocked tests pass on local Node 24.22.2, including
the inbound-first held JSON request, nullable status metadata, mandatory status
requirement and secret-free rejection logging. Browser access was stopped at
the user's request; further work uses source and existing logs. No provider or
CapRover settings were changed, and no live SMS was sent by this patch work.

The **0.1.3** patch is published and verified:

- Source/tag: `2ea77e37da6c031c8cf6e09517a64a86e59695d7` / `v0.1.3`.
- Aliases `0.1.3`, `v0.1.3`, `latest` and the full source SHA resolve to
  `sha256:5080bb6d5aff7680b7e868fcb7e725e54aca4d25e2f1997c250b96609b4a858a`.
- Linux AMD64/ARM64 manifests and both SBOM/provenance attestations are present.
- All **52** mocked tests also pass on the Node 22.23.4 container runtime. Both
  architecture candidates pass health, HTTPS certificate, authentication,
  non-root mounted write, log persistence and clean shutdown checks; AMD64 runs
  under emulation.
- Both published images were pulled by immutable digest and checked with
  external networking disabled. Their real server entry point sends to a local
  fake provider, remains pending after inbound receipt alone, then immediately
  returns HTTP 200 to the held client after matching status with nullable error
  metadata. Rejected-project callbacks produce safe diagnostic events.

Redeploy `schumann/signalwire-sms-tester:0.1.3` in CapRover and start a fresh
round-trip test. If status evidence remains missing, inspect `webhook_rejected`,
`status_received` and `status_unmatched` events and the gateway's callback
delivery attempt. The production callback failure is not yet confirmed fixed.
Browser access remains stopped, no deployment/provider settings were changed,
and no Git source was pushed to a remote.

## Sender symbols and startup version — 0.1.4

The sender validator now follows the user's requested E.164-or-sender-ID
pattern. IDs allow 1–11 ASCII letters/digits and `_ . - + * , #`, including
numeric-only and symbol-only values; spaces are no longer accepted. Outbound
form encoding preserves the sender exactly, and both webhook routes retain
case-sensitive exact correlation. Destination validation remains E.164-only
and now also explicitly rejects trailing line terminators.

`service_started` now logs `version` from `package.json` (the container release
version), `nodeVersion` and the effective `requireDeliveredStatus` setting next
to the existing port/verification fields. The container smoke test verifies the
startup metadata in persisted logs against the image's own package/runtime.

The user confirmed the existing `REQUIRE_DELIVERED_STATUS` flag covers optional
delivery reports. Its evaluator/default are unchanged: `false` accepts creation,
a recognized outbound status callback and matching inbound receipt; `true` also
requires a matching `delivered` callback. Added mocked HTTP coverage verifies the
held client completes in both modes at the appropriate evidence transition.

Syntax checks and all **54** mocked tests pass on local Node 24.22.2. The initial
sandbox test attempt could not bind loopback ports (`EPERM`); rerunning with
local socket access passed. Tests never load live `.env` or contact a provider.
Browser access remains stopped. Publication uses the previously authorized
`schumann/signalwire-sms-tester` repository; no provider/deployment setting is
changed and no live SMS is sent by these checks.

The **0.1.4** patch is published and verified:

- Source/tag: `ac0aa7bc182966001419e02cebdc1b4deb42a3c5` / `v0.1.4`.
- Aliases `0.1.4`, `v0.1.4`, `latest` and the full source SHA resolve to
  `sha256:7dfd568d23ef40b97abd45758faa1817e0d55924023641cd38e9023ce510fbf2`.
- Linux AMD64/ARM64 manifests and both SBOM/provenance attestations are present.
- All **54** mocked tests also pass on container Node 22.23.4. Both architecture
  candidates pass the scratch runtime, HTTPS, authentication, mounted writes,
  versioned persistent startup log and clean shutdown checks; AMD64 uses emulation.
- Both published images were pulled by immutable digest. With external networking
  disabled, their real server reports version `0.1.4`, preserves `A_.-+*,#9` through
  a fake provider request and exact-case webhook correlation, and returns the held
  client HTTP 200 after receipt in default mode or after the additional delivered
  callback in strict mode. Startup metadata matches each mode and runtime.

Redeploy `schumann/signalwire-sms-tester:0.1.4` in CapRover; the next
`service_started` line identifies the release. No CapRover/provider setting was
changed, no Git source was pushed and no live SMS was sent by the release checks.

## Inbound sender opt-out — 0.1.5

The user reported a rejected inbound callback and confirmed that sender-ignore
behavior must apply only to inbound matching. `IGNORE_SENDER_FROM` defaults to
`false`; `true` skips inbound `From` presence, syntax and equality checks. JSON
discards that field before normalization; signed forms preserve it for complete
signature verification. Ignored sender data is never retained in message
summaries or logs. The effective flag is exposed in configuration, startup and
each test; `inbound_matched` records `senderFromIgnored`.

The exact generated body (UUID plus nonce), receiving To, inbound project,
signature when enabled, valid SID/deduplication, direction/media rules, deadline
and active-state requirements remain mandatory. The outbound configured sender
and status matching are unchanged, and a pass still needs API creation plus a
recognized status callback (and delivered only when separately configured).
The README now contains the full inbound matching table and outbound criteria.
Validation errors distinguish invalid SID, To and From without logging payloads.

Syntax checks and all **59** mocked tests pass on local Node 24.22.2, covering
signed-form/JSON held checks, missing/rewritten sender forms, field validation,
signature preservation, unchanged outbound matching, deadlines, deduplication,
terminal immutability, secret-free bounded summaries and per-request override
rejection. No live `.env`, provider request or SMS was used. Browser access
remains stopped; publication uses the previously authorized container repository.

The **0.1.5** patch is published and verified:

- Source/tag: `b68852212d5e23830d54fd4c83496d3e2b205752` / `v0.1.5`.
- Aliases `0.1.5`, `v0.1.5`, `latest` and the full source SHA resolve to
  `sha256:725fa639788c713a0586796dbfdd8c14b6123cbd9825c9d93838f2dd49202ee6`.
- Linux AMD64/ARM64 manifests and both SBOM/provenance attestations are present.
- All **59** mocked tests also pass on container Node 22.23.4. Both architecture
  candidates pass runtime, HTTPS certificate, authentication, mounted write,
  versioned startup/log persistence and shutdown checks; AMD64 uses emulation.
- Both published images were pulled by immutable digest. Their real server was
  checked with external networking disabled and a local fake provider: default
  mode rejects rewritten inbound sender syntax, opt-out mode accepts it, and
  both preserve outbound sender, exact body and receiving To checks. Held checks
  return HTTP 200 after complete evidence; startup reports the effective flag and
  ignored sender payloads are absent from summaries/logs.

Redeploy `schumann/signalwire-sms-tester:0.1.5` with `IGNORE_SENDER_FROM=true` in
CapRover to permit inbound sender rewriting. The default stays `false`. No
deployment/provider setting was changed, no live SMS was sent and no Git source
was pushed by these release checks.
