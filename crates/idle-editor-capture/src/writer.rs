//! Durable admission and retries use exact bytes and native source order.

use editchain_core::{
    Admission, Op, OpId, OpKind, Payload,
    activity::{Kind, Operation},
};
use editchain_store::{
    BlobStore, IndexedTail, SegmentStore,
    format::{Page, encode_op},
};
use serde::Deserialize;
use serde_json::{Value, value::RawValue};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::{
    convert, identity,
    state::State,
    wire::{EditorEvent, RecordEditorEvents},
};

#[derive(Debug)]
struct Chain {
    tail: IndexedTail,
    state: State,
}

impl Chain {
    fn open(root: &Path) -> crate::Result<Self> {
        let mut chain = Self {
            tail: IndexedTail::open(root)?,
            state: State::default(),
        };
        chain.rebuild();
        Ok(chain)
    }

    fn rebuild(&mut self) {
        self.state = State::default();
        for op in self.tail.chain().shared_ops() {
            if let OpKind::Activity(activity) = &op.kind {
                let missing_original = activity
                    .original
                    .as_ref()
                    .is_some_and(|source| self.tail.chain().get(source.operation).is_none());
                let broken_stream = matches!(&activity.kind, Kind::Original(raw) if raw.provider == "vscode.editor")
                    && activity
                        .parents
                        .iter()
                        .any(|id| self.tail.chain().get(*id).is_none());
                if missing_original || broken_stream {
                    self.state.mark_disputed(activity.recorder);
                }
            }
        }
        for op in self.tail.chain().shared_ops() {
            if let OpKind::Activity(activity) = &op.kind
                && !self.state.disputed(activity.recorder)
            {
                self.state.apply(activity);
            }
        }
    }

    fn refresh(&mut self) -> crate::Result<()> {
        let delta = self.tail.drain()?;
        if delta.removed.is_empty() && !self.state.needs_recovery() {
            for (op, _) in delta.added.values() {
                if let OpKind::Activity(activity) = &op.kind {
                    self.state.apply(activity);
                }
            }
        } else {
            self.rebuild();
        }
        Ok(())
    }
}

