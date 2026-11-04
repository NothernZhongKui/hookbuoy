# Arc Commerce local pilot

This procedure exercises HookBuoy against the original webhook handler in [Circle's Arc Commerce sample](https://github.com/circlefin/arc-commerce) at commit `1a4f09d79883c15cb2fa8527a3ad210b3e01a552`, with a development-only change to public-key lookup in the local checkout. It does not send a real Circle notification or require changes to Circle's upstream repository.

**Prior observation:** the project author reports that a locally signed delivery received HTTP 200 and was recorded in Supabase with `signature_valid=true`. The author also reports that a test purchase was credited once on the initial send, with no additional credit on replay. The final machine-readable settlement and replay log was not retained; repeat and record the checks below before treating those outcomes as independently reproduced.

## Requirements

- Node.js 22+, npm, Git, Docker and a local Supabase stack; the [upstream setup](https://github.com/circlefin/arc-commerce/blob/1a4f09d79883c15cb2fa8527a3ad210b3e01a552/README.md) explains the app's configuration and testnet credentials.
- A built HookBuoy checkout and a fresh local test key pair, created as in the [HookBuoy quickstart](../../README.md#quickstart).
- An isolated, disposable Arc Commerce checkout and database. Use only local Supabase keys and testnet credentials. The app's other features may require Circle credentials; HookBuoy and the isolated local-key verification do not.

A public tunnel is unnecessary for HookBuoy's local delivery. Upstream's tunnel instructions apply to receiving notifications from Circle.

## 1. Prepare the app and database

In a separate directory from HookBuoy:

```sh
git clone https://github.com/circlefin/arc-commerce.git
cd arc-commerce
git checkout 1a4f09d79883c15cb2fa8527a3ad210b3e01a552
npm ci
npx supabase start
npx supabase migration up
cp .env.example .env.local
```

Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` in `.env.local` from your local Supabase output. Follow upstream's setup for any remaining application and testnet settings. Do not use a production Supabase project or production credentials. Do not commit `.env.local`.

## 2. Add explicit test-key trust

In the disposable checkout, add this import to `app/api/circle/webhook/route.ts`:

```ts
import { readFile } from "node:fs/promises";
```

At the **start** of the existing `getCirclePublicKey(keyId)` function, before the `CIRCLE_API_KEY` check, add:

```ts
if (
  process.env.NODE_ENV === "development" &&
  process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH &&
  keyId === "hookbuoy-local-test"
) {
  return readFile(process.env.HOOKBUOY_TEST_PUBLIC_KEY_PATH, "utf8");
}
```

Leave the original Circle key lookup and signature-verification code in place for all other key IDs. Set `HOOKBUOY_TEST_PUBLIC_KEY_PATH` in `.env.local` to the **absolute path** of the HookBuoy checkout's `.hookbuoy/public.pem`; restart the app after changing environment variables.

This seam accepts the test key whenever `NODE_ENV=development` and the path is set. `NODE_ENV` alone does **not** guarantee network isolation: keep the application on a loopback interface, use only a disposable local database and do not expose port 3000 through a tunnel, proxy, LAN or container port mapping. Never deploy or ship this trust seam.

```sh
npm run dev -- --hostname 127.0.0.1
```

The endpoint is `http://127.0.0.1:3000/api/circle/webhook`.

## 3. Prepare a test purchase

In local Supabase, create a **non-admin** test user through the app or local Auth tooling. Note its UUID. The signup trigger creates a `credits` row; the admin email is excluded from credit grants.

In local Supabase Studio's SQL editor, replace `<TEST_USER_UUID>` with that UUID. The constants below describe **one run only**. For every fresh run against the same database, choose a new `tx_hash`, `idempotency_key`, `--notification-id`, `--transaction-id` and delivery filenames; update **all** SQL queries and CLI commands consistently. The webhook-event table enforces uniqueness on event identifiers and a hash of the signed body. Do not reuse values from an earlier run:

```sql
INSERT INTO public.transactions
  (user_id, wallet_id, direction, amount_usdc, credit_amount,
   exchange_rate, chain, asset, tx_hash, status, idempotency_key,
   transaction_type)
VALUES
  ('<TEST_USER_UUID>'::uuid, 'hookbuoy-test-wallet', 'credit', 1, 10,
   10, 'ARC-TESTNET', 'USDC', '0x' || repeat('11', 32), 'pending',
   'hookbuoy-pilot-001', 'USER');
```

Record the transaction ID, `pending` status, `credit_amount` and the user's starting balance:

```sql
SELECT id, user_id, tx_hash, status, credit_amount
FROM public.transactions WHERE idempotency_key = 'hookbuoy-pilot-001';

SELECT user_id, credits
FROM public.credits WHERE user_id = '<TEST_USER_UUID>'::uuid;
```

The pinned handler matches `notification.txHash` case-insensitively to USER credit transactions. These are local test records, not an on-chain payment.

## 4. Send and inspect

From the HookBuoy checkout, using the same key whose public half the app trusts (and a fresh notification ID if rerunning the pilot):

```sh
node dist/src/cli.js send wallets.inbound.complete \
  --to http://127.0.0.1:3000/api/circle/webhook \
  --tx-hash 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --notification-id hookbuoy-pilot-001 \
  --transaction-id hookbuoy-local-transaction-001 \
  --save arc-pilot.delivery.json
```

Expected transport result: `HTTP 200`. Check database state as well:

```sql
SELECT circle_event_id, circle_transaction_id, mapped_status, signature_valid
FROM public.transaction_webhook_events
WHERE circle_event_id = 'hookbuoy-pilot-001';

SELECT id, status, credit_amount
FROM public.transactions WHERE idempotency_key = 'hookbuoy-pilot-001';

SELECT user_id, credits
FROM public.credits WHERE user_id = '<TEST_USER_UUID>'::uuid;
```

For this fixture, expect a logged event with `signature_valid = true`, a `complete` purchase and a balance increase of 10 relative to the recorded starting balance. HTTP 200 by itself does not establish any of these database outcomes: the handler can return 200 even when no purchase matches.

## 5. Replay and negative check

```sh
node dist/src/cli.js replay arc-pilot.delivery.json \
  --to http://127.0.0.1:3000/api/circle/webhook --times 3
```

Run the three queries again. Confirm the purchase remains `complete`, the balance has not increased again, and the original event remains recorded. The handler may log a duplicate insertion and still return 200. This checks the pinned sample and local test state; it is not a general exactly-once guarantee.

For a signature-negative check, create a modified copy of the saved file, retaining its signature:

```sh
node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const delivery = JSON.parse(await readFile('arc-pilot.delivery.json', 'utf8'));
const body = Buffer.from(delivery.request.bodyBase64, 'base64').toString('utf8');
if (!body.includes('"state":"COMPLETE"')) throw new Error('Unexpected fixture body');
delivery.request.bodyBase64 = Buffer.from(body.replace('"state":"COMPLETE"', '"state":"FAILED"')).toString('base64');
await writeFile('arc-tampered.delivery.json', JSON.stringify(delivery), { flag: 'wx', mode: 0o600 });
NODE

node dist/src/cli.js replay arc-tampered.delivery.json \
  --to http://127.0.0.1:3000/api/circle/webhook --expect-status 403
```

Expect HTTP 403 and exit 0 because 403 was explicitly expected. Check that the purchase and balance remain unchanged. Preserve the commit IDs, commands, HTTP output and before/after SQL results if publishing the outcome; remove the local trust seam when finished, and stop the development server and local Supabase stack.
