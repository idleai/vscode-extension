//! Real engine workers connected to a retained native history view.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use editchain_core::{BlobRef, ContentId, Op, OpKind, Payload};
use editchain_store::{BlobStore, CanonicalChain};
use editchain_sync::{MAX_BRIDGE_BYTES, MAX_CONTROL_BYTES};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
#[path = "shared_session.rs"]
mod shared_session;

fn peer_binary() -> PathBuf {
    std::env::var_os("EDITCHAIN_PEER_TEST_BINARY").map_or_else(
        || {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../editchain/target/debug")
                .join(format!("editchain-peer{}", std::env::consts::EXE_SUFFIX))
        },
        PathBuf::from,
    )
}

fn require(condition: bool, message: &'static str) -> io::Result<()> {
    if condition {
        Ok(())
    } else {
        Err(io::Error::other(message))
    }
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}

impl Worker {
    fn spawn() -> io::Result<Self> {
        let mut child = Command::new(peer_binary())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("no worker input"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no worker output"))?;
        Ok(Self {
            child,
            input,
            output,
        })
    }

    fn call(&mut self, request: &Value) -> io::Result<Value> {
        let bytes = serde_json::to_vec(request).map_err(io::Error::other)?;
        let length = u32::try_from(bytes.len()).map_err(io::Error::other)?;
        self.input.write_all(&length.to_le_bytes())?;
        self.input.write_all(&bytes)?;
        self.input.flush()?;
        let mut length = [0; 4];
        self.output.read_exact(&mut length)?;
        let length = usize::try_from(u32::from_le_bytes(length)).map_err(io::Error::other)?;
        require(length <= MAX_CONTROL_BYTES, "native output exceeded bound")?;
        let mut bytes = vec![0; length];
        self.output.read_exact(&mut bytes)?;
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }

    fn ok(&mut self, request: &Value) -> io::Result<Value> {
        let response = self.call(request)?;
        require(
            response.get("ok") == Some(&Value::Bool(true)),
            "worker rejected an expected valid request",
        )?;
        response
            .get("result")
            .cloned()
            .ok_or_else(|| io::Error::other("missing worker result"))
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        drop(self.child.kill());
        drop(self.child.wait());
    }
}

fn opaque(response: &Value) -> io::Result<Vec<u8>> {
    STANDARD
        .decode(
            response
                .get("bytes")
                .and_then(Value::as_str)
                .ok_or_else(|| io::Error::other("missing opaque bytes"))?,
        )
        .map_err(io::Error::other)
}

fn connect(a: &mut Worker, b: &mut Worker, initial: Vec<u8>) -> io::Result<()> {
    let mut queue: VecDeque<_> = [(true, initial)].into();
    for _ in 0..20_000 {
        let Some((to_a, bytes)) = queue.pop_front() else {
            return Ok(());
        };
        let worker = if to_a { &mut *a } else { &mut *b };
        for part in bytes.chunks(MAX_BRIDGE_BYTES.min(997)) {
            let result = worker
                .ok(&json!({ "type": "turn", "bytes": STANDARD.encode(part), "tick": false }))?;
            let output = opaque(&result)?;
            if !output.is_empty() {
                queue.push_back((!to_a, output));
            }
        }
    }
    Err(io::Error::other("native workers did not converge"))
}

fn open(
    worker: &mut Worker,
    root: &Path,
    device: &Path,
    remote: Option<&str>,
) -> io::Result<Vec<u8>> {
    opaque(&worker.ok(&json!({ "type": "open", "chain_dir": root, "device_dir": device, "space": "process-space", "remote": remote }))?)
}
