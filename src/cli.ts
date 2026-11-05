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
import { applyFault, parseFault } from './faults.js';

const VERSION = '0.3.0';

const USAGE = `HookBuoy v${VERSION} — local test webhooks (NOT Circle-signed)

Usage:
  hookbuoy                                Interactive terminal (TTY only)
  hookbuoy init --to http://127.0.0.1:3000/api/webhook
  hookbuoy init arc-commerce              Local profile, endpoint :3000/api/circle/webhook
  hookbuoy init arc-fintech               Gateway endpoint :3000/api/circle/gateway-webhook
  hookbuoy status                         Show local project configuration
  hookbuoy events                         List supported synthetic scenarios
  hookbuoy send inbound.complete          Send with configured endpoint and auto-save
  hookbuoy send gateway.deposit.finalized  Synthetic Gateway deposit notification
  hookbuoy replay last --times 3          Replay last stored request exactly
  hookbuoy check signature               Wallets invalid-signature check (HTTP 403)
  hookbuoy check body                    Wallets tampered-body check (HTTP 403)
  hookbuoy keygen --out .hookbuoy         Create local P-256 test keys
  hookbuoy --version                      Show installed CLI version

Legacy aliases: wallets.inbound.complete | wallets.inbound.failed
Short aliases:  inbound.complete | inbound.failed

Send: --to URL --key FILE --tx-hash 0x... --transaction-id ID
      --notification-id ID --save FILE --fault signature|body
Gateway: --event-id ID --wallet-address 0x... --domain ID --amount N
Gateway faults: send gateway.deposit.finalized --fault signature|body
Replay: --to URL --times N (1..100)
Shared: --timeout-ms N (1..60000) --expect-status N
Faults default to expected HTTP 403; override with --expect-status for other handlers.

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
function present(results: Awaited<ReturnType<typeof deliverTimes>>, endpoint: string, expect?: number, concise = false): void {
  if (!concise) console.log(`Endpoint: ${endpoint}`);
  for (const [idx, r] of results.results.entries()) {
    const observed = r.error ?? `HTTP ${r.status}`;
    const ok = !r.error && (expect === undefined ? (r.status! >= 200 && r.status! < 300) : r.status === expect);
    const counter = results.results.length > 1 ? `${idx+1}/${results.results.length}  ` : '';
    console.log(concise
      ? `  ${counter}${observed}  ${r.ms} ms  ${ok ? 'EXPECTED' : 'UNEXPECTED'}`
      : `  ${idx+1}/${results.results.length}  ${observed}  ${r.ms} ms  ${ok ? 'EXPECTED' : 'UNEXPECTED'}`);
  }
  if (!concise) console.log('Observation: HTTP transport only; payment/settlement state NOT verified.');
}


function fixtureAlias(name: string): (typeof FIXTURE_NAMES)[number] | undefined {
  const full = name.startsWith('inbound.') ? 'wallets.' + name : name;
  return FIXTURE_NAMES.find(x => x === full);
}

// The menu can adapt its negative test to a known Gateway endpoint.
export function menuCommand(line: string, gatewayTarget = false, lastExpectedStatus?: number): string[] | 'quit' | null {
  const text = line.trim();
  if (!text) return null;
  if (text === '0' || text === '/quit' || text === '/exit' || text === 'quit' || text === 'exit') return 'quit';
  const shortcuts: Record<string, string[]> = {
    '1': ['send', 'inbound.complete'],
    '2': lastExpectedStatus === undefined ? ['replay', 'last'] : ['replay', 'last', '--expect-status', String(lastExpectedStatus)],
    '3': gatewayTarget ? ['send', 'gateway.deposit.finalized', '--fault', 'signature'] : ['check', 'signature'],
    '4': ['events'],
    '5': ['status'],
    '6': ['init'],
    '7': ['--help'],
    '8': ['send', 'gateway.deposit.finalized'],
  };
  if (shortcuts[text]) return shortcuts[text];
  const input = text.startsWith('/') ? text.slice(1) : text;
  // Only known CLI commands are evaluated. This is NOT a shell or a free-text agent.
  return input.split(/\s+/);
}

function gatewayMenuTarget(project: { endpoint: string; profile: Profile } | null): boolean {
  return !!project && (project.profile === 'arc-fintech' ||
    new URL(project.endpoint).pathname === '/api/circle/gateway-webhook');
}

async function interactive(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n  HookBuoy  •  Local webhook development');
    console.log('  Synthetic test events • HTTP only, no payment verification\n');
    while (true) {
      const project = await loadProject();
      console.log('  ' + (project ? project.profile + '  |  ' + project.endpoint : 'Not configured • choose 6 to initialize'));
      const gatewayTarget = gatewayMenuTarget(project);
      console.log('  ─────────────────────────────────────────────');
      console.log('  1  Wallets COMPLETE      8  Gateway deposit');
      console.log('  2  Replay last' + (project?.lastExpectedStatus !== undefined ? ' (HTTP ' + project.lastExpectedStatus + ')' : '') + '    3  ' + (gatewayTarget ? 'Gateway' : 'Wallets') + ' bad signature');
      console.log('  4  Events                5  Status');
      console.log('  6  ' + (project ? 'Already configured' : 'Initialize') + '    7  Help');
      console.log('  0  Exit');
      const line = (await rl.question('\n  › ')).trim();
      const chosen = menuCommand(line, gatewayTarget, project?.lastExpectedStatus);
      if (chosen === 'quit') return 0;
      if (!chosen) continue;
      const parts = [...chosen];
      if (parts[0] === 'send' && parts.length === 1) {
        const answer = (await rl.question('  Event [complete/failed] (complete): ')).trim();
        parts.push(answer === 'failed' ? 'inbound.failed' : 'inbound.complete');
      }
      if (parts[0] === 'replay' && parts.length === 1) parts.push('last');
      if (parts[0] === 'init' && parts.length === 1) {
        if (project) { console.log('  Already configured. Choose 5 for project status.'); continue; }
        const profile = (await rl.question('  Profile [custom/arc-commerce/arc-fintech] (arc-commerce): ')).trim();
        if (profile === 'custom') {
          const endpoint = (await rl.question('  Local HTTP endpoint: ')).trim();
          if (!endpoint) { console.log('  No endpoint supplied.'); continue; }
          parts.push('--to', endpoint);
        } else if (!profile || profile === 'arc-commerce') parts.push('arc-commerce');
        else if (profile === 'arc-fintech') parts.push('arc-fintech');
        else { console.log('  Unknown profile.'); continue; }
      }
      console.log();
      const code = await run(parts, { concise: true });
      if (code !== 0) console.log('  Exit code: ' + code);
      console.log();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE' || (e as Error).name === 'AbortError') return 0;
    throw e;
  } finally {
    rl.close();
  }
}

export async function run(argv: string[], display: { concise?: boolean } = {}): Promise<number> {
  try {
    const [cmd, ...tail] = argv;
    if (!cmd) {
      if (process.stdin.isTTY && process.stdout.isTTY) return interactive();
      console.log(USAGE);
      return 0;
    }
    if (['--help', '-h', 'help'].includes(cmd)) { console.log(USAGE); return 0; }
    if (['--version', '-V', 'version'].includes(cmd)) {
      if (tail.length) throw new Error('version takes no arguments');
      console.log(VERSION);
      return 0;
    }
    if (cmd === 'events') {
      if (tail.length) throw new Error('events takes no arguments');
      console.log('Available synthetic Circle scenarios:');
      for (const name of FIXTURE_NAMES) console.log(name.startsWith('wallets.')
        ? '  ' + name.replace('wallets.', '') + '  (' + name + ')'
        : '  ' + name + '  (Gateway V2)');
      console.log('Use with: hookbuoy send inbound.complete | hookbuoy send gateway.deposit.finalized');
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
      if (pos.length > 1 || (pos.length === 1 && pos[0] !== 'arc-commerce' && pos[0] !== 'arc-fintech')) {
        throw new Error('init accepts only the optional arc-commerce or arc-fintech profile');
      }
      const profile: Profile = pos[0] === 'arc-commerce' ? 'arc-commerce' : pos[0] === 'arc-fintech' ? 'arc-fintech' : 'custom';
      const endpoint = opts['--to'] ?? (profile === 'arc-commerce' ? 'http://127.0.0.1:3000/api/circle/webhook' : profile === 'arc-fintech' ? 'http://127.0.0.1:3000/api/circle/gateway-webhook' : undefined);
      if (!endpoint) throw new Error('Specify --to with a loopback HTTP URL');
      const result = await initProject(endpoint, profile);
      console.log('Project initialized: ' + profile + ' at ' + endpoint);
      console.log(result.reusedKeys ? 'Existing test keys reused.' : 'Created new LOCAL test keys.');
      console.log('Configure the receiver to trust .hookbuoy/public.pem ONLY in an isolated test environment.');
      if (profile === 'arc-fintech') console.log('Endpoint preset only: Arc Fintech does NOT trust local test keys without explicit test-only configuration.');
      return 0;
    }
    if (cmd === 'check') {
      const kind = tail[0] && !tail[0].startsWith('--') ? tail[0] : 'signature';
      if (kind !== 'signature' && kind !== 'body') throw new Error('check accepts signature or body');
      const rest = tail[0] === kind ? tail.slice(1) : tail;
      return run(['send', 'inbound.complete', '--fault', kind, ...rest], display);
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
      const { pos, opts } = parseArgs(tail, ['--key','--tx-hash','--transaction-id','--notification-id','--save','--to','--timeout-ms','--expect-status','--fault','--event-id','--wallet-address','--domain','--amount']);
      const fixture = pos.length === 1 ? fixtureAlias(pos[0]!) : undefined;
      if (!fixture) throw new Error('Choose a fixture: inbound.complete | inbound.failed | gateway.deposit.finalized (run hookbuoy events)');
      const project = await loadProject();
      const endpoint = opts['--to'] ?? project?.endpoint;
      if (!endpoint) throw new Error('Missing --to URL (or run hookbuoy init)');
      parseLocalUrl(endpoint);
      const ms = positiveInteger(opts['--timeout-ms'],3000,'--timeout-ms',60000);
      const fault = opts['--fault'] ? parseFault(opts['--fault']) : undefined;
      const expect = expectedStatus(opts['--expect-status'] ?? (fault ? '403' : undefined));
      const { body, usesFakeHash, usesFakeWallet } = await makeFixture(fixture, {
        txHash: opts['--tx-hash'], transactionId: opts['--transaction-id'], notificationId: opts['--notification-id'],
        eventId: opts['--event-id'], walletAddress: opts['--wallet-address'], domain: opts['--domain'], amount: opts['--amount'],
      });
      const signed = await createDelivery(body, opts['--key'] ?? '.hookbuoy/private.pem', fixture);
      const artifact = fault ? applyFault(signed, fault) : signed;
      const savePath = opts['--save'] ?? (project ? nextDelivery() : undefined);
      if (savePath) {
        if (project && !opts['--save']) await ensureDeliveryDir();
        await saveDelivery(savePath, artifact);
        if (project) await rememberDelivery(project, savePath, undefined, expect);
        if (!display.concise) console.log('Saved exact signed request: ' + resolve(savePath));
      }
      if (display.concise) {
        const event = JSON.parse(body.toString('utf8')) as { notification?: { id?: string } };
        const id = event.notification?.id;
        console.log((fixture === 'gateway.deposit.finalized' ? 'Gateway · deposit.finalized' : 'Wallets · ' + fixture.replace('wallets.', '')) +
          (fault ? ' · bad ' + fault : ''));
        if (id) console.log('  Event  ' + id.slice(0, 8) + '…');
      } else {
        console.log(fault
          ? 'Fault: ' + fault + ' (intentionally invalid signature; HTTP result only).'
          : 'Signature: LOCAL TEST P-256, NOT authenticated by Circle.');
        if (usesFakeHash) console.warn('Warning: synthetic txHash. For app side effects, set --tx-hash to an EXISTING local test purchase.');
        if (usesFakeWallet) console.warn('Warning: synthetic Gateway walletAddress. For app side effects, use an EXISTING local test wallet via --wallet-address.');
      }
      const report = await deliverTimes(artifact, endpoint, 1, ms, expect);
      present(report, endpoint, expect, display.concise);
      if (display.concise) {
        if (savePath) console.log('  Saved  ' + (project && !opts['--save'] ? 'last (replay with 2)' : resolve(savePath)));
        if (usesFakeHash || usesFakeWallet) console.log('  Data   synthetic' + (usesFakeHash ? ' hash' : '') + (usesFakeWallet ? ' / wallet' : ''));
      }
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
      console.log(display.concise ? 'Replay · exact saved body and signature' :
        'Replay: exact saved body + headers/signature; no re-signing, ID changes, or hidden retries.');
      const report = await deliverTimes(artifact, endpoint, times, ms, expect);
      present(report, endpoint, expect, display.concise);
      if (display.concise && report.exitCode === 3 && expect === undefined &&
          report.results.some(r => r.status === 403)) {
        console.log('  Tip: replay of a negative case? Use /replay last --expect-status 403');
      }
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
