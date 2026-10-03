import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

const sessions = new Map<string, Promise<Record<string, string>>>();

export async function localSessionHeaders(baseUrl: string): Promise<Record<string, string>> {
  const origin = new URL(baseUrl).origin;
  const response = await fetch(`${origin}/api/v2/picker/session`, { method: "POST", headers: { origin } });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  const { csrfToken } = await response.json() as { csrfToken: string };
  assert.ok(cookie);
  return { origin, cookie, "x-csrf-token": csrfToken };
}

/** Explicit authenticated transport for existing business tests; security tests use raw fetch. */
export async function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(url).origin;
  let pending = sessions.get(origin);
  if (!pending) { pending = localSessionHeaders(origin); sessions.set(origin, pending); }
  const headers = new Headers(await pending);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return fetch(url, { ...init, headers });
}

export async function injectedSessionHeaders(app: FastifyInstance): Promise<Record<string, string>> {
  const response = await app.inject({ method: "POST", url: "/api/v2/picker/session", headers: { origin: "http://localhost:80" } });
  assert.equal(response.statusCode, 200);
  const cookies = response.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)?.split(";")[0];
  assert.ok(cookie);
  return { origin: "http://localhost:80", cookie, "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken };
}
