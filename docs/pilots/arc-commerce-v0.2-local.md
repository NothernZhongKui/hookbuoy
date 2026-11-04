# Arc Commerce v0.2 — reported local E2E run

**Result:** PASS (author-provided execution output; not independently reproduced by the assistant)

- **Reported UTC time:** 2026-11-04T22:06:28.848Z
- **Application:** [circlefin/arc-commerce](https://github.com/circlefin/arc-commerce), pinned commit `1a4f09d79883c15cb2fa8527a3ad210b3e01a552`
- **HookBuoy:** `0.2.0-dev.2`, source `main` commit `6dbd8aeff131deb4b3df37a9433937b2f68ce38b` (development version used for the release candidate)
- **Runner:** `scripts/arc-commerce-e2e.mjs`
- **Environment:** author's Mac, Docker, local Supabase, disposable pinned Arc Commerce worktree
- **Evidence basis:** the author pasted the runner's full successful JSON result in the development conversation; the original JSON was saved locally under `.hookbuoy/` and was not uploaded to the public repository.

## Machine-readable outcome (redacted, reproducible summary)

```json
{
  "result": "PASS",
  "checkedAt": "2026-11-04T22:06:28.848Z",
  "upstreamRepository": "circlefin/arc-commerce",
  "upstreamCommit": "1a4f09d79883c15cb2fa8527a3ad210b3e01a552",
  "hookbuoyVersion": "0.2.0-dev.2",
  "tests": {
    "invalidSignature": {
      "httpStatus": 403,
      "stateUnchanged": true,
      "eventRows": 0
    },
    "tamperedBody": {
      "httpStatus": 403,
      "stateUnchanged": true,
      "eventRows": 0
    },
    "correctSignature": {
      "httpStatus": 200,
      "recordedValidEvent": true,
      "transactionStatus": "complete",
      "creditIncrease": 10
    },
    "replay": {
      "attempts": 3,
      "httpStatus": 200,
      "extraCredits": 0,
      "uniqueEventRows": 1,
      "savedRequestUnchanged": true
    }
  }
}
```

This confirms the author's **local synthetic integration run**, including application/database state assertions beyond HTTP status. It does **not** demonstrate Circle network delivery, Arc on-chain settlement, or production-grade exactly-once guarantees. The standalone runner remains available for independent repetition: [E2E procedure](../arc-commerce-e2e.md).
