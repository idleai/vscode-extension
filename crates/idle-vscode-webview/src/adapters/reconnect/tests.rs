use app_core::{Event, workspace};
use serde_json::{Value, json};

use crate::adapters::Runtime;

fn info(id: &str) -> Value {
    json!({"id": id, "name": id, "chain": format!("chain-{id}"),
        "revision": 1, "mode": "Standalone",
        "repositories": [{"id": format!("repository-{id}"), "name": id, "remote": null}]})
}

fn selected() -> Runtime {
    let mut runtime = Runtime::default();
    let directory = runtime
        .ready(&json!({}))
        .expect("initial handshake")
        .remove(0);
    let _calls = runtime
        .receive(
            &directory.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("initial directory");
    let calls = runtime
        .dispatch(Event::Workspace(workspace::Event::SelectWorkspace(
            "two".into(),
        )))
        .expect("select second folder");
    for call in calls
        .into_iter()
        .filter(|call| call.method == "app.workspace")
    {
        let _calls = runtime
            .receive(
                &call.id,
                Ok(json!({"Ok": {"Snapshot": {"workspace": info("two"),
                "members": [], "host_ids": [], "provider_ids": []}}})),
            )
            .expect("workspace snapshot");
    }
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("two")
    );
    runtime
}

#[test]
fn account_reconnection_clears_data_then_restores_the_same_bound_folder() {
    let mut runtime = selected();
    let binding = runtime
        .view()
        .workspace
        .repository_binding
        .expect("selected binding");
    runtime.invalidate();
    assert!(
        runtime.view().workspace.selected_workspace.is_none(),
        "old account context is immediately hidden"
    );
    assert!(runtime.view().workspace.workspaces.is_empty());
    let request = runtime.ready(&json!({})).expect("new handshake").remove(0);
    let calls = runtime
        .receive(
            &request.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("fresh directory");
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("two"),
        "reconnect does not pick the first folder"
    );
    assert_eq!(runtime.view().workspace.repository_binding, Some(binding));
    assert!(
        runtime.view().workspace.snapshot.is_none(),
        "the new account must load a fresh snapshot"
    );
    assert!(calls.iter().any(
        |call| call.params.pointer("/operation/Snapshot/workspace_id") == Some(&json!("two"))
    ));
}

#[test]
fn missing_or_changed_bindings_are_not_restored_from_the_previous_account() {
    let mut changed_chain = info("two");
    *changed_chain.get_mut("chain").expect("chain") = json!("replacement-chain");
    let mut changed_repository = info("two");
    *changed_repository
        .pointer_mut("/repositories/0/id")
        .expect("repository id") = json!("replacement-repository");
    let mut managed = info("two");
    *managed.get_mut("mode").expect("mode") = json!("Managed");
    for directory in [
        json!([info("one")]),
        json!([info("one"), changed_chain]),
        json!([info("one"), changed_repository]),
        json!([info("one"), managed]),
    ] {
        let mut runtime = selected();
        let request = runtime.ready(&json!({})).expect("new handshake").remove(0);
        let calls = runtime
            .receive(&request.id, Ok(json!({"Ok": {"Directory": directory}})))
            .expect("fresh directory");
        assert!(
            calls.is_empty(),
            "a removed or replaced binding needs a new user selection"
        );
        assert!(runtime.view().workspace.selected_workspace.is_none());
        assert!(runtime.view().workspace.repository_binding.is_none());
    }
}

#[test]
fn sign_in_completion_can_reconnect_again_while_the_first_snapshot_is_pending() {
    let mut runtime = selected();
    let first = runtime.ready(&json!({})).expect("provider event").remove(0);
    let retired = runtime
        .receive(
            &first.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("directory before access approval");
    let second = runtime
        .ready(&json!({}))
        .expect("approval completed")
        .remove(0);
    let before = runtime.view();
    for call in retired {
        assert!(
            runtime
                .receive(&call.id, Ok(json!(null)))
                .expect("retired reply")
                .is_empty()
        );
    }
    assert_eq!(
        runtime.view(),
        before,
        "retired reads cannot restore old account data"
    );
    let calls = runtime
        .receive(
            &second.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("directory after access approval");
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("two")
    );
    assert!(calls.iter().any(
        |call| call.params.pointer("/operation/Snapshot/workspace_id") == Some(&json!("two"))
    ));
}
