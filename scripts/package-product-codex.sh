#!/usr/bin/env bash
set -euo pipefail

for variant in codex codex-app-server; do
  variant_args=()
  entry_directory=cli
  if [[ "$variant" == codex-app-server ]]; then
    variant_args+=(--variant codex-app-server)
    entry_directory=app-server
  fi
  python3 scripts/build_codex_package.py --target x86_64-unknown-linux-gnu "${variant_args[@]}" \
    --strip all \
    --entrypoint-bin "bazel-bin/codex-rs/$entry_directory/$variant" \
    --code-mode-host-bin bazel-bin/codex-rs/code-mode-host/codex-code-mode-host \
    --bwrap-bin bazel-bin/codex-rs/bwrap/bwrap \
    --package-dir "$RUNNER_TEMP/product-$variant-package" \
    --archive-output "product-output/$variant-package-x86_64-unknown-linux-gnu.tar.gz" --force
done
python3 - <<'PY'
import hashlib, json, pathlib, subprocess
root = pathlib.Path('product-output')
document = {'schema': 1, 'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
            'archives': {path.name: hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
                         for path in sorted(root.glob('*.tar.gz'))}}
(root / 'codex-result.json').write_text(json.dumps(document, indent=2) + '\n')
PY
