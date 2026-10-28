'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

exports.prepare = async (home, checkout, chain) => {
  for (const name of ['IDLE_CODEX_AUTH_SOURCE', 'IDLE_CODEX_RUNNER_CONFIG']) {
    assert.ok(path.isAbsolute(process.env[name] ?? ''), `${name} must name a private test input`);
  }
  await fs.copyFile(process.env.IDLE_CODEX_AUTH_SOURCE, path.join(home, 'auth.json'));
  await fs.chmod(path.join(home, 'auth.json'), 0o600);
  await fs.copyFile(process.env.IDLE_CODEX_RUNNER_CONFIG, path.join(home, 'config.toml'));
  const marker = `runner-${crypto.randomUUID()}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const denied = path.join(chain, 'private-runner-check.txt');
  await fs.writeFile(denied, secret, { mode: 0o600 });
  await fs.symlink(denied, path.join(checkout, 'outside-symlink'));
  let connections = 0;
  const network = net.createServer(socket => { connections++; socket.end('reachable'); });
  await new Promise((resolve, reject) => {
    network.once('error', reject);
    network.listen(0, '127.0.0.1', resolve);
  });
  const port = network.address().port;
  await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port });
    client.once('error', reject);
    client.once('data', () => { client.destroy(); resolve(); });
  });
  const baselineConnections = connections;
  const script = `import json, os, pathlib, socket, sys, time
marker = sys.argv[1]
started = int(time.time() * 1000)
pathlib.Path('runner-started.json').write_text(json.dumps({'marker': marker, 'at': started}))
time.sleep(45)
denied = pathlib.Path(${JSON.stringify(denied)})
checks = {}
for key, target in [('outsideReadDenied', denied), ('symlinkReadDenied', pathlib.Path('outside-symlink'))]:
    try:
        target.read_bytes()
        checks[key] = False
    except OSError:
        checks[key] = True
try:
    denied.write_text('must not escape the checkout')
    checks['outsideWriteDenied'] = False
except OSError:
    checks['outsideWriteDenied'] = True
try:
    connection = socket.create_connection(('127.0.0.1', ${port}), timeout=2)
    connection.close()
    checks['networkDenied'] = False
except OSError:
    checks['networkDenied'] = True
checks['privateEnvironmentExcluded'] = not any(name in os.environ for name in ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY'])
pathlib.Path('runner-allowed.txt').write_text(marker)
checks['checkoutWriteAllowed'] = pathlib.Path('runner-allowed.txt').read_text() == marker
assert all(checks.values()), json.dumps(checks)
result = {'marker': marker, 'startedAt': started, 'completedAt': int(time.time() * 1000), 'checks': checks}
pathlib.Path('runner-result.json').write_text(json.dumps(result))
print(marker + ':PASS', flush=True)
`;
  await fs.writeFile(path.join(checkout, 'runner-check.py'), script);
  return {
    task: { marker, prompt: `Run exactly this command using exec_command with the default permissions: python3 runner-check.py ${marker}. The script waits 45 seconds while the editor closes, then checks the allowed checkout and denied paths/network. If it returns a session ID, use write_stdin to wait until it exits. Do not modify the script or request additional permissions. Finish by reporting the command's PASS marker.` },
    async verify(results, restored) {
      assert.equal(restored.runnerCompleted, true, 'desktop restored the completed native runner');
      const closed = JSON.parse(await fs.readFile(path.join(results, 'desktop-closed.json'), 'utf8'));
      const result = JSON.parse(await fs.readFile(path.join(checkout, 'runner-result.json'), 'utf8'));
      assert.equal(result.marker, marker);
      assert.equal(Object.keys(result.checks).length, 6);
      assert.ok(Object.values(result.checks).every(value => value === true), 'all native scope checks passed');
      assert.ok(result.startedAt < closed.at && result.completedAt > closed.at, 'the command completed after the desktop process exited');
      assert.equal(await fs.readFile(denied, 'utf8'), secret, 'the denied file is unchanged');
      assert.equal(connections, baselineConnections, 'runner could not reach a listening service');
      console.log('PASS: the existing model completed native sandbox checks after the remote desktop exited.');
    },
    close() { return new Promise(resolve => network.close(resolve)); },
  };
};
