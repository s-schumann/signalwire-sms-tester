import { mkdir, appendFile, stat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

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

function writeStdout(line) {
  if (!process.stdout.write(line)) return once(process.stdout, 'drain');
}

export function createLogger({ dataDir, secrets = [], now = Date.now, stdout = writeStdout, maxBytes = 50 * 1024 * 1024, maxEvents = 500, maxPendingBytes = 1024 * 1024, maxPendingEvents = 1000 } = {}) {
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 4096 || !Number.isSafeInteger(maxPendingEvents) || maxPendingEvents < 1) throw new Error('Invalid pending log limits');
  const path = join(dataDir, 'events.jsonl');
  const events = [];
  let failure;
  let pendingBytes = 0, pendingEvents = 0, dropped = 0;
  const ready = mkdir(dataDir, { recursive: true }).then(() => appendFile(path, ''));
  let queue = ready.catch(() => { failure = new Error('Event log unavailable'); });
  function reportDropped() {
    if (dropped && pendingEvents < maxPendingEvents && pendingBytes + 4096 <= maxPendingBytes) {
      const count = dropped;
      dropped = 0;
      log('log_dropped', { count, reason: 'Pending event log limit reached' });
    }
  }
  function log(type, fields = {}) {
    const event = redact({ ...fields, id: randomUUID(), time: new Date(now()).toISOString(), type }, secrets);
    events.push(event);
    if (events.length > maxEvents) events.shift();
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (pendingEvents >= maxPendingEvents || pendingBytes + bytes > maxPendingBytes) {
      dropped++;
      return event;
    }
    pendingEvents++;
    pendingBytes += bytes;
    queue = queue.then(async () => {
      // Honor pipe backpressure inside the same bounded queue as disk writes.
      await stdout(line);
      const size = (await stat(path)).size;
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${path}.1`, { force: true });
        await rename(path, `${path}.1`);
      }
      await appendFile(path, line);
    }).catch(async () => {
      failure = new Error('Event log write failed');
      try { await stdout('{"type":"log_error","reason":"Event log write failed"}\n'); } catch { /* Flush reports the failure. */ }
    }).finally(() => {
      pendingEvents--;
      pendingBytes -= bytes;
      // Report overload once capacity is available, without retaining payloads.
      reportDropped();
    });
    return event;
  }
  return {
    ready, log, recent: (limit = 100) => structuredClone(events.slice(-limit).reverse()),
    pending: () => ({ events: pendingEvents, bytes: pendingBytes, dropped }),
    async flush() {
      let observed;
      do { reportDropped(); observed = queue; await observed; } while (observed !== queue);
      if (failure) throw failure;
    },
  };
}
