import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod, rm } from "node:fs/promises";
import path from "node:path";

// Source repositories are build dependencies; installed adapters use VSIX assets.
const directory = path.resolve("bin", `${process.platform}-${process.arch}`);
await mkdir(directory, { recursive: true });
await rm(path.join(directory, `editchain-vscode-service${process.platform === "win32" ? ".exe" : ""}`), { force: true });
for (const [repository, crate, binary] of [
  ["../editchain", "editchain-sync", "editchain-peer"],
]) {
  const manifest = path.resolve(repository, "Cargo.toml");
  execFileSync("cargo", ["build", "--manifest-path", manifest, "--locked", "--release", "-p", crate, "--bin", binary], { stdio: "inherit" });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", manifest, "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8" }));
  const name = `${binary}${process.platform === "win32" ? ".exe" : ""}`;
  const destination = path.join(directory, name);
  await copyFile(path.join(metadata.target_directory, "release", name), destination);
  await chmod(destination, 0o755);
}
