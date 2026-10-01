//! Native VS Code adapters, executed on the host that owns the files.
//! f38 owns bridges, f39 capture conversion, f40 native history actions.
//! f41 owns native peer presentation over accepted shared coordination state.
//! Reuse `EditChain` `node::editor` and `protocol::editor` during those feature sessions.

pub mod capture;
pub mod history;
pub mod presence;
pub mod transport;
