/**
 * Mutation testing: Stryker changes the code a little at a time (flips a condition, drops a statement, swaps an operator)
 * and runs the tests; a change no test notices — a surviving mutant — is a place the tests run the code but do not check
 * it. Coverage says a line ran; this says whether a test would notice if it were wrong.
 *
 * Run it on the files that matter, not on everything (it re-runs the tests per mutant):
 *   bun run mutation -- --mutate packages/adapter/src/sql/lexical-rules.ts
 * The default set is below (about 2 hours; the script raises the test timeout, since mutated code runs slower). Not
 * part of CI: its score is read, not gated. It runs the tests that need no database, so code tested only against the
 * real servers (the conformance suite) shows as not covered here.
 */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  // `related` finds the tests of a file by what imports it; across workspace packages (`@tsmyadmin/shared`) that finds
  // none, so every test runs, narrowed per mutant by the coverage analysis.
  vitest: { configFile: 'vitest.config.ts', related: false },
  concurrency: 3,
  coverageAnalysis: 'perTest',
  mutate: [
    'packages/shared/src/capabilities.ts',
    'packages/shared/src/quote-identifier.ts',
    'packages/adapter/src/sql/lexical-rules.ts',
    'packages/adapter/src/sql/split.ts',
    'packages/adapter/src/sql/database-op.ts',
    'packages/adapter/src/sql/ddl-common.ts',
    'packages/adapter/src/sql/conditions.ts',
    'packages/adapter/src/sql/join-plan.ts',
    'packages/adapter/src/sql/read-wrap.ts',
    'packages/adapter/src/sql/replication.ts',
    'packages/adapter/src/sql/cells.ts',
    'packages/adapter/src/sql/quote.ts',
    'packages/adapter/src/mysql/users.ts',
    'packages/adapter/src/postgres/users.ts',
    'packages/adapter/src/mysql/ddl.ts',
    'packages/adapter/src/postgres/ddl.ts',
    'packages/adapter/src/mysql/prepare-ddl.ts',
    'packages/adapter/src/postgres/prepare-ddl.ts',
    'packages/adapter/src/mysql/program-detail.ts',
    'packages/adapter/src/postgres/program-detail.ts',
    'apps/api/src/lib/identifiers.ts',
  ],
  reporters: ['clear-text', 'progress-append-only'],
  clearTextReporter: { allowColor: false, reportTests: false, reportMutants: true },
  thresholds: { high: 90, low: 70, break: null },
  tempDirName: 'node_modules/.cache/stryker-tmp',
  ignoreStatic: true,
  timeoutMS: 20000,
}
