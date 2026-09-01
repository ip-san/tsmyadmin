#!/usr/bin/env node
/**
 * Architecture checks (fail = exit 1):
 * 1. Package/layer dependency rules
 * 2. Feature isolation in apps/web (features import each other only through components/ or lib/)
 * 3. Component size limit
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const errors = []
const warnings = []

const DRIVERS = ['mysql2', 'pg']

/** [glob-ish prefix, forbidden import specifiers (prefix match), reason] */
const LAYER_RULES = [
  { scope: 'packages/shared/src', forbidden: ['@tsmyadmin/'], reason: 'shared has no internal dependencies' },
  {
    scope: 'packages/adapter/src',
    forbidden: ['@tsmyadmin/api', '@tsmyadmin/web', 'hono'],
    reason: 'adapter is framework-free',
  },
  { scope: 'apps/web/src', forbidden: ['@tsmyadmin/adapter', ...DRIVERS], reason: 'web must not touch DB drivers' },
  { scope: 'apps/api/src/routes', forbidden: DRIVERS, reason: 'routes go through the adapter, never drivers' },
]

const COMPONENT_LINE_LIMIT = 300

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, exts, out)
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full)
  }
  return out
}

function importsOf(source) {
  const specs = []
  const re =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of source.matchAll(re)) specs.push(m[1] ?? m[2] ?? m[3])
  return specs
}

const files = walk(ROOT, ['.ts', '.tsx']).filter((f) => !f.includes(`${sep}e2e${sep}`))

// 1. Layer rules
let checked = 0
for (const file of files) {
  const rel = relative(ROOT, file)
  const source = readFileSync(file, 'utf8')
  const specs = importsOf(source)
  for (const rule of LAYER_RULES) {
    if (!rel.startsWith(rule.scope)) continue
    checked++
    for (const spec of specs) {
      const hit = rule.forbidden.find((f) => spec === f || spec.startsWith(`${f}/`) || spec.startsWith(f))
      if (hit && !(rel.startsWith('packages/adapter/src') && spec.startsWith('@tsmyadmin/shared'))) {
        errors.push(`Layer violation: ${rel} imports '${spec}' (${rule.reason})`)
      }
    }
  }
  // Drivers anywhere outside packages/adapter
  if (!rel.startsWith('packages/adapter/src')) {
    for (const spec of specs) {
      if (DRIVERS.some((d) => spec === d || spec.startsWith(`${d}/`))) {
        errors.push(`Driver import outside adapter: ${rel} imports '${spec}'`)
      }
    }
  }
}

// 2. Feature isolation
const featureDir = join(ROOT, 'apps/web/src/features')
for (const file of walk(featureDir, ['.ts', '.tsx'])) {
  const rel = relative(ROOT, file)
  const feature = relative(featureDir, file).split(sep)[0]
  for (const spec of importsOf(readFileSync(file, 'utf8'))) {
    const m = /^@\/features\/([^/]+)/.exec(spec) ?? /^\.\.\/([^./][^/]*)/.exec(spec)
    if (m && m[1] !== feature && spec.includes('features') === spec.startsWith('@/')) {
      errors.push(`Feature isolation: ${rel} imports feature '${m[1]}' via '${spec}'`)
    }
  }
}

// 3. Component size
const large = []
for (const file of walk(join(ROOT, 'apps/web/src'), ['.tsx'])) {
  if (file.includes('.test.') || file.endsWith('routeTree.gen.ts')) continue
  const lines = readFileSync(file, 'utf8').split('\n').length
  if (lines > COMPONENT_LINE_LIMIT) large.push({ file: relative(ROOT, file), lines })
}
for (const c of large.sort((a, b) => b.lines - a.lines)) {
  warnings.push(`Large component: ${c.file} (${c.lines} lines, limit ${COMPONENT_LINE_LIMIT})`)
}

console.log('Architecture Quality Report')
console.log('─'.repeat(50))
console.log(`Layer rules: ${checked} file/rule pairs checked, ${files.length} files scanned`)
if (warnings.length) {
  console.log('\n⚠️  Warnings:')
  for (const w of warnings) console.log(`  - ${w}`)
}
if (errors.length) {
  console.error('\n✗ Architecture check FAILED:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('\n✓ Architecture check passed')
