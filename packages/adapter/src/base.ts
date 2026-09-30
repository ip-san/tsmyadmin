import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  DatabaseGrant,
  DatabaseInfo,
  DiagnosticKind,
  DiagnosticQuery,
  DiagnosticReport,
  Dialect,
  DistinctValues,
  EventDetail,
  EventInfo,
  Filter,
  InputCell,
  InsertPreview,
  KeyValue,
  Namespace,
  ObjectDependency,
  Partitioning,
  ProcessInfo,
  ProfileStage,
  QueryBuilderCondition,
  QueryBuilderResult,
  QueryBuilderSpec,
  ReferenceCheck,
  RelationDef,
  ReplicationInfo,
  RoutineDetail,
  RoutineInfo,
  RoutineKind,
  RowKey,
  RowKeyKind,
  RowValues,
  SearchOptions,
  ServerCatalog,
  ServerCatalogKind,
  ServerInfo,
  StatementResult,
  TableInfo,
  TableSchema,
  TableSearchResult,
  TableStats,
  TriggerDetail,
  TriggerInfo,
  UserInfo,
  UserRef,
  WriteCell,
} from '@tsmyadmin/shared'
import {
  BROWSE_ALL_MAX,
  DISTINCT_VALUES_LIMIT,
  EXACT_COUNT_MAX_ROWS,
  isFunctionCell,
  isViewKind,
  LIST_OPS,
  MAX_BINARY_BYTES,
} from '@tsmyadmin/shared'
import { type Canceller, type Conn, firstResult } from './driver.ts'
import { bufferToCell, DISPLAY, toDbValue, UNCAPPED } from './sql/cells.ts'
import { joinPlan } from './sql/join-plan.ts'
import { mysqlLiteral, pgLiteral } from './sql/literal.ts'
import { Params, quoteIdent, quoteTable } from './sql/quote.ts'
import { rowFunctionSql } from './sql/row-functions.ts'
import { escapeLike, isSearchableType } from './sql/search.ts'
import { ScriptRunner } from './sql-console.ts'
import {
  AdapterError,
  type DatabaseAdapter,
  type DdlBuilder,
  type ExecuteOptions,
  type InsertRowsOptions,
  type RowBatch,
  type SqlExporter,
  type UserSqlBuilder,
} from './types.ts'

const NO_CODES: ReadonlySet<string> = new Set()

const DEFAULT_TIMEOUT_MS = 30_000

export { MAX_BINARY_BYTES }
/** The largest single value readCell hands over (a download, held in memory while it is sent). */
export const READ_CELL_MAX_BYTES = 64 * 1024 * 1024

/** Operators that match on the text form, where a BIT column is not written as its bytes. */
const TEXT_OPS: ReadonlySet<Filter['op']> = new Set([
  'contains',
  'starts_with',
  'like',
  'not_like',
  'regexp',
  'not_regexp',
])

const FILTER_SQL: Record<Filter['op'], string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  like: 'LIKE',
  not_like: 'NOT LIKE',
  contains: 'LIKE',
  starts_with: 'LIKE',
  is_null: 'IS NULL',
  is_not_null: 'IS NOT NULL',
  in: 'IN',
  not_in: 'NOT IN',
  between: 'BETWEEN',
  not_between: 'NOT BETWEEN',
  regexp: 'REGEXP',
  not_regexp: 'NOT REGEXP',
  empty: '=',
  not_empty: '<>',
}

const BIT_MAX = 2n ** 64n - 1n

/** A MySQL BIT value typed as a whole number, as the hex literal of its bytes (170 → X'AA'). */
function bitLiteral(value: InputCell): string {
  const text = String(value).trim()
  // BIT holds at most 64 bits; a larger number would be clamped to the maximum by MySQL's CONV, not refused.
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > BIT_MAX)
    throw new AdapterError('VALIDATION', 'A BIT value must be a whole number from 0 to 18446744073709551615')
  const hex = BigInt(text).toString(16)
  return `X'${hex.length % 2 === 0 ? hex : `0${hex}`}'`
}

/** Exact COUNT(*) unless the catalog says the table is large (callers pass null when the browse is filtered). */
export function countMode(estimate: number | null, threshold = EXACT_COUNT_MAX_ROWS): 'exact' | 'estimate' {
  return estimate !== null && estimate > threshold ? 'estimate' : 'exact'
}

/** MySQL's error number for a duplicate key. */
const DUPLICATE_ENTRY = 1062
/** Warnings an insert reports back at most (a file with a thousand bad values must not return a thousand lines). */
const MAX_INSERT_WARNINGS = 20

/**
 * Dialect-independent implementation of browsing, row mutation and script execution.
 * Subclasses provide connections, value conversion, introspection and DDL.
 */
export abstract class BaseAdapter implements DatabaseAdapter {
  abstract readonly dialect: Dialect
  abstract readonly ddl: DdlBuilder
  abstract readonly exporter: SqlExporter
  abstract readonly users: UserSqlBuilder

