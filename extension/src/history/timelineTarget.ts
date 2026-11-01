import { HostError, record } from "../host/protocol";
import { parseRecord, RecordReference } from "./contracts";

export type CommitTarget = { repository: string; oid: string };
export type CommitFileTarget = CommitTarget & {
  path: string; old_path: string | null; old_oid: string | null; new_oid: string | null;
  old_mode: string | null; new_mode: string | null; status: "A" | "D" | "M" | "R" | "C" | "T"; binary: boolean;
};
export type TimelineTarget = { Record: { source: "current" | "retained"; record: RecordReference } }
  | { Commit: CommitTarget } | { CommitFile: CommitFileTarget };

const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const repository = (value: unknown): value is string => typeof value === "string"
  && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const filePath = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4096 && !value.includes("\0");
const mode = (value: unknown): boolean => value === null || typeof value === "string" && ["blob", "exe", "link", "commit"].includes(value);

/** Complete descriptors are checked again against the commit by the native host. */
export function parseCommitFile(value: unknown): CommitFileTarget {
  if (!record(value) || Object.keys(value).length !== 10 || !repository(value.repository) || !oid(value.oid)
    || !filePath(value.path) || !(value.old_path === null || filePath(value.old_path))
    || !(value.old_oid === null || oid(value.old_oid)) || !(value.new_oid === null || oid(value.new_oid))
    || value.old_oid === null && value.new_oid === null || !mode(value.old_mode) || !mode(value.new_mode)
    || typeof value.status !== "string" || !["A", "D", "M", "R", "C", "T"].includes(value.status)
    || typeof value.binary !== "boolean") {
    throw new HostError("invalid_request", "Invalid Git file destination.");
  }
  return value as CommitFileTarget;
}

/** Exact destinations cross view lifetimes without selecting host storage paths. */
export function parseTimelineTarget(value: unknown): TimelineTarget {
  if (record(value) && Object.keys(value).length === 1) {
    const stored = value.Record;
    if (record(stored) && Object.keys(stored).length === 2 && (stored.source === "current" || stored.source === "retained")) {
      return { Record: { source: stored.source, record: parseRecord(stored.record) } };
    }
    const commit = value.Commit;
    if (record(commit) && Object.keys(commit).length === 2 && repository(commit.repository) && oid(commit.oid)) {
      return { Commit: { repository: commit.repository, oid: commit.oid } };
    }
    if (value.CommitFile !== undefined) return { CommitFile: parseCommitFile(value.CommitFile) };
  }
  throw new HostError("invalid_request", "Invalid Activity destination.");
}
