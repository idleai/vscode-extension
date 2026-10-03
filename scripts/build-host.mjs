import { build } from "esbuild";
import { createRequire } from "node:module";

// The installed extension includes the SDKs; it never resolves sibling source
// checkouts or runtime node_modules. VS Code supplies its own API module.
await build({
  entryPoints: ["extension/src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  // Linked runtime dependencies resolve their optional logging peer here, so
  // their own node_modules location cannot leave an external require in the VSIX.
  alias: { "supports-color": createRequire(import.meta.url).resolve("supports-color") },
  sourcemap: false,
  legalComments: "linked",
});
