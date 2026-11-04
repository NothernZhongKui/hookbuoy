#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestKeys } from './keys.js';
import { createDelivery, loadDelivery, saveDelivery } from './artifact.js';
import { isFixtureName, makeFixture } from './fixtures.js';
import { deliverTimes, parseLocalUrl } from './delivery.js';
import { ensureDeliveryDir, initProject, keyStatus, loadProject, nextDelivery, rememberDelivery, type Profile } from './project.js';
import { FIXTURE_NAMES } from './constants.js';

const USAGE = `HookBuoy v0.2.0-dev.1 — local test webhooks (NOT Circle-signed)

Usage:
  hookbuoy                                Interactive terminal (TTY only)
  hookbuoy init --to http://127.0.0.1:3000/api/webhook
  hookbuoy init arc-commerce              Local profile, endpoint :3000/api/circle/webhook
  hookbuoy status                         Show local project configuration
  hookbuoy events                         List supported synthetic scenarios
  hookbuoy send inbound.complete          Send with configured endpoint and auto-save
  hookbuoy replay last --times 3          Replay last stored request exactly
  hookbuoy keygen --out .hookbuoy         Create local P-256 test keys

Legacy aliases: wallets.inbound.complete | wallets.inbound.failed
Short aliases:  inbound.complete | inbound.failed

Send: --to URL --key FILE --tx-hash 0x... --transaction-id ID
      --notification-id ID --save FILE
Replay: --to URL --times N (1..100)
Shared: --timeout-ms N (1..60000) --expect-status N

Config: .hookbuoy/config.json, local-only; endpoints must use HTTP loopback.
Save:  configured sends automatically create immutable .hookbuoy/deliveries/*.delivery.json
Safety: local TEST keys, no Circle credentials or production trust.
Exit codes: 0 expected HTTP; 2 usage/input; 3 unexpected HTTP; 4 network/timeout.
`;

type Args = { pos: string[]; opts: Record<string, string> };
function parseArgs(argv: string[], allowed: readonly string[]): Args {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (!item.startsWith('--')) { pos.push(item); continue; }
    if (!allowed.includes(item)) throw new Error(`Unknown option ${item}`);
    if (opts[item] !== undefined) throw new Error(`Duplicate option ${item}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${item} requires a value`);
    opts[item] = value;
  }
  return { pos, opts };
}
function positiveInteger(input: string | undefined, fallback: number, name: string, max: number): number {
  if (input === undefined) return fallback;
  if (!/^[0-9]+$/.test(input)) throw new Error(`${name} must be a positive integer`);
  const v = Number(input);
  if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new Error(`${name} must be 1..${max}`);
  return v;
}
function expectedStatus(input?: string): number | undefined {
  if (input === undefined) return undefined;
  if (!/^[0-9]{3}$/.test(input) || Number(input) < 100 || Number(input) > 599) throw new Error('--expect-status must be HTTP 100..599');
  return Number(input);
}
function present(results: Awaited<ReturnType<typeof deliverTimes>>, endpoint: string, expect?: number): void {
  console.log(`Endpoint: ${endpoint}`);
  for (const [idx, r] of results.results.entries()) {
    const observed = r.error ?? `HTTP ${r.status}`;
    const ok = !r.error && (expect === undefined ? (r.status! >= 200 && r.status! < 300) : r.status === expect);
    console.log(`  ${idx+1}/${results.results.length}  ${observed}  ${r.ms} ms  ${ok ? 'EXPECTED' : 'UNEXPECTED'}`);
  }
  console.log('Observation: HTTP transport only; payment/settlement state NOT verified.');
}


function fixtureAlias(name: string): (typeof FIXTURE_NAMES)[number] | undefined {
  const full = name.startsWith('inbound.') ? 'wallets.' + name : name;
  return FIXTURE_NAMES.find(x => x === full);
}

