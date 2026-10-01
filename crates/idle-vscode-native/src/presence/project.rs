use std::collections::BTreeSet;

use app_core::workspace::{
    MemberStatus, PresenceEntry, PresenceStatus, WorkspaceRequestState, WorkspaceSnapshot,
};
use idle_protocol::v1::resources::{Availability, ComputeHost};

use super::{AwarenessError, AwarenessInput, HostLabel, Peer, joins};

pub(super) struct Projection {
    pub peers: Vec<(Peer, PresenceEntry)>,
    pub valid_for_ms: u64,
}

pub(super) fn project(input: &AwarenessInput<'_>) -> Result<Projection, AwarenessError> {
    validate(input)?;
    let mut peers = Vec::new();
    let mut ids = BTreeSet::new();
    let mut deadline = input.now_ms.saturating_add(30_000);
    for member in &input.workspace.members {
        if member.member.status != MemberStatus::Active {
            continue;
        }
        for connection in &member.connections {
            if !ids.insert(&connection.connection_id) {
                return Err(AwarenessError::Unavailable);
            }
            if !visible(input, connection, &member.member.contributor_id) {
                continue;
            }
            deadline = deadline.min(connection.valid_until_ms);
            let host = input
                .directory
                .hosts
                .iter()
                .find(|host| Some(&host.value.id.0) == connection.host_id.as_ref());
            if let Some(host) = host.filter(|host| available(&host.value, input.now_ms)) {
                deadline = deadline.min(host.value.health.valid_until.0);
            }
            let name = &member.member.display_name;
            let peer = Peer {
                connection_id: connection.connection_id.clone(),
                contributor_id: member.member.contributor_id.clone(),
                display_name: if name.trim().is_empty() {
                    member.member.contributor_id.clone()
                } else {
                    name.clone()
                },
                branch: connection.branch.clone(),
                file: connection.file.clone(),
                host: host.map(|host| HostLabel {
                    id: host.value.id.0.clone(),
                    name: host.value.name.clone(),
                }),
                summary: connection.summary.clone(),
                joins: joins::offers(input, connection),
            };
            peers.push((peer, connection.clone()));
        }
    }
    // A view must be refreshed before any displayed permission can expire.
    for offer in peers.iter().flat_map(|(peer, _)| &peer.joins) {
        if let Some(expiry) = input
            .directory
            .grants
            .iter()
            .find(|grant| grant.value.id.0 == offer.request.grant_id)
            .and_then(|grant| grant.value.expires_at)
        {
            deadline = deadline.min(expiry.0);
        }
    }
    peers.sort_by(|(left, _), (right, _)| {
        (
            &left.display_name,
            &left.contributor_id,
            &left.connection_id,
        )
            .cmp(&(
                &right.display_name,
                &right.contributor_id,
                &right.connection_id,
            ))
    });
    Ok(Projection {
        peers,
        valid_for_ms: deadline.saturating_sub(input.now_ms),
    })
}

fn validate(input: &AwarenessInput<'_>) -> Result<(), AwarenessError> {
    let editor = input.editor;
    let view = input.workspace;
    let directory = input.directory;
    let snapshot = WorkspaceSnapshot::try_from(directory)
        .map_err(|_invalid_directory| AwarenessError::Unavailable)?;
    let selected = &snapshot.workspace;
    if view.snapshot_state != WorkspaceRequestState::Ready
        || view.presence_state != WorkspaceRequestState::Ready
        || view.snapshot.as_ref() != Some(&snapshot)
        || view.repository_binding.as_ref() != Some(&editor.binding)
        || view.selected_workspace.as_ref() != Some(&editor.binding.workspace_id)
        || view.selected_repository.as_ref() != Some(&editor.binding.repository_id)
        || view.chain.as_ref() != Some(&editor.binding.chain)
        || selected.id != editor.binding.workspace_id
        || selected.chain != editor.binding.chain
        || selected.mode != editor.mode
        || !selected
            .repositories
            .iter()
            .any(|repo| repo.id == editor.binding.repository_id)
        || directory.as_of.contributor_id.0 != editor.contributor_id
        || editor.connection_id.is_empty()
        || !snapshot.members.iter().any(|member| {
            member.contributor_id == editor.contributor_id && member.status == MemberStatus::Active
        })
        || editor
            .host_id
            .as_ref()
            .is_some_and(|host| !snapshot.host_ids.contains(host))
        || editor
            .file
            .as_deref()
            .is_some_and(|file| !relative_file(file))
        || !unique(
            directory
                .grants
                .iter()
                .map(|grant| grant.value.id.0.as_str()),
        )
        || !unique(
            directory
                .sessions
                .iter()
                .map(|session| session.value.id.0.as_str()),
        )
        || !unique(
            view.members
                .iter()
                .map(|member| member.member.contributor_id.as_str()),
        )
        || view
            .members
            .iter()
            .any(|member| !snapshot.members.contains(&member.member))
    {
        return Err(AwarenessError::Unavailable);
    }
    Ok(())
}

fn unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .all(|id| !id.is_empty() && seen.insert(id))
}

fn visible(input: &AwarenessInput<'_>, connection: &PresenceEntry, contributor: &str) -> bool {
    connection.contributor_id == contributor
        && connection.connection_id != input.editor.connection_id
        && !connection.connection_id.is_empty()
        && connection.repository_id.as_ref() == Some(&input.editor.binding.repository_id)
        && matches!(
            connection.status,
            PresenceStatus::Online | PresenceStatus::Away
        )
        && connection.observed_at_ms <= input.now_ms
        && input.now_ms < connection.valid_until_ms
        && connection.file.as_deref().is_none_or(relative_file)
        && connection.host_id.as_ref().is_none_or(|id| {
            input
                .directory
                .hosts
                .iter()
                .any(|host| &host.value.id.0 == id)
        })
}

pub(super) fn available(host: &ComputeHost, now_ms: u64) -> bool {
    host.health.availability == Availability::Available
        && host.health.observed_at.0 <= now_ms
        && now_ms < host.health.valid_until.0
        && !host.routes.is_empty()
        && host
            .routes
            .iter()
            .all(|route| !route.protocol.trim().is_empty() && !route.reference.trim().is_empty())
}

fn relative_file(file: &str) -> bool {
    !file.is_empty()
        && !file.contains(['\\', '\0'])
        && file
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}
