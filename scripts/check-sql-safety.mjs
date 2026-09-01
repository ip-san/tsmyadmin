#!/usr/bin/env node
/**
 * SQL safety checks (fail = exit 1):
 * 1. SQL text may only be assembled by interpolation inside the adapter's designated builders.
 *    Everywhere else, SQL must be a constant string with parameters (or come from the user via the SQL editor).
 * 2. DB driver packages (mysql2, pg) may only be imported inside packages/adapter.
 * 3. Identifier quoting must go through quoteIdent/quoteTable (no hand-written backtick/double-quote wrapping).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const errors = []

/** Files allowed to build SQL text by interpolation (they quote every identifier via quoteIdent). */
const SQL_BUILDER_ALLOWLIST = [
  /^packages\/adapter\/src\/base\.ts$/,
  /^packages\/adapter\/src\/sql\/.*\.ts$/,
  /^packages\/adapter\/src\/(mysql|postgres)\/(ddl|adapter)\.ts$/,
  // Editor prefill text shown to the user; executed only when they press Run (identifiers quoted).
  /^apps\/web\/src\/features\/sql\/prefill\.ts$/,
]
const SQL_KEYWORD =
  /\b(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|SET SESSION|SET search_path|USE)\b/i
const DRIVERS = ['mysql2', 'pg']

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

/** Extracts template literals (handles one level of ${} nesting containing backticks). */
function templateLiterals(source) {
  const out = []
  let i = 0
  while (i < source.length) {
    const start = source.indexOf('`', i)
    if (start === -1) break
    let j = start + 1
    let depth = 0
    while (j < source.length) {
      const ch = source[j]
      if (ch === '\\') {
        j += 2
        continue
      }
      if (depth === 0 && ch === '`') break
      if (ch === '$' && source[j + 1] === '{') {
        depth++
        j += 2
        continue
      }
      if (depth > 0 && ch === '}') depth--
      j++
    }
    const text = source.slice(start + 1, j)
    out.push({ text, line: source.slice(0, start).split('\n').length })
    i = j + 1
  }
  return out
}

const files = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'packages'))]
let scanned = 0
for (const file of files) {
  const rel = relative(ROOT, file)
  const isTest = /\.(test|spec)\.tsx?$/.test(rel) || rel.includes('/test/') || rel.includes('/testing/')
  const source = readFileSync(file, 'utf8')
  scanned++

  // 2. Driver imports
  if (!rel.startsWith('packages/adapter/src/')) {
    for (const d of DRIVERS) {
      if (new RegExp(`from\\s*['"]${d}(/[^'"]*)?['"]`).test(source))
        errors.push(`${rel}: imports DB driver '${d}' outside packages/adapter`)
    }
  }

  if (isTest) continue
  const allowed = SQL_BUILDER_ALLOWLIST.some((re) => re.test(rel))

  // 1. Interpolated SQL
  for (const tl of templateLiterals(source)) {
    if (!tl.text.includes('${')) continue
    if (!SQL_KEYWORD.test(tl.text)) continue
    if (allowed) {
      // 3. Even in builders, raw quoting of interpolations is forbidden: `\`${x}\`` or "${x}"
      if (/`\$\{[^}]+\}`|"\$\{[^}]+\}"/.test(tl.text)) {
        errors.push(`${rel}:${tl.line}: interpolation wrapped in raw quotes; use quoteIdent()`)
      }
      continue
    }
    errors.push(`${rel}:${tl.line}: SQL built by string interpolation outside the adapter builders`)
  }
  // String concatenation with SQL keywords
  for (const [idx, line] of source.split('\n').entries()) {
    if (allowed) break
    if (
      /['"][^'"]*\b(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b[^'"]*['"]\s*\+\s*[A-Za-z_$]/.test(line)
    ) {
      errors.push(`${rel}:${idx + 1}: SQL built by string concatenation`)
    }
  }
}

console.log(`SQL safety: scanned ${scanned} files`)
if (errors.length) {
  console.error('✗ SQL safety check FAILED:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('✓ SQL safety check passed')
