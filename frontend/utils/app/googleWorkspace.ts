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
