import type { Conversation } from '@/types/chat';

import { expect, type Page } from '@playwright/test';

// Deterministic content isolates frontend behavior from personal data and live
// model services. The existing agentic suite covers authenticated integration.
export async function openApp(page: Page, conversations: Conversation[] = []) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/me')
      body = { user: { id: 'hig', username: 'hig', name: 'Design Review' } };
    else if (path === '/api/session/conversationHistory') body = conversations;
    else if (path === '/api/session/selectedConversation') body = null;
    else if (path === '/api/images/history') body = [];
    else if (path === '/api/memory/status') body = { total: 0, counts: {} };
    else if (path === '/api/memory/memories')
      body = {
        items: [{ id: 'fact-1', text: 'I prefer concise answers.' }],
        total: 1,
        limit: 25,
        offset: 0,
      };
    else if (path.startsWith('/api/memory/'))
      body = { items: [], total: 0, limit: 25, offset: 0 };
    else if (path === '/api/autonomy/config')
      body = { enabled: false, intervalSeconds: 14400 };
    else if (path.startsWith('/api/autonomy/')) body = [];
    else if (path === '/api/google-workspace/connections')
      body = {
        connections: [
          { id: 'gmail', label: 'Gmail', authorizationSaved: false },
          {
            id: 'calendar',
            label: 'Google Calendar',
            authorizationSaved: true,
          },
        ],
      };
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  // The development indicator is not part of the shipped app.
  await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible();
}

export async function navigate(page: Page, name: string) {
  if ((page.viewportSize()?.width || 0) < 768) {
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name, exact: true })
      .click();
  } else {
    await page.getByRole('tab', { name, exact: true }).click();
  }
}

export async function openSidebar(page: Page) {
  await page
    .getByRole('button', {
      name:
        (page.viewportSize()?.width || 0) < 768
          ? 'Open conversation history'
          : 'Toggle sidebar',
    })
    .click();
}

export async function settleTransitions(page: Page) {
  await page.evaluate(async () => {
    // A parent's appearance transition can start another transition in an
    // inheriting child. Wait for two quiet frames after all finite effects.
    for (let quietFrames = 0; quietFrames < 2; ) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const animations = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getTiming().iterations !== Infinity &&
            animation.playState !== 'finished',
        );
      if (animations.length) {
        quietFrames = 0;
        await Promise.all(
          animations.map((animation) => animation.finished.catch(() => {})),
        );
      } else quietFrames++;
    }
  });
}

export async function assertFits(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, h1, h2, [role="tablist"]',
      ),
    )
      .filter(
        (el) =>
          el.getClientRects().length &&
          !el.closest('[hidden]') &&
          !el.closest('[aria-hidden="true"]'),
      )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < -1 || r.right > width + 1;
      })
      .map(
        (el) =>
          el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName,
      );
  });
  expect(overflow).toEqual([]);
}
