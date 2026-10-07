//! Control-first native session rows without inferred runner execution status.

use app_core::{
    ViewModel,
    repository::RepositoryLoadState,
    resources::{ControllerAssignment, ControllerPhase},
    sessions::{SessionKind, SessionLoadState, SessionRelationship},
    workspace::NavigationSection,
};

use super::{Row, Tree, destination, item_destination, key};

pub(super) fn sessions(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.sessions");
    if view.workspace.selected_workspace.is_none() {
        tree.notice("Select a workspace", false);
        return tree;
    }
    let control = controller(view);
    if !view
        .sessions
        .sessions
        .iter()
        .any(|row| row.session.kind == SessionKind::Control)
    {
        tree.rows.push(
            Row::new(
                key(view, tree.id, "control"),
                "Control model".into(),
                "hubot",
                destination(view, NavigationSection::Sessions),
            )
            .describe(format!("Ambient · {control}")),
        );
    }
    for kind in [SessionKind::Control, SessionKind::Runner] {
        for row in view
            .sessions
            .sessions
            .iter()
            .filter(|row| row.session.kind == kind)
        {
            let description = if kind == SessionKind::Control {
                format!("Ambient · {control}")
            } else {
                match row.relationship {
                    SessionRelationship::Owned => "Owned".into(),
                    SessionRelationship::Invited => "Invited".into(),
                }
            };
            tree.rows.push(
                Row::new(
                    key(view, tree.id, &row.session.id),
                    row.session.title.clone(),
                    if kind == SessionKind::Control {
                        "hubot"
                    } else {
                        "terminal"
                    },
                    item_destination(
                        view,
                        NavigationSection::Sessions,
                        "session",
                        &row.session.id,
                    ),
                )
                .describe(description),
            );
        }
    }
    recorded(&mut tree, view);
    match &view.sessions.load {
        SessionLoadState::Idle if view.repository.context.is_some() => {}
        SessionLoadState::Idle => tree.notice("Sessions not connected", false),
        SessionLoadState::Loading => tree.notice("Loading sessions…", false),
        SessionLoadState::Ready => {}
        SessionLoadState::Failed(error) => tree.notice(&error.message, true),
    }
    if let SessionLoadState::Failed(error) = &view.sessions.updates {
        tree.notice(&error.message, true);
    }
    if let Some(error) = &view.sessions.action_error {
        tree.notice(&error.message, true);
    }
    tree
}

fn recorded(tree: &mut Tree, view: &ViewModel) {
    if let Some(snapshot) = &view.repository.snapshot {
        for session in &snapshot.sessions {
            let mut row = Row::new(
                key(view, "idle.sessions.recorded", &session.id),
                session
                    .labels
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "Untitled recorded session".into()),
                "history",
                item_destination(
                    view,
                    NavigationSection::Sessions,
                    "recorded_session",
                    &session.id,
                ),
            )
            .describe("Recorded".into());
            row.tooltip = format!(
                "{}\n{}\n{}\n{}",
                row.tooltip,
                session.id,
                session.actions.join(", "),
                session.sources.join("\n")
            );
            tree.rows.push(row);
        }
    }
    match &view.repository.load {
        RepositoryLoadState::Loading if view.repository.snapshot.is_none() => {
            tree.notice("Loading recorded sessions…", false);
        }
        RepositoryLoadState::Suspended => {
            tree.notice("Recorded sessions waiting to reconnect", false);
        }
        RepositoryLoadState::Failed(error) => tree.notice(&error.message, true),
        RepositoryLoadState::Idle | RepositoryLoadState::Ready | RepositoryLoadState::Loading => {}
    }
}

fn controller(view: &ViewModel) -> String {
    match &view.resources.controller.phase {
        ControllerPhase::Unknown => match view.resources.controller.assignment {
            ControllerAssignment::Unknown => "Status unknown",
            ControllerAssignment::Unassigned => "Unassigned",
            ControllerAssignment::Assigned => "Assigned · runtime unknown",
            ControllerAssignment::Expired => "Lease expired",
        }
        .into(),
        ControllerPhase::Starting => "Starting".into(),
        ControllerPhase::Running => "Running".into(),
        ControllerPhase::Paused => "Paused".into(),
        ControllerPhase::Stopped => "Stopped".into(),
        ControllerPhase::Failed(message) => format!("Error: {message}"),
    }
}
