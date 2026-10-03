import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  }
  return result.stdout;
}

const bindgenVersion = run("wasm-bindgen", ["--version"], true).trim();
if (bindgenVersion !== "wasm-bindgen 0.2.127") {
  throw new Error("Install wasm-bindgen-cli 0.2.127: cargo install --locked wasm-bindgen-cli --version 0.2.127");
}
run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "idle-vscode-webview"]);
const metadata = JSON.parse(run("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], true));
const output = join(root, "dist");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
run("wasm-bindgen", [
  "--target", "web", "--no-typescript", "--out-dir", join(output, "pkg"),
  join(metadata.target_directory, "wasm32-unknown-unknown", "release", "idle_vscode_webview.wasm"),
]);
cpSync(join(root, "static"), output, { recursive: true });
writeFileSync(join(output, "theme.css"), ["theme.css", "history.css", "history-details.css", "sessions.css", "navigation.css", "projections.css"]
  .map(file => readFileSync(join(root, "../web-ui/crates/web-ui/assets", file), "utf8")).join("\n") + "\n" + readFileSync(join(root, "static/assembly.css"), "utf8"));
