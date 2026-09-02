#!/usr/bin/env node
/**
 * Keeps the numbers in CLAUDE.md in sync with the code. `--fix` rewrites them.
 * Counted: unit/API/web tests, conformance cases, e2e tests, API routes.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const fix = process.argv.includes('--fix')

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const count = (file, re) => (readFileSync(file, 'utf8').match(re) ?? []).length
// `it(`, `it.each(...)(`, `it.skipIf(...)(` / `it.runIf(...)(` — the dialect-gated conformance cases count too.
const IT = /^\s*(?:it|test)(?:\.(?:each|skipIf|runIf)\([^)]*\))?\(/gm

const all = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'e2e'))]
const unitTests = all
  .filter((f) => /\.test\.tsx?$/.test(f) && !f.includes('.integration.test.'))
  .reduce((n, f) => n + count(f, IT), 0)
const conformance = count(join(ROOT, 'packages/adapter/src/test/conformance.ts'), IT)
const e2e = all
  .filter((f) => f.endsWith('.spec.ts') && relative(ROOT, f).startsWith('e2e'))
  .reduce((n, f) => n + count(f, IT), 0)
const routes = all
  .filter((f) => relative(ROOT, f).startsWith('apps/api/src/routes/') && f.endsWith('.ts') && !f.includes('.test.'))
  .reduce((n, f) => n + count(f, /\.(get|post|put|patch|delete)\(\s*['"]\//g), 0)

const expected = {
  'unit-tests': unitTests,
  conformance,
  e2e,
  routes,
}

const claudeMd = join(ROOT, 'CLAUDE.md')
let text = readFileSync(claudeMd, 'utf8')
let drift = false
for (const [key, value] of Object.entries(expected)) {
  const re = new RegExp(`(<!-- stat:${key} -->)(\\d+)(<!-- /stat -->)`)
  const m = re.exec(text)
  if (!m) {
    console.error(`CLAUDE.md: missing marker <!-- stat:${key} -->N<!-- /stat -->`)
    drift = true
    continue
  }
  if (Number(m[2]) !== value) {
    drift = true
    console.log(`${fix ? 'fixing' : 'stale'}: ${key} ${m[2]} → ${value}`)
    if (fix) text = text.replace(re, `$1${value}$3`)
  }
}
if (fix && drift) writeFileSync(claudeMd, text)
if (drift && !fix) {
  console.error('✗ docs:validate FAILED (run `bun run docs:validate --fix`)')
  process.exit(1)
}
console.log(`✓ docs:validate ${fix && drift ? 'fixed' : 'passed'} (${JSON.stringify(expected)})`)
