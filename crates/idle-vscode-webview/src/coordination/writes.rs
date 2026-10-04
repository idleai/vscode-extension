//! Exact standalone write envelopes and provider-confirmed configuration outcomes.

use app_core::configuration::{
    ConfigurationAction, ConfigurationError, ConfigurationErrorKind, ConfigurationOperation,
    ConfigurationRecord, ConfigurationResult, ConfigurationValue,
};
use idle_protocol::v1::{
    api::{ApiResult, ErrorCode, Request, Response},
    identity::{ContributorIdentity, ExternalIdentity},
    standalone::{Mutation, MutationResult, MutationValue, RepositorySnapshot},
};
use serde_json::{Value, json};

pub(super) fn command(operation: &ConfigurationOperation) -> Result<Value, String> {
    let subject = operation
        .context
        .contributor_id
        .strip_prefix("local-contributor:")
        .ok_or("Configuration requires a local contributor")?;
    let request = operation
        .write_request(ContributorIdentity {
            contributor_id: operation.context.contributor_id.as_str().into(),
            authenticated_as: ExternalIdentity {
                issuer: "idle-vscode-local".into(),
                subject: subject.into(),
            },
        })
        .map_err(|error| error.to_string())?;
    let write = serde_json::from_value(
        serde_json::to_value(request.body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"kind":"mutate", "data": Request {
        api_version: request.api_version, context: request.context,
        control_fence: request.control_fence, body: Mutation::Configuration(write),
    }}))
}

pub(super) fn configuration(
    operation: &ConfigurationOperation,
    data: Value,
    current: Option<&Value>,
) -> Result<Value, String> {
    let ConfigurationAction::Save(save) = &operation.action else {
        return Err("Expected a configuration write".into());
    };
    let response: Response<MutationResult> =
        serde_json::from_value(data).map_err(|error| error.to_string())?;
    if response.request.workspace_id.0 != operation.context.workspace_id
        || response.request.contributor_id.0 != operation.context.contributor_id
        || response.request.request_id.0 != save.request.request_id
    {
        return Err("Configuration response belongs to another request".into());
    }
    let result = match response.result {
        ApiResult::Success(result) => {
            if result.through.workspace_id.0 != operation.context.workspace_id
                || result.through.contributor_id.0 != operation.context.contributor_id
                || result.through.stream_id.0.is_empty()
            {
                return Err("Configuration commit belongs to another connection".into());
            }
            let MutationValue::Configuration(record) = result.value else {
                return Err("Expected a committed configuration record".into());
            };
            let raw = current
                .and_then(Value::as_str)
                .ok_or("Missing current configuration authorization")?;
            let envelope: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
            let snapshot: RepositorySnapshot = serde_json::from_value(
                envelope
                    .pointer("/result/Ok")
                    .cloned()
                    .ok_or("Invalid configuration snapshot")?,
            )
            .map_err(|error| error.to_string())?;
            let mut snapshot = super::reads::configuration_snapshot(operation, snapshot)?;
            snapshot.record = Some(ConfigurationRecord {
                revision: record.revision.0,
                value: ConfigurationValue {
                    schema_version: record.value.schema_version,
                    json: record.value.json,
                },
            });
            ConfigurationResult::Saved {
                request: save.request.clone(),
                snapshot,
            }
        }
        ApiResult::Failure(error) => ConfigurationResult::Rejected {
            request: save.request.clone(),
            error: ConfigurationError {
                kind: error_kind(error.code),
                message: error.message,
            },
        },
    };
    Ok(json!({"Ok":result}))
}

const fn error_kind(code: ErrorCode) -> ConfigurationErrorKind {
    match code {
        ErrorCode::InvalidRequest | ErrorCode::IdempotencyConflict | ErrorCode::RequestExpired => {
            ConfigurationErrorKind::InvalidInput
        }
        ErrorCode::UnsupportedVersion | ErrorCode::UnsupportedOperation => {
            ConfigurationErrorKind::Unsupported
        }
        ErrorCode::Unauthenticated => ConfigurationErrorKind::Unauthenticated,
        ErrorCode::Forbidden | ErrorCode::NotFound => ConfigurationErrorKind::Forbidden,
        ErrorCode::Conflict | ErrorCode::StaleRevision | ErrorCode::StaleControl => {
            ConfigurationErrorKind::Conflict
        }
        ErrorCode::CursorScopeMismatch => ConfigurationErrorKind::InvalidData,
        ErrorCode::Unavailable | ErrorCode::RateLimited => ConfigurationErrorKind::Unavailable,
    }
}
