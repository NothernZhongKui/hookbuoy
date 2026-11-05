#!/usr/bin/env node
// A tiny standalone dev-only receiver, intentionally not an arc-commerce integration.
// Usage: node examples/local-receiver.mjs .hookbuoy/public.pem
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { verify } from 'node:crypto';

if (!process.argv[2]) {
  console.error('Usage: node examples/local-receiver.mjs .hookbuoy/public.pem');
  process.exit(2);
}
const publicPem = await readFile(process.argv[2]);
const seenNotifications = new Set();
const server = createServer(async (req, res) => {
  const respond = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (req.method !== 'POST' || !['/api/circle/webhook', '/api/circle/gateway-webhook'].includes(req.url)) return respond(404, { error: 'Not found' });
  const parts = [];
  for await (const part of req) parts.push(part);
  const bytes = Buffer.concat(parts);
  const sig = req.headers['x-circle-signature'];
  const kid = req.headers['x-circle-key-id'];
  if (typeof sig !== 'string' || kid !== 'hookbuoy-local-test') return respond(400, { error: 'Missing local test signature' });
  if (!verify('sha256', bytes, publicPem, Buffer.from(sig, 'base64'))) return respond(403, { error: 'Invalid signature' });
  let event;
  try { event = JSON.parse(bytes.toString('utf8')); } catch { return respond(400, { error: 'Invalid JSON' }); }
  if (!event.notificationId || !event.notification?.id) return respond(422, { error: 'Missing event fields' });
  const key = event.notificationType === 'gateway.deposit.finalized' ? event.notification.id : event.notificationId;
  const duplicate = seenNotifications.has(key);
  seenNotifications.add(key);
  console.log(event.notificationType, event.notification.id, event.notification.state ?? '-', duplicate ? 'DUPLICATE' : 'NEW');
  return respond(200, { received: true, duplicate });
});
server.listen(3917, '127.0.0.1', () => console.log('HookBuoy DEV-only receiver on http://127.0.0.1:3917/api/circle/webhook and /api/circle/gateway-webhook'));
