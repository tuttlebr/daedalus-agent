import { nextEndPoints } from "./const";

export class ConflictError extends Error {
  serverState: any;
  constructor(serverState: any) {
    super('Conflict: server has newer data');
    this.name = 'ConflictError';
    this.serverState = serverState;
  }
}

export const apiBase = () => {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
};

export const getEndpoint = ({ service = 'chat' as keyof typeof nextEndPoints}) => {
  return nextEndPoints[service];
};

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPut<TBody extends object, TResp = void>(path: string, body: TBody): Promise<TResp> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const data = await res.json();
    throw new ConflictError(data.serverState);
  }
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  if (res.status === 204) return undefined as unknown as TResp;
  return res.json() as Promise<TResp>;
}

export async function apiPost<TBody extends object, TResp = void>(path: string, body: TBody): Promise<TResp> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  if (res.status === 204) return undefined as unknown as TResp;
  return res.json() as Promise<TResp>;
}

export async function apiDelete<TResp = void>(path: string): Promise<TResp> {
    const res = await fetch(`${apiBase()}${path}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.statusText}`);
    if (res.status === 204) return undefined as unknown as TResp;
    return res.json() as Promise<TResp>;
}
