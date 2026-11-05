#!/usr/bin/env node
// Pinned Arc Fintech Gateway webhook E2E against a disposable local Supabase stack.
// Uses a local-only public key resolver while keeping the upstream verification code.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN = '0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'src', 'cli.js');
const routeName = 'app/api/circle/webhook/route.ts';
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error('Usage: node scripts/arc-fintech-e2e.mjs ARC_FINTECH_DIR [REPORT.json]');
  process.exit(2);
}
const arc = resolve(args[0]);
const reportPath = resolve(args[1] || 'arc-fintech-gateway-result.json');
const port = 3000;
const endpoint = 'http://127.0.0.1:' + port + '/api/circle/gateway-webhook';
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
  assert.equal(git('rev-parse', 'HEAD'), PIN, 'Arc Fintech revision does not match pinned commit');
  const origin = git('remote', 'get-url', 'origin');
  assert.match(origin, /^(https:\/\/github\.com\/|git@github\.com:)circlefin\/arc-fintech(\.git)?$/, 'Unexpected Arc Fintech origin');
  assert.equal(git('status', '--porcelain'), '', 'Use a CLEAN disposable Arc Fintech checkout');
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
async function snapshot(supabase, txId) {
  const rows = await queryOne(supabase, 'transactions', 'id', txId, 'id,status,type,tx_hash,amount,updated_at');
  assert.equal(rows.length, 1, 'Expected exactly one pre-created Gateway transaction');
  return rows[0];
}
async function eventRows(supabase, eventId) {
  return queryOne(supabase, 'webhook_events', 'notification_id', eventId,
    'notification_id,notification_type,payload,received_at');
}
async function countAll(supabase, table, userId) {
  const rows = await queryOne(supabase, table, 'user_id', userId, 'id');
  return rows.length;
}

