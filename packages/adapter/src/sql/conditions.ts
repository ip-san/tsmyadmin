import type { Cell, Dialect, Filter, InputCell, RowKey, WriteCell } from '@tsmyadmin/shared'
import { isFunctionCell, LIST_OPS } from '@tsmyadmin/shared'
import { AdapterError } from '../types.ts'
import { toDbValue } from './cells.ts'
import { Params, quoteIdent } from './quote.ts'
import { rowFunctionSql } from './row-functions.ts'
import { escapeLike } from './search.ts'

/**
 * What an adapter contributes to turning a filter or a row key into SQL: the dialect, and the three places where a
 * dialect differs (how a key value is typed, how two sides of an all-columns match are wrapped, what "equal, NULL
 * included" is spelled). `BaseAdapter` hands over its own overridable methods.
 */
export interface ConditionHooks {
  readonly dialect: Dialect
  keyParam(placeholder: string, type: string): string
  keyMatchExpr(expr: string, type: string): string
  nullSafeEq(): string
}

/** Operators that match on the text form, where a BIT column is not written as its bytes. */
export const TEXT_OPS: ReadonlySet<Filter['op']> = new Set([
  'contains',
  'starts_with',
  'like',
  'not_like',
  'regexp',
  'not_regexp',
])

const FILTER_SQL: Record<Filter['op'], string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  like: 'LIKE',
  not_like: 'NOT LIKE',
  contains: 'LIKE',
  starts_with: 'LIKE',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
  in: 'IN',
  not_in: 'NOT IN',
  between: 'BETWEEN',
  not_between: 'NOT BETWEEN',
  regexp: 'REGEXP',
  not_regexp: 'NOT REGEXP',
  empty: '=',
  not_empty: '<>',
}

const BIT_MAX = 2n ** 64n - 1n

/** A MySQL BIT value typed as a whole number, as the hex literal of its bytes (170 → X'aa'). */
export function bitLiteral(value: InputCell): string {
  const text = String(value).trim()
  // BIT holds at most 64 bits; a larger number would be clamped to the maximum by MySQL's CONV, not refused.
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > BIT_MAX)
    throw new AdapterError('VALIDATION', 'A BIT value must be a whole number from 0 to 18446744073709551615')
  const hex = BigInt(text).toString(16)
  return `X'${hex.length % 2 === 0 ? hex : `0${hex}`}'`
}

/**
 * One condition on one column, shared by the browse filter and the query builder. `bind` turns a value into
 * SQL text: a placeholder for browsing, a quoted literal for a statement the user will edit in the SQL tab.
 */
export function conditionSql(
  hooks: ConditionHooks,
  col: string,
  f: Pick<Filter, 'column' | 'op' | 'value' | 'values'>,
  type: string,
  bind: (value: InputCell) => string
): string {
  const d = hooks.dialect
  const op = FILTER_SQL[f.op]
  if (f.op === 'is_null' || f.op === 'is_not_null') return `${col} ${op}`
  // The column's text form: PostgreSQL has no implicit cast for LIKE / ~ on numbers, dates or json. On MySQL an
  // INT compared with '' would convert '' to 0; CONCAT gives the text ('0') instead, and keeps NULL as NULL.
  const textCol = d === 'postgres' ? `${col}::text` : col
  if (f.op === 'empty' || f.op === 'not_empty') return `${d === 'mysql' ? `CONCAT(${col})` : textCol} ${op} ''`
  if (LIST_OPS.has(f.op)) {
    const values = f.values ?? []
    const between = f.op === 'between' || f.op === 'not_between'
    if (between ? values.length !== 2 : values.length === 0)
      throw new AdapterError(
        'VALIDATION',
        `Filter "${f.op}" on ${f.column} takes ${between ? 'two values' : 'at least one value'}`
      )
    const typed = values.map((v) => hooks.keyParam(bind(v), type))
    return between ? `${col} ${op} ${typed[0]} AND ${typed[1]}` : `${col} ${op} (${typed.join(', ')})`
  }
  if (f.value === undefined) throw new AdapterError('QUERY_FAILED', `Filter "${f.op}" on ${f.column} requires a value`)
  if (f.op === 'contains' || f.op === 'starts_with') {
    // The user's text is matched literally: LIKE metacharacters are escaped, wildcards added here.
    const text = escapeLike(String(f.value ?? ''))
    const pattern = f.op === 'contains' ? `%${text}%` : `${text}%`
    return `${textCol} LIKE ${bind(pattern)} ESCAPE '!'`
  }
  if (f.op === 'like' || f.op === 'not_like') return `${textCol} ${op} ${bind(f.value)}`
  if (f.op === 'regexp' || f.op === 'not_regexp')
    return d === 'postgres'
      ? `${textCol} ${f.op === 'regexp' ? '~' : '!~'} ${bind(f.value)}`
      : `${col} ${op} ${bind(f.value)}`
  // Comparisons use the column's own type (FLOAT 0.1 is not the DOUBLE literal 0.1; BIT is not a hex string).
  return `${col} ${op} ${hooks.keyParam(bind(f.value), type)}`
}

export function buildWhere(
  hooks: ConditionHooks,
  filters: Filter[],
  params: Params,
  types: Map<string, string>
): string {
  if (filters.length === 0) return ''
  const parts = filters.map((f) =>
    conditionSql(hooks, quoteIdent(hooks.dialect, f.column), f, types.get(f.column) ?? '', (v) =>
      params.add(toDbValue(v))
    )
  )
  return ` WHERE ${parts.join(' AND ')}`
}

/** A value to write: bound as a parameter, or an allowed function around its bound argument. */
export function writeValue(dialect: Dialect, params: Params, cell: WriteCell): string {
  if (!isFunctionCell(cell)) return params.add(toDbValue(cell))
  return rowFunctionSql(dialect, cell.$fn, () => params.add(cell.arg ?? null))
}

export function buildKeyWhere(hooks: ConditionHooks, key: RowKey, params: Params, types: Map<string, string>): string {
  const d = hooks.dialect
  const value = (name: string, cell: Cell | undefined) =>
    hooks.keyParam(params.add(toDbValue(cell ?? null)), types.get(name) ?? '')
  switch (key.kind) {
    case 'pk': {
      const names = Object.keys(key.values)
      if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Primary key values are empty')
      return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} = ${value(n, key.values[n])}`).join(' AND ')}`
    }
    case 'all-columns': {
      if (d !== 'mysql') throw new AdapterError('UNSUPPORTED', 'all-columns keys are only supported on MySQL')
      const names = Object.keys(key.values)
      if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Key values are empty')
      const eq = hooks.nullSafeEq()
      // Every column is the key here, so the comparison has to be exact: under the column's own collation
      // rows differing only by case, accent or trailing space are equal, and `LIMIT 1` would then pick
      // whichever the scan reached first — silently editing a row the user did not click.
      const match = (n: string, expr: string) => hooks.keyMatchExpr(expr, types.get(n) ?? '')
      return ` WHERE ${names
        .map((n) => `${match(n, quoteIdent(d, n))} ${eq} ${match(n, value(n, key.values[n]))}`)
        .join(' AND ')}`
    }
    case 'ctid': {
      if (d !== 'postgres') throw new AdapterError('UNSUPPORTED', 'ctid keys are only supported on PostgreSQL')
      return ` WHERE ctid = ${params.add(key.value)}::tid`
    }
  }
}
