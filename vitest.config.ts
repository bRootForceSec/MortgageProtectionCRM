import { defineConfig } from 'vitest/config';
// Setup hooks get more time than the 10 s default: the Windows CI machine is slow when several test files run at once.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', hookTimeout: 30_000 } });
