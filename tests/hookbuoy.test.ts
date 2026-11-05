import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestKeys, verifyBytes } from '../src/keys.js';
import { makeFixture } from '../src/fixtures.js';
import { createDelivery, decodeDelivery, loadDelivery, saveDelivery } from '../src/artifact.js';
import { deliver, deliverTimes, parseLocalUrl } from '../src/delivery.js';
import { run, menuCommand } from '../src/cli.js';
import { applyFault, parseFault } from '../src/faults.js';
import { initProject, keyStatus, loadProject, nextDelivery, rememberDelivery } from '../src/project.js';

async function harness() {
  const temp = await mkdtemp(join(tmpdir(), 'hookbuoy-test-'));
  const keys = await createTestKeys(join(temp, 'keys'));
  const seen = new Set<string>();
  const transactionState = new Map<string,string>();
  const requests: { body: Buffer; signature?: string; keyId?: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const rawChunks: Buffer[] = [];
    for await (const chunk of req) rawChunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(rawChunks);
    const signature = req.headers['x-circle-signature'] as string | undefined;
    const keyId = req.headers['x-circle-key-id'] as string | undefined;
    requests.push({ body: raw, signature, keyId });
    if (!signature || keyId !== 'hookbuoy-local-test') { res.writeHead(400).end(); return; }
    const verified = await verifyBytes(raw, signature, keys.publicPath);
    if (!verified) { res.writeHead(403).end(); return; }
    if (req.url === '/fail') { res.writeHead(500).end(); return; }
    if (req.url === '/slow') await delay(120);
    const ev = JSON.parse(raw.toString('utf8'));
    const duplicate = seen.has(ev.notificationId);
    if (!duplicate) {
      seen.add(ev.notificationId);
      transactionState.set(ev.notification.id, ev.notification.state);
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ duplicate }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    temp, keys, requests, transactionState, origin,
    close: async () => { await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); await rm(temp, { recursive: true, force: true }); },
  };
}

test('sign/send produces Circle-style P-256 headers and a valid signature', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', { txHash: `0x${'11'.repeat(32)}` });
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    assert.equal(signed.request.headers['x-circle-key-id'], 'hookbuoy-local-test');
    assert.equal(await verifyBytes(body, signed.request.headers['x-circle-signature'], ctx.keys.publicPath), true);
    assert.deepEqual((await deliver(signed, ctx.origin)).status, 200);
  } finally { await ctx.close(); }
});

test('saved replay transmits EXACT request body and signature three times', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const artifact = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const file = join(ctx.temp, 'delivery.json');
    await saveDelivery(file, artifact);
    const { artifact: loaded, bytes } = await loadDelivery(file);
    assert.deepEqual(bytes, body);
    const report = await deliverTimes(loaded, ctx.origin, 3, 1000);
    assert.equal(report.exitCode, 0);
    assert.equal(ctx.requests.length, 3);
    for (const r of ctx.requests) {
      assert.deepEqual(r.body, body);
      assert.equal(r.signature, artifact.request.headers['x-circle-signature']);
    }
    await assert.rejects(saveDelivery(file, artifact), /EEXIST/);
  } finally { await ctx.close(); }
});

test('tampering with signed bytes is rejected by real P-256 verification', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const tampered = { ...signed, request: { ...signed.request, bodyBase64: Buffer.from(body.toString().replace('COMPLETE','FAILED__')).toString('base64') } };
    const report = await deliverTimes(tampered, ctx.origin, 1, 1000, 403);
    assert.equal(report.results[0]!.status, 403);
    assert.equal(report.exitCode, 0);
  } finally { await ctx.close(); }
});

test('same transaction ID with distinct notification IDs creates distinct events', async () => {
  const ctx = await harness();
  try {
    const id = 'tx-123';
    for (const [name, notif] of [['wallets.inbound.failed', 'first'], ['wallets.inbound.complete','second']] as const) {
      const { body } = await makeFixture(name, { transactionId: id, notificationId: notif });
      const signed = await createDelivery(body, ctx.keys.privatePath, name);
      assert.equal((await deliver(signed, ctx.origin)).status, 200);
    }
    assert.equal(ctx.transactionState.get(id), 'COMPLETE');
    assert.equal(ctx.requests.length, 2);
  } finally { await ctx.close(); }
});

