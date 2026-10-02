import { MultiplayerManager as RuntimeManager, ManagerOptions as RuntimeOptions, RelayProvider } from '@idle/history-runtime/manager';
import { connectionState, joinState } from './clientState';
import { managementClient, RelayClient, RelayHost, RelayJournal, removeSavedRelay } from './relay';

export type { RelayProvider, SavedSharing, SharingStatus } from '@idle/history-runtime/manager';
export type ManagerOptions = Omit<RuntimeOptions, 'relay' | 'state'> & {
  githubToken(): Promise<string>;
  journal: RelayJournal;
  relay?: RelayProvider;
};

/** Bind the portable coordinator to this extension's relay and app-core assets. */
export class MultiplayerManager extends RuntimeManager {
  constructor(options: ManagerOptions) {
    super({ ...options, state: { connectionState, joinState }, relay: options.relay ?? {
      host: (incoming, failed) => new RelayHost(() => managementClient(options.githubToken), options.journal, incoming, failed),
      client: () => new RelayClient(),
      remove: lease => removeSavedRelay(lease, options.journal, options.githubToken),
    } });
  }
}