async function waitForHandler(process, url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (process.exitCode !== null) throw new Error('Arc Fintech dev server exited early');
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch { /* Wait for Next.js to compile the pinned handler. */ }
    await wait(1500);
  }
  throw new Error('Arc Fintech webhook did not become available on loopback');
}
async function main() {
  await access(cli);
  await prepareLocalTrust();
  const supabase = supabaseStatus();
  serviceKey = supabase.service;
  temp = await mkdtemp(join(tmpdir(), 'hookbuoy-fintech-gateway-'));
  await cliCommand(temp, ['init', 'arc-fintech']);
  const publicPem = join(temp, '.hookbuoy', 'public.pem');
  await access(publicPem);

  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(1200) });
    throw new Error('Port 3000 is already in use (HTTP ' + response.status + '); refusing the test');
  } catch (e) {
    if (e instanceof Error && e.message.includes('already in use')) throw e;
  }

  logFile = await open(join(temp, 'arc-server.log'), 'wx', 0o600);
  server = spawn('npm', ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: arc,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: supabase.api,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publicKey,
      SUPABASE_SECRET_KEY: supabase.service,
      // No real Circle API credential. Only local "hookbuoy-local-test" bypasses Circle key lookup.
      CIRCLE_API_KEY: 'local-pilot-no-live-credentials',
      HOOKBUOY_TEST_PUBLIC_KEY_PATH: publicPem,
    },
    stdio: ['ignore', logFile.fd, logFile.fd],
    detached: true,
  });
  await waitForHandler(server, endpoint);

  // New disposable user and a synthetic pending deposit. Never target remote Supabase.
  const uid = randomUUID();
  const userResp = await request(supabase, '/auth/v1/admin/users', 'POST', {
    email: 'hookbuoy-gateway-' + uid + '@example.invalid',
    password: randomBytes(20).toString('hex'),
    email_confirm: true,
  });
  const userId = userResp?.id || userResp?.user?.id;
  assert.match(userId, /^[a-f0-9-]{36}$/i, 'Local Auth did not return a user ID');

  const hash = '0x' + randomBytes(32).toString('hex');
  const address = '0x' + randomBytes(20).toString('hex');
  const amount = '2.125000';
  const inserted = await request(supabase, '/rest/v1/transactions', 'POST', {
    user_id: userId, amount: Number(amount), sender_address: address,
    recipient_address: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    blockchain: 'ARC-TESTNET', type: 'OUTBOUND', status: 'PENDING',
    tx_hash: hash,
  });
  assert.ok(Array.isArray(inserted) && inserted.length === 1, 'One synthetic transaction required');
  const txId = inserted[0].id;
  const initial = await snapshot(supabase, txId);
  assert.equal(initial.status, 'PENDING');
  assert.equal(initial.type, 'OUTBOUND');

  const signatureEvent = 'hb-gw-sig-' + uid;
  const bodyEvent = 'hb-gw-body-' + uid;
  const goodEvent = 'hb-gw-valid-' + uid;
  const common = ['--tx-hash', hash, '--wallet-address', address,
    '--domain', '26', '--amount', amount];

  // These must not reach the dedupe insert or alter our synthetic transaction.
  await cliCommand(temp, ['send', 'gateway.deposit.finalized', ...common,
    '--event-id', signatureEvent, '--fault', 'signature', '--expect-status', '403'], 403);
  assert.deepEqual(await snapshot(supabase, txId), initial);
  assert.equal((await eventRows(supabase, signatureEvent)).length, 0);

  await cliCommand(temp, ['send', 'gateway.deposit.finalized', ...common,
    '--event-id', bodyEvent, '--fault', 'body', '--expect-status', '403'], 403);
  assert.deepEqual(await snapshot(supabase, txId), initial);
  assert.equal((await eventRows(supabase, bodyEvent)).length, 0);

  await cliCommand(temp, ['send', 'gateway.deposit.finalized', ...common,
    '--event-id', goodEvent], 200);
  const completed = await snapshot(supabase, txId);
  assert.equal(completed.status, 'COMPLETE');
  assert.equal(completed.tx_hash, hash);
  assert.equal(Number(completed.amount), Number(amount));
  const recorded = await eventRows(supabase, goodEvent);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].notification_type, 'gateway.deposit.finalized');
  assert.equal(recorded[0].payload.notification.txHash, hash);

  const config = JSON.parse(await readFile(join(temp, '.hookbuoy', 'config.json'), 'utf8'));
  const savedBefore = await readFile(config.lastDelivery);
  const fingerprint = createHash('sha256').update(savedBefore).digest('hex');
  await cliCommand(temp, ['replay', 'last', '--times', '3'], 200);
  const after = await snapshot(supabase, txId);
  assert.deepEqual(after, completed, 'Gateway replay changed completed transaction');
  assert.equal((await eventRows(supabase, goodEvent)).length, 1);
  assert.equal(createHash('sha256').update(await readFile(config.lastDelivery)).digest('hex'),
    fingerprint, 'Saved delivery changed on replay');
  assert.equal((await eventRows(supabase, signatureEvent)).length, 0);
  assert.equal((await eventRows(supabase, bodyEvent)).length, 0);

  const report = {
    result: 'PASS',
    checkedAt: new Date().toISOString(),
    upstreamRepository: 'circlefin/arc-fintech',
    upstreamCommit: PIN,
    hookbuoyVersion: '0.3.0-dev.1',
    tests: {
      invalidSignature: { httpStatus: 403, stateUnchanged: true, eventRows: 0 },
      tamperedBody: { httpStatus: 403, stateUnchanged: true, eventRows: 0 },
      validGatewayDeposit: { httpStatus: 200, transactionId: txId, initialStatus: initial.status,
        finalStatus: completed.status, eventId: goodEvent, eventRows: 1 },
      replay: { attempts: 3, httpStatus: 200, extraEvents: 0,
        transactionUnchanged: true, savedRequestUnchanged: true },
    },
    disclaimer: 'Synthetic locally signed event, isolated local database and test key; no Circle network, USDC transfer or on-chain settlement.',
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
try {
  await main();
} catch (e) {
  const message = e instanceof Error ? e.stack || e.message : String(e);
  console.error('Arc Fintech Gateway E2E FAILED: ' + (serviceKey ?
    message.replaceAll(serviceKey, '[redacted]') : message).slice(0, 3000));
  if (temp) {
    try {
      const logs = await readFile(join(temp, 'arc-server.log'), 'utf8');
      console.error('Arc Fintech dev server (last lines):\n' +
        (serviceKey ? logs.replaceAll(serviceKey, '[redacted]') : logs)
          .split('\n').slice(-40).join('\n').slice(-5000));
    } catch { /* no log */ }
  }
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  if (logFile) await logFile.close();
  if (changedRoute) {
    try { git('restore', '--', routeName); }
    catch (e) { console.error('Could not restore local pilot patch:', e); process.exitCode = 1; }
  }
  if (temp) await rm(temp, { recursive: true, force: true });
}
