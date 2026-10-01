//! VS Code's platform bridge, extracted from the history renderer's shell.
//!
//! The versioned envelope carries opaque JSON; domain state, request correlation
//! and rendering belong to `app-core` and `web-ui`. Each webview document receives
//! a fresh session from its host so delayed messages cannot cross reloads.

use std::fmt;

use serde_json::{Map, Value};

#[cfg(target_arch = "wasm32")]
mod browser;
#[cfg(target_arch = "wasm32")]
mod handshake;
#[cfg(test)]
mod tests;

#[cfg(target_arch = "wasm32")]
pub use browser::{MessageSubscription, VsCodeBridge};
#[cfg(target_arch = "wasm32")]
pub use handshake::initialize_host_bridge;

/// Version of the extension host's platform envelope.
pub const HOST_PROTOCOL_VERSION: u8 = 1;

/// Method sent after installing the webview's host message listener.
pub const READY_METHOD: &str = "host.ready";

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// An error reported by the platform bridge or returned by the extension host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeError {
    /// Stable machine-readable classification; remote codes remain unchanged.
    pub code: String,
    /// Description suitable for the caller's error reporting surface.
    pub message: String,
    /// Host-selected domain details, such as complete replacement record references.
    pub details: Option<Value>,
}

impl BridgeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            details: None,
        }
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BridgeError {}

/// A validated host message whose domain payload remains opaque to this bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMessage {
    /// Result of a host request; the shared application owns correlation.
    Response {
        /// Caller-assigned request identifier.
        id: String,
        /// Success payload, including explicit JSON null, or a host error.
        result: Result<Value, BridgeError>,
    },
    /// Unsolicited host notification.
    Event {
        /// Platform event name.
        event: String,
        /// Event payload passed unchanged to the shared application.
        params: Value,
    },
}

/// Immutable document session used to construct and validate platform envelopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProtocol {
    session: String,
}

impl HostProtocol {
    /// Bind this protocol instance to a host-generated document session.
    ///
    /// # Errors
    /// Returns an error when the session is empty.
    pub fn new(session: impl Into<String>) -> Result<Self, BridgeError> {
        let session = session.into();
        if session.is_empty() {
            return Err(BridgeError::new("invalid_session", "Host session is empty"));
        }
        Ok(Self { session })
    }

    /// Return the host-generated session assigned to this webview document.
    #[must_use]
    pub fn session(&self) -> &str {
        &self.session
    }

    /// Wrap an opaque JSON request for the extension host.
    ///
    /// The caller supplies request identities and keeps any pending domain state
    /// in the shared application. This method does not dispatch a message.
    ///
    /// # Errors
    /// Returns an error for invalid identifiers/methods or envelopes exceeding
    /// the host's one-mebibyte message limit. Identifiers use ASCII letters,
    /// digits, `_`, `.`, `-` and `:`; methods use the same set without `:`.
    /// Both fields are limited to 128 bytes.
    pub fn request(&self, id: &str, method: &str, params: Value) -> Result<Value, BridgeError> {
        if !valid_identifier(id) || !valid_identifier(method) || method.contains(':') {
            return Err(BridgeError::new(
                "invalid_request",
                "Host request identifier or method has an invalid length or character",
            ));
        }
        let request = Value::Object(Map::from_iter([
            ("protocol".to_owned(), Value::from(HOST_PROTOCOL_VERSION)),
            ("session".to_owned(), Value::from(self.session.clone())),
            ("id".to_owned(), Value::from(id)),
            ("method".to_owned(), Value::from(method)),
            ("params".to_owned(), params),
        ]));
        if request.to_string().len() > MAX_MESSAGE_BYTES {
            return Err(BridgeError::new(
                "message_too_large",
                "Host request exceeds the one-mebibyte message limit",
            ));
        }
        Ok(request)
    }

    /// Validate the version, session and envelope before exposing its payload.
    ///
    /// Success is `{protocol, session, id, result}`, failure replaces `result`
    /// with `error: {code, message, details?}`, and events use `{event, params}` in place
    /// of `{id, result}`. Explicit null success values remain successful.
    ///
    /// # Errors
    /// Returns an error for another session, an unsupported protocol, malformed
    /// fields or an ambiguous envelope containing multiple message kinds.
    pub fn decode(&self, value: &Value) -> Result<HostMessage, BridgeError> {
        if !value.is_object() {
            return Err(invalid_message("Host message must be an object"));
        }
        if value.get("protocol").and_then(Value::as_u64) != Some(u64::from(HOST_PROTOCOL_VERSION)) {
            return Err(BridgeError::new(
                "protocol_mismatch",
                "Host message has an unsupported protocol version",
            ));
        }
        if value.get("session").and_then(Value::as_str) != Some(self.session()) {
            return Err(BridgeError::new(
                "session_mismatch",
                "Host message belongs to another webview document",
            ));
        }
        if value.get("id").is_some() {
            decode_response(value)
        } else {
            decode_event(value)
        }
    }
}

fn invalid_message(message: &str) -> BridgeError {
    BridgeError::new("invalid_message", message)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b':'))
}

fn required_text<'a>(value: &'a Value, field: &str) -> Result<&'a str, BridgeError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid_message(&format!("Host message requires a nonempty {field} string")))
}

fn decode_response(value: &Value) -> Result<HostMessage, BridgeError> {
    if value.get("event").is_some() || value.get("params").is_some() {
        return Err(invalid_message("Host response also contains event fields"));
    }
    let id = required_text(value, "id")?.to_owned();
    let result = match (value.get("result"), value.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let details = error.get("details");
            if details.is_some_and(|value| !value.is_object()) {
                return Err(invalid_message("Host error details must be an object"));
            }
            Err(BridgeError {
                code: required_text(error, "code")?.to_owned(),
                message: required_text(error, "message")?.to_owned(),
                details: details.cloned(),
            })
        }
        (None | Some(_), None | Some(_)) => {
            return Err(invalid_message(
                "Host response requires exactly one result or error",
            ));
        }
    };
    Ok(HostMessage::Response { id, result })
}

fn decode_event(value: &Value) -> Result<HostMessage, BridgeError> {
    if value.get("result").is_some() || value.get("error").is_some() {
        return Err(invalid_message("Host event also contains response fields"));
    }
    Ok(HostMessage::Event {
        event: required_text(value, "event")?.to_owned(),
        params: value
            .get("params")
            .cloned()
            .ok_or_else(|| invalid_message("Host event requires params"))?,
    })
}
