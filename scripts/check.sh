#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/lint.sh
cargo build --workspace --locked
npm test
npm run package
node scripts/smoke-package.cjs idle.vsix
