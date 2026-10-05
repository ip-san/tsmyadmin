#!/usr/bin/env node
/**
 * How much of the web app the E2E suite really runs.
 *
 * The unit tests of apps/web cover the logic in `lib/` but hardly the screens (they are tested through the browser),
 * so their numbers say little about the app. This measures the browser tests instead: with E2E_COVERAGE set, each
 * Chromium test saves the V8 block coverage of the app's scripts (e2e/helpers.ts); this merges them (a character
 * ran if any test ran it), maps the result back to the source files through the source maps of a coverage build
 * (apps/web/vite.config.ts), and says per area what share of the emitted code ran and which files never ran at all.
 *
 *   bun run test:e2e:coverage        clears the old records, runs the Chromium tests, prints this report
 *
 * The measure is the share of emitted characters, not of lines or branches: a rough but honest one. A file that
 * appears with 0% is a screen or a helper that no browser test opens.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

const COVERAGE_DIR = 'node_modules/.cache/e2e-coverage'
const SUMMARY_FILE = 'node_modules/.cache/e2e-coverage-summary.json'
const DIST = 'apps/web/dist/assets'

/** One flag per character of a script: 1 where V8 says it ran. Nested ranges override the ones around them. */
export function coveredMap(length, functions) {
  const covered = new Uint8Array(length)
  const ranges = functions.flatMap((f) => f.ranges)
  // Outer ranges first, so an inner range (a block that did not run inside a function that did) overrides it.
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
  for (const r of ranges) covered.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(length, r.endOffset))
  return covered
}

/** `into` with every character that ran in `other` as well. */
export function union(into, other) {
  for (let i = 0; i < other.length; i++) if (other[i]) into[i] = 1
  return into
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(segment) {
  const out = []
  let shift = 0
  let value = 0
  for (const ch of segment) {
    const d = B64.indexOf(ch)
    value += (d & 31) << shift
    if (d & 32) shift += 5
    else {
      out.push(value & 1 ? -(value >> 1) : value >> 1)
      shift = 0
      value = 0
    }
  }
  return out
}

/** Where, in `code`, each piece of generated text starts, and which source it came from. */
export function segmentsOf(code, mappings) {
  const lineStarts = [0]
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1)
  const segments = []
  let source = 0
  mappings.split(';').forEach((line, lineNo) => {
    let col = 0
    for (const seg of line.split(',')) {
      if (!seg) continue
      const v = vlq(seg)
      col += v[0] ?? 0
      if (v.length >= 4) {
        source += v[1] ?? 0
        segments.push({ start: (lineStarts[lineNo] ?? code.length) + col, source })
      }
    }
  })
  return segments
}

/** For each source: how many emitted characters it accounts for, and how many of them ran. */
export function attribute(code, map, covered) {
  const ran = new Uint32Array(code.length + 1)
  for (let i = 0; i < code.length; i++) ran[i + 1] = ran[i] + (covered[i] ? 1 : 0)
  const segments = segmentsOf(code, map.mappings)
  const bySource = new Map()
  segments.forEach((seg, i) => {
    const end = Math.min(code.length, segments[i + 1]?.start ?? code.length)
    const start = Math.min(seg.start, end)
    const name = map.sources[seg.source]
    const entry = bySource.get(name) ?? { total: 0, covered: 0 }
    entry.total += end - start
    entry.covered += ran[end] - ran[start]
    bySource.set(name, entry)
  })
  return bySource
}

/**
 * The repository path of an app source, or null for anything else (a dependency, a virtual module). The paths of a
 * source map are relative to the folder the map is in (apps/web/dist/assets), so they are resolved against it.
 */
export function appPath(source, mapDir = DIST) {
  const resolved = posix.normalize(posix.join(mapDir, source))
  const m = /(?:^|\/)(apps\/web\/src\/.*|packages\/[^/]+\/src\/.*)$/.exec(resolved)
  return m && !m[1].includes('node_modules') ? m[1] : null
}

/** The area a source file belongs to: its first folder under apps/web/src, or its package. */
export function areaOf(path) {
  const web = /^apps\/web\/src\/([^/]+)/.exec(path)
  if (web) return web[1].replace(/\.tsx?$/, '')
  const pkg = /^packages\/([^/]+)/.exec(path)
  return pkg ? `packages/${pkg[1]}` : 'other'
}