test('HTTP 500 is unexpected by default but 500 can be explicitly expected', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    assert.equal((await deliverTimes(signed, ctx.origin + '/fail', 1, 1000)).exitCode, 3);
    assert.equal((await deliverTimes(signed, ctx.origin + '/fail', 1, 1000, 500)).exitCode, 0);
  } finally { await ctx.close(); }
});

test('timeouts and failed local connections have exit code 4', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const timeout = await deliverTimes(signed, ctx.origin + '/slow', 1, 10);
    assert.equal(timeout.results[0]!.error, 'TIMEOUT');
    assert.equal(timeout.exitCode, 4);
    const down = await deliverTimes(signed, 'http://127.0.0.1:1', 1, 100);
    assert.equal(down.exitCode, 4);
  } finally { await ctx.close(); }
});

test('URL policy blocks remote, credentials, HTTPS and deceptive hostnames', () => {
  for (const url of ['https://localhost:3000', 'http://example.com', 'http://localhost.evil.com', 'http://user:pw@localhost:3000']) {
    assert.throws(() => parseLocalUrl(url));
  }
  assert.equal(parseLocalUrl('http://[::1]:3000/hook').hostname, '[::1]');
});

test('invalid delivery JSON fails before any HTTP connection', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    assert.throws(() => decodeDelivery({ ...signed, request: { ...signed.request, bodyBase64: '$$$' } }));
    assert.throws(() => decodeDelivery({ ...signed, request: { ...signed.request, method: 'GET' } }));
    assert.throws(() => decodeDelivery({ ...signed, request: { ...signed.request, headers: { ...signed.request.headers, authorization: 'Bearer accidental-secret' } } }));
    assert.equal(ctx.requests.length, 0);
  } finally { await ctx.close(); }
});

test('CLI keygen/send/replay workflow works without dependencies or credentials', async () => {
  const ctx = await harness();
  try {
    const another = join(ctx.temp, 'cli-keys');
    assert.equal(await run(['keygen','--out',another]), 0);
    assert.equal((await readFile(join(another,'public.pem'),'utf8')).includes('BEGIN PUBLIC KEY'), true);
    // Sign with the harness trusted key for successful delivery.
    const file = join(ctx.temp, 'cli.delivery.json');
    assert.equal(await run(['send','wallets.inbound.complete','--key',ctx.keys.privatePath,'--to',ctx.origin,'--save',file]), 0);
    assert.equal(await run(['replay',file,'--to',ctx.origin,'--times','3']), 0);
    assert.equal(ctx.requests.length, 4);
    assert.equal(await run(['replay',file,'--to','https://example.org']), 2);
  } finally { await ctx.close(); }
});

test('first delivery is NEW; exact replay is DUPLICATE', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const d = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const send = () => fetch(ctx.origin, {
      method: 'POST', headers: d.request.headers, body: new Uint8Array(body)
    });
    assert.deepEqual(await (await send()).json(), { duplicate: false });
    assert.deepEqual(await (await send()).json(), { duplicate: true });
  } finally { await ctx.close(); }
});

