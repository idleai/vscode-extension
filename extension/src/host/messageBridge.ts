import { HostEffects } from "./effects";
import { HOST_PROTOCOL, HostError, parseRequest, publicError } from "./protocol";

/** One disposable webview transport, with no history or application state. */
export class WebviewBridge {
  private readonly pending = new Map<string, AbortController>();
  private closed = false;
  private ready = false;

  constructor(
    readonly session: string,
    private readonly effects: HostEffects,
    private readonly post: (message: unknown) => PromiseLike<boolean>,
    private readonly failure: (error: unknown) => void,
  ) {}

  async receive(value: unknown): Promise<void> {
    const request = parseRequest(value, this.session);
    if (this.closed || !request) return;
    // VS Code may recreate a hidden webview document without resolving its
    // provider again. Its ready handshake retires the previous document's work.
    if (request.method === "host.ready") {
      for (const controller of this.pending.values()) controller.abort();
      this.pending.clear();
      this.ready = false;
    }
    if (this.pending.has(request.id)) return;
    if (this.pending.size >= 64) {
      await this.send({ id: request.id, error: publicError(new HostError("host_busy", "Too many pending host operations.")) });
      return;
    }
    const controller = new AbortController();
    this.pending.set(request.id, controller);
    try {
      const result = await this.effects.execute(request.method, request.params,
        { signal: controller.signal, session: this.session });
      if (!controller.signal.aborted) {
        if (request.method === "host.ready") this.ready = true;
        await this.send({ id: request.id, result: result ?? null });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.failure(error);
        await this.send({ id: request.id, error: publicError(error) });
      }
    } finally {
      if (this.pending.get(request.id) === controller) this.pending.delete(request.id);
    }
  }

  async event(event: string, params: unknown): Promise<void> {
    if (this.ready) await this.send({ event, params });
  }

  private async send(body: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    try { await this.post({ protocol: HOST_PROTOCOL, session: this.session, ...body }); }
    catch (error) { this.failure(error); }
  }

  dispose(): void {
    this.closed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}
