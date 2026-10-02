use app_core::{Event, configuration, history, resources, sessions, workspace};
use serde_json::{Value, json};
use web_ui::host::HostCapability;

use super::{Call, Runtime};
use crate::bridge::BridgeError;

fn unavailable() -> BridgeError {
    BridgeError {
        code: "unavailable".to_owned(),
        message: "Adapter unavailable.".to_owned(),
        details: None,
    }
}

fn fail(runtime: &mut Runtime, calls: Vec<Call>) {
    for call in calls {
        assert!(
            runtime
                .receive(&call.id, Err(unavailable()))
                .expect("resolve host failure")
                .is_empty(),
            "failure must complete the operation"
        );
    }
}

fn context(mode: workspace::WorkspaceMode) -> Value {
    json!({ "provider": "provider", "workspace_id": "workspace", "contributor_id": "contributor", "chain": "chain", "mode": mode })
}

#[test]
fn bootstrap_resolves_host_information() {
    let mut runtime = Runtime::default();
    let calls = runtime
        .ready(&json!({"capabilities": ["history.openQuery"]}))
        .expect("start runtime");
    assert!(runtime.view().initialized, "the shared core initializes");
    assert_eq!(
        runtime.view().bootstrap,
        app_core::module::LoadState::Ready(app_core::effects::HostInfo {
            name: "Idle VS Code".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        }),
        "the shell resolves host information"
    );
    assert_eq!(calls.len(), 1, "startup requests the workspace directory");
    assert!(
        runtime.capabilities().supports(HostCapability::OpenRecord),
        "only installed actions are exposed"
    );
}

#[test]
fn configuration_requests_complete_both_editors_without_a_connected_adapter() {
    for mode in [
        workspace::WorkspaceMode::Standalone,
        workspace::WorkspaceMode::Managed,
    ] {
        let mut runtime = Runtime::default();
        let context: configuration::ConfigurationContext =
            serde_json::from_value(context(mode)).expect("configuration context");
        let calls = runtime
            .dispatch(Event::Configuration(configuration::Event::Connect(
                context.clone(),
            )))
            .expect("configuration requests");
        assert_eq!(calls.len(), 2, "both editors request a document");
        fail(&mut runtime, calls);
        let view = runtime.view().configuration;
        assert_eq!(view.context, Some(context), "context remains visible");
        for editor in [view.settings, view.agent_rules] {
            assert!(
                matches!(
                    editor.load,
                    configuration::ConfigurationLoadState::Failed(_)
                ),
                "failed loads complete"
            );
            assert!(
                editor.current.is_none() && editor.actions.is_empty(),
                "no unloaded document can be edited"
            );
        }
    }
}

#[test]
fn resource_requests_resolve_as_unavailable_without_a_connected_adapter() {
    for mode in [
        workspace::WorkspaceMode::Standalone,
        workspace::WorkspaceMode::Managed,
    ] {
        let mut runtime = Runtime::default();
        let context: resources::ResourceContext =
            serde_json::from_value(context(mode)).expect("resource context");
        let calls = runtime
            .dispatch(Event::Resources(resources::Event::Connect(context.clone())))
            .expect("resource request");
        assert!(!calls.is_empty(), "connection requests resources");
        fail(&mut runtime, calls);
        let view = runtime.view().resources;
        assert_eq!(view.context, Some(context), "selected context remains");
        assert!(
            matches!(view.load, resources::ResourceLoadState::Failed(_)),
            "load completes"
        );
        assert_eq!(
            view.capabilities,
            resources::ResourceCapabilities::default(),
            "unavailable adapters enable no capabilities"
        );
    }
}

