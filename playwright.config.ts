import { defineConfig } from '@playwright/test';

// End-to-end tests run the built app (npm run build) against a throwaway data directory.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    // The browser runs on Eastern time, like the sample leads, so callback times read the same in their time and yours.
    timezoneId: 'America/New_York',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
});
