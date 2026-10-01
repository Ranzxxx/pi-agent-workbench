function transientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("status" in error) return [500, 502, 503, 504].includes(Number(error.status));
  return error instanceof TypeError || ("name" in error && error.name === "TimeoutError");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Only the read-only startup requests use this retry policy. Never replay writes.
export async function retryStartupRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  { timeoutMs = 30_000, attemptTimeoutMs = 3_000, retryDelayMs = 500 } = {},
): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let retryDelay = retryDelayMs;
  while (true) {
    deadline.throwIfAborted();
    const controller = new AbortController();
    const attempt = AbortSignal.any([deadline, controller.signal, AbortSignal.timeout(attemptTimeoutMs)]);
    try { return await read(attempt); }
    catch (error) {
      deadline.throwIfAborted();
      if (!transientConnectionError(error)) throw error;
    } finally { controller.abort(); }
    await delay(retryDelay, deadline);
    retryDelay = Math.min(retryDelay * 2, 3_000);
  }
}
