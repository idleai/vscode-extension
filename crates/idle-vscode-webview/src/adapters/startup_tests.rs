use app_core::{Event, projections, subscriptions::Context};
use serde_json::{Value, json};

use super::{Call, Runtime};

fn connect(runtime: &mut Runtime, workspace: &str) -> Call {
    runtime
        .dispatch(Event::Projections(projections::Event::Connect(Context {
            provider: "local".into(),
            workspace: workspace.into(),
            contributor: "member".into(),
            chain: "chain".into(),
        })))
        .unwrap()
        .into_iter()
        .find(|call| call.method == "app.projection")
        .unwrap()
}

fn snapshot(workspace: &str) -> Value {
    let inputs: Vec<_> = ["activity", "task", "error", "triage", "need_input"].into_iter().map(|kind| {
        let activity = kind == "activity";
        let rows = if activity { vec![json!({
            "key":"local-record", "title":"Local activity", "summary":null, "url":null, "status":null,
            "labels":[], "sources":[{"observation":"ab".repeat(32), "item":"cd".repeat(32), "record_hash":"ef".repeat(32)}], "related":[]
        })] } else { vec![] };
        json!({"kind":kind, "freshness":{"status":"unknown", "generated_at_ms":1000, "checkpoint":null},
            "availability":if activity { "complete" } else { "unavailable" },
            "total":if activity { Some(1) } else { None }, "rows":rows,
            "gaps":if activity { vec![] } else { vec![json!({"reference":null,"message":"GitHub details are loading."})] }})
    }).collect();
    json!({"Ok":{"version":1, "workspace_id":workspace, "chain":"chain", "inputs":inputs}})
}

#[test]
fn local_activity_remains_visible_during_one_complete_followup_and_new_contexts_restart() {
    let mut runtime = Runtime::default();
    let first = connect(&mut runtime, "one");
    assert_eq!(first.params.get("initial"), Some(&json!(true)));
    let result = snapshot("one");
    let calls = runtime
        .receive(&first.id, Ok(json!({"local":result})))
        .unwrap();
    let complete = calls
        .iter()
        .find(|call| call.method == "app.projection")
        .unwrap();
    assert_eq!(complete.params.get("initial"), Some(&json!(false)));
    let view = runtime.view().projections;
    assert_eq!(view.load, projections::ProjectionLoadState::Loading);
    assert_eq!(view.activity.rows.first().unwrap().title, "Local activity");
    assert_eq!(
        view.tasks.total, None,
        "pending remote data is not an empty total"
    );
    let calls = runtime.receive(&complete.id, Ok(result.clone())).unwrap();
    assert!(
        !calls.iter().any(|call| call.method == "app.projection"),
        "completion must not loop"
    );
    let calls = runtime
        .dispatch(Event::Projections(projections::Event::Refresh))
        .unwrap();
    let manual = calls
        .iter()
        .find(|call| call.method == "app.projection")
        .unwrap();
    assert_eq!(manual.params.get("initial"), Some(&json!(false)));
    assert_eq!(
        manual.params.pointer("/operation/refresh_sources"),
        Some(&json!(true))
    );
    let next = connect(&mut runtime, "two");
    assert_eq!(next.params.get("initial"), Some(&json!(true)));
    let _calls = runtime
        .receive(&manual.id, Ok(json!({"local":result})))
        .unwrap();
    assert!(
        runtime.view().projections.activity.rows.is_empty(),
        "retired rows stay cleared"
    );
    runtime.invalidate();
    assert_eq!(
        connect(&mut runtime, "two").params.get("initial"),
        Some(&json!(true))
    );
}