async function interactive(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('HookBuoy • local webhook development');
    console.log('Commands: /init, /status, /events, /send, /replay, /help, /quit');
    while (true) {
      const line = (await rl.question('hookbuoy > ')).trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') return 0;
      if (line === '/help') { console.log(USAGE); continue; }
      const parts = line.split(/\s+/);
      if (parts[0]?.startsWith('/')) parts[0] = parts[0].slice(1);
      if (parts[0] === 'send' && parts.length === 1) {
        parts.push('inbound.complete');
      }
      if (parts[0] === 'replay' && parts.length === 1) parts.push('last');
      if (parts[0] === 'init' && parts.length === 1) {
        const endpoint = (await rl.question('Local HTTP endpoint: ')).trim();
        if (endpoint) parts.push('--to', endpoint);
      }
      const code = await run(parts);
      if (code !== 0) console.log('Exit code:', code);
    }
  } catch (e) {
    if ((e as Error).code === 'ERR_USE_AFTER_CLOSE' || (e as Error).name === 'AbortError') return 0;
    throw e;
  } finally {
    rl.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    const [cmd, ...tail] = argv;
    if (!cmd) {
      if (process.stdin.isTTY && process.stdout.isTTY) return interactive();
      console.log(USAGE);
      return 0;
    }
    if (['--help', '-h', 'help'].includes(cmd)) { console.log(USAGE); return 0; }
    if (cmd === 'events') {
      if (tail.length) throw new Error('events takes no arguments');
      console.log('Available synthetic Circle Wallets scenarios:');
      for (const name of FIXTURE_NAMES) console.log('  ' + name.replace('wallets.', '') + '  (' + name + ')');
      console.log('Use with: hookbuoy send inbound.complete');
      return 0;
    }
    if (cmd === 'status') {
      if (tail.length) throw new Error('status takes no arguments');
      const config = await loadProject();
      console.log(config ? 'Profile: ' + config.profile : 'Project: not initialized (run hookbuoy init)');
      if (config) {
        console.log('Endpoint: ' + config.endpoint);
        console.log('Test keys: ' + await keyStatus());
        console.log('Last saved delivery: ' + (config.lastDelivery ?? 'none'));
      }
      return 0;
    }
    if (cmd === 'init') {
      const { pos, opts } = parseArgs(tail, ['--to']);
      if (pos.length > 1 || (pos.length === 1 && pos[0] !== 'arc-commerce')) {
        throw new Error('init accepts only the optional arc-commerce profile');
      }
      const profile: Profile = pos[0] === 'arc-commerce' ? 'arc-commerce' : 'custom';
      const endpoint = opts['--to'] ?? (profile === 'arc-commerce' ? 'http://127.0.0.1:3000/api/circle/webhook' : undefined);
      if (!endpoint) throw new Error('Specify --to with a loopback HTTP URL');
      const result = await initProject(endpoint, profile);
      console.log('Project initialized: ' + profile + ' at ' + endpoint);
      console.log(result.reusedKeys ? 'Existing test keys reused.' : 'Created new LOCAL test keys.');
      console.log('Configure the receiver to trust .hookbuoy/public.pem ONLY in an isolated test environment.');
      return 0;
    }
    if (cmd === 'keygen') {
      const { pos, opts } = parseArgs(tail, ['--out']);
      if (pos.length !== 0) throw new Error('keygen takes no positional arguments');
      const paths = await createTestKeys(opts['--out'] ?? '.hookbuoy');
      console.log('Created LOCAL TEST keys (not Circle keys).');
      console.log(`Private: ${paths.privatePath}\nPublic:  ${paths.publicPath}`);
      console.log('Configure the RECEIVER to trust public.pem only in an explicitly isolated local test environment.');
      return 0;
    }
    if (cmd === 'send') {
      const { pos, opts } = parseArgs(tail, ['--key','--tx-hash','--transaction-id','--notification-id','--save','--to','--timeout-ms','--expect-status']);
      const fixture = pos.length === 1 ? fixtureAlias(pos[0]!) : undefined;
      if (!fixture) throw new Error('Choose a fixture: inbound.complete | inbound.failed (run hookbuoy events)');
      const project = await loadProject();
      const endpoint = opts['--to'] ?? project?.endpoint;
      if (!endpoint) throw new Error('Missing --to URL (or run hookbuoy init)');
      parseLocalUrl(endpoint);
      const ms = positiveInteger(opts['--timeout-ms'],3000,'--timeout-ms',60000);
      const expect = expectedStatus(opts['--expect-status']);
      const { body, usesFakeHash } = await makeFixture(fixture, {
        txHash: opts['--tx-hash'], transactionId: opts['--transaction-id'], notificationId: opts['--notification-id'],
      });
      const artifact = await createDelivery(body, opts['--key'] ?? '.hookbuoy/private.pem', fixture);
      const savePath = opts['--save'] ?? (project ? nextDelivery() : undefined);
      if (savePath) {
        if (project && !opts['--save']) await ensureDeliveryDir();
        await saveDelivery(savePath, artifact);
        if (project) await rememberDelivery(project, savePath);
        console.log('Saved exact signed request: ' + resolve(savePath));
      }
      console.log('Signature: LOCAL TEST P-256, NOT authenticated by Circle.');
      if (usesFakeHash) console.warn('Warning: synthetic txHash. For app side effects, set --tx-hash to an EXISTING local test purchase.');
      const report = await deliverTimes(artifact, endpoint, 1, ms, expect);
      present(report, endpoint, expect);
      return report.exitCode;
    }
    if (cmd === 'replay') {
      const { pos, opts } = parseArgs(tail, ['--to','--times','--timeout-ms','--expect-status']);
      if (pos.length !== 1) throw new Error('replay expects a saved .json path or last');
      const project = await loadProject();
      const endpoint = opts['--to'] ?? project?.endpoint;
      if (!endpoint) throw new Error('Missing --to URL (or run hookbuoy init)');
      parseLocalUrl(endpoint);
      const path = pos[0] === 'last' ? project?.lastDelivery : pos[0];
      if (!path) throw new Error('No saved delivery for replay last');
      const times = positiveInteger(opts['--times'],1,'--times',100);
      const ms = positiveInteger(opts['--timeout-ms'],3000,'--timeout-ms',60000);
      const expect = expectedStatus(opts['--expect-status']);
      const { artifact } = await loadDelivery(path);
      console.log('Replay: exact saved body + headers/signature; no re-signing, ID changes, or hidden retries.');
      const report = await deliverTimes(artifact, endpoint, times, ms, expect);
      present(report, endpoint, expect);
      return report.exitCode;
    }
    throw new Error(`Unknown command ${cmd}`);
  } catch (e) {
    console.error(`HookBuoy error: ${(e as Error).message}`);
    console.error('Run: hookbuoy --help');
    return 2;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2));
}
