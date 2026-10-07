//! Workspace choice and contributor rows retain their recorded identities.

use app_core::{
    ViewModel,
    workspace::{MemberStatus, NavigationSection, PresenceStatus, WorkspaceRequestState},
};
use serde_json::json;

use super::{Action, Row, Tree, destination, key};

pub(super) fn workspaces(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.workspace");
    for workspace in &view.workspace.workspaces {
        let selected = view.workspace.selected_workspace.as_ref() == Some(&workspace.id);
        let mut row = Row::new(
            format!(
                "workspace:{}",
                json!([
                    workspace.id,
                    workspace.chain,
                    workspace
                        .repositories
                        .iter()
                        .map(|repository| &repository.id)
                        .collect::<Vec<_>>()
                ])
            ),
            workspace.name.clone(),
            if selected { "check" } else { "root-folder" },
            Some(Action::Workspace(workspace.id.clone())),
        );
        row.selected = selected;
        row.context = "idle.workspace";
        if selected {
            let branch = view
                .repository
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.checkout.as_ref())
                .map(|checkout| checkout.branch.as_deref().unwrap_or("Detached HEAD"));
            let status = view.subscriptions.status.label();
            row = row.describe(
                branch.map_or_else(|| status.into(), |branch| format!("{branch} · {status}")),
            );
        }
        tree.rows.push(row);
    }
    request(
        &mut tree,
        &view.workspace.directory_state,
        "Loading workspaces…",
    );
    if view.workspace.directory_state == WorkspaceRequestState::Ready && tree.rows.is_empty() {
        tree.notice("Open a folder to select a workspace", false);
    }
    if let WorkspaceRequestState::Failed(error) = &view.workspace.snapshot_state {
        tree.notice(&error.message, true);
    }
    if let Some(error) = &view.workspace.selection_error {
        tree.notice(&error.message, true);
    }
    tree
}

pub(super) fn users(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.users");
    if view.workspace.selected_workspace.is_none() {
        tree.notice("Select a workspace", false);
        return tree;
    }
    for user in &view.workspace.members {
        let (status, color) = if user.member.status == MemberStatus::Revoked {
            ("Revoked", Some("errorForeground"))
        } else {
            match user.presence {
                PresenceStatus::Unknown => ("Online status unknown", None),
                PresenceStatus::Online => ("Online", Some("charts.green")),
                PresenceStatus::Away => ("Away", Some("charts.yellow")),
                PresenceStatus::Offline => ("Offline", None),
            }
        };
        let details = user
            .connections
            .iter()
            .map(|connection| {
                [
                    connection.summary.as_deref(),
                    connection.file.as_deref(),
                    connection.branch.as_deref(),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ")
            })
            .filter(|details| !details.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        let mut row = Row::new(
            key(view, tree.id, &user.member.contributor_id),
            user.member.display_name.clone(),
            "account",
            destination(view, NavigationSection::Members),
        )
        .describe(if details.is_empty() {
            status.into()
        } else {
            format!("{status} · {details}")
        });
        row.color = color;
        row.tooltip = format!(
            "{}\nContributor: {}",
            row.tooltip, user.member.contributor_id
        );
        tree.rows.push(row);
    }
    request(
        &mut tree,
        &view.workspace.presence_state,
        "Updating online status…",
    );
    if tree.rows.is_empty() {
        tree.notice("No users in this workspace", false);
    }
    tree
}

fn request(tree: &mut Tree, state: &WorkspaceRequestState, loading: &str) {
    match state {
        WorkspaceRequestState::Idle | WorkspaceRequestState::Loading => tree.notice(loading, false),
        WorkspaceRequestState::Ready => {}
        WorkspaceRequestState::Failed(error) => tree.notice(&error.message, true),
    }
}
