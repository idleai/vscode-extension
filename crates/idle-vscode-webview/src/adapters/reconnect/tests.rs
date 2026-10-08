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

fn binding(id: &str) -> Value {
    json!({"workspace_id": id, "repository_id": format!("repository-{id}"), "chain": format!("chain-{id}")})
}

#[test]
fn reopened_native_views_wait_for_the_directory_and_apply_only_the_latest_selection() {
    let mut runtime = Runtime::default();
    let request = runtime.ready(&json!({})).expect("handshake").remove(0);
    assert!(
        runtime
            .synchronize_workspace(binding("one"))
            .expect("first selection")
            .is_empty()
    );
    assert!(
        runtime
            .synchronize_workspace(binding("two"))
            .expect("latest selection")
            .is_empty()
    );
    assert!(runtime.view().workspace.selected_workspace.is_none());
    let _calls = runtime
        .receive(
            &request.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("fresh directory");
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("two")
    );
    assert!(
        runtime
            .synchronize_workspace(binding("two"))
            .expect("same selection")
            .is_empty()
    );
    let calls = runtime
        .synchronize_workspace(binding("one"))
        .expect("changed selection");
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("one")
    );
    assert!(calls.iter().any(
        |call| call.params.pointer("/operation/Snapshot/workspace_id") == Some(&json!("one"))
    ));
}

#[test]
fn native_view_does_not_adopt_a_replaced_repository_or_chain() {
    for (field, value) in [
        ("chain", "replaced-chain"),
        ("repository_id", "replaced-repository"),
    ] {
        let mut runtime = Runtime::default();
        let request = runtime.ready(&json!({})).expect("handshake").remove(0);
        let mut changed = binding("two");
        *changed.get_mut(field).expect("binding field") = json!(value);
        let _calls = runtime
            .synchronize_workspace(changed)
            .expect("queued binding");
        let calls = runtime
            .receive(
                &request.id,
                Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
            )
            .expect("fresh directory");
        assert!(calls.is_empty());
        assert!(runtime.view().workspace.selected_workspace.is_none());
    }
}

#[test]
fn detail_navigation_survives_initial_loading_and_a_later_user_choice_cancels_it() {
    let mut runtime = Runtime::default();
    let request = runtime.ready(&json!({})).expect("handshake").remove(0);
    let _calls = runtime
        .navigate_from_host(
            json!({"binding": binding("two"), "section": "Sessions", "session": "waiting-session"}),
        )
        .expect("detail target");
    let _calls = runtime
        .receive(
            &request.id,
            Ok(json!({"Ok": {"Directory": [info("one"), info("two")]}})),
        )
        .expect("fresh directory");
    assert_eq!(
        runtime.view().workspace.selected_workspace.as_deref(),
        Some("two")
    );
    assert_eq!(
        runtime.view().workspace.section,
        workspace::NavigationSection::Sessions
    );
    let _calls = runtime
        .dispatch(Event::Workspace(workspace::Event::Navigate(
            workspace::NavigationSection::Settings,
        )))
        .expect("user navigation");
    assert!(runtime.navigation.is_none());
    assert_eq!(
        runtime.view().workspace.section,
        workspace::NavigationSection::Settings
    );
}

#[test]
fn activity_destination_preserves_the_exact_mini_record_through_native_views() {
    let mut runtime = selected();
    let selection = json!({"occurrence": format!("retained:{}", "a".repeat(64)),
        "address": {"Record": {"source": "retained", "record": {"operation": "a".repeat(64), "hash": "b".repeat(64)}}}});
    let calls = runtime
        .navigate_from_host(json!({
            "binding": binding("two"), "section": "Activity", "timeline": selection,
        }))
        .expect("exact Activity destination");
    assert!(calls.iter().any(|call| {
        call.params
            .pointer("/operation/action/Timeline/action/Window/position/Seek")
            == selection.get("occurrence")
    }));
    assert_eq!(
        runtime
            .navigation_target(workspace::NavigationSection::Activity)
            .get("timeline"),
        Some(&selection)
    );
    assert!(
        calls
            .iter()
            .all(|call| call.params.pointer("/operation/action/OpenAt").is_none()),
        "revealing the Activity editor does not activate a document"
    );
}

#[test]
fn mini_destination_waits_for_subscription_binding_and_reconciliation() {
    use app_core::{Effect, history, subscriptions};

    let mut runtime = selected();
    runtime.coordination.enabled = true;
    let selection = json!({"occurrence": format!("current:{}", "a".repeat(64)),
        "address": {"Record": {"source": "current", "record": {"operation": "a".repeat(64), "hash": "b".repeat(64)}}}});
    let early = runtime
        .navigate_from_host(json!({
            "binding": binding("two"), "section": "Activity", "timeline": selection,
        }))
        .expect("early mini destination");
    assert!(
        early
            .iter()
            .all(|call| call.params.pointer("/operation/action/Timeline").is_none())
    );
    assert!(runtime.view().history.timeline.selected.is_none());
    let mounted = runtime
        .dispatch(Event::History(history::Event::Timeline(
            history::timeline::Event::Load(history::timeline::Surface::Editor),
        )))
        .expect("mounted editor");
    let _calls = runtime
        .dispatch(Event::Subscriptions(subscriptions::Event::Connect(
            subscriptions::Context {
                provider: "local".into(),
                workspace: "two".into(),
                contributor: "person".into(),
                chain: "chain-two".into(),
            },
        )))
        .expect("late subscription binding");
    let join = runtime
        .pending
        .iter()
        .find_map(|(id, effect)| {
            matches!(effect, Effect::Subscription(request)
                if request.operation.action == subscriptions::SubscriptionAction::Join)
            .then(|| id.clone())
        })
        .expect("join request");
    let joined = runtime
        .receive(&join, Ok(json!({"Ok": {"Joined": {"connection": "live"}}})))
        .expect("subscription joined");
    assert!(runtime.view().history.timeline.selected.is_none());
    let stale = mounted
        .iter()
        .find(|call| call.method == "app.history")
        .expect("early timeline read");
    let interrupted = runtime
        .receive(&stale.id, Ok(json!({"Err": {"message": "retired read"}})))
        .expect("late retired read");
    assert!(
        interrupted
            .iter()
            .all(|call| call.params.pointer("/operation/action/Reconcile").is_none()),
        "a pending destination must not restart reconciliation on every reply"
    );
    let reconcile = joined
        .iter()
        .find(|call| call.params.pointer("/operation/action/Reconcile").is_some())
        .expect("replacement history read");
    let calls = runtime
        .receive(
            &reconcile.id,
            Ok(json!({"Ok": {"Reconciled": {
                "history": [{"observations": [], "next_after": null, "scanned": 0}],
                "search": [], "items": [], "details": []
            }}})),
        )
        .expect("completed history reconciliation");
    assert!(calls.iter().any(|call| {
        call.params
            .pointer("/operation/action/Timeline/action/Window/position/Seek")
            == selection.get("occurrence")
    }));
    assert_eq!(
        runtime
            .navigation_target(workspace::NavigationSection::Activity)
            .get("timeline"),
        Some(&selection)
    );
    assert!(
        calls
            .iter()
            .all(|call| call.params.pointer("/operation/action/OpenAt").is_none())
    );
}
