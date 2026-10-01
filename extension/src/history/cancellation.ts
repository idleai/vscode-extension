/** Link a view's lifetime to a history binding on every supported extension host. */
export function linkCancellation(binding: AbortSignal, view?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (!view) return { signal: binding, dispose() {} };
  const controller = new AbortController();
  const sources = [binding, view];
  const abort = () => controller.abort();
  for (const source of sources) {
    if (source.aborted) abort();
    else source.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() { for (const source of sources) source.removeEventListener("abort", abort); },
  };
}
