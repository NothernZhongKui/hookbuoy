# CLI guide

This guide applies to HookBuoy v0.2.1 installed with npm. Run commands from the directory initialized by `hookbuoy init`. To use a source checkout instead, run `npm ci && npm run build` from the HookBuoy checkout. When running commands from a separate project directory, replace `hookbuoy` with `node /absolute/path/to/hookbuoy/dist/src/cli.js` (using the actual checkout path). The relative path `node dist/src/cli.js` only works when your current directory is the HookBuoy checkout.

## Initialize

```sh
hookbuoy init --to http://127.0.0.1:3917/api/circle/webhook
hookbuoy status
hookbuoy events
```

`init` writes `.hookbuoy/config.json` and creates a local P-256 test key pair, or reuses an existing complete pair. It refuses an existing configuration or an incomplete pair; it does not establish that existing keys match. `init arc-commerce` selects `http://127.0.0.1:3000/api/circle/webhook`; it does not start or configure that application.

Use `keygen --out DIR` for a standalone pair. The default signing key is `.hookbuoy/private.pem`; use `--key FILE` on `send` to select another.

## Send and replay

```sh
hookbuoy send inbound.complete
hookbuoy replay last --times 3
```

A configured send saves a uniquely named delivery in `.hookbuoy/deliveries/` **before** attempting HTTP, even if the delivery fails. `--save FILE` selects a path and refuses to overwrite it. The project remembers the most recently saved delivery; `replay last` reads it. `replay FILE --to URL` also works without project initialization.

Each `send` generates new notification and transaction IDs and a timestamp. Use `--notification-id`, `--transaction-id` and `--tx-hash` to supply values. The hash must be `0x` plus 64 hex digits; the default is synthetic. Both short aliases (`inbound.complete`, `inbound.failed`) and full aliases (`wallets.inbound.complete`, `wallets.inbound.failed`) are supported.

The saved file contains the original body bytes and the explicit content type, key ID and signature. Replay preserves them and sends sequentially; it does not re-sign, change IDs or add hidden retries. It may be sent to a different allowed loopback endpoint via `--to`. Saved files may contain sensitive payloads; keep them private.

## Negative checks

```sh
hookbuoy check signature
hookbuoy check body
```

These send intentionally invalid signatures. The first changes the signature; the second changes the signed body while retaining its signature. Both expect HTTP 403 by default; pass `--expect-status N` if your receiver uses another status. The equivalent `send inbound.complete --fault signature|body` accepts the normal send options.

In an initialized project, these checks also save their faulted delivery and update `last`. To replay a previous valid request afterwards, use its explicit path. Replay defaults to expecting any 2xx, so pass `--expect-status 403` when intentionally replaying a saved invalid request.

## Results and limits

| Exit code | Meaning |
| --- | --- |
| `0` | Every response matched the expected status. |
| `2` | Invalid input, key, file or configuration. |
| `3` | An unexpected HTTP status, with no transport error. |
| `4` | A connection or timeout error in at least one delivery. |

By default any 2xx is expected; `--expect-status N` requires one exact status. `--timeout-ms` defaults to 3000 and accepts 1–60000. `--times` defaults to 1 and accepts 1–100. Deliveries use HTTP on `localhost`, `127.0.0.1` or `[::1]`; redirects are not followed. An expected HTTP response does not establish correct payment processing.

Run `hookbuoy --help` for all options. With no arguments the CLI opens a numbered menu when both input and output are terminals; otherwise it prints help and exits. The menu is not a shell.
