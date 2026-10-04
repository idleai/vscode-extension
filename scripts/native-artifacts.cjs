const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
function artifact(name, ...parts) {
  return path.join(root, '.artifacts', name, ...parts);
}
function binary(owner, name) {
  return artifact(owner, 'bin', name + suffix);
}
function install(...names) {
  execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'install-artifacts.py'), ...names],
    { cwd: root, stdio: 'inherit' });
}

module.exports = { root, artifact, binary, install };
