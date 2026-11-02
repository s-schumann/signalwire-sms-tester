# Agent handover: SignalWire SMS round-trip tester

## Assignment

Build a small, independently deployable **SMS tester in a new repository**, provisionally named `signalwire-sms-tester`. This document is the complete implementation brief; access to the original calling repository is not required.

The user confirmed the receiving endpoint is **another SignalWire SMS-enabled phone number**. Send an SMS from SignalWire number A to SignalWire number B, receive the actual SMS content through B's inbound messaging webhook, and correlate it with the originating test using a unique value in the SMS body. Expose a monitor-friendly pass/fail result and provide Docker deployment comparable to the existing calling tester.

Use a separate repository, image, configuration, and release history. Calling and SMS may be deployed independently. Do not add voice or Placetel integration, an SMS echo/reply service, a dashboard, or an internal scheduler to the initial implementation. Regular testing will be driven by an external HTTP monitor such as Uptime Kuma.

This brief describes work to implement. It does not assert that the SMS service, container, or real SMS route has already been tested. Live credentials and phone numbers must be supplied separately; none are included here.

## Reference project and what to retain

The calling project was reviewed at release `0.1.1`, commit `3ec9a7c`, on 2026-11-02. It is a dependency-free Node.js ES module service using `node:http`, built-in `fetch`, `node:crypto`, and Node's test runner. It loads a root `.env` without overwriting existing environment variables, keeps current state in memory, appends events to `data/events.jsonl`, and exposes asynchronous tests plus a synchronous check for uptime monitors.

Retain these useful conventions:

- `src/server.js` entry point; `npm start`, `npm test`; port `3000`; host `0.0.0.0`.
- Self-documenting JSON at `GET /`, lightweight public `GET /health`, authenticated operational APIs, and provider-authenticated public webhooks.
- Test records with `status`, `ok`, `reason`, an expected-evidence checklist, missing evidence, timestamps, and diagnostic events.
- Header-only API authentication, server-controlled provider credentials and URLs, bounded HTTP bodies and timeouts, destination restrictions, and redacted logs.
- Non-root Docker runtime, mounted event logs, SemVer releases, Conventional Commits, and release-only `latest` image tags.

Adapt the architecture rather than copying the call evaluator. The call service accepts several terminal voice outcomes, including `busy` and `failed`, as callback evidence. **SMS `failed` and `undelivered` are failures.** A delivery report alone must never pass an SMS round-trip test. Also avoid the call service's permissive phone suffix matching, automatic signature bypass for callback URL overrides, unbounded state maps, and the possibility of late events changing a finished result.

## What the test proves

```text
External monitor / API caller
        |
        v
SMS tester creates test and unique text
        |
        v
SignalWire outbound Messages API -- SMS --> SignalWire receiving number B
        |                                          |
        | outbound status webhook                  | inbound SMS webhook
        v                                          v
/webhooks/signalwire/status              /webhooks/signalwire/inbound
        |                                          |
        +------------> correlate and evaluate <----+
```

"Round trip" means outbound send followed by receipt of that text at this service through B's webhook. No second SMS reply is needed. Outbound and inbound message SIDs are separate identifiers and must not be assumed equal.

