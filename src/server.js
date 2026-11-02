import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig, sendConfigurationErrors, webhookConfigurationErrors, isE164, isSid, MAX_BODY_BYTES, MAX_MESSAGE_CHARS, MAX_TIMEOUT_MS } from './config.js';
import { HttpError } from './errors.js';
import { createMessage } from './signalwire.js';
import { parseForm, verifyForm, safeEqual, signedWebhookUrl, statusCallbackUrl } from './signature.js';
import { EMPTY_MESSAGING_XML, XML_CONTENT_TYPE } from './xml.js';
import { createLogger } from './logger.js';
import { Store } from './store.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, contentType) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== contentType) throw new HttpError(415, `Expected ${contentType}`);
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); throw new HttpError(413, 'Request body exceeds 256 KiB'); }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); req.resume(); reject(new HttpError(413, 'Request body exceeds 256 KiB')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks).toString('utf8')); };
    const error = () => { cleanup(); reject(new HttpError(400, 'Unable to read request body')); };
    const aborted = () => error();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown or unsupported input field');
  return value;
}

function queryFields(url, allowed) {
  const result = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new HttpError(400, 'Unknown or repeated query parameter');
    result[key] = value;
  }
  return result;
}

function duration(value, fallback, query = false) {
  if (value === undefined) return fallback;
  if (query && typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'Timeout must be a positive integer in milliseconds');
  return Math.min(value, MAX_TIMEOUT_MS);
}

function limitQuery(url, max = 500) {
  const { limit } = queryFields(url, ['limit']);
  if (limit === undefined) return 100;
  if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1) throw new HttpError(400, 'limit must be a positive integer');
  return Math.min(Number(limit), max);
}

function destination(config, input) {
  const to = input === undefined ? config.defaultTo : input;
  if (!isE164(to)) throw new HttpError(400, 'to must be a canonical E.164 number; configure DEFAULT_TO or supply to');
  if (to === config.from || !config.allowedTo.includes(to)) throw new HttpError(403, 'Destination is not allowed');
  return to;
}

function alias(form, current, legacy) {
  if (form[current] !== undefined && form[legacy] !== undefined && form[current] !== form[legacy]) throw new HttpError(400, 'Conflicting webhook aliases');
  return form[current] ?? form[legacy];
}

function waitForTest(store, id, until, res, now) {
  return new Promise(resolveWait => {
    let timer;
    const finish = value => {
      clearTimeout(timer);
      store.off(id, changed);
      res.off('close', disconnected);
      resolveWait(value);
    };
    const changed = () => {
      const test = store.get(id);
      if (!test || ['ok', 'failed'].includes(test.status)) finish(test);
    };
    const disconnected = () => finish(null);
    store.on(id, changed);
    res.once('close', disconnected);
    timer = setTimeout(() => finish(store.get(id)), Math.max(0, until - now()));
    changed();
  });
}

