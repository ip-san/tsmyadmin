import { type Cell, isBinaryCell } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'

export type CellDisplay =
  | { kind: 'null' }
  | { kind: 'binary'; bytes: number }
  | { kind: 'text'; text: string; empty: boolean }

/** How a wire Cell should be rendered. */
export function describeCell(cell: Cell): CellDisplay {
  if (cell === null) return { kind: 'null' }
  if (isBinaryCell(cell))
    return {
      kind: 'binary',
      bytes: Math.floor((cell.$bin.length * 3) / 4) - (cell.$bin.endsWith('==') ? 2 : cell.$bin.endsWith('=') ? 1 : 0),
    }
  const text = typeof cell === 'string' ? cell : String(cell)
  return { kind: 'text', text, empty: text.length === 0 }
}

export function cellToText(cell: Cell): string {
  const d = describeCell(cell)
  switch (d.kind) {
    case 'null':
      return locale.common.null
    case 'binary':
      return locale.common.binary(d.bytes)
    case 'text':
      return d.text
  }
}

/** Value to put in an <input> when editing (NULL handled separately). */
export function cellToEditable(cell: Cell): string {
  if (cell === null || isBinaryCell(cell)) return ''
  return typeof cell === 'string' ? cell : String(cell)
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    const code = err.code as keyof typeof locale.errors
    const base = locale.errors[code] ?? locale.errors.INTERNAL
    const detail =
      'detail' in err && typeof err.detail === 'string'
        ? err.detail
        : 'message' in err && typeof err.message === 'string'
          ? err.message
          : ''
    const native = 'nativeCode' in err && typeof err.nativeCode === 'string' ? ` [${err.nativeCode}]` : ''
    return detail ? `${base}: ${detail}${native}` : `${base}${native}`
  }
  return err instanceof Error ? err.message : String(err)
}
