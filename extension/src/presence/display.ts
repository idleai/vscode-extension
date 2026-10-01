import type { BranchInvitation, JoinOffer, Peer } from "./contracts";

/** Native labels are plain text. Escape codicon syntax and flatten control characters. */
export function label(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\$\(/g, "＄(");
}

export function peerLabel(peer: Peer): string {
  const person = label(peer.display_name || peer.contributor_id);
  const branch = peer.branch ? label(peer.branch) : "unknown branch";
  const host = peer.host ? label(peer.host.name || peer.host.id) : "unknown host";
  return `${person} · branch: ${branch} · host: ${host}`;
}

export function offerLabel(offer: JoinOffer): string {
  return `Join ${offer.request.target.kind === "session" ? "session" : "host"}: ${label(offer.label)}`;
}

export function branchLabel(invitation: BranchInvitation): string {
  return invitation.change === "local"
    ? `You switched to ${label(invitation.peer.branch ?? "an unknown branch")} with ${peerLabel(invitation.peer)}.`
    : `${label(invitation.peer.display_name || invitation.peer.contributor_id)} switched to your branch. ${peerLabel(invitation.peer)}.`;
}
