# Unofficial fork: @mageyuki/opencode-mcp

**Status (2026-10-12): source prepared; fork repository exists; npm package not published.** The public fork `mageyuki/opencode-mcp` exists (fork of `AlaeddineMessadi/opencode-mcp`; verified 2026-10-12). The `repository`, `homepage`, and `bugs` fields in `package.json` already point at it. No npm package has been published yet, so the npm badge and install links in `README.md` are **pending** until publication. Do not describe this package as released until it has been published to npm.

## Identity

| Item | Value |
|---|---|
| Package | `@mageyuki/opencode-mcp` (public scoped; `publishConfig.access = public`) |
| Version | `3.1.0-rc.1`, the version of the upstream base (see below) |
| npm dist-tag | `rc` (`publishConfig.tag`; npm requires an explicit tag for prerelease versions) |
| Executable | `opencode-mcp` (unchanged), MCP `serverInfo.name` `opencode-mcp` (unchanged) |
| License | MIT; `LICENSE` and the original `Copyright (c) 2025 Alaeddine Messadi` notice are unchanged |
| Upstream | https://github.com/AlaeddineMessadi/opencode-mcp |
| Upstream base | commit `1b9552bebaf648e7dd989f3d48515d3c116c154e` (`package.json` version `3.1.0-rc.1`) |
| Repository | https://github.com/mageyuki/opencode-mcp (public fork; exists, verified 2026-10-12) |

## Divergence from upstream

The source is the upstream base commit plus every hunk and new file of `pr29-live-observation.patch` (SHA-256 `3368e44bbef0f3e00d156ef878e19b5055624689952dac5d86cca7955583b1a0`, 94 hunks, 33 files: 20 modified, 13 new). It adds V2 live observation and execution evidence, guarded project-read tools (`opencode_file_read`, `opencode_file_list`, `opencode_find_file`; essential profile 25 → 28 tools), agent-ID validation, and a Herdr origin marker. Behavior is described in the changelog and tool reference, not re-specified here.

Package-only differences from patch-applied source: package name/description/repository metadata/`publishConfig`/`files` in `package.json`, the matching name fields in `package-lock.json` (no dependency changes), this file, README banner and scoped install commands, a changelog entry, a regenerated `docs/tools.md`, a shipped `dependency-lock.json`, and scoped-name/npm-12 handling in `scripts/test-package.mjs` and `tests/compat-harness.test.ts`.

## Why the version number is unchanged

`3.1.0-rc.1` is the upstream base version. The scoped name is a distinct npm namespace, so it cannot collide with the unscoped `opencode-mcp` (whose published `latest` is 3.0.0; `3.1.0-rc.1` is not published there). The number records the base the fork derives from; the divergence is identified by the name, description, this file, and the README banner. Published versions are immutable: changing their shipped bytes requires a new version. This still-unpublished candidate keeps `3.1.0-rc.1` and dist-tag `rc` under explicit user approval; repacking it records a new integrity (SRI), not a published-version replacement.

## Independent fork maintenance policy

The user maintains this fork independently and will not create upstream PRs. This environment will not use Windows, so Windows CI is outside its maintenance scope. CI retains Ubuntu/macOS × Node 22/24, including the unchanged Ubuntu Node 22 coverage and dependency vulnerability gates. This removes only the Windows CI matrix entry, not Windows runtime code, tests or inventory; it adds no package OS restriction or dependency change. It does not fix the known macOS `npm test` failures or Ubuntu Node 22 vulnerability-gate failure; their root details remain unknown.

## Shipped dependency lock (`dependency-lock.json`)

`dependency-lock.json` is a byte-for-byte copy of `package-lock.json` (root name/version `@mageyuki/opencode-mcp` `3.1.0-rc.1`; no dependency was re-resolved or upgraded). It is an intentional public pin of the production dependency tree for one purpose: restoring dependencies into an extracted package root.

- **npm 12 does not honor `npm-shrinkwrap.json`.** It neither packs nor loads one, from the project root or from inside a dependency tarball, so a shrinkwrap cannot be shipped with the npm 12 toolchain this fork builds with. The lock therefore ships under a non-reserved filename.
- **Nothing uses it automatically.** `npm install @mageyuki/opencode-mcp@3.1.0-rc.1` ignores it; consumers who install the package get normal semver resolution of the declared ranges.
- **Manual use only.** In an extracted package root, copy it to `package-lock.json` and run `npm ci --omit=dev --ignore-scripts`; the root `dist/index.js` then runs. This installs or switches nothing by itself; any deployment is a separate decision.
- **Keep it in sync.** Whenever `package-lock.json` changes, copy it to `dependency-lock.json` in the same change. `npm run test:package` fails if the packed file differs from `package-lock.json` or its root name/version differ from the package.

## Before publishing

1. Confirm the `package.json` repository/homepage/bugs URLs still match the existing fork.
2. Rebuild from a clean install, run the package checks, and publish the exact verified archive (see [docs/releasing.md](docs/releasing.md)).
3. If the unscoped `opencode-mcp` is also installed globally, both put an `opencode-mcp` executable on `PATH`; use one.
