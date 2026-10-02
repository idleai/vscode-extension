//! Replication order is observable by an already open native History view.

use super::operation;
use super::{deliver, seed, session, start, EncodedRecord};
use editchain_core::{
    CommandOp, CommandStage, ImportOp, NodeId, Op, OpId, OpKind, ParentSet, Payload, ScopeRef,
    SessionId, Tags, TurnId,
};
use editchain_editor_protocol::Request;
use editchain_node::Server;
use editchain_protocol::{LiveBlock, LiveUpdate, OpenResponse, ResponseBody};
use editchain_store::{format::encode_op, CanonicalChain};
use editchain_sync::RecordKey;
use serde_json::{json, Value};
use std::{collections::BTreeMap, io};

fn fixture(count: u64) -> io::Result<Vec<EncodedRecord>> {
    let mut records = Vec::new();
    for seq in 1..=count {
        let mut raw = operation(seq << 16, Payload::Empty);
        let source = raw
            .source
            .as_mut()
            .ok_or_else(|| io::Error::other("fixture operation has no source"))?;
        source.node = NodeId(9000);
        let source = *source;
        raw.id = source.id();
        raw.scope = ScopeRef::Session(SessionId(73));
        raw.parents = if seq == 1 {
            ParentSet::None
        } else {
            ParentSet::One(OpId::new(
                NodeId(9000),
                source.boot,
                seq.saturating_sub(1) << 16,
            ))
        };
        raw.kind = OpKind::Import(ImportOp {
            raw_ref: Payload::Inline(br#"{"type":"assistant"}"#.to_vec()),
            raw_hash: None,
        });
        raw.tags = Tags::IMPORT;
        let result = Op {
            source: Some(editchain_core::SourceId::new(
                NodeId(1),
                source.boot,
                source.seq.saturating_add(1),
            )),
            id: OpId::new(NodeId(1), source.boot, source.seq.saturating_add(1)),
            parents: ParentSet::One(raw.id),
            scope: ScopeRef::Turn(TurnId(15)),
            tags: Tags::AGENT | Tags::COMMAND,
            kind: OpKind::Command(CommandOp {
                command_id: Payload::Inline(format!("command-{seq}").into_bytes()),
                content: Payload::Inline(format!("cargo test fixture-{seq}").into_bytes()),
                stage: CommandStage::Finish,
            }),
            ..raw.clone()
        };
        for op in [raw, result] {
            let bytes = encode_op(&op).map_err(io::Error::other)?;
            records.push((RecordKey::from_encoded(&bytes)?, bytes));
        }
    }
    Ok(records)
}

fn call(server: &mut Server, body: Value) -> io::Result<Value> {
    let request = Request {
        id: 1,
        body: serde_json::from_value(body)?,
    };
    match server
        .handle(&request)
        .map_err(|error| io::Error::other(error.to_string()))?
        .body
    {
        ResponseBody::Ok(value) => Ok(value),
        ResponseBody::Error(error) => {
            Err(io::Error::other(format!("native view failed: {error:?}")))
        }
    }
}

#[test]
fn replicated_results_have_source_context_at_every_durable_page_and_after_reconnect(
) -> io::Result<()> {
    let tmp = tempfile::tempdir()?;
    let ar = tmp.path().join("a/.editchain");
    let br = tmp.path().join("b/.editchain");
    seed(&ar, &fixture(140)?)?;
    let mut a = session(&ar)?;
    let mut b = session(&br)?;
    let mut view = Server::new();
    let opened = call(
        &mut view,
        json!({"OpenLive": {
            "workspace_path": tmp.path().join("b"), "chain_dir": ".editchain"
        }}),
    )?;
    let mut queue = start(&a, &b);
    let mut records = 0;
    let opened: OpenResponse = serde_json::from_value(opened)?;
    let baseline = opened
        .live
        .ok_or_else(|| io::Error::other("no live baseline"))?;
    let mut revision = 0;
    let mut blocks = BTreeMap::<String, LiveBlock>::new();
    let mut restarted = false;
    for _ in 0..20_000 {
        if queue.is_empty() {
            break;
        }
        deliver(&mut a, &mut b, &mut queue)?;
        if b.progress().records == records {
            continue;
        }
        records = b.progress().records;
        let chain = CanonicalChain::read(&br)?;
        let ops: BTreeMap<_, _> = chain.located_ops().map(|(op, _)| (op.id, op)).collect();
        for op in ops.values() {
            check!(
                op.parents.iter().all(|parent| ops.contains_key(parent)),
                "durable result appeared before its exported source ancestry"
            );
        }
        let update = call(
            &mut view,
            json!({"SyncLive": {
                "epoch": baseline.epoch, "after_revision": revision, "codex": null
            }}),
        )?;
        let update: LiveUpdate = serde_json::from_value(update)?;
        revision = update.revision;
        for delta in update.deltas {
            for key in delta.removed {
                drop(blocks.remove(&key));
            }
            for block in delta.upserts {
                drop(blocks.insert(block.meta.key.clone(), block));
            }
        }
        for block in blocks.values() {
            check!(
                block.rows.iter().all(|row| row.group == "session:73"),
                "a received command was published as an unowned ops root"
            );
            for parent in &block.meta.parents {
                check!(
                    blocks.contains_key(parent),
                    "received graph edge lost its parent"
                );
            }
        }
        if !restarted {
            // Lose in-flight messages/ACKs; durable records and the open view survive.
            a = session(&ar)?;
            b = session(&br)?;
            queue = start(&a, &b);
            records = 0;
            restarted = true;
        }
    }
    check!(queue.is_empty(), "replication did not converge");
    check_eq!(blocks.len(), 140, "one visible block per source occurrence");
    check_eq!(
        blocks
            .values()
            .filter(|block| block.meta.parents.is_empty())
            .count(),
        1,
        "the received session has exactly one real root"
    );
    check_eq!(
        CanonicalChain::read(&br)?.stats().accepted,
        280,
        "all exact operations survived reconnect"
    );
    Ok(())
}
