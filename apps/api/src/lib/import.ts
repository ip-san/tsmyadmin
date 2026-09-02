import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import type { Cell, ImportForm, ImportResult, Namespace } from '@tsmyadmin/shared'
import { isBinaryDataType, parseCsvDocument } from '@tsmyadmin/shared'

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

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export async function importCsv(
  adapter: DatabaseAdapter,
  ns: Namespace,
  form: ImportForm,
  text: string
): Promise<ImportResult> {
  const table = form.table
  if (!table) throw new ImportValidationError('CSV import requires a target table')
  const started = performance.now()
  const doc = parseCsvDocument(text, { delimiter: form.delimiter })
  // Blank lines (a common artefact of hand-edited files) carry no row; they are skipped like LOAD DATA does.
  const lines = doc.rows.map((r, i) => ({ fields: r, quoted: doc.quoted[i] ?? [], line: i + 1 }))
  const parsed = lines.filter((l) => !(l.fields.length === 1 && l.fields[0] === '' && !l.quoted[0]))
  if (parsed.length === 0) throw new ImportValidationError('The CSV file is empty')
  const schema = await adapter.describeTable(ns, table)
  const known = new Map(schema.columns.map((c) => [c.name, c]))
  let columns: string[]
  let data: typeof parsed
  if (form.header === '1') {
    columns = (parsed[0]?.fields ?? []).map((c) => c.trim())
    data = parsed.slice(1)
    const unknown = columns.filter((c) => !known.has(c))
    if (unknown.length > 0) throw new ImportValidationError(`Unknown column(s) in header: ${unknown.join(', ')}`)
  } else {
    // reduce, not spread: a 64 MB CSV can exceed the argument limit of Math.max(...)
    const width = parsed.reduce((m, r) => Math.max(m, r.fields.length), 0)
    columns = schema.columns.slice(0, width).map((c) => c.name)
    data = parsed
  }
  if (columns.length === 0) throw new ImportValidationError('No columns to import')
  // Binary columns are exported as base64 (see csvField) and must come back as binary cells, not as that text.
  const binary = columns.map((c) => {
    const col = known.get(c)
    return col !== undefined && isBinaryDataType(col.dataType, adapter.dialect)
  })
  const rows: Cell[][] = data.map((r) => {
    if (r.fields.length > columns.length)
      throw new ImportValidationError(`Line ${r.line} has ${r.fields.length} fields but ${columns.length} columns`)
    return columns.map((name, j) => {
      const v = r.fields[j]
      // Only an unquoted marker means NULL: a quoted one is the literal text (COPY / LOAD DATA semantics).
      if (v === undefined || (v === form.nullMarker && !r.quoted[j])) return null
      if (!binary[j]) return v
      if (!BASE64.test(v)) throw new ImportValidationError(`Line ${r.line}: column ${name} expects base64 binary data`)
      return { $bin: v }
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
