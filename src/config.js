import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_MESSAGE_CHARS = 1600;
export const isE164 = value => typeof value === 'string' && /^\+[1-9][0-9]{1,14}$/.test(value) && value === value.trim();
// Equivalent to [\w.\-+*,#]{1,11}, with whole-string validation (no final newline).
export const isSenderId = value => typeof value === 'string' && value.length >= 1 && value.length <= 11 &&
  !/[^A-Za-z0-9_.+*,#-]/.test(value);
export const isSmsSender = value => isE164(value) || isSenderId(value);
export const isSid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Intentionally small dotenv grammar: single-line values, quotes, and comments.
// Existing environment entries (even empty ones) always win.
export function loadDotEnv(env, path = resolve(ROOT, '.env')) {
  let contents;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return env; throw error; }
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid .env syntax at line ${index + 1}`);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const quoted = value.match(quote === '"' ? /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/ : /^'([^']*)'\s*(?:#.*)?$/);
      if (!quoted) throw new Error(`Invalid .env quoting at line ${index + 1}`);
      value = quoted[1];
      if (quote === '"') value = value.replace(/\\(n|r|"|\\)/g, (_, c) => ({ n: '\n', r: '\r', '"': '"', '\\': '\\' })[c]);
    } else value = value.replace(/(?:^|\s+)#.*$/, '').trim();
    if (!Object.hasOwn(env, match[1])) env[match[1]] = value;
  }
  return env;
}

function integer(env, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(Number(value), max);
}

function boolean(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase() || String(fallback);
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
}

export function validHttpUrl(value, { originOnly = false, noQuery = false } = {}) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash &&
      (!originOnly || (url.pathname === '/' && !url.search)) && (!noQuery || !url.search);
  } catch { return false; }
}

export function createConfig(env = {}, { root = ROOT } = {}) {
  const str = name => env[name]?.trim() || '';
  const verify = str('SIGNALWIRE_VERIFY_WEBHOOKS') || 'on';
  if (!['on', 'off'].includes(verify)) throw new Error('SIGNALWIRE_VERIFY_WEBHOOKS must be on or off');
  const projectId = str('SIGNALWIRE_PROJECT_ID');
  const signingKey = str('SIGNALWIRE_SIGNING_KEY');
  const inboundProjectId = str('SIGNALWIRE_INBOUND_PROJECT_ID') || projectId;
  const publicBaseUrl = str('PUBLIC_BASE_URL').replace(/\/$/, '');
  const config = {
    port: integer(env, 'PORT', 3000, 65535), host: str('HOST') || '0.0.0.0',
    apiKey: str('API_KEY'), publicBaseUrl,
    baseUrl: str('SIGNALWIRE_BASE_URL').replace(/\/$/, ''), projectId,
    token: str('SIGNALWIRE_TOKEN'), signingKey,
    from: str('SIGNALWIRE_FROM'), defaultTo: str('DEFAULT_TO'),
    allowedTo: [...new Set(str('ALLOWED_TO_NUMBERS').split(',').map(n => n.trim()).filter(Boolean))],
    inboundProjectId,
    inboundSigningKey: str('SIGNALWIRE_INBOUND_SIGNING_KEY') || (inboundProjectId === projectId ? signingKey : ''),
    statusWebhookUrl: str('SIGNALWIRE_STATUS_WEBHOOK_URL') || (publicBaseUrl ? `${publicBaseUrl}/webhooks/signalwire/status` : ''),
    inboundWebhookUrl: str('SIGNALWIRE_INBOUND_WEBHOOK_URL') || (publicBaseUrl ? `${publicBaseUrl}/webhooks/signalwire/inbound` : ''),
    verifyWebhooks: verify === 'on',
    testTimeoutMs: integer(env, 'TEST_TIMEOUT_MS', 120_000, MAX_TIMEOUT_MS),
    requestTimeoutMs: integer(env, 'SIGNALWIRE_REQUEST_TIMEOUT_MS', 10_000, MAX_TIMEOUT_MS),
    requireDeliveredStatus: boolean(env, 'REQUIRE_DELIVERED_STATUS', false),
    ignoreSenderFrom: boolean(env, 'IGNORE_SENDER_FROM', false),
    maxActiveTests: integer(env, 'MAX_ACTIVE_TESTS', 1, 100),
    minSendIntervalMs: integer(env, 'MIN_SEND_INTERVAL_MS', 60_000),
    dataDir: resolve(root, str('DATA_DIR') || './data'),
  };
  return config;
}

export function webhookConfigurationErrors(config, inbound) {
  const errors = [];
  const project = inbound ? config.inboundProjectId : config.projectId;
  const url = inbound ? config.inboundWebhookUrl : config.statusWebhookUrl;
  if (!isSid(project)) errors.push(inbound ? 'SIGNALWIRE_INBOUND_PROJECT_ID' : 'SIGNALWIRE_PROJECT_ID');
  if ((config.verifyWebhooks || url) && !validHttpUrl(url)) errors.push(inbound ? 'SIGNALWIRE_INBOUND_WEBHOOK_URL' : 'SIGNALWIRE_STATUS_WEBHOOK_URL');
  if (config.verifyWebhooks) {
    if (!(inbound ? config.inboundSigningKey : config.signingKey)) errors.push(inbound ? 'SIGNALWIRE_INBOUND_SIGNING_KEY' : 'SIGNALWIRE_SIGNING_KEY');
  }
  return errors;
}

export function sendConfigurationErrors(config) {
  const errors = [];
  if (!validHttpUrl(config.baseUrl, { noQuery: true })) errors.push('SIGNALWIRE_BASE_URL');
  if (!validHttpUrl(config.publicBaseUrl, { originOnly: true })) errors.push('PUBLIC_BASE_URL');
  if (!isSid(config.projectId)) errors.push('SIGNALWIRE_PROJECT_ID');
  if (!config.token) errors.push('SIGNALWIRE_TOKEN');
  if (!isSmsSender(config.from)) errors.push('SIGNALWIRE_FROM');
  if (!config.allowedTo.length || config.allowedTo.some(n => !isE164(n) || n === config.from)) errors.push('ALLOWED_TO_NUMBERS');
  if (config.defaultTo && (!isE164(config.defaultTo) || !config.allowedTo.includes(config.defaultTo) || config.defaultTo === config.from)) errors.push('DEFAULT_TO');
  for (const [key, value] of [['SIGNALWIRE_STATUS_WEBHOOK_URL', config.statusWebhookUrl], ['SIGNALWIRE_INBOUND_WEBHOOK_URL', config.inboundWebhookUrl]]) {
    if (!validHttpUrl(value)) errors.push(key);
    else {
      const query = new URL(value).searchParams;
      if (query.has('test_id') || [...query.keys()].some(k => query.getAll(k).length > 1)) errors.push(key);
    }
  }
  return [...new Set([...errors, ...webhookConfigurationErrors(config, false), ...webhookConfigurationErrors(config, true)])];
}

export function loadConfig() {
  loadDotEnv(process.env);
  return createConfig(process.env);
}
