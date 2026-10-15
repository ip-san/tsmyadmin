import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest projects:
 * - adapter / api / web: DB 不要。`bun run test` と pre-commit の対象
 * - adapter-integration / api-integration: docker compose の DB が必要。
 *   `bun run test:integration`（INTEGRATION=1）でのみ実行
 */
const integration = process.env.INTEGRATION === '1'

/**
 * The unit tests finish in milliseconds; the limit is for a machine that is busy with something else (a build, another
 * test run, Docker): under that load the 5-second default failed unrelated tests one after another, at random.
 * A mutation run (`bun run mutation`) raises it: the mutated code carries a switch at every mutant and runs slower.
 */
const UNIT_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 15_000)

/**
 * How many workers (forks) run at once, for the whole run (set at the root: the pool is shared by the projects).
 *
 * Vitest's default is `availableParallelism() - 1`, one fork per test file. Several runs at once (other worktrees,
 * other sessions) multiply that, the machine runs out of memory and swaps, and a fork can no longer answer within
 * Vitest's start timeout: "[vitest-pool]: Failed to start forks worker … Timeout waiting for worker to respond".
 * That timeout is fixed inside Vitest 4.1 (60 s, not an option), so the only lever is to start fewer forks.
 *
 * - CI: Vitest's default (unchanged).
 * - Local, machine mostly idle (1-minute load < half the CPUs): Vitest's default, so the usual run is not slower.
 * - Local, busy: the CPUs that are left, at least 2.
 * - `TEST_MAX_WORKERS=<n>` overrides both (as does `--maxWorkers` on the command line).
 *
 * `os.freemem()` is not used: on macOS it counts only the pages nobody holds, and is near zero on a healthy machine.
 * The load average lags by about a minute, so runs that all start in the same second still each see an idle machine.
 */
function localMaxWorkers(): number | undefined {
  if (process.env.TEST_MAX_WORKERS) return Number(process.env.TEST_MAX_WORKERS)
  if (process.env.CI) return undefined
  const cpus = os.availableParallelism()
  const [load1 = 0] = os.loadavg()
  if (load1 < cpus / 2) return undefined
  return Math.min(cpus - 1, Math.max(2, Math.floor(cpus - load1)))
}

const maxWorkers = localMaxWorkers()

export default defineConfig({
  test: {
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    projects: [
      {
        test: {
          name: 'shared',
          testTimeout: UNIT_TIMEOUT_MS,
          root: 'packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'adapter',
          testTimeout: UNIT_TIMEOUT_MS,
          root: 'packages/adapter',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'api',
          testTimeout: UNIT_TIMEOUT_MS,
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
          testTimeout: UNIT_TIMEOUT_MS,
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
      exclude: ['**/*.test.*', '**/testing/**', '**/test/**', '**/index.ts'],
    },
  },
})
