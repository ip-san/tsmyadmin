import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell, isTruncatedCell, neutraliseFormula } from '@tsmyadmin/shared'

/** One tab-separated field: quoted, CSV-style, only when a tab, line break or quote would break the grid. */
function tsvField(cell: Cell, neutralise: boolean): string {
  // Callers refuse cut values first, as the download does: a paste must not look complete when it is not.
  if (isTruncatedCell(cell)) throw new Error('truncated text cannot be copied')
  const raw = cell === null ? 'NULL' : isBinaryCell(cell) ? cell.$bin : String(cell)
  const text = neutralise ? neutraliseFormula(raw) : raw
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * A result set as tab-separated text with a header row — what a spreadsheet splits into cells when pasted. NULL
 * is written as the word NULL (an empty cell would read as an empty string), binary as base64. `neutralise` is the
 * same opt-in as the CSV download's: values a spreadsheet would run as formulas get a leading apostrophe.
 */
export function toTsv(columns: readonly string[], rows: readonly Cell[][], neutralise = false): string {
  const line = (cells: readonly Cell[]) => cells.map((c) => tsvField(c, neutralise)).join('\t')
  return [line(columns), ...rows.map(line)].join('\n')
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
