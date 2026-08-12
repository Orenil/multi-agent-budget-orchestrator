/** Delay that rejects early if `signal` aborts mid-wait — the primitive both simulated
 *  tools and the interceptor's LLM stub use to make cancellation genuinely observable
 *  (a cleared timer, a rejected promise) rather than a value nobody checks. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted: exceeded remaining time budget"));
      },
      { once: true }
    );
  });
}
