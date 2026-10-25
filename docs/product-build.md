# Coordinated desktop builds

A product build selects the current default-branch revisions of editchain,
host-tools, app-core, web-ui, vscode-extension and codex-evo once. The commit
that triggered the run takes precedence over its repository's current head.
Optional candidate revisions can be supplied when dispatching a coordinated
change across repositories. Project commit IDs are recorded in the run's
`product-inputs.json`; they are never fixed in workflow source files.

The Cargo components use local path overrides and a shared compilation
directory. The build rejects a dependency selection that falls back to a
published internal Cargo package. EditChain and host-tools native bundles pass
directly to downstream builds through a local artifact mirror. Third-party
dependencies and the existing session exporter keep their committed selections.
No package publication or scheduled dependency check is needed to produce a
new VSIX.

Optimized Codex CLI and app-server packages build alongside the Cargo path.
The existing prebuilt V8 configuration remains in use. Every component's
required CI must pass for the exact selected commit before the product can
pass acceptance; an unchanged Codex commit can reuse its successful CI result.
The product build also runs the Cargo repositories' canonical checks, browser
checks, and installation checks in an isolated desktop VS Code profile.

The final integration check loads the VSIX's actual JavaScript bundle and its
native host against the packaged Codex app server. It verifies coordination
transfer, recovery after a lost transfer acknowledgement, writes on the
compute checkout, repeated requests, and recovery after a Codex restart.
This check uses a local owner stdio connection and private temporary state.
Remote Dev Tunnels lifecycle remains covered by the extension's live compute
acceptance workflow.

The successful `idle-product-linux-x64` artifact contains the installable VSIX,
Codex packages, native bundles, checksums, source selection, and per-stage
timings. Default-branch pushes publish these exact files as a GitHub prerelease
in the triggering repository after acceptance, without rebuilding. Manual
candidate runs retain downloadable workflow artifacts. Existing independent
package releases remain available for external consumers.

`product-result.json` records elapsed time from workflow creation to completed
validation. GitHub's workflow duration additionally includes final bundle
compression and artifact upload. Failed stage timings are retained separately.
When comparing runs, report whether compilation caches were warm and include
queue time in the full propagation duration.

Source workflows call `idleai/vscode-extension`'s public reusable product
workflow on their default-branch
pushes. Each source repository owns its run and downloadable result. The
coordinator's manual workflow supports a JSON `revisions` input for an exact
candidate set; every value must be a full commit ID. Reusable workflow source
uses the maintained `main` branch, and all build jobs use the coordinator
revision selected at the beginning of the run.

Publication checks the accepted VSIX checksum, complete archive checksum,
embedded source selection, successful component checks, triggering commit,
and workflow run. A release starts as a draft and becomes a prerelease only
after every file is uploaded. A retried publication accepts matching existing
files and refuses to replace different bytes. Product tags include the source
selection, coordinator revision, run number and attempt, so reruns cannot
overwrite a previous product.
