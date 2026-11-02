import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, deferred } from '../test-support/helpers.js';

test('serialized append/rotation retains valid JSONL and one backup, with redaction before stdout/disk', async t => {
  let output = '';
  const { logger, dataDir, config } = await setup(t, { loggerOptions: { maxBytes: 600, stdout: line => { output += line; } } });
  for (let i = 0; i < 30; i++) logger.log('example', { index: i, authorization: 'Bearer hidden', token: config.token, body: 'unrelated-private-text', nested: { 'x-signalwire-signature': 'hidden', harmless: `prefix ${config.signingKey}` } });
  await logger.flush();
  assert.deepEqual((await readdir(dataDir)).sort(), ['events.jsonl', 'events.jsonl.1']);
  const current = await readFile(join(dataDir, 'events.jsonl'), 'utf8');
  const backup = await readFile(join(dataDir, 'events.jsonl.1'), 'utf8');
  for (const line of `${current}${backup}`.trim().split('\n')) assert.equal(JSON.parse(line).type, 'example');
  for (const secret of [config.token, config.signingKey, 'unrelated-private-text', 'Bearer hidden']) {
    assert.equal(output.includes(secret), false);
    assert.equal(`${current}${backup}`.includes(secret), false);
  }
  assert.equal(JSON.parse(current.trim().split('\n').at(-1)).index, 29);
});

test('slow log output bounds pending events and bytes, then reports dropped events on recovery', async t => {
  const entered = deferred(), release = deferred();
  let output = '';
  const { logger, dataDir } = await setup(t, { loggerOptions: {
    maxPendingEvents: 3, maxPendingBytes: 8192,
    stdout: async line => { output += line; if (!output.includes('burst')) { entered.resolve(); await release.promise; } },
  } });
  logger.log('blocked');
  await entered.promise;
  try {
    for (let i=0;i<1000;i++) logger.log('burst', { index: i });
    assert.equal(logger.pending().events, 3);
    assert.ok(logger.pending().bytes <= 8192);
    assert.equal(logger.pending().dropped, 998);
  } finally { release.resolve(); }
  await logger.flush();
  assert.deepEqual(logger.pending(), { events: 0, bytes: 0, dropped: 0 });
  const rows=(await readFile(join(dataDir,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.filter(row=>row.type==='burst').length,2);
  assert.equal(rows.find(row=>row.type==='log_dropped').count,998);
  assert.equal(output.includes('log_dropped'),true);
});

test('oversized queued log lines are dropped without unbounded buffering and flush reports the loss', async t => {
  let output='';
  const { logger }=await setup(t,{loggerOptions:{maxPendingBytes:8192,stdout:line=>{output+=line;}}});
  logger.log('oversized',{a:'x'.repeat(2048),b:'x'.repeat(2048),c:'x'.repeat(2048),d:'x'.repeat(2048)});
  assert.deepEqual(logger.pending(),{events:0,bytes:0,dropped:1});
  await logger.flush();
  assert.deepEqual(logger.pending(),{events:0,bytes:0,dropped:0});
  assert.equal(JSON.parse(output.trim()).type,'log_dropped');
  assert.equal(JSON.parse(output.trim()).count,1);
});
