import { z } from 'zod'

/**
 * Wire format for a single value.
 * - number: only when losslessly representable in JS (INT, FLOAT, DOUBLE, and BIGINT within Number.MAX_SAFE_INTEGER —
 *   both dialects apply the same safe-integer rule, so `COUNT(*)` is a number and 2^63-1 is a string)
 * - string: everything else (BIGINT beyond the safe range, DECIMAL, dates, JSON text, ENUM, arrays...)
 * - { $bin }: binary as base64 (BLOB, bytea, BIT)
 */
export const BinaryCellSchema = z.strictObject({ $bin: z.string() })
export type BinaryCell = z.infer<typeof BinaryCellSchema>

export const CellSchema = z.union([z.null(), z.string(), z.number(), z.boolean(), BinaryCellSchema])
export type Cell = z.infer<typeof CellSchema>

export const RowValuesSchema = z.record(z.string(), CellSchema)
export type RowValues = z.infer<typeof RowValuesSchema>

export function isBinaryCell(cell: Cell): cell is BinaryCell {
  return typeof cell === 'object' && cell !== null && '$bin' in cell
}

/**
 * Whether a column of this declared type carries `{ $bin }` cells on the wire (so a CSV import must decode its
 * base64 text). MySQL BIT is binary; PostgreSQL bit / varbit arrive as '0101' text and stay text.
 */
export function isBinaryDataType(dataType: string, dialect: 'mysql' | 'postgres'): boolean {
  return dialect === 'mysql'
    ? /^(?:(?:tiny|medium|long)?blob|(?:var)?binary\b|bit\b)/i.test(dataType)
    : /^bytea$/i.test(dataType)
}
