'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const minute = 60_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Observe real credential reads without retaining or printing their contents. */
async function createSoak(directory, github) {
  const audit = path.join(directory, 'credential-reads.jsonl');
  const credentialProgram = path.join(directory, 'github-audit.cjs');
  await fs.writeFile(audit, '', { mode: 0o600 });
  await fs.writeFile(credentialProgram, `#!${process.execPath}
'use strict';
require('node:fs').appendFileSync(${JSON.stringify(audit)}, String(Date.now()) + '\\n');
const child = require('node:child_process').spawnSync(${JSON.stringify(github)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o700 });
  const reads = async () => (await fs.readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
  return {
    credentialProgram,
    async run({ grant, runtime, coordination, config, binding, until }) {
      const started = Date.now();
      const initial = await runtime.snapshot(config, binding);
      const verifyConnected = async description => {
        const deadline = Date.now() + 90_000;
        await until(async () => {
          if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
          const current = await runtime.snapshot(config, binding);
          if (!current?.connected) return false;
          assert.equal(current.status.hostId, initial.status.hostId);
          assert.equal(current.status.runtimeId, initial.status.runtimeId);
          try { await coordination.verify(); return true; }
          catch (error) {
            if (!['unavailable', 'host_timeout'].includes(error.code)) throw error;
            console.log('SOAK: relay stream changed; waiting for automatic reconnect before checking saved state');
            return false;
          }
        }, description);
      };
      assert.ok(grant.expiresAt > started + 50 * minute, 'soak needs a fresh one-hour grant');
      coordination.reset();
      await runtime.reset();
      console.log('SOAK: client disconnected for eleven minutes across a real relay renewal');
      await pause(11 * minute);
      assert.ok((await reads()).some(time => time > started + 9 * minute),
        'daemon must reacquire its management credential while the client is closed');
      await verifyConnected('reconnect after unattended credential renewal');
      console.log('PASS: unattended relay renewal and reconnect retain the coordinator');

      let reported = 1;
      while (Date.now() < grant.expiresAt - 90_000) {
        await verifyConnected('connection across recurring relay renewal');
        const elapsed = Math.floor((Date.now() - started) / (10 * minute));
        if (elapsed > reported) {
          reported = elapsed;
          console.log(`PASS: ${elapsed * 10} minutes; same daemon, coordinator and recorded state`);
        }
        await pause(Math.min(minute, Math.max(0, grant.expiresAt - 90_000 - Date.now())));
      }
      const windows = new Set((await reads()).filter(time => time > started + 9 * minute)
        .map(time => Math.floor((time - started) / (10 * minute))));
      assert.ok(windows.size >= 4, 'soak must observe credential reads across at least four renewal windows');
      await pause(Math.max(0, Math.max(grant.expiresAt, grant.relay.expiresAt) + 1_000 - Date.now()));
      await coordination.verifyDenied();
      await runtime.reset();
      const expired = await runtime.snapshot(config, binding);
      assert.ok(expired && !expired.connected, 'expired invitation must retain an unavailable host row');
      await coordination.verifyDenied();
      console.log('PASS: actual invitation expiry denies the open connection and reconnect without local fallback');
    },
  };
}

module.exports = { createSoak };
