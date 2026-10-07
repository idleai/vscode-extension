use app_core::{Event, configuration, resources, subscriptions, workspace};
use serde_json::{Value, json};

use crate::adapters::{Call, Runtime};

#[path = "workspace_config_tests.rs"]
mod workspace_config;

fn snapshot(workspace: &str) -> Value {
    json!({
        "as_of": {"workspace_id":workspace, "contributor_id":"local-contributor:test", "stream_id":"stream", "position":"9007199254740993"},
        "workspace": {"revision":"1", "value": {"id":workspace, "name":workspace, "chain":workspace,
            "mode":{"kind":"standalone", "repository":{"id":"repository", "name":"Repository", "remote":null}}}},
        "memberships":[{"revision":"1", "value":{"contributor_id":"local-contributor:test", "role":"owner", "status":"active"}}],
        "sessions":[], "hosts":[], "providers":[], "grants":[],
        "control":{"workspace_id":workspace,"last_epoch":"0","lease":null},
        "settings":{"revision":"9007199254740993", "value":{"schema_version":1,"json":"{\"unknown\":true}"}},
        "agent_rules":null,"views":[]
    })
}

fn native(data: &Value) -> Value {
    json!({"native":json!({"version":1,"id":"service-id","result":{"Ok":data}}).to_string(),"now_ms":1000})
}

fn start() -> (Runtime, Vec<Call>) {
    start_with(&json!({"capabilities":["app.coordination"]}))
}

fn start_with(handshake: &Value) -> (Runtime, Vec<Call>) {
    let mut runtime = Runtime::default();
    let directory = runtime.ready(handshake).unwrap().remove(0);
    let infos: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|id| {
            json!({
                "id":id,"name":id,"chain":id,"revision":1,"mode":"Standalone",
                "repositories":[{"id":"repository","name":"Repository","remote":null}]
            })
        })
        .collect();
    let _calls = runtime
        .receive(&directory.id, Ok(json!({"Ok":{"Directory":infos}})))
        .unwrap();
    let calls = runtime
        .dispatch(Event::Workspace(workspace::Event::SelectWorkspace(
            "one".into(),
        )))
        .unwrap();
    (runtime, calls)
}

fn settle(runtime: &mut Runtime, mut calls: Vec<Call>) -> Vec<Call> {
    let mut waiting = Vec::new();
    let mut count = 0;
    while let Some(call) = calls.pop() {
        count = u32::checked_add(count, 1).unwrap();
        assert!(count < 40, "bootstrap must settle without a polling loop");
        let result = if call.method == "app.coordination" {
            let command: Value =
                serde_json::from_str(call.params.get("command").unwrap().as_str().unwrap())
                    .unwrap();
            if command.get("kind").unwrap() == "catch_up" {
                waiting.push(call);
                continue;
            }
            if command.get("kind").unwrap() == "presence" {
                native(&json!([]))
            } else {
                native(&snapshot(
                    call.params
                        .pointer("/binding/workspace_id")
                        .unwrap()
                        .as_str()
                        .unwrap(),
                ))
            }
        } else if call.method == "app.configurationState" {
            json!({"drafts":"[]"})
        } else if call.method == "app.history" {
            let page = json!({"observations":[],"next_after":null,"scanned":0});
            if call
                .params
                .pointer("/operation/action")
                .unwrap()
                .get("Reconcile")
                .is_some()
            {
                json!({"Ok":{"Reconciled":{"history":[page],"search":[],"items":[],"details":[]}}})
            } else {
                json!({"Ok":{"History":page}})
            }
        } else if call.method == "app.subscription" {
            json!({"Ok":"Left"})
        } else if call.method == "app.repository" {
            waiting.push(call);
            continue;
        } else {
            json!({"Err":{"message":"No controller connected"}})
        };
        calls.extend(runtime.receive(&call.id, Ok(result)).unwrap());
    }
    waiting
}

