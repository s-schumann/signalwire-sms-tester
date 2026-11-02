import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ENV, A, B, providerResponse, deferred, statusForm, inboundForm } from '../test-support/helpers.js';
import { statusCallbackUrl, signForm } from '../src/signature.js';

test('health needs no credentials or SMS; all operational routes require header authentication', async t => {
  let calls = 0;
  const h = await setup(t, { server: true, fetch: async () => { calls++; return providerResponse(); } });
  assert.equal((await h.request('/health', { headers: { authorization: '' } })).status, 200);
  assert.equal((await h.request('/', { headers: { authorization: '' } })).status, 401);
  assert.equal((await h.request('/', { headers: { authorization: '', 'x-api-key': h.config.apiKey } })).status, 200);
  assert.equal((await h.request('/?api_key=anything')).status, 400);
  const index = await (await h.request('/')).json();
  for (const secret of [h.config.token, h.config.apiKey, h.config.signingKey, h.config.baseUrl]) assert.equal(JSON.stringify(index).includes(secret), false);
  assert.equal(calls, 0);
  const unconfigured = await setup(t, { server: true, env: { API_KEY: '', SIGNALWIRE_PROJECT_ID: '', SIGNALWIRE_TOKEN: '', SIGNALWIRE_SIGNING_KEY: '' }, fetch: async () => { calls++; return providerResponse(); } });
  assert.equal((await unconfigured.request('/health')).status, 200);
  for (const route of ['/tests', '/messages']) assert.equal((await unconfigured.post(route, { body: 'hello' })).status, 503);
  assert.equal((await unconfigured.request('/checks/round-trip')).status, 503);
  assert.equal(calls, 0);
});

