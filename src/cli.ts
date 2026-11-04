#!/usr/bin/env node
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestKeys } from './keys.js';
import { createDelivery, loadDelivery, saveDelivery } from './artifact.js';
import { isFixtureName, makeFixture } from './fixtures.js';
import { deliverTimes, parseLocalUrl } from './delivery.js';

const USAGE = `HookBuoy v0.1.0-dev.1 — Circle Wallets local test webhooks (NOT Circle-signed)

Usage:
  hookbuoy keygen --out .hookbuoy
  hookbuoy send wallets.inbound.complete --to http://127.0.0.1:3000/api/webhook [options]
  hookbuoy replay delivery.json --to http://127.0.0.1:3000/api/webhook [options]

Send options:
  --key FILE                Test private PEM file (default .hookbuoy/private.pem)
  --tx-hash 0x...            Existing test transaction hash (64 hex digits)
  --transaction-id ID       Existing test transaction ID (default random UUID)
  --notification-id ID      Override generated notification ID
  --save FILE               Save signed exact request for later replay (never overwrites)
Shared delivery options:
  --timeout-ms N            Request timeout, 1..60000 (default 3000)
  --expect-status N         Exact expected HTTP status (default any 2xx)
Replay options:
  --times N                 Total sequential deliveries 1..100 (default 1)

Security: local HTTP loopback only; no Circle credentials, no payment creation.
Exit codes: 0 expected HTTP; 2 usage/input error; 3 unexpected HTTP; 4 network/timeout.
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

export async function run(argv: string[]): Promise<number> {
  try {
    const [cmd, ...tail] = argv;
    if (!cmd || ['--help', '-h', 'help'].includes(cmd)) { console.log(USAGE); return 0; }
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
      if (pos.length !== 1 || !isFixtureName(pos[0]!)) throw new Error('Choose a fixture: wallets.inbound.complete | wallets.inbound.failed');
      if (!opts['--to']) throw new Error('Missing --to URL');
      parseLocalUrl(opts['--to']);
      const ms = positiveInteger(opts['--timeout-ms'],3000,'--timeout-ms',60000);
      const expect = expectedStatus(opts['--expect-status']);
      const { body, usesFakeHash } = await makeFixture(pos[0]!, {
        txHash: opts['--tx-hash'], transactionId: opts['--transaction-id'], notificationId: opts['--notification-id'],
      });
      const artifact = await createDelivery(body, opts['--key'] ?? '.hookbuoy/private.pem', pos[0]!);
      if (opts['--save']) { await saveDelivery(opts['--save'], artifact); console.log(`Saved exact signed request: ${resolve(opts['--save'])}`); }
      console.log('Signature: LOCAL TEST P-256, NOT authenticated by Circle.');
      if (usesFakeHash) console.warn('Warning: synthetic txHash. For app side effects, set --tx-hash to an EXISTING local test purchase.');
      const report = await deliverTimes(artifact, opts['--to'], 1, ms, expect);
      present(report, opts['--to'], expect);
      return report.exitCode;
    }
    if (cmd === 'replay') {
      const { pos, opts } = parseArgs(tail, ['--to','--times','--timeout-ms','--expect-status']);
      if (pos.length !== 1) throw new Error('replay expects exactly one saved .json path');
      if (!opts['--to']) throw new Error('Missing --to URL');
      parseLocalUrl(opts['--to']);
      const times = positiveInteger(opts['--times'],1,'--times',100);
      const ms = positiveInteger(opts['--timeout-ms'],3000,'--timeout-ms',60000);
      const expect = expectedStatus(opts['--expect-status']);
      const { artifact } = await loadDelivery(pos[0]!);
      console.log('Replay: exact saved body + headers/signature; no re-signing, ID changes, or hidden retries.');
      const report = await deliverTimes(artifact, opts['--to'], times, ms, expect);
      present(report, opts['--to'], expect);
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
