//! Native shared-session wire calls with authenticated app-core projections.

use app_core::sessions::{
    SessionAcknowledgement, SessionAction, SessionAdapterContext, SessionCapabilities,
    SessionCapability, SessionChanges, SessionError, SessionErrorCode, SessionInfo,
    SessionInputUpdate, SessionMutation, SessionOperation, SessionOutput, SessionReceipt,
    SessionResult, SessionRetryAdvice, SessionSnapshot,
};
use idle_protocol::v1::{
    ApiVersion, Record,
    api::{ApiResult, Command, Request, Response},
    identity::{ContributorIdentity, RequestContext, RequestKey},
    sessions::{InputRef, RuntimeInputUpdate, Session},
    standalone::{MutationResult, RepositorySnapshot},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Default)]
pub(crate) struct Adapter {
    pub(crate) enabled: bool,
    pub(crate) host_id: Option<String>,
    pub(crate) now_ms: Option<u64>,
    pub(crate) members: Vec<app_core::workspace::MemberInfo>,
    pub(crate) readiness: Option<String>,
}

impl Adapter {
    pub(crate) fn route(&self, operation: &SessionOperation) -> Result<String, String> {
        if !self.enabled {
            return Err("The host does not support live sessions".into());
        }
        let command = match &operation.action {
            SessionAction::Snapshot | SessionAction::Watch { .. } => json!({"kind":"snapshot"}),
            SessionAction::InputStatus(input) => {
                json!({"kind":"input_status","input":InputRef::from(input)})
            }
            SessionAction::RequestStatus(key) => {
                json!({"kind":"request_status","key":RequestKey::from(key)})
            }
            SessionAction::Mutate {
                request,
                mutation: SessionMutation::Create(draft),
            } => {
                if draft.parent.is_some() {
                    return Err(
                        "Creating a child session is not available on this connection".into(),
                    );
                }
                json!({"kind":"create","request":Request {
                    api_version: ApiVersion::V1, context: RequestContext::from(request), control_fence: None,
                    body: json!({"title":draft.title,"host_id":draft.host_id}),
                }})
            }
            SessionAction::Mutate {
                mutation: SessionMutation::Submit { .. },
                ..
            } => {
                json!({"kind":"submit","request":operation.runtime_submission().map_err(|error| error.to_string())?.ok_or("Missing input request")?})
            }
            SessionAction::Mutate {
                mutation: SessionMutation::Invite { .. } | SessionMutation::Revoke { .. },
                ..
            } => {
                let request = operation
                    .coordination_command()
                    .map_err(|error| error.to_string())?
                    .ok_or("Missing grant request")?;
                let Command::Grant(body) = request.body else {
                    return Err("Expected a session grant".into());
                };
                json!({"kind":"grant","request":Request { api_version:request.api_version, context:request.context, control_fence:request.control_fence, body }})
            }
        };
        Ok(command.to_string())
    }

    pub(crate) fn decode(
        &mut self,
        operation: &SessionOperation,
        value: Value,
        view: &app_core::ViewModel,
    ) -> Result<Value, String> {
        let Some(data) = value.get("session") else {
            return Ok(value);
        };
        let output = self.result(
            operation,
            data,
            value.get("changed") == Some(&Value::Bool(true)),
            view,
        );
        serde_json::to_value(output).map_err(|error| error.to_string())
    }

    fn result(
        &mut self,
        operation: &SessionOperation,
        data: &Value,
        changed: bool,
        view: &app_core::ViewModel,
    ) -> SessionOutput {
        if let Some(code) = data.pointer("/error/code").and_then(Value::as_str) {
            return Err(failure(code));
        }
        if let SessionAction::Watch { after } = &operation.action {
            let raw: Snapshot = decode(data.clone())?;
            self.now_ms = Some(raw.now_ms);
            return if changed {
                Ok(SessionResult::SnapshotRequired)
            } else {
                Ok(SessionResult::Changes(SessionChanges {
                    after: after.clone(),
                    through: after.clone(),
                    events: Vec::new(),
                    now_ms: raw.now_ms,
                }))
            };
        }
        if operation.action == SessionAction::Snapshot {
            let raw: Snapshot = decode(data.clone())?;
            let execution = if raw.readiness.is_none() {
                SessionCapability::Available
            } else {
                SessionCapability::Unavailable
            };
            let adapter = SessionAdapterContext {
                context: operation.context.clone(),
                contributor: raw.contributor,
                now_ms: raw.now_ms,
                capabilities: SessionCapabilities {
                    create: execution,
                    input: execution,
                    share: SessionCapability::Available,
                },
            };
            let mut snapshot = SessionSnapshot::from_live_protocol(
                &crate::coordination::recovery_snapshot(raw.repository),
                &adapter,
            )?;
            snapshot.transcripts = raw.transcripts;
            for transcript in &mut snapshot.transcripts {
                transcript.input = raw
                    .inputs
                    .iter()
                    .find(|input| {
                        input.turn_id.as_ref() == Some(&transcript.turn_id)
                            && input.update.input.session_id.0 == transcript.session_id
                    })
                    .map(|input| (&input.update.input).into());
            }
            snapshot.inputs = raw
                .inputs
                .into_iter()
                .map(|input| {
                    let mut update = SessionInputUpdate::from(&input.update);
                    update.text = input.text;
                    update
                })
                .collect();
            self.members.clone_from(&snapshot.members);
            self.now_ms = Some(raw.now_ms);
            self.host_id = Some(raw.host_id);
            self.readiness = raw.readiness;
            return Ok(SessionResult::Snapshot(Box::new(snapshot)));
        }
        match data.get("kind").and_then(Value::as_str) {
            Some("input") => {
                let update: RuntimeInputUpdate = decode(
                    data.get("update")
                        .cloned()
                        .ok_or_else(|| failure("invalid"))?,
                )?;
                Ok(SessionResult::Input((&update).into()))
            }
            Some("created") => {
                let key: RequestKey = decode(
                    data.get("request")
                        .cloned()
                        .ok_or_else(|| failure("invalid"))?,
                )?;
                if data.get("ready") != Some(&Value::Bool(true)) {
                    return Ok(SessionResult::Retryable((&key).into()));
                }
                let session: Record<Session> = decode(
                    data.get("session")
                        .cloned()
                        .ok_or_else(|| failure("invalid"))?,
                )?;
                Ok(SessionResult::Created {
                    request: (&key).into(),
                    session: SessionInfo::from_live_protocol(&session),
                })
            }
            Some("grant") => grant(operation, data, view),
            Some("unknown") => Ok(SessionResult::Unknown),
            _ => Err(failure("invalid")),
        }
    }
}

