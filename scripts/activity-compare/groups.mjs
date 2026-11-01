import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:4173';
const output = resolve(process.argv[3] ?? 'outputs/activity-compare/groups');
assert(process.env.CHROME_BIN, 'Set CHROME_BIN to the Chromium executable.');
await mkdir(output, { recursive: true });
const manifest = await (await fetch(`${origin}/api/manifest`)).json();
async function journal() {
  const text = await readFile(join(manifest.runDirectory, 'events.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const lines = text.split('\n');
  lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
}
const results = { manifest, started: new Date().toISOString(), startSequence: (await journal()).at(-1)?.sequence ?? 0, actions: [], cases: [], errors: [] };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1050, deviceScaleFactor: 1 });
await page.emulateTimezone('America/Los_Angeles');
page.on('pageerror', error => results.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') results.errors.push(message.text()); });
const pause = ms => new Promise(done => setTimeout(done, ms));
let frames;
let sessions;
let group;
let recorder;
const selector = side => side === 'legacy' ? `#rows .row[data-key="${group.legacyKey}"]` : `.idle-timeline-row[data-occurrence="${group.currentKey}"]`;
const disclosure = side => side === 'legacy' ? '.task-chevron' : '.idle-timeline-disclosure';

async function settled() {
  await frames.legacy.waitForFunction(() => window.__activityCompareLegacy.pending === 0);
  const deadline = Date.now() + 30_000;
  while (true) {
    const entries = await journal();
    const replies = new Set(entries.filter(e => e.side === 'current' && e.kind === 'host.reply' && e.message?.session === sessions.current).map(e => e.message.id));
    const pending = entries.some(e => e.side === 'current' && e.kind === 'host.request' && e.message?.session === sessions.current && e.message.method === 'app.history' && !replies.has(e.message.id));
    if (!pending) break;
    assert(Date.now() < deadline, 'Current history requests settle.');
    await pause(50);
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function state(side) {
  const dom = await frames[side].evaluate(({ rowSelector, buttonSelector, count }) => {
    const snapshot = window.activityCompare.snapshot();
    const row = document.querySelector(rowSelector);
    const button = row?.querySelector(buttonSelector);
    const grid = document.querySelector(location.pathname.startsWith('/legacy/') ? '#rows' : '.idle-timeline-viewport');
    const badge = row && [...row.querySelectorAll('*')].find(element => element.children.length === 0 && element.textContent.trim() === `${count} activities`);
    return { ...snapshot, hasFocus: document.hasFocus(), group: row ? {
      text: row.innerText, expanded: button?.getAttribute('aria-expanded'),
      anchorTop: row.getBoundingClientRect().top - grid.getBoundingClientRect().top,
      buttonText: button?.textContent.trim(), buttonLabel: button?.getAttribute('aria-label'),
      buttonBox: button ? { width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height } : null,
      badgeTag: badge?.tagName, badgeClass: badge?.getAttribute('class'),
    } : null };
  }, { rowSelector: selector(side), buttonSelector: disclosure(side), count: group.count });
  const entries = (await journal()).filter(e => e.side === side && (side === 'legacy' ? e.session === sessions.legacy : e.message?.session === sessions.current));
  const windows = entries.map(e => side === 'legacy' ? e.response?.body?.Ok : e.message?.result?.Ok?.Timeline?.Window).filter(w => w && (w.total !== undefined || w.visible_rows !== undefined));
  const last = windows.at(-1);
  return { ...dom, totalRows: last?.visible_rows ?? last?.total };
}

async function caption(text) {
  await page.evaluate(text => {
    document.querySelector('header strong').textContent = 'Group reveal / minimize';
    document.querySelector('header p').textContent = text;
  }, text);
}

async function click(side, target = 'button', rowSelector = selector(side)) {
  const point = await frames[side].evaluate(({ rowSelector, buttonSelector, contentSelector, target, count }) => {
    const row = document.querySelector(rowSelector);
    const element = target === 'button' ? row.querySelector(buttonSelector) : target === 'body' ? row.querySelector(contentSelector) :
      [...row.querySelectorAll('*')].find(element => element.children.length === 0 && element.textContent.trim() === `${count} activities`) ?? row.querySelector(buttonSelector);
    if (!element) throw new Error(`Missing ${target} target`);
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, height: innerHeight,
      tag: element.tagName, class: element.getAttribute('class'), text: element.textContent.slice(0, 120) };
  }, { rowSelector, buttonSelector: disclosure(side), contentSelector: side === 'legacy' ? '.text-cell' : '.idle-timeline-content', target, count: group.count });
  const outer = await (await frames[side].frameElement()).boundingBox();
  const x = outer.x + point.x * outer.width / point.width;
  const y = outer.y + point.y * outer.height / point.height;
  await page.evaluate(({ x, y }) => {
    const marker = document.createElement('div');
    marker.style.cssText = `position:fixed;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;border:2px solid #ffd166;border-radius:50%;pointer-events:none;z-index:9999`;
    document.body.append(marker);
    setTimeout(() => marker.remove(), 600);
  }, { x, y });
  await page.mouse.click(x, y);
  await settled();
  return point;
}

async function act(side, label, operation) {
  const before = await state(side);
  const start = (await journal()).at(-1)?.sequence ?? 0;
  const target = await operation();
  await settled();
  const after = await state(side);
  const opens = (await journal()).filter(e => e.sequence > start && e.side === side && e.kind === 'editor.open');
  const result = { side, label, target, before, after, opens };
  results.actions.push(result);
  console.log(`${side}: ${label}: ${before.totalRows} → ${after.totalRows}, expanded=${after.group?.expanded}, opens=${opens.length}`);
  return result;
}

async function ensure(expanded) {
  for (const side of ['legacy', 'current']) {
    if ((await state(side)).group.expanded !== String(expanded)) await click(side);
    await frames[side].waitForSelector(`${selector(side)} ${disclosure(side)}[aria-expanded="${expanded}"]`);
  }
}

async function capture(name) {
  await settled();
  const views = { legacy: await state('legacy'), current: await state('current') };
  await writeFile(join(output, `${name}.json`), JSON.stringify({ group, views }, null, 2));
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  results.cases.push({ name, rows: Object.fromEntries(Object.entries(views).map(([side, view]) => [side, view.totalRows])) });
  return views;
}

async function cycle(name, animate) {
  for (const side of ['legacy', 'current']) await frames[side].$eval(side === 'legacy' ? '#rows' : '.idle-timeline-viewport', (node, index) => { node.scrollTop = Math.max(0, index - 2) * 34; }, side === 'legacy' ? group.legacyIndex : group.index);
  await Promise.all(['legacy', 'current'].map(side => frames[side].waitForSelector(`${selector(side)} ${disclosure(side)}`)));
  await ensure(false);
  await caption(`${group.count}-activity group · collapsed → revealed → minimized. Yellow rings mark real pointer clicks.`);
  const before = await capture(`${name}-1-collapsed`);
  if (animate) recorder = await page.screencast({ path: join(output, `${name}-cycle.gif`), format: 'gif', fps: 8, loop: Infinity });
  await pause(900);
  for (const side of ['legacy', 'current']) {
    await caption(`${group.count}-activity group · reveal ${side === 'legacy' ? 'old' : 'current'} using its disclosure control`);
    await act(side, 'reveal with disclosure', () => click(side));
    await pause(900);
  }
  await caption(`${group.count}-activity group · both revealed`);
  const expanded = await capture(`${name}-2-revealed`);
  await pause(1200);
  for (const side of ['legacy', 'current']) {
    await caption(`${group.count}-activity group · minimize ${side === 'legacy' ? 'old' : 'current'} using the same control`);
    await act(side, 'minimize with disclosure', () => click(side));
    await pause(900);
  }
  await caption(`${group.count}-activity group · both minimized again`);
  const after = await capture(`${name}-3-minimized`);
  await pause(1200);
  if (recorder) { await recorder.stop(); recorder = undefined; }
  for (const side of ['legacy', 'current']) {
    assert.equal(expanded[side].totalRows, before[side].totalRows + group.count - 1);
    assert.equal(after[side].totalRows, before[side].totalRows);
    assert.equal(after[side].group.expanded, 'false');
    assert.equal(after[side].group.text, before[side].group.text, 'Minimizing restores the original group summary.');
    assert.equal(after[side].scroll.top, before[side].scroll.top, 'The visible group keeps its scroll position.');
    assert.equal(after[side].group.anchorTop, before[side].group.anchorTop, 'The visible group stays at the same vertical position.');
  }
}

try {
  await page.goto(origin);
  console.log('Waiting for both native Activity views…');
  await page.waitForFunction(() => ['legacy', 'current'].every(side => {
    const frame = document.getElementById(side);
    return frame.contentWindow.location.href === frame.src && frame.contentDocument.querySelector(side === 'legacy' ? '#rows .row[data-key]' : '.idle-timeline-row');
  }), { timeout: 300_000 });
  frames = Object.fromEntries(await Promise.all(['legacy', 'current'].map(async side => [side, await (await page.$(`#${side}`)).contentFrame()])));
  sessions = { legacy: await frames.legacy.evaluate(() => window.__activityCompareLegacy.session), current: await frames.current.$eval('#main', node => node.dataset.hostSession) };
  await settled();
  const entries = await journal();
  const current = entries.filter(e => e.message?.session === sessions.current).map(e => e.message?.result?.Ok?.Timeline?.Window).filter(Boolean).at(-1);
  const old = entries.filter(e => e.session === sessions.legacy).map(e => e.response?.body?.Ok?.rows).filter(Boolean).sort((left, right) => right.length - left.length)[0];
  assert(old, 'The original native window is recorded.');
  const match = predicate => {
    const index = current.rows.findIndex(row => row.group?.header && predicate(row));
    assert(index >= 0, 'The recorded history contains the requested group.');
    const row = current.rows[index];
    const oldMatches = old.map((value, index) => ({ value, index })).filter(({ value }) => value.content.timestamp_ms === row.timestamp);
    assert.equal(oldMatches.length, 1, 'The old group has a unique matching timestamp.');
    return { legacyKey: oldMatches[0].value.content.node_key, currentKey: row.occurrence, timestamp: row.timestamp, count: row.group.count, index, legacyIndex: oldMatches[0].index };
  };
  const provider = match(row => row.occurrence.startsWith('activity:') && row.group.count > 2);
  const human = match(row => row.preview.startsWith('Human work') && row.group.count > 1);
  results.groups = { provider, human };
  group = provider;
  await cycle('provider', true);
  for (const target of ['count', 'body']) {
    await ensure(false);
    await caption(`Matched group · clicking the ${target === 'count' ? 'activity count badge' : 'Content cell'} in each UI`);
    for (const side of ['legacy', 'current']) await act(side, `click ${target}`, () => click(side, target));
    await capture(`provider-${target}-click`);
  }
  for (const target of ['count', 'body']) {
    await ensure(true);
    await caption(`Revealed group · clicking the ${target === 'count' ? 'activity count badge' : 'Content cell'} in each UI`);
    for (const side of ['legacy', 'current']) await act(side, `click ${target} when revealed`, () => click(side, target));
    await capture(`provider-revealed-${target}-click`);
  }
  await ensure(false);
  await caption('Keyboard · Enter on the disclosure button, then Enter again without moving focus');
  for (const side of ['legacy', 'current']) {
    await frames[side].focus(`${selector(side)} ${disclosure(side)}`);
    for (let step = 1; step <= 2; step += 1) await act(side, `Enter ${step}`, async () => { await page.keyboard.press('Enter'); await pause(100); });
  }
  await capture('provider-enter-twice');
  await ensure(true);
  for (const side of ['legacy', 'current']) {
    const childSelector = await frames[side].$eval(selector(side), row => {
      const sibling = row.nextElementSibling;
      return sibling.dataset.key ? `.row[data-key="${sibling.dataset.key}"]` : `.idle-timeline-row[data-occurrence="${sibling.dataset.occurrence}"]`;
    });
    await act(side, 'select first child', () => click(side, 'body', childSelector));
    await act(side, 'minimize with selected child', () => click(side));
  }
  await caption('Matched group · minimized after selecting a child');
  await capture('provider-selected-child-minimized');
  group = human;
  await cycle('human', false);
  results.endSequence = (await journal()).at(-1)?.sequence ?? results.startSequence;
  const errors = (await journal()).filter(e => e.sequence > results.startSequence && e.kind === 'error');
  assert.deepEqual(errors, [], 'The comparison has no bridge or renderer errors.');
  assert.deepEqual(results.errors, []);
  results.result = 'PASS';
  console.log('PASS: provider and human groups reveal and minimize; target, keyboard, selection and scroll results captured.');
} catch (error) {
  results.result = 'FAIL'; results.error = String(error);
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await recorder?.stop();
  await writeFile(join(output, 'summary.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
