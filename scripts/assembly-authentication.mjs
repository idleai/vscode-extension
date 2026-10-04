import assert from 'node:assert/strict';

// Real packaged host, renderer and repository reader; only the VS Code account
// provider is controlled. No browser login or personal credential is used here.
export async function checkAuthentication(browser, origin, fixture, host, errors, failures) {
  const previous = fixture.api.authentication.getSession;
  const pages = [];
  const secret = 'ASSEMBLY-AUTH-TOKEN-NEVER-IN-WEBVIEW';
  const session = scopes => ({ id: 'approved-session', account: { id: 'approved', label: 'Approved account' }, scopes, accessToken: secret });
  const repositoryScopes = ['repo', 'read:user', 'read:org'];
  const vscodeScopes = ['repo', 'workflow', 'user:email', 'read:user'];
  const sameScopes = (left, right) => [...left].sort().join(' ') === [...right].sort().join(' ');
  let state = 'existing';
  let cancelled = false;
  let finish;
  let interactive = 0;
  let passed = false;
  let broadcasts = Promise.resolve();
  const failureStart = failures.length;
  const subscription = host.onDidChangeContext(() => {
    broadcasts = broadcasts.then(() => Promise.all(pages.map(page => page.evaluate(() => {
      const { protocol, session } = window.assemblyFixture.requests[0];
      window.dispatchEvent(new MessageEvent('message', { data: { protocol, session, event: 'host.configurationChanged', params: {} } }));
    }))));
  });
  fixture.api.authentication.getSession = async (_provider, scopes, options) => {
    if (options.silent) {
      if (state === 'existing' && sameScopes(scopes, vscodeScopes)) return session(vscodeScopes);
      if (state === 'approved' && sameScopes(scopes, repositoryScopes)) return session(repositoryScopes);
      return undefined;
    }
    interactive++;
    if (cancelled) throw new Error('Cancelled');
    fixture.events.authentication.fire({ provider: { id: 'github' } });
    await new Promise(resolve => { finish = resolve; });
    state = 'approved';
    return session(repositoryScopes);
  };
  try {
    const selections = [];
    for (const kind of ['sidebar', 'detail']) {
      const page = await browser.newPage();
      pages.push(page);
      page.on('pageerror', error => errors.push(String(error)));
      await page.setViewport({ width: kind === 'sidebar' ? 360 : 1200, height: 900 });
      await page.goto(`${origin}/?kind=${kind}`);
      await page.waitForSelector('select[id$=-workspace] option[value^="local-workspace:"]');
      const selected = await page.$$eval('select[id$=-workspace] option[value^="local-workspace:"]', (options, index) => options[index].value, pages.length - 1);
      selections.push(selected);
      await page.select('select[id$=-workspace]', selected);
      await account(page, 'Approved account');
    }
    await connect(pages[0]);
    await pages[0].waitForFunction(() => window.assemblyFixture.responses.some(({ request }) => request.params?.operation?.action === 'SignIn'));
    assert.equal(interactive, 0, 'an existing VS Code GitHub account is reused without another browser flow');
    assert(await pages[0].evaluate(() => window.assemblyFixture.timeouts.some(delay => delay >= 300_000)), 'interactive sign-in allows time for the provider browser/device flow');

    state = 'none';
    fixture.events.authentication.fire({ provider: { id: 'github' } });
    await broadcasts;
    for (const page of pages) await account(page, 'No account connected');
    await connect(pages[0]);
    await until(() => finish !== undefined);
    await broadcasts;
    for (const page of pages) await account(page, 'No account connected');
    await connect(pages[1]);
    await pages[1].waitForFunction(() => window.assemblyFixture.requests.some(request => request.params?.operation?.action === 'SignIn'));
    assert.equal(interactive, 1, 'recreated views share the pending account approval');
    finish();
    for (const page of pages) await account(page, 'Approved account');
    assert.equal(interactive, 1, 'both sign-in requests finish from the same provider approval');
    for (const [index, page] of pages.entries()) {
      assert.equal(await page.$eval('select[id$=-workspace]', select => select.value), selections[index], 'each view reconnects its own repository after approval');
      assert(!await page.evaluate(token => JSON.stringify(window.assemblyFixture).includes(token), secret), 'the token never enters webview messages');
    }

    state = 'none';
    cancelled = true;
    fixture.events.authentication.fire({ provider: { id: 'github' } });
    await broadcasts;
    for (const page of pages) await account(page, 'No account connected');
    await connect(pages[0]);
    await pages[0].waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(element => element.textContent.includes('GitHub sign-in was cancelled')));
    assert.equal(await pages[0].$eval('button[aria-busy="true"]', () => true).catch(() => false), false, 'cancellation leaves no busy sign-in control');
    cancelled = false;
    finish = undefined;
    await connect(pages[0]);
    await until(() => finish !== undefined);
    await broadcasts;
    finish();
    for (const page of pages) await account(page, 'Approved account');
    assert(failures.slice(failureStart).every(error => ['cancelled', 'account_changed', 'authentication_cancelled'].includes(error.code)), 'only retired reads and the deliberate cancellation may fail');
    passed = true;
  } finally {
    subscription.dispose();
    fixture.api.authentication.getSession = previous;
    finish?.();
    await broadcasts;
    if (passed) for (const page of pages) await page.close();
  }
}

async function account(page, label) {
  await page.bringToFront();
  await page.waitForFunction(label => document.querySelector('[aria-label="Repository workspace"]')?.textContent.includes(`GitHub account: ${label}`), {}, label);
}

async function connect(page) {
  await page.bringToFront();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Connect GitHub repository access' && !button.disabled));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect GitHub repository access' && !button.disabled).click());
}

async function until(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('GitHub account approval did not start.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
