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

/**
 * Text cut to the display limit (`$text` holds the first MAX_TEXT_CHARS characters, `length` the full count).
 * Only ever produced by the server for display: never accepted as a value to write.
 */
export const TruncatedTextCellSchema = z.strictObject({ $text: z.string(), length: z.number().int().min(0) })
export type TruncatedTextCell = z.infer<typeof TruncatedTextCellSchema>

/** UTF-16 units kept of a text value when browsing / running SQL (exports and catalog reads carry the whole value). */
export const MAX_TEXT_CHARS = 64 * 1024

/** A value the client may send (row values, filters, keys). */
export const InputCellSchema = z.union([z.null(), z.string(), z.number(), z.boolean(), BinaryCellSchema])
export type InputCell = z.infer<typeof InputCellSchema>

/** A value the server may return: any input cell, or a truncated text. */
export const CellSchema = z.union([InputCellSchema, TruncatedTextCellSchema])
export type Cell = z.infer<typeof CellSchema>

export const RowValuesSchema = z.record(z.string(), InputCellSchema)
export type RowValues = z.infer<typeof RowValuesSchema>

export function isBinaryCell(cell: Cell): cell is BinaryCell {
  return typeof cell === 'object' && cell !== null && '$bin' in cell
}

export function isTruncatedCell(cell: Cell): cell is TruncatedTextCell {
  return typeof cell === 'object' && cell !== null && '$text' in cell
}

/** Whether a cell can be sent back as a value (a truncated text would write a cut value). */
export function isInputCell(cell: Cell): cell is InputCell {
  return !isTruncatedCell(cell)
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
