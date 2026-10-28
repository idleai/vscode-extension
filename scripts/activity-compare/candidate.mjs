import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:4174';
const output = resolve(process.argv[3] ?? 'outputs/activity-original/interactions');
const groups = JSON.parse(await readFile(process.argv[4] ?? 'outputs/activity-original/groups/summary.json', 'utf8'));
assert.equal(groups.result, 'PASS');
for (const side of ['legacy', 'current']) {
  const action = label => groups.actions.find(item => item.side === side && item.label === label);
  for (const label of ['click count', 'click body', 'Enter 1']) {
    assert.equal(action(label).after.group.expanded, 'true', `${side}: ${label} expands the task.`);
    assert.equal(action(label).opens.length, 0, `${side}: ${label} does not open an editor.`);
  }
  assert.equal(action('click count when revealed').after.group.expanded, 'false');
  assert.equal(action('click body when revealed').after.group.expanded, 'true');
  assert.equal(action('click body when revealed').opens.length, 0);
  assert.equal(action('Enter 2').after.group.expanded, 'true');
  assert.equal(action('Enter 2').opens.length, 1, `${side}: the second Enter opens the physical anchor.`);
  assert.equal(action('minimize with selected child').after.rows.some(row => row.selected === 'true'), false);
}

assert(process.env.CHROME_BIN, 'Set CHROME_BIN to the Chromium executable.');
await mkdir(output, { recursive: true });
const manifest = await (await fetch(`${origin}/api/manifest`)).json();
async function journal() {
  const text = await readFile(join(manifest.runDirectory, 'events.jsonl'), 'utf8');
  return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1050, deviceScaleFactor: 1 });
