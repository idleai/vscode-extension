import type { Duplex } from 'node:stream';
import { SecureStream, SshStream } from '@microsoft/dev-tunnels-ssh';
import type { ForwardedPortConnectingEventArgs } from '@microsoft/dev-tunnels-ssh-tcp';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';
import { DevTunnelsError } from './contracts';

const managed = new WeakSet<Duplex>();

/** SDK SecureStream.destroy() does not dispose its SSH session or propagate SDK closure. */
export function closeRelayStream(stream: Duplex): void {
  if (stream instanceof SecureStream) stream.dispose();
  stream.destroy();
}

function manageSecureLifetime(stream: SecureStream, transport: Duplex): void {
  if (managed.has(stream)) return;
  managed.add(stream);
  let closing = false;
  const subscriptions: { dispose(): void }[] = [];
  const close = () => {
    if (closing) return;
    closing = true;
    for (const subscription of subscriptions) subscription.dispose();
    stream.off('close', close); stream.off('end', close);
    transport.off('close', close); transport.off('end', close);
    closeRelayStream(stream);
    transport.destroy();
  };
  // End this owned stream on disconnect; the Rust caller decides whether to reconnect.
  subscriptions.push(stream.onClosed(close), stream.onDisconnected(close));
  stream.once('close', close); stream.once('end', close);
  transport.once('close', close); transport.once('end', close);
  if (stream.isClosed || stream.destroyed || transport.destroyed || transport.readableEnded) close();
}

function manageSshLifetime(stream: SshStream): void {
  if (managed.has(stream)) return;
  managed.add(stream);
  const session = stream.channel.session;
  // SshStream has already queued EOF on channel closure. End its writable side
  // and let Node drain buffered final bytes before auto-destroying the Duplex.
  const close = () => { stream.end(); };
  const subscriptions = [stream.channel.onClosed(close), session.onClosed(close),
    session.onDisconnected(() => { session.dispose(); close(); })];
  stream.once('close', () => { for (const subscription of subscriptions) subscription.dispose(); });
  if (!session.isConnected || stream.channel.isClosed) close();
}

/** Preserve the SDK's authenticated V2 transform; never forward a raw channel. */
export async function encryptedStream(event: ForwardedPortConnectingEventArgs, port: number): Promise<Duplex> {
  try {
    const stream = await event.transformPromise;
    if (event.port !== port || !(stream instanceof SecureStream) || stream.isClosed || stream.destroyed) {
      if (stream) closeRelayStream(stream);
      throw new DevTunnelsError('Expected an encrypted V2 stream on the requested port.');
    }
    manageSecureLifetime(stream, event.stream);
    return stream;
  } catch (error) { event.stream.destroy(); throw error; }
}

/** V1 encrypts and authenticates the entire peer SSH session. */
export function encryptedV1SessionId(stream: Duplex): Buffer {
  if (stream instanceof SshStream) {
    const session = stream.channel.session;
    const algorithms = session.algorithms;
    if (session.isConnected && session.principal && session.sessionId?.length && algorithms?.cipher &&
      algorithms.decipher && algorithms.messageSigner && algorithms.messageVerifier) {
      manageSshLifetime(stream);
      return session.sessionId;
    }
  }
  stream.destroy();
  throw new DevTunnelsError('Expected an authenticated, encrypted V1 SSH session.');
}

/** Rejected transforms can resolve after cancellation; their late streams must close too. */
export function rejectForwardedStream(event: ForwardedPortConnectingEventArgs): void {
  const pending = event.transformPromise;
  event.stream.destroy();
  event.transformPromise = Promise.resolve(pending).then(stream => { if (stream) closeRelayStream(stream); return null; }, () => null);
}

export async function encryptedHostStream(event: ForwardedPortConnectingEventArgs, protocol: string | undefined, port: number): Promise<Duplex> {
  if (protocol === 'tunnel-relay-host-v2-dev') return encryptedStream(event, port);
  if (protocol !== 'tunnel-relay-host' || event.port !== port) {
    rejectForwardedStream(event);
    throw new DevTunnelsError('Unsupported relay protocol or forwarded port.');
  }
  encryptedV1SessionId(event.stream);
  return event.stream;
}

export function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Remote error strings, stacks, response bodies and request headers are never diagnostics. */
export function safeFailure(stage: string, error: unknown): string {
  if (error instanceof DevTunnelsError) return `${stage}: ${error.message}`;
  const status = httpStatus(error);
  return `${stage} failed${status === undefined ? '' : ` (HTTP ${status})`}. SDK error details were omitted to protect credentials.`;
}

export function ensureActive(token: CancellationToken): void {
  if (token.isCancellationRequested) throw new DevTunnelsError('Operation cancelled or timed out.');
}

/** Cancellation bounds the caller even when SDK work ignores its token. Callers own late results. */
export async function bounded<T>(action: (token: CancellationToken) => Promise<T>, parent: CancellationToken, timeoutMs: number): Promise<T> {
  const source = new CancellationTokenSource();
  const token = source.token;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: { dispose(): void } | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const cancel = () => { source.cancel(); reject(new DevTunnelsError('Operation cancelled or timed out.')); };
    subscription = parent.onCancellationRequested(cancel);
    timer = setTimeout(cancel, timeoutMs);
    if (parent.isCancellationRequested) cancel();
  });
  try {
    if (token.isCancellationRequested) return await cancelled;
    return await Promise.race([action(token), cancelled]);
  } finally {
    clearTimeout(timer);
    subscription?.dispose();
    source.cancel();
    source.dispose();
  }
}
