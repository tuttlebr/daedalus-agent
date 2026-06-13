import {
  filterOpenedOAuthPrompts,
  oauthPromptKey,
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
          'https://accounts.google.com/auth?scope=calendar.events.readonly',
        oauthState: 'calendar-state',
      },
      'conv-1',
    );

    expect(prompts).toEqual([
      {
        id: 'calendar-state:https://accounts.google.com/auth?scope=calendar.events.readonly',
        conversationId: 'conv-1',
        jobId: 'job-1',
        authUrl:
          'https://accounts.google.com/auth?scope=calendar.events.readonly',
        oauthState: 'calendar-state',
        service: 'Calendar',
      },
    ]);
  });

  it('filters only the clicked OAuth request while leaving other services visible', () => {
    const prompts = oauthPromptsFromStatus(
      {
        jobId: 'job-1',
        oauthRequests: [
          {
            id: 'calendar-state:https://accounts.google.com/auth?scope=calendar.events.readonly',
            authUrl:
              'https://accounts.google.com/auth?scope=calendar.events.readonly',
            oauthState: 'calendar-state',
            service: 'Calendar',
          },
          {
            id: 'gmail-state:https://accounts.google.com/auth?scope=gmail.readonly',
            authUrl: 'https://accounts.google.com/auth?scope=gmail.readonly',
            oauthState: 'gmail-state',
            service: 'Gmail',
          },
        ],
      },
      'conv-1',
    );
    const opened = new Set([oauthPromptKey(prompts[0])]);

    const visible = filterOpenedOAuthPrompts(prompts, opened);

    expect(visible).toHaveLength(1);
    expect(visible[0].service).toBe('Gmail');
  });

  it('does not suppress a later OAuth request with a new state', () => {
    const openedCalendar = oauthPromptsFromStatus(
      {
        jobId: 'job-1',
        authUrl:
          'https://accounts.google.com/auth?scope=calendar.events.readonly',
        oauthState: 'calendar-state-1',
      },
      'conv-1',
    )[0];
    const nextCalendar = oauthPromptsFromStatus(
      {
        jobId: 'job-1',
        authUrl:
          'https://accounts.google.com/auth?scope=calendar.events.readonly',
        oauthState: 'calendar-state-2',
      },
      'conv-1',
    )[0];

    const visible = filterOpenedOAuthPrompts(
      [nextCalendar],
      new Set([oauthPromptKey(openedCalendar)]),
    );

    expect(visible).toEqual([nextCalendar]);
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
});
