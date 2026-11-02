# Changelog

Changes follow Semantic Versioning. The 0.x interface is unstable; minor
versions may introduce breaking changes.

## 0.1.5 — 2026-11-02

- Add server-only `IGNORE_SENDER_FROM=false`; opting in ignores inbound sender
  presence, syntax and equality, including discarded JSON `From` values.
- Preserve outbound sender/status correlation and every other inbound receipt
  requirement. Expose the effective flag in startup, configuration and test data.
- Omit ignored sender payloads from summaries/logs; identify ignored matching in
  `inbound_matched`, and report invalid SID, To and From errors separately.
- Document the full matching contract and cover rewritten/missing senders,
  signatures, held checks, deadline/dedup rules and false-pass prevention.

## 0.1.4 — 2026-11-02

- Accept the requested sender grammar: E.164 or 1–11 ASCII letters/digits and
  `_ . - + * , #`, including numeric-only IDs. Spaces are no longer accepted.
- Preserve sender symbols through outbound encoding and exact webhook matching;
  destinations remain strict E.164, including rejection of trailing newlines.
- Include software/container version, Node version and effective delivery mode
  in `service_started` logs.
- Retain `REQUIRE_DELIVERED_STATUS=false` as the default; add HTTP coverage for
  queued/sent plus inbound receipt and strict mode waiting for `delivered`.

## 0.1.3 — 2026-11-02

- Accept optional `ErrorCode: null` and `ErrorMessage: null` in JSON callbacks;
  these previously caused a `400` before status evidence could be recorded.
- Log rejected webhook requests with safe metadata and reasons, and show remaining
  required evidence in `inbound_matched` events.
- Keep the outbound status callback mandatory, as explicitly confirmed by the user.
- Add regression coverage for a held HTTP check receiving inbound SMS first and
  completing immediately after a status callback with nullable error metadata.
- Document callback diagnosis and CapRover's nginx timeout setting.

## 0.1.2 — 2026-11-02

- Allow `SIGNALWIRE_FROM` to be an E.164 number or alphanumeric sender ID of
  1–11 ASCII letters/digits/internal spaces, including at least one letter.
- Accept alphanumeric `From` in status/inbound callbacks and preserve exact,
  case-sensitive sender correlation. Destinations and allowlists remain E.164.
- Add four regression tests for configuration boundaries, outbound form encoding,
  full signed-form/unsigned-JSON correlation and destination/override restrictions.

## 0.1.1 — 2026-11-02

- Accept flat JSON Compatibility callbacks at both webhook endpoints when
  `SIGNALWIRE_VERIFY_WEBHOOKS=off`, including integer counts and error codes.
- Preserve form callbacks, empty inbound cXML and all body/project/number/deadline
  correlation rules. A plain `Test` message remains unrelated traffic.
- Defer JSON signature work as requested; verification-on JSON requests fail
  closed with `415` and signed form verification remains unchanged.
- Add five mocked parser/HTTP regression tests covering the reported payload shape,
  false-pass prevention, validation and verification-mode behavior.

## 0.1.0 — 2026-11-02

- Add an independent, dependency-free SignalWire Compatibility SMS tester.
- Require generated-body inbound receipt, outbound creation and authenticated
  status evidence; support optional delivered-status enforcement.
- Handle early callbacks, duplicate/late traffic, send ambiguity and bounded waits.
- Add authenticated APIs, destination restrictions, shared cooldown and atomic
  active-test limits, bounded state, redacted rotating event logs and shutdown.
- Add isolated mocked tests, configuration/setup documentation and non-root Docker.
- Pin the security-patched Node 22.23.4/Alpine 3.24 base, update copied runtime
  libraries and retain their package metadata for container scanners.
- Set the release container destination to `schumann/signalwire-sms-tester`.
