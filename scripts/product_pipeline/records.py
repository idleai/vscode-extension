"""Small, durable records for source selection and elapsed build time."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def write(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Timings:
    def __init__(self, path):
        self.path = Path(path)
        self.document = (json.loads(self.path.read_text()) if self.path.exists()
                         else {"schema": 1, "started_at": now(), "steps": []})
        write(self.path, self.document)

    @contextmanager
    def step(self, name):
        row = {"name": name, "started_at": now(), "result": "running"}
        self.document["steps"].append(row)
        write(self.path, self.document)
        started = time.monotonic()
        print(f"::group::{name}", flush=True)
        try:
            yield
        except BaseException:
            row["result"] = "failed"
            raise
        else:
            row["result"] = "success"
        finally:
            row.update(completed_at=now(), seconds=round(time.monotonic() - started, 3))
            self.document["updated_at"] = now()
            write(self.path, self.document)
            print(f"::endgroup::\n{name}: {row['result']} ({row['seconds']:.1f}s)", flush=True)
