export const GOOGLE_WORKSPACE_SERVICES = [
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Search mail and read messages, threads, labels, and drafts.',
    authSignals: ['gmail.'],
  },
  {
    id: 'calendar',
    label: 'Google Calendar',
    description: 'Read calendars and make approved event changes.',
    authSignals: ['calendar.'],
  },
  {
    id: 'docs',
    label: 'Google Docs',
    description: 'Read documents and make approved document updates.',
    authSignals: ['/auth/documents', 'docsmcp'],
  },
] as const;

export type GoogleWorkspaceServiceId =
  (typeof GOOGLE_WORKSPACE_SERVICES)[number]['id'];

export type GoogleWorkspaceConnection = {
  id: GoogleWorkspaceServiceId;
  label: string;
  description: string;
  authorizationSaved: boolean;
};

export function inferGoogleWorkspaceService(authUrl: string): string {
  let decoded = authUrl;
  try {
    decoded = decodeURIComponent(authUrl);
  } catch {
    // Use the original URL if it contains malformed percent encoding.
  }
  const normalized = decoded.toLowerCase();

  const inferenceOrder: GoogleWorkspaceServiceId[] = [
    'gmail',
    'calendar',
    'docs',
  ];
  for (const id of inferenceOrder) {
    const service = GOOGLE_WORKSPACE_SERVICES.find((item) => item.id === id);
    if (service?.authSignals.some((signal) => normalized.includes(signal))) {
      return service.label;
    }
  }
  return 'Google Workspace';
}

const MCP_SERVER_SERVICES: Record<string, string> = {
  gmail_mcp_server: 'Gmail',
  calendar_mcp_server: 'Google Calendar',
  docs_mcp_server: 'Google Docs',
};

export function googleWorkspaceAuthRecoveryMessage(
  toolOutput: string,
): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(toolOutput);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.error !== 'mcp_user_authentication_required') return null;
  const service =
    typeof record.server === 'string'
      ? MCP_SERVER_SERVICES[record.server]
      : undefined;
  if (!service) return null;
  return `${service} authorization needs attention. Open Connections, choose Reconnect for ${service}, then retry your request.`;
}
