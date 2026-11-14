export class AutonomyRequestError extends Error {}

/** Read the bounded, public message from our API, never a proxy's HTML body. */
export async function autonomyResponseError(
  response: Response,
  fallback: string,
): Promise<AutonomyRequestError> {
  // Session and rate-limit responses can come from middleware rather than the route.
  if (response.status === 401)
    return new AutonomyRequestError(
      'Your session expired. Sign in again, then retry.',
    );
  try {
    const body = await response.json();
    if (
      typeof body?.error === 'string' &&
      body.error.trim() &&
      body.error.length <= 600
    )
      return new AutonomyRequestError(body.error);
  } catch {
    // A proxy or an interrupted response may not return JSON.
  }
  if (response.status === 429)
    return new AutonomyRequestError(
      'Too many automation requests. Wait a moment, then try again.',
    );
  return new AutonomyRequestError(`${fallback} (HTTP ${response.status})`);
}