#[derive(Deserialize)]
struct Snapshot {
    #[serde(rename = "snapshot")]
    repository: RepositorySnapshot,
    contributor: ContributorIdentity,
    now_ms: u64,
    host_id: String,
    inputs: Vec<Input>,
    #[serde(default)]
    transcripts: Vec<app_core::sessions::SessionTranscript>,
    #[serde(default)]
    readiness: Option<String>,
}

#[derive(Deserialize)]
struct Input {
    update: RuntimeInputUpdate,
    text: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, SessionError> {
    serde_json::from_value(value).map_err(|_error| failure("invalid"))
}

fn grant(operation: &SessionOperation, data: &Value, view: &app_core::ViewModel) -> SessionOutput {
    let response: Option<Response<MutationResult>> = decode(
        data.get("response")
            .cloned()
            .ok_or_else(|| failure("invalid"))?,
    )?;
    let Some(response) = response else {
        return Ok(match &operation.action {
            SessionAction::RequestStatus(key) => SessionResult::Retryable(key.clone()),
            SessionAction::Snapshot
            | SessionAction::Watch { .. }
            | SessionAction::Mutate { .. }
            | SessionAction::InputStatus(_) => SessionResult::Unknown,
        });
    };
    let result = match response.result {
        ApiResult::Success(result) => result,
        ApiResult::Failure(error) => return Err(error.into()),
    };
    let key = (&response.request).into();
    let original = view
        .sessions
        .mutations
        .iter()
        .find(|mutation| mutation.request.key() == key)
        .ok_or_else(|| failure("invalid"))?;
    Ok(SessionResult::Acknowledged(
        SessionAcknowledgement::Committed {
            receipt: SessionReceipt {
                request: key,
                received_at_ms: result.committed_at.0,
                retry_until_ms: original.request.mutation.expires_at_ms,
            },
            committed_at_ms: result.committed_at.0,
            through: (&result.through).into(),
        },
    ))
}

pub(crate) fn failure(code: &str) -> SessionError {
    let (code, message, retry) = match code {
        "disconnected" => (
            SessionErrorCode::Unavailable,
            "Connect a runner invitation for this workspace.",
            SessionRetryAdvice::Never,
        ),
        "forbidden" | "denied" => (
            SessionErrorCode::Forbidden,
            "Session access was removed or is not allowed. Ask the session owner for an invitation.",
            SessionRetryAdvice::Never,
        ),
        "expired" => (
            SessionErrorCode::RequestExpired,
            "This request or invitation has expired. Recover its saved status before starting a new task.",
            SessionRetryAdvice::Never,
        ),
        "version" | "incompatible_host" => (
            SessionErrorCode::UnsupportedVersion,
            "Update the editor host tools and compute runtime to use shared sessions.",
            SessionRetryAdvice::Never,
        ),
        "conflict" => (
            SessionErrorCode::IdempotencyConflict,
            "This request identity already belongs to another action. Recover the original request.",
            SessionRetryAdvice::QueryStatus,
        ),
        "invalid" | "invalid_request" => (
            SessionErrorCode::InvalidRequest,
            "The compute host returned invalid session data.",
            SessionRetryAdvice::Never,
        ),
        _ => (
            SessionErrorCode::Unavailable,
            "The session response is unavailable. Your draft and original request are saved; recover its status before retrying.",
            SessionRetryAdvice::QueryStatus,
        ),
    };
    SessionError {
        code,
        message: message.into(),
        retry,
    }
}
