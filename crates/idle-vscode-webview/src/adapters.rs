//! Persistent Crux continuations and the extension's typed effect boundary.

use std::collections::BTreeMap;

use app_core::{Core, Effect, Event, ViewModel, effects::HostInfo};
use crux_core::{Request, capability::Operation};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use web_ui::host::{HostCapabilities, HostCapability, HostKind};

use crate::bridge::BridgeError;

mod drafts;
mod navigation;
mod reconnect;
#[cfg(test)]
mod startup_tests;

/// One platform call. Its identity is valid only in this document.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Call {
    /// Monotonic transport identity, never reused across context resets.
    pub id: String,
    /// Allowlisted host adapter.
    pub method: &'static str,
    /// Serialized app-core operation and explicit repository selection.
    pub params: Value,
}

/// The application survives renders; closing a document drops only its reads.
pub struct Runtime {
    core: Core,
    pending: BTreeMap<String, Effect>,
    next: u64,
    capabilities: HostCapabilities,
    coordination: crate::coordination::Adapter,
    drafts: drafts::State,
    reconnect: Option<app_core::workspace::RepositoryChainBinding>,
    navigation: Option<navigation::Target>,
    projection_started: Option<app_core::subscriptions::Context>,
    native_views: bool,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Runtime")
            .field("pending", &self.pending.len())
            .finish_non_exhaustive()
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            core: Core::new(),
            pending: BTreeMap::new(),
            next: 0,
            capabilities: HostCapabilities::new(HostKind::VsCode),
            coordination: crate::coordination::Adapter::default(),
            drafts: drafts::State::default(),
            reconnect: None,
            navigation: None,
            projection_started: None,
            native_views: false,
        }
    }
}

impl Runtime {
    /// Current shared view, without transport or platform state.
    #[must_use]
    pub fn view(&self) -> ViewModel {
        self.core.view()
    }

    /// Latest coordinator clock for freshness labels, without inventing runtime state.
    #[must_use]
    pub const fn now_ms(&self) -> Option<u64> {
        self.coordination.now_ms
    }

    /// Presentation hints negotiated with the host, denied before its handshake.
    #[must_use]
    pub fn capabilities(&self) -> HostCapabilities {
        self.capabilities.clone()
    }

    /// Retire all scoped state immediately while a new handshake is pending.
    pub fn invalidate(&mut self) {
        self.remember_workspace();
        self.pending.clear();
        self.core = Core::new();
        self.capabilities = HostCapabilities::new(HostKind::VsCode);
        self.coordination = crate::coordination::Adapter::default();
        self.drafts = drafts::State::default();
        self.navigation = None;
        self.projection_started = None;
        self.native_views = false;
    }

