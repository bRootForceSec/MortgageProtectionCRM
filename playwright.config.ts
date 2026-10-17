import { defineConfig } from '@playwright/test';

// End-to-end tests run the built app (npm run build) against a throwaway data directory.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
});
