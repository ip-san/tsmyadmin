import { defineConfig, devices, type ReporterDescription } from '@playwright/test'

/**
 * E2E against the real compose databases (bun run db:up first).
 * - functional: user flows on desktop chromium, for MySQL and PostgreSQL
 * - a11y: axe-core scans of each screen
 * - visual: layout regression (desktop, light + dark)
 * The web server is the production build served by the API (single origin, like the Docker image).
 */
const port = Number(process.env.E2E_PORT ?? 3199)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  ...(process.env.CI ? { workers: 1 } : {}),
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: (process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']]) satisfies ReporterDescription[],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testMatch: /(flow|rows|sql|structure|export)\.spec/ },
    { name: 'a11y', use: { ...devices['Desktop Chrome'] }, testMatch: /a11y\.spec/ },
    { name: 'visual-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' }, testMatch: /visual\.spec/ },
    { name: 'visual-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' }, testMatch: /visual\.spec/ },
  ],
  webServer: {
    command: `bun run build && API_PORT=${port} SESSION_SECRET=e2e-secret bun apps/api/src/index.ts`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
