use app_core::workspace::{
    MemberStatus, MemberView, PresenceEntry, PresenceStatus, ViewModel, WorkspaceMode,
    WorkspaceRequestState, WorkspaceSnapshot,
};
use idle_protocol::v1::{
    events::RecoverySnapshot,
    grants::{GrantScope, GrantStatus, SessionPermission},
    identity::Timestamp,
    membership::MembershipStatus,
    resources::Availability,
    workspace::CoordinationMode,
};

use super::{
    AwarenessError, AwarenessInput, AwarenessView, BranchChange, EditorContext, PeerAwareness,
    SessionConnection, prepare_join,
};

struct Scenario {
    editor: EditorContext,
    workspace: ViewModel,
    directory: RecoverySnapshot,
    sessions: Vec<SessionConnection>,
    now_ms: u64,
}

impl Scenario {
    fn new(mode: WorkspaceMode) -> Self {
        let view: AwarenessView =
            serde_json::from_str(include_str!("../../../../test/fixtures/peer-view.json"))
                .expect("native view fixture");
        let directory: RecoverySnapshot = serde_json::from_str(include_str!(
            "../../../../test/fixtures/peer-directory.json"
        ))
        .expect("published directory contract");
        let mut scenario = Self {
            editor: view.editor,
            workspace: ViewModel::default(),
            directory,
            sessions: vec![SessionConnection {
                connection_id: "alice-connection".into(),
                session_id: "session".into(),
            }],
            now_ms: 1_000,
        };
        if mode == WorkspaceMode::Managed {
            let CoordinationMode::Standalone { repository } =
                &scenario.directory.workspace.value.mode
            else {
                return scenario;
            };
            scenario.directory.workspace.value.mode = CoordinationMode::Managed {
                repositories: vec![repository.clone()],
            };
            scenario.editor.mode = mode;
        }
        scenario.sync_metadata();
        scenario
            .workspace
            .members
            .iter_mut()
            .find(|member| member.member.contributor_id == "alice")
            .expect("Alice member")
            .connections
            .push(PresenceEntry {
                connection_id: "alice-connection".into(),
                contributor_id: "alice".into(),
                status: PresenceStatus::Online,
                repository_id: Some("repo".into()),
                branch: Some("feature".into()),
                file: Some("src/lib.rs".into()),
                host_id: Some("remote-host".into()),
                summary: Some("Fixing parser edge cases.".into()),
                observed_at_ms: 900,
                valid_until_ms: 20_000,
            });
        scenario
    }

    fn sync_metadata(&mut self) {
        let snapshot =
            WorkspaceSnapshot::try_from(&self.directory).expect("valid workspace snapshot");
        let members = snapshot
            .members
            .iter()
            .map(|member| MemberView {
                member: member.clone(),
                presence: PresenceStatus::Online,
                connections: self
                    .workspace
                    .members
                    .iter()
                    .find(|old| old.member.contributor_id == member.contributor_id)
                    .map_or_else(Vec::new, |old| old.connections.clone()),
            })
            .collect();
        self.workspace = ViewModel {
            workspaces: vec![snapshot.workspace.clone()],
            directory_state: WorkspaceRequestState::Ready,
            selected_workspace: Some(self.editor.binding.workspace_id.clone()),
            selected_repository: Some(self.editor.binding.repository_id.clone()),
            chain: Some(self.editor.binding.chain.clone()),
            repository_binding: Some(self.editor.binding.clone()),
            repository_bindings: vec![self.editor.binding.clone()],
            snapshot: Some(snapshot),
            snapshot_state: WorkspaceRequestState::Ready,
            members,
            presence_state: WorkspaceRequestState::Ready,
            ..ViewModel::default()
        };
    }

    fn connection(&mut self) -> &mut PresenceEntry {
        self.workspace
            .members
            .iter_mut()
            .find(|member| member.member.contributor_id == "alice")
            .expect("Alice member")
            .connections
            .first_mut()
            .expect("Alice connection")
    }

    fn input(&self) -> AwarenessInput<'_> {
        AwarenessInput {
            editor: &self.editor,
            workspace: &self.workspace,
            directory: &self.directory,
            sessions: &self.sessions,
            now_ms: self.now_ms,
        }
    }

    fn view(&self) -> AwarenessView {
        PeerAwareness::default()
            .update(&self.input())
            .expect("valid awareness input")
    }
}

