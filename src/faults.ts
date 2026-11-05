import type { SavedDelivery } from './artifact.js';

export type Fault = 'signature' | 'body';

export function parseFault(value: string): Fault {
  if (value === 'signature' || value === 'invalid-signature') return 'signature';
  if (value === 'body' || value === 'tampered-body') return 'body';
  throw new Error('Unknown fault; choose signature | body');
}

// Faults are applied *after* signing. Never modify the original signed artifact.
export function applyFault(original: SavedDelivery, fault: Fault): SavedDelivery {
  if (fault === 'signature') {
    const raw = Buffer.from(original.request.headers['x-circle-signature'], 'base64');
    if (!raw.length) throw new Error('Missing signature');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    return {
      ...original,
      request: {
        ...original.request,
        headers: {
          ...original.request.headers,
          'x-circle-signature': raw.toString('base64'),
        },
      },
    };
  }

  const rawBody = Buffer.from(original.request.bodyBase64, 'base64').toString('utf8');
  // Gateway has no transaction.state; alter its amount after signing while keeping JSON valid.
  if (rawBody.includes('"notificationType":"gateway.deposit.finalized"')) {
    const data: unknown = JSON.parse(rawBody);
    if (!data || typeof data !== 'object') throw new Error('Invalid Gateway body');
    const event = (data as { notification?: { amount?: unknown } }).notification;
    if (typeof event?.amount !== 'string') throw new Error('Missing Gateway amount');
    const before = '"amount":' + JSON.stringify(event.amount);
    const after = '"amount":' + JSON.stringify(event.amount === '1.000000' ? '2.000000' : '1.000000');
    if (!rawBody.includes(before)) throw new Error('Missing Gateway amount field in signed bytes');
    return { ...original, request: { ...original.request,
      bodyBase64: Buffer.from(rawBody.replace(before, after), 'utf8').toString('base64'),
    } };
  }
  const currentState = rawBody.includes('"state":"COMPLETE"') ? 'COMPLETE' :
                       rawBody.includes('"state":"FAILED"') ? 'FAILED' : null;
  if (!currentState) throw new Error('Body fault requires a supported Circle Wallets state');
  const changed = rawBody.replace(
    '"state":"' + currentState + '"',
    '"state":"' + (currentState === 'COMPLETE' ? 'FAILED' : 'COMPLETE') + '"',
  );
  return {
    ...original,
    request: {
      ...original.request,
      bodyBase64: Buffer.from(changed, 'utf8').toString('base64'),
    },
  };
}
