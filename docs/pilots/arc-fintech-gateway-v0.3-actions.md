# Arc Fintech Gateway external local E2E — recorded PASS

**Evidence level:** GitHub Actions runner executed the actual, pinned Circle Arc Fintech webhook handler against an isolated local Supabase database. Not a Circle-origin event or an on-chain transfer.

| Field | Value |
| --- | --- |
| Run | [Arc Fintech Gateway E2E #42022278809](https://github.com/NothernZhongKui/hookbuoy/actions/runs/42022278809) |
| Output artifact | `arc-fintech-gateway-result` (ID `13412242219`, GitHub artifact retention 14 days) |
| UTC time | 2026-11-05T11:53:17.689Z |
| HookBuoy revision | `7416b92362313086b298769f66d1d1a7c121105c` |
| HookBuoy package | `0.3.0-dev.1` (source preview; **not published to npm**) |
| External app | `circlefin/arc-fintech` |
| Pinned upstream SHA | `0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6` |
| Verification | Github Actions E2E job **success**; JSON report `result: PASS` |

## Observed assertions

| Scenario | HTTP | Application / local database |
| --- | --- | --- |
| Invalid P-256 signature | 403 | No event row, existing pending transaction unchanged |
| Body altered after P-256 signing | 403 | No event row, existing pending transaction unchanged |
| Valid `gateway.deposit.finalized` | 200 | Existing `OUTBOUND` transaction matched by `tx_hash`: `PENDING → COMPLETE`; one `webhook_events` row |
| Replay same signed delivery 3× | 200 each | No extra event rows; completed transaction unchanged |
| Delivery integrity | n/a | Saved delivery SHA-256 unchanged after replay |

The pinned handler's original Circle public-key lookup was amended **only in the disposable checkout** to resolve the special `hookbuoy-local-test` key to a generated local public key in development. The handler still applied its normal signature verification. The runner restored the original file and stopped Next.js. Circle API credentials and real USDC were not used.

## Interpretation and limits

This proves a **local integration behavior**: correct synthetic webhook causes the pinned app to reconcile a previously created synthetic transaction and exact replay is idempotent on the observed database fields. It does **not** prove compatibility with future versions of Arc Fintech, actual Gateway notification payloads beyond this sample, Circle-origin authentication, network finality or real money movement. Running an unmodified official app in production will **not** trust the local test key.

The runner and reproduction guide are at [`scripts/arc-fintech-e2e.mjs`](../../scripts/arc-fintech-e2e.mjs) and [`docs/arc-fintech-e2e.md`](../arc-fintech-e2e.md). Re-run the pinned E2E after changing the fixture or external handler.
