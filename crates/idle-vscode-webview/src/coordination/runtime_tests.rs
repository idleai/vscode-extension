use app_core::{resources, workspace};
use serde_json::{Value, json};

fn operation() -> resources::ResourceOperation {
    resources::ResourceOperation {
        context: resources::ResourceContext {
            provider: "idle-local".into(),
            workspace_id: "one".into(),
            contributor_id: "local-contributor:test".into(),
            chain: "one".into(),
            mode: workspace::WorkspaceMode::Standalone,
        },
        kind: resources::ResourceOperationKind::Snapshot,
    }
}

fn observation() -> Value {
    json!({"connected":true,"observed_at":1000,"revision":1,"status":{
        "protocolVersion":1,"hostId":"daemon-host","hostName":"compute-machine","runtimeId":"runtime:one",
        "workspaces":[{"binding":{"workspaceId":"one","chainId":"one"},"available":true}]
    }})
}

fn project(observation: &Value) -> Result<resources::ResourceSnapshot, String> {
    let value = super::super::reads::resource(
        &operation(),
        super::snapshot("one"),
        1000,
        Some(observation),
    )?;
    let result: resources::ResourceResult =
        serde_json::from_value(value.get("Ok").ok_or("missing result")?.clone())
            .map_err(|error| error.to_string())?;
    if let resources::ResourceResult::Snapshot(snapshot) = result {
        Ok(*snapshot)
    } else {
        Err("expected resource snapshot".into())
    }
}

#[test]
fn compute_status_uses_daemon_identity_and_does_not_advertise_execution() {
    let snapshot = project(&observation()).expect("valid runtime observation");
    let host = snapshot.hosts.first().expect("connected compute host");
    assert_eq!(
        host.id, "daemon-host",
        "host identity must come from the daemon"
    );
    assert_ne!(
        host.owner, snapshot.context.contributor_id,
        "the viewer does not own the compute machine"
    );
    assert_eq!(
        host.name, "Codex on compute-machine",
        "the view uses the compute machine name"
    );
    assert!(
        host.features.is_empty(),
        "status access must not advertise execution"
    );
    assert_eq!(
        host.health.at(1000),
        resources::ResourceAvailability::Available,
        "live status is available"
    );
    assert_eq!(
        host.health.at(31_000),
        resources::ResourceAvailability::Unknown,
        "old status must expire"
    );
    assert_eq!(
        snapshot.runtime.capabilities.connect_host,
        resources::ResourceCapability::Unavailable,
        "publication does not add a runtime action"
    );
}

#[test]
fn compute_disconnect_and_missing_checkout_keep_the_host_unavailable() {
    for path in ["/connected", "/status/workspaces/0/available"] {
        let mut value = observation();
        *value.pointer_mut(path).expect("known flag") = json!(false);
        let snapshot = project(&value).expect("unavailable host retains identity");
        assert_eq!(
            snapshot
                .hosts
                .first()
                .expect("retained host")
                .health
                .at(1000),
            resources::ResourceAvailability::Unavailable,
            "unreachable hosts must not be shown as available"
        );
    }
}

#[test]
fn compute_status_rejects_other_workspaces_and_future_observations() {
    for (path, replacement) in [
        ("/status/protocolVersion", json!(2)),
        ("/status/hostId", json!("")),
        ("/status/workspaces/0/binding/workspaceId", json!("two")),
        ("/status/workspaces/0/binding/chainId", json!("two")),
        ("/observed_at", json!(1001)),
        ("/revision", json!(0)),
    ] {
        let mut value = observation();
        *value.pointer_mut(path).expect("known field") = replacement;
        assert!(
            project(&value).is_err(),
            "mismatched field {path} must be rejected"
        );
    }
}

#[test]
fn daemon_status_reaches_the_native_compute_hosts_tree() {
    let (mut runtime, calls) = super::start();
    let _waiting = super::settle(&mut runtime, calls);
    for (revision, connected, description) in [(1, true, "Available"), (2, false, "Unavailable")] {
        let calls = runtime
            .dispatch(app_core::Event::Resources(resources::Event::Refresh))
            .expect("refresh compute resources");
        let call = calls
            .iter()
            .find(|call| call.params.get("runtime") == Some(&json!(true)))
            .expect("resource read requests runtime status");
        let mut result = super::native(&super::snapshot("one"));
        let mut status = observation();
        *status.get_mut("connected").expect("connection flag") = json!(connected);
        *status.get_mut("revision").expect("observation revision") = json!(revision);
        let _previous = result
            .as_object_mut()
            .expect("response object")
            .insert("runtime".into(), status);
        let _calls = runtime
            .receive(&call.id, Ok(result))
            .expect("runtime reply");
        let trees = crate::trees::snapshot(&runtime.view());
        let hosts = trees
            .iter()
            .find(|tree| tree.id == "idle.computeHosts")
            .expect("compute tree");
        let row = hosts
            .rows
            .iter()
            .find(|row| row.label == "Codex on compute-machine")
            .expect("daemon host row");
        assert_eq!(
            row.description, description,
            "the native view must reflect the runtime connection"
        );
    }
}
