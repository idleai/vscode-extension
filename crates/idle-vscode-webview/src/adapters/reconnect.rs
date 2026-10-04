//! Restore a local selection only after the new host supplies the same binding.

use app_core::{Effect, Event, workspace};

use super::Runtime;

#[cfg(test)]
mod tests;

impl Runtime {
    pub(super) fn remember_workspace(&mut self) {
        let view = self.core.view().workspace;
        let Some(selected) = view.workspaces.iter().find(|info| {
            Some(&info.id) == view.selected_workspace.as_ref()
                && info.mode == workspace::WorkspaceMode::Standalone
        }) else {
            return;
        };
        let [repository] = selected.repositories.as_slice() else {
            return;
        };
        self.reconnect = Some(workspace::RepositoryChainBinding {
            workspace_id: selected.id.clone(),
            repository_id: repository.id.clone(),
            chain: selected.chain.clone(),
        });
    }

    pub(super) fn restore_workspace(&mut self) -> Vec<Effect> {
        let view = self.core.view().workspace;
        if view.directory_state != workspace::WorkspaceRequestState::Ready {
            return Vec::new();
        }
        let Some(binding) = self.reconnect.take() else {
            return Vec::new();
        };
        let current = view.workspaces.iter().any(|info| {
            info.id == binding.workspace_id
                && info.chain == binding.chain
                && info.mode == workspace::WorkspaceMode::Standalone
                && matches!(info.repositories.as_slice(), [repository] if repository.id == binding.repository_id)
        });
        if !current {
            return Vec::new();
        }
        self.core
            .process_event(Event::Workspace(workspace::Event::SelectWorkspace(
                binding.workspace_id,
            )))
    }
}
