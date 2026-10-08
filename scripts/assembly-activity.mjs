import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function deliver(page, event, params) {
  await page.evaluate((event, params) => {
    const { protocol, session } = window.assemblyFixture.responses[0].data;
    window.dispatchEvent(new MessageEvent('message', { data: { protocol, session, event, params } }));
  }, event, params);
}

async function open(browser, url, width, errors) {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width, height: 900 });
  await page.goto(url);
  await page.waitForFunction(() => window.assemblyFixture.responses.some(({ request, data }) => request.method === 'app.workspace' && data.result));
  return page;
}

async function waitForBinding(page, workspace) {
  await page.waitForFunction(workspace => window.assemblyFixture.responses.some(({ request, data }) =>
    request.method === 'app.history' && request.params.binding.workspace_id === workspace
      && request.params.operation.action.Reconcile && data.result), {}, workspace);
}

async function waitForWorkspaceReads(page, workspace) {
  await waitForBinding(page, workspace);
  await page.waitForFunction(workspace => {
    const { requests, responses } = window.assemblyFixture;
    const reads = requests.filter(request => request.params?.binding?.workspace_id === workspace
      && ['app.history', 'app.repository', 'app.projection'].includes(request.method));
    return ['app.repository', 'app.projection'].every(method => responses.some(({ request, data }) =>
      request.method === method && request.params.binding.workspace_id === workspace
        && request.params.initial !== true && data.result))
      && reads.every(request => responses.some(response => response.request.id === request.id));
  }, {}, workspace);
}

export async function checkMiniActivity(browser, origin, { binding, fixture, errors, savePage, append }) {
  const mini = await open(browser, `${origin}/?kind=sidebar&section=Activity`, 280, errors);
  let editor;
  try {
    await deliver(mini, 'host.workspaceSelected', binding);
    await waitForBinding(mini, binding.workspace_id);
    await mini.waitForSelector('.idle-history-mini-row');
    console.log('Mini Activity: native rows loaded.');
    assert.equal(await mini.$('.idle-history-explorer'), null, 'the native Activity pane uses its own composition');
    assert.equal(await mini.$eval('.idle-history-mini-row', row => row.getBoundingClientRect().height), 28);
    assert.ok(await mini.$$eval('.idle-history-mini-row', rows => rows.length <= 40));
    assert.ok(await mini.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const exact = await mini.$eval('.idle-history-mini-row', row => ({ occurrence: row.dataset.occurrence,
      address: { Record: { source: 'current', record: { operation: row.dataset.operation, hash: row.dataset.recordHash } } } }));
    const before = fixture.calls.editorCommands.length;
    await mini.click(`.idle-history-mini-row[data-occurrence="${exact.occurrence}"]`);
    await mini.waitForFunction(() => window.assemblyFixture.responses.some(({ request, data }) => request.method === 'views.openDetail' && Object.hasOwn(data, 'result')));
    const target = await mini.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'views.openDetail').params);
    assert.deepEqual(target.timeline, exact, 'the mini sends the exact occurrence and record digest');
    assert.equal(fixture.calls.editorCommands.length, before, 'mini selection reveals Activity without opening content');
    editor = await open(browser, `${origin}/?kind=detail`, 1200, errors);
    console.log('Mini Activity: editor opened; delivering the exact destination.');
    await deliver(editor, 'host.navigate', target);
    console.log('Mini Activity: destination delivered.');
    await waitForBinding(editor, binding.workspace_id);
    console.log('Mini Activity: editor subscription reconciled.');
    await editor.waitForSelector(`.idle-timeline-row[data-occurrence="${exact.occurrence}"][aria-selected="true"]`);
    assert.equal(await editor.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dataset.recordHash), exact.address.Record.record.hash);
    assert.equal(fixture.calls.editorCommands.length, before, 'revealing a selection does not activate its content');
    console.log('Mini Activity: exact selection revealed without opening content.');
    await mini.bringToFront();
    const previous = await mini.$$eval('.idle-history-mini-row', rows => rows.map(row => row.dataset.occurrence));
    await append();
    console.log('Mini Activity: fresh capture appended.');
    await deliver(mini, 'history.changed', { binding });
    await mini.waitForFunction(previous => [...document.querySelectorAll('.idle-history-mini-row')]
      .some(row => !previous.includes(row.dataset.occurrence)), {}, previous);
    assert.equal(await editor.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dataset.recordHash), exact.address.Record.record.hash,
      'mini refresh preserves the editor selection');
    assert.equal(fixture.calls.editorCommands.length, before);
    if (process.env.IDLE_ASSEMBLY_OUTPUT) {
      await savePage(mini, 'activity-mini', process.env.IDLE_ASSEMBLY_OUTPUT);
      await savePage(editor, 'activity-mini-destination', process.env.IDLE_ASSEMBLY_OUTPUT);
    }
  } catch (error) {
    console.error('Mini Activity failed:', error);
    if (process.env.IDLE_ASSEMBLY_OUTPUT) {
      await savePage(mini, 'activity-mini-failure', process.env.IDLE_ASSEMBLY_OUTPUT);
      if (editor) await savePage(editor, 'activity-mini-destination-failure', process.env.IDLE_ASSEMBLY_OUTPUT);
    }
    console.error('Mini state:', await mini.evaluate(() => ({
      text: document.body.textContent,
      requests: window.assemblyFixture.requests.map(request => request.method),
      failures: window.assemblyFixture.responses.filter(({ data }) => data.error),
    })), 'binding:', binding);
    throw error;
  } finally {
    await mini.close();
    await editor?.close();
  }
}

