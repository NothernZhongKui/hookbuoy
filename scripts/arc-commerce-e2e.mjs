#!/usr/bin/env node
// End-to-end exercise of the pinned, UNMODIFIED-in-upstream Arc Commerce webhook.
// Operates only against loopback ports and a disposable local Supabase project.
// No real Circle API keys or live payments. Does not claim on-chain settlement.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN = '1a4f09d79883c15cb2fa8527a3ad210b3e01a552';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'src', 'cli.js');
const routeName = 'app/api/circle/webhook/route.ts';
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error('Usage: node scripts/arc-commerce-e2e.mjs ARC_COMMERCE_DIR [REPORT.json]');
  process.exit(2);
}
const arc = resolve(args[0]);
const reportPath = resolve(args[1] || 'arc-commerce-pilot-result.json');
const port = 3000;
const endpoint = 'http://127.0.0.1:' + port + '/api/circle/webhook';
let temp;
let server;
let logFile;
let changedRoute = false;
let serviceKey = '';

function git(...commands) {
  return execFileSync('git', commands, { cwd: arc, encoding: 'utf8' }).trim();
}
function localURL(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'Only local HTTP is allowed');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only loopback is allowed');
  assert.ok(!url.username && !url.password, 'URL credentials are forbidden');
  return url;
}
function command(bin, argumentsList, cwd) {
  return new Promise((done, fail) => {
    const p = spawn(bin, argumentsList, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', x => { out += x; });
    p.stderr.on('data', x => { err += x; });
    p.once('error', fail);
    p.once('close', code => code === 0 ? done(out) : fail(new Error(
      bin + ' exited ' + code + '\n' + out.slice(-2000) + '\n' + err.slice(-2000)
    )));
  });
}
function wait(ms) { return new Promise(done => setTimeout(done, ms)); }
async function prepareLocalTrust() {
  assert.equal(git('rev-parse', 'HEAD'), PIN, 'Arc Commerce revision does not match pinned commit');
  const origin = git('remote', 'get-url', 'origin');
  assert.match(origin, /^(https:\/\/github\.com\/|git@github\.com:)circlefin\/arc-commerce(\.git)?$/, 'Unexpected Arc Commerce origin');
  assert.equal(git('status', '--porcelain'), '', 'Use a CLEAN disposable Arc Commerce checkout');
  const route = join(arc, routeName);
  let source = await readFile(route, 'utf8');
  const anchorImport = 'import crypto from "crypto";';
  const anchorResolver = 'async function getCirclePublicKey(keyId: string) {';
  assert.ok(source.includes(anchorImport) && source.includes(anchorResolver), 'Pinned route layout changed');
  source = source.replace(anchorImport, anchorImport + '\nimport { readFile } from "node:fs/promises";');
  source = source.replace(anchorResolver, anchorResolver + '\n' +
    '  // HookBuoy E2E ONLY: isolated, local development test key.\n' +
    '  if (process.env.NODE_ENV === "development" &&\n' +
    '      keyId === "hookbuoy-local-test" &&\n' +
    '      process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH) {\n' +
    '    return readFile(process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH, "utf8");\n' +
    '  }\n');
  await writeFile(route, source, 'utf8');
  changedRoute = true;
  git('diff', '--check');
}
function supabaseStatus() {
  const raw = execFileSync('npx', ['--no-install', 'supabase', 'status', '--output', 'json'],
    { cwd: arc, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const details = JSON.parse(raw);
  const api = process.env.HB_ARC_SUPABASE_URL || details.API_URL;
  const service = process.env.HB_ARC_SERVICE_KEY || details.SERVICE_ROLE_KEY || details.SECRET_KEY;
  const publicKey = details.ANON_KEY || details.PUBLISHABLE_KEY || service;
  assert.equal(typeof api, 'string', 'Missing local Supabase API_URL');
  assert.equal(typeof service, 'string', 'Missing local service-role key');
  assert.equal(typeof publicKey, 'string', 'Missing local Supabase public key');
  localURL(api);
  return { api: api.replace(/\/$/, ''), service, publicKey };
}
async function request(supabase, urlPath, method = 'GET', payload) {
  const res = await fetch(supabase.api + urlPath, {
    method,
    headers: {
      apikey: supabase.service,
      Authorization: 'Bearer ' + supabase.service,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Local Supabase ' + method + ' ' + urlPath.split('?')[0] +
    ' returned ' + res.status + ': ' + body.slice(0, 700));
  return body ? JSON.parse(body) : null;
}
async function queryOne(supabase, table, idColumn, id, select) {
  const path = '/rest/v1/' + table + '?' + idColumn + '=eq.' + encodeURIComponent(id) +
               '&select=' + encodeURIComponent(select);
  const rows = await request(supabase, path);
  assert.ok(Array.isArray(rows), table + ' query returned non-array');
  return rows;
}
async function cliCommand(cwd, argumentsList, expectedHttp) {
  const output = await command(process.execPath, [cli, ...argumentsList], cwd);
  if (expectedHttp !== undefined) {
    assert.match(output, new RegExp('HTTP ' + expectedHttp + '\\b'));
    assert.match(output, /EXPECTED/);
  }
  return output;
}
async function snapshot(supabase, userId, transactionId) {
  const txs = await queryOne(supabase, 'transactions', 'id', transactionId, 'id,status,credit_amount');
  const balances = await queryOne(supabase, 'credits', 'user_id', userId, 'user_id,credits');
  assert.equal(txs.length, 1, 'Missing local test transaction');
  assert.equal(balances.length, 1, 'Missing test-user credit row');
  return {
    status: txs[0].status,
    credits: Number(balances[0].credits),
    creditAmount: Number(txs[0].credit_amount),
  };
}
async function verifyEvent(supabase, eventId, expected) {
  const events = await queryOne(supabase, 'transaction_webhook_events',
    'circle_event_id', eventId, 'circle_event_id,circle_transaction_id,mapped_status,signature_valid');
  assert.equal(events.length, expected, 'Wrong count for event ' + eventId);
  return events;
}
async function waitForHandler(process, url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (process.exitCode !== null) throw new Error('Arc Commerce dev server exited early');
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch { /* Wait for Next.js to compile the pinned handler. */ }
    await wait(1500);
  }
  throw new Error('Arc Commerce webhook did not become available on loopback');
}
async function main() {
  await access(cli);
  await prepareLocalTrust();
  const supabase = supabaseStatus();
  serviceKey = supabase.service;
  temp = await mkdtemp(join(tmpdir(), 'hookbuoy-arc-'));
  await cliCommand(temp, ['init', 'arc-commerce']);
  const publicPem = join(temp, '.hookbuoy', 'public.pem');
  await access(publicPem);

  // Prevent accidental interaction with another application on port 3000.
  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(1200) });
    throw new Error('Port 3000 is already in use (HTTP ' + response.status + '); refusing the test');
  } catch (e) {
    if ((e instanceof Error) && e.message.includes('already in use')) throw e;
  }

  const logPath = join(temp, 'arc-server.log');
  logFile = await open(logPath, 'wx', 0o600);
  server = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: arc,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: supabase.api,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publicKey,
      SUPABASE_SECRET_KEY: supabase.service,
      HOOKBUOY_TEST_PUBLIC_KEY_PATH: publicPem,
    },
    stdio: ['ignore', logFile.fd, logFile.fd],
    detached: true,
  });
  await waitForHandler(server, endpoint);

  // Disposable local user; never target an existing account or remote Supabase.
  const uid = randomUUID();
  const created = await request(supabase, '/auth/v1/admin/users', 'POST', {
    email: 'hookbuoy-pilot-' + uid + '@example.invalid',
    password: randomBytes(20).toString('hex'),
    email_confirm: true,
  });
  const userId = created?.id || created?.user?.id;
  assert.match(userId, /^[a-f0-9-]{36}$/i, 'Local Auth did not return a user ID');
  const txHash = '0x' + randomBytes(32).toString('hex');
  const idem = 'hookbuoy-arc-e2e-' + uid;
  const createdTx = await request(supabase, '/rest/v1/transactions', 'POST', {
    user_id: userId,
    wallet_id: 'hookbuoy-test-wallet',
    direction: 'credit',
    amount_usdc: 1,
    credit_amount: 10,
    exchange_rate: 10,
    chain: 'ARC-TESTNET',
    asset: 'USDC',
    tx_hash: txHash,
    status: 'pending',
    idempotency_key: idem,
    transaction_type: 'USER',
  });
  assert.ok(Array.isArray(createdTx) && createdTx.length === 1);
  const txId = createdTx[0].id;
  const initial = await snapshot(supabase, userId, txId);
  assert.equal(initial.status, 'pending');
  assert.equal(initial.creditAmount, 10);

  const eventSig = 'hb-badsig-' + uid;
  const eventBody = 'hb-badbody-' + uid;
  const eventGood = 'hb-valid-' + uid;
  const common = ['--tx-hash', txHash, '--transaction-id', 'hb-local-tx-' + uid];

  await cliCommand(temp, ['check', 'signature', ...common, '--notification-id', eventSig], 403);
  assert.deepEqual(await snapshot(supabase, userId, txId), initial);
  await verifyEvent(supabase, eventSig, 0);

  await cliCommand(temp, ['check', 'body', ...common, '--notification-id', eventBody], 403);
  assert.deepEqual(await snapshot(supabase, userId, txId), initial);
  await verifyEvent(supabase, eventBody, 0);

  await cliCommand(temp, ['send', 'inbound.complete', ...common, '--notification-id', eventGood], 200);
  const completed = await snapshot(supabase, userId, txId);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.credits, initial.credits + 10);
  const event = await verifyEvent(supabase, eventGood, 1);
  assert.equal(event[0].signature_valid, true);
  assert.equal(event[0].mapped_status, 'complete');

  const config = JSON.parse(await readFile(join(temp, '.hookbuoy', 'config.json'), 'utf8'));
  const savedBefore = await readFile(config.lastDelivery);
  const fingerprint = createHash('sha256').update(savedBefore).digest('hex');
  await cliCommand(temp, ['replay', 'last', '--times', '3'], 200);
  const after = await snapshot(supabase, userId, txId);
  assert.deepEqual(after, completed, 'Replay changed credited purchase');
  await verifyEvent(supabase, eventGood, 1);
  const savedAfter = await readFile(config.lastDelivery);
  assert.equal(createHash('sha256').update(savedAfter).digest('hex'), fingerprint);
  await verifyEvent(supabase, eventSig, 0);
  await verifyEvent(supabase, eventBody, 0);

  const report = {
    result: 'PASS',
    checkedAt: new Date().toISOString(),
    upstreamRepository: 'circlefin/arc-commerce',
    upstreamCommit: PIN,
    hookbuoyVersion: '0.2.0-dev.2',
    tests: {
      invalidSignature: { httpStatus: 403, stateUnchanged: true, eventRows: 0 },
      tamperedBody: { httpStatus: 403, stateUnchanged: true, eventRows: 0 },
      correctSignature: { httpStatus: 200, recordedValidEvent: true, transactionStatus: completed.status, creditIncrease: 10 },
      replay: { attempts: 3, httpStatus: 200, extraCredits: 0, uniqueEventRows: 1, savedRequestUnchanged: true },
    },
    disclaimer: 'Synthetic locally signed notifications against disposable local Supabase. Not a real Circle delivery or on-chain settlement.',
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
try {
  await main();
} catch (e) {
  const message = e instanceof Error ? e.stack || e.message : String(e);
  console.error('Arc Commerce E2E FAILED: ' + (serviceKey ? message.replaceAll(serviceKey, '[redacted]') : message).slice(0, 2500));
  if (temp) {
    try {
      const logs = await readFile(join(temp, 'arc-server.log'), 'utf8');
      console.error('Arc Commerce dev server (last lines):\n' +
        (serviceKey ? logs.replaceAll(serviceKey, '[redacted]') : logs).split('\n').slice(-35).join('\n').slice(-4500));
    } catch { /* No server log available. */ }
  }
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  }
  if (logFile) await logFile.close();
  if (changedRoute) {
    try { git('restore', '--', routeName); } catch (e) { console.error('Could not restore local pilot patch:', e); }
  }
  if (temp) await rm(temp, { recursive: true, force: true });
}
