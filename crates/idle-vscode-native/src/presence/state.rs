use std::collections::BTreeMap;

use app_core::workspace::PresenceEntry;

use super::{
    AwarenessError, AwarenessInput, AwarenessView, BranchChange, BranchInvitation, EditorContext,
    project,
};

/// Extension-local observation history used only to detect branch transitions.
/// The provider retains selection, reconciliation and authorization in app-core.
#[derive(Debug, Default)]
pub struct PeerAwareness {
    editor: Option<EditorContext>,
    stream_id: Option<String>,
    previous: BTreeMap<String, PresenceEntry>,
    pending: BTreeMap<String, BranchInvitation>,
    next_invitation_id: u64,
    now_ms: u64,
}

impl PeerAwareness {
    /// Clear the baseline on disconnect, account/provider change or recovery reset.
    pub fn reset(&mut self) {
        self.editor = None;
        self.stream_id = None;
        self.previous.clear();
        self.pending.clear();
        // Retain the ID sequence so late acknowledgements cannot remove new prompts.
        self.now_ms = 0;
    }

    /// Remove only the invitations the native host has displayed to the user.
    pub fn acknowledge_invitations(&mut self, ids: &[String]) {
        self.pending
            .retain(|_connection_id, invitation| !ids.contains(&invitation.id));
    }

    /// Project current peers and retain branch transitions until acknowledged.
    ///
    /// # Errors
    /// Rejects unavailable, foreign or inconsistent shared state. A subsequent
    /// successful update establishes a new baseline without branch notifications.
    pub fn update(&mut self, input: &AwarenessInput<'_>) -> Result<AwarenessView, AwarenessError> {
        let same_scope = self
            .editor
            .as_ref()
            .is_some_and(|previous| same_checkout(previous, input.editor))
            && self.stream_id.as_ref() == Some(&input.directory.as_of.stream_id.0);
        if !same_scope {
            self.reset();
        }
        if input.now_ms < self.now_ms {
            return Err(AwarenessError::Unavailable);
        }
        self.now_ms = input.now_ms;
        let projection = match project::project(input) {
            Ok(projection) => projection,
            Err(error) => {
                self.reset();
                return Err(error);
            }
        };
        let previous_editor = self
            .editor
            .as_ref()
            .filter(|previous| same_checkout(previous, input.editor));
        // Presence timestamps are observations, not recovery cursors. Older or
        // conflicting observations cannot establish a new branch transition.
        for (_, connection) in &projection.peers {
            if self
                .previous
                .get(&connection.connection_id)
                .is_some_and(|previous| {
                    previous.contributor_id == connection.contributor_id
                        && previous.host_id == connection.host_id
                        && (connection.observed_at_ms < previous.observed_at_ms
                            || (connection.observed_at_ms == previous.observed_at_ms
                                && connection.branch != previous.branch))
                })
            {
                return Err(AwarenessError::Unavailable);
            }
        }
        let mut pending = BTreeMap::new();
        let mut next_invitation_id = self.next_invitation_id;
        if let Some(previous_editor) = previous_editor {
            let local_switched =
                previous_editor.branch.is_some() && previous_editor.branch != input.editor.branch;
            for (peer, connection) in &projection.peers {
                if input.editor.branch.is_none()
                    || connection.branch != input.editor.branch
                    || (connection.host_id.is_some() && connection.host_id == input.editor.host_id)
                {
                    continue;
                }
                if let Some(invitation) =
                    self.pending.get(&peer.connection_id).filter(|invitation| {
                        invitation.peer.contributor_id == peer.contributor_id
                            && invitation.peer.host.as_ref().map(|host| &host.id)
                                == connection.host_id.as_ref()
                            && invitation.peer.branch == peer.branch
                    })
                {
                    let _previous = pending.insert(
                        peer.connection_id.clone(),
                        BranchInvitation {
                            peer: peer.clone(),
                            ..invitation.clone()
                        },
                    );
                }
                let previous = self.previous.get(&peer.connection_id).filter(|previous| {
                    previous.contributor_id == connection.contributor_id
                        && previous.host_id == connection.host_id
                        && previous.valid_until_ms > input.now_ms
                        && previous.observed_at_ms <= connection.observed_at_ms
                });
                let change = if local_switched && previous.is_some() {
                    Some(BranchChange::Local)
                } else if previous.is_some_and(|previous| {
                    previous.branch.is_some() && previous.branch != connection.branch
                }) {
                    Some(BranchChange::Peer)
                } else {
                    None
                };
                if let Some(change) = change {
                    next_invitation_id = next_invitation_id
                        .checked_add(1)
                        .ok_or(AwarenessError::Unavailable)?;
                    let _previous = pending.insert(
                        peer.connection_id.clone(),
                        BranchInvitation {
                            id: next_invitation_id.to_string(),
                            change,
                            peer: peer.clone(),
                        },
                    );
                }
            }
        }
        self.editor = Some(input.editor.clone());
        self.pending = pending;
        self.next_invitation_id = next_invitation_id;
        self.stream_id = Some(input.directory.as_of.stream_id.0.clone());
        self.previous = projection
            .peers
            .iter()
            .map(|(_, connection)| (connection.connection_id.clone(), connection.clone()))
            .collect();
        let invitations = projection
            .peers
            .iter()
            .filter_map(|(peer, _)| self.pending.get(&peer.connection_id).cloned())
            .collect();
        let join_offers = projection
            .peers
            .iter()
            .flat_map(|(peer, _)| peer.joins.iter().cloned())
            .collect();
        let peers = projection
            .peers
            .into_iter()
            .filter_map(|(peer, _)| {
                (input.editor.file.is_some() && peer.file == input.editor.file).then_some(peer)
            })
            .collect();
        Ok(AwarenessView {
            editor: input.editor.clone(),
            peers,
            join_offers,
            invitations,
            valid_for_ms: projection.valid_for_ms,
        })
    }
}

fn same_checkout(left: &EditorContext, right: &EditorContext) -> bool {
    left.binding == right.binding
        && left.mode == right.mode
        && left.contributor_id == right.contributor_id
        && left.connection_id == right.connection_id
        && left.host_id == right.host_id
}
