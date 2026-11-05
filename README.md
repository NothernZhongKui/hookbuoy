# HookBuoy

Local webhook signing and replay for payment integration tests.

HookBuoy sends synthetic Circle Wallets and Gateway-shaped notifications to a local HTTP handler using a test key you control. Replay a saved delivery to test how your application handles duplicates and invalid signatures.

**Status:** Experimental, v0.3.1. Supports synthetic Circle Wallets and Gateway notifications. HookBuoy is independent of Circle. Requests are signed with a local test key, not Circle's private key.

## Quickstart

Requires Node.js 22+ and npm. Install HookBuoy:

```sh
npm install --global hookbuoy@0.3.1
hookbuoy --version
```

Create a local project and a dedicated test key pair:

```sh
mkdir hookbuoy-demo
cd hookbuoy-demo
hookbuoy init --to http://127.0.0.1:3917/api/circle/webhook
```

If you run HookBuoy inside a Git repository, add `.hookbuoy/` to that repository's `.gitignore` **before committing**. This directory contains private test keys and saved deliveries; HookBuoy does not modify your `.gitignore` automatically.

Start the receiver included in the npm package in this terminal:

```sh
node "$(npm root --global)/hookbuoy/examples/local-receiver.mjs" .hookbuoy/public.pem
```

From the **same project directory** in another terminal:

```sh
hookbuoy send inbound.complete
hookbuoy replay last --times 3
hookbuoy check signature
hookbuoy check body
```

The send and replays should return HTTP 200; the two negative checks should return HTTP 403. The receiver logs one `NEW` and three `DUPLICATE` events. It is an in-memory demonstration, not a payment handler.

`init` saves the endpoint and creates test keys in `.hookbuoy/`, or reuses an existing complete key pair. Each configured `send` saves its request before delivery. `replay last` sends the most recently saved request, including a negative test if that was the last send. The CLI expects a 2xx response by default; to replay a saved negative test, use `--expect-status 403`. Interactive menu option `2` instead uses the last saved expected status. See the [CLI guide](docs/cli.md) for details.

For a local Gateway demonstration in this same project directory, use the receiver above and run:

```sh
hookbuoy send gateway.deposit.finalized --to http://127.0.0.1:3917/api/circle/gateway-webhook
hookbuoy replay last --times 3 --to http://127.0.0.1:3917/api/circle/gateway-webhook
hookbuoy send gateway.deposit.finalized --to http://127.0.0.1:3917/api/circle/gateway-webhook --fault signature
```

The included receiver accepts both local paths and deduplicates Gateway notifications by `notification.id`. It is for exploring CLI behavior, not a claim about production Circle delivery.

## Use your handler

Configure your local handler to trust `.hookbuoy/public.pem` for key ID `hookbuoy-local-test` **only in an isolated development environment**. Keep signature verification enabled and verify the original body bytes. The normal Circle key lookup does not trust this local key.

Point `init --to` or `send --to` at your handler. HookBuoy accepts HTTP loopback addresses only. It signs synthetic fixtures; it does not create payments or fetch Circle keys. To test a matching transaction, provide its existing local test hash with `--tx-hash` and inspect the application's state afterwards.

The supported fixtures are `inbound.complete`, `inbound.failed` (also `wallets.inbound.*`) and `gateway.deposit.finalized`. Use `hookbuoy events` to see them. `init arc-fintech` presets the dedicated local Gateway route; its local test keys must be explicitly trusted by the receiver in an isolated test setup. See [compatibility](docs/compatibility.md) for fixture shape and trust limits.

A successful HTTP response does not prove that a payment was matched, credited once or settled on-chain. The [Arc Commerce guide](docs/arc-commerce-e2e.md) describes a reproducible local integration; its [pilot result](docs/pilots/arc-commerce-v0.2-local.md) records an author-reported run. The [Gateway pilot](docs/pilots/arc-fintech-gateway-v0.3-actions.md) passed an automated GitHub Actions E2E against the pinned Arc Fintech handler and local Supabase.

## Development

```sh
git clone https://github.com/NothernZhongKui/hookbuoy.git
cd hookbuoy
npm ci
npm test
```

## Security

Keep the private key and saved deliveries out of version control. Never enable local test-key trust in production. HookBuoy cannot authenticate Circle notifications, send to remote endpoints, simulate a provider's retry schedule or guarantee business outcomes.

[CLI guide](docs/cli.md) · [Compatibility](docs/compatibility.md) · [Gateway preview](docs/gateway-preview.md) · [Arc Commerce](docs/arc-commerce-e2e.md) · [MIT license](LICENSE)
