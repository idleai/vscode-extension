import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Two independent editor documents against the packaged native authority.
export async function checkConfiguration(browser, origin, errors, savePage, workspace) {
  let sidebar = await open(browser, origin, 'sidebar', errors);
  let detail = await open(browser, origin, 'detail', errors);
  let passed = false;
  try {
    const first = '{"integration":{"unknown":[1,"first"]}}';
    console.log('Checking configuration draft storage');
    await edit(sidebar, first);
    await click(sidebar, 'Save');
    const firstRevision = await saved(sidebar);
    const directory = join(workspace, '.idle', 'workspace');
    assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), first, 'saving settings writes the checkout');
    const manifest = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
    assert.equal(manifest.schema_version, 1);
    assert.ok(manifest.id, 'the checkout has a stable authored identity');
    await click(detail, 'Refresh document');
    await detail.waitForFunction(() => document.querySelector('textarea').value.includes('first'));
    await edit(detail, '{"integration":{"unknown":"detail draft"}}');
    await edit(sidebar, '{"integration":{"unknown":"sidebar update"}}');
    await click(sidebar, 'Save');
    const secondRevision = await saved(sidebar, firstRevision);
    const canSave = await detail.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save')?.disabled === false);
    if (canSave) await click(detail, 'Save');
    await detail.waitForFunction(() => document.body.textContent.includes('This document changed since you started editing'));
    await waitStored(detail);
    await detail.close();
    detail = await open(browser, origin, 'detail', errors);
    await detail.waitForFunction(() => document.querySelector('textarea').value.includes('detail draft'));
    assert.equal(await detail.evaluate(() => document.body.textContent.includes('This document changed since you started editing')), true);
    await click(detail, 'Use draft with current revision');
    await click(detail, 'Save');
    const thirdRevision = await saved(detail, secondRevision);
    await click(detail, 'Agent Rules');
    await detail.waitForSelector('#idle-agent-rules-json');
    await edit(detail, '{"instructions":"review changes"}');
    await click(detail, 'Save');
    await saved(detail);
    assert.equal(await readFile(join(directory, 'agent-rules.json'), 'utf8'), '{"instructions":"review changes"}', 'saving agent rules writes the checkout');
    await click(detail, 'Settings');
    assert.equal(await detail.$eval('textarea', element => element.value), '{"integration":{"unknown":"detail draft"}}');

    // Closing before receipt keeps the immutable original save for recovery.
    await click(sidebar, 'Refresh document');
    await sidebar.waitForFunction(() => document.querySelector('textarea').value.includes('detail draft'));
    await sidebar.evaluate(() => { window.assemblyFixture.holdMutation = true; });
    await edit(sidebar, '{"integration":{"unknown":"lost acknowledgement"}}');
    await click(sidebar, 'Save');
    await sidebar.waitForFunction(() => window.assemblyFixture.held.length > 0);
    const original = await sidebar.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'app.coordination' && JSON.parse(request.params.command).kind === 'mutate').params.command);
    await waitStored(sidebar);
    await sidebar.close();
    sidebar = await open(browser, origin, 'sidebar', errors);
    await sidebar.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Recover save' && !button.disabled));
    await click(sidebar, 'Recover save');
    const fourthRevision = await saved(sidebar, thirdRevision);
    const retry = await sidebar.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'app.coordination' && JSON.parse(request.params.command).kind === 'mutate').params.command);
    assert.equal(retry, original, 'recovery reuses the exact request ID, deadline, revision and contents');
    await click(sidebar, 'Refresh document');
    await saved(sidebar, fourthRevision, true);
    sidebar = await recoverDuringEditing(browser, origin, sidebar, errors, fourthRevision);
    assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), '{"pending":"recover despite newer edits"}', 'recovery saves the original request while preserving the newer editor draft');
    if (process.env.IDLE_ASSEMBLY_OUTPUT) await savePage(sidebar, 'settings', process.env.IDLE_ASSEMBLY_OUTPUT);
    passed = true;
  } finally {
    if (passed) { await sidebar.close(); await detail.close(); }
  }
}

async function recoverDuringEditing(browser, origin, page, errors, previousRevision) {
  await page.evaluate(() => { window.assemblyFixture.holdMutation = true; });
  await edit(page, '{"pending":"recover despite newer edits"}');
  await click(page, 'Save');
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  const original = await page.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'app.coordination' && JSON.parse(request.params.command).kind === 'mutate').params.command);
  await waitStored(page);
  await page.close();
  page = await open(browser, origin, 'sidebar', errors, true);
  await page.waitForFunction(() => window.assemblyFixture.held.length > 0);
  const newer = '{"new":"edited before draft recovery"}';
  await page.$eval('textarea', (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, newer);
  await page.evaluate(() => {
    window.assemblyFixture.holdMethod = undefined;
    for (const data of window.assemblyFixture.held.splice(0)) window.dispatchEvent(new MessageEvent('message', { data }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Recover save' && !button.disabled));
  await waitStored(page);
  assert.equal(await page.$eval('textarea', element => element.value), newer, 'late recovery preserves current edits');
  const pending = await page.evaluate(() => {
    const state = window.assemblyFixture.requests.findLast(request => request.method === 'app.configurationState' && request.params.operation === 'store');
    return JSON.parse(state.params.drafts).find(draft => draft.document === 'Settings').pending;
  });
  assert.equal(pending.request.request_id, JSON.parse(original).data.context.request_id, 'the persisted draft retains its original request');
  await click(page, 'Recover save');
  await saved(page, previousRevision);
  const retry = await page.evaluate(() => window.assemblyFixture.requests.findLast(request => request.method === 'app.coordination' && JSON.parse(request.params.command).kind === 'mutate').params.command);
  assert.equal(retry, original, 'new edits do not replace the original save payload');
  assert.equal(await page.$eval('textarea', element => element.value), newer, 'confirming the original save preserves current edits');
  return page;
}

async function open(browser, origin, kind, errors, holdDrafts = false) {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/?kind=${kind}`);
  await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
  const workspace = await page.$eval('select[id$=-workspace] option[value^="local-workspace:"]', option => option.value);
  if (holdDrafts) await page.evaluate(() => { window.assemblyFixture.holdMethod = 'app.configurationState'; });
  await page.select('select[id$=-workspace]', workspace);
  await click(page, 'Settings');
  await page.waitForFunction(() => document.querySelector('#idle-settings-json')?.readOnly === false);
  if (!holdDrafts) await waitStored(page);
  return page;
}

async function click(page, label) {
  await page.bringToFront();
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === label && !button.disabled), {}, label);
  await page.evaluate(label => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label).click(), label);
}

async function edit(page, value) {
  await page.$eval('textarea', (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await waitStored(page);
}

async function saved(page, previous = '0', unchanged = false) {
  await page.waitForFunction((previous, unchanged) => {
    const revision = document.body.textContent.match(/Saved revision (\d+)\./)?.[1];
    return revision && (unchanged ? revision === previous : BigInt(revision) > BigInt(previous));
  }, {}, previous, unchanged);
  await waitStored(page);
  return page.evaluate(() => document.body.textContent.match(/Saved revision (\d+)\./)[1]);
}

async function waitStored(page) {
  await page.bringToFront();
  await page.waitForFunction(() => {
    const stores = window.assemblyFixture.requests.filter(request => request.method === 'app.configurationState');
    return stores.length && stores.every(request => window.assemblyFixture.responses.some(response => response.request.id === request.id));
  });
}
