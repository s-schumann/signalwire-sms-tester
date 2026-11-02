# SignalWire SMS tester

Read `README.md` and `HANDOVER.md` before changing behavior. Node.js >=22.23.4,
ES modules, built-ins only. `package.json` is the version source.

- Run `npm run check` and `npm test`. Tests use isolated temporary logs,
  explicit configuration, injected provider fetch and clocks. Never load a live
  `.env` or send an SMS in automated tests.
- A pass needs API creation, a verified outbound status callback, and the exact
  unique body received through the verified inbound webhook. DLR alone cannot pass.
- Keep exact sender identity matching (E.164 or sender ID), strict E.164
  destination allowlists, fixed sender,
  provider-controlled configuration, deadline enforcement and immutable terminal
  outcomes. Preserve early-callback handling and separate inbound/outbound SIDs.
- Never retry message creation automatically. All send endpoints consume the
  global cooldown; reserve concurrency before awaiting network I/O.
- Webhooks use project Signing Keys, never API tokens. Do not trust Host/forwarded
  headers or disable verification because a proxy/callback URL changes.
- Per the user's temporary setup, flat JSON webhooks are accepted only when
  verification is explicitly off. Keep signed form support intact and JSON
  fail-closed with verification on until JSON signing is implemented separately.
- Keep state, evidence, deduplication and logs bounded. Do not log arbitrary SMS
  bodies, credentials, signatures or upstream error payloads.
- Single process/replica; events.jsonl is an audit log, not restored state.
- Conventional Commits, SemVer `vX.Y.Z`, release-only `latest`. Do not push,
  publish containers or configure provider resources without user authorization.
- Validate scratch image libraries, certificates, non-root mounted writes,
  liveness and signal shutdown on each release architecture.
