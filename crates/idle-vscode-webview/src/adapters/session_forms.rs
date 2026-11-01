//! Recoverable editor forms for attributed live-session actions.

use std::collections::{BTreeMap, BTreeSet};

use app_core::{
    Effect, Event,
    sessions::{
        self, SessionAction, SessionContext, SessionDraft, SessionLoadState, SessionMutationId,
        SessionMutationState, SessionOperation,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use web_ui::{
    controls::SelectOption,
    navigation::SessionCreation,
    sessions::{InvitationAccess, InvitationDraft, PromptDraft, SessionActionToken},
};

use super::{BridgeError, Call, Runtime};

#[derive(Default)]
pub(super) struct State {
    enabled: bool,
    surface: SessionSurface,
    prefix: String,
    context: Option<SessionContext>,
    loaded: bool,
    failed: bool,
    forms: Forms,
    retained: Vec<SessionOperation>,
    pending: BTreeMap<String, Pending>,
    sent: Option<String>,
    settled: BTreeSet<String>,
    creating: Option<String>,
}

#[derive(Default, PartialEq, Eq)]
enum SessionSurface {
    #[default]
    Live,
    Recorded,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct Forms {
    creation: Option<TextDraft>,
    prompts: BTreeMap<String, TextDraft>,
    invitations: BTreeMap<String, SharingDraft>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TextDraft {
    mutation: SessionMutationId,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SharingDraft {
    mutation: SessionMutationId,
    grant_id: String,
    grantee: String,
    access: String,
}

enum Pending {
    Load,
    Store(String),
}

impl State {
    pub(super) fn has_request(&self, id: &str) -> bool {
        self.pending.contains_key(id)
    }
    pub(super) fn retry(&mut self) {
        self.failed = false;
        self.sent = None;
    }
    pub(super) fn submitted(&mut self, event: &Event) {
        if matches!(
            event,
            Event::Sessions(sessions::Event::Select(_) | sessions::Event::Create { .. })
        ) {
            self.surface = SessionSurface::Live;
        } else if matches!(
            event,
            Event::Repository(app_core::repository::Event::SelectSession(_))
        ) {
            self.surface = SessionSurface::Recorded;
        }
        if let Event::Sessions(sessions::Event::Create { id, .. }) = event {
            self.creating = Some(id.request_id.clone());
        }
    }
}

impl Runtime {
    /// Saved live-session forms for the current detail surface.
    #[must_use]
    pub fn session_forms(&self) -> web_ui::sessions::SessionForms {
        web_ui::sessions::SessionForms {
            show_recorded_history: self.session_forms.surface == SessionSurface::Recorded,
            creation: self.session_creation(),
            prompt: self.session_prompt(),
            invitation: self.session_invitation(),
            recipients: self.session_recipients(),
            readiness: self.sessions.readiness.clone(),
        }
    }

    /// Persist a user edit to a live-session form.
    /// # Errors
    /// Rejects stale form scope, invalid text or unavailable storage.
    pub fn edit_session_form(
        &mut self,
        edit: web_ui::sessions::SessionFormEdit,
    ) -> Result<Vec<Call>, String> {
        match edit {
            web_ui::sessions::SessionFormEdit::Title(text) => self.edit_session_title(text),
            web_ui::sessions::SessionFormEdit::Prompt(text) => self.edit_session_prompt(text),
            web_ui::sessions::SessionFormEdit::Invitation(draft) => {
                self.edit_session_invitation(*draft)
            }
        }
    }

    pub(super) fn configure_session_forms(&mut self, value: &Value) {
        self.session_forms.enabled = value.get("view_kind").and_then(Value::as_str)
            != Some("sidebar")
            && value
                .get("capabilities")
                .and_then(Value::as_array)
                .is_some_and(|methods| methods.iter().any(|method| method == "app.sessionState"));
        self.session_forms.prefix = value
            .get("mutation_prefix")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into();
    }

    /// Prepared creation on the connected compute host, with a saved request identity.
    #[must_use]
    pub fn session_creation(&self) -> Option<SessionCreation> {
        let state = &self.session_forms;
        let draft = state.forms.creation.as_ref()?;
        Some(SessionCreation {
            context: state.context.clone()?,
            mutation: draft.mutation.clone(),
            draft: SessionDraft {
                title: draft.text.clone(),
                host_id: self.sessions.host_id.clone()?,
                parent: None,
            },
        })
    }

    /// Exact unsent prompt for the currently selected live session.
    #[must_use]
    pub fn session_prompt(&self) -> Option<PromptDraft> {
        let view = self.core.view().sessions;
        let id = view.selected?;
        let draft = self.session_forms.forms.prompts.get(&id)?;
        Some(PromptDraft {
            token: SessionActionToken {
                context: view.context?,
                session_id: id,
                mutation: draft.mutation.clone(),
            },
            text: draft.text.clone(),
        })
    }

    /// Controlled participant and access choices for the current live session.
    #[must_use]
    pub fn session_invitation(&self) -> Option<InvitationDraft> {
        let view = self.core.view().sessions;
        let id = view.selected?;
        let draft = self.session_forms.forms.invitations.get(&id)?;
        Some(InvitationDraft {
            token: SessionActionToken {
                context: view.context?,
                session_id: id,
                mutation: draft.mutation.clone(),
            },
            grant_id: draft.grant_id.clone(),
            grantee: draft.grantee.clone(),
            expires_at_ms: None,
            access: match draft.access.as_str() {
                "contribute" => InvitationAccess::Contribute,
                "manage" => InvitationAccess::Manage,
                _ => InvitationAccess::Observe,
            },
        })
    }

    /// Active workspace contributors from the authenticated runtime snapshot.
    #[must_use]
    pub fn session_recipients(&self) -> Vec<SelectOption> {
        let current = self
            .core
            .view()
            .sessions
            .context
            .map(|context| context.contributor_id);
        self.sessions
            .members
            .iter()
            .filter(|member| {
                member.status == app_core::workspace::MemberStatus::Active
                    && Some(&member.contributor_id) != current.as_ref()
            })
            .map(|member| SelectOption {
                value: member.contributor_id.clone(),
                label: member.display_name.clone(),
                disabled: false,
            })
            .collect()
    }

    /// Preserve a prompt edit before the user sends it.
    /// # Errors
    /// Rejects an unbound form, excessive text or exhausted request identities.
    pub fn edit_session_prompt(&mut self, text: String) -> Result<Vec<Call>, String> {
        if text.len() > 32 * 1024 {
            return Err("Prompts must be at most 32 KiB".into());
        }
        let view = self.core.view().sessions;
        let id = view
            .selected
            .ok_or("Select a live session before editing its prompt")?;
        let old = self
            .session_forms
            .forms
            .prompts
            .get(&id)
            .ok_or("Wait for saved draft recovery")?;
        let mutation = if view
            .mutations
            .iter()
            .any(|entry| entry.request.mutation == old.mutation)
        {
            self.session_mutation_id()?
        } else {
            old.mutation.clone()
        };
        let _previous = self
            .session_forms
            .forms
            .prompts
            .insert(id, TextDraft { mutation, text });
        self.collect_session_forms()
    }

    /// Save the title reviewed before native runner creation.
    /// # Errors
    /// Rejects missing recovery state or an excessive title.
    pub fn edit_session_title(&mut self, title: String) -> Result<Vec<Call>, String> {
        if title.len() > 256 {
            return Err("Session titles must be at most 256 bytes".into());
        }
        let old = self
            .session_forms
            .forms
            .creation
            .as_ref()
            .ok_or("Wait for saved session setup")?;
        let mutation = if self
            .core
            .view()
            .sessions
            .mutations
            .iter()
            .any(|entry| entry.request.mutation == old.mutation)
        {
            self.session_mutation_id()?
        } else {
            old.mutation.clone()
        };
        self.session_forms.forms.creation = Some(TextDraft {
            mutation,
            text: title,
        });
        self.collect_session_forms()
    }

    /// Keep sharing choices tied to the session for which they were prepared.
    /// # Errors
    /// Rejects a stale session or contributor before retaining changes.
    pub fn edit_session_invitation(&mut self, draft: InvitationDraft) -> Result<Vec<Call>, String> {
        let view = self.core.view().sessions;
        if view.context.as_ref() != Some(&draft.token.context)
            || view.selected.as_ref() != Some(&draft.token.session_id)
        {
            return Err("The sharing form belongs to another session".into());
        }
        let mutation = if view
            .mutations
            .iter()
            .any(|entry| entry.request.mutation == draft.token.mutation)
        {
            self.session_mutation_id()?
        } else {
            draft.token.mutation
        };
        let grant_id = format!("session-grant:{}", mutation.request_id);
        let _previous = self.session_forms.forms.invitations.insert(
            draft.token.session_id,
            SharingDraft {
                mutation,
                grant_id,
                grantee: draft.grantee,
                access: match draft.access {
                    InvitationAccess::Observe => "observe",
                    InvitationAccess::Contribute => "contribute",
                    InvitationAccess::Manage => "manage",
                }
                .into(),
            },
        );
        self.collect_session_forms()
    }

    pub(super) fn collect_session_forms(&mut self) -> Result<Vec<Call>, String> {
        if !self.session_forms.enabled {
            return Ok(Vec::new());
        }
        let view = self.core.view();
        let context = view.sessions.context.clone();
        if self.session_forms.context != context {
            let enabled = self.session_forms.enabled;
            let prefix = self.session_forms.prefix.clone();
            self.session_forms = State {
                enabled,
                prefix,
                context: context.clone(),
                ..State::default()
            };
        }
        let (Some(context), Some(binding)) = (context, view.workspace.repository_binding) else {
            return Ok(Vec::new());
        };
        if self.session_forms.failed {
            return Ok(Vec::new());
        }
        if !self.session_forms.loaded {
            if self
                .session_forms
                .pending
                .values()
                .any(|pending| matches!(pending, Pending::Load))
            {
                return Ok(Vec::new());
            }
            let call = self
                .session_form_call(json!({"binding":binding,"context":context,"action":"load"}))?;
            let _previous = self
                .session_forms
                .pending
                .insert(call.id.clone(), Pending::Load);
            return Ok(vec![call]);
        }
        if view.sessions.load != SessionLoadState::Ready {
            return Ok(Vec::new());
        }
        let mut effects = Vec::new();
        for operation in std::mem::take(&mut self.session_forms.retained) {
            if operation.context != context {
                return Err("Saved session request belongs to another connection".into());
            }
            effects.extend(
                self.core
                    .process_event(Event::Sessions(sessions::Event::Restore(Box::new(
                        operation,
                    )))),
            );
        }
        self.reconcile_session_forms(&mut effects);
        self.ensure_session_forms()?;
        let mut calls = if effects.is_empty() {
            Vec::new()
        } else {
            self.enqueue(effects)?
        };
        let encoded =
            serde_json::to_string(&self.session_forms.forms).map_err(|error| error.to_string())?;
        let payload = json!({"binding":binding,"context":context,"action":"store","drafts":encoded,"settled":self.session_forms.settled});
        let fingerprint = payload.to_string();
        if self.session_forms.sent.as_ref() != Some(&fingerprint)
            && !self
                .session_forms
                .pending
                .values()
                .any(|pending| matches!(pending, Pending::Store(_)))
        {
            let call = self.session_form_call(payload)?;
            self.session_forms.sent = Some(fingerprint.clone());
            let _previous = self
                .session_forms
                .pending
                .insert(call.id.clone(), Pending::Store(fingerprint));
            calls.push(call);
        }
        Ok(calls)
    }

    fn reconcile_session_forms(&mut self, effects: &mut Vec<Effect>) {
        let view = self.core.view().sessions;
        for mutation in &view.mutations {
            if matches!(
                mutation.state,
                SessionMutationState::Acknowledged(_)
                    | SessionMutationState::Created(_)
                    | SessionMutationState::RuntimeReported
            ) {
                let id = &mutation.request.mutation.request_id;
                self.clear_confirmed_form(id);
                let _new = self.session_forms.settled.insert(id.clone());
                if self.session_forms.creating.as_ref() == Some(id)
                    && let SessionMutationState::Created(session) = &mutation.state
                {
                    self.session_forms.creating = None;
                    effects.extend(self.core.process_event(Event::Sessions(
                        sessions::Event::Select(Some(session.id.clone())),
                    )));
                }
            }
        }
        // A confirmed prompt can outlive the editor's request journal.
        for prompt in view
            .prompts
            .iter()
            .filter(|prompt| prompt.runtime.is_some())
        {
            self.clear_confirmed_form(&prompt.input.request.request_id);
        }
    }

    fn clear_confirmed_form(&mut self, id: &str) {
        if self
            .session_forms
            .forms
            .creation
            .as_ref()
            .is_some_and(|draft| draft.mutation.request_id == id)
        {
            self.session_forms.forms.creation = None;
        }
        self.session_forms
            .forms
            .prompts
            .retain(|_session, draft| draft.mutation.request_id != id);
        self.session_forms
            .forms
            .invitations
            .retain(|_session, draft| draft.mutation.request_id != id);
    }

    fn ensure_session_forms(&mut self) -> Result<(), String> {
        let view = self.core.view().sessions;
        let now = self.now_ms().ok_or("Session clock is unavailable")?;
        let used: BTreeSet<_> = view
            .mutations
            .iter()
            .map(|entry| entry.request.mutation.request_id.as_str())
            .collect();
        if self
            .session_forms
            .forms
            .creation
            .as_ref()
            .is_some_and(|draft| {
                draft.mutation.expires_at_ms <= now
                    && !used.contains(draft.mutation.request_id.as_str())
            })
        {
            let mutation = self.session_mutation_id()?;
            if let Some(draft) = &mut self.session_forms.forms.creation {
                draft.mutation = mutation;
            }
        }
        if self.session_forms.forms.creation.is_none() {
            self.session_forms.forms.creation = Some(TextDraft {
                mutation: self.session_mutation_id()?,
                text: "New session".into(),
            });
        }
        if let Some(id) = view.selected {
            if self
                .session_forms
                .forms
                .prompts
                .get(&id)
                .is_some_and(|draft| {
                    draft.mutation.expires_at_ms <= now
                        && !used.contains(draft.mutation.request_id.as_str())
                })
            {
                let mutation = self.session_mutation_id()?;
                if let Some(draft) = self.session_forms.forms.prompts.get_mut(&id) {
                    draft.mutation = mutation;
                }
            }
            if self
                .session_forms
                .forms
                .invitations
                .get(&id)
                .is_some_and(|draft| {
                    draft.mutation.expires_at_ms <= now
                        && !used.contains(draft.mutation.request_id.as_str())
                })
            {
                let mutation = self.session_mutation_id()?;
                if let Some(draft) = self.session_forms.forms.invitations.get_mut(&id) {
                    draft.grant_id = format!("session-grant:{}", mutation.request_id);
                    draft.mutation = mutation;
                }
            }
            if !self.session_forms.forms.prompts.contains_key(&id) {
                let mutation = self.session_mutation_id()?;
                let _previous = self.session_forms.forms.prompts.insert(
                    id.clone(),
                    TextDraft {
                        mutation,
                        text: String::new(),
                    },
                );
            }
            if !self.session_forms.forms.invitations.contains_key(&id) {
                let mutation = self.session_mutation_id()?;
                let grant_id = format!("session-grant:{}", mutation.request_id);
                let _previous = self.session_forms.forms.invitations.insert(
                    id,
                    SharingDraft {
                        mutation,
                        grant_id,
                        grantee: String::new(),
                        access: "observe".into(),
                    },
                );
            }
        }
        Ok(())
    }

    fn session_mutation_id(&mut self) -> Result<SessionMutationId, String> {
        if self.session_forms.prefix.is_empty() {
            return Err("Session request identity is unavailable".into());
        }
        let now = self.now_ms().ok_or("Session clock is unavailable")?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Session request identities exhausted")?;
        Ok(SessionMutationId {
            request_id: format!("session:{}:{}", self.session_forms.prefix, self.next),
            expires_at_ms: now.saturating_add(3_600_000),
        })
    }

    fn session_form_call(&mut self, params: Value) -> Result<Call, String> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Session request identities exhausted")?;
        Ok(Call {
            id: format!("session-state:{}", self.next),
            method: "app.sessionState",
            params,
        })
    }

    pub(super) fn receive_session_forms(
        &mut self,
        id: &str,
        result: Result<Value, BridgeError>,
    ) -> Result<Vec<Call>, String> {
        let Some(pending) = self.session_forms.pending.remove(id) else {
            return Ok(Vec::new());
        };
        match (pending, result) {
            (Pending::Load, Ok(value)) => {
                self.session_forms.failed = true;
                let raw = value
                    .get("drafts")
                    .and_then(Value::as_str)
                    .ok_or("Invalid saved session drafts")?;
                let forms: Forms =
                    serde_json::from_str(raw).map_err(|_error| "Invalid saved session drafts")?;
                if forms.prompts.len() > 512
                    || forms.invitations.len() > 512
                    || forms
                        .prompts
                        .values()
                        .any(|draft| draft.text.len() > 32 * 1024)
                {
                    return Err("Saved session drafts exceed the supported limit".into());
                }
                let requests: Vec<SessionOperation> = serde_json::from_value(
                    value
                        .get("requests")
                        .cloned()
                        .ok_or("Missing saved session requests")?,
                )
                .map_err(|_error| "Invalid saved session requests")?;
                if requests.len() > 64
                    || requests
                        .iter()
                        .any(|operation| !matches!(operation.action, SessionAction::Mutate { .. }))
                {
                    return Err("Invalid saved outgoing session actions".into());
                }
                self.session_forms.forms = forms;
                self.session_forms.retained = requests;
                self.session_forms.loaded = true;
                self.session_forms.failed = false;
            }
            (Pending::Store(_), Ok(_)) => {}
            (Pending::Load, Err(error)) => {
                self.session_forms.failed = true;
                return Err(format!(
                    "Could not recover session drafts: {}",
                    error.message
                ));
            }
            (Pending::Store(sent), Err(error)) => {
                self.session_forms.failed = true;
                if self.session_forms.sent.as_ref() == Some(&sent) {
                    self.session_forms.sent = None;
                }
                return Err(format!(
                    "Could not save the session draft: {}",
                    error.message
                ));
            }
        }
        self.collect_session_forms()
    }
}
