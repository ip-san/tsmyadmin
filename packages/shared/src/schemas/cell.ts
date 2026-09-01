import { z } from 'zod'

/**
 * Wire format for a single value.
 * - number: only when losslessly representable in JS (INT, FLOAT, DOUBLE)
 * - string: everything else (BIGINT, DECIMAL, dates, JSON text, ENUM, arrays...)
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
