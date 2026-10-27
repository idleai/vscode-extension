import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { git, rawManifest } from './fixture.mjs';

const origin = process.argv[2] ?? 'http://127.0.0.1:4173';
const output = resolve(process.argv[3] ?? 'outputs/activity-compare/captures');
assert(process.env.CHROME_BIN, 'Set CHROME_BIN to the Chromium executable.');
await mkdir(output, { recursive: true });
const manifest = await (await fetch(`${origin}/api/manifest`)).json();
const journal = async () => {
  const lines = (await readFile(join(manifest.runDirectory, 'events.jsonl'), 'utf8')).split('\n');
  lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
};
const gitCount = Number(git(manifest.input.source, 'rev-list', 'HEAD', '--count'));
const windowOf = event => event.message?.result?.Ok?.Timeline?.Window;
const latestWindow = events => events.map(windowOf).filter(Boolean).at(-1);
const results = { manifest, started: new Date().toISOString(), startSequence: (await journal()).at(-1)?.sequence ?? 0, cases: [], browserErrors: [] };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
let page;
let frames;
async function mount(profile) {
  const start = performance.now();
  await page.select('#profile', profile);
  await page.waitForFunction(() => ['legacy', 'current'].every(side => {
    const frame = document.getElementById(side);
    return frame.contentWindow.location.href === frame.src && frame.contentDocument.querySelector(
      side === 'legacy' ? '#rows .row[data-key]' : '.idle-timeline-row');
  }), { timeout: 180_000 });
  frames = Object.fromEntries(await Promise.all(['legacy', 'current'].map(async side => [side, await (await page.$(`#${side}`)).contentFrame()])));
  if (profile === 'git') await frames.current.waitForFunction(count => {
    const filter = document.querySelector('select[aria-label="Filter activity kind"]');
    return filter?.value === 'git' && document.body.innerText.includes(`${count} activities`);
  }, { timeout: 180_000 }, gitCount);
  return Math.round(performance.now() - start);
}
async function capture(name, details = {}) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const views = Object.fromEntries(await Promise.all(Object.entries(frames).map(async ([side, frame]) => [side, await frame.evaluate(() => window.activityCompare.snapshot())])));
  const snapshot = { name, ...details, views };
  await writeFile(join(output, `${name}.json`), JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  results.cases.push({ name, ...details });
  console.log(`Captured ${name}`);
}
async function seek(frame, selector, index) {
  await frame.$eval(selector, (node, row) => { node.scrollTop = Math.max(0, row - 2) * 34; }, index);
}
async function openedCount() { return (await journal()).filter(event => event.kind === 'editor.open').length; }
async function click(frame, selector) {
  // The panes scale their iframe contents. Convert the actual control rectangle
  // to page coordinates so native pointer clicks land on the intended control.
  const rect = await frame.$eval(selector, node => {
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth, height: innerHeight };
  });
  const outer = await (await frame.frameElement()).boundingBox();
  await page.mouse.click(outer.x + rect.x * outer.width / rect.width, outer.y + rect.y * outer.height / rect.height);
}

