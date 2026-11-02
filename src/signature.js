import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

export function parseForm(text) {
  const form = Object.create(null);
  for (const [key, value] of new URLSearchParams(text)) {
    if (Object.hasOwn(form, key)) throw new HttpError(400, 'Repeated form fields are unsupported');
    form[key] = value;
  }
  return form;
}

export function parseJsonWebhook(text) {
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new HttpError(400, 'Invalid webhook JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'Webhook JSON must be an object');
  const form = Object.create(null);
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') form[key] = value;
    else if (['NumMedia', 'NumSegments', 'ErrorCode'].includes(key) && Number.isSafeInteger(value) && value >= 0) form[key] = String(value);
    else throw new HttpError(400, 'Webhook JSON fields must be strings; counts and ErrorCode may also be nonnegative integers');
  }
  return form;
}

// Compatibility form contract: exact URL, then case-sensitive sorted names/values.
// Repeated keys are rejected at the parser, rather than choosing an ambiguous value.
export function signForm(key, url, form) {
  const data = Object.keys(form).sort().reduce((value, name) => value + name + form[name], url);
  return createHmac('sha1', key).update(data, 'utf8').digest('base64');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyForm(key, url, form, headers) {
  const expected = signForm(key, url, form);
  const signatures = [headers['x-signalwire-signature'], headers['x-twilio-signature']].filter(v => v !== undefined);
  return signatures.length > 0 && signatures.every(value => safeEqual(value, expected));
}

export function statusCallbackUrl(config, testId) {
  const url = new URL(config.statusWebhookUrl);
  if (testId) url.searchParams.set('test_id', testId);
  return url.href;
}

export function signedWebhookUrl(config, inbound, requestUrl) {
  // Only the request's raw query is variable. Scheme, authority and path always
  // come from configuration, even behind a TLS-terminating/path-rewriting proxy.
  // The status URL must use exactly the same URL serialization as the actual
  // StatusCallback sent to the provider (e.g. default ports/host casing).
  const configured = inbound ? config.inboundWebhookUrl : statusCallbackUrl(config);
  const queryAt = requestUrl.indexOf('?');
  const rawQuery = queryAt < 0 ? '' : requestUrl.slice(queryAt);
  return configured.split('?')[0] + rawQuery;
}
