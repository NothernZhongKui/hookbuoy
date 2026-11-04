# External pilot protocol — circlefin/arc-commerce

**Status: LOCALLY RUN on 2026-11-04.** Signed HTTP delivery and Supabase verification confirmed. Settlement and replay results developer-reported. Steps below remain a reproduction protocol.

Pinned revision at initial source inspection: `1a4f09d79883c15cb2fa8527a3ad210b3e01a552` (`master` when inspected, 2026-11-05). Confirm the correct current commit before a pilot.

## Minimal trusted test-key seam

The source handler at `app/api/circle/webhook/route.ts` calls `getCirclePublicKey(keyId)` which currently fetches the Circle API's actual public key. For a local-only pilot, modify a **throwaway fork / isolated working tree** so that only when `NODE_ENV === 'development'`, an explicit opt-in environment variable is set, AND `keyId === 'hookbuoy-local-test'`, the function returns the contents of HookBuoy's `public.pem` (otherwise use its existing Circle API behavior). Never use this trust seam in production or ship it as part of a production deployment.

A conceptual development-only guard:

```ts
if (
  process.env.NODE_ENV === 'development' &&
  process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH &&
  keyId === 'hookbuoy-local-test'
) {
  return readFileSync(process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH, 'utf8');
}
```

This code is intentionally **not automatically applied** to a third-party project. Confirm path access and imports before use. The existing `verifyCircleSignature(rawBody, signature, keyId)` crypto path should remain entirely unchanged.

## External test contract

1. Pin the exact Circle sample commit; start its local Supabase stack and Next.js app with **testnet-only** credentials.
2. Create a **local test purchase row** in `transactions` with a known valid `tx_hash`, `transaction_type = USER`, `direction = credit`, pending status and known starting credit balance. Review app schema; do not modify funds or real accounts.
3. Start the app with the local-key environment guard explicitly enabled in development only.
4. Generate test keys with `hookbuoy keygen` and send `wallets.inbound.complete --tx-hash <matching hash> --save delivery.json` to `/api/circle/webhook`.
5. Inspect local Supabase: the test purchase is settled and credits changed **once**. An HTTP 200 alone is not sufficient.
6. `hookbuoy replay delivery.json --times 3`; inspect that credits and purchase state do not change on duplicates.
7. Negative case: mutate signed request bytes without regenerating the signature; expect HTTP 403 and no DB mutation.
8. Record environment, commit, commands, outputs and result for a transparent public pilot report. If setup is too invasive, re-evaluate the product idea before release.

The standalone local test receiver is only a crypto/HTTP mock; it cannot establish that any of these external steps passed.
