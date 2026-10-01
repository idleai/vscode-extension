use app_core::workspace::PresenceEntry;
use idle_protocol::v1::{
    grants::{ComputePermission, Grant, GrantScope, GrantStatus, SessionPermission},
    resources::HostCapability,
};

use super::{
    AuthorizedJoin, AwarenessError, AwarenessInput, JoinOffer, JoinRequest, JoinTarget, project,
};

pub(super) fn offers(input: &AwarenessInput<'_>, connection: &PresenceEntry) -> Vec<JoinOffer> {
    let Some(host) = input.directory.hosts.iter().find(|host| {
        Some(&host.value.id.0) == connection.host_id.as_ref()
            && project::available(&host.value, input.now_ms)
    }) else {
        return Vec::new();
    };
    let mut offers = Vec::new();
    for session in &input.directory.sessions {
        if session.value.runtime.host_id != host.value.id
            || !host.value.capabilities.contains(&HostCapability::Sessions)
            || !input.sessions.iter().any(|link| {
                link.connection_id == connection.connection_id
                    && link.session_id == session.value.id.0
            })
        {
            continue;
        }
        let target = JoinTarget::Session {
            session_id: session.value.id.0.clone(),
        };
        if let Some(grant) = grant(input, &target) {
            offers.push(offer(
                input,
                connection,
                &session.value.title,
                target,
                grant,
            ));
        }
    }
    let target = JoinTarget::Host {
        host_id: host.value.id.0.clone(),
    };
    if let Some(grant) = grant(input, &target) {
        offers.push(offer(input, connection, &host.value.name, target, grant));
    }
    offers
}

fn grant<'a>(input: &'a AwarenessInput<'_>, target: &JoinTarget) -> Option<&'a Grant> {
    input
        .directory
        .grants
        .iter()
        .map(|record| &record.value)
        .filter(|grant| eligible(input, grant, target))
        .min_by(|left, right| left.id.cmp(&right.id))
}

fn eligible(input: &AwarenessInput<'_>, grant: &Grant, target: &JoinTarget) -> bool {
    grant.grantee.0 == input.editor.contributor_id
        && grant.status == GrantStatus::Active
        && grant
            .expires_at
            .is_none_or(|expiry| input.now_ms < expiry.0)
        && match (&grant.scope, target) {
            (
                GrantScope::Session {
                    session_id,
                    permissions,
                },
                JoinTarget::Session { session_id: id },
            ) => &session_id.0 == id && permissions.contains(&SessionPermission::Observe),
            (
                GrantScope::Compute {
                    host_id,
                    permissions,
                },
                JoinTarget::Host { host_id: id },
            ) => &host_id.0 == id && permissions.contains(&ComputePermission::Connect),
            (
                GrantScope::Session { .. }
                | GrantScope::Compute { .. }
                | GrantScope::Provider { .. },
                _,
            ) => false,
        }
}

fn offer(
    input: &AwarenessInput<'_>,
    connection: &PresenceEntry,
    label: &str,
    target: JoinTarget,
    grant: &Grant,
) -> JoinOffer {
    JoinOffer {
        label: label.to_owned(),
        request: JoinRequest {
            binding: input.editor.binding.clone(),
            mode: input.editor.mode,
            contributor_id: input.editor.contributor_id.clone(),
            connection_id: connection.connection_id.clone(),
            target,
            grant_id: grant.id.0.clone(),
        },
    }
}

/// Recheck a selected invitation against current app-core state and provider time.
///
/// This returns discovery details, not an authorization token. The adapter must
/// authenticate the contributor, authorize the same grant at the authority/runtime,
/// and respect cancellation before connecting. Session joins do not grant compute
/// access and host joins do not grant file/process permissions.
///
/// # Errors
/// Returns an error when scope, membership, peer location, health or grants changed.
pub fn prepare_join(
    input: &AwarenessInput<'_>,
    request: &JoinRequest,
) -> Result<AuthorizedJoin, AwarenessError> {
    let projection = project::project(input)?;
    let peer = projection
        .peers
        .iter()
        .find(|(peer, _)| peer.connection_id == request.connection_id)
        .ok_or(AwarenessError::JoinUnavailable)?;
    let grant = input
        .directory
        .grants
        .iter()
        .find(|grant| grant.value.id.0 == request.grant_id)
        .ok_or(AwarenessError::JoinUnavailable)?;
    if request.binding != input.editor.binding
        || request.mode != input.editor.mode
        || request.contributor_id != input.editor.contributor_id
        || !eligible(input, &grant.value, &request.target)
        || !peer
            .0
            .joins
            .iter()
            .any(|offer| offer.request.target == request.target)
    {
        return Err(AwarenessError::JoinUnavailable);
    }
    let host = input
        .directory
        .hosts
        .iter()
        .find(|host| Some(&host.value.id.0) == peer.1.host_id.as_ref())
        .ok_or(AwarenessError::JoinUnavailable)?;
    let runtime_id = match &request.target {
        JoinTarget::Session { session_id } => Some(
            input
                .directory
                .sessions
                .iter()
                .find(|session| &session.value.id.0 == session_id)
                .ok_or(AwarenessError::JoinUnavailable)?
                .value
                .runtime
                .runtime_id
                .0
                .clone(),
        ),
        JoinTarget::Host { .. } => None,
    };
    Ok(AuthorizedJoin {
        request: request.clone(),
        routes: host.value.routes.clone(),
        runtime_id,
    })
}
