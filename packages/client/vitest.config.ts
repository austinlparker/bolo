import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Client tests are out of scope this engagement; the harness is wired but empty.
    passWithNoTests: true,
  },
});
