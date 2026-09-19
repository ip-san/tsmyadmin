import type { Cell, Dialect, RowKey } from '@tsmyadmin/shared'
import { createContext, useContext } from 'react'
import { z } from 'zod'
import { readPreference, writePreference } from '@/lib/preferences.ts'

/** How the browse grid shows values: phpMyAdmin's "Options" above the rows (full texts, binary, geometry). */
const CellDisplaySchema = z.object({
  fullText: z.boolean().default(false),
  fkDisplay: z.boolean().default(false),
  binaryAsHex: z.boolean().default(false),
  geometryAsWkt: z.boolean().default(false),
})
export type CellDisplay = z.infer<typeof CellDisplaySchema>

const DEFAULT: CellDisplay = { fullText: false, fkDisplay: false, binaryAsHex: false, geometryAsWkt: false }
const PREF = 'browse.display'

/** The browser's remembered choice; the defaults when there is none or it does not read. */
export function preferredCellDisplay(): CellDisplay {
  return readPreference(PREF, CellDisplaySchema, DEFAULT)
}
export function rememberCellDisplay(d: CellDisplay): void {
  writePreference(PREF, d)
}

/** The current choice, and (where the grid offers the options) a way to change it and the session's dialect. */
export const CellDisplayContext = createContext<{
  display: CellDisplay
  setDisplay?: (d: CellDisplay) => void
  dialect?: Dialect
  /** URL downloading one value whole, where the grid can address its rows. */
  downloadUrl?: (key: RowKey, column: string) => string
  /** The referenced row's display value beside a foreign key value, when that option is on. */
  fkLabel?: (column: string, value: Cell) => string | undefined
}>({ display: DEFAULT })
export const useCellDisplay = () => useContext(CellDisplayContext)
