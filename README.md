# SignalWire SMS round-trip tester

A small, dependency-free Node.js service for checking a configured SignalWire
SMS route. An external monitor starts a test, the service sends one synthetic SMS
from configured sender A to number B, and B's inbound messaging webhook supplies the actual
received text. There is no SMS reply, dashboard, voice integration or send scheduler.

```text
monitor -> tester -> Compatibility Messages API -> A -> SMS -> B
              ^                 |                           |
              +-- status POST --+                           |
              +---------------- inbound messaging POST -----+
```

A pass requires all of these before the deadline:

- Successful message creation with an outbound SID.
- An authenticated, matching outbound status callback in a recognized state.
- An inbound webhook containing the exact generated text and receiving number B,
  passing the checks below. Sender A must match unless `IGNORE_SENDER_FROM=true`.
- A `delivered` callback when `REQUIRE_DELIVERED_STATUS=true`.

`failed` and `undelivered` fail immediately once their outbound SID is confirmed.
A delivery report alone cannot pass. `sent` plus actual inbound content can pass
in the default mode. The API response's status is not callback evidence.

The body is `swsms:v1:<fresh UUID v4>:<random 128-bit lowercase hex nonce>`.
Inbound and outbound SIDs are separate. Receipt requires the full body after
outer whitespace trimming, E.164 destination equality, inbound direction when
supplied, no media, and server receipt time strictly before the deadline.
Sender identity is checked by default; `IGNORE_SENDER_FROM=true` permits a
rewritten or missing inbound sender without changing outbound status matching.
Early callbacks are staged until the API establishes the outbound SID. Duplicate,
unrelated and late webhooks are acknowledged but cannot rewrite a finished run.

This verifies the configured SignalWire A-to-B path. It does not establish
delivery to a handset or traversal of an independent carrier.

## Setup

