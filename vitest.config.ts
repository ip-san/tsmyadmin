import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest projects:
 * - adapter / api / web: DB 不要。`bun run test` と pre-commit の対象
 * - adapter-integration / api-integration: docker compose の DB が必要。
 *   `bun run test:integration`（INTEGRATION=1）でのみ実行
 */
const integration = process.env.INTEGRATION === '1'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: 'packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'adapter',
          root: 'packages/adapter',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'api',
          root: 'apps/api',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'apps/web/src') } },
        define: { __APP_VERSION__: '"test"' },
        test: {
          name: 'web',
          root: 'apps/web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      ...(integration
        ? [
            {
              test: {
                name: 'adapter-integration',
                root: 'packages/adapter',
                environment: 'node',
                include: ['src/**/*.integration.test.ts'],
                testTimeout: 30_000,
                hookTimeout: 60_000,
              },
            },
            {
              test: {
                name: 'api-integration',
                root: 'apps/api',
                environment: 'node',
                include: ['src/**/*.integration.test.ts'],
                testTimeout: 30_000,
                hookTimeout: 60_000,
              },
            },
          ]
        : []),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.*', '**/testing/**', '**/test/**'],
    },
  },
})
