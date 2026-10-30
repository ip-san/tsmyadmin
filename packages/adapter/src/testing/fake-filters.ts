/** How the fake adapter orders and filters rows, as a server would: SQL's comparisons and its NULL rule. */
import type { Cell, Filter, InputCell } from '@tsmyadmin/shared'

/** Two cells in a stable order: NULL first, numbers as numbers, anything else by its JSON text. */
export function compare(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b)))
}

/** A value as SQL would compare it: numbers as numbers (a filter's '5' equals 5), anything else as text. */
function sqlCompare(a: Cell, b: InputCell | undefined): number {
  const x = Number(a)
  const y = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y
  return String(a).localeCompare(String(b))
}

/** One browse filter, with SQL's NULL rule: only IS NULL / IS NOT NULL say anything about a NULL. */
export function matchesFilter(v: Cell, f: Filter): boolean {
  if (f.op === 'is_null') return v === null
  if (f.op === 'is_not_null') return v !== null
  if (v === null) return false
  const text = String(v)
  const like = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('%', '.*')
        .replaceAll('_', '.')}$`,
      's'
    ).test(text)
  const values = f.values ?? []
  switch (f.op) {
    case 'eq':
      return sqlCompare(v, f.value) === 0
    case 'neq':
      return sqlCompare(v, f.value) !== 0
    case 'lt':
      return sqlCompare(v, f.value) < 0
    case 'lte':
      return sqlCompare(v, f.value) <= 0
    case 'gt':
      return sqlCompare(v, f.value) > 0
    case 'gte':
      return sqlCompare(v, f.value) >= 0
    case 'contains':
      return text.includes(String(f.value))
    case 'starts_with':
      return text.startsWith(String(f.value))
    case 'like':
      return like(String(f.value))
    case 'not_like':
      return !like(String(f.value))
    case 'in':
      return values.some((x) => sqlCompare(v, x) === 0)
    case 'not_in':
      return !values.some((x) => sqlCompare(v, x) === 0)
    case 'between':
      return sqlCompare(v, values[0]) >= 0 && sqlCompare(v, values[1]) <= 0
    case 'not_between':
      return !(sqlCompare(v, values[0]) >= 0 && sqlCompare(v, values[1]) <= 0)
    case 'regexp':
      return new RegExp(String(f.value)).test(text)
    case 'not_regexp':
      return !new RegExp(String(f.value)).test(text)
    case 'empty':
      return text === ''
    case 'not_empty':
      return text !== ''
  }
}
