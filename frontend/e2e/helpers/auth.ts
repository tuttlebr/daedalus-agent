import { expect, type Page } from '@playwright/test';

// A rendered composer can use the login response's cached identity. Verify the
// browser also retained and sends its production Secure session cookie.
export async function assertAuthenticatedSession(page: Page) {
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body).toMatchObject({
    authenticated: true,
    user: { username: 'e2e-user', name: 'E2E User' },
  });
}
