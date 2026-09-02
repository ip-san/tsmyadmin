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

/** Files allowed to build SQL text by interpolation (they quote every identifier via quoteIdent). */
const SQL_BUILDER_ALLOWLIST = [
  /^packages\/adapter\/src\/base\.ts$/,
  /^packages\/adapter\/src\/sql\/.*\.ts$/,
  // Per-dialect builders that assemble statements from quoteIdent() identifiers and literal helpers:
  // ddl (ALTER/CREATE), adapter (USE/SET/SHOW CREATE), export (INSERT dumps), users (accounts/GRANT), server (KILL id, regex-validated).
  // introspect.ts / values.ts are deliberately NOT listed: they must stay static SQL + parameters.
  /^packages\/adapter\/src\/(mysql|postgres)\/(ddl|adapter|export|users|server)\.ts$/,
  // routines: SHOW CREATE PROCEDURE|FUNCTION <quoted db>.<quoted name> (MySQL has no parameterisable form).
  /^packages\/adapter\/src\/mysql\/routines\.ts$/,
  // Editor prefill text shown to the user; executed only when they press Run (identifiers quoted).
  /^apps\/web\/src\/features\/sql\/prefill\.ts$/,
  // Regular expressions that *parse* GRANT statements returned by the server; nothing here is executed.
  /^apps\/web\/src\/features\/users\/privilege-level\.ts$/,
]
const SQL_KEYWORD =
  /\b(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|KILL|SHOW|SET SESSION|SET search_path|USE|WHERE|JOIN|ORDER BY|GROUP BY|VALUES)\b/i
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

