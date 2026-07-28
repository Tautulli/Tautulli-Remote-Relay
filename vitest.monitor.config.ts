import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { TEST_SERVICE_ACCOUNT } from './test/fixtures';

export default defineWorkersProject({
  test: {
    name: 'monitor',
    include: ['test/quota.spec.ts', 'test/quota-do.spec.ts', 'test/relay.spec.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            FCM_SERVICE_ACCOUNT: TEST_SERVICE_ACCOUNT,
          },
        },
      },
    },
  },
});
