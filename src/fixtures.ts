import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { DEFAULT_FAKE_TX_HASH, DEFAULT_GATEWAY_WALLET, FIXTURE_NAMES, type FixtureName } from './constants.js';

export type FixtureOptions = {
  txHash?: string;
  notificationId?: string;
  transactionId?: string;
  eventId?: string;
  walletAddress?: string;
  domain?: string;
  amount?: string;
};
export function isFixtureName(name: string): name is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(name);
}
export function validateTxHash(hash: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('--tx-hash must be 0x followed by exactly 64 hex digits');
}
function validateAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('--wallet-address must be 0x followed by exactly 40 hex digits');
}
function validateDomain(domain: string): void {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(domain) || Number(domain) > 65535)
    throw new Error('--domain must be a decimal domain ID (0..65535)');
}
function validateAmount(amount: string): void {
  if (!/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/.test(amount) || !/[1-9]/.test(amount))
    throw new Error('--amount must be a positive USDC amount with up to 6 decimals');
}
function validateEventId(id: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('--event-id must be 1..128 letters, digits, dots, underscores, colons or dashes');
}

export async function makeFixture(name: FixtureName, options: FixtureOptions): Promise<{ body: Buffer; usesFakeHash: boolean; usesFakeWallet: boolean }> {
  const gateway = name === 'gateway.deposit.finalized';
  if (gateway && options.transactionId !== undefined) throw new Error('Gateway uses --event-id, not --transaction-id');
  if (!gateway && [options.eventId, options.walletAddress, options.domain, options.amount].some(v => v !== undefined)) {
    throw new Error('--event-id, --wallet-address, --domain and --amount require a Gateway fixture');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = here.endsWith(join('dist', 'src')) ? resolve(here, '../..') : resolve(here, '..');
  const folder = gateway ? 'circle-gateway' : 'circle-wallets';
  const template = JSON.parse(await readFile(join(projectRoot, 'fixtures', folder, name + '.json'), 'utf8'));
  const txHash = options.txHash ?? DEFAULT_FAKE_TX_HASH;
  validateTxHash(txHash);
  template.notificationId = options.notificationId ?? randomUUID();
  template.timestamp = new Date().toISOString();

  if (gateway) {
    const walletAddress = options.walletAddress ?? DEFAULT_GATEWAY_WALLET;
    const domain = options.domain ?? '26';
    const amount = options.amount ?? '1.000000';
    const id = options.eventId ?? randomUUID();
    validateAddress(walletAddress);
    validateDomain(domain);
    validateAmount(amount);
    validateEventId(id);
    template.notification.id = id;
    template.notification.walletAddress = walletAddress;
    template.notification.from = walletAddress;
    template.notification.domain = domain;
    template.notification.amount = amount;
    template.notification.txHash = txHash;
  } else {
    template.notification.id = options.transactionId ?? randomUUID();
    template.notification.txHash = txHash;
  }
  return {
    body: Buffer.from(JSON.stringify(template), 'utf8'),
    usesFakeHash: options.txHash === undefined,
    usesFakeWallet: gateway && options.walletAddress === undefined,
  };
}
