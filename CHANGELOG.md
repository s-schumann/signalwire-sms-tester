# Changelog

Changes follow Semantic Versioning. The 0.x interface is unstable; minor
versions may introduce breaking changes.

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
