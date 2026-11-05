# Arc Fintech Gateway end-to-end pilot

This runner tests HookBuoy's **development** `gateway.deposit.finalized` fixture against Circle's real [Arc Fintech](https://github.com/circlefin/arc-fintech) Next.js Gateway route, pinned at [`0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6`](https://github.com/circlefin/arc-fintech/tree/0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6).

Only a disposable **local Supabase instance** is used; no Circle credentials, real funds or blockchain calls. The upstream repo is never modified on GitHub. A temporary local patch resolves `hookbuoy-local-test` to an isolated test public key, without disabling the signature verifier, and is automatically reverted. **Never apply that test-key resolver to deployed code**.

## Prerequisites

- Node.js 22+, npm, Git and Docker Desktop.
- A clean, dedicated checkout of Arc Fintech **at exactly the pinned commit**, with its dependencies and local Supabase started.
- Loopback port 3000 unused, and no other Supabase project running on this checkout's default local ports. Do **not** use shared or production databases.
- A built HookBuoy v0.3.1 checkout (`npm ci && npm run build`).

On macOS, in a separate terminal:

```sh
git clone https://github.com/circlefin/arc-fintech.git ~/Projects/hookbuoy-arc-fintech-pilot
cd ~/Projects/hookbuoy-arc-fintech-pilot
git checkout --detach 0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6
npm ci
npx --no-install supabase start
```

Then from the HookBuoy checkout:

```sh
npm ci
npm run build
node scripts/arc-fintech-e2e.mjs ~/Projects/hookbuoy-arc-fintech-pilot arc-fintech-gateway-result.json
```

The report path must not exist already. The script refuses an unpinned or dirty upstream checkout, non-loopback Supabase API endpoints and an occupied Next.js port. It exits nonzero on any assertion failure. A successful pilot requires the **JSON `result: PASS` report**, not a passing syntax check or a fixture-only mock. Exit cleanup stops the spawned Next.js process and restores the original upstream route. For future local runs, `npx --no-install supabase stop` can stop the disposable containers (run from the Arc Fintech directory).

## Assertions

1. Create one disposable Supabase Auth user and one pending outbound Gateway deposit with a unique transaction hash.
2. Send a Gateway notification with **invalid signature**, require HTTP 403 and unchanged database state.
3. Send a **valid JSON body modified after signing**, require HTTP 403 and unchanged database state.
4. Send a correctly signed `gateway.deposit.finalized`, require HTTP 200, one event in `webhook_events`, and the pre-existing `transactions.status` changing `PENDING → COMPLETE` at the same `tx_hash`.
5. Replay the identical saved signed delivery three times: require HTTP 200, one event, no additional transaction change and unchanged delivery artifact SHA-256.

The script writes only nonsecret report data; do not publish logs that might contain local Supabase credentials.

## Known scope

The fixture follows the pinned sample handler's fields. An HTTP 200 alone is not acceptance: unmatched synthetic hashes can be acknowledged without changing a transaction. This pilot checks the local app database, **not** Gateway balance reconciliation, Circle-origin authentication, on-chain finality or real USDC settlement. A v0.3 development revision passed this synthetic local test in GitHub Actions; see the [recorded run](pilots/arc-fintech-gateway-v0.3-actions.md). That run does not establish a new end-to-end result for v0.3.1.
