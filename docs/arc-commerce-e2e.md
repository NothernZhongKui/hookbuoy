# Arc Commerce v0.2 end-to-end pilot

HookBuoy's v0.2 negative signature cases and byte-exact replay can be tested against a **real application handler**, not just a mock receiver.

This pilot uses Circle's **pinned Arc Commerce** app at commit [1a4f09d79883c15cb2fa8527a3ad210b3e01a552](https://github.com/circlefin/arc-commerce/tree/1a4f09d79883c15cb2fa8527a3ad210b3e01a552) and a **disposable local Supabase** stack. No real Circle notifications or on-chain payments are created.

## Prerequisites

- Node.js 22+, npm, Git and Docker running.
- A built HookBuoy checkout (run `npm ci && npm run build`).
- A **clean** separate Arc Commerce checkout at the exact pinned SHA:

```sh
git clone https://github.com/circlefin/arc-commerce.git /tmp/hookbuoy-arc-commerce
cd /tmp/hookbuoy-arc-commerce
git checkout --detach 1a4f09d79883c15cb2fa8527a3ad210b3e01a552
npm ci
npx supabase start
```

- Loopback port 3000 must be unused.
- Use **only** the disposable local Supabase instance, not a production or shared database.

The script temporarily inserts a development-only test-key resolver into the pinned local Circle route, starts Next.js bound to `127.0.0.1`, then restores the original route. It refuses to modify a dirty/unpinned checkout. Local Supabase API URL and service-role key come from `supabase status --output json`; they are not written into the success report.

## Run

From the HookBuoy checkout:

```sh
npm ci
npm run build
node scripts/arc-commerce-e2e.mjs /tmp/hookbuoy-arc-commerce arc-commerce-pilot-result.json
```

The output file must not already exist. The script will:

1. Create an isolated local test user and a pending purchase with a unique synthetic transaction hash.
2. Send `check signature` and confirm **HTTP 403**, zero event rows, unchanged purchase status and credits.
3. Send `check body` and confirm the same invariants.
4. Send a valid signed `inbound.complete`, verify **HTTP 200**, one event with `signature_valid = true`, status `complete`, and a credit increment of 10.
5. Replay the same signed request three times, verify HTTP 200, **zero additional credits**, one event row, and an unchanged saved-request SHA-256 fingerprint.

Temporary keys and signed payloads are kept outside the repository and deleted at exit. The local Next.js process is stopped and the local route is restored.

## Evidence and scope

Only a JSON report with `"result": "PASS"` from a real invocation against pinned Arc Commerce and local Supabase counts as a completed external pilot. An author-provided local v0.2 run is now recorded in the [pilot result](pilots/arc-commerce-v0.2-local.md); the standalone test is still reproducible. Passing HookBuoy's normal CI and syntax checking the E2E script **does not** count.

This is a **synthetic local integration test**, not proof of Circle network delivery or on-chain USDC settlement. HTTP results are checked alongside database state. Preserve the upstream SHA, HookBuoy commit SHA and machine-readable output for reproducibility; do not include credentials or private keys in reports.

After testing, run `npx supabase stop` from the Arc Commerce checkout to stop disposable containers.
