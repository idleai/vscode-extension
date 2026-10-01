//! Native editor awareness over accepted app-core state in either coordination mode.
//!
//! Adapters pass a reconciled directory and workspace view, then serialize
//! [`AwarenessView`] for the thin VS Code host. They must call [`prepare_join`]
//! with current state before routing a user-selected invitation. The authority
//! and runtime still authenticate the caller and enforce the grant at connection
//! and execution time. No grant is issued by viewing or accepting an invitation.

mod joins;
mod project;
mod state;
mod types;

pub use joins::prepare_join;
pub use state::PeerAwareness;
pub use types::*;

#[cfg(test)]
mod tests;
