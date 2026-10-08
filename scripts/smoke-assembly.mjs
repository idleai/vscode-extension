import artifacts from './native-artifacts.cjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { checkConfiguration } from "./assembly-configuration.mjs";
import { checkResources } from "./assembly-resources.mjs";
import { checkRepository, repositoryInputs } from "./assembly-repository.mjs";
import { checkAuthentication } from "./assembly-authentication.mjs";
import { checkActivityPerformance, checkMiniActivity } from "./assembly-activity.mjs";

// Isolated browser and synthetic chain. This never attaches to the user's editor.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("Set CHROME_BIN to run the assembled extension check.");
const temporary = await mkdtemp(join(tmpdir(), "idle-assembly-"));
const require = createRequire(import.meta.url);
const { fixture, view, loadWithVSCode } = require("../test/helpers/vscode.cjs");
const f = fixture();
let browser;
let server;
let extension;
try {
  execFileSync("unzip", ["-q", resolve(process.argv[2] ?? "idle.vsix"), "-d", temporary]);
  const extensionRoot = join(temporary, "extension");
  const assets = join(extensionRoot, "dist");
  const workspace = join(temporary, "workspace");
  const otherWorkspace = join(temporary, "other-workspace");
  execFileSync(artifacts.binary("host-tools", "history-fixture"), [workspace], { cwd: root, stdio: "inherit" });
  execFileSync(artifacts.binary("host-tools", "history-fixture"), [otherWorkspace], { cwd: root, stdio: "inherit" });
  execFileSync('git', ['init', '-b', 'main', workspace], { stdio: 'ignore' });
  await writeFile(join(workspace, 'README.txt'), 'Isolated repository fixture.\n');
  execFileSync('git', ['-C', workspace, 'add', 'README.txt']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Repository Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
  const records = JSON.parse(await readFile(join(workspace, "history.json"), "utf8"));
  const uri = f.api.Uri.parse(pathToFileURL(workspace).toString());
  f.context.globalStorageUri = f.api.Uri.parse(pathToFileURL(join(temporary, "private")).toString());
  f.context.extensionUri = f.api.Uri.parse(pathToFileURL(extensionRoot).toString());
  const otherUri = f.api.Uri.parse(pathToFileURL(otherWorkspace).toString());
  f.api.workspace.workspaceFolders = [{ name: "Recorded workspace", index: 0, uri }, { name: "Other workspace", index: 1, uri: otherUri }];
  for (const resource of [uri, otherUri]) f.configuration.set(resource.toString(), { chainDirectory: "chain", "tracking.enabled": false, "live.enabled": false });
  if (process.env.IDLE_ACTIVITY_BENCHMARK_CHAIN) {
    const benchmark = f.api.Uri.parse(pathToFileURL(resolve(process.env.IDLE_ACTIVITY_BENCHMARK_CHAIN)).toString());
    f.api.workspace.workspaceFolders.push({ name: 'Activity benchmark', index: 2, uri: benchmark });
    f.configuration.set(benchmark.toString(), { chainDirectory: '.', 'tracking.enabled': false, 'live.enabled': false });
  }
  extension = loadWithVSCode(join(extensionRoot, "out/extension.js"), f.api);
  const host = extension.activate(f.context);
  let projectionFixture = false;
  const snapshot = host.repository.snapshot.bind(host.repository);
  host.repository.snapshot = async (...args) => {
    const result = await snapshot(...args);
    return projectionFixture ? { ...result, projections: repositoryInputs(records.github_source) } : result;
  };
  const { webviewHtml } = loadWithVSCode("../../out/host/webviews", f.api);
  // Keep transport and host errors in the same compiled bundle. Loading the
  // source bridge separately would turn packaged HostErrors into generic ones.
  const provider = f.calls.providers.find(item => item.id === 'idle.activity').provider;
  const mounted = view();
  provider.resolveWebviewView(mounted);
  const WebviewBridge = [...provider.views][0].bridge.constructor;
  mounted.dispose();
  const expectedFailures = [];
  let pageSequence = 0;
  server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
      if (url.pathname === "/append" && request.method === "POST") {
        await appendCapture(host, workspace);
        response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); return;
      }
      if (url.pathname === "/host" && request.method === "POST") {
        let data = "";
        for await (const chunk of request) data += chunk;
        const envelope = JSON.parse(data);
        let delivery;
        const send = message => { delivery = message; return Promise.resolve(true); };
        const bridge = new WebviewBridge(envelope.session, host.effects, send, error => { if (!response.destroyed) expectedFailures.push(error); }, envelope.session.endsWith('detail') ? 'detail' : 'sidebar');
        response.on("close", () => bridge.dispose());
        await bridge.receive(envelope);
        bridge.dispose();
        if (process.env.IDLE_ASSEMBLY_TRACE) await appendFile(process.env.IDLE_ASSEMBLY_TRACE,
          JSON.stringify({ request: envelope, response: delivery }) + '\n');
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(delivery));
        return;
      }
      if (url.pathname === "/") {
        const kind = url.searchParams.get("kind") === "detail" ? "detail" : "sidebar";
        const section = url.searchParams.get('section') === 'Activity' ? 'Activity' : '';
        const html = webviewHtml(origin, `${origin}/dist/bootstrap.js`, `${origin}/dist/theme.css`, `assembly-${++pageSequence}-${kind}`, kind, undefined, section)
          .replace('<script nonce=', '<script src="/fixture.js"></script>\n  <script nonce=');
        response.setHeader("Content-Type", "text/html"); response.end(html); return;
      }
      const file = url.pathname === "/fixture.js" ? join(root, "test/fixtures/assembly-api.js") :
        url.pathname.startsWith("/dist/") ? resolve(assets, `.${url.pathname.slice(5)}`) : undefined;
      if (!file || (!file.startsWith(assets + "/") && url.pathname !== "/fixture.js")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".css") ? "text/css" : file.endsWith(".ttf") ? "font/ttf" : "text/javascript");
      response.end(await readFile(file));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 30_000, userDataDir: join(temporary, "profile"),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"] });
  const errors = [];
  for (const kind of ["sidebar", "detail"]) {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewport({ width: kind === "sidebar" ? 360 : 1200, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?kind=${kind}`);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-font-family', 'system-ui, sans-serif');
      document.documentElement.style.setProperty('--vscode-font-size', '13px');
    });
    await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
    const workspaceId = await page.$eval('select[id$=-workspace] option[value^="local-workspace:"]', option => option.value);
    await page.select("select[id$=-workspace]", workspaceId);
    if (kind === "sidebar") await checkNavigation(page);
    await showActivity(page);
    const recordId = records.requests[0].record.operation;
    await selectRecord(page, recordId);
    await checkWorkspaceSwitch(page, workspaceId);
    await selectRecord(page, recordId);
    if (kind === 'detail') {
      await checkActivityEditor(page, records, f);
    } else {
    await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Inspect record").click());
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Open recorded revision" && !button.disabled));
    if (process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(page, kind, process.env.IDLE_ASSEMBLY_OUTPUT);
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
    assert.equal(await page.$eval('#idle-history', element => element.getBoundingClientRect().height), 400, 'CSP permits graph sizing');
    }
    assert.equal(await page.evaluate(() => document.body.textContent.includes('Starting Idle…')), false, 'the startup placeholder is removed after mounting');
    await page.evaluate(() => document.documentElement.style.setProperty("--vscode-editor-background", "#112233"));
    assert.equal(await page.$eval(".idle-theme", element => getComputedStyle(element).backgroundColor), "rgb(17, 34, 51)", 'the view follows host theme tokens');
    if (kind === 'sidebar') {
      await page.evaluate(() => document.documentElement.style.setProperty('--vscode-sideBar-background', '#223344'));
      assert.equal(await page.$eval('.idle-theme', element => getComputedStyle(element).backgroundColor), 'rgb(34, 51, 68)', 'the sidebar uses the sidebar palette when it differs from the editor');
      await page.evaluate(() => document.documentElement.style.removeProperty('--vscode-sideBar-background'));
    }
    if (kind === "sidebar") await checkActivityUpdate(page);
    await checkSearch(page);
    await checkReadyReplies(page, workspaceId);
    await page.close();
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  await checkMiniActivity(browser, origin, {
    binding: provider.selectedWorkspace, fixture: f, errors, savePage,
    append: () => appendCapture(host, workspace, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  });
  console.log('PASS: packaged mini Activity loads at 280px, reveals the exact editor record and receives live capture updates.');
  await checkRepository(browser, origin, records, f, () => { projectionFixture = true; }, errors, savePage);
  await checkConfiguration(browser, origin, errors, savePage, workspace);
  await checkResources(browser, origin, errors, workspace, host);
  assert.deepEqual(expectedFailures, [], "host operations succeed");
  await checkAuthentication(browser, origin, f, host, errors, expectedFailures);
  if (process.env.IDLE_ACTIVITY_BENCHMARK_CHAIN) await checkActivityPerformance(browser, origin, errors, savePage);
  assert.deepEqual(errors, [], "the packaged views have no browser or CSP errors");
  console.log("PASS: packaged sidebar/detail, Git repository/authors, recorded sessions and reopened selection, projection URLs/exact Originals, native history, configuration conflicts/drafts/deletion/recreation, declared/live resources, original-request recovery and GitHub authentication/reconnection.");
} catch (error) {
  console.error('Assembly failed:', error);
  for (const [index, page] of (await browser?.pages() ?? []).entries()) {
    try { await savePage(page, `failure-${index}`, process.env.IDLE_ASSEMBLY_OUTPUT ?? join(root, 'outputs', 'assembly')); } catch {}
  }
  throw error;
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

async function checkActivityEditor(page, records, fixture) {
  const before = fixture.calls.editorCommands.length;
  await selectRecord(page, records.requests[0].record.operation);
  await waitFor(() => fixture.calls.editorCommands.length > before);
  const opened = fixture.calls.editorCommands.at(-1);
  assert.equal(opened.id, 'vscode.diff', 'file changes open a normal recorded diff on one click');
  assert.deepEqual(opened.args[3], { preview: true }, 'native previews use normal editor placement');
  const hex = fixture.calls.contentProviders.find(provider => provider.scheme === 'idle-history-hex').provider;
  for (const [index, expected] of [records.before, records.after].entries()) {
    const content = await hex.provideTextDocumentContent(opened.args[index]);
    const bytes = content.split('\n').flatMap(line => line.split('  ')[1].split(' ').map(byte => parseInt(byte, 16)));
    assert.deepEqual(Buffer.from(bytes), Buffer.from(expected));
  }
  const count = fixture.calls.editorCommands.length;
  await page.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
  await page.focus('#idle-history');
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(fixture.calls.editorCommands.length, count, 'arrows and the second click do not open another editor');
  await selectRecord(page, records.requests.at(-1).record.operation);
  await waitFor(() => fixture.calls.editorCommands.length > count);
  const json = fixture.calls.editorCommands.at(-1);
  assert.equal(json.id, 'vscode.open', 'unavailable file content opens operation JSON');
  assert(json.args[0].path.endsWith('.json'));
  const text = fixture.calls.contentProviders.find(provider => provider.scheme === 'idle-history-text').provider;
  const operation = JSON.parse(await text.provideTextDocumentContent(json.args[0]));
  assert.equal(operation.id, records.requests.at(-1).record.operation);
  assert.equal(await page.$('.idle-history-inspector'), null);
  assert.ok(await page.$('.idle-timeline-header'), 'the editor uses one continuous table');
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'the table owns vertical scrolling');
  assert.equal(await page.$eval('.idle-timeline-row', element => element.getBoundingClientRect().height), 34);
  if (process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(page, 'detail', process.env.IDLE_ASSEMBLY_OUTPUT);
  await checkActivityScroll(page);
}

async function checkActivityScroll(page) {
  const viewport = page.viewport();
  await page.setViewport({ ...viewport, height: 260 });
  await page.waitForFunction(() => {
    const grid = document.querySelector('#idle-history');
    return grid.scrollHeight > grid.clientHeight;
  });
  const last = await page.$eval('.idle-timeline-canvas', canvas => canvas.lastElementChild.dataset.occurrence);
  await page.click(`.idle-timeline-row[data-occurrence="${last}"]`);
  await page.focus('#idle-history');
  const count = await page.$$eval('.idle-timeline-row', rows => rows.length);
  for (let index = 0; index < count; index++) {
    await page.keyboard.press('ArrowUp');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
  }
  await page.waitForFunction(() => document.querySelector('#idle-history').scrollTop === 0);
  assert.ok(await page.$eval('#idle-history', grid => {
    const selected = grid.querySelector('.idle-timeline-row[aria-selected="true"]');
    return selected.getBoundingClientRect().top >= grid.querySelector('.idle-timeline-header').getBoundingClientRect().bottom;
  }), 'packaged keyboard navigation reveals the newest row beneath the sticky header');
  await page.setViewport(viewport);
}

async function checkTimelineFind(page) {
  const input = '#idle-history-search';
  await page.$eval(input, input => {
    input.value = 'x'.repeat(4097);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('button[aria-label="Find in activity"]');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('4096 bytes'));
  await page.evaluate(() => { window.assemblyFixture.holdMethod = 'app.history'; });
  await page.$eval(input, input => {
    input.value = 'never-matches-anything';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('button[aria-label="Find in activity"]');
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  assert.equal(await page.$eval('button[aria-label="Next match"]', button => button.disabled), true);
  assert(await page.$('.idle-timeline-row'), 'rows remain readable during Find');
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = undefined;
    for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent('message', { data }));
  });
  await page.waitForFunction(() => document.querySelector('.idle-history-match-count')?.textContent === '0 of 0');
  await page.waitForFunction(() => document.body.textContent.includes('records have unavailable text'));
  await page.$eval(input, input => {
    input.value = 'recorded.ts';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('button[aria-label="Find in activity"]');
  await page.waitForFunction(() => document.querySelector('.idle-history-match-count')?.textContent === '1 of 3');
  await page.click('button[aria-label="Next match"]');
  await page.waitForFunction(() => document.querySelector('.idle-history-match-count')?.textContent === '2 of 3');
  await page.click('button[aria-label="Clear activity Find"]');
  assert.equal(await page.$('[role="alert"]'), null);
}

async function checkSearch(page) {
  if (await page.$('.idle-history-explorer')) return checkTimelineFind(page);
  const editor = Boolean(await page.$('.idle-history-explorer'));
  const selector = editor ? '#idle-history-search' : '#idle-search';
  const submit = editor ? 'button[aria-label="Search history"]' : undefined;
  await page.evaluate(selector => {
    const input = document.querySelector(selector);
    input.value = "x".repeat(16_385);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
  await submitSearch(page, submit);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes("Search text exceeds")));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Retry search" && !button.disabled)), true);
  await page.evaluate(selector => {
    window.assemblyFixture.holdMethod = "app.history";
    const input = document.querySelector(selector);
    input.value = "never-matches-anything";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
  await submitSearch(page, submit);
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(element => /Searching(?: history)?…/.test(element.textContent))), true);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Search more").getAttribute("aria-disabled")), "true");
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = undefined;
    for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent("message", { data }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(element => element.textContent.includes("fields could not be searched")));
  if (editor) {
    assert.equal(await page.$eval('.idle-history-match-count', element => element.textContent), '0 of 0');
    assert.equal(await page.$eval('button[aria-label="Next match"]', button => button.disabled), true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Search more')), false, 'completed search has no continuation');
  } else {
    assert.equal(await page.evaluate(() => document.body.textContent.includes("0 loaded matches")), true);
    assert.deepEqual(await page.evaluate(() => ["Next match", "Search more"].map(label => [...document.querySelectorAll("button")].find(button => button.textContent === label).disabled)), [true, true]);
  }
  assert.equal(await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? null), null);
}

async function submitSearch(page, selector) {
  if (selector) await page.click(selector);
  else await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Search').click());
}

async function checkReadyReplies(page, workspaceId) {
  const workspaceCalls = await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === "app.workspace").length);
  await page.evaluate(() => {
    const { data } = window.assemblyFixture.responses.find(({ request }) => request.method === "host.ready");
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$eval("select[id$=-workspace]", element => element.value), workspaceId, "duplicate ready does not clear selection");
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
  await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
  await page.select("select[id$=-workspace]", workspaceId);
  await showActivity(page);
}

async function showActivity(page) {
  if (!await page.$('.idle-history-explorer')) await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Activity" || button.getAttribute('aria-label') === 'Open Activity').click());
  await page.waitForSelector('#idle-search, #idle-history-search');
  await page.waitForSelector('#idle-history[aria-busy="false"] [role="treeitem"], #idle-history[aria-busy="false"] .idle-timeline-row');
}

async function selectRecord(page, recordId) {
  if (await page.$('.idle-history-explorer')) {
    const selector = `.idle-timeline-row[data-operation="${recordId}"]`;
    await page.waitForSelector(selector);
    await page.click(selector);
    await page.waitForSelector(`${selector}[aria-selected="true"]`);
    return;
  }
  const selector = `#idle-history [role="treeitem"][id$="${Buffer.from(recordId).toString("hex")}"]`;
  await page.$eval('#idle-history', element => { element.scrollTop = 0; });
  for (let step = 0; step < 40; step++) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (await page.$(selector)) {
      await page.click(selector);
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Inspect record'));
      return;
    }
    await page.$eval('#idle-history', element => { element.scrollTop += element.clientHeight / 2; });
  }
  throw new Error(`Recorded item ${recordId} is absent from the loaded graph.`);
}

async function checkNavigation(page) {
  assert.deepEqual(await page.$$eval('.idle-navigation-section', nodes => nodes.map(node => node.dataset.section)),
    ['Workspace', 'Members', 'Sessions', 'Projections', 'ComputeHosts', 'ModelProviders', 'Activity']);
  assert.equal(await page.$eval('.idle-navigation-activity .idle-history-viewport', element => element.getBoundingClientRect().height), 176);
  await page.waitForFunction(() => document.querySelector('.idle-navigation')?.textContent.includes('You (local)'));
  await page.waitForFunction(() => document.querySelector('.idle-navigation')?.textContent.includes('Online'));
  assert.equal(await page.$('[aria-label="Repository workspace"]'), null, 'repository inspection stays outside the sidebar');
  await page.waitForFunction(() => document.querySelector('.idle-navigation-branch')?.textContent.includes('main'));
  assert.equal(await page.$eval('.idle-navigation-row', element => element.getBoundingClientRect().height), 22, 'sidebar rows match the workbench density');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the sidebar fits without horizontal scrolling');
  if (process.env.IDLE_ASSEMBLY_OUTPUT) {
    const previous = await page.evaluate(() => {
      const before = { style: document.documentElement.style.cssText, body: document.body.className };
      document.body.classList.add('vscode-dark');
      for (const [name, value] of Object.entries({
        'sideBar-background': '#181818', 'sideBar-foreground': '#cccccc',
        'foreground': '#cccccc', 'descriptionForeground': '#999999',
        'sideBarSectionHeader-background': '#181818', 'sideBarSectionHeader-border': '#2b2b2b',
        'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'dropdown-border': '#3c3c3c',
        'list-hoverBackground': '#2a2d2e', 'focusBorder': '#0078d4',
      })) document.documentElement.style.setProperty(`--vscode-${name}`, value);
      return before;
    });
    await savePage(page, 'workspace-sidebar', process.env.IDLE_ASSEMBLY_OUTPUT);
    await page.evaluate(previous => {
      document.documentElement.style.cssText = previous.style;
      document.body.className = previous.body;
    }, previous);
  }
  assert.equal(await page.$eval('.idle-navigation-heading', element => getComputedStyle(element).display), 'flex');
  await page.evaluate(() => document.querySelector('[data-section="Projections"] button').click());
  await page.waitForFunction(() => document.querySelectorAll('.idle-projection-panel').length === 4);
  await page.waitForFunction(() => document.body.textContent.includes('no supported github.com remote'));
  for (const title of ['Settings', 'Agent Rules']) {
    await page.evaluate(title => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === title).click(), title);
    await page.waitForFunction(title => [...document.querySelectorAll('h2')].some(heading => heading.textContent === title), {}, title);
    await page.waitForFunction(() => document.body.textContent.includes('This document has not been created.'));
  }
}

