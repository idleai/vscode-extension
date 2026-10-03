//! Folder-bound collection over the host's framed transport.

use std::io;
#[cfg(test)]
use tempfile as _;
use {
    blake3 as _, editchain_core as _, editchain_engine as _, editchain_git as _,
    editchain_store as _, idle_history_import as _, serde as _,
};

fn main() -> io::Result<()> {
    let mut arguments = std::env::args().skip(1);
    let binding = arguments
        .next()
        .ok_or_else(|| io::Error::other("collector binding required"))?;
    if arguments.next().is_some() {
        return Err(io::Error::other("expected one collector binding"));
    }
    let binding = serde_json::from_str(&binding).map_err(io::Error::other)?;
    idle_history_collector::service::serve(io::stdin().lock(), io::stdout().lock(), binding)
}
