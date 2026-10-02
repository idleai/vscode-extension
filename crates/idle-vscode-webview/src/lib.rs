//! VS Code mounting entrypoint for shared history and session components.

pub mod adapters;
pub mod app;
pub mod bridge;
#[cfg(target_arch = "wasm32")]
mod connection;

/// Mount the shared component after the WASM module loads.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    dioxus_web::launch::launch(app::App, Vec::new(), Vec::new());
}
