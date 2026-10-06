import { RepositoryBinding } from "../history";
import { HostError, record } from "./protocol";

export const SIDEBAR_VIEWS: Readonly<Record<string, string>> = {
  "idle.workspace": "Workspace", "idle.users": "Members", "idle.sessions": "Sessions",
  "idle.projections": "Projections", "idle.computeHosts": "ComputeHosts",
  "idle.modelProviders": "ModelProviders", "idle.activity": "Activity",
};

/** Only a binding and selection keys cross view lifetimes; domain data stays in Rust. */
export function detailTarget(value: unknown, validate: (binding: unknown) => RepositoryBinding): Record<string, unknown> {
  if (!record(value) || ![...Object.values(SIDEBAR_VIEWS), "Settings", "AgentRules"].includes(String(value.section))) {
    throw new HostError("invalid_request", "Unknown detail destination.");
  }
  const key = (value: unknown) => {
    if (value == null) return null;
    if (typeof value !== "string" || value.length > 4096) throw new HostError("invalid_request", "Invalid detail selection.");
    return value;
  };
  if (value.history != null && !record(value.history)) throw new HostError("invalid_request", "Invalid history selection.");
  return { binding: validate(value.binding), section: value.section,
    session: key(value.session), recorded_session: key(value.recorded_session), host: key(value.host), provider: key(value.provider),
    history: record(value.history) ? { item: key(value.history.item), observation: key(value.history.observation) } : null };
}
