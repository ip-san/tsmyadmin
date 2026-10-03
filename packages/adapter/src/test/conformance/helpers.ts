import { type Cell, type ColumnSpec, type InputCell, isInputCell } from '@tsmyadmin/shared'
import { type ExecuteOptions } from '../../types.ts'

/** A browsed value handed back as a key / filter value (fails loudly if the server cut it). */
export function input(cell: Cell | undefined): InputCell {
  if (cell === undefined || !isInputCell(cell)) throw new Error('not a writable cell')
  return cell
}

export const EXEC: ExecuteOptions = { maxRows: 1000, timeoutMs: 10_000, stopOnError: true }

export function byName(columns: { name: string }[], row: Cell[]): Record<string, Cell> {
  const out: Record<string, Cell> = {}
  columns.forEach((c, i) => {
    out[c.name] = row[i] ?? null
  })
  return out
}

export function col(name: string, dataType: string, extra: Partial<ColumnSpec> = {}): ColumnSpec {
  return {
    name,
    dataType,
    nullable: true,
    default: null,
    autoIncrement: false,
    comment: null,
    collation: null,
    onUpdate: null,
    check: null,
    generated: null,
    ...extra,
  }
}
