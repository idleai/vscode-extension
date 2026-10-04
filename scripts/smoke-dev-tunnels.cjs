'use strict';

// The shared native probe owns cloud creation, reconnect and durable cleanup.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const binary = path.resolve('bin', `${process.platform}-${process.arch}`,
  `idle-coordination${process.platform === 'win32' ? '.exe' : ''}`);
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
  [require('./native-artifacts.cjs').artifact('host-tools', 'scripts', 'smoke-tunnels.py'), '--binary', binary, ...process.argv.slice(2)],
  { stdio: 'inherit' });
if (result.error) throw new Error('Cannot start the native relay probe.');
process.exitCode = result.status ?? 1;
