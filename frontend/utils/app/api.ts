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

async function requestJson<T>(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: object,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    networkError(method, path, err);
  }

  // Conversation saves use PUT conflicts to rebase onto the server's copy.
  // Other methods keep the ordinary ApiError, including its response body.
  if (method === 'PUT' && res.status === 409) {
    const data = await readBody(res);
    throw new ConflictError((data as any)?.serverState);
  }
  if (!res.ok) await throwForStatus(method, path, res);
  if (method !== 'GET' && res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return requestJson<T>('GET', path);
}

export function apiPut<TBody extends object, TResp = void>(
  path: string,
  body: TBody,
): Promise<TResp> {
  return requestJson<TResp>('PUT', path, body);
}

export function apiPost<TBody extends object, TResp = void>(
  path: string,
  body: TBody,
): Promise<TResp> {
  return requestJson<TResp>('POST', path, body);
}

export function apiDelete<TResp = void>(path: string): Promise<TResp> {
  return requestJson<TResp>('DELETE', path);
}
