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

/** Bytes kept of a binary value when browsing (a longer one arrives cut, with nothing on the wire saying so). */
export const MAX_BINARY_BYTES = 64 * 1024

/** UTF-16 units kept of a text value when browsing / running SQL (exports and catalog reads carry the whole value). */
export const MAX_TEXT_CHARS = 64 * 1024

/** A value the client may send (row values, filters, keys). */
export const InputCellSchema = z.union([z.null(), z.string(), z.number(), z.boolean(), BinaryCellSchema])
export type InputCell = z.infer<typeof InputCellSchema>

/** A value the server may return: any input cell, or a truncated text. */
export const CellSchema = z.union([InputCellSchema, TruncatedTextCellSchema])
export type Cell = z.infer<typeof CellSchema>

/**
 * The functions a value can be written through (phpMyAdmin's "Function" column on the insert / edit form). A
 * closed list: the adapter renders each one per dialect, the name is never taken from the request as SQL, and the
 * argument — for the ones that take the field's value — is bound like any other value.
 */
export const ROW_FUNCTIONS = [
  'now',
  'current_date',
  'current_time',
  'uuid',
  'md5',
  'sha1',
  'sha256',
  'upper',
  'lower',
  'trim',
] as const
export const RowFunctionSchema = z.enum(ROW_FUNCTIONS)
export type RowFunction = z.infer<typeof RowFunctionSchema>

/** The functions a dialect offers: PostgreSQL has no SHA-1 without the pgcrypto extension. */
export function rowFunctionsFor(dialect: 'mysql' | 'postgres'): RowFunction[] {
  return dialect === 'postgres' ? ROW_FUNCTIONS.filter((fn) => fn !== 'sha1') : [...ROW_FUNCTIONS]
}

/** The functions that take the field's value as their argument; the others ignore it. */
export const ROW_FUNCTIONS_WITH_ARG: ReadonlySet<RowFunction> = new Set([
  'md5',
  'sha1',
  'sha256',
  'upper',
  'lower',
  'trim',
])

export const FunctionCellSchema = z.strictObject({
  $fn: RowFunctionSchema,
  arg: z.union([z.string(), z.number(), z.null()]).optional(),
})
export type FunctionCell = z.infer<typeof FunctionCellSchema>

/** A value to write into a row: a plain value, or one computed by an allowed function. */
export const WriteCellSchema = z.union([InputCellSchema, FunctionCellSchema])
export type WriteCell = z.infer<typeof WriteCellSchema>

export function isFunctionCell(cell: unknown): cell is FunctionCell {
  return typeof cell === 'object' && cell !== null && '$fn' in cell
}

/** Values that identify a row (keys, filters): plain values only — a key is matched, never computed. */
export const KeyValuesSchema = z.record(z.string(), InputCellSchema)
export type KeyValues = z.infer<typeof KeyValuesSchema>

export const RowValuesSchema = z.record(z.string(), WriteCellSchema)
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
