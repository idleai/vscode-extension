import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout;
}

const manifest = join(root, "../host-tools/Cargo.toml");
run("cargo", ["build", "--manifest-path", manifest, "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "idle-peer-state"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--manifest-path", manifest, "--locked", "--no-deps", "--format-version", "1"], true));
const output = join(root, "dist", "peer-state");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
run("wasm-bindgen", ["--target", "nodejs", "--out-dir", output,
  join(metadata.target_directory, "wasm32-unknown-unknown", "release", "idle_peer_state.wasm")]);
