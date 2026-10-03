import { spawnSync } from "node:child_process";

for (const [command, args] of [
  ["npm", ["--prefix", "../host-tools/packages/history-runtime", "run", "build"]],
  ["cargo", ["build", "--locked", "-p", "idle-editor-capture", "--bins"]],
  ["cargo", ["build", "--manifest-path", "../editchain/Cargo.toml", "--locked", "-p", "editchain", "-p", "editchain-sync", "--bins"]],
  [process.execPath, ["scripts/build-peer-state.mjs"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
