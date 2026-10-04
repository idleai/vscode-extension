import assert from 'node:assert/strict';

// Typed GitHub inputs use actual retained Original records. REST field mapping
// and HTTP failures are checked separately by the native adapter's fixtures.
export function repositoryInputs(source) {
  return ['task', 'error', 'triage', 'need_input'].map(kind => ({
    kind, freshness: { status: 'current', generated_at: '1000', checkpoint: null },
    availability: 'complete', total: '1', gaps: [],
    rows: [{ key: `fixture:${kind}`, title: `Repository fixture ${kind}`, summary: 'Declared GitHub fields',
      url: 'https://github.com/idleai/vscode-extension/issues/42', status: 'open', labels: [], sources: [source], related: [] }],
  }));
}

export async function checkRepository(browser, origin, records, fixture, enableProjections, errors, savePage) {
  let page = await open(browser, origin, 'sidebar', errors);
  let passed = false;
  try {
    await page.waitForFunction(() => document.querySelector('[aria-label="Repository workspace"]')?.textContent.includes('main'));
    assert(await page.evaluate(() => document.body.textContent.includes('No commit yet') === false));
    await capture(page, 'repository', savePage);
    await click(page, 'Users');
    await page.waitForFunction(() => document.querySelector('[aria-label="Git authors"]')?.textContent.includes('Repository Fixture'));
    assert(await page.evaluate(() => document.body.textContent.includes('Idle members and online status')));
    await capture(page, 'users', savePage);
    await click(page, 'Sessions');
    await page.waitForFunction(() => document.body.textContent.includes('Imported smoke session'));
    assert(await page.evaluate(() => document.body.textContent.includes('No runtime connected')));
    await click(page, 'Imported smoke session');
    await page.waitForSelector('#idle-recorded-history [role="treeitem"]');
    const selected = `[data-session-id="${records.session_id}"][data-selected="true"]`;
    await page.waitForSelector(selected);
    await remembered(page);
    await capture(page, 'sessions', savePage);
    await click(page, 'Show all recorded history');
    await page.waitForFunction(() => {
      const request = window.assemblyFixture.requests.findLast(request => request.method === 'app.history' && request.params.operation.action.History);
      return request?.params.operation.action.History.filter.session === null
        && window.assemblyFixture.responses.some(response => response.request.id === request.id);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await page.$('#idle-recorded-history'), 'clearing the session keeps the history graph mounted');
    assert.equal(await page.$eval('#idle-search', input => input.type), 'search', 'clearing the session keeps history search mounted');
    await click(page, 'Imported smoke session');
    await page.waitForSelector(selected);
    await remembered(page);
    await page.close();
    page = await open(browser, origin, 'sidebar', errors, true);
    await click(page, 'Activity');
    await page.waitForSelector('#idle-history [role="treeitem"]');
    await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
    await page.evaluate(() => {
      window.assemblyFixture.holdMethod = undefined;
      for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent('message', { data }));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const restoredHistory = await page.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'app.history' && request.params.operation.action.History));
    assert.equal(restoredHistory.params.operation.action.History.filter.session, null, 'delayed session restoration leaves Activity unfiltered');
    await click(page, 'Sessions');
    await page.waitForSelector(selected);
    await page.waitForSelector('#idle-recorded-history [role="treeitem"]');
    await click(page, 'Inspect session record 1');
    await page.waitForFunction(id => document.body.textContent.includes(id) && document.body.textContent.includes('Inspect record'), {}, records.session_id);
    await click(page, 'Activity');
    await page.waitForSelector('#idle-history [role="treeitem"]');
    const lastHistory = await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === 'app.history' && request.params.operation.action.History).at(-1));
    assert.equal(lastHistory.params.operation.action.History.filter.session, null, 'Activity clears the session filter');

    enableProjections();
    await click(page, 'Projections');
    await click(page, 'Refresh projections');
    await page.waitForFunction(() => document.body.textContent.includes('Repository fixture need_input'));
    assert(await page.evaluate(() => window.assemblyFixture.requests.some(request => request.method === 'app.projection' && request.params.operation.refresh_sources === true)), 'manual refresh revalidates upstream sources');
    for (const kind of ['task', 'error', 'triage', 'need_input']) assert(await page.evaluate(kind => document.body.textContent.includes(`Repository fixture ${kind}`), kind));
    const before = fixture.calls.external.length;
    await click(page, 'Open source page');
    await until(() => fixture.calls.external.length > before);
    assert.equal(fixture.calls.external.at(-1), 'https://github.com/idleai/vscode-extension/issues/42');
    await page.evaluate(() => document.querySelector('.idle-projection-records').open = true);
    await click(page, 'Inspect source 1');
    await page.waitForSelector('#idle-history [role="treeitem"]');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Inspect record'));
    await click(page, 'Inspect record');
    await page.waitForFunction(() => document.body.textContent.includes('Original captured content') && document.body.textContent.includes('Fixture issue'));
    assert(await page.evaluate(hash => document.body.textContent.includes(hash), records.github_source.record_hash), 'the inspector retains the exact stored source hash');
    await capture(page, 'github-source', savePage);
    await click(page, 'Projections');
    await capture(page, 'projections', savePage);
    passed = true;
  } finally { if (passed) await page.close(); }
}

async function open(browser, origin, kind, errors, holdRepository = false) {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 360, height: 900 });
  await page.goto(`${origin}/?kind=${kind}`);
  await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
  const workspace = await page.$eval('select[id$=-workspace] option[value^="local-workspace:"]', option => option.value);
  if (holdRepository) await page.evaluate(() => { window.assemblyFixture.holdMethod = 'app.repository'; });
  await page.select('select[id$=-workspace]', workspace);
  return page;
}

async function click(page, label) {
  await page.bringToFront();
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === label && !button.disabled), {}, label);
  await page.evaluate(label => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label && !button.disabled).click(), label);
}

async function remembered(page) {
  await page.waitForFunction(() => window.assemblyFixture.requests.filter(request => request.method === 'app.repository' && request.params.operation.action.Remember).every(request => window.assemblyFixture.responses.some(({ request: done }) => done.id === request.id)));
}

async function capture(page, name, savePage) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} fits the narrow view`);
  if (process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(page, name, process.env.IDLE_ASSEMBLY_OUTPUT);
}

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Source page did not open.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
