import type * as vscode from "vscode";

/** JSON view types from idle-vscode-native::presence, checked by the shared fixture. */
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
export interface BranchInvitation { change: "local" | "peer"; peer: Peer }
export interface AwarenessView {
  editor: EditorContext;
  peers: Peer[];
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
   * Publish the observed file/branch through the selected provider, reconcile app-core,
   * and return PeerAwareness::update. Calls are serialized. Reset the Rust baseline on
   * reconnect/visibility reset. Abort detaches this presence connection; publication
   * has a bounded lease so a failed call cannot leave stale presence indefinitely.
   * Identity and summaries come from coordination, never from Git author/host labels.
   */
  update(editor: EditorContext, signal: AbortSignal): Promise<AwarenessView>;
  /**
   * Refresh current grants, call prepare_join, then authorize and route this exact
   * intent. Honor cancellation before connecting. Never issue grants implicitly or
   * open a general host connection using a session grant. Runtime revocation remains
   * enforced on already-open connections. A coordination receipt is only pending.
   */
  join(request: JoinRequest, signal: AbortSignal): Promise<"connected" | "pending">;
}
