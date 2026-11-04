# HookBuoy

Local webhook signing and replay for payment integration tests.

HookBuoy sends synthetic Circle Wallets-shaped notifications to a local HTTP handler using a test key you control. Save a signed delivery and replay the same body bytes and signature to exercise your handler's duplicate-delivery behavior.

**Status:** Experimental developer preview (`0.1.0-dev.1`). HookBuoy is an independent project and is not affiliated with Circle. Its requests are **not signed by Circle**.

## Why HookBuoy?

Use it when you need a small, local loop for testing Circle Wallets-style signature verification and duplicate handling. A raw `curl` request does not create the test signature or preserve a signed delivery for replay; Stripe CLI targets Stripe, while Hookdeck provides a broader webhook development platform. HookBuoy is scoped to locally signed fixtures and replay.

## Requirements and installation

Node.js 22 or newer, npm and Git are required to build from source. For this preview, use a source checkout.

```sh
git clone https://github.com/NothernZhongKui/hookbuoy.git
cd hookbuoy
npm ci
npm run build
```

While the repository is private, use a GitHub account with access and an authenticated clone URL if needed. The commands below run the built CLI from this checkout. To inspect all options:

```sh
node dist/src/cli.js --help
```

## Quickstart

Run these commands from the repository root. Generate a **dedicated local test key pair**:

```sh
node dist/src/cli.js keygen --out .hookbuoy
```

Key generation refuses to overwrite an existing key pair. Start the example receiver in the first terminal. It explicitly trusts this test public key and listens only on loopback:

```sh
node examples/local-receiver.mjs .hookbuoy/public.pem
```

In a second terminal, from the same directory:

```sh
node dist/src/cli.js send wallets.inbound.complete \
  --to http://127.0.0.1:3917/api/circle/webhook \
  --save first.delivery.json

node dist/src/cli.js replay first.delivery.json \
  --to http://127.0.0.1:3917/api/circle/webhook \
  --times 3
```

Each delivery should report `HTTP 200` and `EXPECTED`. The receiver logs one `NEW` and three `DUPLICATE` observations. It is an in-memory demonstration, not a payment handler. Stop it with Ctrl-C.

## Use your handler

Configure your local handler to explicitly trust `.hookbuoy/public.pem` for key ID `hookbuoy-local-test` **only in an isolated test environment**. Preserve its signature verification and verify the original request body bytes before processing the event.

Point `--to` at your local endpoint. The accepted destinations are HTTP `localhost`, `127.0.0.1` and `[::1]`; redirects are not followed. No tunnel or Circle credentials are needed for HookBuoy itself. Your application may have additional requirements.

Two fixture aliases are available: `wallets.inbound.complete` and `wallets.inbound.failed`. Both use `notificationType: transactions.inbound`, with different synthetic states. They are illustrative templates, not complete or authoritative Circle schemas. See [compatibility](docs/compatibility.md) for identifier behavior, signing and limitations.

To exercise an application path that matches an existing local test transaction, supply its hash:

```sh
node dist/src/cli.js send wallets.inbound.complete \
  --to http://127.0.0.1:3000/api/circle/webhook \
  --tx-hash 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --notification-id my-test-event \
  --transaction-id my-test-transaction \
  --save purchase.delivery.json
```

Replace the hash with the value in your test database. IDs can also be omitted to generate UUIDs. The example receiver does not use a database.

`--save` creates a new delivery file **before** the HTTP attempt and refuses to overwrite an existing file. It stores the original body as base64 plus the content type, local key ID and signature; it does not store the private key or destination. `replay` sends the stored body and those headers sequentially without re-signing. The file may contain sensitive test payload data; keep it private.

## HTTP results

By default, any 2xx response is expected. Use `--expect-status 403` to test for a specific status; `--timeout-ms` defaults to 3000 ms.

| Exit code | Meaning |
| --- | --- |
| `0` | All responses matched the expected status. |
| `2` | Invalid input, key, delivery file or file operation. |
| `3` | At least one unexpected HTTP status, with no transport error. |
| `4` | At least one connection or timeout error. |

An expected HTTP response does **not** prove a payment was matched, settled or credited exactly once. Inspect your application's state separately. See the [Arc Commerce pilot](examples/arc-commerce/README.md) for a concrete integration procedure.

## Security and scope

The generated P-256 key pair belongs to you. A receiver using Circle's normal public-key lookup will not trust it unless explicitly configured to do so for local testing. Keep the private key out of version control; never enable local test-key trust in a production deployment or disable signature verification there.

HookBuoy does not create payments, fetch Circle keys, send to remote endpoints, simulate Circle's delivery schedule, or verify ledger and business outcomes. Replay is an intentional sequence of repeated requests, not an automatic retry policy.

## Development

```sh
npm test
```

See [compatibility and fixture provenance](docs/compatibility.md) and the [Arc Commerce pilot](examples/arc-commerce/README.md). Licensed under [MIT](LICENSE).
