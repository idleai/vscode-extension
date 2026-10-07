//! Native projection and resource directories use the Rust view model's status.

use app_core::{
    ViewModel,
    projections::{FreshnessStatus, ProjectionAvailability, ProjectionLoadState},
    resources::{ModelProviderKind, ResourceAvailability, ResourceLoadState},
    workspace::NavigationSection,
};

use super::{Row, Tree, destination, item_destination, key};

pub(super) fn projections(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.projections");
    if view.workspace.selected_workspace.is_none() {
        tree.notice("Select a workspace", false);
        return tree;
    }
    for (projection, title) in [
        (&view.projections.tasks, "Tasks"),
        (&view.projections.errors, "Errors"),
        (&view.projections.triage, "Triage"),
        (&view.projections.need_input, "Human input"),
    ] {
        if projection.availability == ProjectionAvailability::Unavailable {
            continue;
        }
        let mut row = Row::new(
            key(view, tree.id, &format!("{:?}", projection.kind)),
            title.into(),
            "list-tree",
            destination(view, NavigationSection::Projections),
        )
        .describe(
            projection
                .total
                .map_or_else(|| "Total unknown".into(), |total| total.to_string()),
        );
        let freshness = match projection.freshness.status {
            FreshnessStatus::Unknown => "Freshness unknown",
            FreshnessStatus::Current => "Current",
            FreshnessStatus::Stale => "Stale",
        };
        let completeness = match projection.availability {
            ProjectionAvailability::Complete => "Complete",
            ProjectionAvailability::Partial => "Partial results",
            ProjectionAvailability::Unavailable => "Unavailable",
        };
        row.tooltip = format!(
            "{}\n{freshness} · {completeness} · {} loaded",
            row.tooltip, projection.loaded_count
        );
        if projection.freshness.status == FreshnessStatus::Stale {
            row.color = Some("charts.yellow");
        }
        tree.rows.push(row);
    }
    match &view.projections.load {
        ProjectionLoadState::Idle => tree.notice("Projections not connected", false),
        ProjectionLoadState::Loading => tree.notice("Loading projections…", false),
        ProjectionLoadState::Suspended => tree.notice("Waiting to reconnect", false),
        ProjectionLoadState::Failed(error) => tree.notice(&error.message, true),
        ProjectionLoadState::Ready if tree.rows.is_empty() => {
            tree.notice("No projections available", false);
        }
        ProjectionLoadState::Ready => {}
    }
    tree
}

pub(super) fn hosts(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.computeHosts");
    for row in &view.resources.hosts {
        let mut item = Row::new(
            key(view, tree.id, &row.host.id),
            row.host.name.clone(),
            "server",
            item_destination(view, NavigationSection::ComputeHosts, "host", &row.host.id),
        )
        .describe(availability(row.availability).0.into());
        item.color = availability(row.availability).1;
        tree.rows.push(item);
    }
    resource_feedback(&mut tree, view);
    tree
}

pub(super) fn providers(view: &ViewModel) -> Tree {
    let mut tree = Tree::new("idle.modelProviders");
    for row in &view.resources.providers {
        let kind = match row.provider.kind {
            ModelProviderKind::External => "External",
            ModelProviderKind::Local { .. } => "Local",
        };
        let (status, color) = availability(row.availability);
        let mut item = Row::new(
            key(view, tree.id, &row.provider.id),
            row.provider.name.clone(),
            "sparkle",
            item_destination(
                view,
                NavigationSection::ModelProviders,
                "provider",
                &row.provider.id,
            ),
        )
        .describe(format!("{kind} · {status}"));
        item.color = color;
        tree.rows.push(item);
    }
    resource_feedback(&mut tree, view);
    tree
}

fn availability(value: ResourceAvailability) -> (&'static str, Option<&'static str>) {
    match value {
        ResourceAvailability::Unknown => ("Availability unknown", None),
        ResourceAvailability::Available => ("Available", Some("charts.green")),
        ResourceAvailability::Unavailable => ("Unavailable", Some("errorForeground")),
    }
}

fn resource_feedback(tree: &mut Tree, view: &ViewModel) {
    if view.workspace.selected_workspace.is_none() {
        tree.rows.clear();
        tree.notice("Select a workspace", false);
        return;
    }
    match &view.resources.load {
        ResourceLoadState::Idle => tree.notice("Resources not connected", false),
        ResourceLoadState::Loading => tree.notice("Loading resources…", false),
        ResourceLoadState::Suspended => tree.notice("Waiting to reconnect", false),
        ResourceLoadState::Failed(error) => tree.notice(&error.message, true),
        ResourceLoadState::Ready if tree.rows.is_empty() => {
            tree.notice("No publications in this workspace", false);
        }
        ResourceLoadState::Ready => {}
    }
    if let Some(error) = &view.resources.action_error {
        tree.notice(&error.message, true);
    }
}