export async function checkActivityPerformance(browser, origin, errors, savePage) {
  const samples = [];
  let startup;
  let find;
  for (let iteration = -1; iteration < 6; iteration++) {
    const page = await open(browser, `${origin}/?kind=detail`, 1200, errors);
    try {
      const workspace = await page.$eval('select[id$=-workspace]', select => [...select.options]
        .find(option => option.textContent.includes('Activity benchmark')).value);
      await page.select('select[id$=-workspace]', workspace);
      if (iteration < 0) await waitForBinding(page, workspace);
      else await waitForWorkspaceReads(page, workspace);
      assert.equal(await page.$('.idle-timeline-row'), null, 'timing starts before the Activity view has loaded');
      await page.evaluate(workspace => {
        const request = window.assemblyFixture.requests.findLast(request => request.method === 'app.history' && request.params.binding.workspace_id === workspace);
        window.activityDisplayStart = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: { protocol: request.protocol, session: request.session,
          event: 'host.navigate', params: { binding: request.params.binding, section: 'Activity' } } }));
      }, workspace);
      await page.waitForSelector('.idle-timeline-row');
      const elapsed = await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - window.activityDisplayStart;
      });
      console.log(`Activity display sample ${iteration}: ${elapsed.toFixed(1)} ms`);
      assert.ok(await page.$$eval('.idle-timeline-row', rows => rows.length < 50), 'the million-record editor mounts only its viewport');
      if (iteration > 0) samples.push(elapsed);
      if (iteration < 0) startup = elapsed;
      if (iteration === 5 && process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(page, 'million-record-editor', process.env.IDLE_ASSEMBLY_OUTPUT);
      if (iteration === 5) {
        await page.$eval('#idle-history-search', input => {
          input.value = 'Activity 987654:';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const start = performance.now();
        await page.click('button[aria-label="Find in activity"]');
        await page.waitForFunction(() => document.querySelector('.idle-history-match-count')?.textContent === '1 of 1'
          && document.querySelector('.idle-timeline-row[aria-selected="true"]')?.textContent.includes('Activity 987654:'));
        find = { query: 'Activity 987654:', elapsed_ms: performance.now() - start, matches: 1 };
      }
    } catch (error) {
      console.error('Activity display failed:', error);
      console.error('Activity state:', await page.evaluate(() => ({
        text: document.body.textContent,
        history: window.assemblyFixture.responses.filter(({ request }) => request.method === 'app.history')
          .map(({ request, data }) => ({ operation: request.params.operation, result: data.error ?? data.result?.Err
            ?? (data.result?.Ok?.Timeline ? data.result.Ok.Timeline : Object.keys(data.result?.Ok ?? {})) })),
      })));
      if (process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(page, 'activity-performance-failure', process.env.IDLE_ASSEMBLY_OUTPUT);
      throw error;
    } finally { await page.close(); }
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
  const runner = {};
  for (const name of ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'memory.peak']) {
    try { runner[name] = (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim(); } catch {}
  }
  const result = { startup_display_ms: startup, warm_display_ms: samples, p95_ms: p95, find, runner };
  console.log(`Activity display: ${JSON.stringify(result)}`);
  if (process.env.IDLE_ASSEMBLY_OUTPUT) await writeFile(join(process.env.IDLE_ASSEMBLY_OUTPUT, 'activity-performance.json'), JSON.stringify(result, null, 2));
  assert.ok(p95 <= 1000, `warm Activity display p95 ${p95.toFixed(1)} ms exceeds 1000 ms`);
}
