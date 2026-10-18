import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: process.platform === 'win32' ? 30000 : 10000,
    hookTimeout: process.platform === 'win32' ? 30000 : 10000,
  },
});
