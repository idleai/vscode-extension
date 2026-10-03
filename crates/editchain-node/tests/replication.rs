//! Editor capture and native history integration over the public replication API.

// Return a failed test result without adding lint exceptions for panic in Result.
macro_rules! check {
    ($condition:expr_2021, $message:literal $(,)?) => {
        if !$condition {
            return Err(std::io::Error::other($message));
        }
    };
}

macro_rules! check_eq {
    ($actual:expr_2021, $expected:expr_2021, $message:literal $(,)?) => {
        let actual = $actual;
        let expected = $expected;
        if actual != expected {
            return Err(std::io::Error::other(format!(
                "{}: actual={actual:?}, expected={expected:?}",
                $message
            )));
        }
    };
}

#[path = "replication/ancestry.rs"]
mod ancestry;
#[path = "replication/baselines.rs"]
mod baselines;
#[path = "replication/processes.rs"]
mod processes;

use base64 as _;
use clap as _;
use ctrlc as _;
use dirs as _;
use editchain_core::{
    ActorId, BlobRef, Clock, ContentId, MessageOp, NodeId, Op, OpId, OpKind, ParentSet, Payload,
    ScopeRef, Tags,
};
use editchain_editor_protocol as _;
use editchain_git as _;
use editchain_import as _;
use editchain_index as _;
use editchain_project as _;
use editchain_store::{
    format::{encode_op, Page},
    CanonicalChain, SegmentStore,
};
use editchain_sync::{encode_message, FrameDecoder, Message, RecordKey, Replica, Session};
use history_geometry as _;
use serde as _;
use std::{collections::VecDeque, io, path::Path};
use tantivy as _;

fn operation(seq: u64, payload: Payload) -> Op {
    Op {
        source: Some(editchain_core::SourceId::new(NodeId(7), 1, seq)),
        id: OpId::new(NodeId(7), 1, seq),
        parents: ParentSet::None,
        actor: ActorId(17),
        clock: Clock::UnixMs(123),
        scope: ScopeRef::None,
        tags: Tags::MESSAGE,
        kind: OpKind::Message(MessageOp {
            content: payload,
            content_type: Payload::Empty,
        }),
    }
}

fn seed(path: &Path, records: &[(RecordKey, Vec<u8>)]) -> io::Result<()> {
    let mut store = SegmentStore::open(path)?;
    let mut page = Page::new(0);
    for (_, bytes) in records {
        page.add_record(0, bytes.clone());
    }
    store.append_page(&page)
}

type Queue = VecDeque<(bool, Message)>;
type EncodedRecord = (RecordKey, Vec<u8>);

fn session(root: &Path) -> io::Result<Session> {
    Ok(Session::new(Replica::open(root, "space-1", true)?))
}

fn start(a: &Session, b: &Session) -> Queue {
    [(true, b.hello()), (false, a.hello())].into()
}

fn deliver(a: &mut Session, b: &mut Session, queue: &mut Queue) -> io::Result<()> {
    let (to_a, message) = queue
        .pop_front()
        .ok_or_else(|| io::Error::other("empty wire"))?;
    let peer = if to_a { a } else { b };
    let mut decoder = FrameDecoder::default();
    for fragment in encode_message(&message)?.chunks(997) {
        for message in decoder.push(fragment)? {
            queue.extend(
                peer.receive(message)?
                    .into_iter()
                    .map(|reply| (!to_a, reply)),
            );
        }
    }
    decoder.finish()
}