try {
  page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1100, deviceScaleFactor: 1 });
  await page.emulateTimezone('America/Los_Angeles');
  page.on('pageerror', error => results.browserErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') results.browserErrors.push(message.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#legacy').src.includes('/legacy/'));
  const loadMs = await mount('all');
  let events = await journal();
  const initial = latestWindow(events);
  const oldRows = events.filter(event => event.side === 'legacy').map(event => event.response?.body?.Ok?.rows).filter(Boolean).find(rows => rows.length >= initial.visible_rows);
  assert(oldRows, 'The legacy native service returned its initial rows.');
  assert.equal(oldRows.length, initial.visible_rows, 'Initial native row counts match.');
  assert.equal(oldRows[0].content.git_oid, initial.rows[0].address.Commit.oid, 'The first commit matches across repository-specific IDs.');
  await capture('all-top', { loadMs, legacyRows: oldRows.length, currentRows: initial.visible_rows, underlyingActivities: initial.activities });

  const currentIndex = initial.rows.findIndex(row => row.occurrence.startsWith('activity:') && row.group?.header && row.group.count > 2);
  assert(currentIndex >= 0, 'This recorded corpus includes a provider task in the first native window.');
  const task = initial.rows[currentIndex];
  const matches = oldRows.map((row, index) => ({ row, index })).filter(({ row }) => row.content.timestamp_ms === task.timestamp);
  assert.equal(matches.length, 1, 'The task timestamp has one legacy match.');
  const oldTask = matches[0];
  const oldControl = `#rows .row[data-key="${oldTask.row.content.node_key}"] .task-chevron`;
  const currentControl = `.idle-timeline-row[data-occurrence="${task.occurrence}"] .idle-timeline-disclosure`;
  await Promise.all([seek(frames.legacy, '#rows', oldTask.index), seek(frames.current, '.idle-timeline-viewport', currentIndex)]);
  await Promise.all([frames.legacy.waitForSelector(oldControl), frames.current.waitForSelector(currentControl)]);
  const taskMatch = { legacyKey: oldTask.row.content.node_key, currentOccurrence: task.occurrence, timestamp: task.timestamp, count: task.group.count };
  await capture('task-collapsed', { task: taskMatch });
  await click(frames.legacy, oldControl);
  await click(frames.current, currentControl);
  await Promise.all([
    frames.legacy.waitForSelector(`${oldControl}[aria-expanded="true"]`),
    frames.current.waitForSelector(`${currentControl}[aria-expanded="true"]`),
  ]);
  events = await journal();
  const expanded = latestWindow(events);
  const legacyExpanded = events.filter(event => event.side === 'legacy').map(event => event.response?.body?.Ok?.rows ? event.response.body.Ok.total : undefined).filter(value => value !== undefined).at(-1);
  assert.equal(expanded.visible_rows, initial.visible_rows + task.group.count - 1);
  assert.equal(legacyExpanded, expanded.visible_rows, 'Both task disclosures reveal the same number of rows.');
  await capture('task-expanded', { task: taskMatch, legacyRows: legacyExpanded, currentRows: expanded.visible_rows });
  await click(frames.legacy, oldControl);
  await click(frames.current, currentControl);
  await Promise.all([frames.legacy.waitForSelector(`${oldControl}[aria-expanded="false"]`), frames.current.waitForSelector(`${currentControl}[aria-expanded="false"]`)]);

  await mount('git');
  await capture('git-top');
  const oid = manifest.input.head;
  const oldCommit = `#rows .row[data-key$=":${oid}"]`;
  const currentCommit = `.idle-timeline-row[data-occurrence$=":${oid}"]`;
  await click(frames.legacy, `${oldCommit} .subop-chevron`);
  await click(frames.current, `${currentCommit} .idle-timeline-title`);
  await frames.legacy.waitForSelector('#rows .row-file');
  await frames.current.waitForFunction(() => document.querySelector('.idle-timeline-row[aria-selected="true"]'));
  await capture('git-click', { difference: 'Old Git disclosure adds file rows. Current Git click requests a native commit patch.' });
  await click(frames.legacy, '#rows .row-file');
  await page.waitForFunction(async () => {
    const events = await (await fetch('/api/events')).json();
    return events.filter(event => event.kind === 'editor.open').length >= 2;
  });
  events = await journal();
  const opens = events.filter(event => event.kind === 'editor.open');
  const legacyOpen = opens.findLast(event => event.side === 'legacy');
  const currentOpen = opens.findLast(event => event.side === 'current' && event.command === 'vscode.open');
  assert(legacyOpen?.result?.Ok, 'Old native file content resolves.');
  assert(currentOpen?.files?.length, 'Current native commit content resolves.');
  const patch = await readFile(currentOpen.files[0].file, 'utf8');
  assert(patch.startsWith(`commit ${oid}`));
  await writeFile(join(output, 'current-commit.diff'), patch);
  await writeFile(join(output, 'legacy-file.json'), JSON.stringify(legacyOpen, null, 2));
  const beforeKeys = await openedCount();
  const selectedCurrent = await frames.current.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dataset.occurrence);
  const selectedLegacy = await frames.legacy.$eval('#rows .row[aria-selected="true"]', row => row.dataset.key);
  await frames.current.focus('#idle-history'); await page.keyboard.press('ArrowDown');
  await frames.current.waitForFunction(previous => {
    const key = document.querySelector('.idle-timeline-row[aria-selected="true"]')?.dataset.occurrence;
    return key && key !== previous;
  }, {}, selectedCurrent);
  await frames.legacy.focus('#rows .row[aria-selected="true"]'); await page.keyboard.press('ArrowDown');
  await frames.legacy.waitForFunction(previous => {
    const key = document.activeElement.closest('.row')?.dataset.key;
    return key && key !== previous;
  }, {}, selectedLegacy);
  assert.equal(await frames.legacy.$eval('#rows .row[aria-selected="true"]', row => row.dataset.key), selectedLegacy, 'Old arrows move focus while retaining selection.');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await openedCount(), beforeKeys, 'Arrow navigation does not request another editor.');
  await capture('git-file-and-keyboard', { difference: 'Old arrows move row focus; current arrows move row selection. Neither opens another editor.' });

  await frames.legacy.type('#search', 'activity'); await page.keyboard.press('Enter');
  await frames.current.type('#idle-history-search', 'activity');
  await click(frames.current, 'button[aria-label="Find in activity"]');
  await Promise.all([
    frames.legacy.waitForFunction(() => /1 of [1-9]/.test(document.querySelector('#search-counter')?.textContent)),
    frames.current.waitForFunction(() => /1 of [1-9]/.test(document.querySelector('.idle-history-match-count')?.textContent)),
  ]);
  const search = { query: 'activity', legacy: await frames.legacy.$eval('#search-counter', node => node.textContent), current: await frames.current.$eval('.idle-history-match-count', node => node.textContent) };
  await capture('git-find', search);
  await click(frames.legacy, '#search-next');
  await click(frames.current, 'button[aria-label="Next match"]');
  await Promise.all([
    frames.legacy.waitForFunction(() => /2 of/.test(document.querySelector('#search-counter')?.textContent)),
    frames.current.waitForFunction(() => /2 of/.test(document.querySelector('.idle-history-match-count')?.textContent)),
  ]);
  await capture('git-find-next');
  await page.click('#capture');
  for (const side of ['legacy', 'current']) {
    const raw = await rawManifest(join(manifest.runDirectory, side, 'workspace'));
    assert.equal(raw.digest, manifest.input.digest, `${side} raw input is unchanged`);
  }
  assert.deepEqual(results.browserErrors, []);
  results.endSequence = (await journal()).at(-1)?.sequence ?? results.startSequence;
  results.harnessErrors = (await journal()).filter(event => event.sequence > results.startSequence && event.kind === 'error');
  assert.deepEqual(results.harnessErrors, [], 'The scenario has no transport or renderer errors.');
  results.result = 'PASS';
  console.log('PASS: matching raw input, initial rows, task disclosure, Git action differences, resolved file/commit content, keyboard navigation, and find/next.');
} catch (error) {
  results.result = 'FAIL'; results.error = String(error);
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(join(output, 'summary.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
