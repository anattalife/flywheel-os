import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/api/app.js';

export const ADMIN = { authorization: 'Bearer test-admin-token-123456' };

/** Starts the real HTTP server on a random port and returns a small client. */
export async function startServer() {
  const server: Server = createApp();
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isForm = typeof body === 'string';
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return { server, base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let n = 0;
export function uniquePhone() {
  n++;
  return `+1555${String(Date.now()).slice(-4)}${String(100 + n).slice(-3)}`.slice(0, 12);
}