test('keygen does not overwrite trusted keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-keygen-'));
  try {
    const paths = await createTestKeys(join(dir, 'keys'));
    const original = await readFile(paths.publicPath);
    await assert.rejects(createTestKeys(join(dir, 'keys')), /EEXIST/);
    assert.deepEqual(await readFile(paths.publicPath), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized delivery file is rejected before parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-size-'));
  try {
    const f = join(dir, 'large.json');
    await writeFile(f, ' '.repeat(512 * 1024 + 1));
    await assert.rejects(loadDelivery(f), /exceeds 512 KiB/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('npm-style symlink invokes CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-bin-'));
  try {
    const bin = join(dir, 'hookbuoy');
    await symlink(resolve('dist/src/cli.js'), bin);
    const out = execFileSync(process.execPath, [bin, '--help'], {
      encoding: 'utf8'
    });
    assert.match(out, /Usage:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('project init stores only local config and refuses to overwrite keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-project-'));
  try {
    const endpoint = 'http://127.0.0.1:3901/hook';
    assert.deepEqual(await initProject(endpoint, 'custom', dir), { reusedKeys: false });
    const config = await loadProject(dir);
    assert.equal(config?.endpoint, endpoint);
    assert.equal(config?.profile, 'custom');
    assert.equal(await keyStatus(dir), 'ready');
    await assert.rejects(initProject(endpoint, 'custom', dir), /already initialized/);
    assert.equal(await readFile(join(dir, '.hookbuoy', 'config.json'), 'utf8').then(x => JSON.parse(x).endpoint), endpoint);
    assert.ok(nextDelivery(dir).endsWith('.delivery.json'));
    assert.ok(!(await readFile(join(dir, '.hookbuoy', 'config.json'), 'utf8')).includes('PRIVATE KEY'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('project init reuses existing test keys and blocks incomplete pairs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-reuse-'));
  try {
    const key = await createTestKeys(join(dir, '.hookbuoy'));
    const before = await readFile(key.privatePath);
    assert.deepEqual(await initProject('http://localhost:3000/hook', 'arc-commerce', dir), { reusedKeys: true });
    assert.deepEqual(await readFile(key.privatePath), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const bad = await mkdtemp(join(tmpdir(), 'hb-partial-'));
  try {
    const key = await createTestKeys(join(bad, '.hookbuoy'));
    await rm(key.publicPath);
    await assert.rejects(initProject('http://localhost:3000/hook', 'custom', bad), /Incomplete/);
  } finally { await rm(bad, { recursive: true, force: true }); }
});

test('project rejects invalid, remote or oversized config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-config-'));
  try {
    await initProject('http://localhost:3000/hook', 'custom', dir);
    await writeFile(join(dir, '.hookbuoy', 'config.json'),
      JSON.stringify({ format: 'hookbuoy.project.v1', endpoint: 'https://example.com', profile: 'custom' }));
    await assert.rejects(loadProject(dir), /loopback|localhost|http:/);
    await writeFile(join(dir, '.hookbuoy', 'config.json'), 'X'.repeat(17000));
    await assert.rejects(loadProject(dir), /16 KiB/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remembered delivery remains byte-exact and still uses test key', async () => {
  const ctx = await harness();
  try {
    await initProject(ctx.origin, 'custom', ctx.temp);
    const config = await loadProject(ctx.temp);
    assert.ok(config);
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const key = join(ctx.temp, '.hookbuoy', 'private.pem');
    const delivery = await createDelivery(body, key, 'wallets.inbound.complete');
    const path = join(ctx.temp, 'delivery.json');
    await saveDelivery(path, delivery);
    await rememberDelivery(config!, path, ctx.temp);
    const loadedConfig = await loadProject(ctx.temp);
    assert.equal(loadedConfig?.lastDelivery, path);
    const loaded = await loadDelivery(loadedConfig!.lastDelivery!);
    assert.deepEqual(loaded.bytes, body);
    assert.deepEqual(loaded.artifact.request.headers, delivery.request.headers);
    assert.equal(await verifyBytes(loaded.bytes, loaded.artifact.request.headers['x-circle-signature'], join(ctx.temp, '.hookbuoy', 'public.pem')), true);
  } finally { await ctx.close(); }
});

async function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = resolve('dist/src/cli.js');
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: ['ignore','pipe','pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout, stderr }));
  });
}

test('installed-style CLI init -> short send -> replay last, without losing original bytes', async () => {
  const ctx = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'hb-dx-cli-'));
  try {
    let r = await runCli(['init','--to',ctx.origin], dir);
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(['status'], dir);
    assert.match(r.stdout, /Test keys: ready/);
    r = await runCli(['events'], dir);
    assert.match(r.stdout, /inbound.complete/);
    r = await runCli(['send','inbound.complete','--key',ctx.keys.privatePath], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /HTTP 200/);
    const config = await loadProject(dir);
    assert.ok(config?.lastDelivery);
    const first = await loadDelivery(config!.lastDelivery!);
    r = await runCli(['replay','last','--times','3'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ctx.requests.length, 4);
    for (const item of ctx.requests) {
      assert.deepEqual(item.body, first.bytes);
      assert.equal(item.signature, first.artifact.request.headers['x-circle-signature']);
    }
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

test('without a TTY, bare CLI produces help and does not prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-no-tty-'));
  try {
    const result = await runCli([], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('fault parsing is explicit and rejects unsupported values', () => {
  assert.equal(parseFault('signature'), 'signature');
  assert.equal(parseFault('invalid-signature'), 'signature');
  assert.equal(parseFault('body'), 'body');
  assert.equal(parseFault('tampered-body'), 'body');
  assert.throws(() => parseFault('unknown-key'), /Unknown fault/);
});

test('signature fault invalidates verification without changing signed body', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const original = JSON.stringify(signed);
    const mutated = applyFault(signed, 'signature');
    assert.equal(JSON.stringify(signed), original, 'source artifact must remain unchanged');
    assert.equal(mutated.request.bodyBase64, signed.request.bodyBase64);
    assert.notEqual(mutated.request.headers['x-circle-signature'], signed.request.headers['x-circle-signature']);
    assert.equal(await verifyBytes(body, signed.request.headers['x-circle-signature'], ctx.keys.publicPath), true);
    assert.equal(await verifyBytes(body, mutated.request.headers['x-circle-signature'], ctx.keys.publicPath), false);
    const r = await deliverTimes(mutated, ctx.origin, 1, 1000, 403);
    assert.equal(r.exitCode, 0);
    assert.equal(r.results[0]!.status, 403);
  } finally { await ctx.close(); }
});

test('body fault keeps valid JSON, original signature, and produces HTTP 403', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('wallets.inbound.complete', {});
    const signed = await createDelivery(body, ctx.keys.privatePath, 'wallets.inbound.complete');
    const original = JSON.stringify(signed);
    const mutated = applyFault(signed, 'body');
    assert.equal(JSON.stringify(signed), original);
    assert.equal(mutated.request.headers['x-circle-signature'], signed.request.headers['x-circle-signature']);
    const changed = Buffer.from(mutated.request.bodyBase64, 'base64');
    assert.equal(JSON.parse(changed.toString('utf8')).notification.state, 'FAILED');
    assert.equal(await verifyBytes(changed, mutated.request.headers['x-circle-signature'], ctx.keys.publicPath), false);
    const r = await deliverTimes(mutated, ctx.origin, 1, 1000, 403);
    assert.equal(r.exitCode, 0);
    assert.equal(r.results[0]!.status, 403);
  } finally { await ctx.close(); }
});

test('menu accepts numbered choices and slash commands without shell evaluation', () => {
  assert.deepEqual(menuCommand('1'), ['send','inbound.complete']);
  assert.deepEqual(menuCommand('2'), ['replay','last']);
  assert.deepEqual(menuCommand('2', true, 403), ['replay', 'last', '--expect-status', '403']);
  assert.deepEqual(menuCommand('2', false, 409), ['replay', 'last', '--expect-status', '409']);
  assert.deepEqual(menuCommand('3'), ['check','signature']);
  assert.deepEqual(menuCommand('/events'), ['events']);
  assert.deepEqual(menuCommand('6'), ['init']);
  assert.equal(menuCommand('0'), 'quit');
  assert.equal(menuCommand(' '), null);
});

test('menu signature shortcut follows explicit Gateway context without changing other shortcuts', () => {
  assert.deepEqual(menuCommand('3'), ['check', 'signature']);
  assert.deepEqual(menuCommand('3', false), ['check', 'signature']);
  assert.deepEqual(menuCommand('3', true), ['send', 'gateway.deposit.finalized', '--fault', 'signature']);
  assert.deepEqual(menuCommand('1', true), ['send', 'inbound.complete']);
  assert.deepEqual(menuCommand('8', true), ['send', 'gateway.deposit.finalized']);
});

test('CLI check signature and check body produce an expected HTTP 403', async () => {
  const ctx = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'hb-fault-cli-'));
  try {
    let r = await runCli(['init','--to',ctx.origin], dir);
    assert.equal(r.code, 0, r.stderr);
    for (const kind of ['signature', 'body']) {
      r = await runCli(['check',kind], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /HTTP 403/);
      assert.match(r.stdout, /EXPECTED/);
    }
    assert.equal(ctx.requests.length, 2);
    const config = await loadProject(dir);
    assert.ok(config?.lastDelivery);
    const saved = await loadDelivery(config!.lastDelivery!);
    assert.equal(await verifyBytes(saved.bytes, saved.artifact.request.headers['x-circle-signature'], join(dir,'.hookbuoy','public.pem')), false);
    r = await runCli(['replay','last','--expect-status','403'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /HTTP 403/);
    assert.equal(ctx.requests.length, 3);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

test('saved negative-delivery expected status survives CLI restart and clears after a valid send', async () => {
  const ctx = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'hb-menu-replay-status-'));
  try {
    let r = await runCli(['init', '--to', ctx.origin], dir);
    assert.equal(r.code, 0, r.stderr);

    r = await runCli(['send', 'gateway.deposit.finalized', '--fault', 'signature'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /HTTP 403/);
    const negative = await loadProject(dir);
    assert.equal(negative?.lastExpectedStatus, 403);
    assert.ok(negative?.lastDelivery);

    // The menu uses the saved expected status for its numbered Replay option.
    r = await runCli(['replay', 'last', '--expect-status', String(negative!.lastExpectedStatus)], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /HTTP 403/);

    r = await runCli(['send', 'gateway.deposit.finalized', '--key', ctx.keys.privatePath], dir);
    assert.equal(r.code, 0, r.stderr);
    const positive = await loadProject(dir);
    assert.equal(positive?.lastExpectedStatus, undefined);
    assert.notEqual(positive?.lastDelivery, negative?.lastDelivery);
    r = await runCli(['replay', 'last'], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /HTTP 200/);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});

test('invalid saved expected status is rejected without weakening project validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-invalid-expected-'));
  try {
    await initProject('http://127.0.0.1:3917/api/circle/webhook', 'custom', dir);
    const path = join(dir, '.hookbuoy', 'config.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    for (const invalid of [0, 99, 600, 200.5, '403', null]) {
      await writeFile(path, JSON.stringify({ ...original, lastExpectedStatus: invalid }));
      await assert.rejects(loadProject(dir), /Invalid or unsupported project configuration/);
    }
    await writeFile(path, JSON.stringify(original));
    assert.equal((await loadProject(dir))?.lastExpectedStatus, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('negative scenario with wrong expected status exits 3', async () => {
  const ctx = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'hb-fault-status-'));
  try {
    let r = await runCli(['init','--to',ctx.origin], dir);
    assert.equal(r.code, 0);
    r = await runCli(['send','inbound.complete','--fault','signature','--expect-status','200'], dir);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /HTTP 403/);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});


test('installed-style CLI reports the released version without a project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-version-cli-'));
  try {
    for (const flag of ['--version', '-V', 'version']) {
      const r = await runCli([flag], dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), '0.3.0');
    }
    const invalid = await runCli(['--version', 'unexpected'], dir);
    assert.equal(invalid.code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('Gateway fixture uses separate event ID, wallet address, domain and amount', async () => {
  const hash = '0x' + '12'.repeat(32);
  const address = '0x' + '34'.repeat(20);
  const { body, usesFakeWallet, usesFakeHash } = await makeFixture('gateway.deposit.finalized', {
    txHash: hash, notificationId: 'gateway-notif-1', eventId: 'gateway-event-1',
    walletAddress: address, domain: '26', amount: '12.345678',
  });
  const envelope = JSON.parse(body.toString('utf8'));
  assert.equal(envelope.notificationType, 'gateway.deposit.finalized');
  assert.equal(envelope.notificationId, 'gateway-notif-1');
  assert.equal(envelope.notification.id, 'gateway-event-1');
  assert.equal(envelope.notification.walletAddress, address);
  assert.equal(envelope.notification.from, address);
  assert.equal(envelope.notification.domain, '26');
  assert.equal(envelope.notification.amount, '12.345678');
  assert.equal(envelope.notification.txHash, hash);
  assert.equal(usesFakeWallet, false);
  assert.equal(usesFakeHash, false);
});

test('Gateway fixture rejects invalid inputs and Wallets-only flags', async () => {
  const invalid = [
    { walletAddress: 'not-an-address' },
    { domain: '1.2' },
    { domain: '-1' },
    { amount: '-2' },
    { amount: '0' },
    { amount: '1.1234567' },
    { eventId: 'bad id' },
    { transactionId: 'not-gateway' },
  ];
  for (const options of invalid) {
    await assert.rejects(makeFixture('gateway.deposit.finalized', options), /Gateway|--wallet-address|--domain|--amount|--event-id/);
  }
  await assert.rejects(makeFixture('wallets.inbound.complete', { walletAddress: '0x' + '22'.repeat(20) }), /require a Gateway fixture/);
});

test('Gateway signed request can be replayed byte-exactly and rejected after tampering', async () => {
  const ctx = await harness();
  try {
    const { body } = await makeFixture('gateway.deposit.finalized', { eventId: 'gateway-01' });
    const signed = await createDelivery(body, ctx.keys.privatePath, 'gateway.deposit.finalized');
    const original = JSON.stringify(signed);
    assert.equal(await verifyBytes(body, signed.request.headers['x-circle-signature'], ctx.keys.publicPath), true);
    const report = await deliverTimes(signed, ctx.origin, 3, 1000);
    assert.equal(report.exitCode, 0);
    assert.equal(ctx.requests.length, 3);
    for (const request of ctx.requests) {
      assert.deepEqual(request.body, body);
      assert.equal(request.signature, signed.request.headers['x-circle-signature']);
    }
    const tampered = applyFault(signed, 'body');
    assert.equal(JSON.stringify(signed), original);
    const changed = Buffer.from(tampered.request.bodyBase64, 'base64');
    assert.equal(JSON.parse(changed.toString('utf8')).notification.amount, '2.000000');
    assert.equal(await verifyBytes(changed, tampered.request.headers['x-circle-signature'], ctx.keys.publicPath), false);
    assert.equal((await deliverTimes(tampered, ctx.origin, 1, 1000, 403)).exitCode, 0);
  } finally { await ctx.close(); }
});

test('CLI Gateway profile and short event route through existing delivery engine', async () => {
  const ctx = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'hb-gateway-cli-'));
  try {
    let result = await runCli(['init', 'arc-fintech', '--to', ctx.origin], dir);
    assert.equal(result.code, 0, result.stderr);
    result = await runCli(['events'], dir);
    assert.match(result.stdout, /gateway.deposit.finalized/);
    result = await runCli(['send', 'gateway.deposit.finalized', '--key', ctx.keys.privatePath, '--event-id', 'gw-event',
      '--wallet-address', '0x' + '33'.repeat(20), '--domain', '26', '--amount', '5.01'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /HTTP 200/);
    const config = await loadProject(dir);
    assert.equal(config?.profile, 'arc-fintech');
    assert.ok(config?.lastDelivery);
    const stored = await loadDelivery(config!.lastDelivery!);
    assert.equal(JSON.parse(stored.bytes.toString('utf8')).notification.id, 'gw-event');
    result = await runCli(['replay', 'last', '--times', '2'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(ctx.requests.length, 3);
    for (const request of ctx.requests) assert.deepEqual(request.body, stored.bytes);
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});
