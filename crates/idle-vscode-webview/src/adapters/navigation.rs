//! Selection routing between native views; every binding is checked by Rust.

use app_core::{Effect, Event, history, repository, resources, sessions, workspace};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Call, Runtime};

#[derive(Deserialize)]
pub(super) struct Target {
    binding: workspace::RepositoryChainBinding,
    section: workspace::NavigationSection,
    session: Option<String>,
    recorded_session: Option<String>,
    host: Option<String>,
    provider: Option<String>,
    history: Option<history::Selected>,
    timeline: Option<history::timeline::Selection>,
}

impl Runtime {
    /// Whether the host coordinates multiple native sidebar views.
    #[must_use]
    pub const fn has_native_views(&self) -> bool {
        self.native_views
    }

    /// Adopt the host's explicit selection after checking the current directory.
    ///
    /// # Errors
    /// Returns malformed binding or continuation errors.
    pub fn synchronize_workspace(&mut self, value: Value) -> Result<Vec<Call>, String> {
        let binding = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if self.core.view().workspace.repository_binding.as_ref() == Some(&binding) {
            return Ok(Vec::new());
        }
        self.navigation = None;
        self.reconnect = Some(binding);
        let effects = self.restore_workspace();
        self.enqueue(effects)
    }

    /// Capture a detail destination without copying domain data into the host.
    #[must_use]
    pub fn navigation_target(&self, section: workspace::NavigationSection) -> Value {
        let view = self.core.view();
        json!({"binding": view.workspace.repository_binding, "section": section,
            "session": view.sessions.selected, "host": view.resources.selected_host,
            "provider": view.resources.selected_provider, "history": view.history.selected,
            "timeline": view.history.timeline.selected})
    }

    /// Open a typed destination once its current workspace data is available.
    ///
    /// # Errors
    /// Returns malformed destination or continuation errors.
    pub fn navigate_from_host(&mut self, value: Value) -> Result<Vec<Call>, String> {
        let target: Target = serde_json::from_value(value).map_err(|error| error.to_string())?;
        let mut calls = self.synchronize_workspace(json!(target.binding))?;
        self.navigation = Some(target);
        let effects = self.apply_navigation();
        calls.extend(self.enqueue(effects)?);
        Ok(calls)
    }

    pub(super) fn apply_navigation(&mut self) -> Vec<Effect> {
        let Some(mut target) = self.navigation.take() else {
            return Vec::new();
        };
        let view = self.core.view();
        if view.workspace.repository_binding.as_ref() != Some(&target.binding) {
            self.navigation = Some(target);
            return Vec::new();
        }
        let mut events = Vec::new();
        if view.workspace.section != target.section {
            events.push(Event::Workspace(workspace::Event::Navigate(target.section)));
        }
        if view.repository.snapshot.is_some()
            && let Some(id) = target.recorded_session.take()
        {
            events.push(Event::Repository(repository::Event::SelectSession(Some(
                id,
            ))));
        }
        if view.sessions.load == sessions::SessionLoadState::Ready
            && let Some(id) = target.session.take()
        {
            events.push(Event::Sessions(sessions::Event::Select(Some(id))));
        }
        if view.resources.load == resources::ResourceLoadState::Ready {
            if let Some(id) = target.host.take() {
                events.push(Event::Resources(resources::Event::SelectHost(Some(id))));
            }
            if let Some(id) = target.provider.take() {
                events.push(Event::Resources(resources::Event::SelectProvider(Some(id))));
            }
        }
        // The initial join replaces history state. Keep an exact destination
        // queued until that replacement has finished, so it cannot erase a seek.
        let history_ready = view.history.chain.as_deref() == Some(target.binding.chain.as_str())
            && (!self.coordination.enabled
                || (view.subscriptions.status == app_core::subscriptions::ConnectionStatus::Live
                    && view.subscriptions.context.as_ref().is_some_and(|context| {
                        context.workspace == target.binding.workspace_id
                            && context.chain == target.binding.chain
                    })));
        if history_ready && let Some(selection) = target.timeline.take() {
            events.push(Event::History(history::Event::Timeline(
                history::timeline::Event::Reveal {
                    surface: history::timeline::Surface::Editor,
                    selection,
                },
            )));
        }
        if history_ready && let Some(selected) = target.history.take() {
            events.push(Event::History(history::Event::Select(selected)));
        }
        if target.session.is_some()
            || target.recorded_session.is_some()
            || target.host.is_some()
            || target.provider.is_some()
            || target.history.is_some()
            || target.timeline.is_some()
        {
            self.navigation = Some(target);
        }
        events
            .into_iter()
            .flat_map(|event| self.core.process_event(event))
            .collect()
    }
}
