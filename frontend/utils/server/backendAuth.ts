export function withInternalBackendAuth(
  headers: Record<string, string>,
): Record<string, string> {
  const token = process.env.DAEDALUS_INTERNAL_API_TOKEN?.trim();
  if (!token) {
    return headers;
  }

  return {
    ...headers,
    'x-daedalus-internal-token': token,
  };
}
