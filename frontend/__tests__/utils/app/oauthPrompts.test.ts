import {
  oauthPromptsFromStatus,
  withoutOAuthPromptsForConversation,
} from '@/utils/app/oauthPrompts';

import { describe, expect, it } from 'vitest';

describe('oauthPrompts', () => {
  it('builds prompts from a single legacy authUrl status', () => {
    const prompts = oauthPromptsFromStatus(
      {
        jobId: 'job-1',
        authUrl:
          'https://accounts.google.com/auth?scope=calendar.calendarlist.readonly',
        oauthState: 'calendar-state',
      },
      'conv-1',
    );

    expect(prompts).toEqual([
      {
        id: 'calendar-state:https://accounts.google.com/auth?scope=calendar.calendarlist.readonly',
        conversationId: 'conv-1',
        jobId: 'job-1',
        authUrl:
          'https://accounts.google.com/auth?scope=calendar.calendarlist.readonly',
        oauthState: 'calendar-state',
        service: 'Google Calendar',
      },
    ]);
  });

  it('removes prompts for only the selected conversation', () => {
    const prompt = {
      id: 'p1',
      conversationId: 'conv-1',
      jobId: 'job-1',
      authUrl: 'https://accounts.google.com/auth',
    };
    const otherPrompt = { ...prompt, id: 'p2', conversationId: 'conv-2' };

    expect(
      withoutOAuthPromptsForConversation([prompt, otherPrompt], 'conv-1'),
    ).toEqual([otherPrompt]);
  });

  it.each([
    ['gmail.readonly', 'Gmail'],
    ['calendar.events.readonly', 'Google Calendar'],
    ['documents', 'Google Docs'],
    ['spreadsheets', 'Google Sheets'],
    ['presentations', 'Google Slides'],
    ['drive.readonly', 'Google Drive'],
  ])('identifies the %s authorization as %s', (scope, service) => {
    const [prompt] = oauthPromptsFromStatus(
      {
        authUrl: `https://accounts.google.com/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2F${scope}`,
      },
      'conv-1',
    );

    expect(prompt.service).toBe(service);
  });
});
