import { ProcessStartOptions } from './nativeProcess';

export interface ConnectionEvents {
  frame(payload: Buffer): void;
  closed(error: Error): void;
  log?(line: string): void;
}

/** A service connection may own a standalone process or a shared host channel. */
export interface NativeConnection {
  isRunning(): boolean;
  start(binary: string, options?: ProcessStartOptions): void;
  write(parts: readonly (string | Buffer)[]): Promise<void>;
  stop(): void;
  dispose(): void;
  shutdown(): Promise<void>;
}

export type ConnectionFactory = (events: ConnectionEvents) => NativeConnection;
