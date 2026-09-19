import type { DatabaseAdapter } from '@tsmyadmin/adapter'
import { AdapterError, type Statement, setAssignments, splitStatements, stripLeadingComments } from '@tsmyadmin/adapter'
import type {
  ImportError,
  ImportForm,
  ImportReason,
  ImportResult,
  ImportWarning,
  InputCell,
  Namespace,
  StatementResult,
} from '@tsmyadmin/shared'
import { CsvParseError, isBinaryDataType, isGeneratedColumn, parseCsvRecords } from '@tsmyadmin/shared'
import { columnNames, inferColumns } from './import-create.ts'
import type { RowCell } from './import-rows.ts'

const MAX_ERRORS = 20
const SQL_IMPORT_TIMEOUT_MS = 10 * 60 * 1000
/** Progress is reported at most this often (statements) so a 100k-statement file does not flood the stream. */
const PROGRESS_EVERY = 100

/** Thrown for user-fixable input problems (mapped to 400 VALIDATION by the route; the client localises `reason`). */
export class ImportValidationError extends Error {
  readonly reason: ImportReason
  readonly params: Record<string, string | number>
  constructor(reason: ImportReason, message: string, params: Record<string, string | number> = {}) {
    super(message)
    this.name = 'ImportValidationError'
    this.reason = reason
    this.params = params
  }
}

/**
 * The bytes of an upload as text. Anything that is not valid UTF-8 is refused: decoding it with replacement
 * characters would silently corrupt binary literals (mysqldump without --hex-blob) and non-UTF-8 text.
 */
export function decodeUpload(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Locate the first offending byte for the message: the lenient decoder marks it with U+FFFD.
    const lenient = new TextDecoder('utf-8').decode(bytes)
    const at = lenient.indexOf('�')
    const line = at < 0 ? 1 : lenient.slice(0, at).split('\n').length
    throw new ImportValidationError('INVALID_ENCODING', `The file is not valid UTF-8 (near line ${line})`, { line })
  }
}

/** Dump headers that name a dialect: tsmyadmin's own, mysqldump / mariadb-dump, pg_dump. */
const DIALECT_HEADERS: { pattern: RegExp; dialect: 'mysql' | 'postgres' }[] = [
  { pattern: /^-- Dialect: mysql\b/m, dialect: 'mysql' },
  { pattern: /^-- Dialect: postgres\b/m, dialect: 'postgres' },
  { pattern: /^-- (?:MySQL|MariaDB) dump\b/m, dialect: 'mysql' },
  { pattern: /^-- PostgreSQL database dump\b/m, dialect: 'postgres' },
]
/** A mysqldump `/*!40000 ALTER TABLE … *\/` versioned comment: the statement inside runs on MySQL. */
const VERSION_COMMENT = /^\/\*!\d*\s*([\s\S]*?)\s*\*\/$/
/** Statements that move the run to another database (or remove one): the result is flagged. */
const CHANGES_DATABASE = /^(?:USE\s|\\connect\b|\\c\s|CREATE\s+DATABASE\b|DROP\s+DATABASE\b)/i
const OPENS_TRANSACTION = /^(?:BEGIN\b|START\s+TRANSACTION\b)/i
const CLOSES_TRANSACTION = /^(?:COMMIT\b|ROLLBACK\b|END\b)/i
/**
 * MySQL statements that commit the open transaction implicitly (DDL, account statements, LOCK TABLES,
 * `SET autocommit = 1`); temporary tables are the documented exception.
 */
const IMPLICIT_COMMIT =
  /^(?:(?:CREATE|DROP)\s+(?!TEMPORARY\b)|ALTER|TRUNCATE|RENAME|GRANT|REVOKE|LOCK\s+TABLES|UNLOCK\s+TABLES|SET\s+PASSWORD|FLUSH|ANALYZE|OPTIMIZE|REPAIR|CHECK\s+TABLE|LOAD\s+DATA)\b/i
/** The server's own "interrupted by a cancel" errors: MySQL KILL QUERY, PostgreSQL pg_cancel_backend. */
const CANCEL_CODES = new Set(['ER_QUERY_INTERRUPTED', '57014'])
const code = (sql: string, dialect: 'mysql' | 'postgres') => {
  const plain = stripLeadingComments(sql, dialect)
  return VERSION_COMMENT.exec(plain)?.[1] ?? plain
}

