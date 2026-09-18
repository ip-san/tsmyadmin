import type { BrowseResult } from '@tsmyadmin/shared'
import { type RefObject, useEffect, useRef } from 'react'
import { othersOf } from './row-key.ts'

/** An inline-saved row (its other columns' values), until the refetched rows are committed and its fate is known. */
export interface SettlingCell {
  index: number
  col: number
  column: string
  others: string
}

/**
 * Where focus goes after an inline edit, once the refetched rows are committed: back to the edited cell, or to
 * the row it moved to, or — when it left the page — to the notice. The caller sets the returned ref on save.
 */
export function useSettleFocus(
  data: BrowseResult | undefined,
  fetching: boolean,
  gridRef: RefObject<HTMLTableElement | null>,
  noticeRef: RefObject<HTMLOutputElement | null>
): RefObject<SettlingCell | null> {
  const settleFocus = useRef<SettlingCell | null>(null)
  useEffect(() => {
    const saved = settleFocus.current
    if (!saved || fetching) return
    settleFocus.current = null
    // Rows are keyed by index: the cell may still exist but now belong to another row (the edited one left a
    // filtered result set), so the row at that index is compared on every column but the edited one (a row key
    // would change with the edit on all-columns / ctid tables, or when a key column was edited).
    const row = data?.rows[saved.index]
    const stillThere = data !== undefined && row !== undefined && othersOf(data, row, saved.column) === saved.others
    if (stillThere && gridRef.current?.contains(document.activeElement)) return
    // The row may have re-sorted (a key column edited, a new ctid): follow it when exactly one row matches.
    const matches = data
      ? data.rows.flatMap((r, i) => (othersOf(data, r, saved.column) === saved.others ? [i] : []))
      : []
    const moved = matches.length === 1 ? matches[0] : undefined
    const cell =
      moved === undefined ? null : gridRef.current?.querySelector<HTMLElement>(`[data-cell="${moved},${saved.col}"]`)
    if (cell) cell.focus({ preventScroll: true })
    else noticeRef.current?.focus({ preventScroll: true })
  }, [data, fetching])
  return settleFocus
}
