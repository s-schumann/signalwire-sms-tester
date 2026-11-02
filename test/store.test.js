import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, B, statusEvent, inboundEvent } from '../test-support/helpers.js';

test('all evidence is required, and inbound/outbound SIDs are distinct', async t => {
  const { store } = await setup(t);
  const run = store.createTest(B, 1000);
  assert.match(run.body, /^swsms:v1:[a-f0-9-]{36}:[a-f0-9]{32}$/);
  store.markCreated(run.id, 'outbound-1');
  assert.deepEqual(store.get(run.id).missing, ['signalWireStatus', 'inboundSmsMatched']);
  store.receiveStatus(statusEvent(run, { status: 'delivered' }));
  assert.equal(store.get(run.id).ok, false);
  assert.deepEqual(store.get(run.id).missing, ['inboundSmsMatched']);
  store.receiveInbound(inboundEvent(run));
  const result = store.get(run.id);
  assert.equal(result.status, 'ok');
  assert.equal(result.ok, true);
  assert.notEqual(result.inboundMessageSid, result.outboundMessageSid);
  assert.deepEqual(result.missing, []);
});

test('inbound first still requires status, and callbacks may precede send response', async t => {
  for (const order of [['inbound', 'status', 'created'], ['status', 'inbound', 'created'], ['inbound', 'created', 'status'], ['created', 'status', 'inbound']]) {
    const { store } = await setup(t);
    const run = store.createTest(B, 1000);
    for (const operation of order) {
      if (operation === 'created') store.markCreated(run.id, 'outbound-1');
      if (operation === 'inbound') store.receiveInbound(inboundEvent(run));
      if (operation === 'status') store.receiveStatus(statusEvent(run));
      if (operation !== order.at(-1)) assert.equal(store.get(run.id).ok, false);
    }
    assert.equal(store.get(run.id).ok, true);
  }
});

test('wrong body, nonce, version, numbers, project, direction, media never match', async t => {
  const { store } = await setup(t);
  const run = store.createTest(B, 1000);
  store.markCreated(run.id, 'outbound-1');
  store.receiveStatus(statusEvent(run));
  const invalid = [
    { body: `${run.body} extra` }, { body: `prefix ${run.body}` }, { body: run.body.slice(0, -1) },
    { body: run.body.replace('v1', 'v2') }, { body: run.body.replace(/.$/, run.body.endsWith('a') ? 'b' : 'a') },
    { from: '+12025550999' }, { to: '+12025550999' }, { from: undefined }, { to: undefined },
    { projectId: 'other-project' }, { direction: 'outbound-api' }, { hasMedia: true },
  ];
  invalid.forEach((overrides, index) => store.receiveInbound(inboundEvent(run, { sid: `invalid-${index}`, ...overrides })));
  assert.equal(store.get(run.id).expected.inboundSmsMatched, false);
  assert.equal(JSON.stringify(store.listMessages()).includes(run.body), false);
  store.receiveInbound(inboundEvent(run, { body: ` \n${run.body}\r\n ` }));
  assert.equal(store.get(run.id).ok, true);
});

test('strict delivery mode waits for delivered; inbound alone misses callback evidence', async t => {
  const { store } = await setup(t, { env: { REQUIRE_DELIVERED_STATUS: 'true' } });
  const run = store.createTest(B, 1000);
  store.markCreated(run.id, 'outbound-1');
  store.receiveInbound(inboundEvent(run));
  assert.deepEqual(store.get(run.id).missing, ['signalWireStatus', 'signalWireDelivered']);
  for (const status of ['received', 'receiving', 'unknown']) store.receiveStatus(statusEvent(run, { status }));
  assert.equal(store.get(run.id).expected.signalWireStatus, false);
  store.receiveStatus(statusEvent(run));
  assert.deepEqual(store.get(run.id).missing, ['signalWireDelivered']);
  store.receiveStatus(statusEvent(run, { status: 'delivered' }));
  assert.equal(store.get(run.id).ok, true);
  assert.equal(store.get(run.id).request.requireDeliveredStatus, true);
});

test('failed and undelivered fail explicitly even when there is no missing evidence', async t => {
  for (const status of ['failed', 'undelivered']) {
    const { store } = await setup(t);
    const run = store.createTest(B, 1000);
    store.receiveInbound(inboundEvent(run));
    // Even a success-looking early callback cannot hide an already staged failure.
    store.receiveStatus(statusEvent(run));
    store.receiveStatus(statusEvent(run, { status, errorCode: '30003' }));
    store.markCreated(run.id, 'outbound-1');
    const result = store.get(run.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, []);
    assert.match(result.reason, new RegExp(status));
    assert.equal(result.errorCode, '30003');
  }
});

test('mismatching early SID, unknown test ID and conflicting ID/SID cannot fall back', async t => {
  const { store, advance } = await setup(t, { env: { MAX_ACTIVE_TESTS: '2' } });
  const one = store.createTest(B, 1000);
  advance(1);
  const two = store.createTest(B, 1000);
  store.receiveStatus(statusEvent(one, { sid: 'wrong-early-sid' }));
  store.markCreated(one.id, 'outbound-1');
  store.markCreated(two.id, 'outbound-2');
  store.receiveInbound(inboundEvent(one));
  store.receiveInbound(inboundEvent(two, { sid: 'inbound-2' }));
  store.receiveStatus(statusEvent(one, { testId: 'unknown' }));
  store.receiveStatus(statusEvent(two, { sid: 'outbound-1' }));
  assert.equal(store.get(one.id).ok, false);
  assert.equal(store.get(two.id).ok, false);
  store.receiveStatus(statusEvent(one, { testId: undefined }));
  assert.equal(store.get(one.id).ok, true);
  assert.equal(store.get(two.id).ok, false);
  store.receiveStatus(statusEvent(two, { sid: 'outbound-2' }));
  assert.equal(store.get(two.id).ok, true);
});

