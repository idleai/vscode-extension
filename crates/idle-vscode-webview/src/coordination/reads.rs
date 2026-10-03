use app_core::{configuration, resources, subscriptions, workspace};
use idle_protocol::v1::{
    events::RecoverySnapshot,
    standalone::{Presence, RepositorySnapshot},
};
use serde_json::{Value, json};

use super::Adapter;

impl Adapter {
    pub(super) fn workspace(
        &mut self,
        operation: &workspace::WorkspaceOperation,
        data: Value,
        now: u64,
        view: &app_core::ViewModel,
    ) -> Result<Value, String> {
        match operation {
            workspace::WorkspaceOperation::Snapshot { workspace_id, .. } => {
                let snapshot: RepositorySnapshot =
                    serde_json::from_value(data).map_err(|error| error.to_string())?;
                let recovered = recovery(snapshot);
                let mut projected = workspace::WorkspaceSnapshot::try_from(&recovered)
                    .map_err(|error| error.to_string())?;
                for member in &mut projected.members {
                    if member.contributor_id == recovered.as_of.contributor_id.0 {
                        member.display_name = "You (local)".into();
                    }
                }
                if &projected.workspace.id != workspace_id {
                    return Err("Coordinator returned another workspace".into());
                }
                if view.workspace.selected_workspace.as_ref() == Some(workspace_id) {
                    self.context = Some(subscriptions::Context {
                        provider: "idle-local".into(),
                        workspace: workspace_id.clone(),
                        contributor: recovered.as_of.contributor_id.0,
                        chain: projected.workspace.chain.clone(),
                    });
                }
                Ok(json!({"Ok": workspace::WorkspaceResult::Snapshot(projected)}))
            }
            workspace::WorkspaceOperation::Presence { workspace_id, .. } => {
                let entries: Vec<Presence> =
                    serde_json::from_value(data).map_err(|error| error.to_string())?;
                Ok(
                    json!({"Ok": workspace::WorkspaceResult::Presence(workspace::PresenceSnapshot {
                        workspace_id: workspace_id.clone(), as_of_ms: now,
                        entries: entries.into_iter().map(|entry| workspace::PresenceEntry {
                            connection_id: entry.connection_id, contributor_id: entry.contributor_id.0,
                            status: workspace::PresenceStatus::Online, repository_id: Some(entry.repository_id.0),
                            branch: entry.branch, file: entry.file, host_id: entry.host_id.map(|id| id.0), summary: entry.summary,
                            observed_at_ms: entry.observed_at.0, valid_until_ms: entry.valid_until.0,
                        }).collect(),
                    })}),
                )
            }
            workspace::WorkspaceOperation::List => {
                Err("Unexpected coordinator directory result".into())
            }
        }
    }
}

pub(super) fn recovery(snapshot: RepositorySnapshot) -> RecoverySnapshot {
    RecoverySnapshot {
        as_of: snapshot.as_of,
        workspace: snapshot.workspace,
        contributors: Vec::new(),
        memberships: snapshot.memberships,
        invitations: Vec::new(),
        sessions: snapshot.sessions,
        hosts: snapshot.hosts,
        providers: snapshot.providers,
        models: Vec::new(),
        grants: snapshot.grants,
        control: snapshot.control,
        inputs: Vec::new(),
    }
}

pub(super) fn resource(
    operation: &resources::ResourceOperation,
    data: Value,
    now: u64,
) -> Result<Value, String> {
    let snapshot: RepositorySnapshot =
        serde_json::from_value(data).map_err(|error| error.to_string())?;
    let projected = resources::ResourceSnapshot::from_protocol(
        &recovery(snapshot),
        &resources::ResourceAdapterContext {
            context: operation.context.clone(),
            now_ms: now,
            runtime: resources::ResourceRuntimeInfo::default(),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"Ok": resources::ResourceResult::Snapshot(Box::new(projected))}))
}

pub(super) fn configuration(
    operation: &configuration::ConfigurationOperation,
    data: Value,
) -> Result<Value, String> {
    let snapshot: RepositorySnapshot =
        serde_json::from_value(data).map_err(|error| error.to_string())?;
    Ok(
        json!({"Ok": configuration::ConfigurationResult::Loaded(configuration_snapshot(operation, snapshot)?)}),
    )
}

pub(super) fn configuration_snapshot(
    operation: &configuration::ConfigurationOperation,
    snapshot: RepositorySnapshot,
) -> Result<configuration::ConfigurationSnapshot, String> {
    if snapshot.workspace.value.id.0 != operation.context.workspace_id
        || snapshot.as_of.workspace_id.0 != operation.context.workspace_id
        || snapshot.workspace.value.chain.0 != operation.context.chain
        || snapshot.as_of.contributor_id.0 != operation.context.contributor_id
    {
        return Err("Configuration scope differs from the connected coordinator".into());
    }
    let can_edit = snapshot.memberships.iter().any(|record| {
        record.value.contributor_id.0 == operation.context.contributor_id
            && record.value.status == idle_protocol::v1::membership::MembershipStatus::Active
            && matches!(
                record.value.role,
                idle_protocol::v1::membership::Role::Owner
                    | idle_protocol::v1::membership::Role::Admin
            )
    });
    let record = match operation.document {
        configuration::ConfigurationDocument::Settings => snapshot.settings,
        configuration::ConfigurationDocument::AgentRules => snapshot.agent_rules,
    };
    Ok(configuration::ConfigurationSnapshot {
        context: operation.context.clone(),
        document: operation.document,
        can_edit,
        record: record.map(|record| configuration::ConfigurationRecord {
            revision: record.revision.0,
            value: configuration::ConfigurationValue {
                schema_version: record.value.schema_version,
                json: record.value.json,
            },
        }),
    })
}
