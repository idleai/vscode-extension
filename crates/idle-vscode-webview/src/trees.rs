//! Presentation records for workbench-owned trees. No HTML crosses this boundary.

use app_core::{ViewModel, workspace::NavigationSection};
use serde::Serialize;
use serde_json::{Value, json};

mod directories;
mod sessions;
mod workspace;

#[derive(Clone, Debug)]
pub(crate) enum Action {
    Workspace(String),
    Detail(Value),
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Row {
    pub id: String,
    pub label: String,
    pub description: String,
    pub tooltip: String,
    pub icon: &'static str,
    pub color: Option<&'static str>,
    pub context: &'static str,
    pub actionable: bool,
    pub selected: bool,
    #[serde(skip)]
    pub action: Option<Action>,
}

impl Row {
    fn new(id: String, label: String, icon: &'static str, action: Option<Action>) -> Self {
        let actionable = action.is_some();
        Self {
            id,
            tooltip: label.clone(),
            label,
            icon,
            action,
            actionable,
            description: String::new(),
            color: None,
            context: "idle.item",
            selected: false,
        }
    }

    fn describe(mut self, description: String) -> Self {
        self.tooltip = format!("{}\n{description}", self.label);
        self.description = description;
        self
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct Tree {
    pub id: &'static str,
    pub rows: Vec<Row>,
}

impl Tree {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            rows: Vec::new(),
        }
    }

    fn notice(&mut self, message: &str, error: bool) {
        if message.is_empty() {
            return;
        }
        let mut row = Row::new(
            format!("{}:notice:{}", self.id, self.rows.len()),
            message.into(),
            if error { "warning" } else { "info" },
            None,
        );
        row.context = "idle.notice";
        if error {
            row.color = Some("problemsWarningIcon.foreground");
        }
        self.rows.push(row);
    }
}

pub(crate) fn snapshot(view: &ViewModel) -> Vec<Tree> {
    vec![
        workspace::workspaces(view),
        workspace::users(view),
        sessions::sessions(view),
        directories::projections(view),
        directories::hosts(view),
        directories::providers(view),
    ]
}

fn key(view: &ViewModel, section: &str, id: &str) -> String {
    format!(
        "{section}:{}",
        json!([view.workspace.repository_binding, id])
    )
}

fn destination(view: &ViewModel, section: NavigationSection) -> Option<Action> {
    view.workspace.repository_binding.as_ref().map(|binding| {
        Action::Detail(json!({
            "binding": binding, "section": section,
        }))
    })
}

fn item_destination(
    view: &ViewModel,
    section: NavigationSection,
    field: &str,
    id: &str,
) -> Option<Action> {
    match destination(view, section) {
        Some(Action::Detail(mut target)) => {
            let _old = target.as_object_mut()?.insert(field.into(), json!(id));
            Some(Action::Detail(target))
        }
        Some(Action::Workspace(_)) | None => None,
    }
}
