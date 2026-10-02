import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod } from "node:fs/promises";
import path from "node:path";

// Sibling source is a build dependency; installed adapters use only VSIX assets.
const manifest = path.resolve("../editchain/Cargo.toml");
execFileSync("cargo", ["build", "--manifest-path", manifest, "--locked", "--release",
  "-p", "editchain-node", "--bin", "editchain-vscode-service", "-p", "editchain-sync", "--bin", "editchain-peer"], { stdio: "inherit" });
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", manifest, "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8" }));
const directory = path.resolve("bin", `${process.platform}-${process.arch}`);
await mkdir(directory, { recursive: true });
for (const binary of ["editchain-vscode-service", "editchain-peer"]) {
  const name = `${binary}${process.platform === "win32" ? ".exe" : ""}`;
  const destination = path.join(directory, name);
  await copyFile(path.join(metadata.target_directory, "release", name), destination);
  await chmod(destination, 0o755);
}