#[test]
fn both_providers_match_the_native_host_fixture_and_preserve_identity() {
    for mode in [WorkspaceMode::Standalone, WorkspaceMode::Managed] {
        let scenario = Scenario::new(mode);
        let mut expected: AwarenessView =
            serde_json::from_str(include_str!("../../../../test/fixtures/peer-view.json"))
                .expect("host fixture");
        expected.editor.mode = mode;
        for offer in expected
            .peers
            .iter_mut()
            .flat_map(|peer| &mut peer.joins)
            .chain(&mut expected.join_offers)
        {
            offer.request.mode = mode;
        }
        let view = scenario.view();
        assert_eq!(
            view, expected,
            "Rust and TypeScript use the same view contract in both modes"
        );
        assert_eq!(
            serde_json::to_value(&view).expect("serialize"),
            serde_json::to_value(expected).expect("fixture"),
            "wire fields and enum casing agree"
        );
        let peer = view.peers.first().expect("peer");
        assert_eq!(
            peer.contributor_id, "alice",
            "neither the session owner nor the host owner replaces the contributor"
        );
        for offer in &peer.joins {
            let join = prepare_join(&scenario.input(), &offer.request).expect("current grant");
            assert_eq!(
                join.request.contributor_id, "me",
                "join is attributed to the actual caller"
            );
            assert_eq!(
                join.routes.first().expect("route").reference,
                "route:remote-host",
                "route is resolved from current discovery"
            );
        }
    }
}

#[test]
fn same_file_matching_is_scoped_exact_and_does_not_infer_missing_work() {
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    for file in [
        "lib.rs",
        "other/src/lib.rs",
        "../src/lib.rs",
        "/src/lib.rs",
        "src\\lib.rs",
    ] {
        scenario.connection().file = Some(file.into());
        assert!(
            scenario.view().peers.is_empty(),
            "only the exact normalized repository-relative file matches"
        );
    }
    scenario.connection().file = Some("src/lib.rs".into());
    scenario.connection().repository_id = Some("other-repo".into());
    assert!(
        scenario.view().peers.is_empty(),
        "same path in another repository is not the same file"
    );
    scenario.connection().repository_id = Some("repo".into());
    scenario.connection().branch = None;
    scenario.connection().summary = None;
    scenario.connection().host_id = None;
    let view = scenario.view();
    let peer = view.peers.first().expect("visible peer");
    assert!(
        peer.branch.is_none() && peer.summary.is_none() && peer.host.is_none(),
        "missing reports remain unknown"
    );
    assert!(
        peer.joins.is_empty(),
        "no host/session inferred from ownership"
    );
}

#[test]
fn offline_expired_future_and_revoked_peers_are_hidden() {
    for status in [PresenceStatus::Unknown, PresenceStatus::Offline] {
        let mut scenario = Scenario::new(WorkspaceMode::Standalone);
        scenario.connection().status = status;
        assert!(
            scenario.view().peers.is_empty(),
            "offline and unknown are not working peers"
        );
    }
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    scenario.now_ms = 20_000;
    assert!(
        scenario.view().peers.is_empty(),
        "freshness has an exclusive deadline"
    );
    scenario.now_ms = 800;
    assert!(
        scenario.view().peers.is_empty(),
        "future observations are not current"
    );
    scenario.now_ms = 1_000;
    scenario
        .directory
        .memberships
        .iter_mut()
        .find(|member| member.value.contributor_id.0 == "alice")
        .expect("member")
        .value
        .status = MembershipStatus::Revoked;
    scenario.sync_metadata();
    assert!(
        scenario.view().peers.is_empty(),
        "revocation wins over lingering presence"
    );
}

#[test]
fn mismatched_stale_or_ambiguous_contexts_fail_closed() {
    let mut scenario = Scenario::new(WorkspaceMode::Managed);
    scenario.editor.binding.chain = "foreign-chain".into();
    assert_eq!(
        PeerAwareness::default().update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "chain binding must agree"
    );
    let mut scenario = Scenario::new(WorkspaceMode::Managed);
    scenario.workspace.presence_state = WorkspaceRequestState::Loading;
    assert_eq!(
        PeerAwareness::default().update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "loading presence is stale"
    );
    let mut scenario = Scenario::new(WorkspaceMode::Managed);
    scenario.directory.as_of.contributor_id = "other-user".into();
    assert_eq!(
        PeerAwareness::default().update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "directory audience is not transferable"
    );
    let mut scenario = Scenario::new(WorkspaceMode::Managed);
    let duplicate = scenario.directory.grants.first().expect("grant").clone();
    scenario.directory.grants.push(duplicate);
    assert_eq!(
        PeerAwareness::default().update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "ambiguous grant versions cannot authorize a join"
    );
    let mut scenario = Scenario::new(WorkspaceMode::Managed);
    scenario
        .workspace
        .members
        .first_mut()
        .expect("local member")
        .member
        .status = MemberStatus::Revoked;
    assert_eq!(
        PeerAwareness::default().update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "inconsistent metadata cannot be used"
    );
}

