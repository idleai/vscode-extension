# Rust quality policy

Before declaring a code task complete, run `./scripts/lint.sh` and report its
exact result. Run `./scripts/check.sh` when build or packaging behavior changes.
CI uses the same lint entrypoint through `scripts/check.sh`.

All Cargo packages must inherit the root workspace's Rust, Clippy and Rustdoc
lint tables. Keep `clippy.toml`, `deny.toml`, local checks and CI in sync.

Unless the task explicitly authorizes policy work, do not weaken or remove a
lint, change thresholds or quality baselines, skip a quality check, add a
coverage/dependency exclusion, add `#[allow(...)]` or crate-wide allowances,
ignore a failing test, or delete a test merely to pass a gate.

Necessary suppressions must use narrowly scoped `#[expect(..., reason = "...")]`
and be called out in the final report. New code must satisfy the existing limits.
