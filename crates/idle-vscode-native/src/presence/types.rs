use app_core::workspace::{RepositoryChainBinding, ViewModel, WorkspaceMode};
use idle_protocol::v1::{events::RecoverySnapshot, resources::ConnectionRoute};
use serde::{Deserialize, Serialize};

/// Exact selected checkout context; identity is supplied by the authenticated adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorContext {
    /// Explicit workspace/repository/chain binding from app-core.
    pub binding: RepositoryChainBinding,
    /// Provider selected for this binding.
    pub mode: WorkspaceMode,
    /// Actual contributor, independent of the host owner or display label.
    pub contributor_id: String,
    /// Local connection, allowing the same person to use several hosts.
    pub connection_id: String,
    /// File-owning host, when published in this workspace.
    pub host_id: Option<String>,
    /// Repository-relative active file; absent for an unrelated or closed editor.
    pub file: Option<String>,
    /// Observed Git branch; absent for detached HEAD or an unavailable Git adapter.
    pub branch: Option<String>,
}

/// Explicit connection-to-session association supplied by coordination.
/// Neither session ownership nor sharing a host establishes this association.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionConnection {
    /// Connection from this workspace's presence state.
    pub connection_id: String,
    /// Session in the same workspace's directory.
    pub session_id: String,
}

/// Consistent, authorized inputs; hosts retain shared state in app-core.
#[derive(Debug)]
pub struct AwarenessInput<'a> {
    /// Current editor observation and selected binding.
    pub editor: &'a EditorContext,
    /// Accepted shared selection, membership and presence state.
    pub workspace: &'a ViewModel,
    /// Reconciled directory, including current grants and host publications.
    pub directory: &'a RecoverySnapshot,
    /// Supplied session associations, never inferred from user/host labels.
    pub sessions: &'a [SessionConnection],
    /// Current provider-clock time in Unix milliseconds.
    pub now_ms: u64,
}

/// Resource the user explicitly chose to join.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JoinTarget {
    /// Observe an existing session; this grants no general host access.
    Session {
        /// Reconnectable session identity.
        session_id: String,
    },
    /// Connect to a host; file/process operations need their own permissions.
    Host {
        /// Workspace-bound host identity.
        host_id: String,
    },
}

/// Grant reference routed to the same coordination provider as the selected workspace.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JoinRequest {
    /// Immutable workspace/repository/chain scope captured by the invitation.
    pub binding: RepositoryChainBinding,
    /// Provider route captured by the invitation.
    pub mode: WorkspaceMode,
    /// Actual joining contributor; the adapter must authenticate this identity.
    pub contributor_id: String,
    /// Peer connection whose current location must still match the target.
    pub connection_id: String,
    /// Independently authorized resource.
    pub target: JoinTarget,
    /// Existing grant, never a bearer credential.
    pub grant_id: String,
}

/// Presentable invitation backed by a currently usable grant.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JoinOffer {
    /// Human-readable resource name, separate from the peer's name.
    pub label: String,
    /// Opaque intent passed back unchanged on user selection.
    pub request: JoinRequest,
}

/// Host identity and its own display label.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HostLabel {
    /// Published host identity.
    pub id: String,
    /// Host label; never used as a contributor name.
    pub name: String,
}

/// A fresh peer connection shown in an editor header or branch notification.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Peer {
    /// Stable connection identity in this workspace.
    pub connection_id: String,
    /// Actual contributor identity.
    pub contributor_id: String,
    /// Contributor directory label, falling back only to contributor ID.
    pub display_name: String,
    /// Reported branch, with unknown/detached state left absent.
    pub branch: Option<String>,
    /// Reported repository-relative file.
    pub file: Option<String>,
    /// Separate host label, when reported and visible in this workspace.
    pub host: Option<HostLabel>,
    /// Supplied current-work summary, preserved without inferred activity.
    pub summary: Option<String>,
    /// Available session and host invitations; may be empty.
    pub joins: Vec<JoinOffer>,
}

/// Which observed branch transition prompted an invitation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchChange {
    /// The local checkout switched to a peer's branch.
    Local,
    /// A known peer switched to the local checkout's branch.
    Peer,
}

/// One observed transition, never generated merely by initial discovery/reconnect.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BranchInvitation {
    /// Stable until acknowledged; unique for this awareness instance across resets.
    pub id: String,
    /// Direction of the transition.
    pub change: BranchChange,
    /// Peer and any currently grant-backed join choices.
    pub peer: Peer,
}

/// Native presentation, serialized for the extension-lifetime TypeScript adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AwarenessView {
    /// Context echoed for stale-response rejection by the host.
    pub editor: EditorContext,
    /// Fresh connections working on exactly the active repository-relative file.
    pub peers: Vec<Peer>,
    /// Current grant-backed choices, including peers outside the active file.
    pub join_offers: Vec<JoinOffer>,
    /// Unacknowledged branch transitions, refreshed against current visible peers.
    pub invitations: Vec<BranchInvitation>,
    /// Maximum lifetime from request start; refresh or clear when it elapses.
    pub valid_for_ms: u64,
}

/// Current routing details after rechecking a selected grant against fresh state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedJoin {
    /// Original intent, retaining contributor and grant attribution.
    pub request: JoinRequest,
    /// Current discovery references; the transport resolves these after authorization.
    pub routes: Vec<ConnectionRoute>,
    /// Current runtime for session joins; absent for a general host connection.
    pub runtime_id: Option<String>,
}

/// An awareness input or invitation is no longer usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AwarenessError {
    /// Loading, disconnected, foreign, revoked or inconsistent workspace state.
    Unavailable,
    /// A selected invitation no longer has a matching fresh peer and live grant.
    JoinUnavailable,
}