  abstract ping(): Promise<void>
  abstract close(): Promise<void>
  abstract listDatabases(options?: { stats?: boolean }): Promise<DatabaseInfo[]>
  abstract listSchemas(database: string): Promise<string[]>
  abstract listTables(ns: Namespace): Promise<TableInfo[]>
  abstract listForeignKeys(ns: Namespace): Promise<RelationDef[]>
  abstract describeTable(ns: Namespace, table: string): Promise<TableSchema>
  abstract tableStats(ns: Namespace, table: string): Promise<TableStats>
  abstract databaseGrants(database: string): Promise<DatabaseGrant[]>
  abstract listPartitions(ns: Namespace, table: string): Promise<Partitioning>
  abstract listRoutines(ns: Namespace): Promise<RoutineInfo[]>
  abstract routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null>
  abstract routineDetail(
    ns: Namespace,
    name: string,
    kind: RoutineKind,
    parameters?: string
  ): Promise<RoutineDetail | null>
  abstract triggerDetail(ns: Namespace, table: string, name: string): Promise<TriggerDetail | null>
  abstract eventDetail(ns: Namespace, name: string): Promise<EventDetail | null>
  abstract listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]>
  abstract listEvents(ns: Namespace): Promise<EventInfo[]>
  abstract listDependencies(ns: Namespace): Promise<ObjectDependency[] | null>
  abstract readonly serverNamespace: Namespace
  abstract showCreateTable(ns: Namespace, table: string, schema?: TableSchema): Promise<string[]>
  abstract serverInfo(): Promise<ServerInfo>
  abstract listVariables(): Promise<KeyValue[]>
  abstract serverCatalog(kind: ServerCatalogKind): Promise<ServerCatalog>
  abstract replicationInfo(): Promise<ReplicationInfo>
  abstract diagnostics(kind: DiagnosticKind, query?: DiagnosticQuery): Promise<DiagnosticReport>
  abstract listStatus(): Promise<KeyValue[]>
  abstract listProcesses(): Promise<ProcessInfo[]>
  abstract killProcess(id: string): Promise<void>
  abstract listUsers(): Promise<UserInfo[]>
  abstract showGrants(user: UserRef, ns?: Namespace): Promise<string[]>
  abstract canManageAccount(name: string): Promise<boolean>

  /** Checks a connection out of the pool for `ns` (MySQL: `USE db` applied; PG: pool of that database). */
  protected abstract acquire(ns: Namespace): Promise<Conn>
  /** Applies / clears a per-session statement timeout. 0 clears. */
  protected abstract setStatementTimeout(conn: Conn, ms: number): Promise<void>
  /** Backend/connection id of `conn` as seen by the server (CONNECTION_ID() / pg_backend_pid()). */
  protected abstract backendId(conn: Conn): Promise<string>
  /**
   * Opens one dedicated connection for cancel signals (KILL QUERY / pg_cancel_backend). Dedicated, because the
   * session's pool may be fully occupied by the very statements being cancelled; one per cancel (not per
   * signal), because the retry loop would otherwise open a fresh connection every 50 ms.
   */
  protected abstract openCanceller(ns: Namespace): Promise<Canceller>
  /** NULL-safe equality operator used for all-columns keys. */
  protected abstract nullSafeEq(): string
  /**
   * Called once per executeSql before the first statement (and again after a statement that touched the
   * setting). A dialect that can cap result sets session-wide (MySQL / MariaDB `sql_select_limit`) does it
   * here and returns true so plain reads are not wrapped in a derived table — MariaDB drops the inner ORDER BY
   * of a merged derived table, MySQL rejects duplicate column names and top-level-only modifiers inside one.
   * A statement with its own LIMIT overrides the session cap and is still wrapped (a derived table with a
   * LIMIT is materialised, so its ORDER BY survives). The session reset after the script clears the setting.
   */
  protected async capResultRows(_conn: Conn, _maxRows: number): Promise<boolean> {
    return false
  }
  /** Turns on per-statement profiling for this run; false where the server has none. Reset with the session. */
  protected async startProfiling(_conn: Conn): Promise<boolean> {
    return false
  }
  /** The stages of the statement just run, when profiling is on. */
  protected async readProfile(_conn: Conn): Promise<ProfileStage[] | null> {
    return null
  }
  /** Native error codes that mean "the read-only wrapper broke this statement", after which it is re-run unwrapped. */
  protected wrapperOnlyErrors(): ReadonlySet<string> {
    return NO_CODES
  }
  /** Row-identity fallback when a table has no PK / NOT NULL unique key. */
  protected abstract fallbackKeyKind(): Extract<RowKeyKind, 'ctid' | 'all-columns'>
  /** Extra SELECT-list expression that exposes the fallback key (PG: ctid), or null. */
  protected abstract fallbackKeySelect(): string | null
  /**
   * Wraps a key-value placeholder so it compares as the column's own type (`dataType` as reported by describeTable).
   * Dialects whose placeholders reach the server as untyped literals override this (MySQL JSON / FLOAT / DECIMAL).
   */
  protected keyParam(placeholder: string, _type: string): string {
    return placeholder
  }
  /**
   * Both sides of an all-columns key comparison, wrapped so the match is exact rather than collation-equal.
   * The default is no wrapping (PostgreSQL addresses rows by ctid and never takes this path).
   */
  protected keyMatchExpr(expr: string, _type: string): string {
    return expr
  }

  /** Whether keyParam needs the column types (saves the describeTable round trips on dialects that never cast). */
  protected readonly castsKeyParams: boolean = false

  /** Column name → declared type, for keyParam; empty when the dialect never casts. */
  private async keyColumnTypes(ns: Namespace, table: string): Promise<Map<string, string>> {
    if (!this.castsKeyParams) return new Map()
    const schema = await this.describeTable(ns, table)
    return new Map(schema.columns.map((c) => [c.name, c.dataType]))
  }

  /**
   * Statement timeout currently applied to each pooled driver connection. The timeout is left in place on
   * release and only re-sent when the next borrower needs a different value, so the common path (every call
   * using the default timeout) costs no extra round trips. Entries are dropped when user SQL may have changed it.
   */
  private readonly appliedTimeout = new WeakMap<object, number>()

  /** Checks out a connection with the statement timeout applied; `done()` mirrors withConn's cleanup. */
  protected async borrow(ns: Namespace, timeoutMs: number): Promise<{ conn: Conn; done: () => Promise<void> }> {
    const conn = await this.acquire(ns)
    if (this.appliedTimeout.get(conn.id) !== timeoutMs) {
      try {
        await this.setStatementTimeout(conn, timeoutMs)
        this.appliedTimeout.set(conn.id, timeoutMs)
      } catch (err) {
        this.appliedTimeout.delete(conn.id)
        conn.release()
        throw err
      }
    }
    return { conn, done: () => Promise.resolve(conn.release()) }
  }

  /**
   * Forgets the cached session state of `conn` (after user-controlled SQL that may have issued its own SET /
   * USE / search_path change): the timeout cache here and the dialect's namespace cache via `conn.forget()`.
   */
  protected forgetSessionState(conn: Conn): void {
    this.appliedTimeout.delete(conn.id)
    conn.forget()
  }

  protected async withConn<T>(
    ns: Namespace,
    fn: (conn: Conn) => Promise<T>,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const { conn, done } = await this.borrow(ns, timeoutMs)
    try {
      return await fn(conn)
    } finally {
      await done()
    }
  }

  protected async withTransaction<T>(ns: Namespace, fn: (conn: Conn) => Promise<T>): Promise<T> {
    return this.withConn(ns, async (conn) => {
      await conn.query('BEGIN')
      try {
        const result = await fn(conn)
        await conn.query('COMMIT')
        return result
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => undefined)
        throw err
      }
    })
  }

  /** Resolves how rows of `schema` can be addressed. */
  resolveRowKey(schema: TableSchema): { keyKind: RowKeyKind; keyColumns: string[] } {
    if (isViewKind(schema.kind)) return { keyKind: 'none', keyColumns: [] }
    if (schema.primaryKey.length > 0) return { keyKind: 'pk', keyColumns: schema.primaryKey }
    const notNull = new Set(schema.columns.filter((c) => !c.nullable).map((c) => c.name))
    // A partial unique index does not identify every row (duplicates are allowed outside its predicate).
    const unique = schema.indexes.find(
      (i) => i.unique && i.predicate === null && i.columns.every((c) => notNull.has(c))
    )
    if (unique) return { keyKind: 'pk', keyColumns: unique.columns }
    const kind = this.fallbackKeyKind()
    // ctid is unique per physical relation only: a partitioned / inheritance parent repeats it across children.
    if (kind === 'ctid' && (schema.partitioned || schema.hasChildren)) return { keyKind: 'none', keyColumns: [] }
    return { keyKind: kind, keyColumns: kind === 'ctid' ? ['ctid'] : schema.columns.map((c) => c.name) }
  }

  async checkReferences(ns: Namespace, table: string): Promise<ReferenceCheck[]> {
    const schema = await this.describeTable(ns, table)
    const d = this.dialect
    return this.withConn(ns, async (conn) => {
      const out: ReferenceCheck[] = []
      for (const fk of schema.foreignKeys) {
        const child = quoteTable(d, ns, table)
        const parent = quoteTable(d, fk.refNamespace, fk.refTable)
        const on = fk.columns
          .map((c, i) => `c.${quoteIdent(d, c)} = p.${quoteIdent(d, fk.refColumns[i] ?? '')}`)
          .join(' AND ')
        // A key with a NULL in it names no parent (MATCH SIMPLE): only rows with every column set are checked.
        const where = [
          `p.${quoteIdent(d, fk.refColumns[0] ?? '')} IS NULL`,
          ...fk.columns.map((c) => `c.${quoteIdent(d, c)} IS NOT NULL`),
        ].join(' AND ')
        const from = `FROM ${child} c LEFT JOIN ${parent} p ON ${on} WHERE ${where}`
        const count = firstResult(await conn.query(`SELECT COUNT(*) ${from}`)).rows[0]?.[0]
        out.push({
          name: fk.name,
          columns: fk.columns,
          refNamespace: fk.refNamespace,
          refTable: fk.refTable,
          refColumns: fk.refColumns,
          orphans: Number(count ?? 0),
          sql: `SELECT c.* ${from}`,
        })
      }
      return out
    })
  }

  async distinctValues(ns: Namespace, table: string, column: string): Promise<DistinctValues> {
    const schema = await this.describeTable(ns, table)
    if (!schema.columns.some((c) => c.name === column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${column}`)
    const d = this.dialect
    const col = quoteIdent(d, column)
    const params = new Params(d)
    const sql = `SELECT ${col}, COUNT(*) AS n FROM ${quoteTable(d, ns, table)} GROUP BY ${col} ORDER BY n DESC, ${col} LIMIT ${params.add(DISTINCT_VALUES_LIMIT + 1)}`
    return this.withConn(ns, async (conn) => {
      const rows = firstResult(await conn.query(sql, params.values)).rows
      return {
        values: rows.slice(0, DISTINCT_VALUES_LIMIT).map((r) => ({ value: r[0] ?? null, count: Number(r[1]) })),
        truncated: rows.length > DISTINCT_VALUES_LIMIT,
      }
    })
  }

  async searchTable(
    ns: Namespace,
    table: string,
    term: string,
    options: SearchOptions = {}
  ): Promise<TableSearchResult> {
    const schema = await this.describeTable(ns, table)
    const d = this.dialect
    const mode = options.mode ?? 'phrase'
    const only = options.column?.trim().toLowerCase()
    // Columns whose values have no readable text form are skipped (see UNSEARCHABLE_TYPE).
    const columns = schema.columns
      .filter((c) => isSearchableType(d, c.dataType) && (!only || c.name.toLowerCase().includes(only)))
      .map((c) => c.name)
    if (columns.length === 0) return { total: 0, count: 'exact', columns: [], sql: '', deleteSql: '' }
    const tableSql = quoteTable(d, ns, table)
    // Same meaning of "contains" as the browse filter: the term is literal, wildcards added here. Case-insensitive
    // on both servers — MySQL through the connection's collation, PostgreSQL with ILIKE / ~* — as phpMyAdmin
    // searches. A regular expression is the server's own.
    const words = mode === 'any' || mode === 'all' ? term.split(/\s+/).filter((w) => w !== '') : [term]
    const text = (c: string) => (d === 'mysql' ? `CAST(${quoteIdent(d, c)} AS CHAR)` : `${quoteIdent(d, c)}::text`)
    const match = (bind: (v: string) => string) => {
      const one = (c: string, w: string) =>
        mode === 'regexp'
          ? `${text(c)} ${d === 'mysql' ? 'REGEXP' : '~*'} ${bind(w)}`
          : `${text(c)} ${d === 'mysql' ? 'LIKE' : 'ILIKE'} ${bind(`%${escapeLike(w)}%`)} ESCAPE '!'`
      // A word matches the row when any column holds it; "all" needs every word, the others any.
      const perWord = words.map((w) => `(${columns.map((c) => one(c, w)).join(' OR ')})`)
      return perWord.join(mode === 'all' ? ' AND ' : ' OR ')
    }
    const params = new Params(d)
    const where = match((v) => params.add(v))
    // Bounded like the browse count: a term that matches most of a huge table is still one limited scan.
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableSql} WHERE ${where} LIMIT ${params.add(EXACT_COUNT_MAX_ROWS + 1)}) AS tsmyadmin_search`
    // For the SQL tab, where it is edited and run: the term is written in as a literal there.
    const literalWhere = match((v) => (d === 'mysql' ? mysqlLiteral(v) : pgLiteral(v)))
    const sql = `SELECT * FROM ${tableSql} WHERE ${literalWhere}`
    const deleteSql = `DELETE FROM ${tableSql} WHERE ${literalWhere}`
    return this.withConn(ns, async (conn) => {
      const cell = firstResult(await conn.query(countSql, params.values)).rows[0]?.[0]
      const counted = typeof cell === 'number' ? cell : Number(cell ?? 0)
      const bounded = counted > EXACT_COUNT_MAX_ROWS
      return {
        total: bounded ? EXACT_COUNT_MAX_ROWS : counted,
        count: bounded ? 'lower_bound' : 'exact',
        columns,
        sql,
        deleteSql,
      }
    })
  }

  async browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult> {
    const schema = await this.describeTable(ns, table)
    const known = new Set(schema.columns.map((c) => c.name))
    for (const s of opts.sort)
      if (!known.has(s.column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${s.column}`)
    for (const f of opts.filters)
      if (!known.has(f.column)) throw new AdapterError('NOT_FOUND', `Unknown column: ${f.column}`)

    const d = this.dialect
    const key = this.resolveRowKey(schema)
    const types = new Map(schema.columns.map((c) => [c.name, c.dataType]))
    const tableSql = quoteTable(d, ns, table)
    const selectList = schema.columns.map((c) => quoteIdent(d, c.name))
    const fallback = this.fallbackKeySelect()
    if (key.keyKind === 'ctid' && fallback) selectList.push(fallback)
    // Without a user sort the rows still come in a stable order (LIMIT / OFFSET paging over heap order can
    // skip or repeat rows): the primary key (an index scan), or ctid on PostgreSQL — which is a full scan plus
    // a sort per page, so only while the table is small enough to be counted exactly anyway.
    const defaultOrder =
      key.keyKind === 'pk'
        ? key.keyColumns.map((c) => quoteIdent(d, c)).join(', ')
        : key.keyKind === 'ctid' && countMode(schema.rowEstimate) === 'exact'
          ? `${tableSql}.ctid`
          : ''
    const order =
      opts.sort.length > 0
        ? ` ORDER BY ${opts.sort.map((s) => `${quoteIdent(d, s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
        : defaultOrder
          ? ` ORDER BY ${defaultOrder}`
          : ''
    // Built twice from the same pieces: with placeholders (what runs) and with the values written in (what is shown
    // to edit, explain or save).
    const build = (p: Params) =>
      `SELECT ${selectList.join(', ')} FROM ${tableSql}${this.buildWhere(opts.filters, p, types)}${order} LIMIT ${p.add(opts.limit === 0 ? BROWSE_ALL_MAX : opts.limit)} OFFSET ${p.add(opts.limit === 0 ? 0 : opts.offset)}`
    const params = new Params(d)
    const dataSql = build(params)
    const literalSql = build(new Params(d, true))

    // The count stops at the threshold: a filter matching millions of rows costs one bounded scan, and the page
    // then says "100,000+" instead of the exact figure.
    const countParams = new Params(d)
    const countWhere = this.buildWhere(opts.filters, countParams, types)
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM ${tableSql}${countWhere} LIMIT ${countParams.add(EXACT_COUNT_MAX_ROWS + 1)}) AS tsmyadmin_count`

    return this.withConn(ns, async (conn) => {
      const profiling = opts.profile ? await this.startProfiling(conn) : false
      const started = performance.now()
      const data = firstResult(await conn.query(dataSql, params.values, DISPLAY))
      const duration = performance.now() - started
      // Read before anything else runs: the profile is of the most recent statement.
      const stages = profiling ? await this.readProfile(conn).catch(() => null) : null
      const statement = {
        sql: dataSql,
        literal: literalSql,
        ...(stages && stages.length > 0 ? { profile: stages } : {}),
        // Bound values go back as cells: a binary filter was turned into a Buffer for the driver.
        params: params.values.map((v) => (v instanceof Uint8Array ? bufferToCell(v) : (v as Cell))),
        durationMs: duration,
      }
      // Large unfiltered tables: COUNT(*) is a full scan on InnoDB / PostgreSQL, so use the catalog estimate
      // that describeTable already fetched (no extra round trip).
      const estimate = opts.filters.length === 0 ? schema.rowEstimate : null
      if (countMode(estimate) === 'estimate') {
        return {
          columns: data.columns,
          rows: data.rows,
          truncated: false,
          total: estimate,
          count: 'estimate',
          keyKind: key.keyKind,
          keyColumns: key.keyColumns,
          foreignKeys: schema.foreignKeys,
          referencedBy: schema.referencedBy,
          statement,
        }
      }
      const count = firstResult(await conn.query(countSql, countParams.values))
      const totalCell = count.rows[0]?.[0]
      const counted =
        typeof totalCell === 'number' ? totalCell : typeof totalCell === 'string' ? Number(totalCell) : null
      const total = counted !== null && Number.isFinite(counted) ? counted : null
      const bounded = total !== null && total > EXACT_COUNT_MAX_ROWS
      return {
        columns: data.columns,
        rows: data.rows,
        truncated: false,
        total: bounded ? EXACT_COUNT_MAX_ROWS : total,
        count: bounded ? 'lower_bound' : 'exact',
        keyKind: key.keyKind,
        keyColumns: key.keyColumns,
        foreignKeys: schema.foreignKeys,
        referencedBy: schema.referencedBy,
        statement,
      }
    })
  }

  private buildWhere(filters: Filter[], params: Params, types: Map<string, string>): string {
    if (filters.length === 0) return ''
    const parts = filters.map((f) =>
      this.conditionSql(quoteIdent(this.dialect, f.column), f, types.get(f.column) ?? '', (v) =>
        params.add(toDbValue(v))
      )
    )
    return ` WHERE ${parts.join(' AND ')}`
  }

  /**
   * One condition on one column, shared by the browse filter and the query builder. `bind` turns a value into
   * SQL text: a placeholder for browsing, a quoted literal for a statement the user will edit in the SQL tab.
   */
  private conditionSql(
    col: string,
    f: Pick<Filter, 'column' | 'op' | 'value' | 'values'>,
    type: string,
    bind: (value: InputCell) => string
  ): string {
    const d = this.dialect
    const op = FILTER_SQL[f.op]
    if (f.op === 'is_null' || f.op === 'is_not_null') return `${col} ${op}`
    // The column's text form: PostgreSQL has no implicit cast for LIKE / ~ on numbers, dates or json. On MySQL an
    // INT compared with '' would convert '' to 0; CONCAT gives the text ('0') instead, and keeps NULL as NULL.
    const textCol = d === 'postgres' ? `${col}::text` : col
    if (f.op === 'empty' || f.op === 'not_empty') return `${d === 'mysql' ? `CONCAT(${col})` : textCol} ${op} ''`
    if (LIST_OPS.has(f.op)) {
      const values = f.values ?? []
      const between = f.op === 'between' || f.op === 'not_between'
      if (between ? values.length !== 2 : values.length === 0)
        throw new AdapterError(
          'VALIDATION',
          `Filter "${f.op}" on ${f.column} takes ${between ? 'two values' : 'at least one value'}`
        )
      const typed = values.map((v) => this.keyParam(bind(v), type))
      return between ? `${col} ${op} ${typed[0]} AND ${typed[1]}` : `${col} ${op} (${typed.join(', ')})`
    }
    if (f.value === undefined)
      throw new AdapterError('QUERY_FAILED', `Filter "${f.op}" on ${f.column} requires a value`)
    if (f.op === 'contains' || f.op === 'starts_with') {
      // The user's text is matched literally: LIKE metacharacters are escaped, wildcards added here.
      const text = escapeLike(String(f.value ?? ''))
      const pattern = f.op === 'contains' ? `%${text}%` : `${text}%`
      return `${textCol} LIKE ${bind(pattern)} ESCAPE '!'`
    }
    if (f.op === 'like' || f.op === 'not_like') return `${textCol} ${op} ${bind(f.value)}`
    if (f.op === 'regexp' || f.op === 'not_regexp')
      return d === 'postgres'
        ? `${textCol} ${f.op === 'regexp' ? '~' : '!~'} ${bind(f.value)}`
        : `${col} ${op} ${bind(f.value)}`
    // Comparisons use the column's own type (FLOAT 0.1 is not the DOUBLE literal 0.1; BIT is not a hex string).
    return `${col} ${op} ${this.keyParam(bind(f.value), type)}`
  }

  async buildQuery(ns: Namespace, spec: QueryBuilderSpec): Promise<QueryBuilderResult> {
    const d = this.dialect
    if (new Set(spec.tables).size !== spec.tables.length)
      throw new AdapterError('VALIDATION', 'Each table can be listed only once')
    const schemas = new Map<string, TableSchema>()
    // One at a time: the session's pool is small, and structure reads are quick.
    for (const table of spec.tables) schemas.set(table, await this.describeTable(ns, table))
    const typeOf = (ref: { table: string; column: string }): string => {
      const column = schemas.get(ref.table)?.columns.find((c) => c.name === ref.column)
      if (!column) throw new AdapterError('NOT_FOUND', `Unknown column: ${ref.table}.${ref.column}`)
      return column.dataType
    }
    // Columns are qualified by the bare table name, which FROM leaves in scope in both dialects.
    const ref = (r: { table: string; column: string }) => `${quoteIdent(d, r.table)}.${quoteIdent(d, r.column)}`
    const literal = (v: InputCell) => (d === 'mysql' ? mysqlLiteral(String(v)) : pgLiteral(String(v)))

    const select = spec.columns
      .filter((c) => c.show)
      .map((c) => {
        typeOf(c)
        return c.alias === '' ? ref(c) : `${ref(c)} AS ${quoteIdent(d, c.alias)}`
      })
    const condition = (c: QueryBuilderCondition) => {
      const type = typeOf(c)
      // MySQL compares BIT through the bytes bound for it (see keyParam): a quoted '170' would be read as the
      // bytes of the text "170". The number is written as those bytes instead.
      const bitCompare = d === 'mysql' && /^bit\b/i.test(type) && !TEXT_OPS.has(c.op)
      return this.conditionSql(ref(c), c, type, bitCompare ? bitLiteral : literal)
    }
    const groups = spec.where.map((g) => g.map(condition).join(' AND '))
    const order = spec.columns
      .filter((c) => c.sort !== null)
      .map((c) => {
        typeOf(c)
        return `${ref(c)} ${c.sort === 'desc' ? 'DESC' : 'ASC'}`
      })

    const lines = [
      `SELECT ${spec.distinct ? 'DISTINCT ' : ''}${select.length === 0 ? '*' : select.join(', ')}`,
      `FROM ${quoteTable(d, ns, spec.tables[0] ?? '')}`,
      ...joinPlan(d, ns, spec.tables, schemas, spec.joins),
    ]
    const typed = (spec.whereSql ?? '').trim()
    const built = groups.length === 1 ? groups[0] : groups.length > 1 ? groups.map((g) => `(${g})`).join(' OR ') : ''
    // Typed SQL goes in its own parentheses, so an OR in it cannot escape the AND with the built conditions.
    const where = [built && typed && groups.length > 1 ? `(${built})` : built, typed && `(${typed})`].filter(Boolean)
    if (where.length > 0) lines.push(`WHERE ${where.join(' AND ')}`)
    if (order.length > 0) lines.push(`ORDER BY ${order.join(', ')}`)
    if (spec.limit != null) lines.push(`LIMIT ${spec.limit}`)
    return { sql: lines.join('\n') }
  }

  /** A value to write: bound as a parameter, or an allowed function around its bound argument. */
  private writeValue(params: Params, cell: WriteCell): string {
    if (!isFunctionCell(cell)) return params.add(toDbValue(cell))
    return rowFunctionSql(this.dialect, cell.$fn, () => params.add(cell.arg ?? null))
  }

  private insertStatement(
    ns: Namespace,
    table: string,
    values: RowValues,
    ignore: boolean
  ): { sql: string; params: unknown[] } {
    const d = this.dialect
    const names = Object.keys(values)
    const params = new Params(d)
    const verb = d === 'mysql' && ignore ? 'INSERT IGNORE' : 'INSERT'
    const head =
      names.length === 0
        ? d === 'mysql'
          ? `${verb} INTO ${quoteTable(d, ns, table)} () VALUES ()`
          : `${verb} INTO ${quoteTable(d, ns, table)} DEFAULT VALUES`
        : `${verb} INTO ${quoteTable(d, ns, table)} (${names.map((n) => quoteIdent(d, n)).join(', ')}) VALUES (${names
            .map((n) => this.writeValue(params, values[n] ?? null))
            .join(', ')})`
    return { sql: d === 'postgres' && ignore ? `${head} ON CONFLICT DO NOTHING` : head, params: params.values }
  }

  async insertRow(
    ns: Namespace,
    table: string,
    values: RowValues,
    options: { ignore?: boolean } = {}
  ): Promise<{ affectedRows: number }> {
    const { sql, params } = this.insertStatement(ns, table, values, options.ignore === true)
    return this.withConn(ns, async (conn) => {
      const r = firstResult(await conn.query(sql, params))
      return { affectedRows: r.affectedRows }
    })
  }

  insertPreview(ns: Namespace, table: string, values: RowValues, options: { ignore?: boolean } = {}): InsertPreview {
    const { sql, params } = this.insertStatement(ns, table, values, options.ignore === true)
    // What the driver would be given, as wire cells: bytes as base64, the rest as they are.
    return {
      sql,
      params: params.map((p) => (Buffer.isBuffer(p) ? { $bin: p.toString('base64') } : (p as Cell))),
    }
  }

  /** Rows per INSERT statement, bounded so PostgreSQL's 65535-parameter limit is never hit. */
  static chunkSize(columnCount: number): number {
    return Math.max(1, Math.min(500, Math.floor(30_000 / Math.max(1, columnCount))))
  }

  async insertRows(
    ns: Namespace,
    table: string,
    columns: string[],
    rows: Iterable<InputCell[]>,
    options: InsertRowsOptions = {}
  ): Promise<{ affectedRows: number; warnings?: string[] }> {
    if (columns.length === 0) throw new AdapterError('QUERY_FAILED', 'insertRows requires at least one column')
    const d = this.dialect
    // A PostgreSQL identity column declared ALWAYS refuses explicit values without OVERRIDING SYSTEM VALUE.
    const overriding = d === 'postgres' && options.overriding ? ' OVERRIDING SYSTEM VALUE' : ''
    const mysqlVerb =
      options.onDuplicate === 'replace' ? 'REPLACE' : options.onDuplicate === 'ignore' ? 'INSERT IGNORE' : 'INSERT'
    const verb = d === 'mysql' ? mysqlVerb : 'INSERT'
    const head = `${verb} INTO ${quoteTable(d, ns, table)} (${columns.map((c) => quoteIdent(d, c)).join(', ')})${overriding} VALUES `
    // PostgreSQL has neither: a conflicting row is skipped, or its key's other columns are rewritten.
    const rest = columns.filter((c) => !(options.keyColumns ?? []).includes(c))
    if (d === 'postgres' && options.onDuplicate === 'replace' && (options.keyColumns ?? []).length === 0)
      throw new AdapterError('VALIDATION', 'Replacing rows needs a primary key on the table')
    const tail =
      d !== 'postgres' || !options.onDuplicate
        ? ''
        : options.onDuplicate === 'ignore' || rest.length === 0
          ? ' ON CONFLICT DO NOTHING'
          : ` ON CONFLICT (${(options.keyColumns ?? []).map((c) => quoteIdent(d, c)).join(', ')}) DO UPDATE SET ${rest.map((c) => `${quoteIdent(d, c)} = EXCLUDED.${quoteIdent(d, c)}`).join(', ')}`
    const chunk = BaseAdapter.chunkSize(columns.length)
    const it = rows[Symbol.iterator]()
    let first = it.next()
    if (first.done) return { affectedRows: 0 }
    // One transaction for the whole batch (all or nothing); rows are consumed as they come, a chunk at a time.
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      let offset = 0
      // INSERT IGNORE turns more than a key clash into a warning (a value cut to fit, a bad conversion): what it let
      // pass is read back after each statement and handed to the caller, which says so rather than saying nothing.
      const warnings: string[] = []
      while (!first.done) {
        const batch: Cell[][] = []
        while (!first.done && batch.length < chunk) {
          batch.push(first.value)
          first = it.next()
        }
        const params = new Params(d)
        const values = batch
          .map((row) => `(${columns.map((_, j) => params.add(toDbValue(row[j] ?? null))).join(', ')})`)
          .join(', ')
        try {
          const r = firstResult(await conn.query(head + values + tail, params.values))
          affected += r.affectedRows
          if (d === 'mysql' && options.onDuplicate === 'ignore') {
            for (const w of firstResult(await conn.query('SHOW WARNINGS')).rows) {
              // 1062 is the duplicate key itself, which is what was asked to be left out.
              if (Number(w[1]) !== DUPLICATE_ENTRY && warnings.length < MAX_INSERT_WARNINGS) warnings.push(String(w[2]))
            }
          }
        } catch (err) {
          const e = err instanceof AdapterError ? err : this.toAdapterError(err)
          // MySQL names the failing row of the statement; PostgreSQL does not — the batch is the best it gets.
          const at = /\bat row (\d+)/i.exec(e.detail ?? e.message)
          throw new AdapterError(e.code, e.message, e.detail, {
            ...(e.nativeCode ? { nativeCode: e.nativeCode } : {}),
            ...(e.position ? { position: e.position } : {}),
            rows: at ? [offset + Number(at[1]) - 1, offset + Number(at[1]) - 1] : [offset, offset + batch.length - 1],
          })
        }
        offset += batch.length
      }
      return { affectedRows: affected, ...(warnings.length > 0 ? { warnings } : {}) }
    })
  }

  async updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }> {
    const d = this.dialect
    const names = Object.keys(values)
    if (names.length === 0) return { affectedRows: 0 }
    const params = new Params(d)
    const set = names.map((n) => `${quoteIdent(d, n)} = ${this.writeValue(params, values[n] ?? null)}`).join(', ')
    const where = this.buildKeyWhere(key, params, await this.keyColumnTypes(ns, table))
    const limit = key.kind === 'all-columns' && d === 'mysql' ? ' LIMIT 1' : ''
    const sql = `UPDATE ${quoteTable(d, ns, table)} SET ${set}${where}${limit}`
    return this.withTransaction(ns, async (conn) => {
      const r = firstResult(await conn.query(sql, params.values))
      if (r.affectedRows !== 1) {
        throw new AdapterError(
          'KEY_MISMATCH',
          `Expected to update exactly 1 row but matched ${r.affectedRows}; rolled back`
        )
      }
      return { affectedRows: r.affectedRows }
    })
  }

  async countRows(ns: Namespace, table: string): Promise<number> {
    const r = await this.withConn(ns, async (conn) =>
      firstResult(await conn.query(`SELECT COUNT(*) FROM ${quoteTable(this.dialect, ns, table)}`))
    )
    return Number(r.rows[0]?.[0] ?? 0)
  }

  async readCell(ns: Namespace, table: string, key: RowKey, column: string): Promise<Cell> {
    const d = this.dialect
    const schema = await this.describeTable(ns, table)
    const def = schema.columns.find((c) => c.name === column)
    if (!def) throw new AdapterError('NOT_FOUND', `Unknown column: ${column}`)
    const params = new Params(d)
    const where = this.buildKeyWhere(key, params, await this.keyColumnTypes(ns, table))
    const col = quoteIdent(d, column)
    // PostgreSQL's octet_length takes only text, bytea and bit: any other type is measured by its text form.
    const measured =
      d === 'postgres' && !/^(bytea|bit|text|character|varchar)\b/i.test(def.dataType) ? `${col}::text` : col
    // The size first, so a value too large to hand over is refused before it is read into memory.
    const sql = `SELECT OCTET_LENGTH(${measured}) FROM ${quoteTable(d, ns, table)}${where} LIMIT 2`
    return this.withConn(ns, async (conn) => {
      const sized = firstResult(await conn.query(sql, params.values))
      if (sized.rows.length !== 1)
        throw new AdapterError('KEY_MISMATCH', `Expected exactly 1 row but matched ${sized.rows.length}`)
      if (Number(sized.rows[0]?.[0] ?? 0) > READ_CELL_MAX_BYTES)
        throw new AdapterError('VALIDATION', `The value is larger than ${READ_CELL_MAX_BYTES} bytes`)
      const read = firstResult(
        await conn.query(`SELECT ${col} FROM ${quoteTable(d, ns, table)}${where} LIMIT 2`, params.values, UNCAPPED)
      )
      if (read.rows.length !== 1)
        throw new AdapterError('KEY_MISMATCH', `Expected exactly 1 row but matched ${read.rows.length}`)
      return read.rows[0]?.[0] ?? null
    })
  }

  async deleteRows(ns: Namespace, table: string, keys: RowKey[]): Promise<{ affectedRows: number }> {
    const d = this.dialect
    const types = await this.keyColumnTypes(ns, table)
    return this.withTransaction(ns, async (conn) => {
      let affected = 0
      for (const key of keys) {
        const params = new Params(d)
        const where = this.buildKeyWhere(key, params, types)
        const limit = key.kind === 'all-columns' && d === 'mysql' ? ' LIMIT 1' : ''
        const r = firstResult(
          await conn.query(`DELETE FROM ${quoteTable(d, ns, table)}${where}${limit}`, params.values)
        )
        if (r.affectedRows !== 1) {
          throw new AdapterError(
            'KEY_MISMATCH',
            `Expected to delete exactly 1 row but matched ${r.affectedRows}; rolled back`
          )
        }
        affected += r.affectedRows
      }
      return { affectedRows: affected }
    })
  }

  private buildKeyWhere(key: RowKey, params: Params, types: Map<string, string>): string {
    const d = this.dialect
    const value = (name: string, cell: Cell | undefined) =>
      this.keyParam(params.add(toDbValue(cell ?? null)), types.get(name) ?? '')
    switch (key.kind) {
      case 'pk': {
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Primary key values are empty')
        return ` WHERE ${names.map((n) => `${quoteIdent(d, n)} = ${value(n, key.values[n])}`).join(' AND ')}`
      }
      case 'all-columns': {
        if (d !== 'mysql') throw new AdapterError('UNSUPPORTED', 'all-columns keys are only supported on MySQL')
        const names = Object.keys(key.values)
        if (names.length === 0) throw new AdapterError('KEY_MISMATCH', 'Key values are empty')
        const eq = this.nullSafeEq()
        // Every column is the key here, so the comparison has to be exact: under the column's own collation
        // rows differing only by case, accent or trailing space are equal, and `LIMIT 1` would then pick
        // whichever the scan reached first — silently editing a row the user did not click.
        const match = (n: string, expr: string) => this.keyMatchExpr(expr, types.get(n) ?? '')
        return ` WHERE ${names
          .map((n) => `${match(n, quoteIdent(d, n))} ${eq} ${match(n, value(n, key.values[n]))}`)
          .join(' AND ')}`
      }
      case 'ctid': {
        if (d !== 'postgres') throw new AdapterError('UNSUPPORTED', 'ctid keys are only supported on PostgreSQL')
        return ` WHERE ctid = ${params.add(key.value)}::tid`
      }
    }
  }

  /**
   * Full scan of a table for a dump, in batches of `batchSize` rows and with bounded memory. How a scan pages
   * differs by dialect (MySQL: keyset paging or a streamed read; PostgreSQL: a server-side cursor), so each one
   * implements it. An empty table still yields one batch so callers learn the column list.
   */
  abstract iterateRows(
    ns: Namespace,
    table: string,
    opts: { batchSize: number; schema?: TableSchema; utc?: boolean }
  ): AsyncIterable<RowBatch>

  /**
   * The SQL console's runs and their cancellation (see sql-console.ts). Built on first use, because the subclass
   * sets `dialect` after this constructor has run.
   */
  private scriptRunner: ScriptRunner | undefined

  private get scripts(): ScriptRunner {
    this.scriptRunner ??= new ScriptRunner({
      dialect: this.dialect,
      withConn: (ns, fn, timeoutMs) => this.withConn(ns, fn, timeoutMs),
      forgetSessionState: (conn) => this.forgetSessionState(conn),
      capResultRows: (conn, maxRows) => this.capResultRows(conn, maxRows),
      startProfiling: (conn) => this.startProfiling(conn),
      readProfile: (conn) => this.readProfile(conn),
      backendId: (conn) => this.backendId(conn),
      openCanceller: (ns) => this.openCanceller(ns),
      wrapperOnlyErrors: () => this.wrapperOnlyErrors(),
      toAdapterError: (err) => this.toAdapterError(err),
    })
    return this.scriptRunner
  }

  executeSql(ns: Namespace, script: string, opts: ExecuteOptions): Promise<StatementResult[]> {
    return this.scripts.execute(ns, script, opts)
  }

  /** Cancels a registered run. Waits up to `waitMs` for the run to reach the server (pool acquisition). */
  cancelQuery(queryId: string, waitMs = 10_000): Promise<boolean> {
    return this.scripts.cancel(queryId, waitMs)
  }

  /** Maps a driver error to AdapterError. */
  abstract toAdapterError(err: unknown): AdapterError
}
