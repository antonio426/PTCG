import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The engine is pure/synchronous — no test needs longer than this, and a hang here almost
    // always means an effect resolved into an infinite loop (see the 擲硬幣直到反面 note in
    // CLAUDE.md's attack-clause-audit section), which is worth failing fast on.
    testTimeout: 10_000,
  },
});