#[test]
fn joins_require_independent_live_grants_and_explicit_session_links() {
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    let offers = scenario.view().peers.first().expect("peer").joins.clone();
    scenario
        .directory
        .grants
        .retain(|grant| grant.value.id.0 == "session-grant");
    assert_eq!(
        scenario.view().peers.first().expect("peer").joins.len(),
        1,
        "session permission never implies host access"
    );
    assert!(
        prepare_join(
            &scenario.input(),
            &offers.last().expect("host offer").request
        )
        .is_err(),
        "host grant is required again when clicking"
    );
    scenario.sessions.clear();
    assert!(
        scenario
            .view()
            .peers
            .first()
            .expect("peer")
            .joins
            .is_empty(),
        "same host and ownership are not a session association"
    );
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    scenario
        .directory
        .grants
        .first_mut()
        .expect("session grant")
        .value
        .scope = GrantScope::Session {
        session_id: "session".into(),
        permissions: vec![SessionPermission::SubmitInput],
    };
    assert_eq!(
        scenario.view().peers.first().expect("peer").joins.len(),
        1,
        "input permission is not an observe permission"
    );
    scenario.directory.grants.clear();
    assert!(
        scenario
            .view()
            .peers
            .first()
            .expect("peer")
            .joins
            .is_empty(),
        "membership and host availability alone grant nothing"
    );
}

#[test]
fn invitation_click_rechecks_revocation_expiry_identity_health_and_current_routes() {
    for mode in [WorkspaceMode::Standalone, WorkspaceMode::Managed] {
        let mut scenario = Scenario::new(mode);
        let request = scenario
            .view()
            .peers
            .first()
            .expect("peer")
            .joins
            .first()
            .expect("session")
            .request
            .clone();
        scenario
            .directory
            .grants
            .first_mut()
            .expect("grant")
            .value
            .status = GrantStatus::Revoked {
            revoked_at: Timestamp(1_000),
            revoked_by: "alice".into(),
        };
        assert!(
            prepare_join(&scenario.input(), &request).is_err(),
            "revoked invitation is rejected"
        );
        scenario
            .directory
            .grants
            .first_mut()
            .expect("grant")
            .value
            .status = GrantStatus::Active;
        scenario.now_ms = 10_000;
        assert!(
            prepare_join(&scenario.input(), &request).is_err(),
            "expired invitation is rejected without an expiry event"
        );
        scenario.now_ms = 1_000;
        scenario
            .directory
            .grants
            .first_mut()
            .expect("grant")
            .value
            .grantee = "other".into();
        assert!(
            prepare_join(&scenario.input(), &request).is_err(),
            "a grant for another contributor cannot be used"
        );
        scenario
            .directory
            .grants
            .first_mut()
            .expect("grant")
            .value
            .grantee = "me".into();
        scenario
            .directory
            .hosts
            .last_mut()
            .expect("host")
            .value
            .health
            .availability = Availability::Unavailable;
        assert!(
            prepare_join(&scenario.input(), &request).is_err(),
            "unavailable host cannot be joined"
        );
        scenario
            .directory
            .hosts
            .last_mut()
            .expect("host")
            .value
            .health
            .availability = Availability::Available;
        scenario
            .directory
            .hosts
            .last_mut()
            .expect("host")
            .value
            .routes
            .first_mut()
            .expect("route")
            .reference = "current-route".into();
        let join = prepare_join(&scenario.input(), &request).expect("renewed current route");
        assert_eq!(
            join.routes.first().expect("route").reference,
            "current-route",
            "invitations do not pin stale routing"
        );
        assert_eq!(
            join.runtime_id.as_deref(),
            Some("runtime"),
            "session routing retains runtime identity"
        );
        let mut foreign = request;
        foreign.binding.workspace_id = "foreign".into();
        assert!(
            prepare_join(&scenario.input(), &foreign).is_err(),
            "grant IDs cannot cross workspace boundaries"
        );
    }
}

