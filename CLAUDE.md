# Security review entry point

Read `AGENTS.md`, `README.md`, and `SECURITY_REVIEW.md` before reviewing or changing
this service. `SECURITY_REVIEW.md` describes the 2026-11-02 audit, reproduction
commands, scanner evidence, threat boundaries and remaining deployment questions.

Perform an independent review of the current source and the changes since
`v0.1.5`. Distinguish confirmed application defects, vendor-patched CVEs, scanner
disagreements and configuration risks. Report findings first, with severity,
exact file/line, a practical trigger, impact, and a focused mitigation/test.
Do not claim a vulnerability from a version string alone when the distribution
has backported its fix. Do not assume the existing audit found everything.

Use explicit synthetic configuration, temporary log directories and mocked
provider transport. Never load a live `.env`, send an SMS, replay captured live
webhooks, change provider/proxy/CapRover settings, or publish changes as part of
the review. Preserve the user's current JSON/verification-off and inbound-only
sender-ignore options while reporting their security implications.

No runtime npm dependencies are used. `npm run check` and `npm test` are the
default local checks. Container checks and scanner commands are documented in
`SECURITY_REVIEW.md`; they need Docker and some need network access.

The handoff is prepared for Claude Code; a Claude Code review has not yet been
performed by the preparing agent.
