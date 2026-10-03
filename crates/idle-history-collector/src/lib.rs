//! Host-owned imports and notifications, independent of any viewer or runtime fork.

mod collection;
mod git_links;
mod monitor;
pub mod service;
#[cfg(test)]
mod tests;

use std::{io, path::PathBuf};

use idle_history_import::codex::live::LiveCodex;
use serde::{Deserialize, Serialize};

/// Paths installed by the trusted host when its collector process starts.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    /// The explicit file-owning workspace folder.
    pub workspace: PathBuf,
    /// One bound chain, independent of the source discovery root.
    pub chain: PathBuf,
    /// Codex rollout discovery root; required only when collection is enabled.
    pub sessions: PathBuf,
    /// Configured or packaged exporter executable, never a workspace build guess.
    pub helper: PathBuf,
}

/// One bounded polling pass. Empty paths still observe external writes and blobs.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Poll {
    /// Changed rollout paths under the installed discovery root.
    pub paths: Vec<PathBuf>,
    /// Revisit unresolved commit relationships after Git references change.
    #[serde(default)]
    pub git_changed: bool,
}

/// Durable results from a collector pass; no cursor claims or content cross IPC.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Update {
    /// The host should reconcile any visible history for this chain.
    pub changed: bool,
    /// More bounded source work remains even if file metadata is unchanged.
    pub pending: bool,
    /// Newly retained operation variants, including conflicting variants.
    pub written: usize,
    /// Exact already-retained variants encountered during replay.
    pub duplicates: usize,
    /// Newly retained conflicting variants.
    pub conflicts: usize,
    /// Source bytes read during this pass.
    pub source_bytes: u64,
}

/// A collector lives for one installed folder binding, independently of views.
#[derive(Debug)]
pub struct Collector {
    binding: Binding,
    provider: Option<LiveCodex>,
    monitor: monitor::Monitor,
}

impl Collector {
    /// Validate the installation without starting an exporter or creating a chain.
    ///
    /// # Errors
    /// Returns invalid path bindings or unreadable existing history.
    pub fn new(binding: Binding) -> io::Result<Self> {
        if [
            &binding.workspace,
            &binding.chain,
            &binding.sessions,
            &binding.helper,
        ]
        .iter()
        .any(|path| !path.is_absolute())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "collector bindings require absolute paths",
            ));
        }
        let monitor = monitor::Monitor::new(&binding.chain)?;
        Ok(Self {
            binding,
            provider: None,
            monitor,
        })
    }

    /// Import a bounded source batch, then observe committed chain changes.
    /// Failed writes discard speculative provider state before a retry.
    ///
    /// # Errors
    /// Returns source, helper, migration, writer or history-read failures.
    pub fn poll(&mut self, request: &Poll) -> io::Result<Update> {
        let mut result = if request.paths.is_empty() {
            Update::default()
        } else {
            match self.collect(&request.paths) {
                Ok(result) => result,
                Err(error) => {
                    if let Some(provider) = &mut self.provider {
                        provider.invalidate();
                    }
                    return Err(error);
                }
            }
        };
        if request.git_changed && self.binding.chain.is_dir() {
            result.written = result.written.saturating_add(self.reconcile()?);
        }
        result.changed = self.monitor.poll(&self.binding.chain)? || result.written > 0;
        Ok(result)
    }
}
