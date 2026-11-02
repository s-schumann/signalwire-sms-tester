import { mkdir, appendFile, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SENSITIVE = /authorization|api.?key|token|secret|password|signing.?key|signature|body/i;

export function redact(value, secrets = [], key = '') {
  if (SENSITIVE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets, k)]));
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
    return result.slice(0, 2048);
  }
  return value;
}

export function createLogger({ dataDir, secrets = [], now = Date.now, stdout = line => process.stdout.write(line), maxBytes = 50 * 1024 * 1024, maxEvents = 500 } = {}) {
  const path = join(dataDir, 'events.jsonl');
  const events = [];
  let failure;
  const ready = mkdir(dataDir, { recursive: true }).then(() => appendFile(path, ''));
  let queue = ready.catch(() => { failure = new Error('Event log unavailable'); });
  function log(type, fields = {}) {
    const event = redact({ ...fields, id: randomUUID(), time: new Date(now()).toISOString(), type }, secrets);
    events.push(event);
    if (events.length > maxEvents) events.shift();
    const line = `${JSON.stringify(event)}\n`;
    stdout(line);
    queue = queue.then(async () => {
      const size = (await stat(path)).size;
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${path}.1`, { force: true });
        await rename(path, `${path}.1`);
      }
      await appendFile(path, line);
    }).catch(() => {
      failure = new Error('Event log write failed');
      stdout('{"type":"log_error","reason":"Event log write failed"}\n');
    });
    return event;
  }
  return {
    ready, log, recent: (limit = 100) => structuredClone(events.slice(-limit).reverse()),
    async flush() { await queue; if (failure) throw failure; },
  };
}
