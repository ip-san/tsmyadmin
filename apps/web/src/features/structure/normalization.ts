import type { Cell, TableSchema } from '@tsmyadmin/shared'

/**
 * What phpMyAdmin's "Normalize" wizard looks for, as suggestions: nothing here changes the table. The last two
 * are read from a sample of rows, so they are likelihoods — a dependency the sample happens to show is not one
 * the data guarantees.
 */
export type Hint =
  | { kind: 'noPrimaryKey' }
  | { kind: 'repeatingGroup'; columns: string[] }
  | { kind: 'listValues'; column: string; count: number }
  | { kind: 'missingForeignKey'; column: string; table: string }
  | { kind: 'partialDependency'; key: string; column: string }
  | { kind: 'transitiveDependency'; from: string; column: string }

/** Fewer rows than this and a dependency seen in them says nothing. */
export const MIN_SAMPLE = 20
const MAX_DEPENDENCIES = 10
const MIN_DISTINCT = 3

interface Sample {
  columns: string[]
  rows: readonly Cell[][]
}

/** Columns such as `phone1, phone2` or `addr_1, addr_2`: one fact stored in numbered copies. */
function repeatingGroups(columns: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const name of columns) {
    const m = /^(.*?[a-z])_?\d+$/i.exec(name)
    if (!m?.[1]) continue
    const stem = m[1].toLowerCase()
    groups.set(stem, [...(groups.get(stem) ?? []), name])
  }
  return [...groups.values()].filter((g) => g.length >= 2)
}

/** "red, green, blue": several short items in one value. A sentence with a comma is not a list. */
function isList(value: string): boolean {
  const parts = value.split(/[,;|]/)
  return (
    parts.length >= 2 &&
    parts.every((p) => {
      const item = p.trim()
      return item.length > 0 && item.length <= 32 && item.split(/\s+/).length <= 3
    })
  )
}

function listColumns(schema: TableSchema, sample: Sample): { column: string; count: number }[] {
  const out: { column: string; count: number }[] = []
  for (const column of schema.columns) {
    if (!/char|text/i.test(column.dataType)) continue
    const at = sample.columns.indexOf(column.name)
    const values = sample.rows.map((r) => r[at]).filter((v): v is string => typeof v === 'string')
    const lists = values.filter(isList).length
    if (lists >= 3 && lists * 2 >= values.length) out.push({ column: column.name, count: lists })
  }
  return out
}

/** `user_id` / `userId` with no foreign key, where a table of that name exists (`user`, `users`, …). */
function missingForeignKeys(schema: TableSchema, tables: string[]): { column: string; table: string }[] {
  const covered = new Set(schema.foreignKeys.flatMap((fk) => fk.columns))
  const sole = schema.primaryKey.length === 1 ? schema.primaryKey[0] : undefined
  const out: { column: string; table: string }[] = []
  for (const { name } of schema.columns) {
    if (covered.has(name) || name === sole) continue
    // `_id` or camelCase `Id`: a word that merely ends in "id" (paid, valid, grid) is not a reference.
    const stem = /^(.+?)(?:_id|_ID|Id)$/.exec(name)?.[1]
    if (!stem || stem.length < 2) continue
    const s = stem.replace(/_$/, '')
    const candidates = [s, `${s}s`, `${s}es`, s.replace(/y$/i, 'ies')].map((c) => c.toLowerCase())
    const table = tables.find((t) => t !== schema.name && candidates.includes(t.toLowerCase()))
    if (table) out.push({ column: name, table })
  }
  return out
}

const keyOf = (cell: Cell | undefined) => JSON.stringify(cell ?? null)

/**
 * Whether `from` determines `to` in the sample, in a way that means something: some value of `from` repeats (a
 * column whose values are all different determines everything), `to` is not the same everywhere, and `from` has
 * at least three values — two yes/no or light/dark columns line up by chance in a small sample far too often to
 * read anything into it.
 */
function determines(rows: readonly Cell[][], from: number, to: number): boolean {
  const seen = new Map<string, string>()
  const repeats = new Map<string, number>()
  const targets = new Set<string>()
  for (const row of rows) {
    if (row[from] === null || row[from] === undefined) continue
    const a = keyOf(row[from])
    const b = keyOf(row[to])
    const before = seen.get(a)
    if (before !== undefined && before !== b) return false
    seen.set(a, b)
    repeats.set(a, (repeats.get(a) ?? 0) + 1)
    targets.add(b)
  }
  const repeated = [...repeats.values()].filter((n) => n >= 2).length
  return repeated >= 2 && targets.size >= 2 && seen.size >= MIN_DISTINCT
}

function dependencies(schema: TableSchema, sample: Sample): Hint[] {
  if (sample.rows.length < MIN_SAMPLE) return []
  const index = (name: string) => sample.columns.indexOf(name)
  const key = new Set(schema.primaryKey)
  // Columns of a unique index determine every other column by definition; that is not redundancy.
  const unique = new Set(schema.indexes.filter((i) => i.unique && i.columns.length === 1).flatMap((i) => i.columns))
  const nonKey = schema.columns.map((c) => c.name).filter((n) => !key.has(n) && index(n) !== -1)
  const out: Hint[] = []
  // 2NF: part of a composite key decides a column on its own.
  if (schema.primaryKey.length >= 2) {
    for (const part of schema.primaryKey) {
      for (const column of nonKey) {
        if (determines(sample.rows, index(part), index(column)))
          out.push({ kind: 'partialDependency', key: part, column })
      }
    }
  }
  // 3NF: one non-key column decides another. A pair that decide each other is reported once.
  for (const from of nonKey) {
    if (unique.has(from)) continue
    for (const column of nonKey) {
      if (column === from) continue
      if (!determines(sample.rows, index(from), index(column))) continue
      if (column < from && !unique.has(column) && determines(sample.rows, index(column), index(from))) continue
      out.push({ kind: 'transitiveDependency', from, column })
    }
  }
  return out.slice(0, MAX_DEPENDENCIES)
}

export function normalizationHints(schema: TableSchema, tables: string[], sample: Sample | null): Hint[] {
  const hints: Hint[] = []
  if (schema.primaryKey.length === 0) hints.push({ kind: 'noPrimaryKey' })
  for (const columns of repeatingGroups(schema.columns.map((c) => c.name)))
    hints.push({ kind: 'repeatingGroup', columns })
  if (sample) for (const l of listColumns(schema, sample)) hints.push({ kind: 'listValues', ...l })
  for (const fk of missingForeignKeys(schema, tables)) hints.push({ kind: 'missingForeignKey', ...fk })
  if (sample) hints.push(...dependencies(schema, sample))
  return hints
}
