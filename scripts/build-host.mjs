import { build } from "esbuild";
import { rm } from "node:fs/promises";

// The installed extension bundles VS Code glue; native services own transports.
await rm("out/extension.js.LEGAL.txt", { force: true });
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
