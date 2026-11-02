import { isSid } from './config.js';
import { HttpError } from './errors.js';

export class SendError extends HttpError {
  constructor(statusCode, message, uncertain = false) {
    super(statusCode, message, { uncertain });
    this.uncertain = uncertain;
  }
}

export async function createMessage(config, { to, body, callbackUrl, deadline }, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const budget = Math.min(config.requestTimeoutMs, deadline - now());
  if (budget <= 0) throw new SendError(504, 'Provider request timed out; send outcome uncertain', true);
  const controller = new AbortController();
  let timer;
  // Race also bounds injected transports which ignore AbortSignal. Reading the
  // response is inside the operation, so stalled response bodies time out too.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SendError(504, 'Provider request timed out; send outcome uncertain', true));
    }, budget);
  });
  const operation = (async () => {
    const response = await fetch(`${config.baseUrl}/Accounts/${encodeURIComponent(config.projectId)}/Messages`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.projectId}:${config.token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      },
      body: new URLSearchParams({ From: config.from, To: to, Body: body, StatusCallback: callbackUrl }).toString(),
    });
    if (!response.ok) {
      // Never reflect or log the provider's error body.
      await response.body?.cancel();
      throw new SendError(502, 'Provider rejected message creation', response.status >= 500 || response.status < 400);
    }
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      let size = 0;
      try {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) { await reader.cancel(); throw new SendError(502, 'Invalid provider response; send outcome uncertain', true); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    } else text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new SendError(502, 'Invalid provider response; send outcome uncertain', true); }
    if (!payload || !isSid(payload.sid)) throw new SendError(502, 'Provider response missing valid SID; send outcome uncertain', true);
    return { sid: payload.sid };
  })();
  try { return await Promise.race([operation, timeout]); }
  catch (error) {
    if (error instanceof SendError) throw error;
    throw new SendError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'Provider request timed out; send outcome uncertain' : 'Provider transport failed; send outcome uncertain', true);
  } finally { clearTimeout(timer); controller.abort(); }
}
