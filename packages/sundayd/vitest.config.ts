import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // SUNDAY-CI: git operations are slow on Windows runners; give them more time.
    testTimeout: process.platform === 'win32' ? 30000 : 5000,
    hookTimeout: process.platform === 'win32' ? 30000 : 10000,
  },
});
