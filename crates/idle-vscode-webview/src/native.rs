//! Headless Rust entrypoint for native trees, independent of any webview lifetime.

use std::collections::BTreeMap;

use app_core::{Event, workspace::NavigationSection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    adapters::{Call, Runtime},
    bridge::BridgeError,
    trees::{self, Action, Tree},
};

#[cfg(test)]
mod tests;

/// One extension-host application runtime. JavaScript only executes its effects
/// and maps its presentation records onto the supported VS Code APIs.
#[derive(Debug, Default)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub struct NativeSidebar {
    runtime: Runtime,
    actions: BTreeMap<String, Action>,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "value")]
enum Input {
    Ready(Value),
    Reset,
    Reply {
        id: String,
        result: Result<Value, BridgeError>,
    },
    Workspace(Value),
    HistoryChanged(Value),
    Activate(String),
    Refresh(NavigationSection),
}

#[derive(Serialize)]
struct Update {
    trees: Vec<Tree>,
    calls: Vec<Call>,
    selection: Option<Value>,
    detail: Option<Value>,
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
impl NativeSidebar {
    /// Create a runtime with no selected folder or trusted host capabilities.
    #[must_use]
    #[cfg_attr(
        target_arch = "wasm32",
        wasm_bindgen::prelude::wasm_bindgen(constructor)
    )]
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a host reply or native control action and return tree records/effects.
    ///
    /// # Errors
    /// Returns malformed input, stale action or Crux continuation errors.
    pub fn update(&mut self, message: &str) -> Result<String, String> {
        let input: Input = serde_json::from_str(message).map_err(|error| error.to_string())?;
        let mut selection = None;
        let mut detail = None;
        let calls = match input {
            Input::Ready(value) => self.runtime.ready(&value)?,
            Input::Reset => {
                self.runtime.invalidate();
                Vec::new()
            }
            Input::Reply { id, result } => self.runtime.receive(&id, result)?,
            Input::Workspace(value) => self.runtime.synchronize_workspace(value)?,
            Input::HistoryChanged(value) => self.runtime.history_changed(&value)?,
            Input::Refresh(section) => self.refresh(section)?,
            Input::Activate(id) => match self
                .actions
                .get(&id)
                .cloned()
                .ok_or("This row changed. Select it again.")?
            {
                Action::Workspace(id) => {
                    let calls = self.runtime.dispatch(Event::Workspace(
                        app_core::workspace::Event::SelectWorkspace(id),
                    ))?;
                    selection = self
                        .runtime
                        .view()
                        .workspace
                        .repository_binding
                        .map(|binding| serde_json::json!(binding));
                    calls
                }
                Action::Detail(target) => {
                    detail = Some(target);
                    Vec::new()
                }
            },
        };
        let trees = trees::snapshot(&self.runtime.view());
        self.actions = trees
            .iter()
            .flat_map(|tree| tree.rows.iter())
            .filter_map(|row| row.action.clone().map(|action| (row.id.clone(), action)))
            .collect();
        serde_json::to_string(&Update {
            trees,
            calls,
            selection,
            detail,
        })
        .map_err(|error| error.to_string())
    }
}

impl NativeSidebar {
    fn refresh(&mut self, section: NavigationSection) -> Result<Vec<Call>, String> {
        let event = match section {
            NavigationSection::Workspace => Event::Workspace(app_core::workspace::Event::Load),
            NavigationSection::Members => {
                Event::Workspace(app_core::workspace::Event::RefreshWorkspace)
            }
            NavigationSection::Sessions => Event::Sessions(app_core::sessions::Event::Refresh),
            NavigationSection::Projections => {
                Event::Projections(app_core::projections::Event::Refresh)
            }
            NavigationSection::ComputeHosts | NavigationSection::ModelProviders => {
                Event::Resources(app_core::resources::Event::Refresh)
            }
            NavigationSection::Activity => Event::History(app_core::history::Event::Refresh),
            NavigationSection::Settings | NavigationSection::AgentRules => {
                Event::Configuration(app_core::configuration::Event::Refresh)
            }
        };
        let mut calls = self.runtime.dispatch(event)?;
        if section == NavigationSection::Sessions {
            calls.extend(
                self.runtime
                    .dispatch(Event::Repository(app_core::repository::Event::Refresh))?,
            );
        }
        if section == NavigationSection::Members {
            calls.extend(self.runtime.dispatch(Event::Workspace(
                app_core::workspace::Event::RefreshPresence,
            ))?);
        }
        Ok(calls)
    }
}