#[test]
fn local_sessions_are_selectable_while_remote_details_are_pending() {
    let (mut runtime, calls) = start_with(&json!({
        "capabilities":["app.coordination", "app.repository"]
    }));
    let waiting = settle(&mut runtime, calls);
    let initial = waiting
        .iter()
        .find(|call| call.method == "app.repository")
        .unwrap();
    assert_eq!(initial.params.get("initial"), Some(&json!(true)));
    let binding = json!({"workspace_id":"one", "repository_id":"repository", "chain":"one"});
    let session = "ab".repeat(32);
    let _calls = runtime
        .navigate_from_host(json!({
            "binding":binding, "section":"Sessions", "recorded_session":session
        }))
        .unwrap();
    let snapshot = json!({
        "scope":binding, "checked_at_ms":1000, "checkout":null, "github":null, "account":null,
        "git_authors":[], "contributors":[], "collaborators":[],
        "reports":[{"topic":"history.sessions", "state":"complete", "message":"Recorded sessions",
            "checked_at_ms":1000, "retry_at_ms":null, "source_url":null}],
        "sessions":[{"id":session, "labels":["Local session"], "actions":["Started"], "sources":[],
            "records":[{"observation":"cd".repeat(32), "item":session, "record_hash":"ef".repeat(32)}]}]
    });
    let result = json!({"Ok":{"Snapshot":{"snapshot":snapshot, "selected_session":null}}});
    let calls = runtime
        .receive(&initial.id, Ok(json!({"local":result})))
        .unwrap();
    assert!(
        runtime.view().repository.snapshot.is_some(),
        "{:?}",
        runtime.view().repository
    );
    let poll = calls
        .iter()
        .find(|call| call.params.pointer("/operation/action") == Some(&json!("Poll")))
        .unwrap();
    let view = runtime.view();
    assert_eq!(
        view.repository.load,
        app_core::repository::RepositoryLoadState::Loading
    );
    assert_eq!(view.repository.snapshot.as_ref().unwrap().sessions.len(), 1);
    assert_eq!(
        view.repository.selected_session.as_deref(),
        Some(session.as_str())
    );
    assert_eq!(
        view.workspace.section,
        workspace::NavigationSection::Sessions
    );
    let followup = runtime.receive(&poll.id, Ok(result.clone())).unwrap();
    assert!(
        !followup.iter().any(|call| call.method == "app.repository"),
        "full completion must not poll in a loop"
    );
    assert_eq!(
        runtime.view().repository.load,
        app_core::repository::RepositoryLoadState::Ready
    );
    let refresh = runtime
        .dispatch(Event::Repository(app_core::repository::Event::Refresh))
        .unwrap();
    let read = refresh
        .iter()
        .find(|call| call.method == "app.repository")
        .unwrap();
    assert_eq!(
        read.params.get("initial"),
        Some(&json!(false)),
        "manual refresh includes remote details"
    );
    runtime.invalidate();
    assert!(
        runtime
            .receive(&read.id, Ok(json!({"local":result})))
            .unwrap()
            .is_empty()
    );
    assert!(
        runtime.view().repository.snapshot.is_none(),
        "retired local data cannot reappear after reset"
    );
}

#[test]
fn metadata_connects_scoped_reads_without_runtime_capabilities() {
    let (mut runtime, calls) = start();
    let waiting = settle(&mut runtime, calls);
    assert_eq!(waiting.len(), 1);
    let view = runtime.view();
    assert_eq!(
        view.subscriptions.status,
        subscriptions::ConnectionStatus::Live,
        "{:?}",
        runtime.view().history
    );
    assert_eq!(
        view.workspace.members.first().unwrap().member.display_name,
        "You (local)"
    );
    assert_eq!(view.resources.load, resources::ResourceLoadState::Ready);
    assert_eq!(
        view.configuration.settings.load,
        configuration::ConfigurationLoadState::Ready
    );
    assert_eq!(
        view.configuration
            .settings
            .current
            .as_ref()
            .unwrap()
            .revision,
        9_007_199_254_740_993
    );
    assert!(
        !view
            .configuration
            .settings
            .actions
            .contains(&configuration::ConfigurationEditorAction::Save)
    );
    assert!(
        view.configuration
            .settings
            .actions
            .contains(&configuration::ConfigurationEditorAction::Edit)
    );
    assert!(
        view.sessions.context.is_none(),
        "metadata cannot manufacture an execution connection"
    );
    let command: Value = serde_json::from_str(
        waiting
            .first()
            .unwrap()
            .params
            .get("command")
            .unwrap()
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        command.pointer("/data/after/position").unwrap(),
        "9007199254740993"
    );
}

