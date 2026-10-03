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

#[test]
fn history_notifications_match_the_complete_binding_and_retain_selection() {
    use editchain_core::{
        OpId,
        activity::{ItemId, Kind, Message, MessageKind, Operation, Stage},
    };

    let item = ItemId(OpId::from_bytes([2; 32]));
    let operation = Operation::new(
        OpId::from_bytes([1; 32]),
        item,
        ItemId(OpId::from_bytes([3; 32])),
        Kind::Message(Message {
            category: MessageKind::Text,
            stage: Stage::Finished,
            audience: Vec::new(),
            blocks: Vec::new(),
            coverage: None,
            outcome: None,
        }),
    )
    .into_op()
    .expect("valid activity");
    let page = history::HistoryPage {
        observations: vec![history::Observation {
            record: history::RecordRef {
                operation: operation.id.to_string(),
                hash: OpId::from_bytes([4; 32]).to_string(),
            },
            operation_json: serde_json::to_vec(&operation).expect("operation JSON"),
        }],
        next_after: None,
        scanned: 1,
    };
    let mut runtime = Runtime::default();
    let directory = runtime.ready(&json!({})).expect("start").remove(0);
    let infos: Vec<Value> = ["one", "two"]
        .into_iter()
        .map(|id| {
            json!({"id": id, "name": id, "chain": format!("chain-{id}"),
                "revision": 1, "mode": "Standalone",
                "repositories": [{"id": "repository", "name": id, "remote": null}]})
        })
        .collect();
    let _calls = runtime
        .receive(&directory.id, Ok(json!({"Ok": {"Directory": infos}})))
        .expect("directory");
    let calls = runtime
        .dispatch(Event::Workspace(workspace::Event::SelectWorkspace(
            "one".into(),
        )))
        .expect("select first folder");
    for call in calls {
        let result = if call.method == "app.history" {
            json!({"Ok": {"History": page}})
        } else {
            json!({"Ok": {"Snapshot": {"workspace": infos.first().expect("first workspace"),
                "members": [], "host_ids": [], "provider_ids": []}}})
        };
        let _followups = runtime.receive(&call.id, Ok(result)).expect("initial read");
    }
    let selection = history::Selected {
        item: Some(item.to_string()),
        observation: None,
    };
    let _calls = runtime
        .dispatch(Event::History(history::Event::Select(selection.clone())))
        .expect("select item");
    let binding = runtime
        .view()
        .workspace
        .repository_binding
        .expect("bound history");
    for field in ["workspace_id", "repository_id", "chain"] {
        let mut wrong = serde_json::to_value(&binding).expect("binding");
        *wrong.get_mut(field).expect("binding field") = json!("another-context");
        let before = runtime.view();
        assert!(
            runtime
                .history_changed(&json!({"binding": wrong}))
                .expect("unrelated change")
                .is_empty(),
            "another binding cannot issue a read"
        );
        assert_eq!(
            runtime.view(),
            before,
            "unrelated changes preserve the view"
        );
    }
    let refresh = runtime
        .history_changed(&json!({"binding": binding}))
        .expect("bound change");
    assert!(
        refresh.iter().any(|call| call.method == "app.history"),
        "a local or peer write reconciles history"
    );
    assert_eq!(
        runtime.view().history.selected,
        selection,
        "refresh retains logical selection"
    );
    let _calls = runtime
        .dispatch(Event::Workspace(workspace::Event::SelectWorkspace(
            "two".into(),
        )))
        .expect("switch folder");
    let before = runtime.view();
    assert!(
        runtime
            .history_changed(&json!({"binding": binding}))
            .expect("old folder notification")
            .is_empty(),
        "a delayed old-folder event is ignored"
    );
    for call in refresh {
        let _calls = runtime
            .receive(&call.id, Err(unavailable()))
            .expect("old refresh completion");
    }
    assert_eq!(
        runtime.view(),
        before,
        "old reads cannot change the new folder"
    );
    assert!(
        runtime.history_changed(&json!({})).is_err(),
        "binding is required"
    );
}