Requires Node.js **22.23.4 or newer**, using a current security-patched supported
release line. There are no npm dependencies to install. The container pins the
[Node 22.23.4 security release](https://nodejs.org/en/blog/release/v22.23.4);
keep the runtime and Docker base current ([release schedule](https://nodejs.org/en/about/previous-releases)).

1. Copy `.env.example` to `.env`. Set a strong `API_KEY`, outbound credentials,
   Signing Key, public HTTPS origin, sender A and an SMS-enabled receiving number B with a
   nonempty destination allowlist. Set B's project/key separately if needed.
2. Run `npm run check`, `npm test`, then `npm start` (or use Docker below).
   Expose the service through an HTTPS proxy.
3. Configure B's **inbound messaging Compatibility/cXML webhook**, **POST**, to
   `https://your-public-origin/webhooks/signalwire/inbound`, or the exact
   `SIGNALWIRE_INBOUND_WEBHOOK_URL` override. Outbound callbacks are set per send.
4. Export `SMS_TESTER_API_KEY` separately in your local shell and run one manual
   acceptance test. Each accepted test/check sends a real, potentially billable SMS.

```sh
cp .env.example .env
# Edit .env before sending anything.
npm run check
npm test
npm start
```

The service never sends on startup. `/health` works without SignalWire credentials.
Missing provider/receiver configuration blocks sends with `400` and variable
names. Missing `API_KEY` disables operational APIs with `503`. Invalid numeric,
boolean, verification-mode or dotenv syntax prevents startup.

The sender and destination must be operator-controlled and usable on the intended
SMS route. Sender A may be an SMS-enabled E.164 number or a sender ID;
destination B must be an SMS-enabled E.164 number. Numeric A and B must differ.
Confirm Messaging permissions, destination eligibility and applicable account
requirements using the provider's [sending guide](https://signalwire.com/docs/compatibility-api/guides/send-sms).
No numbers or credentials from another repository are needed.

### Reusing configuration from the calling tester

Start with this project's `.env.example` and transfer only the shared settings
you intend to reuse. The calling tester's `.env` does **not** work unchanged:

| Calling setting | SMS tester requirement |
| --- | --- |
| `SIGNALWIRE_BASE_URL`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_SIGNING_KEY` | Reusable for the same outbound project |
| `SIGNALWIRE_TOKEN` | Reusable only if its API token has **Messaging** scope; Voice scope alone is insufficient |
| `SIGNALWIRE_FROM` | SMS-enabled E.164 sender number or sender ID usable on the intended route |
| `DEFAULT_TO`, `ALLOWED_TO_NUMBERS` | Use distinct receiving **SignalWire SMS** number B; the calling tester's Placetel destination is not this receiver; an empty allowlist blocks sends |
| `PUBLIC_BASE_URL`, `SIGNALWIRE_STATUS_WEBHOOK_URL` | Point at the SMS deployment; clear an old status override to use the new origin, or set the exact new external status URL |
| `SIGNALWIRE_VERIFY_WEBHOOKS=auto` | Change to **`on`**; this service accepts only `on`/`off` and never falls back from Signing Key to API token |
| `SIGNALWIRE_VOICE_WEBHOOK_URL`, `SIGNALWIRE_SAY_MESSAGE`, `PLACETEL_*`, `WAIT_FOR_PLACETEL_WEBHOOK` | Unused; omit them. Actual inbound SMS evidence is always required |
| `API_KEY`, host/port/timeouts | Same concepts; use a separate service key and SMS log volume for independent deployment |

Configure B's messaging webhook separately as described below. If B is in the
same project, leave the inbound project/key overrides blank; otherwise supply
its own project ID and Signing Key. The API token's actual scope and the phone
numbers' SMS capability must be checked in SignalWire; reading configuration
alone cannot establish either. No live calling-project `.env` is read or copied
by the SMS service or its release process.

## Receiving number and proxy

Set B's **messaging** handler to an external Compatibility/cXML POST webhook.
The [receiving guide](https://signalwire.com/docs/compatibility-api/guides/receive-sms)
describes assigning messaging handling to a number. In the Legacy Dashboard this
is under **Messaging Settings → LaML Webhooks**. In newer dashboards open the
number's messaging settings and select the Compatibility/cXML external webhook
handler; labels vary. A hosted reply script is unnecessary for this service.
Record the actual dashboard labels and number setup during live acceptance;
no provider dashboard configuration has been performed by this implementation.

The response is exactly
`<?xml version="1.0" encoding="UTF-8"?><Response/>`, with XML content type.
There is no `<Message>` verb and therefore no automatic SMS reply.

Keep `PUBLIC_BASE_URL` as the canonical origin (scheme and host, without a path).
For a proxy path prefix, set both explicit webhook URLs to their exact public
addresses and rewrite the proxy paths to the service's `/webhooks/...` routes.
Fixed query parameters are supported; preserve their encoding and order at the
proxy. `test_id` is reserved and is appended to outbound test callbacks by `URL`.
Changing an environment variable does not configure B's number at SignalWire.

Verification uses each project's **Signing Key**, distinct from the API token,
and checks `AccountSid` as well. For B in another project, supply its project ID
and Signing Key; no receiving-project API token is necessary. Overrides and TLS
termination never disable verification. The service ignores `Host` and forwarded
headers when building signed public URLs.

The form signature contract was checked against SignalWire's
[security documentation](https://signalwire.com/docs/compatibility-api/guides/webhook-security)
and [official Compatibility SDK implementation](https://github.com/signalwire/compatibility-api-js/blob/main/lib/webhooks/webhooks.js):
HMAC-SHA1, base64, exact public URL followed by case-sensitive sorted form names
and values. Every supplied form field is included. This service rejects repeated
form keys explicitly and requires the exact configured URL spelling rather than
trying alternative port spellings. Both signature header names are supported;
if both are supplied, both must validate. The fixed known-vector test comes from
the [published Compatibility security example](https://www.twilio.com/docs/usage/security#validating-requests).

For the temporary verification-off setup, both webhook routes also accept
`Content-Type: application/json`. Set `SIGNALWIRE_VERIFY_WEBHOOKS=off` explicitly;
the default stays `on`. JSON must be a flat Compatibility object with string
fields (`MessageSid`/`SmsSid`, `AccountSid`, `From`, `To`, `Body`, status fields,
etc.). `NumMedia`, `NumSegments` and `ErrorCode` may also be nonnegative integers.
Optional `ErrorCode` and `ErrorMessage` may be `null`; these normalize to empty
error metadata. Required correlation fields must still have valid types.
When `IGNORE_SENDER_FROM=true`, inbound JSON `From` is discarded before field
validation, including missing/null/non-string values. All other JSON fields
retain their normal validation. Signed forms retain every field, including
ignored `From`, for signature verification.
The inbound response remains empty cXML. Account, number, body, media and deadline
checks still apply. JSON signature verification is deferred: with verification
`on`, JSON callbacks return `415`; signed form callbacks continue to work.

A manual SMS with `Body: "Test"` is acknowledged as unrelated traffic. Start a
test/check to generate the unique `swsms:v1:...` text; that exact text must arrive
at the inbound route to satisfy the receipt requirement.

## Configuration

`.env` is loaded from the repository root regardless of the shell's directory.
Existing environment entries, including empty entries, win. Single/double quotes,
single-line values, blank values and comments are supported. Double quotes decode
`\n`, `\r`, `\"` and `\\`; multiline quoted values are rejected. Blank optional
values select the defaults described below. A bare inline `#` starts a comment
when preceded by whitespace (quote values containing literal comment syntax).

| Variable | Default / meaning |
| --- | --- |
| `PORT`, `HOST` | `3000`, `0.0.0.0` |
| `API_KEY` | Required for all operational endpoints; use a strong random secret |
| `PUBLIC_BASE_URL` | Canonical public HTTPS origin; required for sending |
| `SIGNALWIRE_BASE_URL` | Operator-controlled Compatibility base, e.g. `https://your-space.signalwire.com/api/laml/2010-04-01` |
| `SIGNALWIRE_PROJECT_ID` | Outbound project ID |
| `SIGNALWIRE_TOKEN` | Outbound API token with Messaging scope |
| `SIGNALWIRE_SIGNING_KEY` | Outbound project's webhook Signing Key |
| `SIGNALWIRE_FROM` | Fixed E.164 sender number or 1–11 character sender ID A (see below) |
| `DEFAULT_TO` | Optional default destination B; otherwise pass `to` |
| `ALLOWED_TO_NUMBERS` | Required comma-separated complete E.164 allowlist; each must use this receiver webhook/project |
| `SIGNALWIRE_STATUS_WEBHOOK_URL` | Blank: origin + `/webhooks/signalwire/status`; exact external override otherwise |
| `SIGNALWIRE_INBOUND_WEBHOOK_URL` | Blank: origin + `/webhooks/signalwire/inbound`; configure this on B |
| `SIGNALWIRE_INBOUND_PROJECT_ID` | Blank: outbound project |
| `SIGNALWIRE_INBOUND_SIGNING_KEY` | Blank: reuse outbound key only for the same project |
| `SIGNALWIRE_VERIFY_WEBHOOKS` | `on`; only `on` or `off`. `off` is for isolated development/tests |
| `TEST_TIMEOUT_MS` | `120000`; positive integer, capped at `600000` |
| `SIGNALWIRE_REQUEST_TIMEOUT_MS` | `10000`; positive integer, capped at `600000` and remaining test time |
| `REQUIRE_DELIVERED_STATUS` | `false`: creation + recognized outbound status callback + exact inbound receipt; `true`: also require a matching `delivered` callback; cannot be weakened per request |
| `IGNORE_SENDER_FROM` | `false`; `true` ignores inbound `From` only (presence, format and equality); outbound status sender matching remains strict; cannot be changed per request |
| `MAX_ACTIVE_TESTS` | `1`; positive integer, capped at `100` |
| `MIN_SEND_INTERVAL_MS` | `60000`; positive integer shared by tests, checks and raw sends |
| `DATA_DIR` | Repository-root `./data`; `/app/data` in Docker |

Destinations require complete canonical numbers such as `+12025550101`. Phone
numbers with spaces, country guessing, suffix matching, A-to-A sends and
destinations outside the allowlist are rejected. `SIGNALWIRE_FROM` additionally
accepts sender IDs of 1–11 ASCII letters, digits or `_ . - + * , #`. Numeric-only
and symbol-only IDs are accepted; spaces and other characters are rejected.
This implements the sender pattern (using full-string matching):

```regex
^(?:\+[1-9][0-9]{1,14}|[\w.\-+*,#]{1,11})$
```

For example:

```dotenv
SIGNALWIRE_FROM=My-Brand
```

The configured sender is sent unchanged and matched exactly, including case, in
status callbacks and, by default, inbound callbacks. `IGNORE_SENDER_FROM=true`
skips inbound sender validation and equality. Destinations and allowlist entries must still
be canonical E.164 numbers. Provider/route acceptance of an ID is separate from this
service's format validation; a rejected send or rewritten sender cannot produce
a pass unless only inbound sender rewriting is tolerated using the opt-out.
No live sender-ID route has been verified by the automated checks.

### Receipt matching and rewritten senders

If a carrier or gateway rewrites inbound `From`, set this server environment
variable and restart/redeploy:

```dotenv
IGNORE_SENDER_FROM=true
```

In this mode, a pass proves receipt of the generated text at B without checking
the sender identity presented in that inbound webhook.

The body identifies the test using its UUID and random nonce. These checks apply
to `/webhooks/signalwire/inbound`:

| Field or condition | Required match |
| --- | --- |
| `Body` | Complete `swsms:v1:<UUID v4>:<128-bit nonce>` generated for this run; only outer whitespace is trimmed; no substring or phone/time fallback |
| `To` | Valid canonical E.164 and exact equality to this run's receiving number B, selected from the configured allowlist |
| `AccountSid` | Exact configured inbound project (outbound project by default) |
| Signature | Valid project Signing Key signature when verification is `on`; JSON requires the existing explicit verification-off setup |
| `From` | Default: valid sender syntax and exact, case-sensitive equality to configured A. With `IGNORE_SENDER_FROM=true`: ignored entirely, including absence or invalid syntax |
| `MessageSid` / `SmsSid` | Valid identifier; aliases must agree if both are supplied; deduplicated by inbound project + SID; it need not equal the outbound SID |
| `Direction` | If nonempty, must be `inbound` (case normalized) |
| Media | `NumMedia` absent or zero; no `MediaUrlN` or `MediaContentTypeN` fields |
| Time and state | Server receipt time at/after creation and strictly before the deadline; run must still be active; finished results cannot change |

The opt-out does not change the configured outbound `SIGNALWIRE_FROM` or its
validation. Outbound status still requires the outbound project, exact configured
`From` and run `To`, a matching outbound SID and consistent `test_id` when supplied,
a recognized outbound status, and arrival before the deadline. Early status
callbacks are staged until the create response confirms their SID. Status `Body`
never counts as receipt. Creation and outbound status remain mandatory; a
`delivered` callback is additionally required only when
`REQUIRE_DELIVERED_STATUS=true`. Observed `failed`/`undelivered` statuses fail a run.

The effective flag appears in `GET /` configuration, every test's
`request.ignoreSenderFrom`, and `service_started`. `inbound_matched` records
`senderFromIgnored`. Ignored inbound `From` values are omitted from message
summaries and event logs. API callers cannot override this flag.

Provider URLs must be HTTP(S), without embedded credentials or
fragments; use HTTPS in deployment. HTTP support is for isolated local development.

## HTTP API

Use `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`. Query API keys
are rejected. Only `/health` and the two provider-authenticated POST webhooks are
public, including when the service has no API key configured.

| Method/path | Input and response |
| --- | --- |
| `GET /` | Authenticated self-documenting JSON; configuration booleans and effective limits, no credentials |
| `GET /health` | `200 {"ok":true,"time":"..."}`; process liveness, no provider call |
| `POST /tests` | JSON `{to?, timeoutMs?}`; `{}` uses defaults; `201 {test}` after creation, without waiting for receipt |
| `GET /tests` | `{tests}` newest first; `limit` defaults to 100, capped at 1000 |
| `GET /tests/{id}` | `{test}`, or `404` for unknown/evicted IDs |
| `GET /checks/round-trip` | `to`, `timeoutMs`, `waitTimeoutMs` query options; sends one test and waits; `200` only on pass |
| `POST /messages` | Diagnostic JSON `{to?, body}`; `201 {message}` safe summary, no round-trip test |
| `GET /messages` | Bounded safe inbound/outbound summaries; `limit` up to 1000 |
| `GET /events` | Safe recent events newest first; `limit` defaults to 100, capped at 500 |
| `POST /webhooks/signalwire/status` | Form POST, or JSON when verification is explicitly off; outbound project; `200` JSON acknowledgment |
| `POST /webhooks/signalwire/inbound` | Form POST, or JSON when verification is explicitly off; receiving project; `200` empty messaging cXML |

Unknown request fields, repeated query parameters, malformed JSON and bad types
return `400`. JSON timeout values must be numbers, not strings. Timeout/wait
values above 600000 ms are clamped and effective values returned. Query numbers
must be positive decimal integers. Percent-encode a leading `+` in query phone
numbers (`%2B`) or use curl `--data-urlencode`.

Bodies are bounded at 256 KiB; send endpoints accept JSON and webhooks accept
`application/x-www-form-urlencoded` (also `application/json` with verification
explicitly off). Raw text is bounded to 1600 UTF-16 code units
and may incur multiple SMS segments depending on length and encoding. The
[provider's status reference](https://signalwire.com/docs/compatibility-api/rest/messages/webhooks/sms-status-callback)
describes segmentation and the difference between `sent` and `delivered`.
Raw sends reject the reserved `swsms:v1:` body prefix so they cannot replay a
test's receipt token.

`GET /checks/round-trip` defaults both test and HTTP wait to `TEST_TIMEOUT_MS`.
Both budgets start before sending and include creation time. The wait is capped
at the test deadline. An early HTTP timeout returns `503`, `ok:false`, the actual
`starting`/`pending` record, effective wait, and test ID. The same send continues
being tracked; there is no hidden resend. Disconnecting also removes the waiter
without cancelling the accepted send. Finished results return immediately.

Other errors: `401` API auth; `403` destination/signature/project; `413` body too
large; `415` content type; `429` cooldown or active-test limit with `Retry-After`;
`502` provider rejection/invalid response/transport error; `504` provider timeout.
Checks return `503` for a failed or still-pending test unless creation itself
failed with `502`/`504`. Failures after test creation include `ok:false`, a safe
reason and test ID. Upstream bodies and credentials are never returned.
Ambiguous sends are marked uncertain and are **never retried automatically**.

Test records expose `status`, `ok`, `reason`, `expected`, `missing`, effective
requirements, the synthetic body, separate SIDs, timestamps, receipt latency,
latest matched provider status, safe error code and event references. `missing`
describes absent evidence; explicit failure remains visible even if nothing is
missing. Terminal `ok`/`failed` records are immutable. Late facts go to diagnostics.

## Manual acceptance and monitoring

Export the service key independently, then use these commands. Do not use
automatic retries for initial validation. Docker's example uses host port 3001;
the commands below use local Node's port 3000.

```sh
export SMS_TESTER_API_KEY='replace-with-your-service-key'
curl http://localhost:3000/health

curl -X POST http://localhost:3000/tests \
  -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  -H 'Content-Type: application/json' -d '{}'

curl -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  http://localhost:3000/tests

# Sends a SECOND SMS: wait for the active run and cooldown before running this.
curl --max-time 135 \
  -H "Authorization: Bearer ${SMS_TESTER_API_KEY}" \
  'http://localhost:3000/checks/round-trip?timeoutMs=120000&waitTimeoutMs=120000'
```

For real acceptance verify outbound SID, a separate inbound SID, exact received
body, expected B (and A unless inbound sender checking is disabled), valid
signatures, outbound status callback, `status:ok`,
`ok:true`, and empty `missing`. Compare provider and service logs on failure.
A signed synthetic POST proves application handling, not live SMS delivery.

Configure Uptime Kuma or another external HTTP monitor for
`GET /checks/round-trip`, API key in a header, status **200** plus JSON `ok:true`.
Start with five-minute checks and automatic retries **disabled**: continuous
operation attempts roughly 288 sends/day or 8640 per 30 days before manual sends.
Use monitor/proxy timeouts longer than the effective deadline plus a transport
margin (e.g. 135 seconds for 120 seconds). Health probes must target `/health`.
Do not configure multiple monitors/replicas to compete for the same run slot.

## Docker

The container repository is
[`schumann/signalwire-sms-tester`](https://hub.docker.com/r/schumann/signalwire-sms-tester).
The current patch release is `0.1.6`, with tags `0.1.6`, `v0.1.6`, `latest` and a
full commit-SHA alias. Releases target Linux AMD64 and ARM64. Use the version tag
for a fixed deployment; `latest` advances only for tagged releases.

```sh
docker pull schumann/signalwire-sms-tester:0.1.6
docker run -d --name signalwire-sms-tester --restart unless-stopped \
  -p 127.0.0.1:3001:3000 --env-file .env \
  -v signalwire-sms-tester-data:/app/data \
  schumann/signalwire-sms-tester:0.1.6
```

The port above assumes an HTTPS proxy on the Docker host. Local source builds:

```sh
docker build -t signalwire-sms-tester .
docker run --rm --name signalwire-sms-tester \
  -p 3001:3000 --env-file .env \
  -v signalwire-sms-tester-data:/app/data \
  signalwire-sms-tester
```

The multi-stage Node 22.23.4 Alpine-to-scratch image runs as UID/GID **1000:1000**,
with Node, updated musl/C++ runtime libraries and CA bundle. Application files
are owned by root and are not writable by the runtime user; `/app/data` is owned
by UID/GID 1000 for logs. Its base tag/digest
are pinned and OS/library package metadata is retained for scanners. The final image has no
shell or npm; its healthcheck invokes Node directly. Named volumes initialize
with `/app/data` ownership; host bind mounts must allow UID/GID 1000 to write.
Port 3001 and the SMS-specific image/volume allow coexistence with a calling tester.
Point the public HTTPS proxy at this container and keep canonical URLs accurate.

An opt-in smoke test creates and removes its own container/volume, uses a synthetic
service API key, and has **no provider credentials**. It checks liveness,
authenticated reads, UID/GID, mounted writes/persisted logs, HTTPS certificate
validation to nodejs.org, absence of a shell, and SIGTERM exit 0:

```sh
docker build -t signalwire-sms-tester:local .
npm run test:container
# Optional: node scripts/container-smoke.js <another-locally-built-image>
```

## State, logs and shutdown

Deploy **one process/replica**. Send reservations, cooldown and correlation are
in memory. There are at most 1000 retained terminal tests plus active tests, 1000
message summaries, 500 recent events, 64 per-test event references, 64 staged
statuses, 128 status dedup keys per test, and 5000 inbound dedup entries. Terminal
state/message/dedup retention is 24 hours; active tests are never evicted. An
unref'ed sweep expires starting/pending tests even without API polling.

Safe structured events go to stdout and `${DATA_DIR}/events.jsonl`. Appends and
rotation are serialized; about 50 MiB rotates to a single `events.jsonl.1`
backup. Pending disk/stdout writes are capped at 1000 events and 1 MiB and honor
stdout backpressure. Overload drops output events and emits a `log_dropped` count
when capacity returns; test evidence and completion criteria are unaffected.
Event fields avoid arbitrary webhook/provider payloads. Credentials,
auth/signature headers and message bodies are redacted before stdout and disk.
Unrelated/raw SMS bodies are not retained in message summaries. Authenticated
test inspection includes only the generated synthetic test body.

The startup event `service_started` includes `version` from `package.json`
(also the container release version), `nodeVersion`, `port`, `verifyWebhooks`
and `requireDeliveredStatus`/`ignoreSenderFrom`, so the deployed version and effective matching
requirement are visible in logs.

JSONL is an **audit log, not a database**. It is not restored at startup. Restarts
lose pending tests and correlation; mounted logs survive. Schedule deployments
between checks. SIGTERM/SIGINT stops new sends and drains connections/sends for
up to 10 seconds, closes connections, flushes queued writes, then exits (12-second
hard shutdown guard). A monitor interrupted by deployment should inspect logs
and allow the cooldown before deliberately starting a new test.

## Troubleshooting

`inbound_matched` proves receipt evidence, not completion of the full test. Its
`missing` list shows what is still required; `signalWireStatus` means the separate
outbound status callback has not been accepted. `REQUIRE_DELIVERED_STATUS=false`
accepts a recognized status such as `sent` instead of requiring `delivered`; it
does not remove the status callback requirement. The user explicitly retained
this requirement after investigating an inbound-matched test that stayed pending.

Rejected webhook requests emit `webhook_rejected` events with route, HTTP status,
safe reason, content type, and recognized IDs/project-match metadata when available.
They exclude raw bodies, signatures, auth headers and query values. Check these
events for `400` malformed fields, `403` signature/project/query mismatch, `415`
content type/signature-mode mismatch, or `503` missing verification configuration.
Accepted status callbacks produce `status_received`, `status_staged` or
`status_unmatched`. If none of these or status `webhook_rejected` events exist,
inspect the provider/gateway callback attempt and routing to `/webhooks/signalwire/status`.
Gateways must forward the per-send `StatusCallback`, its query and payload.

For CapRover, the app-specific nginx timeout is under **Apps → this app → HTTP
Settings → Edit Default Nginx Configurations**. In the existing proxy `location /`
block, add or update `proxy_read_timeout 150s;` and save the configuration. Preserve
the existing template and `proxy_pass`. nginx defaults to 60 seconds, which can
end a 120-second check before the service returns its JSON result.
([CapRover configuration](https://caprover.com/docs/app-configuration),
[nginx timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout)).
This changes the HTTP wait budget, not the required SMS evidence.

| Evidence | Check |
| --- | --- |
| No outbound SID | Configuration, Messaging scope, API URL, credential rejection, transport/timeout uncertainty |
| Status callback but no inbound | B's SMS capability, route/delivery, messaging handler URL and POST/cXML mode |
| Inbound but no matched receipt | Exact body/nonce, complete B and A unless ignored, receiving project, direction/media, deadline |
| Inbound sender rewritten | Set `IGNORE_SENDER_FROM=true` to ignore inbound `From`; body/To/project/SID/direction/media/deadline and outbound status checks still apply |
| `403` webhook | Project Signing Key, correct project, exact public scheme/host/path/query, proxy rewrites |
| Receipt present but missing status | Outbound callback reachability and signing configuration |
| Strict mode waits for `delivered` | Route may have missing/delayed delivery reports despite content receipt |
| `429` | Existing active test or shared cooldown; inspect `Retry-After`, avoid automatic retries |
| Missing logs | DATA_DIR permissions or storage errors; look for `log_error` on stdout |

## Development and releases

`createApp(config, store, {fetch, now})` does not listen on import. Tests supply
isolated configuration/temp logs, fake provider fetch and controllable clocks.
Default checks never read live `.env`, need external network or send real SMS;
HTTP integration tests use local ephemeral loopback ports.

```sh
npm run check
npm test
```

Use `package.json` as the version source, Conventional Commits and SemVer tags
`vMAJOR.MINOR.PATCH`. The `0.x` interface is unstable; minor versions may break
compatibility. The default branch is `master`; the Git repository is
[`s-schumann/signalwire-sms-tester`](https://github.com/s-schumann/signalwire-sms-tester).
No CI workflow is configured; the release checks are run explicitly.
See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the dated CVE audit and Claude
Code review handoff, and [CLAUDE.md](CLAUDE.md) for the review entry point.
The initial release is `0.1.0`, tagged `v0.1.0`. Registry publication is a separate
action from pushing the Git repository. For subsequent releases update the changelog and use:

```sh
npm run check
npm test
npm version patch -m 'chore(release): %s'  # or minor / major
```

Use an SMS-specific registry path and protected registry credentials/release tags.
Default-branch builds may publish full immutable SHA tags; **latest is reserved
for tagged releases**. At the exact tagged checkout, publish the SHA, version and
latest from one Buildx invocation so aliases identify the same output:

```sh
# At the exact release tag, set COMMIT_SHA and VERSION_TAG first.
IMAGE=schumann/signalwire-sms-tester
docker buildx build --platform linux/amd64,linux/arm64 \
  --provenance=mode=max --sbom=true --push \
  -t "${IMAGE}:${COMMIT_SHA}" -t "${IMAGE}:${VERSION_TAG}" \
  -t "${IMAGE}:latest" .
```

Use a dedicated Buildx runner where possible. Validate runtime libraries and HTTPS
for every target architecture before publication. Building locally does not
authorize publishing or provisioning provider resources. See
[IMPLEMENTATION.md](IMPLEMENTATION.md) for checks actually run and remaining live setup.
