import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell } from '@tsmyadmin/shared'

/** One tab-separated field: quoted, CSV-style, only when a tab, line break or quote would break the grid. */
function tsvField(cell: Cell): string {
  // Callers refuse cut values first, as the download does: a paste must not look complete when it is not.
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be copied')
  const text = cell === null ? 'NULL' : isBinaryCell(cell) ? cell.$bin : String(cell)
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * A result set as tab-separated text with a header row — what a spreadsheet splits into cells when pasted. NULL
 * is written as the word NULL (an empty cell would read as an empty string), binary as base64.
 */
export function toTsv(columns: readonly string[], rows: readonly Cell[][]): string {
  return [columns.map(tsvField).join('\t'), ...rows.map((row) => row.map(tsvField).join('\t'))].join('\n')
}

/**
 * Puts text on the clipboard. The Clipboard API exists only in a secure context (HTTPS or localhost), and
 * tsmyadmin may be served over plain HTTP on a closed network; there the older copy command is tried instead.
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  const focused = document.activeElement
  area.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy command refused')
  } finally {
    area.remove()
    if (focused instanceof HTMLElement) focused.focus()
  }
}
