import { CoordinationClient } from './coordinationClient';
import { HostError, record } from './protocol';

interface Target { host_id: string; checkout_id: string }
export interface CoordinationReceipt { transfer_id: string; package_hash: string; target: Target }

export function coordinationResult(raw: string): unknown {
  const response: unknown = JSON.parse(raw);
  if (!record(response) || !record(response.result) || !Object.hasOwn(response.result, 'Ok')) {
    throw new HostError('invalid_data', 'Invalid workspace coordination response.');
  }
  return response.result.Ok;
}

export function coordinationReceipt(value: unknown): CoordinationReceipt {
  if (!record(value) || typeof value.transfer_id !== 'string' || typeof value.package_hash !== 'string'
    || !record(value.target) || typeof value.target.host_id !== 'string' || typeof value.target.checkout_id !== 'string') {
    throw new HostError('invalid_data', 'Invalid workspace coordination owner.');
  }
  return value as unknown as CoordinationReceipt;
}

function sameReceipt(left: CoordinationReceipt, right: CoordinationReceipt): boolean {
  return left.transfer_id === right.transfer_id && left.package_hash === right.package_hash
    && left.target.host_id === right.target.host_id && left.target.checkout_id === right.target.checkout_id;
}

/** A frozen source keeps the same package across editor, connection and daemon restarts. */
export async function transferCoordination(client: CoordinationClient, send: (request: string) => Promise<string>, current: () => void): Promise<void> {
  const status = coordinationResult(await send('{"kind":"status"}'));
  current();
  if (!record(status) || !record(status.target) || typeof status.target.host_id !== 'string'
    || typeof status.target.checkout_id !== 'string' || typeof status.configuration_revision !== 'string') {
    throw new HostError('invalid_data', 'The compute host did not return its coordination destination.');
  }
  const pending = coordinationResult(await client.request('{"kind":"runtime_transfer_status"}'));
  if (pending === null) {
    if (status.receipt !== null) {
      throw new HostError('coordination_conflict', 'The compute host already owns a different coordination transfer.');
    }
    const configuration = coordinationResult(await client.request('{"kind":"workspace_configuration"}'));
    if (!record(configuration) || configuration.revision !== status.configuration_revision) {
      throw new HostError('coordination_conflict', 'Sync .idle/workspace definitions between these checkouts before moving coordination.');
    }
  }
  current();
  const receipt = coordinationReceipt(coordinationResult(await client.request(JSON.stringify({ kind: 'prepare_runtime_transfer', data: {
    target: status.target, configuration_revision: status.configuration_revision,
  } }))));
  let offset = 0;
  for (;;) {
    current();
    const chunk = coordinationResult(await client.request(JSON.stringify({ kind: 'runtime_transfer_chunk', data: offset })));
    if (!record(chunk) || chunk.offset !== offset || !Number.isSafeInteger(chunk.total) || Number(chunk.total) <= offset
      || Number(chunk.total) > 16 * 1024 * 1024 || typeof chunk.content !== 'string'
      || !sameReceipt(coordinationReceipt(chunk.receipt), receipt)) throw new HostError('invalid_data', 'Invalid coordination transfer chunk.');
    const length = Buffer.from(chunk.content, 'base64').length;
    if (!length || length > 64 * 1024 || offset + length > Number(chunk.total)) throw new HostError('invalid_data', 'Invalid coordination transfer size.');
    await send(JSON.stringify({ kind: 'upload', receipt, total: chunk.total, offset, content: chunk.content }));
    offset += length;
    if (offset === chunk.total) break;
  }
  current();
  const accepted = coordinationReceipt(coordinationResult(await send(JSON.stringify({ kind: 'commit', receipt }))));
  if (!sameReceipt(accepted, receipt)) throw new HostError('invalid_data', 'The compute host acknowledged a different coordination transfer.');
  current();
  await client.request(JSON.stringify({ kind: 'complete_runtime_transfer', data: accepted }));
  current();
}
