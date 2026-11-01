import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const origin = process.argv[2] ?? 'http://127.0.0.1:4173';
const output = resolve(process.argv[3] ?? 'outputs/activity-compare/same-rows');
const identitiesPath = resolve(process.argv[4] ?? join(output, 'identity-map.json'));
const identities = JSON.parse(await readFile(identitiesPath, 'utf8'));
const manifest = await (await fetch(`${origin}/api/manifest`)).json();
assert.equal(identities.inputDigest, manifest.input.digest, 'The record map belongs to this frozen input.');
assert(process.env.CHROME_BIN, 'Set CHROME_BIN to the Chromium executable.');
await mkdir(output, { recursive: true });
const sides = ['legacy', 'current'];
const pause = ms => new Promise(done => setTimeout(done, ms));
async function journal() {
  const text = await readFile(join(manifest.runDirectory, 'events.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.slice(0, text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const results = { manifest, identitiesPath, started: new Date().toISOString(), startSequence: (await journal()).at(-1)?.sequence ?? 0, cases: [], errors: [] };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
const page = await browser.newPage();
await page.setViewport({ width: 2532, height: 1500, deviceScaleFactor: 1 });
await page.emulateTimezone('America/Los_Angeles');
page.on('pageerror', error => results.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') results.errors.push(message.text()); });
let frames;
let sessions;
const native = { legacy: new Map(), current: new Map() };
let currentWindow;
let legacyWindow;
const rowSelector = (side, key) => side === 'legacy' ? `#rows .row[data-key="${key}"]` : `.idle-timeline-row[data-occurrence="${key}"]`;
const viewportSelector = side => side === 'legacy' ? '#rows' : '.idle-timeline-viewport';
const disclosureSelector = side => side === 'legacy' ? '.task-chevron' : '.idle-timeline-disclosure';

async function settled() {
  await frames.legacy.waitForFunction(() => window.__activityCompareLegacy.pending === 0);
  const deadline = Date.now() + 30_000;
  while (true) {
    const entries = await journal();
    const currentEntries = entries.filter(e => e.side === 'current' && e.message?.session === sessions.current);
    const replies = new Set(currentEntries.filter(e => e.kind === 'host.reply').map(e => e.message.id));
    const pending = currentEntries.some(e => e.kind === 'host.request' && e.message.method === 'app.history' && !replies.has(e.message.id));
    if (!pending) {
      for (const e of entries) {
        if (e.side === 'legacy' && e.session === sessions.legacy) {
          const value = e.response?.body?.Ok;
          if (value?.rows && value.total !== undefined) legacyWindow = value;
          for (const row of value?.rows ?? []) if (row.content) native.legacy.set(row.content.node_key, row.content);
        }
        if (e.side === 'current' && e.message?.session === sessions.current) {
          const value = e.message?.result?.Ok?.Timeline?.Window;
          if (value) {
            currentWindow = value;
            for (const row of value.rows) native.current.set(row.occurrence, row);
          }
        }
      }
      break;
    }
    assert(Date.now() < deadline, 'Native history requests settle.');
    await pause(50);
  }
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

function physicalMatch(old, current) {
  const candidates = identities.rows[old.node_key]?.operations ?? [];
  const operations = [...(current.records ?? []).map(record => record.record.operation), current.address?.Record?.record.operation].filter(Boolean);
  return candidates.filter(id => operations.includes(id));
}

function matchGroup(predicate) {
  const index = currentWindow.rows.findIndex(row => row.group?.header && predicate(row));
  assert(index >= 0, 'The input contains the requested group.');
  const current = currentWindow.rows[index];
  const candidates = [...native.legacy.values()].filter(old => old.timestamp_ms === current.timestamp && physicalMatch(old, current).length > 0);
  assert.equal(candidates.length, 1, 'The group maps to exactly one old record.');
  return { legacy: candidates[0].node_key, current: current.occurrence, count: current.group.count, index };
}

async function position(group) {
  await page.evaluate(() => {
    document.getElementById('matched-row-alignment')?.remove();
    for (const side of ['legacy', 'current']) {
      const frame = document.getElementById(side);
      frame.style.transform = 'none';
      frame.parentElement.style.height = '1402px';
    }
    document.querySelectorAll('.row-index').forEach(node => node.remove());
  });
  for (const side of sides) {
    await frames[side].$eval(viewportSelector(side), (node, index) => { node.scrollTop = Math.max(0, index - 3) * 34; }, group.index);
    await frames[side].waitForSelector(rowSelector(side, group[side]));
    await frames[side].evaluate(({ viewport, row }) => {
      const node = document.querySelector(viewport);
      node.scrollTop += document.querySelector(row).getBoundingClientRect().top - node.getBoundingClientRect().top - 3 * 34;
    }, { viewport: viewportSelector(side), row: rowSelector(side, group[side]) });
  }
  await settled();
}

async function expand(group, expanded) {
  for (const side of sides) {
    const selector = `${rowSelector(side, group[side])} ${disclosureSelector(side)}`;
    if (await frames[side].$eval(selector, node => node.getAttribute('aria-expanded')) === String(expanded)) continue;
    const point = await frames[side].$eval(selector, node => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, height: innerHeight };
    });
    const outer = await (await frames[side].frameElement()).boundingBox();
    await page.mouse.click(outer.x + point.x * outer.width / point.width, outer.y + point.y * outer.height / point.height);
    await frames[side].waitForSelector(`${selector}[aria-expanded="${expanded}"]`);
    await settled();
  }
  await page.mouse.move(2500, 10);
}

async function capture(name, title, group, before, count) {
  await position(group);
  await settled();
  const views = {};
  for (const side of sides) {
    views[side] = await frames[side].evaluate(({ key, side, before, count }) => {
      if (side === 'current') {
        for (const row of document.querySelectorAll('.idle-timeline-row[data-file="true"]')) {
          if (!row.querySelector('.idle-timeline-file-name')?.textContent.trim()) throw new Error(`Actionable file ${row.dataset.occurrence} must display its recorded filename.`);
        }
      }
      const snapshot = window.activityCompare.snapshot();
      const index = snapshot.rows.findIndex(row => (side === 'legacy' ? row.data.key : row.data.occurrence) === key);
      if (index < before) throw new Error('The requested context rows are not mounted.');
      const rows = snapshot.rows.slice(index - before, index - before + count);
      return { ...snapshot, matchedRows: rows };
    }, { key: group[side], side, before, count });
    assert.equal(views[side].matchedRows.length, count);
    const rows = views[side].matchedRows;
    for (let i = 0; i < rows.length; i += 1) {
      assert(rows[i].visible, `${side} captured row ${i + 1} at ${rows[i].bounds.y}px is inside the native viewport (${JSON.stringify(views[side].scroll)}).`);
      assert.equal(rows[i].bounds.height, 34, 'Both renderers retain their natural 34px row height.');
      if (i) assert.equal(rows[i].bounds.y - rows[i - 1].bounds.y, 34, 'Captured rows are consecutive.');
    }
  }
  const pairs = views.legacy.matchedRows.map((row, index) => {
    const old = native.legacy.get(row.data.key);
    const current = native.current.get(views.current.matchedRows[index].data.occurrence);
    assert(old && current, 'Each DOM row has a recorded native row.');
    const commonOperations = physicalMatch(old, current);
    const commitOid = current.address?.Commit?.oid;
    const sameCommit = commitOid && old.git_oid === commitOid;
    assert(commonOperations.length > 0 || sameCommit, `Row ${index + 1} maps exactly: ${old.node_key} / ${current.occurrence}.`);
    assert.equal(old.timestamp_ms, current.timestamp, 'Matched source records have the same timestamp.');
    return { number: index + 1, legacyKey: old.node_key, currentKey: current.occurrence, commonOperations, commitOid,
      timestamp: current.timestamp, oldKind: old.kind, currentKind: current.title,
      oldSummary: old.summary, currentSummary: current.preview, oldLane: old.lane, currentLane: current.graph.lane };
  });
  await page.evaluate(({ title, views, count, group }) => {
    document.querySelector('header strong').textContent = title;
    document.querySelector('header p').textContent = `${count} consecutive matching rows · Each numbered pair is checked against its source record or commit IDs · Original 1200px views, 34px rows`;
    document.querySelectorAll('.row-index').forEach(node => node.remove());
    document.getElementById('matched-row-alignment')?.remove();
    const alignment = document.createElement('style');
    alignment.id = 'matched-row-alignment';
    alignment.textContent = ['legacy', 'current'].map(side => `#${side} { transform: translateY(${-views[side].matchedRows[0].bounds.y}px) !important; }`).join('\n') +
      `\n.frame { height: ${count * 34 + 2}px !important; }`;
    document.head.append(alignment);
    for (const side of ['legacy', 'current']) {
      const frame = document.getElementById(side);
      const section = frame.closest('section');
      const top = frame.parentElement.getBoundingClientRect().top - section.getBoundingClientRect().top + 1;
      for (let i = 0; i < count; i += 1) {
        const label = document.createElement('span');
        label.className = 'row-index';
        label.style.top = `${top + i * 34}px`;
        const key = side === 'legacy' ? views[side].matchedRows[i].data.key : views[side].matchedRows[i].data.occurrence;
        label.textContent = String(i + 1).padStart(2, '0');
        if (key === group[side]) label.classList.add('anchor');
        section.append(label);
      }
    }
  }, { title, views, count, group });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const boxes = await page.evaluate(() => ['legacy', 'current'].map(side => {
    const frame = document.getElementById(side);
    const rect = frame.parentElement.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, width: rect.width,
      labels: [...frame.closest('section').querySelectorAll('.row-index')].map(node => ({ text: node.textContent, top: node.getBoundingClientRect().top })) };
  }));
  assert.equal(boxes[0].top, boxes[1].top, 'The paired rows share the same vertical position.');
  assert.equal(boxes[0].width, boxes[1].width, 'The paired views have equal width.');
  for (const box of boxes) {
    assert.equal(box.labels.length, count);
    for (let i = 0; i < count; i += 1) assert.equal(box.labels[i].top, box.top + 1 + i * 34, 'Row numbers align with the captured rows.');
  }
  for (const side of sides) {
    const frame = await (await frames[side].frameElement()).boundingBox();
    assert.equal(frame.y + views[side].matchedRows[0].bounds.y, boxes[0].top + 1, 'The first matched row starts at the crop edge.');
  }
  const record = { name, title, group, pairs, views, crop: boxes, totalRows: { legacy: legacyWindow.total, current: currentWindow.visible_rows } };
  await writeFile(join(output, `${name}.json`), JSON.stringify(record, null, 2));
  await page.screenshot({ path: join(output, `${name}.png`), clip: { x: 0, y: 0, width: 2532, height: Math.ceil(boxes[0].bottom + 18) } });
  results.cases.push({ name, title, pairs, totalRows: record.totalRows });
  console.log(`${name}: ${count} row pairs match by raw-record IDs; aligned at ${boxes[0].top}px.`);
}

try {
  await page.goto(origin);
  await page.addStyleTag({ content: `
    body { padding-bottom: 16px; } header { padding: 16px; } nav, footer, h2 a { display: none; }
    header strong { font-size: 22px; } header p { margin-bottom: 0; }
    main { grid-template-columns: 1242px 1242px; gap: 16px; padding: 0 16px; }
    section { position: relative; } h2 { margin: 16px 0 10px 40px; font-size: 16px; }
    .frame { margin-left: 40px; width: 1202px; }
    iframe { width: 1200px !important; height: 1400px !important; }
    .row-index { position: absolute; left: 0; width: 32px; height: 34px; display: grid; place-items: center; color: #9ba7b6; font: 13px monospace; }
    .row-index.anchor { color: #ffd166; font-weight: bold; }
  ` });
  await page.waitForFunction(() => ['legacy', 'current'].every(side => {
    const frame = document.getElementById(side);
    return frame.contentWindow.location.href === frame.src && frame.contentDocument.querySelector(side === 'legacy' ? '#rows .row[data-key]' : '.idle-timeline-row');
  }), { timeout: 300_000 });
  frames = Object.fromEntries(await Promise.all(sides.map(async side => [side, await (await page.$(`#${side}`)).contentFrame()])));
  sessions = { legacy: await frames.legacy.evaluate(() => window.__activityCompareLegacy.session), current: await frames.current.$eval('#main', node => node.dataset.hostSession) };
  await settled();
  const provider = matchGroup(row => row.occurrence.startsWith('activity:') && row.group.count > 2);
  const human = matchGroup(row => row.preview.startsWith('Human work') && row.group.count > 1);
  results.groups = { provider, human };
  await position(provider);
  await expand(provider, false);
  await capture('provider-collapsed', 'Same items · provider group collapsed', provider, 2, 8);
  await expand(provider, true);
  await capture('provider-revealed', 'Same items · provider group revealed', provider, 2, 10);
  const firstMember = currentWindow.rows.findIndex(row => row.occurrence === provider.current);
  const groupId = currentWindow.rows[firstMember].group.id;
  const memberPositions = currentWindow.rows.flatMap((row, index) => row.group?.id === groupId ? [index] : []);
  assert.equal(memberPositions.length, provider.count, 'All native group members are loaded.');
  const span = memberPositions.at(-1) - firstMember + 1;
  results.providerMembers = { groupId, count: provider.count, span, interleaved: span - provider.count,
    occurrences: memberPositions.map(index => currentWindow.rows[index].occurrence) };
  await capture('provider-all-members', `Same items · all ${provider.count} provider activities and ${span - provider.count} interleaved rows`, provider, 0, span);
  await position(provider);
  await expand(provider, false);
  await capture('provider-minimized', 'Same items · provider group minimized again', provider, 2, 8);
  await position(human);
  await expand(human, false);
  await capture('human-collapsed', 'Same items · human group collapsed', human, 2, 7);
  await expand(human, true);
  await capture('human-revealed', 'Same items · all 3 human activities revealed', human, 2, 9);
  const after = await journal();
  results.endSequence = after.at(-1)?.sequence ?? results.startSequence;
  assert.deepEqual(after.filter(e => e.sequence > results.startSequence && e.kind === 'error'), []);
  assert.deepEqual(results.errors, []);
  results.result = 'PASS';
  console.log('PASS: all captured pairs match by source records, timestamps, order, and row geometry.');
} catch (error) {
  results.result = 'FAIL'; results.error = String(error);
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await writeFile(join(output, 'summary.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
