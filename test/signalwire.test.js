import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessage } from '../src/signalwire.js';
import { createConfig } from '../src/config.js';
import { ENV, B, providerResponse } from '../test-support/helpers.js';

const config = createConfig(ENV);
const options = () => ({ to: B, body: 'body + & text', callbackUrl: 'https://sms.test/status?fixed=1&test_id=id', deadline: Date.now() + 10000 });

test('Compatibility Messages URL, Basic authentication, form encoding, redirect policy', async () => {
  const result = await createMessage(config, options(), { fetch: async (url, init) => {
    assert.equal(url, `${config.baseUrl}/Accounts/outbound-project/Messages`);
    assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${config.projectId}:${config.token}`).toString('base64')}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.accept, 'application/json');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('From'), ENV.SIGNALWIRE_FROM);
    assert.equal(form.get('To'), B);
    assert.equal(form.get('Body'), 'body + & text');
    assert.equal(form.get('StatusCallback'), options().callbackUrl);
    return providerResponse();
  } });
  assert.deepEqual(result, { sid: 'outbound-1' });
});

test('safe upstream failures and ambiguous transport outcomes never retry', async () => {
  const cases = [
    [() => new Response('password=provider-secret', { status: 401 }), 502, false],
    [() => new Response('<html>failure</html>', { status: 500 }), 502, true],
    [() => new Response('not JSON', { status: 201 }), 502, true],
    [() => new Response('{}', { status: 201 }), 502, true],
    [() => new Response('{"sid":"invalid sid"}', { status: 201 }), 502, true],
    [() => { throw new Error('token=provider-secret'); }, 502, true],
  ];
  for (const [response, statusCode, uncertain] of cases) {
    let calls = 0;
    await assert.rejects(createMessage(config, options(), { fetch: async () => { calls++; return response(); } }), error => error.statusCode === statusCode && error.uncertain === uncertain && !error.message.includes('provider-secret'));
    assert.equal(calls, 1);
  }
});

test('timeout covers transport and response body, bounded by test deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const bodyStall of [false, true]) {
    let signal, calls = 0;
    const pending = createMessage(config, { ...options(), deadline: 125 }, { now: () => 100, fetch: async (_, init) => {
      signal = init.signal; calls++;
      if (!bodyStall) return new Promise(() => {});
      return new Response(new ReadableStream({ start() {} }), { status: 201 });
    } });
    await Promise.resolve();
    t.mock.timers.tick(26);
    await assert.rejects(pending, error => error.statusCode === 504 && error.uncertain);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});
