//! Minimal host composition; domain reducers remain in app-core.

use app_core::{Core, Effect, Event};
use dioxus::prelude::*;
use web_ui::Scaffold;

/// Render the extension webview's initial application view.
#[component]
pub fn App() -> Element {
    let view = use_hook(|| {
        let core = Core::new();
        for effect in core.process_event(Event::Start) {
            match effect {
                Effect::Render(_) => {}
            }
        }
        core.view()
    });
    rsx! { Scaffold { view } }
}
