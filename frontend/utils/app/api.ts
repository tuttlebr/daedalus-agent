import { nextEndPoints } from './const';

export type ApiErrorKind =
  | 'client'
  | 'server'
  | 'network'
  | 'auth'
  | 'conflict'
  | 'timeout'
  | 'unknown';

export class ApiError extends Error {
  status: number;
  kind: ApiErrorKind;
  body?: unknown;

  constructor(
    message: string,
    status: number,
    kind: ApiErrorKind,
    body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.body = body;
  }

  get isRetryable(): boolean {
    return (
      this.kind === 'server' ||
      this.kind === 'network' ||
      this.kind === 'timeout'
    );
  }
}

export class ConflictError extends ApiError {
  serverState: any;
  constructor(serverState: any) {
    super('Conflict: server has newer data', 409, 'conflict', serverState);
    this.name = 'ConflictError';
    this.serverState = serverState;
  }
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status >= 400 && status < 500) return 'client';
  if (status >= 500) return 'server';
  return 'unknown';
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function throwForStatus(
  method: string,
  path: string,
  res: Response,
): Promise<never> {
  const body = await readBody(res);
  const kind = kindFromStatus(res.status);
  const statusText = res.statusText ? ` ${res.statusText}` : '';
  throw new ApiError(
    `${method} ${path} failed: ${res.status}${statusText}`,
    res.status,
    kind,
    body,
  );
}

function networkError(method: string, path: string, err: unknown): never {
  if (err instanceof ApiError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new ApiError(`${method} ${path} failed: ${message}`, 0, 'network', err);
}

export const apiBase = () => {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
};

export const getEndpoint = ({
  service = 'chat' as keyof typeof nextEndPoints,
}) => {
  return nextEndPoints[service];
};

export async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
  } catch (err) {
    networkError('GET', path, err);
  }
  if (!res!.ok) await throwForStatus('GET', path, res!);
  return res!.json() as Promise<T>;
}

export async function apiPut<TBody extends object, TResp = void>(
  path: string,
  body: TBody,
): Promise<TResp> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch (err) {
    networkError('PUT', path, err);
  }
  if (res!.status === 409) {
    const data = await readBody(res!);
    throw new ConflictError((data as any)?.serverState);
  }
  if (!res!.ok) await throwForStatus('PUT', path, res!);
  if (res!.status === 204) return undefined as unknown as TResp;
  return res!.json() as Promise<TResp>;
}

export async function apiPost<TBody extends object, TResp = void>(
  path: string,
  body: TBody,
): Promise<TResp> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch (err) {
    networkError('POST', path, err);
  }
  if (!res!.ok) await throwForStatus('POST', path, res!);
  if (res!.status === 204) return undefined as unknown as TResp;
  return res!.json() as Promise<TResp>;
}

export async function apiDelete<TResp = void>(path: string): Promise<TResp> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
  } catch (err) {
    networkError('DELETE', path, err);
  }
  if (!res!.ok) await throwForStatus('DELETE', path, res!);
  if (res!.status === 204) return undefined as unknown as TResp;
  return res!.json() as Promise<TResp>;
}
