use app_core::resources::{
    ComputeHostInfo, ResourceAvailability, ResourceHealth, ResourceSnapshot,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Observation {
    status: Status,
    connected: bool,
    observed_at: u64,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    protocol_version: u32,
    host_id: String,
    host_name: String,
    runtime_id: String,
    workspaces: Vec<Workspace>,
}

#[derive(Deserialize)]
struct Workspace {
    binding: Binding,
    available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    workspace_id: String,
    chain_id: String,
}

pub(super) fn append(
    snapshot: &mut ResourceSnapshot,
    value: Value,
    now: u64,
) -> Result<(), String> {
    let observation: Observation =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    let status = observation.status;
    let [workspace] = status.workspaces.as_slice() else {
        return Err("Compute status must contain the approved workspace".into());
    };
    if status.protocol_version != 1
        || [&status.host_id, &status.host_name, &status.runtime_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control))
        || workspace.binding.workspace_id != snapshot.context.workspace_id
        || workspace.binding.chain_id != snapshot.context.chain
        || observation.observed_at == 0
        || observation.revision == 0
        || observation.observed_at > now
    {
        return Err("Compute status differs from this workspace connection".into());
    }
    let availability = if observation.connected && workspace.available {
        ResourceAvailability::Available
    } else {
        ResourceAvailability::Unavailable
    };
    // The publishing installation owns this connection, independently of the viewer.
    let host = ComputeHostInfo {
        id: status.host_id.clone(),
        owner: format!("codex:{}", status.host_id),
        name: format!("Codex on {}", status.host_name),
        revision: observation.revision,
        features: Vec::new(),
        health: ResourceHealth {
            availability,
            observed_at_ms: observation.observed_at,
            valid_until_ms: observation.observed_at.saturating_add(30_000),
        },
    };
    snapshot.hosts.retain(|existing| existing.id != host.id);
    snapshot.hosts.push(host);
    Ok(())
}
