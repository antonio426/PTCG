import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Node, not jsdom/happy-dom: the store logic under test needs only localStorage and fetch,
    // which tests/setup.ts stubs in a few lines. Pulling in a whole DOM implementation as a
    // dependency just for that would not earn its weight.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
  },
});
