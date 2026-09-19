import type { ExportCharset, ImportFormat } from '@tsmyadmin/shared'

/** Everything the import form lets the user choose besides the file and the target. */
export interface ImportOptions {
  header: boolean
  nullMarker: string
  delimiter: string
  enclosure: string
  escape: string
  charset: ExportCharset
  skip: number
  onDuplicate: 'error' | 'ignore' | 'replace'
  createTable: boolean
  sheet: string
  stopOnError: boolean
  ignoreForeignKeys: boolean
  singleTransaction: boolean
  noAutoValueOnZero: boolean
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  header: true,
  nullMarker: '\\N',
  delimiter: ',',
  enclosure: '"',
  escape: '"',
  charset: 'utf-8',
  skip: 0,
  onDuplicate: 'error',
  createTable: false,
  sheet: '',
  stopOnError: true,
  ignoreForeignKeys: false,
  singleTransaction: false,
  noAutoValueOnZero: false,
}

/** The format a file name suggests (`dump.sql.gz` is read as `dump.sql`), or null. */
export function detectFormat(fileName: string): ImportFormat | null {
  const parts = fileName.toLowerCase().split('.')
  if (parts.length > 2 && parts.at(-1) === 'gz') parts.pop()
  const ext = parts.length > 1 ? parts.at(-1) : undefined
  switch (ext) {
    case 'sql':
      return 'sql'
    case 'csv':
      return 'csv'
    case 'ods':
      return 'ods'
    case 'xml':
      return 'xml'
    case 'wiki':
    case 'mediawiki':
      return 'mediawiki'
    default:
      return null
  }
}

/** Formats that load rows into a table (all but SQL), and so share the target and duplicate-key choices. */
export const isRowsFormat = (f: ImportFormat) => f !== 'sql'

const flag = (on: boolean) => (on ? ('1' as const) : ('0' as const))

/** The form fields the chosen format uses; the others are not sent. */
export function importFields(format: ImportFormat, o: ImportOptions) {
  const common = { charset: o.charset, ...(o.skip > 0 ? { skip: String(o.skip) } : {}) }
  if (format === 'sql') {
    return {
      ...common,
      stopOnError: flag(o.stopOnError),
      ignoreForeignKeys: flag(o.ignoreForeignKeys),
      singleTransaction: flag(o.singleTransaction),
      noAutoValueOnZero: flag(o.noAutoValueOnZero),
    }
  }
  const rows = {
    ...common,
    onDuplicate: o.onDuplicate,
    createTable: flag(o.createTable),
    ...(o.sheet.trim() ? { sheet: o.sheet.trim() } : {}),
  }
  if (format !== 'csv') return rows
  return {
    ...rows,
    header: flag(o.header),
    nullMarker: o.nullMarker,
    delimiter: o.delimiter,
    enclosure: o.enclosure,
    escape: o.escape,
  }
}

/** A CSV's separator and quoting characters are each one character, and the delimiter is never a quote or line break. */
export const csvCharsValid = (o: ImportOptions) =>
  o.delimiter.length === 1 && !'"\r\n'.includes(o.delimiter) && o.enclosure.length === 1 && o.escape.length === 1
