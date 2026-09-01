import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, ImportForm, ImportResult, Namespace } from '@tsmyadmin/shared'
import { parseCsv } from '@tsmyadmin/shared'

const MAX_ERRORS = 20
const SQL_IMPORT_TIMEOUT_MS = 10 * 60 * 1000

/** Thrown for user-fixable input problems (mapped to 400 VALIDATION by the route). */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportValidationError'
  }
}

export async function importSql(
  adapter: DatabaseAdapter,
  ns: Namespace,
  text: string,
  stopOnError: boolean
): Promise<ImportResult> {
  const started = performance.now()
  const results = await adapter.executeSql(ns, text, { maxRows: 1, timeoutMs: SQL_IMPORT_TIMEOUT_MS, stopOnError })
  const errors = results.flatMap((r) =>
    r.kind === 'error' ? [{ sql: r.sql.slice(0, 500), message: r.message, ...(r.code ? { code: r.code } : {}) }] : []
  )
  return {
    format: 'sql',
    statements: results.length,
    succeeded: results.length - errors.length,
    failed: errors.length,
    errors: errors.slice(0, MAX_ERRORS),
    durationMs: Math.round(performance.now() - started),
  }
}

export async function importCsv(
  adapter: DatabaseAdapter,
  ns: Namespace,
  form: ImportForm,
  text: string
): Promise<ImportResult> {
  const table = form.table
  if (!table) throw new ImportValidationError('CSV import requires a target table')
  const started = performance.now()
  const parsed = parseCsv(text, { delimiter: form.delimiter })
  if (parsed.length === 0) throw new ImportValidationError('The CSV file is empty')
  const schema = await adapter.describeTable(ns, table)
  const known = new Set(schema.columns.map((c) => c.name))
  let columns: string[]
  let data: string[][]
  if (form.header === '1') {
    columns = (parsed[0] ?? []).map((c) => c.trim())
    data = parsed.slice(1)
    const unknown = columns.filter((c) => !known.has(c))
    if (unknown.length > 0) throw new ImportValidationError(`Unknown column(s) in header: ${unknown.join(', ')}`)
  } else {
    const width = Math.max(...parsed.map((r) => r.length))
    columns = schema.columns.slice(0, width).map((c) => c.name)
    data = parsed
  }
  if (columns.length === 0) throw new ImportValidationError('No columns to import')
  const rows: Cell[][] = data.map((r, i) => {
    if (r.length > columns.length)
      throw new ImportValidationError(`Row ${i + 1} has ${r.length} fields but ${columns.length} columns`)
    return columns.map((_, j) => {
      const v = r[j]
      return v === undefined || v === form.nullMarker ? null : v
    })
  })
  const result = await adapter.insertRows(ns, table, columns, rows)
  return {
    format: 'csv',
    table,
    columns,
    inserted: result.affectedRows,
    durationMs: Math.round(performance.now() - started),
  }
}
