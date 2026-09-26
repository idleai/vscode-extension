//! VS Code webview mounting entrypoint. Only the scaffold view is wired.

pub mod adapters;
pub mod app;

/// Mount the shared component after the WASM module loads.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    dioxus_web::launch::launch(app::App, Vec::new(), Vec::new());
}
