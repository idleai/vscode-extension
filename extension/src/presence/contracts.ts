import type * as vscode from "vscode";

/** JSON view types from app-core::presence, checked by the shared fixture. */
export type CoordinationMode = "Standalone" | "Managed";
export interface RepositoryBinding { workspace_id: string; repository_id: string; chain: string }
export interface EditorContext {
  binding: RepositoryBinding;
  mode: CoordinationMode;
  contributor_id: string;
  connection_id: string;
  host_id: string | null;
  file: string | null;
  branch: string | null;
}
export interface JoinRequest {
  binding: RepositoryBinding;
  mode: CoordinationMode;
  contributor_id: string;
  connection_id: string;
  target: { kind: "session"; session_id: string } | { kind: "host"; host_id: string };
  grant_id: string;
}
export interface JoinOffer { label: string; request: JoinRequest }
export interface Peer {
  connection_id: string;
  contributor_id: string;
  display_name: string;
  branch: string | null;
  file: string | null;
  host: { id: string; name: string } | null;
  summary: string | null;
  joins: JoinOffer[];
}
export interface BranchInvitation { id: string; change: "local" | "peer"; peer: Peer }
export interface AwarenessView {
  editor: EditorContext;
  peers: Peer[];
  join_offers: JoinOffer[];
  invitations: BranchInvitation[];
  valid_for_ms: number;
}

export interface CheckoutBinding {
  /** Explicit checkout root on the file-owning extension host, supplied by selection. */
  root: vscode.Uri;
  context: Omit<EditorContext, "file" | "branch">;
}

/** Installed by the standalone or managed adapter, independently of webview lifetimes. */
export interface PeerAwarenessProvider {
  /** Invalidate on metadata/presence changes, disconnect, revocation or recovery reset. */
  onDidChange: vscode.Event<void>;
  /**
   * Publish a changed editor observation and maintain its bounded lease until the
   * next publication or abort. Renew independently of update, including on recovery.
   * Abort detaches this presence connection; failed renewal lets its lease expire.
   * Identity and summaries come from coordination, never from Git author/host labels.
   */
  publish(editor: EditorContext, signal: AbortSignal): Promise<void>;
  /**
   * Acknowledge delivered invitation IDs with PeerAwareness::acknowledge_invitations,
   * reconcile app-core, then return PeerAwareness::update without publishing presence.
   * Publish and update calls are serialized. Retain one Rust instance per installed
   * connection, resetting its baseline on reconnect/visibility reset. Invitation IDs
   * remain unique for that instance, including across resets; only delivery is acked.
   */
  update(editor: EditorContext, acknowledgedInvitations: readonly string[], signal: AbortSignal): Promise<AwarenessView>;
  /**
   * Refresh current grants, call prepare_join, then authorize and route this exact
   * intent. Honor cancellation before connecting. Never issue grants implicitly or
   * open a general host connection using a session grant. Runtime revocation remains
   * enforced on already-open connections. A coordination receipt is only pending.
   */
  join(request: JoinRequest, signal: AbortSignal): Promise<"connected" | "pending">;
}
