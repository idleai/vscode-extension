//! Host persistence for independently scoped document drafts and retry identities.

use std::collections::BTreeMap;

use app_core::{
    Effect, Event,
    configuration::{
        ConfigurationContext, ConfigurationDocument, ConfigurationDraft, ConfigurationLoadState,
        ConfigurationRequest, Event as ConfigurationEvent,
    },
};
use serde_json::{Value, json};

use super::{BridgeError, Call, Runtime};

#[derive(Default)]
pub(super) struct State {
    enabled: bool,
    prefix: String,
    context: Option<ConfigurationContext>,
    phase: Recovery,
    error: Option<String>,
    sent: Option<String>,
    retained: Vec<ConfigurationDraft>,
    pending: BTreeMap<String, Pending>,
}

#[derive(Default, PartialEq, Eq)]
enum Recovery {
    #[default]
    Waiting,
    Loaded,
    Ready,
    Failed,
}

enum Pending {
    Load,
    Store(String),
}

impl State {
    pub(super) fn has_request(&self, id: &str) -> bool {
        self.pending.contains_key(id)
    }
    pub(super) fn retry_load(&mut self) {
        if self.phase == Recovery::Failed {
            self.phase = Recovery::Waiting;
        }
    }
}

impl Runtime {
    /// A draft-storage failure does not interrupt unrelated domain requests.
    #[must_use]
    pub fn draft_error(&self) -> Option<&str> {
        self.drafts.error.as_deref()
    }

    pub(super) fn collect_drafts(&mut self) -> Vec<Call> {
        match self.sync_drafts() {
            Ok(calls) => calls,
            Err(message) => {
                self.drafts.error = Some(message);
                Vec::new()
            }
        }
    }

    pub(super) fn configure_drafts(&mut self, value: &Value) {
        self.drafts.enabled = value
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("app.configurationState"))
            });
        self.drafts.prefix = value
            .get("mutation_prefix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into();
    }

    /// Submit the currently reviewed document using a fresh host-issued prefix.
    /// The host journals the exact resulting write before forwarding it.
    ///
    /// # Errors
    /// Rejects an incomplete handshake, draft recovery or missing provider clock.
    pub fn save_configuration(
        &mut self,
        document: ConfigurationDocument,
    ) -> Result<Vec<Call>, String> {
        if self.drafts.phase != Recovery::Ready || self.drafts.prefix.is_empty() {
            return Err("Wait for configuration draft recovery before saving".into());
        }
        let now = self
            .now_ms()
            .ok_or("The configuration clock is unavailable")?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Host request identities exhausted")?;
        self.dispatch(Event::Configuration(ConfigurationEvent::Save {
            document,
            request: ConfigurationRequest {
                request_id: format!("{}:{}", self.drafts.prefix, self.next),
                expires_at_ms: now.saturating_add(300_000),
            },
        }))
    }

    pub(super) fn sync_drafts(&mut self) -> Result<Vec<Call>, String> {
        if !self.drafts.enabled {
            return Ok(Vec::new());
        }
        let view = self.core.view();
        let context = view.configuration.context.clone();
        if self.drafts.context != context {
            self.drafts.context.clone_from(&context);
            self.drafts.phase = Recovery::Waiting;
            self.drafts.error = None;
            self.drafts.sent = None;
            self.drafts.retained.clear();
            self.drafts.pending.clear();
        }
        let Some(context) = context else {
            return Ok(Vec::new());
        };
        let Some(binding) = view.workspace.repository_binding else {
            return Ok(Vec::new());
        };
        if self.drafts.phase == Recovery::Waiting
            && !self
                .drafts
                .pending
                .values()
                .any(|pending| matches!(pending, Pending::Load))
        {
            let call = self.draft_call(json!({"binding":binding, "operation":"load"}))?;
            let _old = self.drafts.pending.insert(call.id.clone(), Pending::Load);
            return Ok(vec![call]);
        }
        let ready = [
            &view.configuration.settings.load,
            &view.configuration.agent_rules.load,
        ]
        .iter()
        .all(|load| {
            matches!(
                load,
                ConfigurationLoadState::Ready | ConfigurationLoadState::Refreshing
            )
        });
        if !matches!(self.drafts.phase, Recovery::Loaded | Recovery::Ready) || !ready {
            return Ok(Vec::new());
        }
        if self.drafts.phase == Recovery::Loaded {
            self.drafts.phase = Recovery::Ready;
            for draft in std::mem::take(&mut self.drafts.retained) {
                if draft.context != context {
                    self.drafts.phase = Recovery::Failed;
                    return Err("Saved draft belongs to another workspace connection".into());
                }
                let effects = self
                    .core
                    .process_event(Event::Configuration(ConfigurationEvent::Restore(draft)));
                if effects
                    .into_iter()
                    .any(|effect| !matches!(effect, Effect::Render(_)))
                {
                    return Err("Draft restoration cannot execute a write".into());
                }
            }
        }
        let encoded = serde_json::to_string(&self.core.view().configuration.drafts)
            .map_err(|error| error.to_string())?;
        if self.drafts.sent.as_ref() == Some(&encoded) {
            return Ok(Vec::new());
        }
        let call =
            self.draft_call(json!({"binding":binding, "operation":"store", "drafts":encoded}))?;
        self.drafts.sent = Some(encoded.clone());
        let _old = self
            .drafts
            .pending
            .insert(call.id.clone(), Pending::Store(encoded));
        Ok(vec![call])
    }

    pub(super) fn receive_drafts(
        &mut self,
        id: &str,
        result: Result<Value, BridgeError>,
    ) -> Result<Vec<Call>, String> {
        let Some(pending) = self.drafts.pending.remove(id) else {
            return Ok(Vec::new());
        };
        match (pending, result) {
            (Pending::Load, Ok(value)) => {
                self.drafts.phase = Recovery::Failed;
                let raw = value
                    .get("drafts")
                    .and_then(Value::as_str)
                    .ok_or("Invalid saved configuration state")?;
                let retained: Vec<ConfigurationDraft> = serde_json::from_str(raw)
                    .map_err(|_error| "Invalid saved configuration drafts")?;
                if retained.len() > 2 {
                    return Err("Too many configuration drafts".into());
                }
                if retained
                    .iter()
                    .any(|draft| Some(&draft.context) != self.drafts.context.as_ref())
                {
                    return Err("Saved draft belongs to another workspace connection".into());
                }
                self.drafts.retained = retained;
                self.drafts.phase = Recovery::Loaded;
                self.drafts.error = None;
                self.drafts.sent = Some(raw.into());
            }
            (Pending::Load, Err(error)) => {
                self.drafts.phase = Recovery::Failed;
                return Err(format!(
                    "Could not restore configuration drafts: {}",
                    error.message
                ));
            }
            (Pending::Store(encoded), Err(error)) => {
                if self.drafts.sent.as_ref() == Some(&encoded) {
                    self.drafts.sent = None;
                }
                return Err(format!(
                    "Could not retain the configuration draft: {}",
                    error.message
                ));
            }
            (Pending::Store(_), Ok(_)) => {
                self.drafts.error = None;
            }
        }
        Ok(self.collect_drafts())
    }

    fn draft_call(&mut self, params: Value) -> Result<Call, String> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Host request identities exhausted")?;
        Ok(Call {
            id: format!("draft:{}", self.next),
            method: "app.configurationState",
            params,
        })
    }
}
