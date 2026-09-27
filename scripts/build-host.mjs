import { build } from "esbuild";

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
  sourcemap: false,
  legalComments: "linked",
});