#[test]
fn branch_notifications_require_real_transitions_and_remain_until_acknowledged() {
    for mode in [WorkspaceMode::Standalone, WorkspaceMode::Managed] {
        let mut scenario = Scenario::new(mode);
        let mut awareness = PeerAwareness::default();
        assert!(
            awareness
                .update(&scenario.input())
                .expect("initial")
                .invitations
                .is_empty(),
            "initial discovery is not a branch switch"
        );
        scenario.editor.branch = Some("feature".into());
        let local = awareness.update(&scenario.input()).expect("local switch");
        assert_eq!(
            local.invitations.first().expect("invitation").change,
            BranchChange::Local,
            "local checkout converged"
        );
        assert_eq!(
            awareness
                .update(&scenario.input())
                .expect("refresh")
                .invitations,
            local.invitations,
            "a discarded host response must not consume the invitation"
        );
        awareness.acknowledge_invitations(
            &local
                .invitations
                .iter()
                .map(|invitation| invitation.id.clone())
                .collect::<Vec<_>>(),
        );
        assert!(
            awareness
                .update(&scenario.input())
                .expect("duplicate")
                .invitations
                .is_empty(),
            "refresh does not repeat notifications"
        );
        scenario.editor.branch = Some("main".into());
        let _view = awareness
            .update(&scenario.input())
            .expect("local departure");
        scenario.connection().branch = Some("main".into());
        scenario.connection().observed_at_ms = 950;
        scenario.connection().file = Some("another-file.rs".into());
        let remote = awareness.update(&scenario.input()).expect("remote switch");
        assert!(
            remote.peers.is_empty(),
            "header still matches the exact file"
        );
        assert_eq!(
            remote.invitations.first().expect("invitation").change,
            BranchChange::Peer,
            "remote convergence is independent of active file"
        );
        assert_eq!(remote.join_offers.len(), 2, "off-file grants remain usable");
        awareness.reset();
        assert!(
            awareness
                .update(&scenario.input())
                .expect("reconnect")
                .invitations
                .is_empty(),
            "reconnect establishes a baseline"
        );
    }
}

#[test]
fn detached_branches_host_changes_and_disconnected_intervals_do_not_imply_switches() {
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    let mut awareness = PeerAwareness::default();
    let _view = awareness.update(&scenario.input()).expect("baseline");
    scenario.editor.branch = None;
    assert!(
        awareness
            .update(&scenario.input())
            .expect("detached")
            .invitations
            .is_empty(),
        "detached HEAD is not a branch name"
    );
    scenario.editor.branch = Some("feature".into());
    assert!(
        awareness
            .update(&scenario.input())
            .expect("unknown to known")
            .invitations
            .is_empty(),
        "unknown branch cannot establish a transition"
    );
    scenario.editor.branch = Some("main".into());
    scenario.workspace.presence_state = WorkspaceRequestState::Loading;
    assert!(
        awareness.update(&scenario.input()).is_err(),
        "unavailable view clears the baseline"
    );
    scenario.workspace.presence_state = WorkspaceRequestState::Ready;
    scenario.connection().branch = Some("main".into());
    assert!(
        awareness
            .update(&scenario.input())
            .expect("recovered")
            .invitations
            .is_empty(),
        "missed intervals cannot establish a switch"
    );
    scenario.connection().branch = Some("feature".into());
    scenario.connection().host_id = Some("local-host".into());
    let _view = awareness.update(&scenario.input()).expect("same host");
    scenario.editor.branch = Some("feature".into());
    assert!(
        awareness
            .update(&scenario.input())
            .expect("already co-located")
            .invitations
            .is_empty(),
        "same-host users need no host convergence prompt"
    );
}

#[test]
fn delayed_branch_observations_and_new_recovery_streams_do_not_create_false_switches() {
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    let mut awareness = PeerAwareness::default();
    let _view = awareness.update(&scenario.input()).expect("baseline");
    scenario.connection().branch = Some("main".into());
    scenario.connection().observed_at_ms = 950;
    let current = awareness.update(&scenario.input()).expect("current");
    assert_eq!(
        current.invitations.len(),
        1,
        "new observation establishes the transition"
    );
    scenario.connection().branch = Some("feature".into());
    scenario.connection().observed_at_ms = 900;
    assert_eq!(
        awareness.update(&scenario.input()),
        Err(AwarenessError::Unavailable),
        "delayed input cannot replace newer observations"
    );
    scenario.connection().branch = Some("main".into());
    scenario.connection().observed_at_ms = 950;
    awareness.acknowledge_invitations(
        &current
            .invitations
            .iter()
            .map(|invitation| invitation.id.clone())
            .collect::<Vec<_>>(),
    );
    assert!(
        awareness
            .update(&scenario.input())
            .expect("replay")
            .invitations
            .is_empty(),
        "replay does not repeat the switch"
    );
    scenario.connection().branch = Some("feature".into());
    scenario.connection().observed_at_ms = 975;
    scenario.editor.branch = Some("feature".into());
    scenario.directory.as_of.stream_id = "new-stream".into();
    assert!(
        awareness
            .update(&scenario.input())
            .expect("new stream")
            .invitations
            .is_empty(),
        "recovery reset establishes a fresh baseline"
    );
}