#[test]
fn empty_recovery_keeps_waiting_and_reset_rejoins() {
    let (mut runtime, calls) = start();
    let watch = settle(&mut runtime, calls).remove(0);
    let cursor = snapshot("one").get("as_of").unwrap().clone();
    let calls = runtime
        .receive(
            &watch.id,
            Ok(native(
                &json!({"kind":"events","data":{"events":[],"through":cursor,"has_more":false}}),
            )),
        )
        .unwrap();
    let next = settle(&mut runtime, calls).remove(0);
    assert_ne!(next.id, watch.id);
    assert_eq!(
        runtime.view().subscriptions.status,
        subscriptions::ConnectionStatus::Live,
        "{:?}",
        runtime.view().history
    );
    let calls = runtime
        .receive(&next.id, Ok(native(&json!({"kind":"snapshot_required"}))))
        .unwrap();
    assert!(
        !calls.is_empty(),
        "a recovery reset must rejoin and replace its snapshot"
    );
}

#[test]
fn old_folder_response_cannot_replace_new_context() {
    let (mut runtime, calls) = start();
    let old = settle(&mut runtime, calls).remove(0);
    let next = runtime
        .dispatch(Event::Workspace(workspace::Event::SelectWorkspace(
            "two".into(),
        )))
        .unwrap();
    let _watch = settle(&mut runtime, next);
    let before = runtime.view();
    let replies = runtime
        .receive(&old.id, Ok(native(&json!({"kind":"snapshot_required"}))))
        .unwrap();
    assert!(replies.is_empty());
    assert_eq!(runtime.view(), before);
    assert_eq!(
        runtime.view().subscriptions.context.unwrap().workspace,
        "two"
    );
}

#[test]
fn invalid_recovery_never_advances_the_connection() {
    let (mut runtime, calls) = start();
    let watch = settle(&mut runtime, calls).remove(0);
    let mut cursor = snapshot("one").get("as_of").unwrap().clone();
    *cursor.get_mut("position").unwrap() = json!("1");
    let calls = runtime
        .receive(
            &watch.id,
            Ok(native(
                &json!({"kind":"events","data":{"events":[],"through":cursor,"has_more":false}}),
            )),
        )
        .unwrap();
    assert!(!calls.iter().any(|call| call.method == "app.history"));
    assert_ne!(
        runtime.view().subscriptions.status,
        subscriptions::ConnectionStatus::Live,
        "{:?}",
        runtime.view().history
    );
}

#[test]
fn interrupted_watch_retries_but_denied_access_stops() {
    for code in ["host_timeout", "unavailable", "busy", "denied"] {
        let (mut runtime, calls) = start();
        let watch = settle(&mut runtime, calls).remove(0);
        let calls = runtime
            .receive(
                &watch.id,
                Err(crate::bridge::BridgeError {
                    code: code.into(),
                    message: "The coordinator read ended.".into(),
                    details: None,
                }),
            )
            .unwrap();
        assert_eq!(
            calls.iter().any(|call| call.method == "app.subscription"
                && call.params.pointer("/operation/action/Wait").is_some()),
            code != "denied",
            "unexpected retry policy for {code}"
        );
    }
}

#[test]
fn configuration_permissions_require_an_active_owner_or_admin() {
    let operation = configuration::ConfigurationOperation {
        context: configuration::ConfigurationContext {
            provider: "idle-local".into(),
            workspace_id: "one".into(),
            contributor_id: "local-contributor:test".into(),
            chain: "one".into(),
            mode: workspace::WorkspaceMode::Standalone,
        },
        document: configuration::ConfigurationDocument::Settings,
        action: configuration::ConfigurationAction::Load,
    };
    for (role, status, allowed) in [
        ("owner", "active", true),
        ("admin", "active", true),
        ("member", "active", false),
        ("owner", "revoked", false),
    ] {
        let mut data = snapshot("one");
        *data.pointer_mut("/memberships/0/value/role").unwrap() = json!(role);
        *data.pointer_mut("/memberships/0/value/status").unwrap() = json!(status);
        let value =
            super::reads::configuration_snapshot(&operation, serde_json::from_value(data).unwrap())
                .unwrap();
        assert_eq!(value.can_edit, allowed, "{role}/{status}");
    }
    let mut foreign = snapshot("one");
    *foreign.pointer_mut("/as_of/contributor_id").unwrap() = json!("another-contributor");
    assert!(
        super::reads::configuration_snapshot(&operation, serde_json::from_value(foreign).unwrap())
            .is_err()
    );
}