#[test]
fn session_requests_resolve_as_unavailable_without_a_connected_adapter() {
    for mode in [
        workspace::WorkspaceMode::Standalone,
        workspace::WorkspaceMode::Managed,
    ] {
        let mut runtime = Runtime::default();
        let context: sessions::SessionContext =
            serde_json::from_value(context(mode)).expect("session context");
        let calls = runtime
            .dispatch(Event::Sessions(sessions::Event::Connect(context.clone())))
            .expect("session request");
        assert!(!calls.is_empty(), "connection requests sessions");
        fail(&mut runtime, calls);
        let view = runtime.view().sessions;
        assert_eq!(view.context, Some(context), "selected context remains");
        assert!(
            matches!(view.load, sessions::SessionLoadState::Failed(_)),
            "load completes"
        );
        assert!(view.sessions.is_empty(), "no sessions are fabricated");
    }
}

#[test]
fn old_and_duplicate_replies_cannot_repopulate_a_reset_runtime() {
    let mut runtime = Runtime::default();
    let old = runtime
        .ready(&json!({"capabilities": ["history.openQuery"]}))
        .expect("first start")
        .remove(0);
    let fresh = runtime.ready(&json!({})).expect("new context").remove(0);
    assert_ne!(old.id, fresh.id, "request identities survive context reset");
    let before = runtime.view();
    assert!(
        runtime
            .receive(&old.id, Ok(json!({"Ok": {"Directory": []}})))
            .expect("old reply")
            .is_empty(),
        "old request is retired"
    );
    assert_eq!(runtime.view(), before, "old context cannot update the view");
    assert!(
        !runtime.capabilities().supports(HostCapability::OpenRecord),
        "reset removes capabilities"
    );
    let _calls = runtime
        .receive(&fresh.id, Ok(json!({"Ok": {"Directory": []}})))
        .expect("current reply");
    assert_eq!(
        runtime.view().workspace.directory_state,
        workspace::WorkspaceRequestState::Ready,
        "current reply completes"
    );
    let _calls = runtime
        .receive(&fresh.id, Err(unavailable()))
        .expect("duplicate reply");
    assert_eq!(
        runtime.view().workspace.directory_state,
        workspace::WorkspaceRequestState::Ready,
        "duplicate replies do nothing"
    );
}

#[test]
fn malformed_history_success_completes_as_a_visible_failure() {
    let mut runtime = Runtime::default();
    let call = runtime
        .dispatch(Event::History(history::Event::Connect("chain".to_owned())))
        .expect("connect history")
        .remove(0);
    let _calls = runtime
        .receive(&call.id, Ok(json!({"unexpected": true})))
        .expect("invalid reply");
    assert!(
        matches!(
            runtime.view().history.paging.state,
            history::RequestState::Failed(_)
        ),
        "malformed data cannot strand loading"
    );
}

#[test]
fn both_session_modes_accept_typed_runtime_fixtures_without_inventing_execution() {
    for mode in [
        workspace::WorkspaceMode::Standalone,
        workspace::WorkspaceMode::Managed,
    ] {
        let snapshot =
            sessions::scripted::demo_snapshot(mode, "contributor-alice").expect("runtime fixture");
        let mut runtime = Runtime::default();
        let call = runtime
            .dispatch(Event::Sessions(sessions::Event::Connect(
                snapshot.context.clone(),
            )))
            .expect("connect session adapter")
            .remove(0);
        let result: sessions::SessionOutput =
            Ok(sessions::SessionResult::Snapshot(Box::new(snapshot)));
        let _calls = runtime
            .receive(
                &call.id,
                Ok(serde_json::to_value(result).expect("typed result")),
            )
            .expect("resolve fixture");
        assert_eq!(
            runtime.view().sessions.load,
            sessions::SessionLoadState::Ready,
            "the fixture completes the directory"
        );
        let _calls = runtime
            .dispatch(Event::Sessions(sessions::Event::Select(Some(
                "session-shared".to_owned(),
            ))))
            .expect("select fixture session");
        assert_eq!(
            runtime.view().sessions.selected.as_deref(),
            Some("session-shared"),
            "user selection reaches the persistent core"
        );
        assert!(
            runtime
                .view()
                .sessions
                .prompts
                .iter()
                .all(|prompt| prompt.runtime.is_none()),
            "directory receipt does not establish runtime execution"
        );
    }
}