async function checkWorkspaceSwitch(page, selected) {
  const other = await page.$eval('select[id$=-workspace]', (element, current) => [...element.options].find(option => option.value && option.value !== current).value, selected);
  for (const id of [other, selected]) {
    const before = await page.evaluate(() => window.assemblyFixture.responses.length);
    await page.select('select[id$=-workspace]', id);
    await page.waitForFunction((id, before) => ['app.coordination', 'app.history'].every(method => window.assemblyFixture.responses.slice(before).some(({ request, data }) => request.method === method && request.params.binding.workspace_id === id && data.result)), {}, id, before);
    await showActivity(page);
    assert.equal(await page.evaluate(() => document.querySelector('.idle-timeline-row[aria-selected="true"]') !== null || [...document.querySelectorAll('button')].some(button => button.textContent === 'Inspect record')), false, 'folder switches clear the previous record selection');
  }
}

async function appendCapture(host, workspace, session = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') {
  const { StdioClient } = require('../out/host/processes');
  const client = new StdioClient({}, host.native.connection(workspace, 'capture', {
    workspace_path: workspace, chain_dir: join(workspace, 'chain'),
  }));
  const event = (sequence, event) => ({ schema: 1, session, sequence, time_ms: Date.now(),
    identity: { kind: 'unsigned', guid: '22222222-2222-4222-8222-222222222222', stream: 'a'.repeat(24) },
    units: { offsets: 'utf16_code_units', positions: 'zero_based_line_utf16_column', snapshots: 'utf8_bytes' }, event });
  try {
    client.start();
    const result = await client.request({ RecordEditorEvents: { workspace_path: workspace, chain_dir: 'chain', events: [
      event(1, { type: 'tracking_started', dwell_ms: 500, vscode_version: '1.85.0', activity_schema: 3 }),
      event(2, { type: 'document_snapshot', document: { id: 'browser-capture', uri: pathToFileURL(join(workspace, 'new.ts')).toString(), path: 'new.ts', version: 1 }, text: 'captured after the view opened' }),
    ] } }, { timeoutMs: 30_000 });
    assert.equal(result.Ok.accepted, 2);
  } finally { await client.shutdown(); }
}

async function checkActivityUpdate(page) {
  const before = await page.$$eval('#idle-history [role="treeitem"]', rows => rows.length);
  await page.evaluate(async () => {
    const response = await fetch('/append', { method: 'POST' });
    if (!response.ok) throw new Error('Native capture append failed');
    const request = window.assemblyFixture.requests.findLast(request => request.method === 'app.history');
    window.dispatchEvent(new MessageEvent('message', { data: { protocol: request.protocol, session: request.session,
      event: 'history.changed', params: { binding: request.params.binding } } }));
  });
  await page.waitForFunction(before => document.querySelectorAll('#idle-history [role="treeitem"]').length > before, {}, before);
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Inspect record')), true, 'history invalidation preserves selected record details');
}

async function savePage(page, name, directory) {
  await mkdir(directory, { recursive: true });
  await page.bringToFront();
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: true });
  await writeFile(join(directory, name + '.html'), await page.content());
  await writeFile(join(directory, name + '.json'), JSON.stringify(await page.evaluate(() => window.assemblyFixture), null, 2));
}
