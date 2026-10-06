import type { FieldPacket, ResultSetHeader } from 'mysql2/promise'
import type { RawResult } from '../driver.ts'
import { driverValueToCell, type QueryOptions } from '../sql/cells.ts'
import { mysqlColumnMeta } from './values.ts'

function isHeader(v: unknown): v is ResultSetHeader {
  return typeof v === 'object' && v !== null && 'affectedRows' in v
}

/** What the driver answered, as the adapter's own result: rows already converted to wire cells. */
export function normalise(
  rowsOut: unknown,
  fields: FieldPacket[] | FieldPacket[][] | undefined,
  options?: QueryOptions
): RawResult | RawResult[] {
  if (isHeader(rowsOut)) return { columns: [], rows: [], affectedRows: rowsOut.affectedRows, hasRows: false }
  const rows = rowsOut as unknown[]
  const multi = Array.isArray(fields) && Array.isArray(fields[0])
  if (multi) {
    const sets = fields as FieldPacket[][]
    const out: RawResult[] = []
    for (let i = 0; i < rows.length; i++) {
      const part = rows[i]
      const partFields = sets[i]
      if (isHeader(part) || !partFields) {
        if (isHeader(part)) out.push({ columns: [], rows: [], affectedRows: part.affectedRows, hasRows: false })
        continue
      }
      out.push({
        columns: partFields.map(mysqlColumnMeta),
        rows: (part as unknown[][]).map((r) => r.map((v) => driverValueToCell(v, options))),
        affectedRows: 0,
        hasRows: true,
      })
    }
    return out
  }
  const single = (fields ?? []) as FieldPacket[]
  return {
    columns: single.map(mysqlColumnMeta),
    rows: (rows as unknown[][]).map((r) => r.map((v) => driverValueToCell(v, options))),
    affectedRows: 0,
    hasRows: true,
  }
}
