/** One local session shared by ordinary chat, picker requests and downloads. */
export function createWorkbenchFetch(baseUrl: string, fetcher: typeof fetch = fetch) {
  let csrfToken: string | undefined;
  let pending: Promise<string> | undefined;

  async function session(): Promise<string> {
    if (csrfToken) return csrfToken;
    if (!pending) {
      pending = (async () => {
        const response = await fetcher(`${baseUrl}/picker/session`, {
          method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw Object.assign(new Error("无法建立本地工作台会话。"), { status: response.status });
        const body = await response.json() as { csrfToken?: unknown };
        if (typeof body.csrfToken !== "string" || !body.csrfToken) throw new Error("本地工作台会话响应无效。");
        csrfToken = body.csrfToken;
        return csrfToken;
      })();
    }
    const current = pending;
    try { return await current; }
    finally { if (pending === current) pending = undefined; }
  }

  return async function request(route: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      const token = await session();
      init.signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set("x-csrf-token", token);
      const response = await fetcher(`${baseUrl}${route}`, { ...init, headers, credentials: "same-origin" });
      // Only the pre-handler session rejection is safe to replay. Never retry
      // business 404s, network failures or ambiguous completed writes.
      if (response.status !== 401 || attempt > 0) return response;
      await response.body?.cancel();
      if (csrfToken === token) csrfToken = undefined;
    }
  };
}
