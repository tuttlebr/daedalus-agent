import { defineConfig, devices } from '@playwright/test';

const iphone17ProViewport = { width: 402, height: 874 };
const baseURL = `https://127.0.0.1:${process.env.E2E_WEB_PORT || '15000'}`;
// Pin this run's certificate for Chromium service-worker fetches, which do not
// inherit ignoreHTTPSErrors. Page/readiness handling stays in the test context.
const chromiumLaunchOptions = {
  args: process.env.E2E_TLS_SPKI
    ? [`--ignore-certificate-errors-spki-list=${process.env.E2E_TLS_SPKI}`]
    : [],
};

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
    baseURL,
    // Only the disposable loopback proxy uses a self-signed certificate.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start-e2e-app.mjs',
    url: `${baseURL}/login`,
    ignoreHTTPSErrors: true,
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
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'mobile-chromium',
      testMatch: /(?:ui-layout|hig-design|ux-review|image-download)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions,
        viewport: iphone17ProViewport,
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'mobile-webkit',
      testMatch: /(?:ui-layout|hig-design|ux-review|image-download)\.spec\.ts/,
      use: { ...devices['iPhone 15'], viewport: iphone17ProViewport },
    },
    {
      name: 'tablet-webkit',
      testMatch: /(?:hig-design|ux-review|image-download)\.spec\.ts/,
      use: {
        ...devices['iPad Pro 11'],
        viewport: { width: 834, height: 1194 },
      },
    },
    {
      name: 'compact-chromium',
      testMatch: /(?:hig-design|ux-review|image-download)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumLaunchOptions,
        viewport: { width: 320, height: 740 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
