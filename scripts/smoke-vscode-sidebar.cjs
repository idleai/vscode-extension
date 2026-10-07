const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync, realpathSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const artifacts = require('./native-artifacts.cjs');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.IDLE_SIDEBAR_OUTPUT ?? path.join(root, 'outputs/sidebar-vscode'));
const binary = process.env.VSCODE_BIN;
const containers = process.env.CONTAINERS_EXTENSION;
assert.ok(binary && path.isAbsolute(binary), 'VSCODE_BIN must be an absolute desktop VS Code executable');
assert.ok(containers && path.isAbsolute(containers), 'CONTAINERS_EXTENSION must be the installed Containers extension directory');
const executable = realpathSync(binary);
const desktop = path.basename(path.dirname(executable)) === 'bin' ? path.resolve(path.dirname(executable), '../code') : executable;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(operation, description) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await operation();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function idleFrame(page, section = "Activity") {
  return until(async () => {
    for (const frame of page.frames()) {
      try { if (await frame.$(`.idle-navigation-pane[data-section="${section}"]`)) return frame; }
      catch (error) {
        if (!/Cannot find context|Execution context was destroyed|detached/i.test(String(error))) throw error;
      }
    }
  }, 'Idle webview');
}

async function pane(page, title) {
  const header = await paneHeader(page, title);
  return (await header.evaluateHandle(element => element.closest('.pane'))).asElement();
}

async function treeRow(page, title, label) {
  const container = await pane(page, title);
  return until(async () => (await container.evaluateHandle((element, label) =>
    [...element.querySelectorAll('.monaco-list-row')].find(row => row.querySelector('.label-name')?.textContent === label), label)).asElement(), `${title} row ${label}`);
}

async function chooseWorkspace(page, label, branch) {
  await expand(page, 'Workspace', true);
  await (await treeRow(page, 'Workspace', label)).click();
  const container = await pane(page, 'Workspace');
  await until(() => container.evaluate((element, label, branch) => [...element.querySelectorAll('.monaco-list-row')]
    .some(row => row.querySelector('.label-name')?.textContent === label && row.querySelector('.codicon-check') &&
      row.querySelector('.label-description')?.textContent.includes(branch)), label, branch), `selected ${label} and branch`);
}

async function detailFrame(page) {
  return until(async () => {
    for (const content of page.frames()) {
      try { if (await content.$('#main[data-view-kind="detail"]')) return content; }
      catch (error) { if (!/context|detached/i.test(String(error))) throw error; }
    }
  }, 'detail editor');
}

async function paneHeader(page, title) {
  return until(async () => {
    const handle = await page.evaluateHandle(title => [...document.querySelectorAll('.part.sidebar .pane-header')]
      .find(header => header.querySelector('.title')?.textContent.trim().toLowerCase() === title.toLowerCase()), title);
    return handle.asElement();
  }, `native ${title} header`);
}

async function expand(page, title, expanded) {
  const header = await paneHeader(page, title);
  if ((await header.evaluate(element => element.getAttribute('aria-expanded') === 'true')) !== expanded) await header.click();
  await until(async () => (await header.evaluate(element => element.getAttribute('aria-expanded') === 'true')) === expanded, `${title} disclosure`);
  // The native split view animates after its disclosure attribute changes.
  await pause(250);
}

function measureHeader(element) {
  const title = element.querySelector('.title');
  const icon = element.querySelector('.codicon');
  const style = getComputedStyle(element), text = getComputedStyle(title);
  return { height: element.getBoundingClientRect().height, borderRadius: style.borderRadius, padding: style.padding,
    margin: style.margin, background: style.backgroundColor, font: text.font, color: text.color,
    titleOffset: title.getBoundingClientRect().left - element.getBoundingClientRect().left,
    icon: { width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height, glyph: getComputedStyle(icon, '::before').content } };
}

