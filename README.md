# HookBuoy (v0.1.0-dev.1)

**Local-first Circle Wallets test webhook signing and exact replay.**

This repository is an **experimental local vertical slice**, not a completed v0.1 release. HookBuoy is **not affiliated with Circle**. It signs with a **local test key**, never with Circle's private key. The receiving app must **explicitly** trust the local test public key in a development-only configuration; an unchanged Circle production-style verifier must reject these requests.

## Requirements

- Node.js 22 or newer
- For development: `npm install` then `npm run build` (TypeScript and Node types are build-only dependencies)
- No Circle credentials, accounts, public tunnel, database, or blockchain node to exercise the local test harness

## Quickstart

If using the attached development ZIP, compiled JavaScript is already included and can run immediately:

```sh
node dist/src/cli.js --help
node dist/src/cli.js keygen --out .hookbuoy
```

For a fresh source checkout (for example, a future GitHub repository), install the **build-only** dependencies first:

```sh
npm install
npm run build
npm test
```


**Start an HTTP receiver configured with `.hookbuoy/public.pem` as its trusted public key for *local test requests only*.** The optional self-contained test receiver below demonstrates this; it is not Circle's `arc-commerce` handler:

```sh
node examples/local-receiver.mjs .hookbuoy/public.pem
```

In another terminal:

```sh
node dist/src/cli.js send wallets.inbound.complete \
  --to http://127.0.0.1:3917/api/circle/webhook \
  --save first.delivery.json
node dist/src/cli.js replay first.delivery.json \
  --to http://127.0.0.1:3917/api/circle/webhook \
  --times 3
```

To test settlement against an external application, `--tx-hash` must reference an **existing local test purchase** and the handler must recognize it. An HTTP 200 alone does not prove a transaction was credited or even matched:

```sh
node dist/src/cli.js send wallets.inbound.complete \
  --tx-hash 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --transaction-id my-test-transaction \
  --to http://127.0.0.1:3000/api/circle/webhook \
  --save purchase.delivery.json
```

## CLI contract

| Command | Action |
| --- | --- |
| `keygen --out DIR` | Generate P-256 local test private/public PEM key pair. Refuses overwrite. |
| `send FIXTURE --to URL [--save FILE]` | Render Circle Wallets-shaped fixture, sign actual UTF-8 body bytes, send one POST. |
| `replay FILE --to URL [--times N]` | Send byte-identical original body and original signed headers sequentially N times, no re-signing or hidden retry. |

`--expect-status N` matches an exact HTTP response (e.g. `403` when checking a bad signature). Defaults to any 2xx. `--timeout-ms` defaults to 3000. Only loopback HTTP addresses are accepted (`localhost`, `127.0.0.1`, `[::1]`); HTTP redirects are never followed.

| Exit code | Interpretation |
| --- | --- |
| `0` | All observed HTTP statuses matched the expectation. Does **not** assert business processing. |
| `2` | Invalid CLI input, invalid saved request, unavailable test key, or local file error. |
| `3` | Unexpected HTTP response status. |
| `4` | Connection failure or timeout. |

## Fixtures

Two experimental **Circle Wallets** envelope templates are bundled: `wallets.inbound.complete` and `wallets.inbound.failed`, both with real event type `transactions.inbound`. The names beginning `wallets.` are **HookBuoy fixture aliases**, not Circle event names. Payloads are synthetic; no claim is made that all fields are official, complete, or version-invariant.

- Envelope based on the public Circle [Arc Commerce unit test](https://github.com/circlefin/arc-commerce/blob/master/tests/unit/circle-webhook.test.ts), inspected 2026-11-05.
- Values `notificationId` (delivery identity) and `notification.id` (underlying transaction identity) are intentionally separate; the source code of the public demo distinguishes them.
- Each `send` generates new identifiers and timestamp unless explicitly overridden; `replay` **never** changes any of them.
- The default `txHash` is dummy data and will not match an existing purchase. Provide `--tx-hash` to reach a meaningful business path.
- The signature mimics the Circle Wallets verification mechanism used by the sample handler (`ECDSA P-256 with SHA-256`, signature base64; `X-Circle-Signature`, `X-Circle-Key-Id`). The trust root is strictly local and synthetic.

## Saved delivery file

`--save` writes a `hookbuoy.delivery.v1` JSON envelope containing the **original byte sequence encoded as base64** and its original signed headers; no test private key, API token, or remote endpoint is saved. Replay decodes the original body bytes; it does **not** parse/re-serialize the embedded payload. Saved files are created with restrictive file permissions and are never silently overwritten.

## Boundaries

- **No actual Circle signing authority**: a production verifier will reject synthetic signatures.
- **No production bypasses**: never enable local test trust on a deployed application.
- **No provider framework, tunnel, payment creation, ledger validation, dashboard or SaaS**.
- **External pilot completed locally** on `arc-commerce` at `1a4f09d`. Signed HTTP 200 and Supabase `signature_valid=true` confirmed. Test-purchase settlement and no double-credit after replay were developer-reported; final verification output was not retained.
- No automated claim that HTTP 200 implies payment success, exactly-once processing, or correct settlement.

## Tests

```sh
npm test
```

Tests spin up an in-process loopback HTTP server that performs **real P-256 signature verification** with test trust, checks byte-exact replay and tamper rejection, and exercises HTTP 500, timeout, and connection failure. They are **not** a substitute for independent Circle app integration.

## Contribution direction

Keep the tool small. First external milestone is an independently reproducible `arc-commerce` pilot with the minimal amount of explicit, development-only test trust wiring. Do not publish to npm until package name/trademark checks and that pilot are complete.