export function createApp(config, store, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const operations = new Set();
  function track(promise) {
    operations.add(promise);
    // All detached operations settle to a value, never an unhandled rejection.
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  }
  function readyToSend() {
    const errors = sendConfigurationErrors(config);
    if (errors.length) throw new HttpError(400, 'Invalid or missing send configuration', { variables: errors });
    if (!store.accepting) throw new HttpError(503, 'Service is shutting down');
  }
  async function sendTest(test) {
    try {
      const result = await createMessage(config, { to: test.request.to, body: test.body, callbackUrl: statusCallbackUrl(config, test.id), deadline: Date.parse(test.timeoutAt) }, { fetch, now });
      store.markCreated(test.id, result.sid);
      return null;
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 502;
      const reason = error instanceof HttpError ? error.message : 'Provider send failed; send outcome uncertain';
      const row = store.tests.get(test.id);
      if (row && !['ok', 'failed'].includes(row.record.status)) row.record.sendErrorStatus = status;
      store.failSend(test.id, reason, error.uncertain ?? true);
      return { status, reason };
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal.invalid');
      if (url.searchParams.has('api_key')) throw new HttpError(400, 'API keys are accepted only in headers');
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { req.resume(); throw new HttpError(413, 'Request body exceeds 256 KiB'); }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, time: new Date(now()).toISOString() });

      const inbound = url.pathname === '/webhooks/signalwire/inbound';
      const status = url.pathname === '/webhooks/signalwire/status';
      if (req.method === 'POST' && (inbound || status)) {
        const errors = webhookConfigurationErrors(config, inbound);
        if (errors.length) throw new HttpError(503, 'Webhook verification configuration unavailable', { variables: errors });
        const form = parseForm(await readBody(req, 'application/x-www-form-urlencoded'));
        // Configured query parameters must survive the public proxy unchanged.
        const configuredUrl = inbound ? config.inboundWebhookUrl : config.statusWebhookUrl;
        const configuredQuery = configuredUrl ? new URL(configuredUrl).searchParams : [];
        for (const [key, value] of configuredQuery) {
          if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) throw new HttpError(403, 'Webhook URL query does not match configuration');
        }
        for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length > 1) throw new HttpError(400, 'Repeated query parameter');
        if (config.verifyWebhooks && !verifyForm(inbound ? config.inboundSigningKey : config.signingKey, signedWebhookUrl(config, inbound, req.url), form, req.headers)) throw new HttpError(403, 'Invalid webhook signature');
        if (!form.AccountSid) throw new HttpError(400, 'Webhook requires AccountSid');
        if (form.AccountSid !== (inbound ? config.inboundProjectId : config.projectId)) throw new HttpError(403, 'Unexpected webhook project');
        const sid = alias(form, 'MessageSid', 'SmsSid');
        if (!isSid(sid) || !isE164(form.From) || !isE164(form.To)) throw new HttpError(400, 'Webhook requires valid message SID, From and To');
        if (inbound) {
          if (typeof form.Body !== 'string') throw new HttpError(400, 'Inbound webhook requires Body');
          if (form.NumMedia !== undefined && !/^\d+$/.test(form.NumMedia)) throw new HttpError(400, 'Invalid NumMedia');
          store.receiveInbound({ projectId: form.AccountSid, sid, from: form.From, to: form.To, body: form.Body, direction: form.Direction?.toLowerCase(), hasMedia: Number(form.NumMedia || 0) > 0 || Object.keys(form).some(key => /^Media(?:Url|ContentType)\d+$/.test(key)) });
          res.writeHead(200, { 'content-type': XML_CONTENT_TYPE, 'cache-control': 'no-store' });
          return res.end(EMPTY_MESSAGING_XML);
        }
        const messageStatus = alias(form, 'MessageStatus', 'SmsStatus')?.toLowerCase();
        if (!messageStatus || !/^[a-z-]{1,40}$/.test(messageStatus)) throw new HttpError(400, 'Status webhook requires MessageStatus');
        const errorCode = /^[A-Za-z0-9_-]{1,32}$/.test(form.ErrorCode || '') ? form.ErrorCode : null;
        if (url.searchParams.has('test_id') && !url.searchParams.get('test_id')) throw new HttpError(400, 'test_id must not be empty');
        store.receiveStatus({ testId: url.searchParams.get('test_id') ?? undefined, projectId: form.AccountSid, sid, status: messageStatus, from: form.From, to: form.To, errorCode });
        return json(res, 200, { ok: true });
      }

      if (!config.apiKey) throw new HttpError(503, 'API_KEY is not configured; operational APIs disabled');
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
      if (!safeEqual(bearer, config.apiKey) && !safeEqual(req.headers['x-api-key'], config.apiKey)) throw new HttpError(401, 'Missing or invalid API authentication');

      if (req.method === 'GET' && url.pathname === '/') {
        queryFields(url, []);
        return json(res, 200, {
          name: 'signalwire-sms-tester', version,
          endpoints: { 'GET /health': 'Public liveness; no SMS', 'POST /tests': 'JSON {to?, timeoutMs?}; 201 after creation', 'GET /tests': 'Recent tests; limit?', 'GET /tests/{test_id}': 'Inspect a test', 'GET /checks/round-trip': 'Sends one SMS; to?, timeoutMs?, waitTimeoutMs?; 200 on pass, 503 while pending/failed; upstream errors 502/504', 'POST /messages': 'Diagnostic SMS; JSON {to?, body}; 201', 'GET /messages': 'Safe message summaries; limit?', 'GET /events': 'Safe recent events; limit?', 'POST /webhooks/signalwire/status': 'Provider-authenticated form POST', 'POST /webhooks/signalwire/inbound': 'Provider-authenticated form POST; empty cXML' },
          authentication: 'Authorization: Bearer <API_KEY> or X-API-Key; query keys rejected',
          passCriteria: ['signalWireMessageCreated', 'signalWireStatus', 'inboundSmsMatched', ...(config.requireDeliveredStatus ? ['signalWireDelivered'] : [])],
          limits: { testTimeoutMs: config.testTimeoutMs, maxTimeoutMs: MAX_TIMEOUT_MS, requestTimeoutMs: config.requestTimeoutMs, maxActiveTests: config.maxActiveTests, minSendIntervalMs: config.minSendIntervalMs, maxBodyBytes: MAX_BODY_BYTES, maxMessageChars: MAX_MESSAGE_CHARS, maxRecentEvents: 500, maxTerminalTests: 1000, maxMessages: 1000, terminalRetentionMs: 86_400_000 },
          configuration: { sendConfigured: sendConfigurationErrors(config).length === 0, verifyWebhooks: config.verifyWebhooks, requireDeliveredStatus: config.requireDeliveredStatus, defaultDestinationConfigured: Boolean(config.defaultTo), inboundUsesSeparateProject: config.projectId !== config.inboundProjectId },
        });
      }
      if (req.method === 'GET' && url.pathname === '/tests') return json(res, 200, { tests: store.list(limitQuery(url, 1000)) });
      if (req.method === 'GET' && /^\/tests\/[^/]+$/.test(url.pathname)) {
        queryFields(url, []);
        const test = store.get(url.pathname.slice(7));
        if (!test) throw new HttpError(404, 'Test not found');
        return json(res, 200, { test });
      }
      if (req.method === 'GET' && url.pathname === '/messages') return json(res, 200, { messages: store.listMessages(limitQuery(url, 1000)) });
      if (req.method === 'GET' && url.pathname === '/events') return json(res, 200, { events: store.logger.recent(limitQuery(url)) });

      const check = req.method === 'GET' && url.pathname === '/checks/round-trip';
      const testPost = req.method === 'POST' && url.pathname === '/tests';
      const raw = req.method === 'POST' && url.pathname === '/messages';
      if (check || testPost || raw) {
        readyToSend();
        let input;
        if (check) input = queryFields(url, ['to', 'timeoutMs', 'waitTimeoutMs']);
        else {
          queryFields(url, []);
          const text = await readBody(req, 'application/json');
          try { input = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
          fields(input, raw ? ['to', 'body'] : ['to', 'timeoutMs']);
        }
        const to = destination(config, input.to);
        if (raw) {
          if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `body must contain 1–${MAX_MESSAGE_CHARS} characters`);
          if (input.body.trim().startsWith('swsms:v1:')) throw new HttpError(400, 'Round-trip bodies are reserved for test endpoints');
          store.reserveSend(false);
          const id = randomUUID(), createdAt = new Date(now()).toISOString();
          const summary = { id, projectId: config.projectId, direction: 'outbound', from: config.from, to, createdAt, bodyLength: input.body.length };
          store.message({ ...summary, status: 'starting' });
          store.recordEvent(null, 'raw_send_started', { messageId: id, direction: 'outbound', from: config.from, to });
          const result = await track((async () => {
            try {
              const { sid } = await createMessage(config, { to, body: input.body, callbackUrl: statusCallbackUrl(config), deadline: now() + config.requestTimeoutMs }, { fetch, now });
              const message = { ...summary, sid, outboundMessageSid: sid, status: 'created' };
              store.messages.delete(`${config.projectId}:outbound:${id}`);
              store.message(message);
              store.recordEvent(null, 'raw_send_accepted', { messageId: id, outboundMessageSid: sid, direction: 'outbound' });
              return { message };
            } catch (error) {
              const safe = error instanceof HttpError ? error : new HttpError(502, 'Provider send failed; send outcome uncertain');
              store.message({ ...summary, status: 'failed', reason: safe.message, uncertain: error.uncertain ?? true });
              store.recordEvent(null, 'raw_send_failed', { messageId: id, reason: safe.message });
              return { error: safe };
            }
          })());
          if (result.error) throw result.error;
          return json(res, 201, result);
        }
        const timeoutMs = duration(input.timeoutMs, config.testTimeoutMs, check);
        const waitTimeoutMs = check ? Math.min(duration(input.waitTimeoutMs, config.testTimeoutMs, true), timeoutMs) : undefined;
        const test = store.createTest(to, timeoutMs);
        const sending = track(sendTest(test));
        if (check) {
          const result = await waitForTest(store, test.id, Date.parse(test.createdAt) + waitTimeoutMs, res, now);
          if (result) return json(res, result.ok ? 200 : (result.sendErrorStatus || 503), { ok: result.ok, reason: result.reason, testId: result.id, waitTimeoutMs, test: result });
          return;
        }
        const error = await sending;
        const result = store.get(test.id);
        if (error) return json(res, error.status, { ok: false, reason: error.reason, testId: test.id, test: result });
        return json(res, 201, { test: result });
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (!(error instanceof HttpError)) store.logger.log('request_error', { reason: 'Internal request error' });
      const safe = error instanceof HttpError ? error : new HttpError(500, 'Internal server error');
      const { retryAfter, ...details } = safe.details;
      json(res, safe.statusCode, { ok: false, reason: safe.message, ...details }, retryAfter ? { 'retry-after': String(retryAfter) } : {});
    }
  };
  const server = http.createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  return {
    server, handler, operations,
    async shutdown(timeoutMs = 10_000) {
      store.accepting = false;
      let timer;
      await Promise.race([
        Promise.all([
          new Promise(resolveClose => { server.close(() => resolveClose()); }),
          Promise.allSettled([...operations]),
        ]).then(() => undefined),
        new Promise(resolveClose => { timer = setTimeout(() => { server.closeAllConnections(); resolveClose(); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      store.close();
      await store.logger.flush();
    },
  };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ dataDir: config.dataDir, secrets: [config.apiKey, config.token, config.signingKey, config.inboundSigningKey, Buffer.from(`${config.projectId}:${config.token}`).toString('base64')] });
  await logger.ready;
  const store = new Store(config, logger);
  const app = createApp(config, store);
  app.server.listen(config.port, config.host, () => logger.log('service_started', { port: config.port, verifyWebhooks: config.verifyWebhooks }));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    app.shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Unable to start: check configuration and DATA_DIR permissions\n'); process.exitCode = 1; });
}
