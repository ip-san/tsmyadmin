import type { Cell, ColumnDef, WriteCell } from '@tsmyadmin/shared'
import { isGeneratedColumn, ROW_FUNCTIONS_WITH_ARG } from '@tsmyadmin/shared'
import { cellToEditable, isOpaqueCell } from '@/lib/format.ts'
import type { FieldState } from './RowField.tsx'

/** The server supplies the value: a key column with a sequence, or a column computed from the others. */
export function isGenerated(c: ColumnDef): boolean {
  return c.extra.includes('auto_increment') || c.extra.includes('identity') || c.extra === 'serial' || computed(c)
}

/** Stronger than `isGenerated`: the server refuses a value for these at all, so they never enter the payload. */
export function computed(c: ColumnDef): boolean {
  return isGeneratedColumn(c.extra)
}

export function initialField(c: ColumnDef, mode: 'insert' | 'edit', initial?: Record<string, Cell>): FieldState {
  const cell = initial?.[c.name] ?? null
  const hasDefault = c.default !== null || isGenerated(c)
  const blank = { fn: '' as const, file: null }
  // Duplicating a row: keep every value except generated keys, which must get a fresh value. A value the page
  // does not hold whole (binary, cut text) cannot be copied: the column falls back to its default or NULL.
  if (mode === 'insert' && initial !== undefined) {
    if (isOpaqueCell(cell)) return { ...blank, text: '', isNull: c.nullable && !hasDefault, useDefault: hasDefault }
    return { ...blank, text: cellToEditable(cell), isNull: cell === null, useDefault: isGenerated(c) }
  }
  return {
    ...blank,
    text: cellToEditable(cell),
    isNull: mode === 'edit' ? cell === null : c.nullable && !hasDefault,
    useDefault: mode === 'insert' && hasDefault,
  }
}

export type RowState = Record<string, FieldState>

export function initialState(columns: ColumnDef[], mode: 'insert' | 'edit', initial?: Record<string, Cell>): RowState {
  const out: RowState = {}
  for (const c of columns) out[c.name] = initialField(c, mode, initial)
  return out
}

/** A field as the value to write, or undefined when it is not written (default, generated, unchanged). */
export function writtenValue(
  c: ColumnDef,
  f: FieldState,
  mode: 'insert' | 'edit',
  original: Cell
): WriteCell | undefined {
  // A generated column rejects any value, including NULL (MySQL ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN).
  if (computed(c) || f.useDefault) return undefined
  if (f.isNull) return mode === 'edit' && original === null ? undefined : null
  if (f.fn !== '') return ROW_FUNCTIONS_WITH_ARG.has(f.fn) ? { $fn: f.fn, arg: f.text } : { $fn: f.fn }
  if (f.file) return { $bin: f.file.base64 }
  // Editing keeps an opaque value untouched (it cannot be shown whole); duplicating sends whatever was typed.
  if (mode === 'edit' && isOpaqueCell(original)) return undefined
  if (mode === 'edit' && !changed(original, f.text)) return undefined
  return f.text
}

function changed(original: Cell, next: string): boolean {
  if (original === null) return true
  if (isOpaqueCell(original)) return true
  return String(original) !== next
}
