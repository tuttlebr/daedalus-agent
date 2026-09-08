import { defineConfig, devices } from '@playwright/test';

const iphone17ProViewport = { width: 402, height: 874 };

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:15000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start-e2e-app.mjs',
    url: 'http://127.0.0.1:15000/login',
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 15_000,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /(?:ui-layout|hig-design)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: iphone17ProViewport,
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'mobile-webkit',
      testMatch: /(?:ui-layout|hig-design)\.spec\.ts/,
      use: { ...devices['iPhone 15'], viewport: iphone17ProViewport },
    },
    {
      name: 'tablet-webkit',
      testMatch: /hig-design\.spec\.ts/,
      use: {
        ...devices['iPad Pro 11'],
        viewport: { width: 834, height: 1194 },
      },
    },
    {
      name: 'compact-chromium',
      testMatch: /hig-design\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 740 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