test('deduplication preserves first timestamps and terminal results are immutable', async t => {
  const { store, advance } = await setup(t);
  const run = store.createTest(B, 1000);
  store.markCreated(run.id, 'outbound-1');
  store.receiveInbound(inboundEvent(run));
  const first = store.get(run.id);
  advance(100);
  store.receiveInbound(inboundEvent(run));
  store.receiveInbound(inboundEvent(run, { sid: 'another-inbound' }));
  assert.equal(store.get(run.id).inboundReceivedAt, first.inboundReceivedAt);
  assert.equal(store.get(run.id).inboundLatencyMs, first.inboundLatencyMs);
  store.receiveStatus(statusEvent(run));
  const done = store.get(run.id);
  advance(10);
  store.receiveStatus(statusEvent(run));
  store.receiveStatus(statusEvent(run, { status: 'failed' }));
  store.receiveInbound(inboundEvent(run, { sid: 'late-inbound' }));
  store.failSend(run.id, 'late transport error');
  assert.deepEqual(store.get(run.id), done);
  assert.ok(store.logger.recent().some(event => event.type === 'status_unmatched'));
});

test('expiry runs without reads for starting and pending, exact deadline is late', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { store, advance } = await setup(t, { env: { MAX_ACTIVE_TESTS: '2' }, storeOptions: { sweepIntervalMs: 5 } });
  const one = store.createTest(B, 100);
  advance(1);
  const two = store.createTest(B, 99);
  store.markCreated(two.id, 'outbound-2');
  advance(99);
  t.mock.timers.tick(5);
  assert.equal(store.tests.get(one.id).record.status, 'failed');
  assert.equal(store.tests.get(two.id).record.status, 'failed');
  const snapshot = store.get(two.id);
  store.receiveInbound(inboundEvent(two));
  store.receiveStatus(statusEvent(two, { sid: 'outbound-2' }));
  assert.deepEqual(store.get(two.id), snapshot);
  assert.match(snapshot.reason, /deadline/);
});

test('fresh runs cannot reuse old bodies; cooldown and active slots are synchronous', async t => {
  const { store, advance } = await setup(t, { env: { MIN_SEND_INTERVAL_MS: '100' } });
  const old = store.createTest(B, 1000);
  assert.throws(() => store.createTest(B, 1000), error => error.statusCode === 429);
  store.failSend(old.id, 'uncertain', true);
  assert.throws(() => store.reserveSend(false), error => error.statusCode === 429);
  advance(100);
  const run = store.createTest(B, 1000);
  assert.notEqual(old.body, run.body);
  store.receiveInbound(inboundEvent(old));
  assert.equal(store.get(run.id).expected.inboundSmsMatched, false);
});

test('an actual inbound receipt can still fail specifically for missing status evidence', async t => {
  const { store, advance } = await setup(t);
  const run = store.createTest(B, 1000);
  store.markCreated(run.id, 'outbound-1');
  store.receiveInbound(inboundEvent(run));
  advance(1000);
  store.sweep();
  const result = store.get(run.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.expected.inboundSmsMatched, true);
  assert.deepEqual(result.missing, ['signalWireStatus']);
  assert.match(result.reason, /signalWireStatus/);
});

test('duplicate statuses do not change observations, and status/event indexes stay bounded', async t => {
  const { store, advance } = await setup(t);
  const run = store.createTest(B, 1000);
  store.markCreated(run.id, 'outbound-1');
  store.receiveStatus(statusEvent(run));
  const first = store.get(run.id);
  advance(5);
  store.receiveStatus(statusEvent(run));
  assert.deepEqual(store.get(run.id), first);
  for (let i = 0; i < 150; i++) store.receiveStatus(statusEvent(run, { errorCode: `code-${i}` }));
  assert.ok(store.tests.get(run.id).statusSeen.size <= 128);
  assert.ok(store.get(run.id).events.length <= 64);
  assert.equal(store.get(run.id).statusReceivedAt, first.statusReceivedAt);
});

test('terminal retention, message/dedup/event limits preserve active runs', async t => {
  const { store, advance } = await setup(t, { env: { MAX_ACTIVE_TESTS: '2' }, storeOptions: { maxTerminal: 2, maxMessages: 3, maxDedup: 3, retentionMs: 100 }, loggerOptions: { maxEvents: 5 } });
  const active = store.createTest(B, 10000);
  for (let i = 0; i < 6; i++) {
    advance(1);
    const run = store.createTest(B, 10000);
    store.failSend(run.id, 'test failure');
    store.receiveInbound(inboundEvent(run, { sid: `unmatched-${i}`, body: 'private unrelated message' }));
    store.sweep();
  }
  assert.ok(store.tests.size <= 3);
  assert.ok(store.messages.size <= 3);
  assert.ok(store.inboundSeen.size <= 3);
  assert.ok(store.logger.recent(500).length <= 5);
  assert.equal(JSON.stringify(store.logger.recent()).includes('private unrelated message'), false);
  advance(101);
  store.sweep();
  assert.equal(store.tests.size, 1);
  assert.equal(store.get(active.id).status, 'starting');
  assert.equal(store.messages.size, 0);
  assert.equal(store.inboundSeen.size, 0);
});
