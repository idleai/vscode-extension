import type { Duplex } from 'node:stream';
import { TunnelAccessScopes, TunnelConnectionMode, TunnelProtocol } from '@microsoft/dev-tunnels-contracts';
import type { Tunnel, TunnelRelayTunnelEndpoint } from '@microsoft/dev-tunnels-contracts';

/** Only fixed, local diagnostic text may be put in this error. */
export class DevTunnelsError extends Error {
  constructor(message: string) { super(message); this.name = 'DevTunnelsError'; }
}

/** The host persists cleanup ownership; this journal must not store access tokens. */
export interface RelayJournal {
  remember(marker: string): Promise<void>;
  forget(marker: string): Promise<void>;
}

export interface RelayEndpoint {
  tunnelId: string;
  clusterId: string;
  hostId: string;
  clientRelayUri: string;
  hostPublicKeys: string[];
}

export interface HostLease { marker: string; tunnelId: string; clusterId: string }

/** Extension-host-only capability. Never post this object to a webview or output channel. */
export interface RelayDescriptor { endpoint: RelayEndpoint; connectToken: string; port: number }

export type RelayStatus = 'connecting' | 'connected' | 'disconnected';
export interface RelayHostOptions {
  port: number;
  incoming(stream: Duplex): void;
  onStatus?(status: RelayStatus): void;
  onFailure?(message: string): void;
}

export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DevTunnelsError('Invalid forwarded port.');
  }
  return port;
}

export function validateMarker(marker: string): string {
  if (typeof marker !== 'string' || !/^idle-relay-[a-f0-9]{24}$/.test(marker)) {
    throw new DevTunnelsError('Invalid relay cleanup record.');
  }
  return marker;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

export function validateLease(input: HostLease): HostLease {
  if (!input || !validId(input.tunnelId) || !validId(input.clusterId)) {
    throw new DevTunnelsError('Invalid saved relay resource.');
  }
  return { marker: validateMarker(input.marker), tunnelId: input.tunnelId, clusterId: input.clusterId };
}

export function validateEndpoint(input: RelayEndpoint): RelayEndpoint {
  if (!input || ![input.tunnelId, input.clusterId, input.hostId].every(validId) ||
    typeof input.clientRelayUri !== 'string' || input.clientRelayUri.length > 4096 ||
    !Array.isArray(input.hostPublicKeys) || !input.hostPublicKeys.length || input.hostPublicKeys.length > 4 ||
    !input.hostPublicKeys.every(key => typeof key === 'string' && /^[a-zA-Z0-9+/=]{1,4096}$/.test(key))) {
    throw new DevTunnelsError('Invalid relay endpoint.');
  }
  let address: URL;
  try { address = new URL(input.clientRelayUri); }
  catch { throw new DevTunnelsError('Invalid relay address.'); }
  if (address.protocol !== 'wss:' || address.username || address.password || address.hash ||
    (address.port && address.port !== '443') ||
    !/^[a-z0-9-]+\.rel\.tunnels\.api\.visualstudio\.com$/.test(address.hostname)) {
    throw new DevTunnelsError('The endpoint must use the Microsoft Dev Tunnels relay.');
  }
  return { tunnelId: input.tunnelId, clusterId: input.clusterId, hostId: input.hostId,
    clientRelayUri: address.toString(), hostPublicKeys: [...input.hostPublicKeys] };
}

export function descriptorTunnel(input: RelayDescriptor): Tunnel {
  const endpoint = validateEndpoint(input?.endpoint);
  const port = validatePort(input.port);
  if (typeof input.connectToken !== 'string' || !input.connectToken.length || input.connectToken.length > 8192) {
    throw new DevTunnelsError('A connect grant is required.');
  }
  const relay: TunnelRelayTunnelEndpoint = { connectionMode: TunnelConnectionMode.TunnelRelay,
    hostId: endpoint.hostId, hostPublicKeys: endpoint.hostPublicKeys, clientRelayUri: endpoint.clientRelayUri };
  return { tunnelId: endpoint.tunnelId, clusterId: endpoint.clusterId, endpoints: [relay],
    ports: [{ portNumber: port, protocol: TunnelProtocol.Auto }],
    accessTokens: { [TunnelAccessScopes.Connect]: input.connectToken } };
}

/** Pin the published endpoint to the key of this SDK host, exposing only a connect grant. */
export function hostDescriptor(tunnel: Tunnel | null | undefined, keys: string[] | undefined, port: number): RelayDescriptor {
  if (!tunnel || !keys?.length) throw new DevTunnelsError('The host did not publish an identity key.');
  const endpoints = tunnel.endpoints?.filter(endpoint => endpoint.connectionMode === TunnelConnectionMode.TunnelRelay &&
    endpoint.hostPublicKeys?.length && endpoint.hostPublicKeys.every(key => keys.includes(key)));
  if (endpoints?.length !== 1) throw new DevTunnelsError('Expected one relay endpoint matching the host key.');
  const relay = endpoints[0] as TunnelRelayTunnelEndpoint;
  const endpoint = validateEndpoint({ tunnelId: tunnel.tunnelId!, clusterId: tunnel.clusterId!,
    hostId: relay.hostId!, hostPublicKeys: relay.hostPublicKeys!, clientRelayUri: relay.clientRelayUri! });
  const connectToken = tunnel.accessTokens?.[TunnelAccessScopes.Connect];
  if (!connectToken) throw new DevTunnelsError('The service did not issue a connect grant.');
  const descriptor = { endpoint, connectToken, port };
  descriptorTunnel(descriptor);
  return descriptor;
}
