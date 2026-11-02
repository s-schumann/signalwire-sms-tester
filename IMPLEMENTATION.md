# Implementation handoff — 2026-11-02

The service described by `HANDOVER.md` is implemented as an independent Node.js
ES module project, initially version **0.1.0**, followed by the **0.1.1** JSON
compatibility and **0.1.2** alphanumeric sender patches. The original handover remains the brief;
`README.md` describes the delivered behavior and operator setup.

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
