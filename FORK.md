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

The user maintains this fork independently and will not create upstream PRs. This environment will not use Windows. After diagnosis, CI maintenance is limited to Ubuntu × Node 22/24, with the Ubuntu Node 22 coverage and dependency vulnerability gates unchanged. Windows and macOS CI exclusions do not remove runtime code, tests or inventory, add a package OS restriction, or change engines or dependencies.

The retained guarded project-read and Herdr-origin features intentionally reject non-Linux systems: project-read uses a Linux guard and `/proc` descriptor checks, and Herdr-origin uses a Linux guard and `/proc` process evidence. In run `38258059893`, each macOS job had 29 failed, 941 passed and 3 skipped tests plus 2 unhandled errors across four files: Linux-assumption fixtures conflict with these Linux capability guards. Portability would require a separately approved security contract, not weakening the guards or changing the 33 patch postimages here.

Controller-supplied diagnosis also found Ubuntu Node 24 passed tests/docs/package/compat (coverage and audit skipped), while Ubuntu Node 22 passed tests and coverage but failed the audit gate: 6 development-tree vulnerabilities (2 moderate, 3 high, 1 critical). Dependency remediation requires separate approval; this CI scope change neither fixes those vulnerabilities nor suppresses that gate. Node 22 stays maintained. The CI majors 22/24 are not exact-host qualification for Node 24.18.0/npm 12.0.1.

### Dependency reachability qualification

Dev classification is not a safety or non-reachability proof. Controller-supplied read-only analysis of the current locked tree found that the shipped TypeScript output preserves external imports; the entry is not a dependency bundle. Production imports load `@modelcontextprotocol/server` 2.0.0 and its Node Ajv-provider module, which embeds a fast-uri 3.1.0 version marker in the reported affected range. This copy is inside the production dependency, **not physically bundled into this fork's tarball**. Ajv is lazy, and the inspected wrapper uses native `inputRequired.elicit`; no attacker-controlled encoded host reaching the advisory's security comparison was demonstrated. A version marker alone does not prove unpatched code or exploitability. Updating or overriding the separately audited dev fast-uri 3.1.7 copy cannot replace that embedded server copy.

The audited `@modelcontextprotocol/client` 2.0.0 and legacy SDK 1.30.0 were observed in dev test/fixture clients, not an inspected production OAuth flow; production `@opencode-ai/sdk` is a different package. Express/proxy-addr/ip-address legacy-SDK HTTP handlers and source-map-js dev transform/coverage code were not shown in captured runtime imports. These are bounded observations, not universal absence proofs: dynamic imports, backend-service OAuth and other paths were not evaluated. The six audit findings (2 moderate, 3 high, 1 critical) are not demonstrated exploitation; the additional embedded fast-uri observation is an affected-range qualification, not a critical-vulnerability claim. Analysis covers the locked tree, not unverified future semver consumer resolutions; dev records in the shipped lock are not themselves code execution.

Future decisions need separate approval: verified non-affected, compatible dev client/SDK releases and fixed locked transitive resolutions (including compatible PostCSS/magicast source-map-js paths), without removing dependencies/tests or hiding the audit; separately, a coordinated production server/core upgrade with a **verified corrected bundled fast-uri**, or an explicit deferral acknowledging the loaded copy and unproved trigger. Fixed versions and compatibility are not established here. No dependency/lock change or security-success claim is made by this qualification. The retained short-budget Node 24 fixture failure also remains pending under the 33-postimage preservation contract; its timing mechanism does not prove an exact failing handler or a confirmed flake.

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
