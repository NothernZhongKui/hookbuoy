# HookBuoy

Local webhook signing and replay for payment integration tests.

HookBuoy sends synthetic Circle Wallets-shaped notifications to a local HTTP handler using a test key you control. Replay a saved delivery to test how your application handles duplicates and invalid signatures.

**Status:** Experimental, v0.2.1. HookBuoy is independent of Circle. Requests are signed with a local test key, not Circle's private key.

## Quickstart

Requirements: Node.js 22+, npm and Git. Build from a source checkout:

```sh
git clone https://github.com/NothernZhongKui/hookbuoy.git
cd hookbuoy
npm ci
npm run build
node dist/src/cli.js --version
```

The v0.2.1 npm publication reported success, but its publish log also reported removal of the CLI `bin` entry. Until the installed registry package is verified, use the source checkout above. See [npm publishing](docs/npm-publishing.md).

Initialize a local project and generate a dedicated test key pair:

```sh
node dist/src/cli.js init --to http://127.0.0.1:3917/api/circle/webhook
```

Start the included receiver in this terminal:

```sh
node examples/local-receiver.mjs .hookbuoy/public.pem
```

From the **same checkout** in another terminal:

```sh
node dist/src/cli.js send inbound.complete
node dist/src/cli.js replay last --times 3
node dist/src/cli.js check signature
node dist/src/cli.js check body
```

The send and replays should return HTTP 200; the two negative checks should return HTTP 403. The receiver logs one `NEW` and three `DUPLICATE` events. It is an in-memory demonstration, not a payment handler.

`init` saves the endpoint and creates test keys in `.hookbuoy/`, or reuses an existing complete key pair. Each configured `send` saves its request before delivery. `replay last` sends the most recently saved request, including a negative test if that was the last send. See the [CLI guide](docs/cli.md) for explicit files, endpoint overrides and exit codes.

## Use your handler

Configure your local handler to trust `.hookbuoy/public.pem` for key ID `hookbuoy-local-test` **only in an isolated development environment**. Keep signature verification enabled and verify the original body bytes. The normal Circle key lookup does not trust this local key.

Point `init --to` or `send --to` at your handler. HookBuoy accepts HTTP loopback addresses only. It signs synthetic fixtures; it does not create payments or fetch Circle keys. To test a matching transaction, provide its existing local test hash with `--tx-hash` and inspect the application's state afterwards.

The available fixtures are `inbound.complete` and `inbound.failed`; the original `wallets.inbound.*` aliases also work. See [compatibility](docs/compatibility.md) for fixture shape and trust limits.

A successful HTTP response does not prove that a payment was matched, credited once or settled on-chain. The [Arc Commerce guide](docs/arc-commerce-e2e.md) describes a reproducible local integration; the [pilot result](docs/pilots/arc-commerce-v0.2-local.md) records an author-reported run.

## Security

Keep the private key and saved deliveries out of version control. Never enable local test-key trust in production. HookBuoy cannot authenticate Circle notifications, send to remote endpoints, simulate a provider's retry schedule or guarantee business outcomes.

[CLI guide](docs/cli.md) · [Compatibility](docs/compatibility.md) · [Arc Commerce](docs/arc-commerce-e2e.md) · [MIT license](LICENSE)
