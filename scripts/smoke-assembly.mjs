import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

// Isolated browser and synthetic chain. This never attaches to the user's editor.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("Set CHROME_BIN to run the assembled extension check.");
const temporary = await mkdtemp(join(tmpdir(), "idle-assembly-"));
const require = createRequire(import.meta.url);
const { fixture, loadWithVSCode } = require("../test/helpers/vscode.cjs");
const f = fixture();
let browser;
let server;
let extension;
try {
  execFileSync("unzip", ["-q", resolve(process.argv[2] ?? "idle.vsix"), "-d", temporary]);
  const extensionRoot = join(temporary, "extension");
  const assets = join(extensionRoot, "dist");
  const workspace = join(temporary, "workspace");
  execFileSync("cargo", ["run", "--quiet", "--locked", "-p", "idle-vscode-native", "--example", "history-fixture", "--", workspace], { cwd: root, stdio: "inherit" });
  const records = JSON.parse(await readFile(join(workspace, "history.json"), "utf8"));
  const uri = f.api.Uri.parse(pathToFileURL(workspace).toString());
  f.context.extensionUri = f.api.Uri.parse(pathToFileURL(extensionRoot).toString());
  f.api.workspace.workspaceFolders = [{ name: "Recorded workspace", index: 0, uri }];
  f.configuration.set(uri.toString(), { chainDirectory: "chain", "tracking.enabled": false });
  extension = loadWithVSCode(join(extensionRoot, "out/extension.js"), f.api);
  const host = extension.activate(f.context);
  const { webviewHtml } = loadWithVSCode("../../out/host/webviews", f.api);
  const { WebviewBridge } = require("../out/host/messageBridge");
  const expectedFailures = [];
  server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
      if (url.pathname === "/host" && request.method === "POST") {
        let data = "";
        for await (const chunk of request) data += chunk;
        const envelope = JSON.parse(data);
        let delivery;
        const send = message => { delivery = message; return Promise.resolve(true); };
        const bridge = new WebviewBridge(envelope.session, host.effects, send, error => expectedFailures.push(error));
        await bridge.receive(envelope);
        bridge.dispose();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(delivery));
        return;
      }
      if (url.pathname === "/") {
        const kind = url.searchParams.get("kind") === "detail" ? "detail" : "sidebar";
        const html = webviewHtml(origin, `${origin}/dist/bootstrap.js`, `${origin}/dist/theme.css`, `assembly-${kind}`, kind)
          .replace('<script nonce=', '<script src="/fixture.js"></script>\n  <script nonce=');
        response.setHeader("Content-Type", "text/html"); response.end(html); return;
      }
      const file = url.pathname === "/fixture.js" ? join(root, "test/fixtures/assembly-api.js") :
        url.pathname.startsWith("/dist/") ? resolve(assets, `.${url.pathname.slice(5)}`) : undefined;
      if (!file || (!file.startsWith(assets + "/") && url.pathname !== "/fixture.js")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(await readFile(file));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: join(temporary, "profile"),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
  const errors = [];
  for (const kind of ["sidebar", "detail"]) {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewport({ width: kind === "sidebar" ? 360 : 1200, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?kind=${kind}`);
    await page.waitForSelector('#idle-workspace option[value^="local-workspace:"]');
    const workspaceId = await page.$eval('#idle-workspace option[value^="local-workspace:"]', option => option.value);
    await page.select("#idle-workspace", workspaceId);
    await page.waitForSelector('[role="treeitem"]');
    const recordId = records.requests[0].record.operation;
    await page.click(`[role="treeitem"][id$="${Buffer.from(recordId).toString("hex")}"]`);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Inspect record"));
    await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Inspect record").click());
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Open recorded revision" && !button.disabled));
    const before = f.calls.editorCommands.length;
    await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Open recorded revision").click());
    await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Opening recorded content"));
    await waitFor(() => f.calls.editorCommands.length > before);
    const opened = f.calls.editorCommands.at(-1);
    assert.equal(opened.id, "vscode.open");
    const hex = f.calls.contentProviders.find(provider => provider.scheme === "idle-history-hex").provider;
    const content = await hex.provideTextDocumentContent(opened.args[0]);
    const bytes = content.split("\n").flatMap(line => line.split("  ")[1].split(" ").map(byte => parseInt(byte, 16)));
    assert.deepEqual(Buffer.from(bytes), Buffer.from(records.after));
    assert.equal(await page.$eval(".idle-history-viewport", element => element.getBoundingClientRect().height), kind === "sidebar" ? 400 : 640, 'CSP permits graph sizing');
    await page.evaluate(() => document.documentElement.style.setProperty("--vscode-editor-background", "#112233"));
    assert.equal(await page.$eval(".idle-theme", element => getComputedStyle(element).backgroundColor), "rgb(17, 34, 51)", 'the view follows host theme tokens');
    await checkSearch(page);
    await checkReadyReplies(page, workspaceId);
    await page.close();
  }
  assert.deepEqual(errors, [], "the packaged views have no browser or CSP errors");
  assert.deepEqual(expectedFailures, [], "host operations succeed");
  console.log("PASS: packaged sidebar/detail -> persistent Crux -> bound native history -> shared inspector -> exact native file preview.");
} finally {
  await browser?.close();
  await extension?.deactivate();
  for (const disposable of f.context.subscriptions) disposable.dispose();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true });
}

async function waitFor(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Host action did not complete."); await new Promise(resolve => setTimeout(resolve, 20)); }
}

async function checkSearch(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#idle-search");
    input.value = "x".repeat(16_385);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Search").click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes("Search text exceeds")));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Retry search" && !button.disabled)), true);
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = "app.history";
    const input = document.querySelector("#idle-search");
    input.value = "never-matches-anything";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Search").click());
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(element => element.textContent === "Searching history…")), true);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Search more").getAttribute("aria-disabled")), "true");
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = undefined;
    for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent("message", { data }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(element => element.textContent.includes("fields could not be searched")));
  assert.equal(await page.evaluate(() => document.body.textContent.includes("0 loaded matches")), true);
  assert.deepEqual(await page.evaluate(() => ["Next match", "Search more"].map(label => [...document.querySelectorAll("button")].find(button => button.textContent === label).disabled)), [true, true]);
  assert.equal(await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? null), null);
}

async function checkReadyReplies(page, workspaceId) {
  const workspaceCalls = await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === "app.workspace").length);
  await page.evaluate(() => {
    const { data } = window.assemblyFixture.responses.find(({ request }) => request.method === "host.ready");
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$eval("#idle-workspace", element => element.value), workspaceId, "duplicate ready does not clear selection");
  assert.equal(await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === "app.workspace").length), workspaceCalls, "duplicate ready does not reload the directory");
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = "host.ready";
    const { protocol, session } = window.assemblyFixture.responses[0].data;
    window.dispatchEvent(new MessageEvent("message", { data: { protocol, session, event: "host.configurationChanged", params: {} } }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes("The host did not respond")));
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = undefined;
    for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent("message", { data }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === "app.workspace").length), workspaceCalls, "late ready cannot revive a timed-out connection");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes("The host did not respond"))), true);
  await page.evaluate(() => {
    const { protocol, session } = window.assemblyFixture.responses[0].data;
    window.dispatchEvent(new MessageEvent("message", { data: { protocol, session, event: "host.configurationChanged", params: {} } }));
  });
  await page.waitForSelector('#idle-workspace option[value^="local-workspace:"]');
  await page.select("#idle-workspace", workspaceId);
  await page.waitForSelector('[role="treeitem"]');
}