function measureRow(row, label) {
  const style = getComputedStyle(row);
  return { height: row.getBoundingClientRect().height, font: style.font, color: style.color, radius: style.borderRadius,
    labelOffset: label.getBoundingClientRect().left - row.getBoundingClientRect().left };
}

(async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'idle-sidebar-vscode-'));
  const workspace = path.join(temporary, 'workspace');
  const secondWorkspace = path.join(temporary, 'second-workspace');
  const workspaceFile = path.join(temporary, 'sidebar.code-workspace');
  const driver = path.join(temporary, 'driver');
  const extensions = path.join(temporary, 'extensions');
  const profile = ['--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', extensions,
    '--shared-data-dir', path.join(temporary, 'shared')];
  const env = { ...process.env, IDLE_SIDEBAR_TEST_ROOT: temporary };
  for (const key of ['VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD', 'VSCODE_PID', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  let child, browser;
  let log = '';
  let sequence = 0;
  const command = async request => {
    const id = ++sequence;
    await fs.writeFile(path.join(temporary, 'command.json'), JSON.stringify({ id, ...request }));
    const result = await until(async () => {
      try { const result = JSON.parse(await fs.readFile(path.join(temporary, 'result.json'), 'utf8')); return result.id === id && result; }
      catch { return false; }
    }, JSON.stringify(request));
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  try {
    await fs.mkdir(output, { recursive: true });
    await fs.mkdir(path.join(temporary, 'profile/User'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await fs.mkdir(driver);
    await fs.mkdir(extensions);
    await fs.writeFile(path.join(temporary, 'profile/User/settings.json'), JSON.stringify({
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
      'workbench.colorTheme': 'Default Dark Modern', 'workbench.startupEditor': 'none',
      'workbench.experimental.modernUI': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'window.zoomLevel': 0, 'window.menuBarVisibility': 'compact', 'chat.disableAIFeatures': true,
      'security.workspace.trust.enabled': false,
    }));
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
      'idle.chainDirectory': 'chain', 'idle.live.enabled': false, 'idle.tracking.enabled': false,
    }));
    await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'idle-sidebar-driver', publisher: 'idle-tests',
      version: '0.0.1', engines: { vscode: '^1.85.0' }, main: './main.cjs', activationEvents: ['onStartupFinished'] }));
    await fs.copyFile(path.join(root, 'test/vscode/sidebar.cjs'), path.join(driver, 'main.cjs'));
    await fs.cp(containers, path.join(extensions, path.basename(containers)), { recursive: true });
    execFileSync(artifacts.binary('host-tools', 'history-fixture'), [workspace], { cwd: root, stdio: 'inherit' });
    await fs.writeFile(path.join(workspace, 'README.txt'), 'Desktop sidebar fixture.\n');
    execFileSync('git', ['init', '-b', 'main', workspace], { stdio: 'ignore' });
    execFileSync('git', ['-C', workspace, 'add', 'README.txt']);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Sidebar Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'], { stdio: 'ignore' });
    await fs.cp(workspace, secondWorkspace, { recursive: true, filter: source => source !== path.join(workspace, 'chain') });
    // Each index checkpoint is bound to its original chain directory.
    execFileSync(artifacts.binary('host-tools', 'history-fixture'), [secondWorkspace], { cwd: root, stdio: 'inherit' });
    execFileSync('git', ['-C', secondWorkspace, 'switch', '-c', 'second'], { stdio: 'ignore' });
    await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: secondWorkspace }] }));
    execFileSync(binary, [...profile, '--install-extension', path.resolve(process.argv[2] ?? 'idle.vsix'), '--force', '--no-sandbox'],
      { env, stdio: 'inherit', timeout: 120_000 });
    const port = await freePort();
    child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x1000x24', desktop, ...profile, '--no-sandbox', '--disable-gpu',
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--locale=en', `--remote-debugging-port=${port}`,
      `--extensionDevelopmentPath=${driver}`, workspaceFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    await until(() => existsSync(path.join(temporary, 'ready.json')), 'desktop test driver');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    const page = (await browser.pages())[0];
    const report = { ...JSON.parse(await fs.readFile(path.join(temporary, 'ready.json'), 'utf8')), modes: {} };
    const save = async name => {
      await page.mouse.move(800, 400);
      await pause(250);
      await page.screenshot({ path: path.join(output, `${name}-workbench.png`) });
      const clip = await page.$eval('.part.sidebar', element => {
        const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
      });
      await page.screenshot({ path: path.join(output, `${name}.png`), clip, captureBeyondViewport: false });
      assert.equal(await page.$eval('.part.sidebar', element => element.getBoundingClientRect().width), clip.width, 'capturing the sidebar must not resize the workbench');
      return clip.width;
    };
    for (const [mode, theme, modern, compact] of [
      ['dark', 'Default Dark Modern', true, false], ['light', 'Default Light Modern', true, false],
      ['compact', 'Default Dark Modern', true, true], ['classic', 'Default Dark Modern', false, false],
    ]) {
      await command({ config: { 'workbench.colorTheme': theme, 'workbench.experimental.modernUI': modern,
        'window.density.layout': compact ? 'compact' : 'default' } });
      await command({ command: 'workbench.view.extension.containersView' });
      await page.waitForFunction(() => [...document.querySelectorAll('.part.sidebar .monaco-list-row')].some(row => row.textContent.startsWith('Read Extension Documentation')));
      await pause(250);
      const nativeHeader = await page.$('.part.sidebar .pane-header');
      const native = await nativeHeader.evaluate(measureHeader);
      const nativeRow = (await page.evaluateHandle(() => [...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(row => row.textContent.startsWith('Read Extension Documentation')))).asElement();
      const referenceRow = await page.evaluate(measureRow, nativeRow, await nativeRow.$('.label-name'));
      const nativeWidth = await save(`${mode}-containers`);
      if (mode === 'dark') {
        if (process.env.IDLE_SIDEBAR_TRACE === '1') await command({ traceRepository: true });
        await command({ openFile: path.join(secondWorkspace, 'README.txt') });
      }
      const startup = performance.now();
      await command({ command: 'idle.open' });
      const bindings = await command({ bindings: true });
      assert.equal(bindings.length, 2, 'multi-folder directory');
      if (mode === 'dark') {
        const workspacePane = await pane(page, 'Workspace');
        await until(() => workspacePane.evaluate(element => [...element.querySelectorAll('.monaco-list-row')]
          .some(row => row.querySelector('.label-name')?.textContent === 'second-workspace' &&
            row.querySelector('.codicon-check') && row.querySelector('.label-description')?.textContent.includes('second'))),
        'fresh profile selects the active editor folder without a workspace click');
        const selected = performance.now() - startup;
        const sessionsPane = await pane(page, 'Sessions');
        await until(() => sessionsPane.evaluate(element => [...element.querySelectorAll('.label-description')]
          .some(label => label.textContent === 'Recorded')), 'recorded sessions after automatic selection');
        report.startup = { defaultWorkspace: 'second-workspace', selectedMs: Math.round(selected), recordedMs: Math.round(performance.now() - startup) };
        for (const title of ['Projections', 'Compute hosts', 'Model providers']) {
          const header = await paneHeader(page, title);
          assert.equal(await header.evaluate(element => element.getAttribute('aria-expanded')), 'false', `${title} starts folded in a fresh profile`);
        }
      }
      await chooseWorkspace(page, 'workspace', 'main');
      await expand(page, 'Sessions', true);
      await treeRow(page, 'Sessions', 'Control model');
      await page.mouse.move(800, 400);
      const header = await paneHeader(page, 'Workspace');
      const idle = await header.evaluate(measureHeader);
      assert.deepEqual(idle, native, `${mode}: real workbench pane header matches Containers`);
      const names = await page.$$eval('.part.sidebar .pane-header .title', elements => elements.map(element => element.textContent.trim()));
      assert.deepEqual(names.map(name => name.toLowerCase()), ['workspace', 'users', 'sessions', 'projections', 'compute hosts', 'model providers', 'activity']);
      const row = await treeRow(page, 'Sessions', 'Control model');
      const idleRow = await page.evaluate(measureRow, row, await row.$('.label-name'));
      assert.deepEqual(idleRow, referenceRow, `${mode}: native tree row geometry and typography`);
      assert.ok((await page.$$('.part.sidebar .monaco-sash.horizontal')).length >= 6, 'native split view dividers');
      for (const title of ['Workspace', 'Users', 'Sessions', 'Projections', 'Compute hosts', 'Model providers']) {
        const collapsed = ['Users', 'Projections', 'Compute hosts', 'Model providers'].includes(title);
        if (collapsed) await expand(page, title, true);
        const container = await pane(page, title);
        await until(() => container.$('.monaco-list-row'), `${title} native tree rows`);
        assert.equal(await container.$$eval('iframe, webview', elements => elements.length), 0, `${title} renders without a webview`);
        assert.equal(await container.$eval('.monaco-list', element => element.getAttribute('role')), 'tree', `${title} exposes native tree accessibility`);
        if (collapsed) await expand(page, title, false);
      }
      await expand(page, 'Activity', true);
      const activity = await idleFrame(page);
      await activity.waitForFunction(binding => document.querySelector('.idle-navigation-pane').dataset.workspace === binding, {}, bindings[0].workspace_id);
      assert.equal(await activity.$$eval('summary, .idle-navigation-heading, .idle-repository', elements => elements.length), 0, 'Activity has no inner pane header or inspector');
      assert.equal(await activity.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Activity has no horizontal overflow');
      const footer = await activity.$eval('.idle-navigation-configuration', element => ({
        labels: [...element.querySelectorAll('button')].map(button => button.textContent.trim()),
        disclosures: element.querySelectorAll('details, summary, [aria-expanded]').length,
        top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
        graphBottom: document.querySelector('.idle-navigation-activity').getBoundingClientRect().bottom,
        height: window.innerHeight,
      }));
      assert.deepEqual(footer.labels, ['Settings', 'Agent Rules'], 'standalone configuration links');
      assert.equal(footer.disclosures, 0, 'single configuration entries have no fold controls');
      assert.ok(footer.top >= footer.graphBottom && footer.bottom <= footer.height, 'configuration links stay visible below the scrollable graph');
      // Hidden custom content must reopen on the native trees' latest selection.
      await expand(page, 'Activity', false);
      await chooseWorkspace(page, 'second-workspace', 'second');
      await expand(page, 'Users', true);
      const usersHeader = await paneHeader(page, 'Users');
      await usersHeader.focus();
      await page.keyboard.press('Space');
      await until(async () => (await usersHeader.evaluate(element => element.getAttribute('aria-expanded'))) === 'false', 'native keyboard collapse');
      await page.keyboard.press('Enter');
      await until(async () => (await usersHeader.evaluate(element => element.getAttribute('aria-expanded'))) === 'true', 'native keyboard expand');
      await expand(page, 'Users', false);
      await expand(page, 'Activity', true);
      const reopened = await idleFrame(page);
      await reopened.waitForFunction(binding => document.querySelector('.idle-navigation-pane').dataset.workspace === binding, {}, bindings[1].workspace_id);
      await chooseWorkspace(page, 'workspace', 'main');
      // Use the native tree's keyboard selection to open an exact recorded session.
      const sessionsPane = await pane(page, 'Sessions');
      const recorded = await until(async () => (await sessionsPane.evaluateHandle(element => [...element.querySelectorAll('.monaco-list-row')]
        .find(row => row.querySelector('.label-description')?.textContent === 'Recorded'))).asElement(), 'recorded session tree row');
      const label = await recorded.$eval('.label-name', element => element.textContent);
      const index = Number(await recorded.evaluate(element => element.getAttribute('data-index')));
      const tree = await sessionsPane.$('.monaco-list');
      await tree.focus();
      await page.keyboard.press('Home');
      for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const detail = await detailFrame(page);
      await detail.waitForFunction(({ binding, label }) => document.querySelector('#idle-workspace')?.value === binding &&
        document.querySelector('.idle-detail-navigation [aria-current="page"]')?.textContent === 'Sessions' &&
        document.querySelector('.idle-recorded-session[data-selected="true"] button')?.textContent === label,
        {}, { binding: bindings[0].workspace_id, label });
      await command({ command: 'workbench.action.closeActiveEditor' });
      await command({ command: 'idle.open' });
      if (mode === 'dark') {
        await expand(page, 'Projections', true);
        const projectionsHeader = await paneHeader(page, 'Projections');
        await projectionsHeader.hover();
        const action = await projectionsHeader.$('.codicon-open-preview');
        assert.ok(action, 'native header exposes the detail command');
        await action.click();
        const inspector = await detailFrame(page);
        await inspector.waitForFunction(() => document.querySelector('.idle-detail-navigation [aria-current="page"]')?.textContent === 'Projections');
        await command({ command: 'workbench.action.closeActiveEditor' });
        await command({ command: 'idle.open' });
        await expand(page, 'Projections', false);
        await chooseWorkspace(page, 'second-workspace', 'second');
        for (const title of ['Settings', 'Agent Rules']) {
          const navigation = await idleFrame(page);
          await navigation.waitForFunction(binding => document.querySelector('.idle-navigation-pane').dataset.workspace === binding, {}, bindings[1].workspace_id);
          const link = await navigation.$(`.idle-navigation-configuration button[title="${title}"]`);
          if (title === 'Settings') await link.click();
          else { await link.focus(); await page.keyboard.press('Enter'); }
          const configuration = await detailFrame(page);
          await configuration.waitForFunction(({ title, binding }) =>
            document.querySelector('.idle-detail-navigation [aria-current="page"]')?.textContent === title &&
            document.querySelector('#idle-workspace')?.value === binding,
          {}, { title, binding: bindings[1].workspace_id });
          await command({ command: 'workbench.action.closeActiveEditor' });
          await command({ command: 'idle.open' });
        }
        await chooseWorkspace(page, 'workspace', 'main');
        // The real Rust presenter gets a large typed directory from the test host.
        await expand(page, 'Activity', false);
        await command({ directorySize: 1200 });
        const workspacePane = await pane(page, 'Workspace');
        await until(() => workspacePane.evaluate(element => element.querySelector('[aria-setsize="1202"]')), 'complete 1,202-row native tree');
        const mounted = await workspacePane.$$eval('.monaco-list-row', rows => rows.length);
        assert.ok(mounted < 100, `native scrolling virtualizes the full directory (${mounted} rows mounted)`);
        const workspaceTree = await workspacePane.$('.monaco-list');
        await workspaceTree.focus();
        await page.keyboard.press('End');
        await treeRow(page, 'Workspace', 'List fixture 1199');
        await page.keyboard.press('Home');
        await treeRow(page, 'Workspace', 'workspace');
        report.longList = { total: 1202, mounted, last: 'List fixture 1199' };
        // Native header actions use VS Code's standard input and clear-filter control.
        const workspaceHeader = await paneHeader(page, 'Workspace');
        await workspaceHeader.hover();
        await (await workspaceHeader.$('.codicon-filter')).click();
        await page.waitForSelector('.quick-input-widget input', { visible: true });
        await page.type('.quick-input-widget input', 'List fixture 1199');
        await page.keyboard.press('Enter');
        await until(() => workspacePane.evaluate(element => element.querySelector('[aria-setsize="1"]') &&
          element.querySelector('.label-name')?.textContent === 'List fixture 1199'), 'filtered native directory');
        await workspaceHeader.hover();
        await (await until(() => workspaceHeader.$('.codicon-clear-all'), 'native clear-filter action')).click();
        await until(() => workspacePane.evaluate(element => element.querySelector('[aria-setsize="1202"]')), 'clear native filter');
        await command({ directorySize: 0 });
        await until(() => workspacePane.evaluate(element => element.querySelector('[aria-setsize="2"]')), 'restore actual folder directory');
        await chooseWorkspace(page, 'workspace', 'main');
        await expand(page, 'Activity', true);
        await (await idleFrame(page)).waitForFunction(binding => document.querySelector('.idle-navigation-pane').dataset.workspace === binding, {}, bindings[0].workspace_id);
      }
      const idleWidth = await save(`${mode}-idle`);
      assert.equal(idleWidth, nativeWidth, `${mode}: equal sidebar width`);
      report.modes[mode] = { width: idleWidth, native, idle, row: idleRow, headers: names };
      console.log(`PASS: ${mode}: six native trees, Activity with standalone configuration links, shared selection, exact recorded-session routing and native keyboard controls`);
    }
    // Drag a workbench sash and ensure the new pane size survives switching containers.
    const expanded = await page.$$('.part.sidebar .pane.expanded');
    const before = await expanded[0].evaluate(element => element.getBoundingClientRect().height);
    const sash = (await page.$$('.part.sidebar .monaco-sash.horizontal:not(.disabled)'))[0];
    const bounds = await sash.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 40, { steps: 12 });
    await page.mouse.up();
    const after = await expanded[0].evaluate(element => element.getBoundingClientRect().height);
    assert.ok(after > before + 10, 'native divider resizes its neighboring panes');
    await command({ command: 'workbench.view.extension.containersView' });
    await command({ command: 'idle.open' });
    assert.equal(await page.$eval('.part.sidebar .pane.expanded', element => element.getBoundingClientRect().height), after, 'native divider size persists');
    report.resize = { before, after };
    await command({ config: { 'workbench.experimental.modernUI': true, 'workbench.experimental.modernUIUppercaseViewHeaders': true } });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.part.sidebar .pane-header .title')).textTransform === 'uppercase');
    await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, 'desktop.log'), log);
    await fs.writeFile(path.join(output, 'comparison.html'), `<!doctype html><meta charset="utf-8"><title>Idle and Containers in VS Code ${report.version}</title><style>body{font:14px system-ui;background:#202020;color:#ddd;margin:24px}section{display:flex;gap:16px;margin-bottom:32px}figure{margin:0}img{display:block;margin-top:8px;border:1px solid #555}h1{font-size:18px}h2{font-size:15px}</style><h1>VS Code ${report.version}: Containers and Idle</h1>${Object.keys(report.modes).map(mode => `<h2>${mode}</h2><section><figure><figcaption>Containers</figcaption><img src="${mode}-containers.png"></figure><figure><figcaption>Idle</figcaption><img src="${mode}-idle.png"></figure></section>`).join('')}`);
    console.log(`PASS: real desktop comparison saved to ${output}`);
  } catch (error) {
    if (browser) {
      const page = (await browser.pages())[0];
      await page.screenshot({ path: path.join(output, 'failure-workbench.png') }).catch(() => {});
      const headers = await page.$$eval('.part.sidebar .pane-header', elements => elements.map(element => ({
        title: element.querySelector('.title')?.textContent, expanded: element.getAttribute('aria-expanded'),
      }))).catch(() => []);
      console.error('Native view headers:', headers);
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'desktop.log'), log);
    if (browser) {
      try { await fs.writeFile(path.join(output, 'repository-reads.json'), JSON.stringify(await command({ repositoryReads: true }), null, 2)); }
      catch {}
    }
    await browser?.disconnect();
    if (child && child.exitCode === null) {
      await fs.writeFile(path.join(temporary, 'command.json'), JSON.stringify({ id: ++sequence, command: 'workbench.action.quit' }));
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
      if (child.exitCode === null) child.kill();
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