test('generated SMS, signed callbacks, empty cXML and exact evidence produce a pass', async t => {
  let sent;
  const h = await setup(t, { server: true, fetch: async (_, init) => { sent = new URLSearchParams(init.body); return providerResponse(); } });
  const response = await h.post('/tests');
  assert.equal(response.status, 201);
  const { test: run } = await response.json();
  assert.equal(sent.get('Body'), run.body);
  assert.equal(sent.get('From'), A);
  assert.equal(sent.get('To'), B);
  const callback = new URL(sent.get('StatusCallback'));
  assert.equal(callback.searchParams.get('test_id'), run.id);
  // A status payload containing the unique Body must never count as receipt.
  assert.equal((await h.webhook('status', statusForm({ Body: run.body, MessageStatus: 'DELIVERED' }), { query: callback.search })).status, 200);
  assert.deepEqual(h.store.get(run.id).missing, ['inboundSmsMatched']);
  const receipt = await h.webhook('inbound', inboundForm(run));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(await receipt.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  const result = await (await h.request(`/tests/${run.id}`)).json();
  assert.equal(result.test.ok, true);
  assert.equal(result.test.outboundMessageSid, 'outbound-1');
  assert.equal(result.test.inboundMessageSid, 'inbound-1');
  assert.equal((await h.webhook('inbound', inboundForm(run))).status, 200);
  assert.deepEqual(h.store.get(run.id), result.test);
  assert.equal((await h.request('/tests/not-found')).status, 404);
  const messages = await (await h.request('/messages')).json();
  assert.deepEqual(new Set(messages.messages.map(m => m.direction)), new Set(['inbound', 'outbound']));
});

test('sender-ID symbols work end to end for signed form and verification-off JSON callbacks', async t => {
  for (const format of ['form', 'json']) {
    const from = 'A_.-+*,#9';
    let sent;
    const h = await setup(t, { server: true,
      env: { SIGNALWIRE_FROM: from, SIGNALWIRE_VERIFY_WEBHOOKS: format === 'json' ? 'off' : 'on' },
      fetch: async (_, init) => { sent = new URLSearchParams(init.body); return providerResponse(); },
    });
    const response = await h.post('/tests');
    assert.equal(response.status, 201);
    const run = (await response.json()).test;
    assert.equal(run.request.from, from);
    assert.equal(sent.get('From'), from);
    const deliver = (kind, payload, query = '') => format === 'form'
      ? h.webhook(kind, payload, { query })
      : h.post(`/webhooks/signalwire/${kind}${query}`, payload, { headers: { authorization: '' } });
    const query = `?test_id=${run.id}`;
    await deliver('status', statusForm({ From: 'a_.-+*,#9' }), query);
    assert.equal(h.store.get(run.id).expected.signalWireStatus, false);
    await deliver('status', statusForm({ From: from }), query);
    for (const [index, wrongFrom] of ['a_.-+*,#9', 'XA_.-+*,#9', '+12025550999'].entries()) {
      const receipt = await deliver('inbound', inboundForm(run, { From: wrongFrom, MessageSid: `wrong-sender-${index}` }));
      assert.equal(receipt.status, 200);
      assert.equal(h.store.get(run.id).expected.inboundSmsMatched, false);
    }
    const receipt = await deliver('inbound', inboundForm(run, { From: from }));
    assert.equal(receipt.status, 200);
    assert.equal(await receipt.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    assert.equal(h.store.get(run.id).ok, true);
    assert.deepEqual(h.store.get(run.id).missing, []);
  }
});

test('inbound-only sender opt-out completes a held check with rewritten From while preserving validation and status matching', async t => {
  for (const format of ['form', 'json']) {
    const sent = deferred();
    const h = await setup(t, { server: true,
      env: { IGNORE_SENDER_FROM: 'true', SIGNALWIRE_VERIFY_WEBHOOKS: format === 'form' ? 'on' : 'off' },
      fetch: async (_, init) => { sent.resolve(new URL(new URLSearchParams(init.body).get('StatusCallback'))); return providerResponse(); },
    });
    const waiting = h.request('/checks/round-trip?timeoutMs=1000&waitTimeoutMs=1000');
    const callback = await sent.promise;
    const id = callback.searchParams.get('test_id');
    await Promise.all([...h.app.operations]);
    const run = h.store.get(id);
    const deliver = (kind, payload, options = {}) => format === 'form'
      ? h.webhook(kind, payload, options)
      : h.post(`/webhooks/signalwire/${kind}${options.query || ''}`, payload, { headers: { authorization: '' } });
    assert.equal((await (await h.request('/')).json()).configuration.ignoreSenderFrom, true);
    assert.equal(run.request.ignoreSenderFrom, true);
    assert.equal((await deliver('status', statusForm({ From: '+12025550999' }), { query: callback.search })).status, 200);
    assert.equal(h.store.get(id).expected.signalWireStatus, false);
    const rejectedStatus = await deliver('status', statusForm({ From: 'rewritten sender' }), { query: callback.search });
    assert.equal(rejectedStatus.status, 400);
    assert.match((await rejectedStatus.json()).reason, /sender From/);
    assert.equal((await deliver('status', statusForm(), { query: callback.search })).status, 200);
    const payload = inboundForm(run, { From: 'private ignored sender / '.repeat(1000), Body: ` \n${run.body}\r\n ` });
    for (const [overrides, reason] of [[{ To: '00491234567890' }, /destination To/], [{ MessageSid: 'bad sid' }, /message SID/]]) {
      const rejected = await deliver('inbound', { ...payload, ...overrides });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).reason, reason);
    }
    assert.equal((await deliver('inbound', { ...payload, AccountSid: 'wrong-project' })).status, 403);
    if (format === 'form') {
      assert.equal((await h.webhook('inbound', payload, { signature: 'invalid' })).status, 403);
      assert.equal((await h.post('/webhooks/signalwire/inbound', payload, { headers: { authorization: '' } })).status, 415);
    }
    assert.deepEqual(h.store.get(id).missing, ['inboundSmsMatched']);
    const receipt = await deliver('inbound', payload);
    assert.equal(receipt.status, 200);
    assert.equal(await receipt.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const response = await waiting;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(h.store.listenerCount(id), 0);
    assert.equal(h.logger.recent().find(event => event.type === 'inbound_matched').senderFromIgnored, true);
    const summaries = await (await h.request('/messages')).json();
    assert.equal(summaries.messages.find(message => message.direction === 'inbound').senderFromIgnored, true);
    assert.equal(JSON.stringify([summaries, h.logger.recent()]).includes('private ignored sender'), false);
  }
});

test('sender opt-out accepts missing inbound form From and discards any JSON From value', async t => {
  for (const [format, from] of [['form', undefined], ['json', undefined], ['json', null], ['json', 491234567890], ['json', { rewritten: true }]]) {
    const h = await setup(t, { server: true, env: { IGNORE_SENDER_FROM: 'true', SIGNALWIRE_VERIFY_WEBHOOKS: format === 'form' ? 'on' : 'off' } });
    const run = (await (await h.post('/tests')).json()).test;
    await h.webhook('status', statusForm(), { query: `?test_id=${run.id}` });
    const payload = inboundForm(run, { From: from });
    if (from === undefined) delete payload.From;
    const receipt = format === 'form' ? await h.webhook('inbound', payload)
      : await h.post('/webhooks/signalwire/inbound', payload, { headers: { authorization: '' } });
    assert.equal(receipt.status, 200);
    assert.equal(h.store.get(run.id).ok, true);
  }
});

test('sender IDs do not allow caller sender overrides or non-E.164 destinations', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_FROM: 'MyBrand' }, fetch: async () => assert.fail('must not send') });
  assert.equal((await h.post('/tests', { from: 'Another' })).status, 400);
  assert.equal((await h.post('/tests', { to: 'OtherBrand' })).status, 400);
  assert.equal((await h.post('/messages', { to: 'OtherBrand', body: 'Test' })).status, 400);
  assert.equal((await h.request('/checks/round-trip?to=OtherBrand')).status, 400);
  assert.equal((await h.webhook('inbound', inboundForm({ body: 'Test' }, { From: 'MyBrand', To: 'OtherBrand' }))).status, 400);
  assert.equal(h.store.list().length, 0);
});