/// A native service's incremental capture writer. Reopening rebuilds its lookup
/// from durable operations; no operation hash is used as a progress cursor.
#[derive(Debug, Default)]
pub struct CaptureWriter {
    chains: BTreeMap<PathBuf, Chain>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBatch {
    workspace_path: String,
    chain_dir: String,
    events: Vec<Box<RawValue>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveLine {
    format: String,
    schema: u32,
    workspace_path: String,
    event: Box<RawValue>,
}

impl CaptureWriter {
    /// Replay a portable archive line into an explicitly selected chain.
    /// The event's exact JSON slice, source order and identities are retained.
    /// # Errors
    /// Rejects unsupported archive formats and the same errors as live capture.
    pub fn record_archive_line(&mut self, line: &[u8], chain_dir: &str) -> crate::Result<Value> {
        let line: ArchiveLine = serde_json::from_slice(line)?;
        if line.format != "editchain-human-history" || line.schema != 1 {
            return Err("unsupported human capture archive".into());
        }
        let prefix = serde_json::to_string(
            &serde_json::json!({"workspace_path": line.workspace_path, "chain_dir": chain_dir}),
        )?;
        let prefix = prefix.strip_suffix('}').ok_or("invalid archive envelope")?;
        let batch = format!("{prefix},\"events\":[{}]}}", line.event.get());
        self.record_json(batch.as_bytes())
    }

    /// Admit the exact JSON event slices supplied by the host's durable outbox.
    /// # Errors
    /// Rejects malformed, reordered or conflicting observations and failed writes.
    /// No acknowledgement is returned until all referenced bytes and records sync.
    pub fn record_json(&mut self, bytes: &[u8]) -> crate::Result<Value> {
        let raw: RawBatch = serde_json::from_slice(bytes)?;
        let request = RecordEditorEvents {
            workspace_path: raw.workspace_path,
            chain_dir: raw.chain_dir,
            events: raw
                .events
                .iter()
                .map(|event| serde_json::from_str(event.get()))
                .collect::<Result<_, _>>()?,
        };
        request.validate()?;
        let workspace = Path::new(&request.workspace_path);
        if !workspace.is_absolute() || request.chain_dir.is_empty() {
            return Err(
                "capture requires an absolute workspace and explicit chain directory".into(),
            );
        }
        let root = workspace.join(&request.chain_dir);
        // Open the writer before reading the tail: other capture/import processes
        // may have appended while this service waited for exclusive access.
        let mut store = SegmentStore::open_wait(&root, Duration::from_secs(2))?;
        if !self.chains.contains_key(&root) {
            let _old = self.chains.insert(root.clone(), Chain::open(&root)?);
        }
        let chain = self
            .chains
            .get_mut(&root)
            .ok_or("capture chain lookup failed")?;
        chain.refresh()?;
        let mut blobs = BlobStore::new(root.join("blobs"))?;
        let mut accepted = 0_u64;
        let mut replayed = 0_u64;
        for (event, raw) in request.events.iter().zip(raw.events) {
            let original = convert::original(event, raw.get().as_bytes(), &mut blobs)?.into_op()?;
            let encoded = encode_op(&original)?;
            let admission = chain.tail.chain().classify(original.id, &encoded)?;
            if admission == Admission::Conflict {
                // Keep the alternate source bytes at their reused identity.
                // Quarantine is visible to readers; this batch receives no ack.
                let mut page = Page::new(0);
                page.add_record(0, encoded);
                store.append_page(&page)?;
                chain.refresh()?;
                return Err("editor observation identity has conflicting source bytes".into());
            }
            if admission == Admission::Duplicate && chain.tail.chain().get(original.id).is_none() {
                return Err("editor observation identity is quarantined".into());
            }
            validate_order(chain, event, &blobs)?;
            let activities = convert::activities(event, &chain.state, &mut blobs)?;
            let mut operations = vec![original];
            for activity in activities {
                operations.push(activity.into_op()?);
            }
            append(chain, &mut store, operations)?;
            chain.refresh()?;
            match admission {
                Admission::Accepted => accepted = accepted.saturating_add(1),
                Admission::Duplicate => replayed = replayed.saturating_add(1),
                Admission::Conflict => {
                    return Err("conflicted capture cannot be acknowledged".into());
                }
            }
        }
        store.sync_all()?;
        Ok(
            serde_json::json!({"schema": 1, "operation_schema": 3, "converter": convert::CONVERTER,
            "accepted": accepted, "replayed": replayed,
            "ack": request.events.iter().map(|event| (&event.session, event.sequence)).collect::<Vec<_>>() }),
        )
    }
}

fn append(chain: &Chain, store: &mut SegmentStore, operations: Vec<Op>) -> crate::Result<()> {
    let mut page = Page::new(0);
    let mut changed = false;
    let mut conflicted = false;
    for operation in operations {
        let encoded = encode_op(&operation)?;
        match chain.tail.chain().classify(operation.id, &encoded)? {
            Admission::Accepted => {
                page.add_record(0, encoded);
                changed = true;
            }
            Admission::Duplicate => {
                if chain.tail.chain().get(operation.id).is_none() {
                    conflicted = true;
                }
            }
            Admission::Conflict => {
                page.add_record(0, encoded);
                changed = true;
                conflicted = true;
            }
        }
    }
    if changed {
        store.append_page(&page)?;
    }
    if conflicted {
        return Err("derived capture identity has conflicting recorded data".into());
    }
    Ok(())
}

fn activity(chain: &Chain, id: OpId) -> crate::Result<&Operation> {
    let op = chain
        .tail
        .chain()
        .get(id)
        .ok_or("editor stream has a gap or disputed predecessor; replay the outbox first")?;
    let OpKind::Activity(operation) = &op.kind else {
        return Err("editor predecessor is not schema three".into());
    };
    Ok(operation)
}

fn validate_order(chain: &Chain, event: &EditorEvent, blobs: &BlobStore) -> crate::Result<()> {
    if chain.state.disputed(identity::recorder(event)) {
        return Err("editor recorder has missing or disputed source history".into());
    }
    if event.sequence == 1 {
        return Ok(());
    }
    let previous = activity(
        chain,
        identity::operation(&event.session, event.sequence.saturating_sub(1), "raw"),
    )?;
    if let Ok(previous) = activity(
        chain,
        identity::operation(&event.session, event.sequence.saturating_sub(1), "activity"),
    ) && matches!(&previous.kind, Kind::Session(session) if session.action == editchain_core::activity::SessionAction::Ended)
    {
        return Err("editor session has already stopped".into());
    }
    if !matches!(previous.kind, Kind::Original(_))
        || previous.time_ms.is_some_and(|time| time > event.time_ms)
    {
        return Err("invalid editor predecessor or backwards recorder time".into());
    }
    let start = activity(chain, identity::operation(&event.session, 1, "raw"))?;
    let Kind::Original(original) = &start.kind else {
        return Err("capture start record is unavailable".into());
    };
    let raw = match &original.bytes {
        Payload::Blob(blob) => blobs
            .resolve_content(blob.id)
            .ok_or("capture start bytes are unavailable")?,
        Payload::Inline(bytes) => bytes.clone(),
        Payload::Empty => return Err("capture start bytes are missing".into()),
    };
    let first: EditorEvent = serde_json::from_slice(&raw)?;
    if first.identity != event.identity {
        return Err("recorder identity cannot change within a session".into());
    }
    Ok(())
}