export interface ImportSqlOptions {
  stopOnError: boolean
  ignoreForeignKeys: boolean
  singleTransaction: boolean
  /** MySQL: a 0 in an AUTO_INCREMENT column stays 0 (the session's sql_mode gets NO_AUTO_VALUE_ON_ZERO). */
  noAutoValueOnZero?: boolean
  /** Statements at the start of the file to leave out (to go on where an earlier run stopped). */
  skip?: number
  /** Registered with the adapter so a client that goes away can interrupt the run. */
  queryId: string
  onProgress?: (done: number, total: number) => void | Promise<void>
}

export async function importSql(
  adapter: DatabaseAdapter,
  ns: Namespace,
  text: string,
  options: ImportSqlOptions
): Promise<ImportResult> {
  const started = performance.now()
  const header = text.slice(0, 4096)
  const claimed = DIALECT_HEADERS.find((h) => h.pattern.test(header))?.dialect
  if (claimed && claimed !== adapter.dialect) {
    throw new ImportValidationError(
      'WRONG_DIALECT',
      `This file is a ${claimed} dump; the connection is ${adapter.dialect}`,
      {
        dialect: claimed,
      }
    )
  }
  const script = wrapScript(text, adapter.dialect, options)
  const { prefix, total } = script
  // Whether a transaction is still open when the script ends is the server's to answer, not a regex's.
  let openTransaction = false
  const results = await adapter.executeSql(ns, script.text, {
    statements: script.statements,
    onTransactionOpen: (open) => {
      openTransaction = open
    },
    maxRows: 1,
    timeoutMs: SQL_IMPORT_TIMEOUT_MS,
    // Single-transaction mode stops at the first error by definition (the rest could not commit anyway).
    stopOnError: options.stopOnError || options.singleTransaction,
    queryId: options.queryId,
    auditLabel: 'import',
    onResult: async (r, index) => {
      // An option the server refused (session_replication_role needs superuser) must stop the run before the
      // user's first statement: throwing here ends executeSql, which resets the connection.
      if (index < prefix.length && r.kind === 'error') {
        const option = script.prefixOptions[index] ?? 'singleTransaction'
        throw new ImportValidationError('OPTION_FAILED', `Import option could not be applied: ${r.message}`, {
          option,
          message: r.message,
        })
      }
      // Statements, not result sets: a CALL returning several sets is still one statement done.
      const done = Math.max(0, (r.statement ?? index) + 1 - prefix.length)
      if (done % PROGRESS_EVERY === 0 || done === total) await options.onProgress?.(Math.min(done, total), total)
    },
  })
  const run = summariseRun(results, script)
  const warnings = runWarnings(run, adapter.dialect, options, openTransaction)
  return {
    format: 'sql',
    total,
    statements: run.ran.size,
    succeeded: run.ran.size - run.failed.size,
    failed: run.failed.size + (run.commit?.kind === 'error' ? 1 : 0),
    errors: run.errors,
    warnings,
    durationMs: Math.round(performance.now() - started),
  }
}

/** The uploaded file wrapped in the option statements, split once, with the wrapper's place in the script. */
interface WrappedScript {
  text: string
  statements: Statement[]
  /** Option statements that run before the file (FK checks off, BEGIN). */
  prefix: string[]
  /** The option each of them belongs to, for the message when the server refuses one. */
  prefixOptions: string[]
  /** The file's own statement count. */
  total: number
  /** Index of the wrapper COMMIT among `statements`, or -1 without one. */
  commitIndex: number
}

