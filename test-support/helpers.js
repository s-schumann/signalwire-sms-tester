import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { signForm } from '../src/signature.js';

export const ENV = {
  API_KEY: 'test-service-secret', PUBLIC_BASE_URL: 'https://sms.example.test',
  SIGNALWIRE_BASE_URL: 'https://space.example.test/api/laml/2010-04-01',
  SIGNALWIRE_PROJECT_ID: 'outbound-project', SIGNALWIRE_TOKEN: 'test-messaging-secret',
  SIGNALWIRE_SIGNING_KEY: 'test-outbound-signing-secret', SIGNALWIRE_FROM: '+12025550100',
  DEFAULT_TO: '+12025550101', ALLOWED_TO_NUMBERS: '+12025550101,+12025550102',
  MIN_SEND_INTERVAL_MS: '1',
};
export const A = ENV.SIGNALWIRE_FROM, B = ENV.DEFAULT_TO;
export const providerResponse = (sid = 'outbound-1') => new Response(JSON.stringify({ sid }), { status: 201 });
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const statusEvent = (test, overrides = {}) => ({ testId: test.id, projectId: ENV.SIGNALWIRE_PROJECT_ID, sid: 'outbound-1', status: 'sent', from: A, to: B, ...overrides });
export const inboundEvent = (test, overrides = {}) => ({ projectId: ENV.SIGNALWIRE_PROJECT_ID, sid: 'inbound-1', from: A, to: B, body: test.body, ...overrides });
export const statusForm = (overrides = {}) => ({ AccountSid: ENV.SIGNALWIRE_PROJECT_ID, MessageSid: 'outbound-1', MessageStatus: 'sent', From: A, To: B, ...overrides });
export const inboundForm = (test, overrides = {}) => ({ AccountSid: ENV.SIGNALWIRE_PROJECT_ID, MessageSid: 'inbound-1', From: A, To: B, Body: test.body, Direction: 'inbound', NumMedia: '0', ...overrides });

export async function setup(t, { env = {}, fetch = async () => providerResponse(), storeOptions = {}, clock = true, loggerOptions = {}, server = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sms-tester-'));
  let time = Date.parse('2026-11-02T12:00:00Z');
  const now = clock ? () => time : Date.now;
  const config = createConfig({ ...ENV, ...env, DATA_DIR: dataDir });
  const logger = createLogger({ dataDir, now, stdout: () => {}, secrets: [config.apiKey, config.token, config.signingKey, config.inboundSigningKey], ...loggerOptions });
  await logger.ready;
  const store = new Store(config, logger, { now, sweepIntervalMs: 0, ...storeOptions });
  const app = server ? createApp(config, store, { fetch, now }) : null;
  if (app) await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = app ? `http://127.0.0.1:${app.server.address().port}` : null;
  t.after(async () => { if (app) await app.shutdown(100); store.close(); await logger.flush(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, options = {}) {
    return globalThis.fetch(`${base}${path}`, { ...options, headers: { authorization: `Bearer ${config.apiKey}`, ...options.headers } });
  }
  async function post(path, body = {}, options = {}) {
    return request(path, { method: 'POST', body: JSON.stringify(body), ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  }
  async function webhook(kind, form, { query, header = 'x-signalwire-signature', signature, key, headers = {} } = {}) {
    const external = new URL(kind === 'inbound' ? config.inboundWebhookUrl : config.statusWebhookUrl);
    const search = query === undefined ? external.search : query;
    const signedUrl = `${external.origin}${external.pathname}${search}`;
    return request(`/webhooks/signalwire/${kind}${search}`, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { authorization: '', 'content-type': 'application/x-www-form-urlencoded', [header]: signature ?? signForm(key ?? (kind === 'inbound' ? config.inboundSigningKey : config.signingKey), signedUrl, form), ...headers } });
  }
  return { config, store, logger, app, dataDir, now, advance: ms => { time += ms; }, request, post, webhook };
}
