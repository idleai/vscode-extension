import { spawnSync } from "node:child_process";

for (const [command, args] of [
  ["npm", ["--prefix", "../host-tools/packages/history-runtime", "run", "build"]],
  ["cargo", ["build", "--locked", "-p", "idle-editor-capture", "--bins"]],
  ["cargo", ["build", "--manifest-path", "../editchain/Cargo.toml", "--locked", "-p", "editchain", "-p", "editchain-sync", "--bins"]],
  ["cargo", ["build", "--manifest-path", "../host-tools/Cargo.toml", "--locked", "-p", "idle-coordination", "--bin", "idle-coordination", "--example", "loopback-coordinator"]],
  ["cargo", ["test", "--manifest-path", "../host-tools/Cargo.toml", "--locked", "-p", "idle-coordination", "-p", "idle-peer-state"]],
  [process.execPath, ["scripts/build-coordination.mjs"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
