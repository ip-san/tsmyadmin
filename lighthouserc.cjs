/**
 * Lighthouse CI (warn-only quality signal for the login screen, the only page reachable without credentials).
 * Runs the production build behind the real API so CSP/headers are exercised.
 * Local: bun run build && bun run lighthouse   (needs Chrome)
 */
const port = 3195

module.exports = {
  ci: {
    collect: {
      startServerCommand: `API_PORT=${port} SESSION_SECRET=lighthouse-secret-0123456789abcdef bun apps/api/src/index.ts`,
      startServerReadyPattern: 'startup',
      startServerReadyTimeout: 30000,
      url: [`http://127.0.0.1:${port}/login`],
      numberOfRuns: 2,
      settings: { preset: 'desktop', chromeFlags: '--no-sandbox --headless=new' },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.9 }],
        'categories:accessibility': ['warn', { minScore: 0.95 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
        'categories:seo': 'off',
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
}
