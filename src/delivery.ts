import type { SavedDelivery } from './artifact.js';
import { decodeDelivery } from './artifact.js';

export type DeliveryResult = { status?: number; ms: number; error?: 'TIMEOUT' | 'CONNECTION_ERROR' | 'RESPONSE_ERROR' };

export function parseLocalUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--to must be a full http://localhost URL'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) {
    throw new Error('v0.1 accepts only http://localhost / 127.0.0.1 / [::1], without credentials or fragments');
  }
  return url;
}

export async function deliver(d: SavedDelivery, endpoint: string, timeoutMs = 3000): Promise<DeliveryResult> {
  const url = parseLocalUrl(endpoint);
  const { bytes } = decodeDelivery(d);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Timeout must be between 1 and 60000 ms');
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: d.request.headers,
      body: new Uint8Array(bytes),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // No assumption about application state: HTTP response only. Cancel streamed response
    // rather than reading potentially unbounded user content.
    await response.body?.cancel();
    return { status: response.status, ms: Math.round(performance.now() - started) };
  } catch (e) {
    const err = e as Error;
    return {
      ms: Math.round(performance.now() - started),
      error: err.name === 'TimeoutError' || err.name === 'AbortError' ? 'TIMEOUT' : 'CONNECTION_ERROR',
    };
  }
}

export type DeliveryReport = { results: DeliveryResult[]; exitCode: 0 | 3 | 4 };
export async function deliverTimes(d: SavedDelivery, endpoint: string, times: number, timeoutMs: number, expectStatus?: number): Promise<DeliveryReport> {
  if (!Number.isInteger(times) || times < 1 || times > 100) throw new Error('--times must be an integer between 1 and 100');
  const results: DeliveryResult[] = [];
  for (let i = 0; i < times; i++) results.push(await deliver(d, endpoint, timeoutMs));
  let exitCode: 0 | 3 | 4 = 0;
  for (const r of results) {
    if (r.error) exitCode = 4;
    else if (exitCode !== 4 && (expectStatus === undefined ? (r.status! < 200 || r.status! >= 300) : r.status !== expectStatus)) exitCode = 3;
  }
  return { results, exitCode };
}
