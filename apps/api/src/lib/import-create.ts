import type { ColumnSpec, Dialect } from '@tsmyadmin/shared'
import { inferType } from '@tsmyadmin/shared'
import type { RowCell } from './import-rows.ts'

/** The start of a name that fits the server's limit (MySQL: 64 characters; PostgreSQL: 63 bytes), less room for a suffix. */
function clip(text: string, dialect: Dialect): string {
  const room = 8
  let out = ''
  let bytes = 0
  let chars = 0
  for (const ch of text) {
    bytes += Buffer.byteLength(ch)
    chars++
    if (dialect === 'postgres' ? bytes > 63 - room : chars > 64 - room) break
    out += ch
  }
  return out
}

/** A name safe to use as a column: not empty, trimmed, and not the same as an earlier one (`name`, `name_2`…). */
export function columnNames(header: readonly string[] | null, width: number, dialect: Dialect): string[] {
  const used = new Set<string>()
  return Array.from({ length: width }, (_, i) => {
    const base = clip((header?.[i] ?? '').trim(), dialect) || `col${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`
    used.add(name.toLowerCase())
    return name
  })
}

/** Column specs for a createTable operation: every column nullable (a file says nothing about keys). */
export function inferColumns(
  names: readonly string[],
  rows: readonly (readonly RowCell[])[],
  dialect: Dialect
): ColumnSpec[] {
  return names.map((name, i) => ({
    name,
    dataType: inferType(rows, i, dialect).dataType,
    nullable: true,
    default: null,
    autoIncrement: false,
    comment: null,
    collation: null,
    onUpdate: null,
    check: null,
    generated: null,
  }))
}
