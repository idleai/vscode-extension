# Install a tested Linux product

Use the files from one product archive together. `product-inputs.json` names
the selected source revisions, and `product-result.json` links their checks.
Run `sha256sum --check SHA256SUMS` in the extracted product directory to verify
the component archives and VSIX.

Install the extension with:

```sh
code --install-extension idle.vsix --force
```

The force option replaces an earlier build with the same extension version.
The extension contains the native host tested in this product build.

For a Linux compute host, extract the CLI and host-tools packages into separate
directories inside the extracted product directory:

```sh
mkdir codex host-tools
tar -xzf codex-package-x86_64-unknown-linux-gnu.tar.gz -C codex
tar -xzf native/idle-coordination-v*-linux-x64.tar.gz -C host-tools
```

Use `codex/bin/codex` for the compute daemon and its existing `app-server idle host`
connection flow. Supply the absolute path to `host-tools/bin/idle-host` as
`--relay-helper`, so the compute host uses the same native code as the extension.
The existing connection request, GitHub authentication and invitation steps
still apply. This product's acceptance test covers local runtime coordination;
the separate live compute acceptance workflow covers Dev Tunnels connections.

The archive also includes the standalone Codex app-server package and EditChain
native tools for consumers that use those entry points directly.