test('input validation and override attempts issue no provider request', async t => {
  let calls = 0;
  const h = await setup(t, { server: true, fetch: async () => { calls++; return providerResponse(); } });
  for (const [input, status] of [[null, 400], [[], 400], [{ body: 'override' }, 400], [{ from: A }, 400], [{ token: 'override' }, 400], [{ callbackUrl: 'https://bad.test' }, 400], [{ baseUrl: 'https://bad.test' }, 400], [{ requireDeliveredStatus: false }, 400], [{ timeoutMs: '10' }, 400], [{ timeoutMs: 0 }, 400], [{ timeoutMs: 1.5 }, 400], [{ timeoutMs: null }, 400], [{ to: 12025550101 }, 400], [{ to: '+1 2025550101' }, 400], [{ to: '+12025550999' }, 403], [{ to: A }, 403]]) assert.equal((await h.post('/tests', input)).status, status, JSON.stringify(input));
  for (const path of ['/checks/round-trip?timeoutMs=Infinity', '/checks/round-trip?timeoutMs=1&timeoutMs=2', '/checks/round-trip?waitTimeoutMs=0', '/checks/round-trip?to=+12025550101', '/checks/round-trip?body=override', '/events?limit=-1', '/events?limit=1&limit=2']) assert.equal((await h.request(path)).status, 400, path);
  for (const field of ['ignoreSenderFrom', 'ignore_sender_from', 'IGNORE_SENDER_FROM']) {
    assert.equal((await h.post('/tests', { [field]: true })).status, 400);
    assert.equal((await h.request(`/checks/round-trip?${field}=true`)).status, 400);
  }
  assert.equal((await h.post('/tests', {}, { body: '{invalid' })).status, 400);
  assert.equal((await h.post('/tests', {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await h.post('/tests', {}, { body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await h.request('/events?limit=999999')).status, 200);
  assert.equal(calls, 0);
});

test('missing signing/receiver/send configuration fails closed without sending', async t => {
  for (const env of [{ SIGNALWIRE_SIGNING_KEY: '' }, { SIGNALWIRE_INBOUND_PROJECT_ID: 'receiver', SIGNALWIRE_INBOUND_SIGNING_KEY: '' }, { SIGNALWIRE_TOKEN: '' }, { ALLOWED_TO_NUMBERS: '' }]) {
    const h = await setup(t, { server: true, env, fetch: async () => assert.fail('must not send') });
    const result = await h.post('/tests');
    assert.equal(result.status, 400);
    const error = await result.json();
    assert.ok(error.variables.length);
    assert.equal(JSON.stringify(error).includes(h.config.token), !h.config.token);
    if (env.SIGNALWIRE_SIGNING_KEY === '') assert.equal((await h.webhook('inbound', inboundForm({ body: 'unrelated' }))).status, 503);
  }
});

test('signatures use all fields, fixed query, exact public URL and independent inbound project/key', async t => {
  const h = await setup(t, { server: true, env: {
    SIGNALWIRE_STATUS_WEBHOOK_URL: 'https://proxy.test/prefix/status?fixed=a%2Fb',
    SIGNALWIRE_INBOUND_WEBHOOK_URL: 'https://receiver.test/prefix/inbound?fixed=%2B1',
    SIGNALWIRE_INBOUND_PROJECT_ID: 'receiver-project', SIGNALWIRE_INBOUND_SIGNING_KEY: 'receiver-secret',
  } });
  const { test: run } = await (await h.post('/tests')).json();
  const form = inboundForm(run, { AccountSid: 'receiver-project', FutureField: 'included in signature' });
  assert.equal((await h.webhook('inbound', form, { signature: 'bad' })).status, 403);
  assert.equal((await h.webhook('inbound', form, { signature: '' })).status, 403);
  assert.equal((await h.webhook('inbound', form, { key: h.config.signingKey })).status, 403);
  assert.equal((await h.webhook('inbound', form, { query: '?fixed=wrong' })).status, 403);
  assert.equal((await h.webhook('inbound', form, { signature: signForm(h.config.inboundSigningKey, h.config.inboundWebhookUrl, { ...form, FutureField: 'changed' }) })).status, 403);
  assert.equal((await h.webhook('inbound', { ...form, AccountSid: 'outbound-project' })).status, 403);
  assert.equal((await h.webhook('inbound', form, { signature: signForm(h.config.inboundSigningKey, 'https://evil.test/prefix/inbound?fixed=%2B1', form), headers: { host: 'evil.test', 'x-forwarded-proto': 'https' } })).status, 403);
  assert.equal((await h.webhook('inbound', form, { header: 'x-twilio-signature', headers: { 'x-forwarded-host': 'ignored.test' } })).status, 200);
  const callback = new URL(statusCallbackUrl(h.config, run.id));
  assert.equal((await h.webhook('status', statusForm(), { query: callback.search })).status, 200);
  assert.equal(h.store.get(run.id).ok, true);
});

test('webhook malformed fields, repeated keys, aliases and unrelated receipts', async t => {
  const h = await setup(t, { server: true });
  const fake = { body: 'unrelated private SMS' };
  for (const field of ['MessageSid', 'From', 'To', 'Body', 'AccountSid']) {
    const form = inboundForm(fake);
    delete form[field];
    assert.equal((await h.webhook('inbound', form)).status, 400, field);
  }
  assert.equal((await h.webhook('inbound', inboundForm(fake, { SmsSid: 'conflict' }))).status, 400);
  assert.equal((await h.request('/webhooks/signalwire/inbound', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'From=a&From=b' })).status, 400);
  const legacy = inboundForm(fake);
  legacy.SmsSid = legacy.MessageSid;
  delete legacy.MessageSid;
  assert.equal((await h.webhook('inbound', legacy)).status, 200);
  const oldStatus = statusForm({ SmsSid: 'unknown', SmsStatus: 'sent' });
  delete oldStatus.MessageSid; delete oldStatus.MessageStatus;
  assert.equal((await h.webhook('status', oldStatus)).status, 200);
  assert.equal(JSON.stringify(h.logger.recent()).includes(fake.body), false);
});

test('unsigned JSON callbacks work with verification off; a plain Test receipt cannot pass', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_VERIFY_WEBHOOKS: 'off', SIGNALWIRE_SIGNING_KEY: '' } });
  const { test: run } = await (await h.post('/tests')).json();
  const options = { headers: { authorization: '' } };
  const callback = `/webhooks/signalwire/status?test_id=${run.id}`;
  const status = await h.post(callback, statusForm({ Body: run.body }), options);
  assert.equal(status.status, 200);
  assert.deepEqual(h.store.get(run.id).missing, ['inboundSmsMatched']);
  // Same Compatibility JSON shape as the reported receipt, with synthetic IDs/numbers.
  const unrelated = {
    ...inboundForm(run, { Body: 'Test', MessageSid: 'unrelated-inbound' }),
    SmsSid: 'unrelated-inbound', SmsMessageSid: 'unrelated-inbound',
    SmsStatus: 'received', MessageStatus: 'received', ApiVersion: '2010-04-01', NumSegments: '1',
  };
  delete unrelated.Direction;
  const acknowledgment = await h.post('/webhooks/signalwire/inbound', unrelated, options);
  assert.equal(acknowledgment.status, 200);
  assert.equal(acknowledgment.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(await acknowledgment.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.equal(h.store.get(run.id).ok, false);
  assert.deepEqual(h.store.get(run.id).missing, ['inboundSmsMatched']);
  const receipt = { ...unrelated, Body: run.body, MessageSid: 'matched-inbound', SmsSid: 'matched-inbound', SmsMessageSid: 'matched-inbound' };
  assert.equal((await h.post('/webhooks/signalwire/inbound', receipt, options)).status, 200);
  assert.equal(h.store.get(run.id).ok, true);
  const frozen = h.store.get(run.id);
  await h.post('/webhooks/signalwire/inbound', receipt, options);
  assert.deepEqual(h.store.get(run.id), frozen);
});

test('JSON accepts numeric counts while project, numbers and required fields stay enforced', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_VERIFY_WEBHOOKS: 'off' } });
  const run = (await (await h.post('/tests')).json()).test;
  const options = { headers: { authorization: '', 'content-type': 'application/json; charset=utf-8' } };
  assert.equal((await h.post('/webhooks/signalwire/inbound', inboundForm(run, { AccountSid: 'other-project' }), options)).status, 403);
  assert.equal((await h.post('/webhooks/signalwire/inbound', inboundForm(run, { From: '+12025550999', MessageSid: 'wrong-sender' }), options)).status, 200);
  assert.equal(h.store.get(run.id).expected.inboundSmsMatched, false);
  const missing = inboundForm(run); delete missing.Body;
  assert.equal((await h.post('/webhooks/signalwire/inbound', missing, options)).status, 400);
  assert.equal((await h.post('/webhooks/signalwire/inbound', inboundForm(run, { NumMedia: 0, NumSegments: 1 }), options)).status, 200);
  assert.equal(h.store.get(run.id).expected.inboundSmsMatched, true);
  assert.deepEqual(h.store.get(run.id).missing, ['signalWireStatus']);
  assert.equal((await h.post(`/webhooks/signalwire/status?test_id=${run.id}`, statusForm({ MessageStatus: 'undelivered', ErrorCode: 30003 }), options)).status, 200);
  assert.equal(h.store.get(run.id).status, 'failed');
  assert.equal(h.store.get(run.id).errorCode, '30003');
});

