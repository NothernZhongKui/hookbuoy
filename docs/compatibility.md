# Compatibility, fixtures and trust

## Supported preview

HookBuoy v0.2.0 is a local Node.js CLI for synthetic Circle Wallets-style notifications. It does not contact Circle or sign with a Circle key.

| Fixture alias | Synthetic `notificationType` | Synthetic `notification.state` |
| --- | --- | --- |
| `wallets.inbound.complete` | `transactions.inbound` | `COMPLETE` |
| `wallets.inbound.failed` | `transactions.inbound` | `FAILED` |

The aliases are HookBuoy names, not Circle event names. The templates contain `subscriptionId`, `notificationId`, `notificationType`, `notification`, `timestamp` and `version`; `notification` contains `id`, `state`, `txHash` and `blockchain`. `ARC-TESTNET` is sample data, not a network connection. The envelope was informed by the public [Arc Commerce webhook tests](https://github.com/circlefin/arc-commerce/blob/1a4f09d79883c15cb2fa8527a3ad210b3e01a552/tests/unit/circle-webhook.test.ts) and [handler](https://github.com/circlefin/arc-commerce/blob/1a4f09d79883c15cb2fa8527a3ad210b3e01a552/app/api/circle/webhook/route.ts), which are Apache-2.0 licensed. The fixture values are synthetic. This is not a complete Circle schema or a compatibility guarantee for every Circle product, event or verifier.

## IDs and replay

Each `send` assigns a fresh UUID to `notificationId` and `notification.id`, unless `--notification-id` or `--transaction-id` supplies the corresponding value. It also refreshes `timestamp`. In the Arc Commerce handler, `notificationId` is logged as the event ID and `notification.id` as the Circle transaction ID. Other consumers may apply different semantics or deduplication rules; do not assume these fields alone guarantee idempotency.

`--tx-hash` must be `0x` followed by 64 hexadecimal digits. Without it, HookBuoy uses synthetic hash data. A handler that matches purchases by hash requires a matching test transaction. `replay` uses the saved body, including both IDs and timestamp, without changing them.

## Signature and saved request

HookBuoy signs the UTF-8 body with ECDSA P-256 and SHA-256. It sends the base64 signature in `X-Circle-Signature` and the fixed value `hookbuoy-local-test` in `X-Circle-Key-Id`. These names match the pinned sample handler; the signature is made with your local test private key and is not authenticated by Circle.

A saved `hookbuoy.delivery.v1` file contains POST, base64 body bytes and the three explicit headers `content-type`, `x-circle-key-id` and `x-circle-signature`. Replay preserves those bytes and header values; transport-generated headers, a destination, a response and the private key are not saved. A saved file can include sensitive payload data.

In v0.2, `check signature` and `check body` create intentionally invalid signature requests after signing; these are negative test cases, not additional official Circle notification types. HTTP 403 is the default expected response and can be overridden. Saved fault cases preserve the actual bytes and signature sent. The receiver must explicitly resolve `hookbuoy-local-test` to the local public key in an isolated development environment. Keep normal signature verification intact; do not introduce this trust path in production. Loopback-only destinations and the local key are scope restrictions, not proof of an application's security.

## External pilot

The initial v0.1 manual pilot was reported by the author but its final machine-readable verification log was not retained. A separate **v0.2 automated local E2E run** was reported as `PASS` on 2026-11-04T22:06:28.848Z against pinned Arc Commerce `1a4f09d79883c15cb2fa8527a3ad210b3e01a552`: both negative cases returned HTTP 403 without state changes, a valid signed event completed a synthetic purchase and granted 10 test credits, and three replays yielded no extra credit. This is author-provided local evidence, not independently observed by the maintainers or a Circle network/on-chain settlement proof. See [pilot result](pilots/arc-commerce-v0.2-local.md) and [reproduction procedure](arc-commerce-e2e.md).