    /// Start or reset after account, trust or workspace configuration changes.
    ///
    /// # Errors
    /// Returns a serialization or Crux continuation failure.
    pub fn ready(&mut self, value: &Value) -> Result<Vec<Call>, String> {
        self.invalidate();
        self.capabilities = capabilities(value);
        self.configure_drafts(value);
        self.native_views = value
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|methods| methods.iter().any(|method| method == "views.openDetail"));
        self.coordination.enabled = value
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("app.coordination"))
            });
        self.coordination.repository_enabled = value
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("app.repository"))
            });
        let mut calls = self.dispatch(Event::Start)?;
        calls.extend(self.dispatch(Event::Workspace(app_core::workspace::Event::Load))?);
        Ok(calls)
    }

    /// Apply a user action and retain every resulting continuation.
    ///
    /// # Errors
    /// Returns a serialization or Crux continuation failure.
    pub fn dispatch(&mut self, event: Event) -> Result<Vec<Call>, String> {
        if matches!(
            &event,
            Event::Workspace(
                app_core::workspace::Event::Navigate(_)
                    | app_core::workspace::Event::SelectWorkspace(_)
            )
        ) {
            self.navigation = None;
        }
        if matches!(
            event,
            Event::Configuration(app_core::configuration::Event::Refresh)
        ) {
            self.drafts.retry_load();
        }
        self.enqueue(self.core.process_event(event))
    }

    /// Reconcile a local change only when it belongs to the current binding.
    /// These invalidations are hints; app-core performs authoritative reads.
    ///
    /// # Errors
    /// Returns malformed notification or Crux continuation errors.
    pub fn history_changed(&mut self, params: &Value) -> Result<Vec<Call>, String> {
        let binding: app_core::workspace::RepositoryChainBinding = serde_json::from_value(
            params
                .get("binding")
                .cloned()
                .ok_or("History notification requires a binding")?,
        )
        .map_err(|error| error.to_string())?;
        if self.core.view().workspace.repository_binding.as_ref() != Some(&binding) {
            return Ok(Vec::new());
        }
        let mut calls = self.dispatch(Event::History(app_core::history::Event::Refresh))?;
        calls.extend(self.dispatch(Event::Projections(app_core::projections::Event::Changed))?);
        calls.extend(self.dispatch(Event::Repository(app_core::repository::Event::Changed))?);
        Ok(calls)
    }

    /// Resolve a matching host response; retired or duplicate responses do nothing.
    /// Malformed success payloads become visible domain failures.
    ///
    /// # Errors
    /// Returns a serialization or Crux continuation failure.
    pub fn receive(
        &mut self,
        id: &str,
        result: Result<Value, BridgeError>,
    ) -> Result<Vec<Call>, String> {
        if self.drafts.has_request(id) {
            return self.receive_drafts(id, result);
        }
        let Some(mut effect) = self.pending.remove(id) else {
            return Ok(Vec::new());
        };
        let workspace_directory = matches!(&effect, Effect::Workspace(request)
            if request.operation == app_core::workspace::WorkspaceOperation::List);
        let mut failure = unavailable(
            &effect,
            result
                .as_ref()
                .err()
                .map_or("The host returned an invalid response.", |error| {
                    error.message.as_str()
                }),
        );
        if self.coordination.enabled
            && matches!(&effect, Effect::Subscription(_))
            && result.as_ref().is_err_and(|error| {
                matches!(error.code.as_str(), "unavailable" | "host_timeout" | "busy")
            })
            && let Some(kind) = failure.pointer_mut("/Err/kind")
        {
            *kind = json!("Transport");
        }
        let mut value = result.unwrap_or_else(|_error| failure.clone());
        let local = matches!(&effect, Effect::Repository(_) | Effect::Projection(_))
            .then(|| value.get("local").cloned())
            .flatten();
        let local_repository = local.is_some() && matches!(&effect, Effect::Repository(_));
        let local_projection = local.is_some() && matches!(&effect, Effect::Projection(_));
        if let Some(local) = local {
            value = local;
        }
        let value = match self
            .coordination
            .decode(&effect, value, id, &self.core.view())
        {
            Ok(Some(value)) => value,
            Ok(None) => {
                let mut effects = self.tick();
                effects.extend(self.core.process_event(Event::Workspace(
                    app_core::workspace::Event::RefreshPresence,
                )));
                effects.push(effect);
                return self.enqueue(effects);
            }
            Err(message) => unavailable(&effect, &message),
        };
        let refresh_workspace = matches!(&effect, Effect::Subscription(_))
            && value
                .get("Ok")
                .is_some_and(|value| value == "Changed" || value.get("Joined").is_some());
        let mut effects = match &mut effect {
            Effect::Workspace(request) => resolve(&self.core, request, value, failure),
            Effect::History(request) => resolve(&self.core, request, value, failure),
            Effect::Subscription(request) => resolve(&self.core, request, value, failure),
            Effect::Session(request) => resolve(&self.core, request, value, failure),
            Effect::Projection(request) => resolve(&self.core, request, value, failure),
            Effect::Resource(request) => resolve(&self.core, request, value, failure),
            Effect::Configuration(request) => resolve(&self.core, request, value, failure),
            Effect::Repository(request) => resolve(&self.core, request, value, failure),
            Effect::Render(_) | Effect::HostInfo(_) => Ok(Vec::new()),
        }?;
        if workspace_directory {
            effects.extend(self.restore_workspace());
        }
        if local_repository
            && self.core.view().repository.load == app_core::repository::RepositoryLoadState::Ready
        {
            effects.extend(
                self.core
                    .process_event(Event::Repository(app_core::repository::Event::Changed)),
            );
        }
        effects.extend(self.tick());
        if refresh_workspace {
            effects.extend(self.core.process_event(Event::Workspace(
                app_core::workspace::Event::RefreshWorkspace,
            )));
            effects.extend(self.core.process_event(Event::Workspace(
                app_core::workspace::Event::RefreshPresence,
            )));
        }
        if local_projection
            && self.core.view().projections.load
                == app_core::projections::ProjectionLoadState::Ready
        {
            effects.extend(
                self.core
                    .process_event(Event::Projections(app_core::projections::Event::Changed)),
            );
        }
        for event in self.coordination.connect(&self.core.view()) {
            effects.extend(self.core.process_event(event));
        }
        effects.extend(self.apply_navigation());
        self.enqueue(effects)
    }

    fn tick(&self) -> Vec<Effect> {
        let Some(now) = self.coordination.now_ms else {
            return Vec::new();
        };
        [
            Event::Workspace(app_core::workspace::Event::Tick(now)),
            Event::Resources(app_core::resources::Event::AdvanceClock(now)),
            Event::Sessions(app_core::sessions::Event::Tick(now)),
        ]
        .into_iter()
        .flat_map(|event| self.core.process_event(event))
        .collect()
    }

    fn enqueue(&mut self, mut effects: Vec<Effect>) -> Result<Vec<Call>, String> {
        let mut calls = Vec::new();
        while let Some(effect) = effects.pop() {
            if let Effect::HostInfo(mut request) = effect {
                effects.extend(
                    self.core
                        .resolve(
                            &mut request,
                            Ok(HostInfo {
                                name: "Idle VS Code".to_owned(),
                                version: env!("CARGO_PKG_VERSION").to_owned(),
                            }),
                        )
                        .map_err(|error| error.to_string())?,
                );
                continue;
            }
            let (mut method, operation) = match &effect {
                Effect::Workspace(request) => ("app.workspace", json!(request.operation)),
                Effect::History(request) => ("app.history", json!(request.operation)),
                Effect::Subscription(request) => ("app.subscription", json!(request.operation)),
                Effect::Session(request) => ("app.session", json!(request.operation)),
                Effect::Projection(request) => ("app.projection", json!(request.operation)),
                Effect::Resource(request) => ("app.resource", json!(request.operation)),
                Effect::Configuration(request) => ("app.configuration", json!(request.operation)),
                Effect::Repository(request) => ("app.repository", json!(request.operation)),
                Effect::Render(_) | Effect::HostInfo(_) => continue,
            };
            self.next = self
                .next
                .checked_add(1)
                .ok_or("Host request identities exhausted")?;
            let id = format!("app:{}", self.next);
            let mut params = if let Some(params) =
                self.coordination.route(&effect, &self.core.view(), &id)
            {
                method = "app.coordination";
                params
            } else {
                json!({"operation": operation, "binding": self.core.view().workspace.repository_binding})
            };
            let initial = match &effect {
                Effect::Repository(request)
                    if request.operation.action == app_core::repository::RepositoryAction::Read =>
                {
                    Some(self.core.view().repository.snapshot.is_none())
                }
                Effect::Projection(request) => {
                    let first = self.projection_started.as_ref()
                        != Some(&request.operation.context)
                        && !request.operation.refresh_sources;
                    self.projection_started = Some(request.operation.context.clone());
                    Some(first)
                }
                Effect::Render(_)
                | Effect::HostInfo(_)
                | Effect::History(_)
                | Effect::Workspace(_)
                | Effect::Subscription(_)
                | Effect::Session(_)
                | Effect::Resource(_)
                | Effect::Configuration(_)
                | Effect::Repository(_) => None,
            };
            if let Some(initial) = initial {
                let _previous = params
                    .as_object_mut()
                    .ok_or("Host request requires an object")?
                    .insert("initial".into(), json!(initial));
            }
            calls.push(Call {
                id: id.clone(),
                method,
                params,
            });
            let _previous = self.pending.insert(id, effect);
        }
        calls.extend(self.collect_drafts());
        Ok(calls)
    }
}

