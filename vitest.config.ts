import { defineConfig } from 'vitest/config';
// Tests and setup hooks get more time than the defaults (5 s and 10 s): the Windows CI machine is slow when
// several test files run at once, and the PDF import tests have timed out there at 5 s while passing in well under 1 s locally.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20_000, hookTimeout: 30_000 } });
