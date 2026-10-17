/** Types for `test-workers.mjs`, so that `vitest.config.ts` type-checks (the tools project has no `allowJs`). */
export function maxWorkersFor(input: { cpus: number; load1: number; activeRuns: number }): number | undefined
export function countVitestRuns(listing: string): number
export function activeVitestRuns(): number
