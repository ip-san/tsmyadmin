import type { Dialect } from '@tsmyadmin/shared'

export interface RoutineParam {
  mode: 'IN' | 'OUT' | 'INOUT'
  name: string
  type: string
}

/** Splits at commas outside parentheses and quotes: `a numeric(10,2), b text` is two parts. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
    } else if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth--
      current += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/**
 * The parameters of a routine as the catalog prints them: `IN uid int, OUT n int` (MySQL procedure), `uid int`
 * (MySQL function), `IN uid integer, name text DEFAULT 'x'` (PostgreSQL). A `DEFAULT …` tail is left off the type.
 */
export function parseParameters(text: string): RoutineParam[] {
  return splitTopLevel(text).map((part, i) => {
    const words = part.split(/\s+/)
    const first = (words[0] ?? '').toUpperCase()
    const mode = first === 'IN' || first === 'OUT' || first === 'INOUT' ? first : null
    // PostgreSQL's VARIADIC is an input.
    const rest = mode || first === 'VARIADIC' ? words.slice(1) : words
    const name = rest[0] ?? `arg${i + 1}`
    const type = rest
      .slice(1)
      .join(' ')
      .replace(/\s+(?:DEFAULT|=)\s+[\s\S]*$/i, '')
    return { mode: mode ?? 'IN', name, type }
  })
}

const NUMERIC_TYPE =
  /^(?:tiny|small|medium|big)?int(?:eger)?\b|^(?:decimal|numeric|float|double|real|serial|smallserial|bigserial)\b/i
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/** A value as an SQL literal: a number for a numeric parameter, else a quoted string; null is NULL. */
export function literalFor(type: string, value: string | null): string {
  if (value === null) return 'NULL'
  if (NUMERIC_TYPE.test(type) && NUMBER.test(value.trim())) return value.trim()
  return `'${value.replaceAll("'", "''")}'`
}

const quote = (dialect: Dialect, name: string) =>
  dialect === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`

/**
 * The statement that runs a routine with these values (one per parameter, null for NULL), to open in the SQL tab.
 * MySQL passes OUT / INOUT through user variables and selects them afterwards; PostgreSQL's CALL takes NULL for an
 * OUT argument and answers with the values itself.
 */
export function callSql(o: {
  dialect: Dialect
  kind: 'procedure' | 'function'
  name: string
  params: RoutineParam[]
  values: (string | null)[]
}): string {
  const name = quote(o.dialect, o.name)
  const value = (p: RoutineParam, i: number) => literalFor(p.type, o.values[i] ?? null)
  if (o.kind === 'function') {
    // A function's OUT arguments are not passed (PostgreSQL) — MySQL functions have none.
    const args = o.params.flatMap((p, i) => (p.mode === 'OUT' ? [] : [value(p, i)]))
    return `SELECT ${name}(${args.join(', ')});\n`
  }
  if (o.dialect === 'postgres') {
    const args = o.params.map((p, i) => (p.mode === 'OUT' ? 'NULL' : value(p, i)))
    return `CALL ${name}(${args.join(', ')});\n`
  }
  const variable = (i: number) => `@tsmyadmin_${i + 1}`
  const lines: string[] = []
  const args = o.params.map((p, i) => {
    if (p.mode === 'IN') return value(p, i)
    if (p.mode === 'INOUT') lines.push(`SET ${variable(i)} = ${value(p, i)};`)
    return variable(i)
  })
  lines.push(`CALL ${name}(${args.join(', ')});`)
  const outs = o.params.flatMap((p, i) => (p.mode === 'IN' ? [] : [`${variable(i)} AS ${quote('mysql', p.name)}`]))
  if (outs.length > 0) lines.push(`SELECT ${outs.join(', ')};`)
  return `${lines.join('\n')}\n`
}
