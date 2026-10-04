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
    assert(await page.evaluate(() => document.body.textContent.includes('Idle members and presence')));
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
    await page.close();
    page = await open(browser, origin, 'sidebar', errors);
    await click(page, 'Sessions');
    await page.waitForSelector(selected);
    await page.waitForSelector('#idle-recorded-history [role="treeitem"]');
    await click(page, 'Inspect session record 1');
    await page.waitForFunction(id => document.body.textContent.includes(id) && document.body.textContent.includes('Inspect record'), {}, records.session_id);
    await click(page, 'Activity');
    await page.waitForSelector('#idle-history [role="treeitem"]');
    const lastHistory = await page.evaluate(() => window.assemblyFixture.requests.filter(request => request.method === 'app.history' && request.params.query.action.History).at(-1));
    assert.equal(lastHistory.params.query.action.History.filter.session, null, 'Activity clears the session filter');

    enableProjections();
    await click(page, 'Projections');
    await click(page, 'Refresh projections');
    await page.waitForFunction(() => document.body.textContent.includes('Repository fixture need_input'));
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
    await page.waitForFunction(() => document.body.textContent.includes('github') && document.body.textContent.includes('Fixture issue'));
    assert(await page.evaluate(hash => document.body.textContent.includes(hash), records.github_source.record_hash), 'the inspector retains the exact stored source hash');
    await capture(page, 'github-source', savePage);
    await click(page, 'Projections');
    await capture(page, 'projections', savePage);
    passed = true;
  } finally { if (passed) await page.close(); }
}

async function open(browser, origin, kind, errors) {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 360, height: 900 });
  await page.goto(`${origin}/?kind=${kind}`);
  await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
  const workspace = await page.$eval('select[id$=-workspace] option[value^="local-workspace:"]', option => option.value);
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
