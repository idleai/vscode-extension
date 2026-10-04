//! Export assets from the exact package versions selected by Cargo.

use std::io::{self, Write};

use crux_core as _;
use dioxus as _;
use editchain_core as _;
use idle_protocol as _;
use idle_vscode_webview as _;
use serde as _;
use serde_json as _;

fn main() -> io::Result<()> {
    let asset = match std::env::args().nth(1).as_deref() {
        Some("styles") => web_ui::assets::STYLESHEET,
        Some("peer-view") => app_core::fixtures::PEER_VIEW,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected styles or peer-view",
            ));
        }
    };
    io::stdout().lock().write_all(asset.as_bytes())
}
