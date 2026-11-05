export const FORMAT = 'hookbuoy.delivery.v1';
export const TEST_KEY_ID = 'hookbuoy-local-test';
export const MAX_BODY_BYTES = 256 * 1024;
export const FIXTURE_NAMES = ['wallets.inbound.complete', 'wallets.inbound.failed', 'gateway.deposit.finalized'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
export const DEFAULT_GATEWAY_WALLET = '0x1111111111111111111111111111111111111111';
export const DEFAULT_FAKE_TX_HASH = `0x${'ab'.repeat(32)}`;