#[test]
fn retained_invitations_refresh_grants_and_survive_changes_to_the_active_file() {
    for mode in [WorkspaceMode::Standalone, WorkspaceMode::Managed] {
        let mut scenario = Scenario::new(mode);
        let mut awareness = PeerAwareness::default();
        let _view = awareness.update(&scenario.input()).expect("baseline");
        scenario.editor.branch = Some("feature".into());
        let first = awareness.update(&scenario.input()).expect("transition");
        let invitation = first.invitations.first().expect("invitation");
        scenario.editor.file = Some("another.rs".into());
        scenario.connection().summary = Some("Updated summary".into());
        scenario
            .directory
            .grants
            .retain(|grant| grant.value.id.0 != "session-grant");
        let updated = awareness
            .update(&scenario.input())
            .expect("refreshed grants");
        let pending = updated.invitations.first().expect("pending invitation");
        assert_eq!(
            pending.id, invitation.id,
            "the same transition keeps its ID"
        );
        assert!(
            updated.peers.is_empty(),
            "same-file headers remain independent"
        );
        assert_eq!(
            pending.peer.summary.as_deref(),
            Some("Updated summary"),
            "peer details are refreshed"
        );
        assert_eq!(pending.peer.joins.len(), 1, "revoked choices are removed");
        assert_eq!(
            updated.join_offers, pending.peer.joins,
            "current joins include off-file peers"
        );
        awareness.acknowledge_invitations(std::slice::from_ref(&pending.id));
        let acknowledged = awareness.update(&scenario.input()).expect("acknowledged");
        assert!(
            acknowledged.invitations.is_empty(),
            "displayed prompts do not repeat"
        );
        assert_eq!(
            acknowledged.join_offers, updated.join_offers,
            "acknowledgement does not revoke a join"
        );
    }
}

#[test]
fn pending_invitations_end_with_convergence_and_reset_never_reuses_their_ids() {
    let mut scenario = Scenario::new(WorkspaceMode::Standalone);
    let mut awareness = PeerAwareness::default();
    let _view = awareness.update(&scenario.input()).expect("baseline");
    scenario.editor.branch = Some("feature".into());
    let first = awareness
        .update(&scenario.input())
        .expect("first transition");
    let old_id = first.invitations.first().expect("invitation").id.clone();
    scenario.editor.branch = Some("main".into());
    assert!(
        awareness
            .update(&scenario.input())
            .expect("departure")
            .invitations
            .is_empty(),
        "obsolete prompts are removed"
    );
    awareness.reset();
    let _view = awareness.update(&scenario.input()).expect("new baseline");
    scenario.editor.branch = Some("feature".into());
    let second = awareness
        .update(&scenario.input())
        .expect("next transition");
    let new_id = &second.invitations.first().expect("invitation").id;
    assert_ne!(
        &old_id, new_id,
        "late acknowledgements cannot consume a newer transition"
    );
    awareness.acknowledge_invitations(&[old_id]);
    assert_eq!(
        awareness
            .update(&scenario.input())
            .expect("late acknowledgement")
            .invitations,
        second.invitations,
        "only matching IDs are acknowledged"
    );
    scenario.connection().valid_until_ms = scenario.now_ms;
    let expired = awareness.update(&scenario.input()).expect("expired peer");
    assert!(
        expired.invitations.is_empty(),
        "expired peers cannot retain invitations"
    );
    assert!(
        expired.join_offers.is_empty(),
        "expired peers cannot retain joins"
    );
}

#[test]
fn unknown_host_labels_do_not_hide_observed_branch_transitions_or_invent_join_targets() {
    for (local, remote) in [(Some("local-host"), None), (None, Some("remote-host"))] {
        let mut scenario = Scenario::new(WorkspaceMode::Standalone);
        scenario.editor.host_id = local.map(str::to_owned);
        scenario.connection().host_id = remote.map(str::to_owned);
        let mut awareness = PeerAwareness::default();
        let _view = awareness.update(&scenario.input()).expect("baseline");
        scenario.connection().branch = Some("main".into());
        scenario.connection().observed_at_ms = 950;
        let view = awareness.update(&scenario.input()).expect("branch change");
        let invitation = view
            .invitations
            .first()
            .expect("reported branch transition");
        assert_eq!(
            invitation.change,
            BranchChange::Peer,
            "branch observations remain useful without a host label"
        );
        assert_eq!(
            invitation.peer.joins.is_empty(),
            remote.is_none(),
            "joins still require a known target and its own grant"
        );
    }
}
