# npm publication and trusted publishing

HookBuoy is currently a public **GitHub source release**; the npm package is not yet confirmed published. The `hookbuoy` npm name is only usable if the registry returns it as available and publication succeeds. Do not assume npm availability from the GitHub package name.

## First publication (package bootstrap)

Do this once on the maintainer's trusted machine with an npm account and 2FA enabled.

1. Check the registry for existing ownership: `npm view hookbuoy name version --registry=https://registry.npmjs.org`. A 404 can mean the name is unclaimed, but is **not a reservation**. If the name is taken or restricted, stop and choose a new package name through a separate reviewed release.
2. Confirm `npm whoami` returns the intended publisher account.
3. Start from the **immutable existing GitHub v0.2.0 tag**, not from unreviewed working-tree files:

```sh
git fetch origin --tags
git switch --detach v0.2.0
npm ci --no-audit --no-fund
npm test
npm run smoke:package
npm pack --dry-run
npm publish --access public
```

The first publish is a deliberately interactive, user-controlled action. Complete npm 2FA as prompted. Never paste OTPs, recovery codes, tokens or an `.npmrc` into an issue, chat, log or repo. Do not use `--force` or attempt to overwrite an already published version. If the package was already published, skip this section and validate its identity and integrity.

**Important:** manual publishing does **not** automatically create npm provenance; OIDC/trusted workflow publications do. The public GitHub v0.2.0 release and npm publication are two separate release states.

## Configure npm Trusted Publishing for subsequent releases

Once the package is visible under your npm account, visit the package's **Settings → Trusted publishing**:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Owner | `NothernZhongKui` |
| Repository | `hookbuoy` |
| Workflow filename | `npm-publish.yml` |
| Environment | Leave empty (unless a matching protected GitHub environment is configured) |
| Allowed actions | Enable **npm publish** (not only npm stage publish) |

The workflow file is `.github/workflows/npm-publish.yml`. Enter only the filename in npm, not its full path. Configure the connection only when ready to use it; newly created trusted publisher entries have a limited initial validation window. GitHub-hosted Actions runners with Node 24, npm 11+, and `id-token: write` are required. No `NPM_TOKEN` repository secret is needed. GitHub Actions trusted publishing automatically produces npm provenance for public repos/packages.

For every **subsequent release**:

1. Merge a PR that aligns the package/lockfile/CLI version and notes; complete Node 22/24 CI.
2. Create the matching `vX.Y.Z` Git tag and **published** GitHub Release after the main-branch checks pass.
3. In GitHub **Actions → Publish to npm (manual OIDC) → Run workflow**, enter the existing tag and explicitly check `confirm_publish`.
4. The job checks tag format, git ancestry, GitHub Release published state, npm package name/version/repository, then runs `npm ci`, tests, and tarball smoke before `npm publish --access public`.
5. Verify `npm view hookbuoy version` returns the version, inspect the npm provenance, and try a clean install: `npm exec --yes --package=hookbuoy@X.Y.Z -- hookbuoy --help`.

**Security caveat:** a manual dispatch is not a replacement for tag protection or GitHub environment approvals. Keep tag creation restricted and use a protected GitHub environment for stronger release approval once the initial publish is stable. Only release trusted commits. Avoid publishing the same version twice.

If the existing `v0.2.0` GitHub Release has been published before this workflow landed, **do not recreate or move the tag**. Bootstrap that exact version manually as above, then use OIDC for future versions. The new workflow is for future release versions and may not exist in the v0.2.0 tag's checkout.

Official reference: https://docs.npmjs.com/trusted-publishers/
