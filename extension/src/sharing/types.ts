import type { WorkProgress } from './progress';
import type { SharingScope } from './scope';

export interface Device { certificate: string; fingerprint: string }
export interface JoinRequest { version: number; device: Device }
export interface Invitation { version: number; space: string; host: Device; guest: string }
export interface SavedSharing { version: number; space: string; peers: unknown[];
  host?: { marker: string; tunnelId: string; clusterId: string } }
export interface SharingStatus {
  space?: string;
  scope?: SharingScope;
  enabled: boolean;
  hosting: boolean;
  host_state?: string;
  peers: { connection?: string; fingerprint?: string; state: string; progress?: WorkProgress & {
    accepted: boolean; records: number; blobs: number; rounds: number; unavailable: number;
    sent_records?: number; sent_blobs?: number;
  } }[];
  durable_changes?: number;
  message?: string;
  discovery?: DiscoveryStatus;
}
export interface DiscoveryStatus { state: string; candidates: number }
