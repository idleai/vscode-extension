import * as path from "node:path";
import { MultiplayerManager, type ManagerOptions } from "@idle/history-runtime/manager";
import type { ConnectionState, JoinState } from "@idle/history-runtime/clientState";

type Bindings = {
  SharedJoin: new () => JoinState;
  SharedConnection: new () => ConnectionState;
};

/** The packaged Node bindings use the same Rust connection policy as app-core. */
export function createManager(options: Omit<ManagerOptions, "state">, extensionPath: string): MultiplayerManager {
  const file = path.join(extensionPath, "dist", "peer-state", "idle_peer_state.js");
  const bindings = require(file) as Bindings;
  return new MultiplayerManager({ ...options, state: {
    joinState: () => new bindings.SharedJoin(),
    connectionState: () => new bindings.SharedConnection(),
  } });
}