#[test]
fn configuration_save_carries_recoverable_state_and_exact_original_revision() {
    let (mut runtime, calls) = start_with(&json!({
        "capabilities":["app.coordination", "app.configurationState"], "mutation_prefix":"new-host-prefix",
    }));
    let _waiting = settle(&mut runtime, calls);
    let calls = runtime
        .dispatch(Event::Configuration(configuration::Event::Edit {
            document: configuration::ConfigurationDocument::Settings,
            json: "{\"new\":true}".into(),
        }))
        .unwrap();
    let _waiting = settle(&mut runtime, calls);
    let calls = runtime
        .save_configuration(configuration::ConfigurationDocument::Settings)
        .unwrap();
    let write = calls
        .iter()
        .find(|call| call.method == "app.coordination")
        .unwrap();
    let command: Value =
        serde_json::from_str(write.params.get("command").unwrap().as_str().unwrap()).unwrap();
    assert_eq!(
        command
            .pointer("/data/body/data/change/expected/value")
            .unwrap(),
        "9007199254740993"
    );
    let drafts: Vec<configuration::ConfigurationDraft> =
        serde_json::from_str(write.params.get("drafts").unwrap().as_str().unwrap()).unwrap();
    let pending = drafts.first().unwrap().pending.as_ref().unwrap();
    assert!(pending.request.request_id.starts_with("new-host-prefix:"));
    assert_eq!(pending.expected_revision, Some(9_007_199_254_740_993));
    assert_eq!(pending.request.expires_at_ms, 301_000);
    let _calls = runtime
        .receive(
            &write.id,
            Err(crate::bridge::BridgeError {
                code: "host_timeout".into(),
                message: "Acknowledgement was lost".into(),
                details: None,
            }),
        )
        .unwrap();
    let calls = runtime
        .dispatch(Event::Configuration(configuration::Event::RetrySave(
            configuration::ConfigurationDocument::Settings,
        )))
        .unwrap();
    let retry = calls
        .iter()
        .find(|call| call.method == "app.coordination")
        .unwrap();
    assert_eq!(
        retry.params.get("command").unwrap(),
        write.params.get("command").unwrap()
    );
}

#[test]
fn malformed_draft_recovery_does_not_loop_or_interrupt_workspace_reads() {
    let (mut runtime, calls) = start_with(&json!({
        "capabilities":["app.coordination", "app.configurationState"], "mutation_prefix":"prefix",
    }));
    // Connecting metadata introduces the first draft read.
    let mut waiting = Vec::new();
    let mut pending = calls;
    while let Some(call) = pending.pop() {
        if call.method == "app.configurationState" {
            assert!(
                runtime
                    .receive(&call.id, Ok(json!({"drafts":"{bad"})))
                    .is_err()
            );
            continue;
        }
        if call.method == "app.coordination" {
            let command: Value =
                serde_json::from_str(call.params.get("command").unwrap().as_str().unwrap())
                    .unwrap();
            if command.get("kind").unwrap() == "snapshot" {
                pending.extend(
                    runtime
                        .receive(&call.id, Ok(native(&snapshot("one"))))
                        .unwrap(),
                );
                continue;
            }
        }
        waiting.push(call);
    }
    let _waiting = settle(&mut runtime, waiting);
    let calls = runtime
        .dispatch(Event::Workspace(workspace::Event::RefreshWorkspace))
        .unwrap();
    assert!(calls.iter().any(|call| call.method == "app.coordination"));
    assert!(
        !calls
            .iter()
            .any(|call| call.method == "app.configurationState")
    );
    assert!(
        runtime
            .save_configuration(configuration::ConfigurationDocument::Settings)
            .is_err()
    );
}
