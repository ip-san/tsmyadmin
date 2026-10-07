#!/usr/bin/env node
/**
 * Coverage ratchet for the server side (packages/shared, packages/adapter, apps/api), measured with the unit tests
 * and the real-database tests together: `bun run check:coverage` runs them, then this script compares the result
 * with `scripts/coverage-baseline.json`.
 *
 * Two measures are held, each per file: the share of statements that ran, and the share of branches taken (an `if`
 * with no test of its else, an error path nobody triggers). Branches are the weaker number, and the one a test of the
 * happy path alone leaves behind. It fails when
 *   - a file that was in the baseline now runs `DROP` points less of its statements (a test that stopped
 *     covering something, or code that grew without one), or
 *   - a file that is not in the baseline starts below `NEW_FILE_MIN` percent (new code should come with tests).
 * Raising is free: `-- --update` records new highs and new files, never a lower number (lowering is done by hand,
 * with a reason, in the baseline).
 *
 * The drop is generous (10 points) because the two CI database versions reach slightly different branches; the
 * point is to catch a file going from tested to untested, not a line or two.
 *
 * Usage: node scripts/check-coverage.mjs [--update] [--self-test] [summary.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SUMMARY = 'coverage/server/coverage-summary.json'
const BASELINE = resolve(ROOT, 'scripts/coverage-baseline.json')
const DROP = 10
const NEW_FILE_MIN = 60
/** The measures of a vitest json-summary that are held, and what a new file must reach for each. */
const METRICS = { statements: NEW_FILE_MIN, branches: 50 }

/** `{ "<repo-relative file>": <percent of `metric`, one decimal> }` from a vitest json-summary. */
function percentages(summary, root = ROOT, metric = 'statements') {
  const out = {}
  for (const [file, v] of Object.entries(summary)) {
    if (file === 'total') continue
    const rel = relative(root, file).split('\\').join('/')
    if (rel.startsWith('..')) continue
    // A file with none of the thing (types only; no `if`) cannot be uncovered.
    out[rel] = v[metric].total === 0 ? 100 : Math.round(v[metric].pct * 10) / 10
  }
  return out
}

/** The problems of `now` against `baseline` (both `{ file: percent }`). */
function compare(now, baseline, { drop = DROP, newFileMin = NEW_FILE_MIN } = {}) {
  const problems = []
  for (const [file, pct] of Object.entries(now)) {
    const was = baseline[file]
    if (was === undefined) {
      if (pct < newFileMin)
        problems.push(
          `${file}: new, and only ${pct}% of it is covered (at least ${newFileMin}% is asked of a new file)`
        )
    } else if (pct < was - drop) {
      problems.push(`${file}: ${pct}% now, was ${was}% (more than ${drop} points lower)`)
    }
  }
  return problems
}

/** The baseline after an update: new files and higher numbers are taken, nothing is lowered or removed. */
function raised(now, baseline) {
  const next = { ...baseline }
  for (const [file, pct] of Object.entries(now)) if (next[file] === undefined || pct > next[file]) next[file] = pct
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

function selfTest() {
  const assert = (cond, what) => {
    if (!cond) throw new Error(`self-test failed: ${what}`)
  }
  const base = { 'a.ts': 90, 'b.ts': 50 }
  assert(compare({ 'a.ts': 85, 'b.ts': 50 }, base).length === 0, 'a small drop is allowed')
  assert(compare({ 'a.ts': 79, 'b.ts': 50 }, base).length === 1, 'a drop of more than 10 points fails')
  assert(compare({ 'a.ts': 90, 'b.ts': 50, 'c.ts': 59 }, base).length === 1, 'a new file under 60% fails')
  assert(compare({ 'a.ts': 90, 'b.ts': 50, 'c.ts': 60 }, base).length === 0, 'a new file at 60% passes')
  assert(compare({ 'b.ts': 50 }, base).length === 0, 'a file that is gone is not a problem')
  const next = raised({ 'a.ts': 80, 'b.ts': 70, 'c.ts': 65 }, base)
  assert(next['a.ts'] === 90 && next['b.ts'] === 70 && next['c.ts'] === 65, 'update raises, never lowers, and adds')
  const pct = percentages(
    {
      total: {},
      [`${ROOT}/x.ts`]: { statements: { total: 4, pct: 75.04 } },
      [`${ROOT}/t.ts`]: { statements: { total: 0, pct: 100 } },
    },
    ROOT
  )
  assert(pct['x.ts'] === 75 && pct['t.ts'] === 100, 'percentages are read as repo-relative, one decimal')
  const both = {
    [`${ROOT}/y.ts`]: { statements: { total: 10, pct: 100 }, branches: { total: 4, pct: 50 } },
    [`${ROOT}/z.ts`]: { statements: { total: 3, pct: 100 }, branches: { total: 0, pct: 100 } },
  }
  assert(percentages(both, ROOT, 'branches')['y.ts'] === 50, 'branches are read from their own measure')
  assert(percentages(both, ROOT, 'branches')['z.ts'] === 100, 'a file with no branches cannot miss one')
  assert(
    compare({ 'a.ts': 55 }, {}, { newFileMin: METRICS.branches }).length === 0,
    'a new file at 55% of its branches passes'
  )
  assert(
    compare({ 'a.ts': 49 }, {}, { newFileMin: METRICS.branches }).length === 1,
    'a new file under 50% of its branches fails'
  )
  console.log('✓ coverage self-test passed')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  const file = resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? SUMMARY)
  if (!existsSync(file)) {
    console.error(`✗ ${relative(ROOT, file)} not found: run \`bun run check:coverage\` (it measures, then checks)`)
    process.exit(1)
  }
  const summary = JSON.parse(readFileSync(file, 'utf8'))
  // The baseline holds one map per measure. (A baseline written before branches were held is a bare map of statements.)
  const stored = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const baselines = 'statements' in stored || 'branches' in stored ? stored : { statements: stored }
  const measured = Object.fromEntries(Object.keys(METRICS).map((m) => [m, percentages(summary, ROOT, m)]))
  if (args.includes('--update')) {
    const next = Object.fromEntries(Object.keys(METRICS).map((m) => [m, raised(measured[m], baselines[m] ?? {})]))
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    for (const m of Object.keys(METRICS))
      console.log(
        `✓ coverage baseline, ${m}: ${Object.keys(next[m]).length} files (${Object.keys(next[m]).length - Object.keys(baselines[m] ?? {}).length} new)`
      )
    return
  }
  const problems = Object.entries(METRICS).flatMap(([m, newFileMin]) =>
    compare(measured[m], baselines[m] ?? {}, { newFileMin }).map((p) => `[${m}] ${p}`)
  )
  const mean = (m) => {
    const values = Object.values(measured[m])
    return values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1)
  }
  if (problems.length > 0) {
    console.error(`✗ coverage: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`)
    console.error(
      '\nAdd the missing tests. If a drop is right (code removed with its tests), lower the number in scripts/coverage-baseline.json by hand.'
    )
    process.exit(1)
  }
  console.log(
    `✓ coverage ok: ${Object.keys(measured.statements).length} files, mean ${mean('statements').toFixed(1)}% of statements, ${mean('branches').toFixed(1)}% of branches`
  )
}

main()
