//! Typed projection of the local coordinator's exact JSON responses.

mod reads;
mod recovery;

use app_core::{
    Effect, Event, ViewModel, configuration, projections, resources, subscriptions, workspace,
};
use idle_protocol::v1::events::RecoveryCursor;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct Adapter {
    pub(crate) enabled: bool,
    context: Option<subscriptions::Context>,
    pub(crate) now_ms: Option<u64>,
    latest_join: Option<String>,
    connections: BTreeMap<String, RecoveryCursor>,
}

impl Adapter {
    pub(crate) fn route(&mut self, effect: &Effect, view: &ViewModel, id: &str) -> Option<Value> {
        if !self.enabled {
            return None;
        }
        let (command, watch) = match effect {
            Effect::Workspace(request) => match &request.operation {
                workspace::WorkspaceOperation::Snapshot {
                    mode: workspace::WorkspaceMode::Standalone,
                    ..
                } => (json!({"kind":"snapshot"}), false),
                workspace::WorkspaceOperation::Presence {
                    mode: workspace::WorkspaceMode::Standalone,
                    ..
                } => (json!({"kind":"presence"}), false),
                workspace::WorkspaceOperation::List
                | workspace::WorkspaceOperation::Snapshot { .. }
                | workspace::WorkspaceOperation::Presence { .. } => return None,
            },
            Effect::Resource(request)
                if request.operation.kind == resources::ResourceOperationKind::Snapshot =>
            {
                (json!({"kind":"snapshot"}), false)
            }
            Effect::Configuration(request)
                if request.operation.action == configuration::ConfigurationAction::Load =>
            {
                (json!({"kind":"snapshot"}), false)
            }
            Effect::Subscription(request) => match &request.operation.action {
                subscriptions::SubscriptionAction::Join => (json!({"kind":"snapshot"}), false),
                subscriptions::SubscriptionAction::Watch { connection } => (
                    json!({"kind":"catch_up", "data": {"after": self.connections.get(connection)?, "limit":256}}),
                    true,
                ),
                subscriptions::SubscriptionAction::Wait { .. }
                | subscriptions::SubscriptionAction::Leave { .. } => return None,
            },
            Effect::Render(_)
            | Effect::HostInfo(_)
            | Effect::History(_)
            | Effect::Session(_)
            | Effect::Projection(_)
            | Effect::Resource(_)
            | Effect::Configuration(_) => return None,
        };
        let binding = binding(effect, view)?;
        if matches!(effect, Effect::Subscription(request) if request.operation.action == subscriptions::SubscriptionAction::Join)
        {
            self.latest_join = Some(id.into());
        }
        Some(json!({"binding":binding, "command":command.to_string(), "watch":watch}))
    }

    pub(crate) fn decode(
        &mut self,
        effect: &Effect,
        value: Value,
        id: &str,
        view: &ViewModel,
    ) -> Result<Option<Value>, String> {
        let Some(raw) = value.get("native").and_then(Value::as_str) else {
            return Ok(Some(value));
        };
        let envelope: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
        let data = envelope
            .get("result")
            .and_then(|result| result.get("Ok"))
            .ok_or("Invalid coordinator result")?;
        let now = value
            .get("now_ms")
            .and_then(Value::as_u64)
            .ok_or("Missing coordinator clock")?;
        self.now_ms = Some(self.now_ms.unwrap_or(0).max(now));
        match effect {
            Effect::Workspace(request) => self
                .workspace(&request.operation, data.clone(), now, view)
                .map(Some),
            Effect::Resource(request) => {
                reads::resource(&request.operation, data.clone(), now).map(Some)
            }
            Effect::Configuration(request) => {
                reads::configuration(&request.operation, data.clone()).map(Some)
            }
            Effect::Subscription(request) => {
                self.subscription(&request.operation, data.clone(), id, view)
            }
            Effect::Render(_)
            | Effect::HostInfo(_)
            | Effect::History(_)
            | Effect::Session(_)
            | Effect::Projection(_) => Err("Unexpected coordinator response".into()),
        }
    }

    pub(crate) fn connect(&self, view: &ViewModel) -> Vec<Event> {
        let Some(context) = self.context.as_ref().filter(|context| {
            view.workspace
                .repository_binding
                .as_ref()
                .is_some_and(|binding| {
                    binding.workspace_id == context.workspace && binding.chain == context.chain
                })
                && view.subscriptions.context.as_ref() != Some(*context)
        }) else {
            return Vec::new();
        };
        let resource = resources::ResourceContext {
            provider: context.provider.clone(),
            workspace_id: context.workspace.clone(),
            contributor_id: context.contributor.clone(),
            chain: context.chain.clone(),
            mode: workspace::WorkspaceMode::Standalone,
        };
        let configuration = configuration::ConfigurationContext {
            provider: resource.provider.clone(),
            workspace_id: resource.workspace_id.clone(),
            contributor_id: resource.contributor_id.clone(),
            chain: resource.chain.clone(),
            mode: resource.mode,
        };
        vec![
            Event::Subscriptions(subscriptions::Event::Connect(context.clone())),
            Event::Projections(projections::Event::Connect(context.clone())),
            Event::Resources(resources::Event::Connect(resource)),
            Event::Configuration(configuration::Event::Connect(configuration)),
        ]
    }
}

fn binding(effect: &Effect, view: &ViewModel) -> Option<workspace::RepositoryChainBinding> {
    if let Effect::Workspace(request) = effect {
        let id = match &request.operation {
            workspace::WorkspaceOperation::Snapshot { workspace_id, .. }
            | workspace::WorkspaceOperation::Presence { workspace_id, .. } => workspace_id,
            workspace::WorkspaceOperation::List => return None,
        };
        let info = view
            .workspace
            .workspaces
            .iter()
            .find(|info| &info.id == id)?;
        if info.mode != workspace::WorkspaceMode::Standalone || info.repositories.len() != 1 {
            return None;
        }
        return Some(workspace::RepositoryChainBinding {
            workspace_id: info.id.clone(),
            repository_id: info.repositories.first()?.id.clone(),
            chain: info.chain.clone(),
        });
    }
    view.workspace.repository_binding.clone()
}

#[cfg(test)]
mod tests;
