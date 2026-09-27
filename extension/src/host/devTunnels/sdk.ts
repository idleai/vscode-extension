import { TunnelRelayTunnelClient, TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import { ManagementApiVersions, TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management';

export type Management = Pick<TunnelManagementHttpClient, 'createTunnel' | 'getTunnel' | 'listTunnels' | 'deleteTunnel' | 'dispose'>;
export type SdkHost = Pick<TunnelRelayTunnelHost, 'connect' | 'dispose' | 'forwardedPortConnecting' |
  'connectionStatusChanged' | 'forwardConnectionsToLocalPorts' | 'enableE2EEncryption' | 'hostPublicKeys' | 'connectionProtocol'>;
export type SdkClient = Pick<TunnelRelayTunnelClient, 'connect' | 'dispose' | 'forwardedPortConnecting' |
  'acceptLocalConnectionsForForwardedPorts' | 'enableE2EEncryption' | 'waitForForwardedPort' |
  'connectToForwardedPort' | 'connectionProtocol'>;

/** Factories let tests exercise real lifecycle and encryption checks without cloud access. */
export interface DevTunnelsSdk {
  createHost(githubToken: () => Promise<string>): { management: Management; host: SdkHost };
  createClient(): SdkClient;
  createManagement(githubToken: () => Promise<string>): Management;
}

export function managementClient(githubToken: () => Promise<string>): TunnelManagementHttpClient {
  return new TunnelManagementHttpClient({ name: 'idle-vscode', version: '0.1.0' },
    ManagementApiVersions.Version20230927preview, async () => `github ${await githubToken()}`);
}

export const defaultSdk: DevTunnelsSdk = {
  createManagement: managementClient,
  createHost(githubToken) {
    const management = managementClient(githubToken);
    return { management, host: new TunnelRelayTunnelHost(management) };
  },
  // No management client: the SDK cannot refresh and silently replace pinned host keys.
  // No SDK trace callbacks: traces and HTTP errors can contain credentials.
  createClient: () => new TunnelRelayTunnelClient(),
};
