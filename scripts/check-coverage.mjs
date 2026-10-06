#!/usr/bin/env node
/**
 * Coverage ratchet for the server side (packages/shared, packages/adapter, apps/api), measured with the unit tests
 * and the real-database tests together: `bun run check:coverage` runs them, then this script compares the result
 * with `scripts/coverage-baseline.json`.
 *
 * It fails when
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

/** `{ "<repo-relative file>": <statement percent, one decimal> }` from a vitest json-summary. */
function percentages(summary, root = ROOT) {
  const out = {}
  for (const [file, v] of Object.entries(summary)) {
    if (file === 'total') continue
    const rel = relative(root, file).split('\\').join('/')
    if (rel.startsWith('..')) continue
    // A file with no statements (types only) cannot be uncovered.
    out[rel] = v.statements.total === 0 ? 100 : Math.round(v.statements.pct * 10) / 10
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
        problems.push(`${file}: new, and only ${pct}% of it runs (at least ${newFileMin}% is asked of a new file)`)
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
  const now = percentages(JSON.parse(readFileSync(file, 'utf8')))
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  if (args.includes('--update')) {
    const next = raised(now, baseline)
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(
      `✓ coverage baseline: ${Object.keys(next).length} files (${Object.keys(next).length - Object.keys(baseline).length} new)`
    )
    return
  }
  const problems = compare(now, baseline)
  const values = Object.values(now)
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1)
  if (problems.length > 0) {
    console.error(`✗ coverage: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`)
    console.error(
      '\nAdd the missing tests. If a drop is right (code removed with its tests), lower the number in scripts/coverage-baseline.json by hand.'
    )
    process.exit(1)
  }
  console.log(`✓ coverage ok: ${values.length} files, mean ${mean.toFixed(1)}% of statements`)
}

main()
