import { inferGoogleWorkspaceService } from './googleWorkspace';

export type OAuthPrompt = {
  id: string;
  conversationId: string;
  jobId?: string;
  authUrl: string;
  oauthState?: string;
  service?: string;
};

function oauthPromptId(authUrl: string, oauthState?: string): string {
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
            service: inferGoogleWorkspaceService(status.authUrl),
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
            : inferGoogleWorkspaceService(authUrl),
      };
    });
}

export function withoutOAuthPromptsForConversation(
  prompts: OAuthPrompt[],
  conversationId: string,
): OAuthPrompt[] {
  return prompts.filter((prompt) => prompt.conversationId !== conversationId);
}
