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
import { run } from '../src/cli.js';
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
