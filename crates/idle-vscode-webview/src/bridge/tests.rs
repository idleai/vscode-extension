use serde_json::{Value, json};

use super::{BridgeError, HostMessage, HostProtocol, MAX_MESSAGE_BYTES, READY_METHOD};

fn protocol() -> HostProtocol {
    HostProtocol::new("document-1").expect("fixture document session is valid")
}

#[test]
fn request_keeps_domain_payload_opaque() {
    let payload = json!({"snapshot": "history-1", "range": [3, 7], "cursor": null});
    assert_eq!(
        protocol().request("request-1", "native.request", payload.clone()),
        Ok(json!({
            "protocol": 1,
            "session": "document-1",
            "id": "request-1",
            "method": "native.request",
            "params": payload,
        })),
        "Platform envelopes must preserve the caller's domain payload"
    );
    assert_eq!(
        protocol().request("host:ready", READY_METHOD, json!({})),
        Ok(json!({
            "protocol": 1,
            "session": "document-1",
            "id": "host:ready",
            "method": "host.ready",
            "params": {},
        })),
        "The bootstrap and TypeScript host must agree on the ready envelope"
    );
}

#[test]
fn rejects_missing_request_identity() {
    assert!(HostProtocol::new("").is_err(), "Session is required");
    assert!(
        protocol()
            .request("", "native.request", Value::Null)
            .is_err(),
        "Requests need caller-owned identifiers"
    );
    assert!(
        protocol().request("request-1", "", Value::Null).is_err(),
        "Requests need an explicit platform method"
    );
}

#[test]
fn rejected_requests_fail_before_the_host_would_silently_ignore_them() {
    for invalid in ["with space".to_owned(), "☃".to_owned(), "a".repeat(129)] {
        assert!(
            protocol()
                .request(&invalid, "native.request", Value::Null)
                .is_err(),
            "The Rust bridge must enforce the TypeScript identifier grammar"
        );
    }
    assert!(
        protocol()
            .request("host:ready", "host:ready", Value::Null)
            .is_err(),
        "Colons are allowed in request IDs but not method names"
    );

    let empty = protocol()
        .request("one", "native.request", Value::String(String::new()))
        .expect("fixture request is valid");
    let remaining = MAX_MESSAGE_BYTES.saturating_sub(empty.to_string().len());
    assert!(
        protocol()
            .request(
                "one",
                "native.request",
                Value::String("x".repeat(remaining))
            )
            .is_ok(),
        "The exact maximum serialized size is accepted"
    );
    let oversized = protocol().request(
        "one",
        "native.request",
        Value::String("x".repeat(remaining.saturating_add(1))),
    );
    assert_eq!(
        oversized.err().map(|error| error.code),
        Some("message_too_large".to_owned()),
        "Oversized requests must fail locally rather than disappear at the host"
    );
}

#[test]
fn null_response_remains_a_success_and_remote_errors_keep_their_code() {
    assert_eq!(
        protocol().decode(&json!({
            "protocol": 1, "session": "document-1", "id": "request-1", "result": null,
        })),
        Ok(HostMessage::Response {
            id: "request-1".to_owned(),
            result: Ok(Value::Null)
        }),
        "Explicit null must not be confused with a missing result"
    );
    assert_eq!(
        protocol().decode(&json!({
            "protocol": 1, "session": "document-1", "id": "request-1",
            "error": {"code": "not_available", "message": "Native service is stopped"},
        })),
        Ok(HostMessage::Response {
            id: "request-1".to_owned(),
            result: Err(BridgeError {
                code: "not_available".to_owned(),
                message: "Native service is stopped".to_owned(),
                details: None,
            }),
        }),
        "Host errors must reach the caller without reinterpretation"
    );
}

#[test]
fn remote_errors_preserve_complete_candidate_references() {
    let details = json!({"candidates": [
        {"operation": "3".repeat(64), "hash": "4".repeat(64)},
        {"operation": "5".repeat(64), "hash": "6".repeat(64)},
    ]});
    assert_eq!(
        protocol().decode(&json!({
            "protocol": 1, "session": "document-1", "id": "alias",
            "error": {
                "code": "migrated_alias", "message": "Select a converted record.",
                "details": details,
            },
        })),
        Ok(HostMessage::Response {
            id: "alias".to_owned(),
            result: Err(BridgeError {
                code: "migrated_alias".to_owned(),
                message: "Select a converted record.".to_owned(),
                details: Some(details),
            }),
        }),
        "The application needs the full replacement references to retry explicitly"
    );
}

#[test]
fn notifications_preserve_their_payload() {
    let params = json!({"connected": false, "generation": 7});
    assert_eq!(
        protocol().decode(&json!({
            "protocol": 1, "session": "document-1", "event": "transport.status", "params": params,
        })),
        Ok(HostMessage::Event {
            event: "transport.status".to_owned(),
            params
        }),
        "Transport notifications remain domain-agnostic"
    );
}

#[test]
fn old_documents_and_other_protocol_versions_cannot_reach_the_application() {
    for (version, session, code) in [
        (1, "document-0", "session_mismatch"),
        (2, "document-1", "protocol_mismatch"),
    ] {
        let decoded = protocol().decode(&json!({
            "protocol": version, "session": session, "id": "request-1", "result": {"total": 3},
        }));
        assert_eq!(
            decoded.err().map(|error| error.code),
            Some(code.to_owned()),
            "Stale or incompatible messages must be rejected before exposing their payload"
        );
    }
}

#[test]
fn rejects_ambiguous_or_malformed_host_messages() {
    let invalid = [
        json!({"id": "one"}),
        json!({"id": "one", "result": null, "error": {"code": "bad", "message": "bad"}}),
        json!({"id": "one", "result": null, "event": "changed", "params": {}}),
        json!({"id": "one", "result": null, "params": {}}),
        json!({"id": "", "result": null}),
        json!({"id": 1, "result": null}),
        json!({"id": "one", "error": {"code": "bad"}}),
        json!({"id": "one", "error": {"code": "bad", "message": 5}}),
        json!({"id": "one", "error": {"code": "bad", "message": "bad", "details": "private"}}),
        json!({"id": "one", "error": {"code": "bad", "message": "bad", "details": null}}),
        json!({"event": "changed"}),
        json!({"event": "changed", "params": null, "result": null}),
        json!({"event": "", "params": null}),
    ];
    for fields in invalid {
        let mut envelope = json!({"protocol": 1, "session": "document-1"});
        envelope
            .as_object_mut()
            .expect("fixture is an object")
            .extend(
                fields
                    .as_object()
                    .expect("fixture fields are an object")
                    .clone(),
            );
        assert!(
            protocol().decode(&envelope).is_err(),
            "Malformed envelope was accepted: {envelope}"
        );
    }
    assert!(
        protocol().decode(&Value::Null).is_err(),
        "Null is not a host envelope"
    );
}
