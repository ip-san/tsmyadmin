import type { Cell, ColumnDef, Dialect } from '@tsmyadmin/shared'
import { type InferredType, inferType } from '@tsmyadmin/shared'

export interface TypeProposal {
  column: string
  from: string
  to: string
  kind: InferredType
}

/** A column that holds text, whatever the length: the only kind whose values can say it should have been a number. */
const TEXTUAL =
  /^(?:(?:national |nchar |character )?varying|n?var(?:char|character)|n?char(?:acter)?|(?:tiny|medium|long)?text)\b/i

/** What a value of a text column looks like once read back: text or NULL (bytes never suggest a narrower type). */
const asText = (cell: Cell | undefined): string | null | { base64: string } =>
  cell === null || cell === undefined
    ? null
    : typeof cell !== 'object'
      ? String(cell)
      : '$bin' in cell
        ? { base64: cell.$bin }
        : cell.$text

/**
 * A narrower type for each text column whose values all fit one: integers, decimals, dates or date-times. It is the
 * import's own rule (`inferType`), applied to the rows that were read, so it is a suggestion about those rows and no
 * more — a later row that does not fit makes the change fail rather than lose data. Columns with no value, and
 * columns that are keys, generated or auto-numbered, are left alone.
 */
export function proposeTypes(
  columns: readonly ColumnDef[],
  names: readonly string[],
  rows: readonly (readonly Cell[])[],
  dialect: Dialect
): TypeProposal[] {
  return columns.flatMap((c) => {
    const index = names.indexOf(c.name)
    if (index === -1 || !TEXTUAL.test(c.dataType.trim()) || c.generated || c.extra.includes('auto_increment')) return []
    const values = rows.map((r) => [asText(r[index])])
    if (values.every((v) => v[0] === null)) return []
    const inferred = inferType(values, 0, dialect)
    if (inferred.type === 'varchar' || inferred.type === 'text') return []
    return [{ column: c.name, from: c.dataType, to: inferred.dataType, kind: inferred.type }]
  })
}
