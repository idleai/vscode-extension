import { HostError, record } from "../host/protocol";
import { parseRecord, RecordReference } from "./contracts";

export type CommitTarget = { repository: string; oid: string };
export type TimelineTarget = { Record: { source: "current" | "retained"; record: RecordReference } } | { Commit: CommitTarget };

/** Exact destinations cross view lifetimes without carrying filesystem paths. */
export function parseTimelineTarget(value: unknown): TimelineTarget {
  if (record(value) && Object.keys(value).length === 1) {
    const stored = value.Record;
    if (record(stored) && Object.keys(stored).length === 2 && (stored.source === "current" || stored.source === "retained")) {
      return { Record: { source: stored.source, record: parseRecord(stored.record) } };
    }
    const commit = value.Commit;
    if (record(commit) && Object.keys(commit).length === 2 && typeof commit.repository === "string"
      && /^(0|[1-9][0-9]{0,19})$/.test(commit.repository) && BigInt(commit.repository) <= 18446744073709551615n
      && typeof commit.oid === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit.oid)) {
      return { Commit: { repository: commit.repository, oid: commit.oid } };
    }
  }
  throw new HostError("invalid_request", "Invalid Activity destination.");
}
