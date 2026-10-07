//! Rust application state for native VS Code trees and custom webview content.

pub mod adapters;
pub mod app;
pub mod bridge;
#[cfg(target_arch = "wasm32")]
mod connection;
mod coordination;
mod destinations;
pub mod native;
mod trees;

/// Mount the shared component after the WASM module loads.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn start() {
    dioxus_web::launch::launch(app::App, Vec::new(), Vec::new());
}