Numbers A and B must be different, controlled by the operator, and provisioned for SMS on the intended route. Voice capability alone is insufficient. Confirm both numbers' messaging permissions and applicable account/destination requirements before a live smoke test. SignalWire's [sending guide](https://signalwire.com/docs/compatibility-api/guides/send-sms) covers SMS-capable numbers and credentials.

This checks the configured A-to-B SignalWire path. Do not claim it proves delivery to a physical handset or traversal of an independent mobile carrier without establishing that routing separately.

## Implementation layout and runtime

Use Node.js **22 or newer**, ES modules, and no npm runtime dependencies unless a concrete requirement warrants one. The reference container uses Node 22; check supported base image versions when implementing and update the runtime requirement and image together if needed.

Create these files in the new repository:

```text
package.json
src/server.js           HTTP routes, parsing, auth, synchronous waiting, lifecycle
src/config.js           .env loading, normalization, configuration validation
src/signalwire.js       Compatibility API SMS creation; injectable fetch
src/signature.js        Compatibility form-webhook signature validation
src/store.js            tests/messages/events, correlation, deadlines, evaluation
src/xml.js              empty messaging cXML acknowledgement
src/logger.js           safe structured interaction logs
scripts/check.js        dependency-free syntax checks
test/config.test.js
test/signalwire.test.js
test/signature.test.js
test/store.test.js
test/server.test.js
test/xml.test.js
.env.example
.gitignore
.dockerignore
Dockerfile
README.md
AGENTS.md
CHANGELOG.md
LICENSE
```

Use this package shape, with an initial independent version:

```json
{
  "name": "signalwire-sms-tester",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test",
    "check": "node scripts/check.js"
  },
  "engines": { "node": ">=22" }
}
```

Implement `scripts/check.js` using Node built-ins to enumerate project JavaScript files and run `node --check` on them, propagating failures. Keep source attribution and license notices if source is copied. Do not invent ownership details for the new repository.

Export an app factory such as `createApp(config, store, { fetch, now })`. Keep network listening behind the executable entry-point guard. Tests must supply isolated configuration, a temporary log directory, mocked HTTP transport, and a controllable clock; they must never read live `.env` or send real SMS.

## Configuration contract

Create a commented `.env.example` from this template. All values below are placeholders, including the phone numbers; replace them with SMS-capable numbers owned by the operator.

```dotenv
PORT=3000
HOST=0.0.0.0
API_KEY=
PUBLIC_BASE_URL=https://sms-tester.example

SIGNALWIRE_BASE_URL=https://your-space.signalwire.com/api/laml/2010-04-01
SIGNALWIRE_PROJECT_ID=your-outbound-project-id
SIGNALWIRE_TOKEN=your-messaging-api-token
SIGNALWIRE_SIGNING_KEY=your-outbound-project-signing-key
SIGNALWIRE_FROM=+12025550100
DEFAULT_TO=+12025550101
ALLOWED_TO_NUMBERS=+12025550101

# Optional externally visible URLs, including any reverse-proxy path prefix.
# Blank uses PUBLIC_BASE_URL plus the corresponding service route.
SIGNALWIRE_STATUS_WEBHOOK_URL=
SIGNALWIRE_INBOUND_WEBHOOK_URL=

# Blank means the receiving number belongs to the outbound project.
SIGNALWIRE_INBOUND_PROJECT_ID=
# Blank may reuse SIGNALWIRE_SIGNING_KEY only when projects are the same.
SIGNALWIRE_INBOUND_SIGNING_KEY=

# on | off; default on. off is explicitly for isolated development/tests.
SIGNALWIRE_VERIFY_WEBHOOKS=on
TEST_TIMEOUT_MS=120000
SIGNALWIRE_REQUEST_TIMEOUT_MS=10000
REQUIRE_DELIVERED_STATUS=false
MAX_ACTIVE_TESTS=1
MIN_SEND_INTERVAL_MS=60000
DATA_DIR=./data
```

Configuration behavior:

- Load `.env` from the repository root, independent of the shell working directory. Existing environment variables win. Empty values, quotes, comments, booleans, integers, and invalid values need deliberate handling.
- Validate configured numbers as canonical E.164. Require a nonempty destination allowlist for send endpoints and compare complete canonical numbers; do not use suffix matching or implicitly assume a country.
- Fix `from` to `SIGNALWIRE_FROM`; the API caller may select only an allowed `to`. Reject A-to-A tests. Every allowed destination used for tests must be wired to the receiving webhook.
- `PUBLIC_BASE_URL` is the canonical external service origin. Explicit webhook URLs describe the public URLs SignalWire actually requests; they do not automatically configure the receiving number.
- Provider credentials, API base, sender, callback URLs, and security settings come only from server configuration. Reject request fields attempting to override them.
- Require valid send configuration and usable receiver signature configuration before sending. Missing configuration returns a safe `400` with variable names; missing `API_KEY` disables sending with `503`. Health must still work without provider credentials.
- Use the inbound project/key for B's webhook. If B is in another project, require its own project ID and signing key. No receiving-project API token is needed merely to verify inbound webhooks.
- Invalid verification modes must fail configuration validation. `on` with missing signing configuration must fail closed; URL overrides must never silently disable verification.
- Validate time settings as finite positive integers. Cap per-test and HTTP wait timeouts at `600000` ms. Invalid client values return `400`; values above the cap are clamped and the effective value is returned.

## Sending through SignalWire

Use the **Compatibility API**, keeping the form-encoded/SID-based integration familiar. Send:

```text
POST {SIGNALWIRE_BASE_URL}/Accounts/{SIGNALWIRE_PROJECT_ID}/Messages
Authorization: Basic base64(project_id:api_token)
Content-Type: application/x-www-form-urlencoded
Accept: application/json

From=<configured A>
To=<allowed B>
Body=<server-generated test body>
StatusCallback=<configured status URL with test_id query parameter>
```

Use `URLSearchParams` so `+` phone prefixes and message text are encoded correctly. Read the returned `sid` as the outbound message identifier. The token needs Messaging scope. See the official [Create a Message contract](https://signalwire.com/docs/compatibility-api/rest/messages/create-message). Do not mix this endpoint with the newer JSON messaging API's field names or webhook format.

Generate the test before making the provider request. Append `test_id` using `URL`, preserving preconfigured query parameters. The inbound number's webhook is configured separately and does not receive this outbound callback URL or a dynamic `test_id` automatically.

Bound the entire outbound HTTP operation, including reading the response body, using an abort signal. Its deadline must not exceed the remaining test deadline. Reject redirects rather than following an authenticated request to another host. Keep API base URL/proxy configuration operator-controlled.

Handle non-JSON errors, rejected credentials, provider validation errors, missing SID, transport failure, and timeout. Mark the test failed with a safe reason and retain it for inspection. An uncertain send outcome must be labeled as such. **Do not automatically retry message creation** after an ambiguous timeout or network failure: the first SMS may already have been sent. Return `502` for upstream rejection/invalid response and `504` for upstream timeout, without exposing raw credentials or provider responses.

## Webhooks and receiver setup

### Inbound SMS: `POST /webhooks/signalwire/inbound`

Configure number B's **inbound messaging** handler to call this service's externally visible inbound URL using the **Compatibility/cXML webhook mode and POST**. Do not configure its voice handler, or assume a SWML resource will emit the same payload and accept the same response. Dashboard labels vary; document the actual setup used. SignalWire's [receiving guide](https://signalwire.com/docs/compatibility-api/guides/receive-sms) explains assigning messaging handling to a number.

Parse `application/x-www-form-urlencoded` fields including `MessageSid`, `AccountSid`, `From`, `To`, and `Body`; accept the documented legacy `SmsSid` alias where needed. Keep inbound and outbound SIDs separately. The [messaging cXML reference](https://signalwire.com/docs/compatibility-api/cxml/reference/messaging) documents these fields and the XML response model.

Verify the signature and receiving `AccountSid`, normalize the payload, then correlate its body. Return `200` with `Content-Type: application/xml; charset=utf-8` and:

```xml
<?xml version="1.0" encoding="UTF-8"?><Response/>
```

Do not include `<Message>`: the receiver must acknowledge without sending another SMS. Authenticated but unrelated, expired, or duplicate messages should still receive a successful acknowledgement, while remaining unable to change a test result. Malformed required fields return `400`; invalid signatures or an unexpected project return `403`; missing verification configuration returns `503`.

### Outbound status: `POST /webhooks/signalwire/status`

Verify the signature and outbound `AccountSid`. Read `MessageSid`/`SmsSid`, `MessageStatus`/legacy `SmsStatus`, numbers, and available error fields. Normalize status to lowercase. Acknowledge accepted callbacks with `200` JSON. SMS status callbacks are form-encoded POSTs; `failed` and `undelivered` indicate failure. `sent` is weaker evidence than `delivered`, and DLRs may be delayed or absent. See [SMS status callback](https://signalwire.com/docs/compatibility-api/rest/messages/webhooks/sms-status-callback).

Associate status callbacks by `test_id` and outbound SID. If both exist they must agree. When `test_id` is absent, exact known outbound SID matching is allowed. Unknown or conflicting IDs must never fall back to matching by phone/time or to a different test. A status payload containing `Body` is still status evidence, never inbound receipt evidence.

### Signature validation

Both webhook routes bypass the service's `API_KEY` check and enforce provider signatures instead. Use the appropriate project's **Signing Key**, distinct from the outbound API token. Follow SignalWire's [Compatibility webhook security contract](https://signalwire.com/docs/compatibility-api/guides/webhook-security), which validates the signature header, exact public URL, and request form parameters.

Implement dependency-free validation with `node:crypto`, checking the current official Compatibility SDK's form-signature behavior and capturing an independent known-vector fixture. The reference calling implementation uses base64 HMAC-SHA1 over the full URL followed by sorted form key/value pairs; confirm compatibility rather than adopting a different API family's raw-JSON signing algorithm. Include all supplied form fields in verification, not only recognized fields, and handle repeated keys according to the verified contract or reject them explicitly.

Support `X-SignalWire-Signature` and the Compatibility `X-Twilio-Signature` header; compare with a length check plus `timingSafeEqual`. Preserve the exact external scheme, host, path, encoding, and query, including `test_id`. Use configured canonical URLs; never trust arbitrary `Host` or forwarded headers to choose the signed URL. Cover explicit callback overrides and query preservation in tests. A normal TLS-terminating proxy is not a reason to disable signatures.

## Body correlation and state machine

Generate a fresh UUID plus a cryptographically random 128-bit nonce for each test. Use this exact ASCII SMS body format:

```text
swsms:v1:<test-uuid>:<32-lowercase-hex-character-nonce>
```

This is a short synthetic message. Always construct it server-side for `POST /tests` and the synchronous check; do not accept a caller-supplied body or reusable token for these endpoints. Keep raw message creation separate.

Correlation rules:

1. Store the test, generated body, expected A/B numbers, creation time, and deadline **before** starting the outbound request, so an early inbound webhook can be held as evidence.
2. On the inbound route, require the complete expected body after trimming outer whitespace only. Parse the version/UUID/nonce with an anchored format; use both UUID and nonce to identify exactly one test. Do not use a substring, phone/time fallback, query `test_id`, or inbound SID equality to prove receipt.
3. Require inbound `From` to equal test A and `To` to equal test B after strict E.164 normalization. Direction must be inbound when supplied; reject media-bearing receipts for this SMS-only test. Do not silently accept missing sender or destination.
4. Use server receipt time for deadline decisions. A provider timestamp cannot backdate a late arrival into a pass. Require `createdAt <= receivedAt < timeoutAt`; apply the deadline to both webhook routes.
5. Deduplicate inbound evidence by project + inbound message SID. Deduplicate status evidence by project + outbound SID + normalized status + error code, so later status changes for one SID remain visible. Repeated callbacks cannot create additional passes or change timings.
6. Early callbacks may be staged until the API response establishes the outbound SID. Then reconcile status SIDs against the response; mismatches are diagnostics, never success evidence. Inbound receipt can arrive before status or before the send response.
7. Retain authenticated unmatched/late-event metadata for diagnosis with bounded retention. Never attach an old body to a new run. Freeze finished test outcomes; late or contradictory events remain diagnostic evidence without changing the result already returned to a monitor.

State transitions:

```text
starting -> pending -> ok
    |          |
    +----------+----> failed
```

`ok` and `failed` are terminal. Evaluate deadlines for both starting and pending tests, including when nothing calls `GET /tests`. Transport errors cannot leave tests stuck in `starting`. A periodic unref'ed expiry sweep or scheduled deadline timers are acceptable; this is expiry handling, not a send scheduler.

Default success requires all of:

- `signalWireMessageCreated`: successful API creation with a valid outbound SID.
- `signalWireStatus`: at least one authenticated, matching outbound callback with a recognized outbound state (`queued`, `sending`, `sent`, `delivered`, `failed`, or `undelivered`). Failure states satisfy callback observation but explicitly fail the outcome.
- `inboundSmsMatched`: authenticated inbound webhook with the exact generated body and expected numbers within the deadline.

When `REQUIRE_DELIVERED_STATUS=true`, also require `signalWireDelivered`: a matching status webhook explicitly reporting `delivered`. Default is `false`, because actual inbound content is the core receipt proof and some routes lack DLRs. Expose the effective requirement in each test; do not allow per-request weakening of pass criteria. Never offer an option that disables the inbound requirement for a round-trip test.

A matching outbound `failed`/`undelivered` event observed before completion fails the run immediately, retaining any receipt evidence and safe error code. Do not treat `receiving`, `received`, an unknown status, or merely the send API response's status as an outbound status callback. At deadline, fail with a specific reason and the remaining evidence checklist. An SMS can have arrived while the test still fails due to missing status webhook evidence; make that distinction visible.

Keep `missing` as evidence absence, separate from explicit failure reasons. For example, an undelivered message may have no missing callback but must still have `ok: false`.

## HTTP API

All operational endpoints require `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`. Never accept `api_key` in a query string. Only health and the two provider-authenticated POST webhooks are public. Without an API key, operational reads may return `503`; send endpoints must return `503` and issue no provider request.

| Method/path | Behavior |
| --- | --- |
| `GET /` | Self-documenting JSON: endpoints, parameters, responses, pass criteria, effective limits, configuration booleans only. |
| `GET /health` | Process liveness only; `200 {"ok":true,"time":"..."}`. No SMS, provider request, or credential requirement. |
| `POST /tests` | Send one test SMS; return `201 {"test":{...}}` once API creation finishes. Does not wait for SMS receipt. |
| `GET /tests` | Bounded list of tests, newest first. |
| `GET /tests/{test_id}` | `200 {"test":{...}}`; `404` if absent or evicted. |
| `GET /checks/round-trip` | Send one test SMS and hold the response for its result; `200` on pass, `503` otherwise. |
| `POST /messages` | Diagnostic raw SMS send, accepting `to` and `body`; return `201` with safe message summary. Does not create a round-trip pass. |
| `GET /messages` | Bounded message summaries; distinguish outbound and inbound SIDs/directions. |
| `GET /events?limit=100` | Recent safe events, newest first; validate/cap `limit`. |
| `POST /webhooks/signalwire/status` | Outbound message progress callback. |
| `POST /webhooks/signalwire/inbound` | Actual receipt at B; empty cXML acknowledgement. |

Test input is a JSON object with optional `to` and `timeoutMs`; `{}` uses configuration defaults. `GET /checks/round-trip` supports the same query fields plus `waitTimeoutMs`. Reject unknown/unsupported fields and ambiguous repeated query parameters. Bound every incoming body at `256 KiB` before parsing. Validate field types; bound raw message bodies and document their possible segmentation. For query overrides, percent-encode a leading `+` (or use curl `--data-urlencode`) to avoid decoding it as a space.

For the synchronous endpoint, default the test duration and wait duration to `TEST_TIMEOUT_MS`. Measure both from before the provider request and include that request in the wait budget. Separate the single bounded send operation from the HTTP waiter so a short wait can expire even while creation is in flight. A wait ending before the test deadline returns `503`, `ok: false`, and the actual `starting` or `pending` status, with the test ID for later inspection. The send operation remains tracked, with all errors handled; a shorter HTTP wait does not permanently fail the test or trigger another send. Clamp the wait budget to the test deadline and return an already terminal result immediately. Clean up wait timers/listeners on client disconnect; an accepted SMS continues to be tracked and is never retried automatically.

Also implement consistent `400` invalid JSON/input/configuration, `401` missing/invalid API authentication, `403` disallowed destination/signature/project, `413` excessive body, `415` unsupported content type, `429` send/concurrency limit, and `502`/`504` provider failure responses. For synchronous checks that created a test, failure responses must include a safe `ok: false`, reason, and test ID. `POST /tests` failures after test creation likewise include that ID. Do not forward upstream error bodies to API clients.

An example test record shape (illustrative ID and values):

```json
{
  "id": "8e93d877-8d09-4fe8-9322-f8e382b59624",
  "status": "pending",
  "ok": false,
  "reason": "Waiting for: signalWireStatus, inboundSmsMatched",
  "expected": {
    "signalWireMessageCreated": true,
    "signalWireStatus": false,
    "inboundSmsMatched": false
  },
  "missing": ["signalWireStatus", "inboundSmsMatched"],
  "request": {
    "from": "+12025550100",
    "to": "+12025550101",
    "timeoutMs": 120000,
    "requireDeliveredStatus": false
  },
  "body": "swsms:v1:8e93d877-8d09-4fe8-9322-f8e382b59624:0123456789abcdef0123456789abcdef",
  "outboundMessageSid": "outbound-provider-id",
  "inboundMessageSid": null,
  "createdAt": "2026-11-02T12:00:00.000Z",
  "timeoutAt": "2026-11-02T12:02:00.000Z"
}
```

Include `updatedAt`, `finishedAt`, receipt timestamps/latency, latest provider status, safe error codes, and event references as appropriate. Never serialize configuration credentials into a test or message record.

## Regular monitoring, logs, and operation

The default concurrency limit is one active round-trip test. Reserve its slot atomically before awaiting network I/O; simultaneous requests must not both send. Apply a global minimum send interval to **all** send endpoints, including raw sends. Return `429` with `Retry-After` when blocked, without queuing a hidden later send. Failed/uncertain send attempts still consume the cooldown. These limits are per process; deploy a single replica with this in-memory design.

Configure an external monitor to request `GET /checks/round-trip`, send the API key in a header, and expect `200` plus `"ok": true`. A reasonable initial interval is five minutes with automatic retries disabled. Every accepted check sends a real billable SMS; at that interval, continuous operation attempts roughly 288 sends/day or 8,640/30 days, before manual tests. Set monitor and reverse-proxy HTTP timeouts above the effective check deadline plus a small transport margin. Point Docker/platform health probes at `/health`, never the round-trip route.

Persist safe events to `${DATA_DIR}/events.jsonl`, defaulting to the repository's `data/` directory and `/app/data` inside Docker. Serialize file appends and rotate at approximately 50 MiB to one `.1` backup, avoiding concurrent rotation races. Keep memory bounded: for example, 500 recent events, at most 1,000 terminal tests/message summaries, and 24-hour terminal-state retention. Never evict active tests; enforce the concurrency limit. Bound per-test events and deduplication indexes too.

Log start, accepted send, status, inbound match/unmatched receipt, and finish with timestamp, test ID, direction, SIDs, status, and duration. Redact credentials, authentication headers, signing keys, and signature headers before both stdout and JSONL persistence. Do not store arbitrary unrelated SMS bodies in plaintext; retain only the metadata needed to diagnose unmatched traffic. Avoid dumping full upstream responses or logging unrecognized payload fields without sanitization.

As in the reference project, the JSONL file is an audit log, **not** a database restored at startup. Restarts lose in-memory tests/correlation; mounted logs survive. Document this, single-replica deployment, log retention, and what a deploy does to pending tests. Handle `SIGTERM`/`SIGINT`, stop accepting new sends, drain/close within a bounded shutdown timeout, and flush pending event writes. Never send an SMS on startup.

## Docker deliverables

Provide a production `Dockerfile` comparable to the reference's multi-stage Alpine-to-scratch image. This is a starting template to build and verify, not evidence of a working SMS image:

```dockerfile
FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && chown -R 1000:1000 /app

FROM scratch
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /lib/ld-musl-*.so.1 /lib/
COPY --from=runtime /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=runtime /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime --chown=1000:1000 /app /app
USER 1000:1000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

The final image contains no shell or npm; run Node directly. Verify the copied libraries for each target architecture and HTTPS certificate validation. Use a maintained equivalent non-root image if this layout cannot be validated, documenting the tradeoff rather than claiming scratch support untested.

Ignore `.env`, `.env.*` except `.env.example`, `data/`, `node_modules/`, npm debug logs, and `.DS_Store` in git. The Docker context must additionally exclude `.git`, tests, local data, and all real environment files. Use allowlisted `COPY` instructions as above. Do not bake credentials into image layers or build arguments.

Document these commands, with persistent logs and a distinct volume/image from the calling tester:

```sh
docker build -t signalwire-sms-tester .
docker run --rm --name signalwire-sms-tester \
  -p 3001:3000 --env-file .env \
  -v signalwire-sms-tester-data:/app/data \
  signalwire-sms-tester
```

Port `3001` on the host allows it to coexist with a call tester on `3000`. Configure the public HTTPS proxy to reach this container, and set `PUBLIC_BASE_URL` accordingly. Named volumes should initialize with the image's `/app/data` ownership; document that host bind mounts need write permission for UID/GID `1000:1000`.

If adding a Docker `HEALTHCHECK`, use Node to request `/health`; `curl` and a shell are absent. Verify liveness with unconfigured provider credentials, read/write access to the mounted data directory, clean signal shutdown, and an authenticated API request that does not send an SMS. Do not put live credentials in automated container tests.

## Test requirements

Use `node --test` with fake provider responses and signed webhook fixtures. Exercise observable behavior, especially false-pass prevention:

| Area | Required cases |
| --- | --- |
| Sending | Correct Messages URL, Basic auth, form encoding, generated body, preserved callback query plus `test_id`; no client URL/credential overrides; no request on invalid/disallowed numbers. |
| Send errors | Non-JSON error, malformed/missing SID, rejected request, timeout, network ambiguity; terminal failed record and no automatic resend. |
| Correlation | Exact body and numbers pass; wrong/missing nonce/body/number/project fails to match; outbound and inbound SIDs differ; status `Body` cannot satisfy receipt. |
| Ordering | Inbound before status, status before inbound, callbacks before API response, contradictory SID, concurrent tests when the configured limit permits them. |
| Lifecycle | Duplicate receipts/statuses, old token, unknown test ID, receipt at/after deadline, expiry without reads, early HTTP wait expiry, and late callbacks cannot rewrite terminal outcomes. |
| Evaluation | API creation alone fails; delivery report alone fails; matching inbound alone misses status evidence; default full evidence passes; strict delivery mode additionally waits for `delivered`; `failed`/`undelivered` fail. |
| Signatures | Independent known vector; missing/invalid signatures; changed body/URL/query; unknown extra fields; repeat-key policy; both header names; inbound project/key differs; overrides preserve verification; forced `on` without key fails closed. |
| API/limits | Both API-key headers; query key rejected; no key means no sends; malformed JSON/type/number/timeout; oversized and unsupported bodies; allowlist; atomic concurrency/cooldown; secret-free index/errors. |
| Persistence | Temporary directory isolation, append/rotation behavior, redaction, bounded state/dedup maps, terminal cleanup preserving active runs. |
| XML | Empty valid cXML with correct content type; no automatic reply verb. |
| Container | Build, `/health`, non-root user, CA/HTTPS availability, mounted logs, shutdown; state actual validation limits if Docker unavailable. |

Default tests must not import live configuration, require network access, or contact SignalWire. Avoid changing global `fetch` in parallel tests; prefer dependency injection. Use a fake clock for deadline tests instead of waiting minutes.

## README setup and manual acceptance

Write a standalone README covering the architecture, SMS-specific evidence, all configuration, B's messaging webhook setup, APIs/authentication, monitor settings and costs, Docker, log persistence, troubleshooting, and releases. Add a concise `AGENTS.md` for the implemented repository, rather than carrying over voice instructions.

Document this operator sequence:

1. Copy `.env.example` to `.env`, set a strong API key, sender credentials/signing key, distinct SMS-capable A/B numbers, destination allowlist, receiver project/key if needed, and public HTTPS origin.
2. Run `npm run check`, `npm test`, then `npm start` or the Docker command above. Expose the service through HTTPS.
3. Configure B's inbound **messaging Compatibility/cXML POST webhook** to `{PUBLIC_BASE_URL}/webhooks/signalwire/inbound` (or the explicitly configured external URL). Outbound status callbacks are supplied per send by this service.
4. Export `SMS_TESTER_API_KEY` in the local shell separately, then run the examples below. An accepted test/check sends one real SMS. Do not use an automated retrying command for initial validation.

```sh
# Local Node default; use port 3001 for the Docker example above.
curl http://localhost:3000/health

curl -X POST http://localhost:3000/tests \
  -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  http://localhost:3000/tests

# This starts a second SMS test; wait for the active run and send cooldown first.
curl --max-time 135 \
  -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  'http://localhost:3000/checks/round-trip?timeoutMs=120000&waitTimeoutMs=120000'
```

For a real acceptance run, verify: an outbound SID, a separate inbound SID, the unique received body, expected A/B, valid signatures, outbound status callback, `status: ok`, `ok: true`, and no missing evidence. Inspect logs on both provider and service sides if it times out. A synthetic signed POST proves application handling only; it must not be reported as a live SMS success.

Diagnose failures by evidence: no outbound SID means configuration/API/send trouble; outbound status without inbound receipt points to B's number/webhook setup or delivery; an unmatched inbound points to body/number/project checks; signature rejection points to signing key, exact URL, or proxy changes; strict mode waiting for `delivered` may indicate missing/delayed DLRs despite content receipt.

If no real credentials/number setup or live-test authorization is available, finish all local implementation and mocked/container checks, then state exactly which real route check remains. Never copy `.env` or numbers from the calling repository, fabricate credentials, or claim a live SMS passed based on mocks.

## Versioning and container publication

Use `package.json` as the version source, tags `vMAJOR.MINOR.PATCH`, and Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`). Treat `0.x` as unstable and document that policy. The reference default branch is `master`; use the new repository's actual configured default branch consistently.

Maintain `CHANGELOG.md` and run syntax checks/tests before releases. Use `npm version patch|minor|major -m "chore(release): %s"` for subsequent release commits/tags. For the initial `0.1.0`, create its release commit/tag deliberately after the implementation is ready. Do not push, publish, or provision provider resources merely because this brief contains example commands; follow the user's scope in the new chat.

Default-branch builds may publish immutable full commit-SHA tags. `latest` must mean the latest **tagged release**. Publish SHA, version, and `latest` aliases from a single Buildx invocation so they refer to the same image output, with SBOM and max-mode provenance when supported:

```sh
# Set IMAGE to the new SMS repository's registry path, not the calling image.
# Set COMMIT_SHA and VERSION_TAG to the exact tagged checkout being released.
docker buildx build \
  --platform linux/amd64 \
  --provenance=mode=max --sbom=true --push \
  -t "${IMAGE}:${COMMIT_SHA}" \
  -t "${IMAGE}:${VERSION_TAG}" \
  -t "${IMAGE}:latest" \
  .
```

Keep registry credentials in protected CI variables, protect release tags, and prefer a dedicated Buildx-capable runner over privileged Docker-in-Docker. Build/test automation should run checks on the actual new repository's CI platform; none is assumed here. Do not reuse the calling project's registry destination by accident.

## Completion criteria for the implementing agent

Deliver working source, focused automated coverage, static checks, a documented configuration template, provider setup instructions, Docker deployment, release conventions, and a current repository handoff. Demonstrate that real receipt of the correct SMS body is required for a pass, callbacks in either order work, missing evidence fails predictably, and an authenticated monitor can run regular checks without creating uncontrolled extra sends.

Report the implemented behavior, checks actually run, container validation result, and live SMS result or precise remaining setup. Keep mock verification, container verification, and live SMS verification clearly identified. This should leave the new repository as independently usable as the calling tester.
