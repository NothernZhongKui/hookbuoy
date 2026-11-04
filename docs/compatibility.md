# Compatibility and trust model (2026-11-05)

- Initial provider: Circle Wallets Developer-Controlled Wallets, `transactions.inbound` only.
- Fixture aliases: `wallets.inbound.complete`, `wallets.inbound.failed`. These are **not** official Circle event names.
- Event envelope fields: `subscriptionId`, `notificationId`, `notificationType`, `notification`, `timestamp`, `version` — structure inferred from public Arc Commerce webhook tests and handlers. First external capture should confirm precise schema and state fields.
- Authentication: ECDSA P-256, SHA-256 digest, base64 signature, `X-Circle-Signature` and `X-Circle-Key-Id` compatible with the test signing approach in `circlefin/arc-commerce/tests/unit/circle-webhook.test.ts`.
- Key trust: Synthetic `hookbuoy-local-test` key ID and PEM **never** corresponds to a Circle-managed public key. Receiving apps must explicitly opt into test trust; default Circle verification rejects it.
- Replay: Exact saved raw request bytes and signature; excludes retries, mutated IDs, and any assertion about payment state.
- External app `arc-commerce` status: local pilot completed at pinned revision `1a4f09d`. Signed delivery and Supabase signature verification confirmed; settlement result developer-reported.
- Arc-specific logic is not in the tool; ARC-TESTNET is a sample fixture field, not an Arc runtime requirement.
- Name, licensing provenance, npm availability, event schema and external pilot still require release review.
