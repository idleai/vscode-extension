//! Editor capture requests layered over the shared history view protocol.

pub mod editor;

/// Native service envelope with validated editor capture payloads.
pub type Request = editchain_protocol::Request<editor::RecordEditorEvents>;
/// Native service operations with typed editor capture payloads.
pub type RequestBody = editchain_protocol::RequestBody<editor::RecordEditorEvents>;

impl editchain_protocol::RequestPayload for editor::RecordEditorEvents {
    fn validate(&self) -> Result<(), editchain_protocol::ServiceError> {
        self.validate()
    }
}