test('JSON webhooks reject malformed, excessive and unsupported payloads with verification off', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_VERIFY_WEBHOOKS: 'off' } });
  for (const body of ['{invalid', 'null', '[]', '{"Body":1}', '{"Extra":{"nested":true}}']) {
    assert.equal((await h.post('/webhooks/signalwire/inbound', {}, { body, headers: { authorization: '' } })).status, 400);
  }
  assert.equal((await h.post('/webhooks/signalwire/inbound', {}, { body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await h.post('/webhooks/signalwire/inbound', {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('JSON fails closed when verification is on, even with a form-style signature', async t => {
  const h = await setup(t, { server: true });
  const run = (await (await h.post('/tests')).json()).test;
  const payload = inboundForm(run);
  const result = await h.post('/webhooks/signalwire/inbound', payload, { headers: { authorization: '', 'x-signalwire-signature': signForm(h.config.inboundSigningKey, h.config.inboundWebhookUrl, payload) } });
  assert.equal(result.status, 415);
  assert.match((await result.json()).reason, /Signed JSON webhooks are not supported/);
  assert.equal(h.store.get(run.id).expected.inboundSmsMatched, false);
  assert.equal((await h.webhook('inbound', payload)).status, 200);
  assert.equal(h.store.get(run.id).expected.inboundSmsMatched, true);
});

test('atomic active limit and shared cooldown cover raw/test/check endpoints', async t => {
  const gate = deferred();
  let calls = 0;
  const h = await setup(t, { server: true, env: { MIN_SEND_INTERVAL_MS: '100' }, fetch: async () => { calls++; return calls === 1 ? gate.promise : providerResponse('outbound-2'); } });
  const first = h.post('/tests');
  // Wait for the provider invocation without using arbitrary timing delays.
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  const second = await h.post('/tests');
  assert.equal(second.status, 429);
  assert.ok(second.headers.get('retry-after'));
  assert.equal((await h.post('/messages', { body: 'diagnostic' })).status, 429);
  assert.equal((await h.request('/checks/round-trip')).status, 429);
  assert.equal(calls, 1);
  gate.resolve(providerResponse());
  const run = (await (await first).json()).test;
  h.store.failSend(run.id, 'test ended');
  assert.equal((await h.post('/tests')).status, 429);
  h.advance(100);
  assert.equal((await h.post('/messages', { body: 'diagnostic' })).status, 201);
  assert.equal(calls, 2);
});

test('upstream errors leave terminal inspectable tests with safe IDs and no retries', async t => {
  for (const upstream of [() => new Response('secret-provider-text', { status: 401 }), () => new Response('not-json'), () => new Response('{}'), () => { throw new Error('secret-provider-text'); }]) {
    let calls = 0;
    const h = await setup(t, { server: true, fetch: async () => { calls++; return upstream(); } });
    const response = await h.post('/tests');
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.ok(result.testId);
    assert.equal(result.test.status, 'failed');
    assert.equal((await h.request(`/tests/${result.testId}`)).status, 200);
    assert.equal(JSON.stringify(result).includes('secret-provider-text'), false);
    assert.equal(calls, 1);
  }
});

test('a provider SID cannot identify two active tests', async t => {
  const h = await setup(t, { server: true, env: { MAX_ACTIVE_TESTS: '2' } });
  const first = (await (await h.post('/tests')).json()).test;
  h.advance(1);
  const response = await h.post('/tests');
  assert.equal(response.status, 502);
  const second = await response.json();
  assert.equal(second.test.status, 'failed');
  assert.equal(second.test.sendOutcomeUncertain, true);
  assert.equal(h.store.get(first.id).status, 'pending');
});

test('short HTTP wait expires during creation; one send remains tracked and can pass later', async t => {
  const gate = deferred();
  let calls = 0;
  const h = await setup(t, { server: true, fetch: async () => { calls++; return gate.promise; } });
  const response = await h.request('/checks/round-trip?timeoutMs=999999&waitTimeoutMs=5');
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.test.status, 'starting');
  assert.equal(result.test.request.timeoutMs, 600000);
  assert.equal(result.waitTimeoutMs, 5);
  assert.equal(calls, 1);
  assert.equal(h.store.listenerCount(result.testId), 0);
  assert.equal(h.app.operations.size, 1);
  gate.resolve(providerResponse());
  await Promise.all([...h.app.operations]);
  const callback = new URL(statusCallbackUrl(h.config, result.testId));
  await h.webhook('inbound', inboundForm(result.test));
  await h.webhook('status', statusForm(), { query: callback.search });
  assert.equal(h.store.get(result.testId).ok, true);
  assert.equal(calls, 1);
});

test('synchronous check returns immediately on full evidence, including callbacks before API response', async t => {
  let h;
  h = await setup(t, { server: true, fetch: async (_, init) => {
    const sent = new URLSearchParams(init.body);
    const callback = new URL(sent.get('StatusCallback'));
    const run = h.store.get(callback.searchParams.get('test_id'));
    await h.webhook('status', statusForm(), { query: callback.search });
    await h.webhook('inbound', inboundForm(run));
    return providerResponse();
  } });
  const response = await h.request('/checks/round-trip?timeoutMs=1000&waitTimeoutMs=999999');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.waitTimeoutMs, 1000);
  assert.equal(result.test.status, 'ok');
});

test('held JSON check stays pending after inbound and completes on a status callback with null error metadata', async t => {
  const sent = deferred();
  const h = await setup(t, { server: true, env: { SIGNALWIRE_VERIFY_WEBHOOKS: 'off', SIGNALWIRE_FROM: 'MyBrand' }, fetch: async (_, init) => {
    const fields = new URLSearchParams(init.body);
    sent.resolve(new URL(fields.get('StatusCallback')).searchParams.get('test_id'));
    return providerResponse();
  } });
  const waiting = h.request('/checks/round-trip?timeoutMs=1000&waitTimeoutMs=1000');
  const id = await sent.promise;
  await Promise.all([...h.app.operations]);
  const run = h.store.get(id);
  assert.equal((await h.post('/webhooks/signalwire/inbound', inboundForm(run, { From: 'MyBrand' }), { headers: { authorization: '' } })).status, 200);
  assert.equal(h.store.get(id).status, 'pending');
  assert.deepEqual(h.store.get(id).missing, ['signalWireStatus']);
  assert.equal(h.store.listenerCount(id), 1);
  assert.deepEqual(h.logger.recent().find(event => event.type === 'inbound_matched').missing, ['signalWireStatus']);
  const callback = statusForm({ From: 'MyBrand', ErrorCode: null, ErrorMessage: null });
  assert.equal((await h.post(`/webhooks/signalwire/status?test_id=${id}`, callback, { headers: { authorization: '' } })).status, 200);
  const response = await waiting;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.test.errorCode, null);
  assert.deepEqual(result.test.missing, []);
  assert.equal(h.store.listenerCount(id), 0);
});

test('held check accepts queued/sent plus receipt, and waits for delivered only when configured', async t => {
  for (const requireDelivered of [false, true]) {
    const sent = deferred();
    const h = await setup(t, { server: true,
      env: { REQUIRE_DELIVERED_STATUS: String(requireDelivered) },
      fetch: async (_, init) => {
        sent.resolve(new URL(new URLSearchParams(init.body).get('StatusCallback')));
        return providerResponse();
      },
    });
    const waiting = h.request('/checks/round-trip?timeoutMs=1000&waitTimeoutMs=1000');
    const callback = await sent.promise;
    const id = callback.searchParams.get('test_id');
    await Promise.all([...h.app.operations]);
    const run = h.store.get(id);
    for (const status of ['queued', 'sent']) {
      assert.equal((await h.webhook('status', statusForm({ MessageStatus: status }), { query: callback.search })).status, 200);
      assert.equal(h.store.get(id).ok, false);
    }
    assert.equal((await h.webhook('inbound', inboundForm(run))).status, 200);
    if (requireDelivered) {
      assert.equal(h.store.get(id).status, 'pending');
      assert.deepEqual(h.store.get(id).missing, ['signalWireDelivered']);
      assert.equal(h.store.listenerCount(id), 1);
      assert.equal((await h.webhook('status', statusForm({ MessageStatus: 'delivered' }), { query: callback.search })).status, 200);
    }
    const response = await waiting;
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.test.missing, []);
    assert.equal(result.test.request.requireDeliveredStatus, requireDelivered);
    assert.equal(result.test.latestProviderStatus, requireDelivered ? 'delivered' : 'sent');
    assert.equal(h.store.listenerCount(id), 0);
  }
});

test('rejected webhooks log bounded metadata and reasons without payloads, signatures or query secrets', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_VERIFY_WEBHOOKS: 'off' } });
  const run = (await (await h.post('/tests')).json()).test;
  const payload = statusForm({ AccountSid: 'unexpected-project', Body: 'private unrelated content', ErrorMessage: 'private provider detail' });
  const path = `/webhooks/signalwire/status?test_id=${run.id}&opaque=private-query-secret`;
  assert.equal((await h.post(path, payload, { headers: { authorization: '', 'x-signalwire-signature': 'private-signature' } })).status, 403);
  assert.equal((await h.post(path, payload, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await h.post(path, payload, { body: '{invalid' })).status, 400);
  const events = h.logger.recent().filter(event => event.type === 'webhook_rejected');
  assert.deepEqual(events.map(event => event.httpStatus), [400, 415, 403]);
  assert.ok(events.every(event => event.webhook === 'status' && event.testId === run.id && event.reason));
  assert.equal(events[2].messageSid, 'outbound-1');
  assert.equal(events[2].projectMatches, false);
  assert.equal(events[1].contentType, 'unsupported');
  const logged = JSON.stringify(events);
  for (const value of ['private unrelated content', 'private provider detail', 'private-query-secret', 'private-signature']) assert.equal(logged.includes(value), false);
  assert.equal(h.store.get(run.id).expected.signalWireStatus, false);
});

