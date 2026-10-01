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
    resolve_effects(&core, core.process_event(Event::Start))?;
    Ok(core.view())
}

fn resolve_effects(core: &Core, mut effects: Vec<Effect>) -> Result<(), String> {
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
            Effect::Workspace(mut request) => {
                effects.extend(
                    core.resolve(
                        request.as_mut(),
                        Err(app_core::workspace::WorkspaceError {
                            kind: app_core::workspace::WorkspaceErrorKind::Unavailable,
                            message: "Workspace adapter is not connected.".to_owned(),
                        }),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            Effect::Subscription(mut request) => {
                effects.extend(
                    core.resolve(
                        request.as_mut(),
                        Err(app_core::subscriptions::SubscriptionError {
                            kind: app_core::subscriptions::SubscriptionErrorKind::Unavailable,
                            message: "Subscription adapter is not connected.".to_owned(),
                        }),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            Effect::History(mut request) => {
                effects.extend(
                    core.resolve(
                        request.as_mut(),
                        Err(app_core::module::EffectError {
                            message: "History adapter is not connected.".to_owned(),
                        }),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            Effect::Session(mut request) => {
                effects.extend(
                    core.resolve(
                        request.as_mut(),
                        Err(app_core::sessions::SessionError {
                            code: app_core::sessions::SessionErrorCode::Unavailable,
                            message: "Session adapter is not connected.".to_owned(),
                            retry: app_core::sessions::SessionRetryAdvice::Never,
                        }),
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_requests_resolve_as_unavailable_without_a_connected_adapter() {
        use app_core::sessions::{
            SessionContext, SessionError, SessionErrorCode, SessionLoadState, SessionRetryAdvice,
        };
        use app_core::workspace::WorkspaceMode;

        for mode in [WorkspaceMode::Standalone, WorkspaceMode::Managed] {
            let core = app_core::Core::new();
            let context = SessionContext {
                provider: "provider".to_owned(),
                workspace_id: "workspace".to_owned(),
                contributor_id: "contributor".to_owned(),
                chain: "chain".to_owned(),
                mode,
            };
            let effects = core.process_event(app_core::Event::Sessions(
                app_core::sessions::Event::Connect(context.clone()),
            ));
            assert!(
                effects
                    .iter()
                    .any(|effect| matches!(effect, app_core::Effect::Session(_))),
                "connecting sessions must request the host adapter"
            );
            super::resolve_effects(&core, effects).expect("resolve session operation");
            let view = core.view().sessions;
            assert_eq!(
                view.context,
                Some(context),
                "the failure retains its selected context"
            );
            assert_eq!(
                view.load,
                SessionLoadState::Failed(SessionError {
                    code: SessionErrorCode::Unavailable,
                    message: "Session adapter is not connected.".to_owned(),
                    retry: SessionRetryAdvice::Never,
                }),
                "an absent adapter must finish the request with an explicit failure"
            );
            assert!(
                view.sessions.is_empty(),
                "an absent adapter cannot fabricate sessions"
            );
        }
    }

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
