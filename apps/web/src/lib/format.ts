import { type Cell, isBinaryCell } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import { ApiError } from './api.ts'

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

/** Codes whose Japanese text says everything; the server's English message would only repeat it. */
const SELF_EXPLANATORY = new Set<string>([
  'INTERNAL',
  'AUTH_FAILED',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'NETWORK',
  'HOST_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
])

export function errorMessage(err: unknown): string {
  // fetch() itself failed: the server is unreachable, not broken.
  if (err instanceof ApiError && err.status === 0) return locale.errors.NETWORK
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    const code = err.code as keyof typeof locale.errors
    const base = locale.errors[code] ?? locale.errors.INTERNAL
    const message = 'message' in err && typeof err.message === 'string' ? err.message : ''
    // A DB-native message (QUERY_FAILED, …) is kept verbatim: DBAs want it. Generic codes drop the English echo,
    // except the bare status of a non-JSON upstream reply (`HTTP 502` from a proxy), which is the only clue.
    const detail =
      'detail' in err && typeof err.detail === 'string'
        ? err.detail
        : !SELF_EXPLANATORY.has(code) || /^HTTP \d{3}$/.test(message)
          ? message
          : ''
    const native = 'nativeCode' in err && typeof err.nativeCode === 'string' ? ` [${err.nativeCode}]` : ''
    return detail ? `${base}: ${detail}${native}` : `${base}${native}`
  }
  return err instanceof Error ? err.message : String(err)
}