fn resolve<O: Operation>(
    core: &Core,
    request: &mut Request<O>,
    value: Value,
    failure: Value,
) -> Result<Vec<Effect>, String>
where
    O::Output: DeserializeOwned,
{
    let output = serde_json::from_value(value)
        .or_else(|_error| serde_json::from_value(failure))
        .map_err(|error| error.to_string())?;
    core.resolve(request, output)
        .map_err(|error| error.to_string())
}

fn unavailable(effect: &Effect, message: &str) -> Value {
    let error = match effect {
        Effect::Workspace(_) | Effect::Subscription(_) | Effect::Configuration(_) => {
            json!({ "kind": "Unavailable", "message": message })
        }
        Effect::Session(_) | Effect::Resource(_) => {
            json!({ "code": "Unavailable", "message": message, "retry": "Never" })
        }
        Effect::History(_)
        | Effect::Projection(_)
        | Effect::Repository(_)
        | Effect::HostInfo(_)
        | Effect::Render(_) => {
            json!({ "message": message })
        }
    };
    json!({ "Err": error })
}

fn capabilities(value: &Value) -> HostCapabilities {
    let mut result = HostCapabilities::new(HostKind::VsCode);
    let methods = value.get("capabilities").and_then(Value::as_array);
    for (method, capability) in [
        ("clipboard.write", HostCapability::CopyText),
        ("external.open", HostCapability::OpenExternal),
        ("history.openQuery", HostCapability::OpenRecord),
        ("history.openQuery", HostCapability::OpenOperationJson),
        ("history.openQuery", HostCapability::OpenOriginal),
        ("history.openQuery", HostCapability::OpenFile),
        ("history.openQuery", HostCapability::OpenDiff),
    ] {
        if methods.is_some_and(|methods| methods.iter().any(|value| value.as_str() == Some(method)))
        {
            result = result.with(capability);
        }
    }
    result
}

#[cfg(test)]
mod tests;