/** Static text of a template literal with every ${...} interpolation removed (one level of nested braces). */
function staticText(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') depth--
        i++
      }
      continue
    }
    out += text[i]
    i++
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
    // Is this literal the SQL argument of a query call? Covers `conn.query(`…`)`, generics (`query<T>(`),
    // the driver object forms (`query({ sql: `…` })` / `{ text: `…` }`), `execute(` and the adapters' own
    // `this.run(conn, `…`)` helper.
    const before = source.slice(Math.max(0, start - 80), start)
    const queryArg =
      /\.(query|execute|exec)(<[^>]*>)?\(\s*(\{\s*(sql|text)\s*:\s*)?$/.test(before) ||
      /\.run\(\s*\w+\s*,\s*$/.test(before)
    out.push({ text, line: source.slice(0, start).split('\n').length, queryArg })
    i = j + 1
  }
  return out
}

/** Rule violations for one source file (repo-relative path); test files only get the driver-import rule. */
function checkFile(rel, source) {
  const errors = []
  const isTest = /\.(test|spec)\.tsx?$/.test(rel) || rel.includes('/test/') || rel.includes('/testing/')

  // 2. Driver imports
  if (!rel.startsWith('packages/adapter/src/')) {
    for (const d of DRIVERS) {
      if (new RegExp(`from\\s*['"]${d}(/[^'"]*)?['"]`).test(source))
        errors.push(`${rel}: imports DB driver '${d}' outside packages/adapter`)
    }
  }

  if (isTest) return errors
  const allowed = SQL_BUILDER_ALLOWLIST.some((re) => re.test(rel))

  // 1. Interpolated SQL
  for (const tl of templateLiterals(source)) {
    if (!tl.text.includes('${')) continue
    // 1a. In SQL text, an interpolation glued to a quote is a literal built from a value — never acceptable
    // (the quoting helpers in sql/quote.ts and sql/literal.ts are the ones that produce such literals).
    const sqlish = tl.queryArg || SQL_KEYWORD.test(staticText(tl.text))
    if (sqlish && !/^packages\/adapter\/src\/sql\/(quote|literal)\.ts$/.test(rel) && /['"]\$\{|\}['"]/.test(tl.text)) {
      errors.push(`${rel}:${tl.line}: interpolation adjacent to a quote (value inlined into SQL)`)
      continue
    }
    // 1b. Outside the builders, a template handed to .query() may only compose UPPER_CASE SQL constants
    // (e.g. `${TRIGGER_SELECT} WHERE …`); the keyword test below would miss a prefix-constant statement.
    if (!allowed && tl.queryArg) {
      const parts = tl.text.match(/\$\{[^}]*\}/g) ?? []
      if (parts.some((p) => !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(p))) {
        errors.push(`${rel}:${tl.line}: query text interpolates a non-constant outside the adapter builders`)
      }
      continue
    }
    // Only the literal SQL text counts; identifiers inside ${} (e.g. locale.ddl.drop) must not trigger.
    if (!SQL_KEYWORD.test(staticText(tl.text))) continue
    if (allowed) {
      // 3. Even in builders, raw quoting of interpolations is forbidden: `\`${x}\`` or "${x}"
      if (/`\$\{[^}]+\}\\?`|"\$\{[^}]+\}"/.test(tl.text)) {
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
      /['"][^'"]*\b(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|WHERE|FROM)\b[^'"]*['"]\s*\+\s*[A-Za-z_$]/i.test(
        line
      )
    ) {
      errors.push(`${rel}:${idx + 1}: SQL built by string concatenation`)
    }
  }
  return errors
}

/**
 * Known-bad snippets every rule must catch and known-good ones it must accept: `--self-test` runs them so a
 * regex change cannot silently open a hole (the rules live in this file only, so this is their test).
 */
const SELF_TEST = [
  { rel: 'apps/api/src/x.ts', bad: true, source: "conn.query(`SELECT * FROM t WHERE a = '${v}'`)" },
  { rel: 'apps/api/src/x.ts', bad: true, source: "conn.query({ sql: `${TABLES} WHERE name = '${v}'` })" },
  { rel: 'apps/api/src/x.ts', bad: true, source: "client.query<Row>(`${TABLES} WHERE name = '${v}'`)" },
  { rel: 'apps/api/src/x.ts', bad: true, source: 'conn.execute(`${TABLES} WHERE id = ${id}`)' },
  { rel: 'apps/api/src/x.ts', bad: true, source: 'this.run(conn, `${TABLES} WHERE id = ${id}`)' },
  { rel: 'apps/api/src/x.ts', bad: true, source: "const q = 'select * from t where x = ' + v" },
  { rel: 'apps/api/src/x.ts', bad: true, source: 'const q = `SELECT * FROM ${table}`' },
  { rel: 'apps/web/src/x.ts', bad: true, source: "import mysql from 'mysql2/promise'" },
  {
    rel: 'packages/adapter/src/mysql/introspect.ts',
    bad: true,
    source: "conn.query({ sql: `${TABLES} WHERE name = '${v}'` })",
  },
  { rel: 'packages/adapter/src/mysql/ddl.ts', bad: true, source: 'return [`ALTER TABLE \\`${op.table}\\` ADD ${x}`]' },
  {
    rel: 'packages/adapter/src/mysql/introspect.ts',
    bad: false,
    source: 'conn.query(`${TABLE_SELECT} WHERE TABLE_SCHEMA = ?`, [db])',
  },
  {
    rel: 'packages/adapter/src/mysql/ddl.ts',
    bad: false,
    source: 'return [`ALTER TABLE ${quoteTable(ns, op.table)} ADD ${col}`]',
  },
  { rel: 'apps/web/src/x.ts', bad: false, source: 'const label = `${count} rows from ${table}`' },
  { rel: 'apps/api/src/x.test.ts', bad: false, source: "conn.query(`SELECT * FROM t WHERE a = '${v}'`)" },
]

if (process.argv.includes('--self-test')) {
  const failed = SELF_TEST.filter((c) => checkFile(c.rel, c.source).length > 0 !== c.bad)
  for (const c of failed) console.error(`  - ${c.bad ? 'missed' : 'false positive'}: ${c.rel}: ${c.source}`)
  if (failed.length) {
    console.error('✗ SQL safety self-test FAILED')
    process.exit(1)
  }
  console.log(`✓ SQL safety self-test passed (${SELF_TEST.length} cases)`)
  process.exit(0)
}

const files = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'packages'))]
const errors = files.flatMap((file) => checkFile(relative(ROOT, file), readFileSync(file, 'utf8')))
console.log(`SQL safety: scanned ${files.length} files`)
if (errors.length) {
  console.error('✗ SQL safety check FAILED:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log('✓ SQL safety check passed')
