import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, loadDotEnv, sendConfigurationErrors, webhookConfigurationErrors, isE164, isSenderId, isSmsSender, isSid, isTestId } from '../src/config.js';
import { ENV } from '../test-support/helpers.js';

test('dotenv supports blank, quoted, comments and existing environment without exposing values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sms-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  await writeFile(path, 'A=file\nB="hello # text" # note\nC=\nD=bare # comment\nE=\'quoted\'\nF="line\\ntext"\n');
  const env = { A: 'environment', C: '' };
  loadDotEnv(env, path);
  assert.deepEqual(env, { A: 'environment', B: 'hello # text', C: '', D: 'bare', E: 'quoted', F: 'line\ntext' });
  await writeFile(path, 'A="unterminated-secret');
  assert.throws(() => loadDotEnv({}, path), /^Error: Invalid .env quoting at line 1$/);
  assert.deepEqual(loadDotEnv({}, join(dir, 'missing')), {});
});

test('configuration defaults, caps and strict values', () => {
  const config = createConfig(ENV, { root: '/tmp/isolated' });
  assert.equal(config.testTimeoutMs, 120000);
  assert.equal(config.requireDeliveredStatus, false);
  assert.equal(config.ignoreSenderFrom, false);
  assert.equal(createConfig({ ...ENV, IGNORE_SENDER_FROM: 'true' }).ignoreSenderFrom, true);
  assert.equal(createConfig({ ...ENV, IGNORE_SENDER_FROM: 'false' }).ignoreSenderFrom, false);
  assert.equal(createConfig({ ...ENV, REQUIRE_DELIVERED_STATUS: 'false' }).requireDeliveredStatus, false);
  assert.equal(createConfig({ ...ENV, REQUIRE_DELIVERED_STATUS: 'true' }).requireDeliveredStatus, true);
  assert.equal(config.dataDir, '/tmp/isolated/data');
  assert.deepEqual(sendConfigurationErrors(config), []);
  assert.equal(createConfig({ ...ENV, TEST_TIMEOUT_MS: '700000' }).testTimeoutMs, 600000);
  for (const [name, value] of [['TEST_TIMEOUT_MS', 'NaN'], ['MIN_SEND_INTERVAL_MS', '0'], ['PORT', '-1'], ['SIGNALWIRE_REQUEST_TIMEOUT_MS', '1.5'], ['MAX_ACTIVE_TESTS', 'Infinity'], ['REQUIRE_DELIVERED_STATUS', 'yes'], ['IGNORE_SENDER_FROM', 'yes'], ['SIGNALWIRE_VERIFY_WEBHOOKS', 'false']]) {
    assert.throws(() => createConfig({ ...ENV, [name]: value }), new RegExp(name));
  }
  for (const value of ['2025550100', '+1 2025550100', ' +12025550100', '+01234567', '+1234567890123456', '+12025550100\n', '+12025550100\r']) assert.equal(isE164(value), false);
});

test('sender follows the requested E.164 or 1–11 ASCII sender-ID grammar; destinations remain E.164', () => {
  for (const from of ['A', 'Brand123', 'MixedCase', 'Brand-1', 'A_.-+*,#9', '12345678901', '_', '.', '-', '+', '*', ',', '#', '+Brand', '+01234567']) {
    assert.equal(isSenderId(from), true, from);
    assert.equal(isSmsSender(from), true, from);
    assert.deepEqual(sendConfigurationErrors(createConfig({ ...ENV, SIGNALWIRE_FROM: from })), []);
  }
  assert.equal(isSmsSender(ENV.SIGNALWIRE_FROM), true);
  assert.equal(isSmsSender('+123456789012345'), true);
  for (const from of ['', '123456789012', 'Brand1234567', '+1234567890123456', 'Älpha', 'My Brand2', 'Brand/', 'Brand:', 'Brand@', ' Brand', 'Brand ', 'Brand\n', 'Brand\t', null, 123]) {
    assert.equal(isSenderId(from), false, String(from));
    assert.equal(isSmsSender(from), false, String(from));
  }
  for (const from of ['123456789012', 'Brand1234567', 'My Brand2']) assert.ok(sendConfigurationErrors(createConfig({ ...ENV, SIGNALWIRE_FROM: from })).includes('SIGNALWIRE_FROM'));
  assert.ok(sendConfigurationErrors(createConfig({ ...ENV, DEFAULT_TO: 'Brand123' })).includes('DEFAULT_TO'));
  assert.ok(sendConfigurationErrors(createConfig({ ...ENV, ALLOWED_TO_NUMBERS: 'Brand123' })).includes('ALLOWED_TO_NUMBERS'));
});

test('message and test IDs reject line terminators and noncanonical token shapes', () => {
  assert.equal(isSid('message_sid-123'), true);
  assert.equal(isSid('x'.repeat(128)), true);
  for (const sid of ['', 'x'.repeat(129), 'sid\n', 'sid\r', 'sid\u2028', 'sid\u2029', 'bad sid', null]) assert.equal(isSid(sid), false);
  const id = 'ac59184c-2482-49e5-bee7-12eecd1cab20';
  assert.equal(isTestId(id), true);
  for (const value of [id+'\n', id.replace('-49e5-', '-19e5-'), 'private-query-marker', '-'.repeat(36), null]) assert.equal(isTestId(value), false);
});

test('separate receiver project needs its signing key, explicit URLs keep verification enabled', () => {
  const config = createConfig({ ...ENV, SIGNALWIRE_INBOUND_PROJECT_ID: 'receiver-project', SIGNALWIRE_STATUS_WEBHOOK_URL: 'https://proxy.test/prefix/status?fixed=1' });
  assert.equal(config.verifyWebhooks, true);
  assert.equal(config.inboundSigningKey, '');
  assert.deepEqual(webhookConfigurationErrors(config, true), ['SIGNALWIRE_INBOUND_SIGNING_KEY']);
  assert.ok(sendConfigurationErrors(config).includes('SIGNALWIRE_INBOUND_SIGNING_KEY'));
  assert.ok(sendConfigurationErrors(createConfig({ ...ENV, SIGNALWIRE_SIGNING_KEY: '' })).includes('SIGNALWIRE_SIGNING_KEY'));
  assert.deepEqual(sendConfigurationErrors(createConfig({ ...ENV, SIGNALWIRE_VERIFY_WEBHOOKS: 'off', SIGNALWIRE_SIGNING_KEY: '' })), []);
});

test('missing configuration, URL credentials, query test IDs, invalid allowlists and A-to-A are rejected', () => {
  assert.ok(sendConfigurationErrors(createConfig({})).includes('SIGNALWIRE_TOKEN'));
  for (const overrides of [{ ALLOWED_TO_NUMBERS: '' }, { ALLOWED_TO_NUMBERS: ENV.SIGNALWIRE_FROM }, { DEFAULT_TO: '+12025550999' }, { PUBLIC_BASE_URL: 'https://example.test/prefix' }, { SIGNALWIRE_BASE_URL: 'https://user:password@example.test/api' }, { SIGNALWIRE_STATUS_WEBHOOK_URL: 'https://sms.test/status?test_id=reserved' }, { SIGNALWIRE_INBOUND_WEBHOOK_URL: 'https://sms.test/inbound?a=1&a=2' }]) {
    assert.ok(sendConfigurationErrors(createConfig({ ...ENV, ...overrides })).length > 0);
  }
});
