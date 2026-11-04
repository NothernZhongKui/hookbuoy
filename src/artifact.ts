import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FORMAT, MAX_BODY_BYTES, TEST_KEY_ID } from './constants.js';
import { signBytes } from './keys.js';

export type SavedDelivery = {
  format: typeof FORMAT;
  fixture: string;
  createdAt: string;
  request: {
    method: 'POST';
    headers: {
      'content-type': 'application/json';
      'x-circle-key-id': typeof TEST_KEY_ID;
      'x-circle-signature': string;
    };
    bodyBase64: string;
  };
};

export async function createDelivery(raw: Buffer, keyFile: string, fixture: string): Promise<SavedDelivery> {
  if (raw.length > MAX_BODY_BYTES) throw new Error('Payload too large');
  const signature = await signBytes(raw, keyFile);
  return {
    format: FORMAT,
    fixture,
    createdAt: new Date().toISOString(),
    request: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-circle-key-id': TEST_KEY_ID,
        'x-circle-signature': signature,
      },
      bodyBase64: raw.toString('base64'),
    },
  };
}

export function decodeDelivery(value: unknown): { artifact: SavedDelivery; bytes: Buffer } {
  if (!value || typeof value !== 'object') throw new Error('Invalid delivery file');
  const d = value as Record<string, unknown>;
  if (d.format !== FORMAT || !d.request || typeof d.request !== 'object') throw new Error('Unsupported delivery format');
  const req = d.request as Record<string, unknown>;
  const h = req.headers;
  if (!h || typeof h !== 'object') throw new Error('Missing delivery headers');
  const headers = h as Record<string, unknown>;
  if (req.method !== 'POST' || headers['content-type'] !== 'application/json' || headers['x-circle-key-id'] !== TEST_KEY_ID) {
    throw new Error('Invalid delivery method or headers');
  }
  const headerNames = Object.keys(headers).sort();
  const allowedHeaderNames = ['content-type', 'x-circle-key-id', 'x-circle-signature'].sort();
  if (headerNames.length !== allowedHeaderNames.length || headerNames.some((name, i) => name !== allowedHeaderNames[i])) {
    throw new Error('Delivery contains unsupported HTTP headers');
  }
  const sig = headers['x-circle-signature'];
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || Buffer.from(sig, 'base64').toString('base64') !== sig) {
    throw new Error('Invalid saved signature');
  }
  const data = req.bodyBase64;
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid body encoding');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BODY_BYTES || bytes.toString('base64') !== data) throw new Error('Invalid or oversized body');
  const artifact = value as SavedDelivery;
  return { artifact, bytes };
}

export async function saveDelivery(file: string, d: SavedDelivery): Promise<void> {
  // Refuse overwrite, matching conservative test fixture provenance.
  await writeFile(resolve(file), JSON.stringify(d, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function loadDelivery(file: string): Promise<{ artifact: SavedDelivery; bytes: Buffer }> {
  const path = resolve(file);
  if ((await stat(path)).size > 512 * 1024)
    throw new Error('Saved delivery file exceeds 512 KiB limit');
  const raw = await readFile(path, 'utf8');
  return decodeDelivery(JSON.parse(raw) as unknown);
}
