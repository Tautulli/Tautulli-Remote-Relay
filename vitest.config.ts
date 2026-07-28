import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./vitest.monitor.config.ts', './vitest.enforced.config.ts'],
  },
});