const SELF_TEST = () => {
  const failures = []
  const check = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      failures.push(`${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
  }
  check(
    'a block inside a function that ran, which did not',
    [
      ...coveredMap(10, [
        {
          ranges: [
            { startOffset: 0, endOffset: 10, count: 1 },
            { startOffset: 3, endOffset: 6, count: 0 },
          ],
        },
      ]),
    ],
    [1, 1, 1, 0, 0, 0, 1, 1, 1, 1]
  )
  check(
    'an inner function that did not run, listed before its outer one',
    [
      ...coveredMap(6, [
        { ranges: [{ startOffset: 2, endOffset: 4, count: 0 }] },
        { ranges: [{ startOffset: 0, endOffset: 6, count: 3 }] },
      ]),
    ],
    [1, 1, 0, 0, 1, 1]
  )
  check(
    'ranges past the end are cut',
    [...coveredMap(3, [{ ranges: [{ startOffset: 1, endOffset: 99, count: 1 }] }])],
    [0, 1, 1]
  )
  check('a union', [...union(Uint8Array.from([1, 0, 0, 1]), Uint8Array.from([0, 0, 1, 1]))], [1, 0, 1, 1])
  // "ab\ncd": the first line comes from source 0, the second from source 1; only the first line ran.
  const parts = attribute(
    'ab\ncd',
    { mappings: 'AAAA;ACAA', sources: ['a.ts', 'b.ts'] },
    Uint8Array.from([1, 1, 1, 0, 0])
  )
  check(
    'attribution to sources',
    [...parts.entries()],
    [
      ['a.ts', { total: 3, covered: 3 }],
      ['b.ts', { total: 2, covered: 0 }],
    ]
  )
  check(
    'a source the bundle does not map',
    [...attribute('abc', { mappings: '', sources: [] }, new Uint8Array(3)).entries()],
    []
  )
  check(
    'a web source, relative to the map',
    appPath('../../src/features/rows/Grid.tsx'),
    'apps/web/src/features/rows/Grid.tsx'
  )
  check('a web source written out in full', appPath('../../../apps/web/src/app.tsx', 'x/y'), 'apps/web/src/app.tsx')
  check('a dependency is not an app path', appPath('../../../../node_modules/react/index.js'), null)
  check(
    'a shared package path',
    appPath('../../../../packages/shared/src/schemas/api.ts'),
    'packages/shared/src/schemas/api.ts'
  )
  check('the area of a feature', areaOf('apps/web/src/features/rows/Grid.tsx'), 'features')
  check('the area of the entry file', areaOf('apps/web/src/app.tsx'), 'app')
  check('the area of a package', areaOf('packages/shared/src/schemas/api.ts'), 'packages/shared')
  return failures
}

function report() {
  if (!existsSync(COVERAGE_DIR))
    throw new Error(`No records in ${COVERAGE_DIR}: run \`bun run test:e2e:coverage\` first`)
  const records = readdirSync(COVERAGE_DIR).filter((f) => f.endsWith('.json'))
  if (records.length === 0) throw new Error(`No records in ${COVERAGE_DIR}`)
  // What ran, per script file: merged over every test.
  const ranByFile = new Map()
  for (const f of records) {
    for (const entry of JSON.parse(readFileSync(join(COVERAGE_DIR, f), 'utf8'))) {
      const merged = ranByFile.get(entry.file) ?? new Uint8Array(entry.length)
      ranByFile.set(entry.file, union(merged, coveredMap(entry.length, entry.functions)))
    }
  }
  // What exists: every script of the build, loaded by a test or not.
  const perSource = new Map()
  for (const name of readdirSync(DIST).filter((f) => f.endsWith('.js') && existsSync(join(DIST, `${f}.map`)))) {
    const code = readFileSync(join(DIST, name), 'utf8')
    const map = JSON.parse(readFileSync(join(DIST, `${name}.map`), 'utf8'))
    const ran = ranByFile.get(name)
    const covered = ran && ran.length === code.length ? ran : new Uint8Array(code.length)
    for (const [source, v] of attribute(code, map, covered)) {
      const path = appPath(source)
      if (!path) continue
      const entry = perSource.get(path) ?? { total: 0, covered: 0 }
      entry.total += v.total
      entry.covered += v.covered
      perSource.set(path, entry)
    }
  }
  const areas = new Map()
  for (const [path, v] of perSource) {
    const a = areas.get(areaOf(path)) ?? { files: 0, never: 0, total: 0, covered: 0 }
    a.files++
    a.total += v.total
    a.covered += v.covered
    if (v.covered === 0) a.never++
    areas.set(areaOf(path), a)
  }
  const pct = (c, t) => (t === 0 ? '   n/a' : `${((100 * c) / t).toFixed(1).padStart(5)}%`)
  console.log(
    `E2E coverage of the web app: ${records.length} tests, ${perSource.size} source files (share of emitted code that ran)`
  )
  console.log(`${'area'.padEnd(16)} ${'files'.padStart(5)}  ${'ran'.padStart(6)}  never run`)
  let total = 0
  let covered = 0
  for (const [area, a] of [...areas].sort((x, y) => y[1].total - x[1].total)) {
    console.log(`${area.padEnd(16)} ${String(a.files).padStart(5)}  ${pct(a.covered, a.total)}  ${a.never} files`)
    total += a.total
    covered += a.covered
  }
  console.log(`${'TOTAL'.padEnd(16)} ${String(perSource.size).padStart(5)}  ${pct(covered, total)}`)
  const never = [...perSource].filter(([, v]) => v.covered === 0).sort((x, y) => y[1].total - x[1].total)
  console.log(`\nFiles no browser test ran (${never.length}; the largest first):`)
  for (const [path, v] of never.slice(0, 25)) console.log(`  ${String(v.total).padStart(6)} chars  ${path}`)
  mkdirSync('node_modules/.cache', { recursive: true })
  writeFileSync(SUMMARY_FILE, JSON.stringify({ tests: records.length, files: Object.fromEntries(perSource) }, null, 1))
  console.log(`\nPer-file numbers: ${SUMMARY_FILE}`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    const failures = SELF_TEST()
    for (const f of failures) console.error(`  - ${f}`)
    if (failures.length) {
      console.error('✗ e2e-coverage self-test FAILED')
      process.exit(1)
    }
    console.log('✓ e2e-coverage self-test passed')
    return
  }
  if (args.includes('--clear')) {
    rmSync(COVERAGE_DIR, { recursive: true, force: true })
    return
  }
  report()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
