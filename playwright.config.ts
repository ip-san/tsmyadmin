import { defineConfig, devices, type ReporterDescription } from '@playwright/test'

/**
 * E2E against the real compose databases (bun run db:up first).
 * - functional: user flows on desktop chromium, for MySQL and PostgreSQL
 * - a11y: axe-core scans of each screen
 * - visual: layout regression (desktop, light + dark)
 * The web server is the production build served by the API (single origin, like the Docker image).
 */
const port = Number(process.env.E2E_PORT ?? 3199)
// A second API on the persistent session store, for the one feature whose behaviour depends on it (saved
// queries). It serves the same build, so it waits for the first server — whose port opens only once `bun run
// build` has finished — instead of racing it for apps/web/dist.
const persistentPort = port - 1
const STORE_PATH = 'node_modules/.cache/e2e-sessions.sqlite'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  ...(process.env.CI ? { workers: 1 } : {}),
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: (process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']]) satisfies ReporterDescription[],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // The specs assert the Japanese UI; the browsers would otherwise ask for English (the app follows the browser).
    locale: 'ja-JP',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  // Drops scratch objects left behind by aborted runs (e2e_% tables, many_% schemas) so the shared DBs stay clean.
  globalTeardown: './e2e/global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Every functional spec runs here; a11y/visual have their own projects (a new spec cannot be silently skipped).
      testIgnore: /(a11y|visual)\.spec/,
    },
    {
      // Safari's engine differs where it matters for this app (focus restoration after a dialog, Secure cookies
      // on localhost, date input rendering): the functional specs run there too.
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      // saved-queries is excluded: it is the only spec on the shared server-side list, and two browsers running
      // it as the same account would see each other's bookmarks.
      testIgnore: /(a11y|visual|saved-queries)\.spec/,
    },
    { name: 'a11y', use: { ...devices['Desktop Chrome'] }, testMatch: /a11y\.spec/ },
    { name: 'visual-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' }, testMatch: /visual\.spec/ },
    { name: 'visual-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' }, testMatch: /visual\.spec/ },
  ],
  webServer: [
    {
      // Every spec logs in as the same account from parallel workers; the per-identity cap must not evict them.
      command: `bun run build && API_PORT=${port} SESSION_SECRET=e2e-secret SESSION_MAX_PER_IDENTITY=1000 TSMYADMIN_SERVERS='${JSON.stringify(
        [
          { name: 'e2e-mysql', dialect: 'mysql', host: '127.0.0.1', port: 13306, database: 'tsmyadmin_test' },
          { name: 'e2e-postgres', dialect: 'postgres', host: '127.0.0.1', port: 15433, database: 'tsmyadmin_test' },
        ]
      )}' bun apps/api/src/index.ts`,
      port,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Starts only once the build server answers, so both serve the same freshly built assets. The store file
      // is dropped first: a run must not inherit bookmarks (or sessions) from the last one.
      command: `until bun -e 'await fetch("http://127.0.0.1:${port}/healthz")' >/dev/null 2>&1; do sleep 1; done; rm -f ${STORE_PATH} && API_PORT=${persistentPort} SESSION_SECRET=e2e-secret SESSION_STORE=sqlite SESSION_DB_PATH=${STORE_PATH} SESSION_MAX_PER_IDENTITY=1000 TSMYADMIN_SERVERS='${JSON.stringify(
        [
          { name: 'e2e-mysql', dialect: 'mysql', host: '127.0.0.1', port: 13306, database: 'tsmyadmin_test' },
          { name: 'e2e-postgres', dialect: 'postgres', host: '127.0.0.1', port: 15433, database: 'tsmyadmin_test' },
        ]
      )}' bun apps/api/src/index.ts`,
      port: persistentPort,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
})
