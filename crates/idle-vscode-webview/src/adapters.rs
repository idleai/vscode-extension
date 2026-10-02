//! Persistent Crux continuations and the extension's typed effect boundary.

use std::collections::BTreeMap;

use app_core::{Core, Effect, Event, ViewModel, effects::HostInfo};
use crux_core::{Request, capability::Operation};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use web_ui::host::{HostCapabilities, HostCapability, HostKind};

use crate::bridge::BridgeError;

/// One platform call. Its identity is valid only in this document.
#[derive(Clone, Debug, PartialEq, Eq)]
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
        }
    }
}

impl Runtime {
    /// Current shared view, without transport or platform state.
    #[must_use]
    pub fn view(&self) -> ViewModel {
        self.core.view()
    }

    /// Presentation hints negotiated with the host, denied before its handshake.
    #[must_use]
    pub fn capabilities(&self) -> HostCapabilities {
        self.capabilities.clone()
    }

    /// Retire all scoped state immediately while a new handshake is pending.
    pub fn invalidate(&mut self) {
        self.pending.clear();
        self.core = Core::new();
        self.capabilities = HostCapabilities::new(HostKind::VsCode);
    }

    /// Start or reset after account, trust or workspace configuration changes.
    ///
    /// # Errors
    /// Returns a serialization or Crux continuation failure.
    pub fn ready(&mut self, value: &Value) -> Result<Vec<Call>, String> {
        self.invalidate();
        self.capabilities = capabilities(value);
        let mut calls = self.dispatch(Event::Start)?;
        calls.extend(self.dispatch(Event::Workspace(app_core::workspace::Event::Load))?);
        Ok(calls)
    }

    /// Apply a user action and retain every resulting continuation.
    ///
    /// # Errors
    /// Returns a serialization or Crux continuation failure.
    pub fn dispatch(&mut self, event: Event) -> Result<Vec<Call>, String> {
        self.enqueue(self.core.process_event(event))
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
        let Some(mut effect) = self.pending.remove(id) else {
            return Ok(Vec::new());
        };
        let failure = unavailable(
            &effect,
            result
                .as_ref()
                .err()
                .map_or("The host returned an invalid response.", |error| {
                    error.message.as_str()
                }),
        );
        let value = result.unwrap_or_else(|_error| failure.clone());
        let effects = match &mut effect {
            Effect::Workspace(request) => resolve(&self.core, request, value, failure),
            Effect::History(request) => resolve(&self.core, request, value, failure),
            Effect::Subscription(request) => resolve(&self.core, request, value, failure),
            Effect::Session(request) => resolve(&self.core, request, value, failure),
            Effect::Projection(request) => resolve(&self.core, request, value, failure),
            Effect::Resource(request) => resolve(&self.core, request, value, failure),
            Effect::Configuration(request) => resolve(&self.core, request, value, failure),
            Effect::Render(_) | Effect::HostInfo(_) => Ok(Vec::new()),
        }?;
        self.enqueue(effects)
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
            let (method, operation) = match &effect {
                Effect::Workspace(request) => ("app.workspace", json!(request.operation)),
                Effect::History(request) => ("app.history", json!(request.operation)),
                Effect::Subscription(request) => ("app.subscription", json!(request.operation)),
                Effect::Session(request) => ("app.session", json!(request.operation)),
                Effect::Projection(request) => ("app.projection", json!(request.operation)),
                Effect::Resource(request) => ("app.resource", json!(request.operation)),
                Effect::Configuration(request) => ("app.configuration", json!(request.operation)),
                Effect::Render(_) | Effect::HostInfo(_) => continue,
            };
            self.next = self
                .next
                .checked_add(1)
                .ok_or("Host request identities exhausted")?;
            let id = format!("app:{}", self.next);
            calls.push(Call { id: id.clone(), method, params: json!({
                "operation": operation, "binding": self.core.view().workspace.repository_binding,
            }) });
            let _previous = self.pending.insert(id, effect);
        }
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
        Effect::History(_) | Effect::Projection(_) | Effect::HostInfo(_) | Effect::Render(_) => {
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
