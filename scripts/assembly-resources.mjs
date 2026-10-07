import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkResources(browser, origin, errors, workspace, host) {
  console.log('Checking declared and published resources');
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${origin}/?kind=detail`);
  await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
  const workspaceId = await page.$eval('select[id$=-workspace] option[value^="local-workspace:"]', option => option.value);
  await page.select('select[id$=-workspace]', workspaceId);
  const directory = join(workspace, '.idle', 'workspace');
  await writeFile(join(directory, 'hosts.json'), JSON.stringify({ hosts: [{ id: 'browser-host', name: 'Configured browser host' }] }));
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ providers: [{ id: 'browser-provider', name: 'Configured browser models', host_id: 'browser-host' }] }));
  const declaredHost = await row(page, 'Compute hosts', 'Configured browser host', 'Availability unknown');
  const declaredProvider = await row(page, 'Model providers', 'Configured browser models', 'Availability unknown');
  const contributor = await host.coordination.contributor();
  // Use the packaged native channel as an authenticated publisher. The renderer
  // still has no resource-registration or runtime-execution capability.
  const client = await host.coordination.clients.get(workspaceId).acquire(true);
  const now = Date.now();
  const health = { availability: 'available', observed_at: String(now), valid_until: String(now + 300_000) };
  const compute = { id: 'browser-host', name: 'Published browser host', owner: contributor, capabilities: [], health, routes: [] };
  const models = { id: 'browser-provider', name: 'Published browser models', owner: contributor,
    kind: { kind: 'local', host_id: 'browser-host', runtime_id: 'browser-runtime' }, health, routes: [] };
  await publish(client, workspaceId, contributor, 'host', compute);
  await publish(client, workspaceId, contributor, 'provider', models);
  const liveHost = await row(page, 'Compute hosts', compute.name, 'Available');
  const liveProvider = await row(page, 'Model providers', models.name, 'Available');
  assert.ok(BigInt(liveHost) > BigInt(declaredHost), 'the live host advances its declaration revision');
  assert.ok(BigInt(liveProvider) > BigInt(declaredProvider), 'the live provider advances its declaration revision');
  const snapshot = JSON.parse(await client.request('{"kind":"snapshot"}')).result.Ok;
  const current = snapshot.hosts.find(record => record.value.id === compute.id);
  compute.name = 'Updated browser host';
  await publish(client, workspaceId, contributor, 'host', compute, current.revision);
  const updated = await row(page, 'Compute hosts', compute.name, 'Available');
  assert.ok(BigInt(updated) > BigInt(liveHost), 'native snapshot revisions remain conditional-write tokens');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.idle-resource-card button')].find(button => button.textContent === 'Connect').disabled), true,
    'published health does not create an execution provider');
  await page.close();
}

async function publish(client, workspace, contributor, kind, value, revision) {
  const response = JSON.parse(await client.request(JSON.stringify({ kind: 'mutate', data: {
    api_version: '1', control_fence: null,
    context: { workspace_id: workspace, request_id: `browser-${kind}-${revision ?? 'first'}`,
      contributor: { contributor_id: contributor, authenticated_as: { issuer: 'idle-vscode-local', subject: contributor.slice('local-contributor:'.length) } },
      expires_at: String(Date.now() + 60_000) },
    body: { kind, data: { expected: revision ? { kind: 'revision', value: revision } : { kind: 'absent' }, value } },
  } })));
  assert.equal(response.result?.Ok?.result?.status, 'success', JSON.stringify(response));
}

async function row(page, section, name, availability) {
  await click(page, section);
  await page.waitForSelector('.idle-resources');
  await click(page, 'Refresh resources');
  await page.waitForFunction(({ name, availability }) => [...document.querySelectorAll('article.idle-resource-card')]
    .some(card => card.getAttribute('aria-label') === name && card.textContent.includes(availability)), {}, { name, availability });
  assert.equal(await page.$$eval('article.idle-resource-card', cards => cards.length), 1, 'publication replaces its declaration');
  return page.$eval('article.idle-resource-card', card => card.textContent.match(/Revision (\d+)/)[1]);
}

async function click(page, label) {
  await page.bringToFront();
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === label && !button.disabled), {}, label);
  await page.evaluate(label => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label).click(), label);
}
