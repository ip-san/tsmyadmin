#!/usr/bin/env node
/**
 * How many workers a local `vitest run` may start, so that several runs at once do not swap the machine.
 *
 * Imported by `vitest.config.ts` (`localMaxWorkers`); the reasons are written there. This file holds the parts that can
 * be tested without Vitest: the arithmetic, and reading `ps` for the other runs. `node scripts/test-workers.mjs` prints
 * what this machine would get now; `--self-test` checks the arithmetic and the `ps` parsing.
 */
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * The worker count for one run, or `undefined` for Vitest's default (`cpus - 1`).
 *
 * - Several runs at once share `cpus - 1` evenly (at least 2 each).
 * - A busy machine (1-minute load at least half the CPUs) gets the CPUs that are left (at least 2).
 * - Both apply: the smaller wins. Neither: `undefined`, so a lone run on an idle machine is exactly as before.
 * @param {{ cpus: number, load1: number, activeRuns: number }} input
 * @returns {number | undefined}
 */
export function maxWorkersFor({ cpus, load1, activeRuns }) {
  const limits = []
  if (activeRuns > 1) limits.push(Math.min(cpus - 1, Math.max(2, Math.floor((cpus - 1) / activeRuns))))
  if (load1 >= cpus / 2) limits.push(Math.min(cpus - 1, Math.max(2, Math.floor(cpus - load1))))
  return limits.length ? Math.min(...limits) : undefined
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

/**
 * How many `vitest run` main processes a `ps -axww -o command=` listing holds.
 *
 * A main process looks like `node …/node_modules/.bin/vitest run …` (or `…/vitest/vitest.mjs run`). Not counted: the
 * forks (`node … …/vitest/dist/workers/forks.js`, the path goes on past `vitest/`), the `bun run test` above it, a
 * shell that only names it (`sh -c "vitest run"`), and a run in watch mode or an editor's (`vitest --api`): those sit
 * idle most of the time and would halve every other run's workers for as long as they stay open.
 * @param {string} listing
 * @returns {number}
 */
export function countVitestRuns(listing) {
  let count = 0
  for (const line of listing.split('\n')) {
    const [exe = '', ...rest] = line.trim().split(/\s+/)
    const name = exe.split('/').pop() ?? ''
    if (SHELLS.has(name) || !/^(node|bun)/.test(name)) continue
    // The first argument that is Vitest's bin as a path (Node's own flags may come before it). A bare `vitest` is a
    // launcher that stays as the parent (`node …/npx-cli.js vitest run`): its child is the run, counted on its own line.
    const bin = rest.findIndex((arg) => /\/vitest(\.mjs)?$/.test(arg))
    if (bin === -1) continue
    const args = rest.slice(bin + 1)
    if (args.includes('run') || args.includes('--run')) count++
  }
  return count
}

/**
 * The `vitest run` processes on this machine, this one included (so at least 1). 1 when `ps` is missing, fails or
 * takes longer than 1.5 s: the config must never hang or throw because of this.
 * @returns {number}
 */
export function activeVitestRuns() {
  try {
    const listing = execFileSync('ps', ['-axww', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return Math.max(1, countVitestRuns(listing))
  } catch {
    return 1
  }
}

const SELF_TEST = [
  { name: 'alone, idle: default', input: { cpus: 10, load1: 1, activeRuns: 1 }, expect: undefined },
  { name: 'two runs share 9', input: { cpus: 10, load1: 1, activeRuns: 2 }, expect: 4 },
  { name: 'four runs: 2 each', input: { cpus: 10, load1: 0, activeRuns: 4 }, expect: 2 },
  { name: 'ten runs: never below 2', input: { cpus: 10, load1: 0, activeRuns: 10 }, expect: 2 },
  { name: 'alone, busy: the CPUs left', input: { cpus: 10, load1: 6.5, activeRuns: 1 }, expect: 3 },
  { name: 'alone, saturated: 2', input: { cpus: 10, load1: 14, activeRuns: 1 }, expect: 2 },
  { name: 'busy and two runs: the smaller', input: { cpus: 10, load1: 5, activeRuns: 2 }, expect: 4 },
  { name: 'two runs, busier: load wins', input: { cpus: 10, load1: 7.2, activeRuns: 2 }, expect: 2 },
  { name: 'busy on 2 CPUs: still 1 below the CPUs', input: { cpus: 2, load1: 1, activeRuns: 1 }, expect: 1 },
  { name: 'two runs on 2 CPUs: still 1 below the CPUs', input: { cpus: 2, load1: 0, activeRuns: 2 }, expect: 1 },
]

const LISTING = [
  'node /w/a/node_modules/.bin/vitest run',
  'node --max-old-space-size=4096 /w/b/node_modules/.bin/vitest run --project api --reporter=dot',
  '/usr/bin/node /w/c/node_modules/vitest/vitest.mjs --run',
  '/opt/node --experimental-import-meta-resolve --require /w/a/node_modules/vitest/suppress-warnings.cjs /w/a/node_modules/vitest/dist/workers/forks.js',
  'bun run test',
  '/bin/sh -c vitest run',
  'node /w/d/node_modules/.bin/vitest',
  'node /w/e/node_modules/.bin/vitest --api 51204',
  'node /w/f/node_modules/.bin/vitest-other run',
  'node /usr/lib/node_modules/npm/bin/npx-cli.js vitest run',
  'npm exec vitest run',
  'bun x vitest run',
  '',
].join('\n')

function main() {
  if (process.argv.includes('--self-test')) {
    const failed = SELF_TEST.filter((c) => maxWorkersFor(c.input) !== c.expect)
    for (const c of failed) console.error(`  - ${c.name}: got ${maxWorkersFor(c.input)}, expected ${c.expect}`)
    const runs = countVitestRuns(LISTING)
    if (runs !== 3) {
      console.error(`  - ps listing: counted ${runs} runs, expected 3`)
      failed.push({ name: 'ps listing' })
    }
    if (failed.length) {
      console.error('✗ test-workers self-test FAILED')
      process.exit(1)
    }
    console.log(`✓ test-workers self-test passed (${SELF_TEST.length + 1} cases)`)
    return
  }
  const cpus = os.availableParallelism()
  const [load1 = 0] = os.loadavg()
  const activeRuns = activeVitestRuns()
  const workers = maxWorkersFor({ cpus, load1, activeRuns })
  console.log(
    `cpus=${cpus} load1=${load1.toFixed(2)} activeRuns=${activeRuns} → maxWorkers=${workers ?? `default (${cpus - 1})`}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
