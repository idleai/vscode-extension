use app_core::{Event, sessions, workspace::WorkspaceMode};
use serde_json::{Value, json};

use super::NativeSidebar;

fn update(runtime: &mut NativeSidebar, input: &Value) -> Value {
    serde_json::from_str(&runtime.update(&input.to_string()).expect("native update"))
        .expect("native tree records")
}

fn info(id: &str) -> Value {
    json!({"id": id, "name": id, "chain": format!("chain-{id}"), "revision": 1,
        "mode": "Standalone", "repositories": [{"id": format!("repository-{id}"), "name": id, "remote": null}]})
}

fn rows<'a>(state: &'a Value, id: &str) -> &'a Vec<Value> {
    state
        .get("trees")
        .and_then(Value::as_array)
        .expect("trees")
        .iter()
        .find(|tree| tree.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|tree| tree.get("rows"))
        .and_then(Value::as_array)
        .expect("tree rows")
}

fn load_directory(runtime: &mut NativeSidebar, directory: &Value) -> Value {
    let ready = update(runtime, &json!({"type": "Ready", "value": {}}));
    let request = ready
        .get("calls")
        .and_then(Value::as_array)
        .and_then(|calls| calls.first())
        .and_then(|call| call.get("id"))
        .expect("directory call");
    update(
        runtime,
        &json!({"type":"Reply", "value":{"id":request, "result":{"Ok":{"Ok":{"Directory":directory}}}}}),
    )
}

fn activate(runtime: &mut NativeSidebar, row: &Value) -> Value {
    update(
        runtime,
        &json!({"type":"Activate", "value": row.get("id").expect("row identity")}),
    )
}

#[test]
fn native_lists_start_without_a_browser_or_an_implicit_workspace_selection() {
    let mut runtime = NativeSidebar::new();
    let state = load_directory(&mut runtime, &json!([info("one"), info("two")]));
    assert_eq!(
        state
            .get("trees")
            .and_then(Value::as_array)
            .expect("trees")
            .len(),
        6
    );
    assert!(
        runtime
            .runtime
            .view()
            .workspace
            .selected_workspace
            .is_none()
    );
    assert_eq!(rows(&state, "idle.workspace").len(), 2);
    let selected = activate(
        &mut runtime,
        rows(&state, "idle.workspace")
            .last()
            .expect("second workspace"),
    );
    assert_eq!(
        selected.pointer("/selection/workspace_id"),
        Some(&json!("two"))
    );
    assert_eq!(
        selected.pointer("/selection/repository_id"),
        Some(&json!("repository-two"))
    );
    assert_eq!(
        selected.pointer("/selection/chain"),
        Some(&json!("chain-two"))
    );
    let detail = activate(
        &mut runtime,
        rows(&selected, "idle.sessions")
            .first()
            .expect("control row"),
    );
    assert_eq!(detail.pointer("/detail/section"), Some(&json!("Sessions")));
    assert_eq!(detail.pointer("/detail/binding"), selected.get("selection"));
}

#[test]
fn row_actions_are_retired_when_the_workspace_or_repository_binding_changes() {
    let mut runtime = NativeSidebar::new();
    let state = load_directory(&mut runtime, &json!([info("one"), info("two")]));
    let first = activate(
        &mut runtime,
        rows(&state, "idle.workspace")
            .first()
            .expect("first workspace"),
    );
    let retired = rows(&first, "idle.sessions")
        .first()
        .expect("old control row")
        .get("id")
        .expect("id")
        .clone();
    let _second = activate(
        &mut runtime,
        rows(&state, "idle.workspace")
            .last()
            .expect("second workspace"),
    );
    assert!(
        runtime
            .update(&json!({"type":"Activate", "value":retired}).to_string())
            .is_err(),
        "old rows cannot open a different workspace"
    );
    let mut changed = info("one");
    *changed.get_mut("chain").expect("chain") = json!("replacement-chain");
    let _fresh = load_directory(&mut runtime, &json!([changed]));
    let old = rows(&state, "idle.workspace")
        .first()
        .expect("old workspace")
        .get("id")
        .expect("id");
    assert!(
        runtime
            .update(&json!({"type":"Activate", "value":old}).to_string())
            .is_err(),
        "replacement bindings require a fresh row"
    );
}

#[test]
fn long_native_directories_preserve_all_items_and_ids_survive_display_name_changes() {
    let mut runtime = NativeSidebar::new();
    let directory: Vec<_> = (0..1200)
        .map(|index| info(&format!("workspace-{index:04}")))
        .collect();
    let state = load_directory(&mut runtime, &json!(directory));
    let old = rows(&state, "idle.workspace");
    assert_eq!(
        old.len(),
        1200,
        "native virtualization must not truncate the Rust directory"
    );
    let mut renamed = directory;
    for item in &mut renamed {
        *item.get_mut("name").expect("name") = json!("Renamed workspace");
    }
    let state = load_directory(&mut runtime, &json!(renamed));
    let fresh = rows(&state, "idle.workspace");
    assert_eq!(
        old.iter().map(|row| row.get("id")).collect::<Vec<_>>(),
        fresh.iter().map(|row| row.get("id")).collect::<Vec<_>>()
    );
    assert!(
        fresh
            .iter()
            .all(|row| row.get("label") == Some(&json!("Renamed workspace")))
    );
}

#[test]
fn native_session_rows_open_the_selected_record_and_reset_clears_private_data() {
    let mut runtime = NativeSidebar::new();
    let snapshot =
        sessions::scripted::demo_snapshot(WorkspaceMode::Standalone, "contributor-alice")
            .expect("sessions");
    let workspace = snapshot.context.workspace_id.clone();
    let mut directory = info("one");
    *directory.get_mut("id").expect("workspace id") = json!(workspace);
    *directory.get_mut("chain").expect("chain") = json!(snapshot.context.chain);
    let state = load_directory(&mut runtime, &json!([directory]));
    let _selected = activate(
        &mut runtime,
        rows(&state, "idle.workspace").first().expect("workspace"),
    );
    let request = runtime
        .runtime
        .dispatch(Event::Sessions(sessions::Event::Connect(
            snapshot.context.clone(),
        )))
        .expect("session request")
        .remove(0);
    let result: sessions::SessionOutput = Ok(sessions::SessionResult::Snapshot(Box::new(snapshot)));
    let state = update(
        &mut runtime,
        &json!({"type":"Reply", "value":{"id":request.id,"result":{"Ok":result}}}),
    );
    let row = rows(&state, "idle.sessions")
        .iter()
        .find(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.contains("session-shared"))
        })
        .expect("shared session");
    let detail = activate(&mut runtime, row);
    assert_eq!(
        detail.pointer("/detail/session"),
        Some(&json!("session-shared"))
    );
    assert_eq!(
        detail.pointer("/detail/binding/workspace_id"),
        Some(&json!(workspace))
    );
    let state = update(&mut runtime, &json!({"type":"Reset"}));
    assert!(
        !state.to_string().contains("session-shared"),
        "account reset clears rows immediately"
    );
    assert!(
        runtime
            .update(&json!({"type":"Activate", "value":row.get("id")}).to_string())
            .is_err()
    );
}
