import { HostError } from "./protocol";

export interface HostCallContext {
  readonly signal: AbortSignal;
  readonly session: string;
}

export type HostEffect = (params: unknown, context: HostCallContext) => unknown | PromiseLike<unknown>;

/** An allowlist of installed platform effects, not an arbitrary VS Code command dispatcher. */
export class HostEffects {
  private readonly handlers = new Map<string, { run: HostEffect; trusted: boolean }>();

  constructor(private readonly isTrusted: () => boolean) {}

  register(method: string, run: HostEffect, trusted = true): { dispose(): void } {
    if (this.handlers.has(method)) throw new Error(`Host effect already registered: ${method}`);
    const entry = { run, trusted };
    this.handlers.set(method, entry);
    return { dispose: () => {
      if (this.handlers.get(method) === entry) this.handlers.delete(method);
    } };
  }

  available(): string[] {
    return [...this.handlers].filter(([, entry]) => !entry.trusted || this.isTrusted()).map(([method]) => method);
  }

  async execute(method: string, params: unknown, context: HostCallContext): Promise<unknown> {
    if (context.signal.aborted) throw new HostError("cancelled", "The view was closed.");
    const entry = this.handlers.get(method);
    if (!entry) throw new HostError("unavailable", "This host action is not installed.");
    if (entry.trusted && !this.isTrusted()) throw new HostError("workspace_untrusted", "Trust this workspace before running this action.");
    return await entry.run(params, context);
  }

  dispose(): void { this.handlers.clear(); }
}
