# Packaging and releases

## Build a VSIX

From the repository root, after [setup](../README.md#setup):

```sh
npm run package
code --install-extension idle.vsix
```

Packaging builds the JavaScript host, WASM UI and native services. The VSIX
contains `idle-host` and `codex-session-exporter` for the build machine's OS and
architecture; build for the destination workspace host. Installed copies need
no sibling source checkouts.

One `idle-host` process serves workspace capture, history, collection, repository
and coordination channels. The exporter runs when collection needs it. For a
custom host, set `idle.native.hostPath` and run **Idle: Restart Native Adapters**.
The old capture, history and collector executable settings are deprecated.

`npm test` installs the older peer compatibility fixture from the host-tools
release and runs its packaged coordinator tests. These tools are excluded from
the shipped extension.

## Dependency selection

Checks and builds need only this repository's source. The canonical
`scripts/lint.sh` and `scripts/check.sh` select the latest compatible internal
Cargo releases at the start. The committed `Cargo.lock` supplies the initial
third-party selection. The
[native dependency manifest](../native-dependencies.json) declares engine,
host-tools and exporter ranges; automatic resolution requires a Linux x64 bundle and checksum. Other published
platform checksums are retained when available.

The resolver verifies published checksums and writes the selected versions and
Cargo lockfile to ignored `target/released-dependencies.json`. CI jobs, release
verification and packaging reuse that selection. CI retains the record as an
artifact, and releases attach it. The VSIX includes the record.
A later build of the same commit can select newer dependencies.

Use an authenticated GitHub CLI (`gh`) for release discovery. For an individual
local command, run this from the repository root:

```sh
python3 scripts/release_dependencies.py run -- cargo build --workspace --locked
```

`--locked` keeps later commands within that build on the resolved selection.
Keep consumer minimum versions accurate when adopting a new API: `^0.1.2`
accepts `0.1.3`; adopting `0.2.0` requires a manifest change.

The [Check latest released dependencies workflow](../.github/workflows/update-releases.yml)
checks every six hours, or on manual request, and starts main CI when inputs
change. PR builds resolve immediately. No dependency-update branch or PR is
created. Retry a failed selection through CI or publish a fix for the next check.
Release preparation incorporates the selected Cargo dependencies in its version
commit, allowing dependency changes to produce new packages.

The `npm` build and test entrypoints also resolve dependencies once per run.
Selected native bundles are downloaded into ignored `.artifacts/`.

## Automatic releases

The [Release workflow](../.github/workflows/release.yml) starts after successful
`main` CI:

1. Release-plz calculates versions and changelogs from commit messages and Rust
   API checks, then stages the release metadata on `ci/release/<source>`.
2. The Linux CI workflow checks that version commit before promotion to `main`.
3. The [Consumer release workflow](../.github/workflows/consumer-release.yml)
   publishes the `idle-vscode-webview` source archive and checksum from that
   verified commit, using its tested dependency selection.

Promotion uses a normal push. If newer work reaches `main` before the version
commit, the old run finishes successfully with publication skipped. It creates
no release tags, archives, index entries or native bundles. This also covers a
concurrent update between the final fetch and push. A rejected push with no
concurrent update still fails so authentication or server errors remain visible.

Use **Re-run failed jobs** to finish publication of a verified version commit
that already reached `main`, including after later work was merged. A superseded
candidate that never reached `main` stays skipped. Dispatch **Release** on `main`
to prepare the current source. Published versions and archives are immutable.

Declare breaking changes and consumer minimum versions in the feature PR.
Documentation changes with no effect on packaged contents do not create a new
package version.

App-core uses that archive for API compatibility checks. Build and install the
VSIX with the commands above; the release workflow publishes the consumer
archive and does not publish an extension to the Marketplace.

## CI platforms and manual builds

Automatic pull-request, main, scheduled, and release runs select Linux only.
Trusted PR jobs use the local PR pool; other Linux release work uses
`IDLE_BACKGROUND_RUNNER` (default `idle-background-linux-x64`). Fork PRs use
GitHub-hosted Ubuntu. Windows dependency checks run only from the manual entrypoint.

Run [Full platform CI](../.github/workflows/full-platform.yml) from Actions with an
existing release tag, or use:

```sh
gh workflow run full-platform.yml --repo idleai/vscode-extension --ref main -f tag=EXISTING_RELEASE_TAG
```

The run checks out that tag and reuses its recorded dependency versions. It does
not prepare a new version commit. Native dependency tags must already have the
required platform bundles: run their manual workflows first, starting with
`editchain`, then `host-tools`, then consumers. The workflow reports any missing
pinned dependency instead of choosing a different version.

The manual run builds and tests a VSIX for Linux x64, macOS x64/arm64, and Windows
x64. It attaches the platform VSIX files and checksums to the selected release.
Existing assets are never overwritten. Set `publish` to `false` for validation
with CI artifacts only. Marketplace publication is a separate operation.

## Unpublished integration

For local Rust work, pass a temporary registry patch with
`cargo --config /absolute/path/local.toml ...`. Keep these overrides out of
committed manifests and lockfiles.

For a full check, use
[memos/scripts/check-integration.py](https://github.com/idleai/memos/blob/v1/scripts/check-integration.py)
with explicit `--producer` and `--consumer` checkout paths. Repeat `--producer`
for paired changes, listing native producers in dependency order. The helper
selects candidate Cargo packages, builds compatible native bundles, runs the
consumer's normal check script and restores dependency files on success or
failure. `--output /path/to/results` retains candidate bundles and dependency
records with their checksums. Temporary registry overrides stay outside the
normal manifests; declared minimum versions must match the APIs being consumed. The manual
[Unpublished package integration workflow](https://github.com/idleai/memos/blob/v1/.github/workflows/integration.yml)
runs the same check for selected branches.

## Registry maintenance

Dependabot version updates are paused. Its custom Cargo registry configuration
still requires the Dependabot secret `PUBLIC_CARGO_REGISTRY_TOKEN` set to the
literal value `anonymous`. This public marker is not an access token; the Cargo
indexes remain anonymously readable.
