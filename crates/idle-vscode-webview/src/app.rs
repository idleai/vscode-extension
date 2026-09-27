//! Minimal host composition; domain reducers remain in app-core.

use app_core::{Core, Effect, Event, ViewModel, effects::HostInfo};
use dioxus::prelude::*;
use web_ui::Scaffold;

/// Render the extension webview's initial application view.
#[component]
pub fn App() -> Element {
    let view = use_hook(initial_view);
    match view {
        Ok(view) => rsx! { Scaffold { view } },
        Err(_error) => rsx! { p { role: "alert", "Unable to start Idle." } },
    }
}

fn initial_view() -> Result<ViewModel, String> {
    let core = Core::new();
    let mut effects = core.process_event(Event::Start);
    while let Some(effect) = effects.pop() {
        match effect {
            Effect::Render(_) => {}
            Effect::HostInfo(mut request) => {
                let info = HostInfo {
                    name: "Idle VS Code".to_owned(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                };
                effects.extend(
                    core.resolve(&mut request, Ok(info))
                        .map_err(|error| error.to_string())?,
                );
            }
        }
    }
    Ok(core.view())
}

#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_resolves_host_information() {
        let view = super::initial_view();
        assert!(
            view.as_ref().is_ok_and(|view| view.initialized),
            "the shared core must initialize"
        );
        assert_eq!(
            view.map(|view| view.bootstrap),
            Ok(app_core::module::LoadState::Ready(
                app_core::effects::HostInfo {
                    name: "Idle VS Code".to_owned(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                }
            )),
            "the shell must resolve the shared core's host information request"
        );
    }
}
