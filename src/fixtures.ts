import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { DEFAULT_FAKE_TX_HASH, FIXTURE_NAMES, type FixtureName } from './constants.js';

export type FixtureOptions = {
  txHash?: string;
  notificationId?: string;
  transactionId?: string;
};
export function isFixtureName(name: string): name is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(name);
}
export function validateTxHash(hash: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('--tx-hash must be 0x followed by exactly 64 hex digits');
}

export async function makeFixture(name: FixtureName, options: FixtureOptions): Promise<{ body: Buffer; usesFakeHash: boolean }> {
  // Resolve relative to package root in BOTH src/ during dev and dist/src/ after build.
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = here.endsWith(`${join('dist', 'src')}`) ? resolve(here, '../..') : resolve(here, '..');
  const template = JSON.parse(await readFile(join(projectRoot, 'fixtures', 'circle-wallets', `${name}.json`), 'utf8'));
  const txHash = options.txHash ?? DEFAULT_FAKE_TX_HASH;
  validateTxHash(txHash);
  template.notificationId = options.notificationId ?? randomUUID();
  template.notification.id = options.transactionId ?? randomUUID();
  template.notification.txHash = txHash;
  template.timestamp = new Date().toISOString();
  return { body: Buffer.from(JSON.stringify(template), 'utf8'), usesFakeHash: options.txHash === undefined };
}