function wrapScript(text: string, dialect: 'mysql' | 'postgres', options: ImportSqlOptions): WrappedScript {
  const splitState: { delimiter?: string; unterminated?: boolean } = {}
  // The first `skip` statements are read and left out: to go on where an earlier run stopped.
  const own = splitStatements(text, dialect, splitState).slice(options.skip ?? 0)
  const total = own.length
  if (total === 0) throw new ImportValidationError('NO_STATEMENTS', 'No SQL statements were found in the file')
  // Wrapping statements are the adapter builders' business (see SqlExporter); a plain pre/postamble is enough here.
  const optionStatements: { option: string; sql: string }[] = [
    ...(options.noAutoValueOnZero && dialect === 'mysql'
      ? [
          {
            option: 'noAutoValueOnZero',
            sql: "SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'NO_AUTO_VALUE_ON_ZERO')",
          },
        ]
      : []),
    ...(options.ignoreForeignKeys
      ? [
          {
            option: 'ignoreForeignKeys',
            sql: dialect === 'mysql' ? 'SET FOREIGN_KEY_CHECKS = 0' : 'SET session_replication_role = replica',
          },
        ]
      : []),
    ...(options.singleTransaction
      ? [{ option: 'singleTransaction', sql: dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN' }]
      : []),
  ]
  const prefix = optionStatements.map((o) => o.sql)
  const suffix = options.singleTransaction ? ['COMMIT'] : []
  // A file whose last statement has no terminator must not merge it with the COMMIT: the delimiter in force at
  // the end is appended (the splitter drops the empty chunk it leaves otherwise). A MySQL file that ends under its
  // own DELIMITER gets the default restored afterwards, so the wrapper's COMMIT is read as usual.
  const delimiter = dialect === 'mysql' ? (splitState.delimiter ?? ';') : ';'
  const terminator = delimiter === ';' ? '\n;' : `\n${delimiter}\nDELIMITER ;`
  const script = [...prefix.map((s) => `${s};`), `${text}${terminator}`, ...suffix.map((s) => `\n${s};`)].join('\n')
  // A file that ends inside an unterminated comment or literal would swallow the terminator and the wrapper's
  // COMMIT: the whole run would silently roll back at the end, so it is refused.
  if (suffix.length > 0 && splitState.unterminated)
    throw new ImportValidationError(
      'UNTERMINATED_END',
      'The file ends inside an unterminated comment or string literal: nothing could be committed'
    )
  // The file was split once above; the wrapper statements are added around it (their lines match `script`) so the
  // adapter does not tokenise a 64 MB upload a second time.
  const commitLine = script.split('\n').length
  const statements: Statement[] = [
    ...prefix.map((sql, k) => ({ sql, line: k + 1 })),
    ...own.map((st) => ({ sql: st.sql, line: st.line + prefix.length })),
    ...suffix.map((sql) => ({ sql, line: commitLine })),
  ]
  return {
    text: script,
    statements,
    prefix,
    prefixOptions: optionStatements.map((o) => o.option),
    total,
    commitIndex: suffix.length > 0 ? prefix.length + total : -1,
  }
}

/** The file's results, told apart from the wrapper's, counted in statements. */
interface RunSummary {
  /** The file's own results with their statement index (0-based within the file), in order. */
  own: { r: StatementResult; index: number }[]
  /** Statement indices that produced a result / an error. */
  ran: Set<number>
  failed: Set<number>
  /** The first MAX_ERRORS errors, plus a failing wrapper COMMIT. */
  errors: ImportError[]
  commit: StatementResult | undefined
  total: number
}

function summariseRun(results: StatementResult[], script: WrappedScript): RunSummary {
  const { prefix, total, commitIndex } = script
  // Every result carries its statement's index (the several result sets of a CALL share one), which tells the
  // wrapper statements apart and keeps the counts in statements; results without it (test doubles) are taken one
  // per statement, in order. One pass: a dump of hundreds of thousands of single-row INSERTs must not cost a
  // quadratic post-processing, nor an error entry per failed statement when only the first MAX_ERRORS are shown.
  const own: RunSummary['own'] = []
  const ran = new Set<number>()
  const failed = new Set<number>()
  const errors: ImportError[] = []
  let commit: StatementResult | undefined
  for (const [i, r] of results.entries()) {
    const index = r.statement ?? i
    if (index === commitIndex) {
      commit = r
      continue
    }
    if (index < prefix.length) continue
    const ownIndex = index - prefix.length
    own.push({ r, index: ownIndex })
    ran.add(ownIndex)
    if (r.kind === 'error') {
      failed.add(ownIndex)
      if (errors.length < MAX_ERRORS)
        errors.push({
          sql: r.sql.slice(0, 500),
          message: r.message,
          index: ownIndex,
          ...(r.code ? { code: r.code } : {}),
          ...(r.line ? { line: r.line - prefix.length } : {}),
        })
    }
  }
  // A COMMIT refused by the server (a deferred constraint failing at commit) is the run's error: listed as such.
  if (commit?.kind === 'error')
    errors.push({ sql: 'COMMIT', message: commit.message, index: total, ...(commit.code ? { code: commit.code } : {}) })
  return { own, ran, failed, errors, commit, total }
}

/** What the user must know beyond the counts: a database switch, a cancel, what a rollback undid. */
function runWarnings(
  run: RunSummary,
  dialect: 'mysql' | 'postgres',
  options: ImportSqlOptions,
  openTransaction: boolean
): ImportWarning[] {
  const warnings: ImportWarning[] = []
  const ran = run.own.filter((o) => o.r.kind !== 'error').map((o) => code(o.r.sql, dialect))
  if (ran.some((sql) => CHANGES_DATABASE.test(sql))) warnings.push('CHANGED_DATABASE')
  // Fewer statements than the file holds without an error stopping the run, or a run whose last statement was
  // interrupted by the server: the run was cancelled (the interrupted statement stays in the error list).
  const last = run.own[run.own.length - 1]?.r
  const interrupted = last?.kind === 'error' && CANCEL_CODES.has(last.nativeCode ?? '')
  const stopsOnError = options.stopOnError || options.singleTransaction
  if (interrupted || (run.ran.size < run.total && (last?.kind !== 'error' || !stopsOnError))) warnings.push('CANCELLED')
  if (options.singleTransaction && (run.errors.length > 0 || run.commit?.kind !== 'affected'))
    warnings.push(committedMidway(ran, dialect) ? 'PARTIALLY_ROLLED_BACK' : 'ALL_ROLLED_BACK')
  else if (openTransaction) warnings.push('ROLLED_BACK')
  return warnings
}

/**
 * Whether the script committed by itself inside the single transaction: a COMMIT of its own; on MySQL any DDL, a
 * new START TRANSACTION, or `SET autocommit` turned back on after being off (a value that is not a literal is
 * unknown, and unknown counts as a commit — the safe direction). A nested BEGIN on PostgreSQL is only a warning
 * and commits nothing.
 */
function committedMidway(ran: string[], dialect: 'mysql' | 'postgres'): boolean {
  let committed = false
  let autocommitOff = false
  for (const sql of ran) {
    const settings = setAssignments(sql)
      .filter((a) => a.name === 'autocommit')
      .map((a) => a.value)
    if (settings.length > 0) {
      for (const value of settings) {
        const off = /^(?:0|OFF|FALSE)$/i.test(value)
        const on = /^(?:1|ON|TRUE)$/i.test(value)
        if (!off && (autocommitOff || !on)) committed = true
        autocommitOff = off
      }
    } else if (
      CLOSES_TRANSACTION.test(sql) ||
      (dialect === 'mysql' && (OPENS_TRANSACTION.test(sql) || IMPLICIT_COMMIT.test(sql)))
    )
      committed = true
  }
  return committed
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Rows to load, wherever they came from: the file's own header (if it has one), and the records, in order. */
export interface RowsSource {
  header: string[] | null
  /** Called more than once (a positional import counts the widest row first): each call starts again. */
  records: () => Iterable<{ line: number; cells: RowCell[] }>
  /** The result's format. */
  format: 'csv' | 'ods' | 'xml' | 'mediawiki'
}

/** A CSV file as rows: a value is NULL when it is the marker written without quotes (a quoted one is the text). */
export function csvSource(
  text: string,
  form: Pick<ImportForm, 'delimiter' | 'enclosure' | 'escape' | 'nullMarker'>
): RowsSource {
  const options = { delimiter: form.delimiter, quote: form.enclosure, escape: form.escape }
  return {
    header: null,
    format: 'csv',
    records: function* () {
      for (const r of parseCsvRecords(text, options)) {
        // Blank lines (a common artefact of hand-edited files) carry no row; they are skipped like LOAD DATA does.
        if (r.fields.length === 1 && r.fields[0] === '' && !r.quoted[0]) continue
        yield {
          line: r.line,
          cells: r.fields.map((v, i) => (v === form.nullMarker && !r.quoted[i] ? null : v)),
        }
      }
    },
  }
}

const cellText = (cell: RowCell | undefined): string | null =>
  cell === undefined || cell === null
    ? null
    : typeof cell === 'string'
      ? cell
      : Buffer.from(cell.base64, 'base64').toString('utf8')

/** The rows of a table read from a spreadsheet, XML or wiki file are loaded like a CSV's. */
export async function importCsv(
  adapter: DatabaseAdapter,
  ns: Namespace,
  form: ImportForm,
  text: string
): Promise<ImportResult> {
  return importRows(adapter, ns, form, csvSource(text, form))
}

export async function importRows(
  adapter: DatabaseAdapter,
  ns: Namespace,
  form: ImportForm,
  source: RowsSource
): Promise<ImportResult> {
  const table = form.table
  if (!table) throw new ImportValidationError('CSV_NO_TABLE', 'CSV import requires a target table')
  const started = performance.now()
  // The records, with the first taken as the header when the file has none of its own and one is asked for.
  let first: { line: number; cells: RowCell[] } | undefined
  const iterator = source.records()[Symbol.iterator]()
  let peek = iterator.next()
  if (peek.done) throw new ImportValidationError('CSV_EMPTY', 'The CSV file is empty')
  first = peek.value
  let header: string[] | null = source.header
  let headerConsumed = false
  if (header === null && form.header === '1') {
    header = first.cells.map((c) => (cellText(c) ?? '').trim())
    headerConsumed = true
  } else if (header !== null) headerConsumed = false
  // A file that names its columns itself (XML) needs no header row; one that does not (CSV without a header) is positional.
  let created: { name: string; dataType: string }[] | undefined
  let createdTable = false
  if (form.createTable === '1') {
    if ((await adapter.listTables(ns)).some((t) => t.name === table))
      throw new ImportValidationError('TABLE_EXISTS', `The table ${table} exists already`, { table })
    const rows: RowCell[][] = []
    for (const r of source.records()) rows.push(r.cells)
    const data = headerConsumed ? rows.slice(1) : rows
    const width = Math.max(header?.length ?? 0, ...rows.map((r) => r.length))
    const names = columnNames(header, width)
    const columns = inferColumns(names, data, adapter.dialect)
    const statements = adapter.ddl.build(ns, { op: 'createTable', table, columns, primaryKey: [] })
    const made = await adapter.executeSql(ns, statements.join(';\n'), {
      maxRows: 1,
      timeoutMs: 60_000,
      stopOnError: true,
    })
    const failure = made.find((r) => r.kind === 'error')
    if (failure?.kind === 'error')
      throw new ImportValidationError('CREATE_INVALID_NAME', `The table could not be created: ${failure.message}`, {
        name: table,
      })
    created = columns.map((c) => ({ name: c.name, dataType: c.dataType }))
    createdTable = true
    header = names
  }
  const schema = await adapter.describeTable(ns, table)
  const known = new Map(schema.columns.map((c) => [c.name, c]))
  // MySQL column names are case-insensitive; PostgreSQL's are not, unless the header matches exactly one column.
  const resolve = (name: string): string | undefined => {
    if (known.has(name)) return name
    const hits = schema.columns.filter((c) => c.name.toLowerCase() === name.toLowerCase())
    return hits.length === 1 ? hits[0]?.name : undefined
  }
  const ambiguous = (name: string): boolean =>
    !known.has(name) && schema.columns.filter((c) => c.name.toLowerCase() === name.toLowerCase()).length > 1
  let columns: string[]
  let skippedColumns: string[] = []
  if (header !== null) {
    const names = header
    const resolved = names.map((n) => resolve(n))
    const vague = names.filter((n) => ambiguous(n))
    if (vague.length > 0) {
      throw new ImportValidationError(
        'CSV_AMBIGUOUS_COLUMNS',
        `Header column(s) match several table columns (case differs): ${vague.join(', ')}`,
        { columns: vague.slice(0, 5).join(', ') }
      )
    }
    const duplicates = resolved.filter((c, i) => c !== undefined && resolved.indexOf(c) !== i)
    if (duplicates.length > 0) {
      throw new ImportValidationError(
        'CSV_DUPLICATE_COLUMNS',
        `Header names a column twice: ${duplicates.join(', ')}`,
        {
          columns: [...new Set(duplicates)].slice(0, 5).join(', '),
        }
      )
    }
    const unknown = names.filter((_, i) => resolved[i] === undefined)
    if (unknown.length > 0) {
      // Bounded: a wrong file (a .sql renamed .csv, a binary) would otherwise echo its whole first line back.
      const shown = unknown.slice(0, 5).map((c) => (c === '' ? '(empty)' : c.length > 64 ? `${c.slice(0, 64)}…` : c))
      const more = unknown.length > shown.length ? ` (+${unknown.length - shown.length})` : ''
      throw new ImportValidationError(
        'CSV_UNKNOWN_COLUMNS',
        `Unknown column(s) in header: ${shown.join(', ')}${more}`,
        {
          columns: `${shown.join(', ')}${more}`,
        }
      )
    }
    // Generated columns are the server's to compute: the header may name them (a CSV export does), the INSERT may not.
    columns = resolved.filter((c): c is string => c !== undefined)
    skippedColumns = columns.filter((c) => isGeneratedColumn(known.get(c)?.extra ?? ''))
  } else {
    // Positional: as many table columns as the widest row (a short row is padded with NULL, the rest keep their
    // defaults). Counting the width is a second read, but it holds no rows.
    let width = first.cells.length
    for (const r of source.records()) width = Math.max(width, r.cells.length)
    columns = schema.columns.slice(0, width).map((c) => c.name)
    skippedColumns = columns.filter((c) => isGeneratedColumn(known.get(c)?.extra ?? ''))
  }
  const keep = columns.map((c) => !skippedColumns.includes(c))
  const target = columns.filter((_, j) => keep[j])
  if (target.length === 0) throw new ImportValidationError('CSV_NO_COLUMNS', 'No columns to import')
  // Binary columns are exported as base64 (see csvField) and must come back as binary cells, not as that text.
  const binary = columns.map((c) => {
    const col = known.get(c)
    return col !== undefined && isBinaryDataType(col.dataType, adapter.dialect)
  })
  const overriding = target.some((c) => known.get(c)?.extra === 'identity always')
  const lines: number[] = []
  let skippedRows = 0
  function* rows(): Generator<InputCell[]> {
    let dropHeader = headerConsumed
    let toSkip = form.skip
    // The first record is already taken; the iterator carries on from the second.
    const all = (function* () {
      yield first as { line: number; cells: RowCell[] }
      for (let r = iterator.next(); !r.done; r = iterator.next()) yield r.value
    })()
    for (const r of all) {
      if (dropHeader) {
        dropHeader = false
        continue
      }
      if (toSkip > 0) {
        toSkip--
        skippedRows++
        continue
      }
      if (r.cells.length > columns.length) {
        throw new ImportValidationError(
          'CSV_FIELD_COUNT',
          `Line ${r.line} has ${r.cells.length} fields but ${columns.length} columns`,
          { line: r.line, fields: r.cells.length, columns: columns.length }
        )
      }
      const cells: InputCell[] = []
      columns.forEach((name, j) => {
        if (!keep[j]) return
        const v = r.cells[j]
        if (v === undefined || v === null) cells.push(null)
        else if (typeof v !== 'string') {
          // Bytes from an XML export: a binary column takes them, any other column takes their text.
          if (binary[j]) cells.push({ $bin: v.base64 })
          else cells.push(Buffer.from(v.base64, 'base64').toString('utf8'))
        } else if (!binary[j]) cells.push(v)
        else if (BASE64.test(v)) cells.push({ $bin: v })
        else {
          throw new ImportValidationError('CSV_BINARY', `Line ${r.line}: column ${name} expects base64 binary data`, {
            line: r.line,
            column: name,
          })
        }
      })
      lines.push(r.line)
      yield cells
    }
  }
  peek = { done: false, value: first }
  let result: { affectedRows: number }
  try {
    result = await adapter.insertRows(ns, table, target, rows(), {
      overriding,
      ...(form.onDuplicate !== 'error' ? { onDuplicate: form.onDuplicate, keyColumns: schema.primaryKey } : {}),
    })
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new ImportValidationError('CSV_UNTERMINATED_QUOTE', err.message, { line: err.line })
    }
    if (err instanceof AdapterError && err.rows) {
      const [from, to] = err.rows
      const message = err.detail ?? err.message
      if (from === to) {
        throw new ImportValidationError('CSV_ROW_FAILED', `Line ${lines[from] ?? from + 1}: ${message}`, {
          line: lines[from] ?? from + 1,
          message,
        })
      }
      throw new ImportValidationError(
        'CSV_ROWS_FAILED',
        `Lines ${lines[from] ?? from + 1}–${lines[to] ?? to + 1}: ${message}`,
        { from: lines[from] ?? from + 1, to: lines[to] ?? to + 1, message }
      )
    }
    throw err
  }
  return {
    format: source.format,
    table,
    columns: target,
    skippedColumns,
    inserted: result.affectedRows,
    ...(createdTable ? { created } : {}),
    skipped: skippedRows,
    durationMs: Math.round(performance.now() - started),
  }
}
