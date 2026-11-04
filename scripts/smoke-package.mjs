#!/usr/bin/env node
// Validate the actual npm tarball and installed CLI, not the source checkout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { verify } from 'node:crypto';

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { encoding: 'utf8', ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error(`${bin} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

const dir = await mkdtemp(join(tmpdir(), 'hookbuoy-package-'));
let server;
try {
  const manifest = JSON.parse(await run('npm', ['pack', '--json', '--pack-destination', dir]));
  assert.equal(manifest.length, 1);
  const pack = manifest[0];
  const included = new Set(pack.files.map(file => file.path));
  for (const path of [
    'dist/src/cli.js',
    'fixtures/circle-wallets/wallets.inbound.complete.json',
    'fixtures/circle-wallets/wallets.inbound.failed.json',
    'examples/local-receiver.mjs',
    'examples/arc-commerce/README.md',
    'docs/compatibility.md',
    'README.md',
    'LICENSE',
  ]) assert.ok(included.has(path), `Missing from tarball: ${path}`);
  for (const path of included) {
    assert.ok(!/(^|\/)(?:\.hookbuoy|node_modules|dist\/tests)(\/|$)|\.delivery\.json$|\.pem$|\.key$|(^|\/)\.env(?:\.|$)/.test(path), `Unexpected package file: ${path}`);
  }

  await run('npm', [
    'install', '--prefix', dir, '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', '--offline', join(dir, pack.filename),
  ]);

  const cli = join(dir, 'node_modules', '.bin', 'hookbuoy');
  const help = await run(cli, ['--help'], { cwd: dir });
  assert.match(help, /Usage:/);
  assert.match(help, /hookbuoy replay/);

  // Verify the shipped v0.2 initialization and aliases, not only the v0.1 legacy commands.
  const events = await run(cli, ['events'], { cwd: dir });
  assert.match(events, /inbound.complete/);
  const publicKey = await readFile(join(dir, '.hookbuoy', 'public.pem'));

  const seen = [];
  let rejected = 0;
  server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const signature = req.headers['x-circle-signature'];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/circle/webhook');
      assert.equal(req.headers['x-circle-key-id'], 'hookbuoy-local-test');
      assert.equal(typeof signature, 'string');
      if (!verify('sha256', bytes, publicKey, Buffer.from(signature, 'base64'))) {
        rejected += 1;
        res.writeHead(403).end();
        return;
      }
      seen.push({ bytes, signature });
      res.writeHead(200).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/circle/webhook`;
  await run(cli, ['init', '--to', endpoint], { cwd: dir });
  const status = await run(cli, ['status'], { cwd: dir });
  assert.match(status, /Test keys: ready/);
  const sent = await run(cli, ['send', 'inbound.complete'], { cwd: dir });
  assert.match(sent, /HTTP 200/);
  const replay = await run(cli, ['replay', 'last', '--times', '3'], { cwd: dir });
  assert.match(replay, /HTTP 200/);
  const badSignature = await run(cli, ['check', 'signature'], { cwd: dir });
  assert.match(badSignature, /HTTP 403/);
  const badBody = await run(cli, ['check', 'body'], { cwd: dir });
  assert.match(badBody, /HTTP 403/);
  assert.equal(rejected, 2);
  assert.equal(seen.length, 4);
  for (const event of seen.slice(1)) {
    assert.deepEqual(event.bytes, seen[0].bytes);
    assert.equal(event.signature, seen[0].signature);
  }
  console.log('PASS: packed files, installed v0.2 CLI, init, short send, exact replay (4 accepted deliveries), and two rejected invalid signatures');
} finally {
  if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  await rm(dir, { recursive: true, force: true });
}
