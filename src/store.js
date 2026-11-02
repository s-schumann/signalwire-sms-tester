import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';

const OUTBOUND_STATES = new Set(['queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered']);
const FAILURES = new Set(['failed', 'undelivered']);
const BODY_PATTERN = /^swsms:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{32})$/;
const terminal = record => ['ok', 'failed'].includes(record.status);
const iso = value => new Date(value).toISOString();

export class Store extends EventEmitter {
  constructor(config, logger, { now = Date.now, sweepIntervalMs = 1000, maxTerminal = 1000, maxMessages = 1000, retentionMs = 86_400_000, maxDedup = 5000 } = {}) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { config, logger, now, maxTerminal, maxMessages, retentionMs, maxDedup });
    this.tests = new Map();
    this.outboundIndex = new Map();
    this.messages = new Map();
    this.inboundSeen = new Map();
    this.lastSendAt = null;
    this.accepting = true;
    if (sweepIntervalMs) {
      this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.timer.unref();
    }
  }

  close() { clearInterval(this.timer); }

  reserveSend(roundTrip) {
    this.sweep();
    if (!this.accepting) throw new HttpError(503, 'Service is shutting down');
    const active = [...this.tests.values()].filter(row => !terminal(row.record));
    if (roundTrip && active.length >= this.config.maxActiveTests) {
      throw new HttpError(429, 'Active test limit reached', { retryAfter: Math.max(1, Math.ceil((Math.min(...active.map(row => row.deadline)) - this.now()) / 1000)) });
    }
    if (this.lastSendAt !== null && this.now() - this.lastSendAt < this.config.minSendIntervalMs) {
      throw new HttpError(429, 'Minimum send interval has not elapsed', { retryAfter: Math.max(1, Math.ceil((this.lastSendAt + this.config.minSendIntervalMs - this.now()) / 1000)) });
    }
    // Synchronous reservation happens before any network await.
    this.lastSendAt = this.now();
  }

  createTest(to, timeoutMs) {
    this.reserveSend(true);
    const created = this.now(), id = randomUUID();
    const record = {
      id, status: 'starting', ok: false, reason: '',
      expected: { signalWireMessageCreated: false, signalWireStatus: false, inboundSmsMatched: false, ...(this.config.requireDeliveredStatus ? { signalWireDelivered: false } : {}) },
      missing: [], request: { from: this.config.from, to, timeoutMs, requireDeliveredStatus: this.config.requireDeliveredStatus },
      body: `swsms:v1:${id}:${randomBytes(16).toString('hex')}`,
      outboundMessageSid: null, inboundMessageSid: null,
      createdAt: iso(created), timeoutAt: iso(created + timeoutMs), updatedAt: iso(created), finishedAt: null,
      messageCreatedAt: null, inboundReceivedAt: null, inboundLatencyMs: null, statusReceivedAt: null,
      latestProviderStatus: null, errorCode: null, sendOutcomeUncertain: false, events: [],
    };
    const row = { record, created, deadline: created + timeoutMs, staged: [], statusSeen: new Set() };
    this.tests.set(id, row);
    this.recordEvent(row, 'test_started', { direction: 'outbound' });
    this.evaluate(row);
    return this.view(row);
  }

  view(row) { return row ? structuredClone(row.record) : null; }
  get(id) { this.sweep(); return this.view(this.tests.get(id)); }
  list(limit = 100) { this.sweep(); return [...this.tests.values()].reverse().slice(0, limit).map(row => this.view(row)); }
  listMessages(limit = 100) { this.sweep(); return structuredClone([...this.messages.values()].reverse().slice(0, limit)); }

  recordEvent(row, type, fields = {}) {
    const event = this.logger.log(type, { testId: row?.record.id, ...fields });
    if (row && !terminal(row.record)) {
      row.record.events.push(event.id);
      if (row.record.events.length > 64) row.record.events.shift();
      row.record.updatedAt = event.time;
    }
    return event;
  }

  finish(row, ok, reason) {
    if (terminal(row.record)) return;
    this.recordEvent(row, 'test_finished', { status: ok ? 'ok' : 'failed', reason, durationMs: this.now() - row.created });
    Object.assign(row.record, { status: ok ? 'ok' : 'failed', ok, reason, finishedAt: iso(this.now()), updatedAt: iso(this.now()) });
    row.staged.length = 0;
    this.emit(row.record.id);
  }

  evaluate(row) {
    if (terminal(row.record)) return;
    const record = row.record;
    record.missing = Object.keys(record.expected).filter(key => !record.expected[key]);
    if (this.now() >= row.deadline) {
      if (record.status === 'starting') record.sendOutcomeUncertain = true;
      return this.finish(row, false, `Test deadline exceeded${record.status === 'starting' ? '; send outcome uncertain' : ''}; missing: ${record.missing.join(', ') || 'completion before deadline'}`);
    }
    if (!record.missing.length) return this.finish(row, true, 'Outbound creation, status callback and inbound SMS verified');
    record.reason = `Waiting for: ${record.missing.join(', ')}`;
    this.emit(record.id);
  }

  message(summary) {
    const key = `${summary.projectId}:${summary.direction}:${summary.sid || summary.id}`;
    this.messages.set(key, structuredClone(summary));
    while (this.messages.size > this.maxMessages) this.messages.delete(this.messages.keys().next().value);
  }

  markCreated(id, sid) {
    const row = this.tests.get(id);
    this.message({ id, testId: id, projectId: this.config.projectId, sid, outboundMessageSid: sid, direction: 'outbound', from: this.config.from, to: row?.record.request.to, createdAt: iso(this.now()), status: 'created' });
    if (!row) return;
    this.evaluate(row);
    if (terminal(row.record)) { this.recordEvent(null, 'late_send_response', { testId: id, outboundMessageSid: sid }); return; }
    // A provider SID must identify only one run.
    if (this.outboundIndex.has(sid) && this.outboundIndex.get(sid) !== id) throw new HttpError(502, 'Provider returned a conflicting message SID; send outcome uncertain');
    this.outboundIndex.set(sid, id);
    row.record.status = 'pending';
    row.record.outboundMessageSid = sid;
    row.record.messageCreatedAt = iso(this.now());
    row.record.expected.signalWireMessageCreated = true;
    this.recordEvent(row, 'send_accepted', { direction: 'outbound', outboundMessageSid: sid });
    const staged = row.staged.splice(0);
    for (const event of staged) {
      if (event.sid === sid && !terminal(row.record)) this.applyStatus(row, event);
      else this.recordEvent(null, 'status_sid_conflict', { testId: id, outboundMessageSid: event.sid });
    }
    this.evaluate(row);
  }

  failSend(id, reason, uncertain = false) {
    const row = this.tests.get(id);
    if (!row || terminal(row.record)) { this.recordEvent(null, 'send_error_after_finish', { testId: id, reason, uncertain }); return; }
    row.record.sendOutcomeUncertain = uncertain;
    this.finish(row, false, reason);
  }

  applyStatus(row, event) {
    const record = row.record;
    record.expected.signalWireStatus = true;
    record.statusReceivedAt ||= iso(event.received);
    record.latestProviderStatus = event.status;
    record.errorCode = event.errorCode;
    if (event.status === 'delivered' && this.config.requireDeliveredStatus) record.expected.signalWireDelivered = true;
    this.recordEvent(row, 'status_received', { direction: 'outbound', outboundMessageSid: event.sid, status: event.status, errorCode: event.errorCode });
    record.missing = Object.keys(record.expected).filter(key => !record.expected[key]);
    if (FAILURES.has(event.status)) this.finish(row, false, `Outbound SMS ${event.status}${event.errorCode ? ` (code ${event.errorCode})` : ''}`);
  }

  receiveStatus({ testId, projectId, sid, status, from, to, errorCode = null }) {
    this.sweep();
    const event = { sid, status, errorCode, received: this.now() };
    const knownId = this.outboundIndex.get(sid);
    const id = testId || knownId;
    const row = this.tests.get(id);
    const diagnostic = reason => this.recordEvent(null, 'status_unmatched', { testId: id, outboundMessageSid: sid, status, errorCode, reason });
    if (projectId !== this.config.projectId || !row || (testId && knownId && knownId !== testId)) { diagnostic('Unknown or conflicting test/SID/project'); return; }
    if (terminal(row.record) || event.received < row.created || event.received >= row.deadline) { diagnostic('Finished or outside deadline'); return; }
    if (from !== row.record.request.from || to !== row.record.request.to || (row.record.outboundMessageSid && row.record.outboundMessageSid !== sid)) { diagnostic('SID or numbers do not match'); return; }
    if (!OUTBOUND_STATES.has(status)) { diagnostic('Unrecognized outbound status'); return; }
    const key = `${projectId}:${sid}:${status}:${errorCode || ''}`;
    if (row.statusSeen.has(key)) return;
    if (row.statusSeen.size >= 128) { diagnostic('Status evidence limit reached'); return; }
    row.statusSeen.add(key);
    if (!row.record.outboundMessageSid) {
      if (row.staged.length < 64) row.staged.push(event);
      this.recordEvent(row, 'status_staged', { direction: 'outbound', outboundMessageSid: sid, status });
      return;
    }
    this.applyStatus(row, event);
    this.evaluate(row);
  }

  receiveInbound({ projectId, sid, from, to, body, direction, hasMedia }) {
    this.sweep();
    const received = this.now(), key = `${projectId}:${sid}`;
    if (this.inboundSeen.has(key)) return;
    this.inboundSeen.set(key, received);
    while (this.inboundSeen.size > this.maxDedup) this.inboundSeen.delete(this.inboundSeen.keys().next().value);
    const match = body.trim().match(BODY_PATTERN);
    const row = match ? this.tests.get(match[1]) : null;
    const valid = row && !terminal(row.record) && projectId === this.config.inboundProjectId &&
      body.trim() === row.record.body && from === row.record.request.from && to === row.record.request.to &&
      (!direction || direction === 'inbound') && !hasMedia && received >= row.created && received < row.deadline;
    const summary = { projectId, sid, inboundMessageSid: sid, direction: 'inbound', from, to, createdAt: iso(received), matched: Boolean(valid), ...(valid ? { testId: row.record.id } : {}) };
    this.message(summary);
    if (!valid) {
      this.recordEvent(null, 'inbound_unmatched', { projectId, inboundMessageSid: sid, direction: 'inbound', from, to, reason: 'Unrelated, invalid, expired or finished receipt' });
      return;
    }
    if (row.record.expected.inboundSmsMatched) {
      this.recordEvent(null, 'inbound_additional_receipt', { testId: row.record.id, inboundMessageSid: sid });
      return;
    }
    Object.assign(row.record, { inboundMessageSid: sid, inboundReceivedAt: iso(received), inboundLatencyMs: received - row.created });
    row.record.expected.inboundSmsMatched = true;
    this.recordEvent(row, 'inbound_matched', { direction: 'inbound', inboundMessageSid: sid, durationMs: received - row.created });
    this.evaluate(row);
  }

  sweep() {
    const cutoff = this.now() - this.retentionMs;
    for (const row of this.tests.values()) if (!terminal(row.record) && this.now() >= row.deadline) this.evaluate(row);
    let count = [...this.tests.values()].filter(row => terminal(row.record)).length;
    for (const [id, row] of this.tests) {
      if (terminal(row.record) && (Date.parse(row.record.finishedAt) <= cutoff || count > this.maxTerminal)) {
        this.tests.delete(id);
        if (row.record.outboundMessageSid) this.outboundIndex.delete(row.record.outboundMessageSid);
        count--;
      }
    }
    for (const [key, summary] of this.messages) if (Date.parse(summary.createdAt) <= cutoff) this.messages.delete(key);
    for (const [key, time] of this.inboundSeen) if (time <= cutoff) this.inboundSeen.delete(key);
  }
}
