import type { JoinState, ConnectionState } from '@idle/history-runtime/clientState';
export type { JoinState, ConnectionState } from '@idle/history-runtime/clientState';

type Bindings = {
  SharedJoin: new () => JoinState;
  SharedConnection: new () => ConnectionState;
};

function bindings(): Bindings {
  // This generated Node/WASM adapter calls the same app-core portable state as
  // Crux. It contains no credentials, VS Code APIs or transport implementation.
  return require('../../media/client-state/pkg/editchain_client_state.js') as Bindings;
}

export function joinState(): JoinState { return new (bindings().SharedJoin)(); }
export function connectionState(): ConnectionState { return new (bindings().SharedConnection)(); }
