export const GOOGLE_WORKSPACE_SERVICES = [
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Search mail, read threads, and create approved drafts.',
    authSignals: ['gmail.'],
  },
  {
    id: 'calendar',
    label: 'Google Calendar',
    description: 'Read calendars, events, availability, and suggested times.',
    authSignals: ['calendar.'],
  },
  {
    id: 'drive',
    label: 'Google Drive',
    description: 'Find and read Drive files; create or copy with approval.',
    authSignals: ['/auth/drive.file', '/auth/drive.readonly', 'drivemcp'],
  },
  {
    id: 'docs',
    label: 'Google Docs',
    description: 'Read documents and make approved document updates.',
    authSignals: ['/auth/documents', 'docsmcp'],
  },
  {
    id: 'sheets',
    label: 'Google Sheets',
    description: 'Read spreadsheets and make approved cell or sheet updates.',
    authSignals: ['/auth/spreadsheets', 'sheetsmcp'],
  },
  {
    id: 'slides',
    label: 'Google Slides',
    description: 'Read presentations and make approved presentation updates.',
    authSignals: ['/auth/presentations', 'slidesmcp'],
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

  // Drive scopes are shared by Docs, Sheets, and Slides, so check their
  // product-specific scopes before the generic Drive signals.
  const inferenceOrder: GoogleWorkspaceServiceId[] = [
    'gmail',
    'calendar',
    'docs',
    'sheets',
    'slides',
    'drive',
  ];
  for (const id of inferenceOrder) {
    const service = GOOGLE_WORKSPACE_SERVICES.find((item) => item.id === id);
    if (service?.authSignals.some((signal) => normalized.includes(signal))) {
      return service.label;
    }
  }
  return 'Google Workspace';
}
