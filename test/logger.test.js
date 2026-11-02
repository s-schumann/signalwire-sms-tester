import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from '../test-support/helpers.js';

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
