# npm publication and trusted publishing

HookBuoy v0.2.0 was initially published manually. The v0.2.1 [OIDC publication run](https://github.com/NothernZhongKui/hookbuoy/actions/runs/41928238170) reported success and a signed provenance statement. The maintainer subsequently confirmed the npm package. Version v0.3.0 added synthetic Gateway deposit notifications, backed by an external Arc Fintech local E2E. The v0.3.1 GitHub Actions [publication run](https://github.com/NothernZhongKui/hookbuoy/actions/runs/42030774690) completed successfully. See the [README](../README.md) for installation.

## Bootstrap status (completed)

- Package: [hookbuoy](https://www.npmjs.com/package/hookbuoy).
- GitHub Release: [v0.2.0](https://github.com/NothernZhongKui/hookbuoy/releases/tag/v0.2.0).
- Confirmed registry version `0.2.0` and tarball.
- `npm trust list hookbuoy` reported: `type: github`, `file: npm-publish.yml`, `repository: NothernZhongKui/hookbuoy`, `permissions: publish, stage publish`.
- The existing v0.2.0 publication was manual and is **not claimed to have OIDC provenance**.

## Configure npm Trusted Publishing for subsequent releases

The package publisher configuration has been confirmed via `npm trust list hookbuoy`. For reference, the trusted publisher is configured as follows:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Owner | `NothernZhongKui` |
| Repository | `hookbuoy` |
| Workflow filename | `npm-publish.yml` |
| Environment | Leave empty (unless a matching protected GitHub environment is configured) |
| Allowed actions | Enable **npm publish** (not only npm stage publish) |

The workflow file is `.github/workflows/npm-publish.yml`. Enter only the filename in npm, not its full path. The trusted publisher was used by the v0.2.1 workflow. Verify the published package separately after each publication. Newly created trusted publisher entries may have an initial validation window. GitHub-hosted Actions runners with Node 24, npm 11+, and `id-token: write` are required. No `NPM_TOKEN` repository secret is needed. GitHub Actions trusted publishing automatically produces npm provenance for public repos/packages.

For every **subsequent release**:

1. Merge a PR that aligns the package/lockfile/CLI version and notes; complete Node 22/24 CI.
2. Create the matching `vX.Y.Z` Git tag and **published** GitHub Release after the main-branch checks pass.
3. In GitHub **Actions → Publish to npm (manual OIDC) → Run workflow**, enter the existing tag and explicitly check `confirm_publish`.
4. The job checks tag format, git ancestry, GitHub Release published state, npm package name/version/repository, then runs `npm ci`, tests, and tarball smoke before `npm publish --access public`.
5. Verify `npm view hookbuoy version` returns the version, inspect the npm provenance, and try a clean install: `npm exec --yes --package=hookbuoy@X.Y.Z -- hookbuoy --help`.

**Security caveat:** a manual dispatch is not a replacement for tag protection or GitHub environment approvals. Keep tag creation restricted and use a protected GitHub environment for stronger release approval once the initial publish is stable. Only release trusted commits. Avoid publishing the same version twice.

Do not move already published tags; previously published package versions are immutable. The workflow is present on the current default branch.

Official reference: https://docs.npmjs.com/trusted-publishers/
