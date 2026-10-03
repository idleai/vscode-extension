import { TunnelConnectionMode } from "@microsoft/dev-tunnels-contracts";
import type { TunnelRelayTunnelEndpoint } from "@microsoft/dev-tunnels-contracts";
import { ManagementApiVersions, TunnelAccessTokenProperties, TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management";
import { CancellationToken, CancellationTokenSource } from "vscode-jsonrpc";
import type { RelayProvider } from "@idle/history-runtime/manager";
import { MULTIPLAYER_PORT } from "@idle/history-runtime/invitation";
import type { DevTunnelsAdapters, RelayDescriptor } from "../host/devTunnels";
import { DevTunnelsError, descriptorTunnel, validateEndpoint } from "../host/devTunnels/contracts";
import { bounded, ensureActive } from "../host/devTunnels/security";
import type { Management } from "../host/devTunnels/sdk";

/** Renew relay keys for the same tunnel; native mutual TLS still pins the approved device. */
export async function refreshEndpoint(descriptor: RelayDescriptor, cancellation: CancellationToken,
  management: Management = new TunnelManagementHttpClient({ name: "idle-sharing", version: "0.1.0" },
    ManagementApiVersions.Version20230927preview)): Promise<RelayDescriptor> {
  try {
    return await bounded(async token => {
      const tunnel = await management.getTunnel(descriptorTunnel(descriptor), { includePorts: true }, token);
      ensureActive(token);
      if (tunnel?.tunnelId !== descriptor.endpoint.tunnelId || tunnel.clusterId !== descriptor.endpoint.clusterId) {
        throw new DevTunnelsError("The approved relay resource is unavailable.");
      }
      const endpoints = tunnel.endpoints?.filter(endpoint => endpoint.connectionMode === TunnelConnectionMode.TunnelRelay);
      if (endpoints?.length !== 1) throw new DevTunnelsError("Expected one current relay host.");
      const endpoint = endpoints[0] as TunnelRelayTunnelEndpoint;
      return { ...descriptor, endpoint: validateEndpoint({ tunnelId: tunnel.tunnelId, clusterId: tunnel.clusterId,
        hostId: endpoint.hostId!, clientRelayUri: endpoint.clientRelayUri!, hostPublicKeys: endpoint.hostPublicKeys! }) };
    }, cancellation, 60_000);
  } catch {
    throw new DevTunnelsError("The approved relay endpoint could not be refreshed.");
  } finally {
    await bounded(() => management.dispose(), CancellationToken.None, 15_000);
  }
}

/** Bind portable reconnect and replication to the host's resource ownership. */
export function relayProvider(adapters: DevTunnelsAdapters, resolve = refreshEndpoint): RelayProvider {
  return {
    host(incoming, failed) {
      const host = adapters.createHost({ port: MULTIPLAYER_PORT, incoming,
        onFailure: failed, onStatus: status => {
          if (status === "disconnected") failed("History relay disconnected.", true);
        } });
      return {
        start: previous => host.start(previous), lease: () => host.lease(),
        stop: () => host.stop(), suspend: () => host.suspend(),
        async descriptor() {
          const value = await host.descriptor();
          const expiration = TunnelAccessTokenProperties.tryParse(value.connectToken)?.expiration?.getTime();
          if (!expiration || expiration <= Date.now() + 60_000) throw new DevTunnelsError("The connect grant expires too soon.");
          return { endpoint: value.endpoint, connectToken: value.connectToken,
            expiresAt: Math.min(expiration, Date.now() + 60 * 60_000) };
        },
      };
    },
    client() {
      const client = adapters.createClient();
      const cancellation = new CancellationTokenSource();
      let stopped = false;
      return {
        async connect(invitation) {
          ensureActive(cancellation.token);
          const descriptor = await resolve({ endpoint: invitation.endpoint,
            connectToken: invitation.connectToken, port: MULTIPLAYER_PORT }, cancellation.token);
          ensureActive(cancellation.token);
          return client.connect(descriptor, cancellation.token);
        },
        async stop() {
          if (!stopped) { stopped = true; cancellation.cancel(); }
          try { await client.stop(); } finally { cancellation.dispose(); }
        },
      };
    },
    remove: lease => adapters.cleanup(lease.marker),
  };
}
