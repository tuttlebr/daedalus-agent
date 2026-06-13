export type OAuthPrompt = {
  id: string;
  conversationId: string;
  jobId?: string;
  authUrl: string;
  oauthState?: string;
  service?: string;
};

export function inferGoogleService(authUrl: string): string {
  let decoded = authUrl;
  try {
    decoded = decodeURIComponent(authUrl);
  } catch {
    decoded = authUrl;
  }
  decoded = decoded.toLowerCase();
  if (decoded.includes('gmail')) return 'Gmail';
  if (decoded.includes('calendar')) return 'Calendar';
  return 'Google';
}

export function oauthPromptId(authUrl: string, oauthState?: string): string {
  return oauthState ? `${oauthState}:${authUrl}` : authUrl;
}

export function oauthPromptKey(prompt: OAuthPrompt): string {
  return [prompt.conversationId, prompt.jobId || '', prompt.id].join('\n');
}

export function oauthPromptConversationKeyPrefix(
  conversationId: string,
): string {
  return `${conversationId}\n`;
}

export function oauthPromptsFromStatus(
  status: {
    jobId?: string;
    authUrl?: unknown;
    oauthState?: unknown;
    oauthRequests?: unknown;
  },
  conversationId: string,
): OAuthPrompt[] {
  const requests = Array.isArray(status.oauthRequests)
    ? status.oauthRequests
    : [];
  const sourceRequests =
    requests.length > 0
      ? requests
      : typeof status.authUrl === 'string'
      ? [
          {
            id: oauthPromptId(
              status.authUrl,
              typeof status.oauthState === 'string'
                ? status.oauthState
                : undefined,
            ),
            authUrl: status.authUrl,
            oauthState: status.oauthState,
            service: inferGoogleService(status.authUrl),
          },
        ]
      : [];

  return sourceRequests
    .filter(
      (request): request is Record<string, unknown> =>
        typeof request === 'object' &&
        request !== null &&
        typeof request.authUrl === 'string',
    )
    .map((request) => {
      const authUrl = String(request.authUrl);
      const oauthState =
        typeof request.oauthState === 'string' ? request.oauthState : undefined;
      return {
        id: String(request.id || oauthPromptId(authUrl, oauthState)),
        conversationId,
        jobId: status.jobId,
        authUrl,
        oauthState,
        service:
          typeof request.service === 'string'
            ? request.service
            : inferGoogleService(authUrl),
      };
    });
}

export function withoutOAuthPromptsForConversation(
  prompts: OAuthPrompt[],
  conversationId: string,
): OAuthPrompt[] {
  return prompts.filter((prompt) => prompt.conversationId !== conversationId);
}

export function filterOpenedOAuthPrompts(
  prompts: OAuthPrompt[],
  openedPromptKeys: ReadonlySet<string>,
): OAuthPrompt[] {
  return prompts.filter(
    (prompt) => !openedPromptKeys.has(oauthPromptKey(prompt)),
  );
}
