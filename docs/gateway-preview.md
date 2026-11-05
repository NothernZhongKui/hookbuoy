# Gateway deposit notifications

HookBuoy supports a first **synthetic** Gateway fixture: `gateway.deposit.finalized`. The target consumer is the Circle [Arc Fintech sample](https://github.com/circlefin/arc-fintech), pinned for review at commit `0b10d386ce2a30e1a0572f28a5aad4aaf4fc66e6` (`master`, 2026-11-05).

This is not a live Gateway notification or a guarantee of compatibility with every Circle subscription. The fixture is informed by Arc Fintech's `GatewayDepositNotification` type and its `app/api/circle/gateway-webhook/route.ts` handler. In particular, that handler uses `notification.id` to deduplicate, `txHash` to reconcile an existing local transaction, and `walletAddress` / `domain` to attribute otherwise unknown deposits.

## Commands

```sh
# First-time configuration from a clean local project folder:
hookbuoy init arc-fintech
hookbuoy events

# Default local target: http://127.0.0.1:3000/api/circle/gateway-webhook
hookbuoy send gateway.deposit.finalized

# Supply an EXISTING local test hash and wallet address for app-side matching:
hookbuoy send gateway.deposit.finalized \
  --tx-hash 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
  --wallet-address 0x1111111111111111111111111111111111111111 \
  --domain 26 --amount 1.25 --event-id gateway-test-1

hookbuoy replay last --times 3

# Negative tests, with the same configured local endpoint:
hookbuoy send gateway.deposit.finalized --fault signature --expect-status 403
hookbuoy send gateway.deposit.finalized --fault body --expect-status 403
```

`init arc-fintech` saves a **local endpoint preset**, creates a local P-256 test key pair or reuses an existing complete pair, and does nothing to Arc Fintech. It does not create a Gateway subscription or register any addresses. The unmodified Arc Fintech handler fetches Circle public keys and therefore does **not** trust `hookbuoy-local-test`. You must explicitly configure a local-only test public-key resolver while preserving signature verification. Never enable this local trust path outside an isolated development setup.

## Fixture semantics

| HookBuoy field/flag | Purpose |
| --- | --- |
| `notificationType` | `gateway.deposit.finalized` |
| `notificationId` | Envelope ID generated per send or controlled with `--notification-id` |
| `notification.id` | Gateway event ID used for dedupe by pinned Arc Fintech, controlled with `--event-id` |
| `notification.txHash` | EVM hash, default synthetic or set with `--tx-hash` |
| `notification.walletAddress`, `notification.from` | Synthetic depositor EVM address or `--wallet-address` |
| `notification.domain` | Circle domain ID as decimal string; default `26` (Arc Testnet in this sample) |
| `notification.amount` | Decimal USDC amount as string; default `1.000000`; `--amount` accepts up to 6 decimal places |

Unlike Wallets fixtures, the Gateway event does not contain a `notification.state` field. `--fault body` changes its signed `amount` after signing, preserving valid JSON but invalidating verification. `--fault signature` changes the signature. Neither changes the original signed object.

Each `send` creates a fresh notification and event ID unless overridden. Each `replay` reproduces **exactly the saved bytes and signature**, without changing IDs or updating timestamps. The CLI checks HTTP status only; an application may acknowledge an event even if no transaction or wallet matched.

## External pilot acceptance

A meaningful Arc Fintech pilot must run against a disposable local database and an isolated test-only trust resolver. Record all of the following before claiming end-to-end success:

1. Correctly signed Gateway notification returns 200 and matches an existing synthetic deposit transaction by `tx_hash`.
2. One matching row changes to `COMPLETE` and a `webhook_events` entry is recorded.
3. Three exact replays return 200 but do not add rows or repeat side effects.
4. Invalid signature and tampered body return 403, with no database changes.
5. Non-matching synthetic hashes return only an HTTP observation and are **not** presented as successful settlement.

**External pilot completed (2026-11-05):** the pinned Arc Fintech handler passed a synthetic local Supabase E2E with HTTP 403 negative tests, a PENDING → COMPLETE Gateway deposit, one event and three idempotent replays. See [recorded Actions evidence](pilots/arc-fintech-gateway-v0.3-actions.md) and [reproduction guide](arc-fintech-e2e.md). This is not a real Circle-delivered notification or a settlement proof.
