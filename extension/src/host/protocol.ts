/** Platform envelopes only. Domain requests and reconciliation belong to Rust. */
export const HOST_PROTOCOL = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface HostRequest {
  protocol: typeof HOST_PROTOCOL;
  session: string;
  id: string;
  method: string;
  params: unknown;
}

export class HostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRequest(value: unknown, session: string): HostRequest | undefined {
  if (!record(value) || value.protocol !== HOST_PROTOCOL || value.session !== session ||
      typeof value.id !== "string" || !/^[\w.:-]{1,128}$/.test(value.id) ||
      typeof value.method !== "string" || !/^[\w.-]{1,128}$/.test(value.method) ||
      !("params" in value)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MESSAGE_BYTES) return undefined;
  } catch { return undefined; }
  return value as unknown as HostRequest;
}

/** Never forward unexpected exception text, transport frames or SDK errors. */
export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof HostError
    ? { code: error.code, message: error.message }
    : { code: "host_failure", message: "The host operation failed. Check the Idle output channel." };
}

export function textParam(params: unknown, key: string, maxLength = 8192): string {
  if (!record(params) || typeof params[key] !== "string" || params[key].length > maxLength) {
    throw new HostError("invalid_request", `Invalid ${key}.`);
  }
  return params[key];
}
