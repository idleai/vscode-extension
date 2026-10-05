import { copyNative } from './copy-native.mjs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import artifacts from './native-artifacts.cjs';

await copyNative('host-tools', ['idle-host']);
await copyNative('codex-exporter', ['codex-session-exporter']);
await mkdir(path.join(artifacts.root, 'dist'), { recursive: true });
await copyFile(process.env.IDLE_RELEASE_INPUTS || path.join(artifacts.root, 'target', 'released-dependencies.json'),
  path.join(artifacts.root, 'dist', 'released-dependencies.json'));