await page.emulateTimezone('America/Los_Angeles');
const results = { manifest, started: new Date().toISOString(), startSequence: (await journal()).at(-1).sequence, errors: [] };
page.on('pageerror', error => results.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') results.errors.push(message.text()); });
const pause = ms => new Promise(done => setTimeout(done, ms));
let frames;
async function click(side, selector, count = 1) {
  const point = await frames[side].$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, height: innerHeight };
  });
  const outer = await (await frames[side].frameElement()).boundingBox();
  await page.mouse.click(outer.x + point.x * outer.width / point.width, outer.y + point.y * outer.height / point.height, { count });
}
async function waitFor(check, message) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    assert(Date.now() < deadline, message);
    await pause(50);
  }
}
async function capture(name) {
  const views = {};
  for (const side of ['legacy', 'current']) views[side] = await frames[side].evaluate(() => window.activityCompare.snapshot());
  await writeFile(join(output, `${name}.json`), JSON.stringify(views, null, 2));
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
}
try {
  await page.goto(origin);
  await page.select('#profile', 'git');
  await page.waitForFunction(() => ['legacy', 'current'].every(side => {
    const frame = document.getElementById(side);
    return frame.contentWindow.location.href === frame.src && frame.contentDocument.querySelector(side === 'legacy' ? '#rows .row[data-key]' : '.idle-timeline-row');
  }), { timeout: 300_000 });
  frames = Object.fromEntries(await Promise.all(['legacy', 'current'].map(async side => [side, await (await page.$(`#${side}`)).contentFrame()])));
  await frames.current.waitForFunction(() => document.querySelector('select[aria-label="Filter activity kind"]')?.value === 'git');
  const currentSelector = '.idle-timeline-row:not([data-child="true"])';
  const legacySelector = '#rows .row[data-key]';
  const currentKey = await frames.current.$eval(currentSelector, row => row.dataset.occurrence);
  const legacyKey = await frames.legacy.$eval(legacySelector, row => row.dataset.key);
  assert.equal(currentKey.split(':').at(-1), legacyKey.split(':').at(-1), 'Both first rows are the exact same commit.');
  const before = (await journal()).at(-1).sequence;
  await click('current', `${currentSelector} .idle-timeline-detail-toggle`);
  await click('legacy', `${legacySelector} .subop-chevron`);
  await frames.current.waitForSelector('.idle-timeline-row[data-child="true"][data-file="true"]');
  await frames.legacy.waitForSelector('#rows .row-file');
  assert.equal((await journal()).filter(item => item.sequence > before && item.kind === 'editor.open').length, 0);
  results.commit = { currentKey, legacyKey };
  await capture('commit-files');
  await click('current', '.idle-timeline-row[data-child="true"][data-file="true"] .idle-timeline-content');
  await click('legacy', '#rows .row-file .text-cell');
  await waitFor(async () => (await journal()).filter(item => item.sequence > before && item.kind === 'editor.open').length === 2, 'Both file diffs open.');
  const opens = (await journal()).filter(item => item.sequence > before && item.kind === 'editor.open');
  const current = opens.find(item => item.side === 'current');
  const legacy = opens.find(item => item.side === 'legacy');
  assert.equal(current.command, 'vscode.diff');
  assert.equal(current.files.length, 2, 'The packaged provider resolves both immutable sides.');
  assert(legacy.result?.Ok, 'The original native file content resolves.');
  results.fileOpens = { current, legacy };
  for (const [index, file] of current.files.entries()) {
    const content = await readFile(file.file, 'utf8');
    assert.equal(content, legacy.result.Ok[index === 0 ? 'before' : 'after'], 'Both native services resolve identical immutable file content.');
    await writeFile(join(output, index === 0 ? 'before.txt' : 'after.txt'), content);
  }
  const selected = await frames.current.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dataset.occurrence);
  await frames.current.focus('.idle-timeline-row[aria-selected="true"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await frames.current.$eval('.idle-timeline-row[aria-selected="true"]', row => row.dataset.occurrence), selected, 'Arrow navigation leaves selection unchanged.');
  assert.notEqual(await frames.current.evaluate(() => document.activeElement?.dataset.occurrence), selected, 'Arrow navigation moves focus to the next row.');
  const startJson = (await journal()).at(-1).sequence;
  await click('current', `${currentSelector} .idle-timeline-content`, 2);
  await waitFor(async () => (await journal()).some(item => item.sequence > startJson && item.side === 'current' && item.kind === 'editor.open'), 'Commit JSON opens after double-click.');
  const json = (await journal()).find(item => item.sequence > startJson && item.side === 'current' && item.kind === 'editor.open');
  assert.equal(json.command, 'vscode.open');
  const metadata = JSON.parse(await readFile(json.files[0].file, 'utf8'));
  assert(['Sha1', 'Sha256'].includes(metadata.oid.format));
  const oid = Buffer.from(metadata.oid.bytes).subarray(0, metadata.oid.format === 'Sha1' ? 20 : 32).toString('hex');
  assert.equal(oid, currentKey.split(':').at(-1), 'The JSON contains the complete native commit identity.');
  results.commitJson = json;
  await capture('commit-json');
  const searchStart = (await journal()).at(-1).sequence;
  await frames.current.type('input[aria-label="Find in activity"]', 'activity');
  await page.keyboard.press('Enter');
  await frames.current.waitForFunction(() => {
    const match = document.querySelector('.idle-history-match-count')?.textContent.match(/^1 of (\d+)/);
    return match && Number(match[1]) > 1;
  });
  results.find = { first: await frames.current.$eval('.idle-history-match-count', node => node.textContent) };
  await click('current', 'button[aria-label="Next match"]');
  await frames.current.waitForFunction(() => /^2 of/.test(document.querySelector('.idle-history-match-count')?.textContent));
  assert.equal(await frames.current.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find in activity', 'Next match restores the search input focus.');
  results.find.next = await frames.current.$eval('.idle-history-match-count', node => node.textContent);
  await page.keyboard.press('Escape');
  await frames.current.waitForFunction(() => !document.querySelector('.idle-history-match-count') && !document.querySelector('.idle-timeline-row[aria-selected="true"]'));
  assert.equal(await frames.current.$eval('input[aria-label="Find in activity"]', node => node.value), 'activity', 'Escape clears Find and selection while retaining the draft.');
  assert.equal((await journal()).filter(item => item.sequence > searchStart && item.kind === 'editor.open').length, 0, 'Find navigation never opens an editor.');
  results.endSequence = (await journal()).at(-1).sequence;
  assert.deepEqual((await journal()).filter(item => item.sequence > results.startSequence && item.kind === 'error'), []);
  assert.deepEqual(results.errors, []);
  results.result = 'PASS';
  console.log('PASS: paired task actions, inline commit files, immutable diff content, independent focus, commit JSON, and native Find.');
} catch (error) {
  results.result = 'FAIL'; results.error = String(error);
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(join(output, 'summary.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