test('provider timeout during synchronous check returns 504 with failed test ID', async t => {
  const h = await setup(t, { server: true, env: { SIGNALWIRE_REQUEST_TIMEOUT_MS: '5' }, fetch: async () => new Promise(() => {}) });
  const response = await h.request('/checks/round-trip?waitTimeoutMs=100');
  assert.equal(response.status, 504);
  const result = await response.json();
  assert.equal(result.test.status, 'failed');
  assert.equal(result.test.sendOutcomeUncertain, true);
  assert.equal(result.testId, result.test.id);
});

test('early wait after creation returns pending and deadline later reports the absent evidence', async t => {
  const h = await setup(t, { server: true });
  const response = await h.request('/checks/round-trip?timeoutMs=1000&waitTimeoutMs=5');
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.test.status, 'pending');
  assert.equal(result.test.outboundMessageSid, 'outbound-1');
  assert.equal(h.store.listenerCount(result.testId), 0);
  h.advance(1000);
  h.store.sweep();
  assert.equal(h.store.get(result.testId).status, 'failed');
  assert.deepEqual(h.store.get(result.testId).missing, ['signalWireStatus', 'inboundSmsMatched']);
});

test('client disconnect removes waiter but keeps the single send tracked', async t => {
  const gate = deferred(), entered = deferred();
  const h = await setup(t, { server: true, fetch: async () => { entered.resolve(); return gate.promise; } });
  const controller = new AbortController();
  const request = h.request('/checks/round-trip', { signal: controller.signal });
  await entered.promise;
  const run = h.store.list()[0];
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  for (let i = 0; i < 100 && h.store.listenerCount(run.id); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.listenerCount(run.id), 0);
  assert.equal(h.app.operations.size, 1);
  gate.resolve(providerResponse());
  await Promise.all([...h.app.operations]);
  assert.equal(h.store.get(run.id).status, 'pending');
});

test('raw messages are bounded diagnostics, store no body and cannot create a test pass', async t => {
  let sent;
  const h = await setup(t, { server: true, fetch: async (_, init) => { sent = new URLSearchParams(init.body); return providerResponse(); } });
  for (const body of ['', 123, 'x'.repeat(1601), ' swsms:v1:reserved-test-token ']) assert.equal((await h.post('/messages', { body })).status, 400);
  const response = await h.post('/messages', { body: 'private raw diagnostic' });
  assert.equal(response.status, 201);
  assert.equal(sent.get('Body'), 'private raw diagnostic');
  assert.equal(new URL(sent.get('StatusCallback')).searchParams.has('test_id'), false);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.store.listMessages().length, 1);
  assert.equal(JSON.stringify(h.store.listMessages()).includes('private raw diagnostic'), false);
  assert.equal(JSON.stringify(h.logger.recent()).includes('private raw diagnostic'), false);
});
