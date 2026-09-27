import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// Isolated artifact check, never a user's browser/profile. CHROME_BIN is an
// explicit test executable. Pass a VSIX to test its extracted assets.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("Set CHROME_BIN to a Chromium executable for this optional smoke check.");
const temporary = await mkdtemp(join(tmpdir(), "idle-webview-smoke-"));
let assets = join(root, "dist");
if (process.argv[2]) {
  execFileSync("unzip", ["-q", resolve(process.argv[2]), "-d", join(temporary, "vsix")]);
  assets = join(temporary, "vsix", "extension", "dist");
}
const require = createRequire(import.meta.url);
const { fixture, loadWithVSCode } = require("../test/helpers/vscode.cjs");
const { webviewHtml } = loadWithVSCode("../../out/host/webviews", fixture().api);
const server = createServer(async (request, response) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pathname = new URL(request.url, origin).pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (pathname === "/") {
      const html = webviewHtml(origin, `${origin}/dist/bootstrap.js`, `${origin}/dist/theme.css`, "smoke-session", "sidebar")
        .replace('<script nonce=', '<script src="/fixture.js"></script>\n  <script nonce=')
        .replace('</body>', '<script type="module" src="/probe.js"></script></body>');
      response.setHeader("Content-Type", "text/html");
      response.end(html);
      return;
    }
    const file = pathname === "/fixture.js" ? join(root, "test/fixtures/webview-api.js") :
      pathname === "/probe.js" ? join(root, "test/fixtures/webview-probe.js") :
        pathname.startsWith("/dist/") ? resolve(assets, `.${pathname.slice(5)}`) : undefined;
    if (!file || (!file.startsWith(assets + "/") && !["/fixture.js", "/probe.js"].includes(pathname))) {
      response.writeHead(404).end(); return;
    }
    response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".css") ? "text/css" : "text/javascript");
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});

let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: join(temporary, "profile"),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.documentElement.dataset.smoke, { timeout: 20_000 });
  const result = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  if (result.smoke !== "pass" || errors.length) throw new Error(`Webview smoke failed: ${JSON.stringify({ result, errors })}`);
  console.log("PASS: packaged Rust view, CSP, synchronous host replies, cached API acquisition, listener cleanup, and protocol error propagation.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
