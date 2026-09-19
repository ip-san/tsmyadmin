import { createHash, randomUUID } from 'node:crypto'
import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  DatabaseInfo,
  Dialect,
  EventInfo,
  Filter,
  InputCell,
  KeyValue,
  KeyValues,
  Namespace,
  ObjectDependency,
  Partitioning,
  ProcessInfo,
  QueryBuilderResult,
  QueryBuilderSpec,
  RelationDef,
  ReplicationInfo,
  RoutineInfo,
  RoutineKind,
  RowKey,
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
  TriggerInfo,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { isFunctionCell } from '@tsmyadmin/shared'
import { mysqlDdl } from '../mysql/ddl.ts'
import { mysqlExporter } from '../mysql/export.ts'
import { mysqlUsers } from '../mysql/users.ts'
import { pgDdl } from '../postgres/ddl.ts'
import { pgExporter } from '../postgres/export.ts'
import { pgUsers } from '../postgres/users.ts'
import {
  AdapterError,
  type DatabaseAdapter,
  type ExecuteOptions,
  type InsertRowsOptions,
  type RowBatch,
} from '../types.ts'

export interface FakeTable {
  schema: TableSchema
  rows: KeyValues[]
  /** What showCreateTable returns instead of the generic fake statement (views in export tests). */
  definition?: string
}

export interface FakeDatabase {
  schemas?: string[]
  tables: Record<string, FakeTable>
}

export interface FakeAdapterOptions {
  dialect?: Dialect
  /** What canManageAccount answers (default true): false plays an account without authority over others. */
  manageAccounts?: boolean
  databases?: Record<string, FakeDatabase>
  /** Hook invoked by executeSql; defaults to echoing a single-row result. */
  onSql?: (ns: Namespace, sql: string, opts: ExecuteOptions) => StatementResult[]
  /** When set, every method rejects with this error (simulates a dead connection). */
  failWith?: AdapterError
  users?: UserInfo[]
  processes?: ProcessInfo[]
  /** What listDependencies reports (null = no catalog, like MariaDB). */
  dependencies?: ObjectDependency[] | null
  /** Routine definitions by name (listRoutines lists them; kind is 'function'). */
  routines?: Record<string, string>
}

/** Row values as stored: an allowed function is worked out here, the way the server would compute it. */
function evaluate(values: RowValues): KeyValues {
  const hash = (algorithm: string, v: unknown) =>
    createHash(algorithm)
      .update(String(v ?? ''))
      .digest('hex')
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      if (!isFunctionCell(v)) return [k, v]
      const arg = v.arg ?? null
      const text = arg === null ? null : String(arg)
      switch (v.$fn) {
        case 'now':
          return [k, '2026-01-01 00:00:00']
        case 'current_date':
          return [k, '2026-01-01']
        case 'current_time':
          return [k, '00:00:00']
        case 'uuid':
          return [k, randomUUID()]
        case 'md5':
        case 'sha1':
          return [k, text === null ? null : hash(v.$fn, text)]
        case 'sha256':
          return [k, text === null ? null : hash('sha256', text)]
        case 'upper':
          return [k, text?.toUpperCase() ?? null]
        case 'lower':
          return [k, text?.toLowerCase() ?? null]
        default:
          return [k, text?.trim() ?? null]
      }
    })
  )
}

export function fakeColumn(name: string, dataType = 'int', nullable = false): TableSchema['columns'][number] {
  return {
    name,
    dataType,
    nullable,
    default: null,
    defaultIsExpression: false,
    extra: '',
    comment: null,
    collation: null,
    check: null,
    generated: null,
  }
}

export function fakeTable(
  name: string,
  columns: string[],
  rows: KeyValues[],
  primaryKey: string[] = ['id']
): FakeTable {
  return {
    schema: {
      name,
      kind: 'table',
      comment: null,
      engine: null,
      rowEstimate: rows.length,
      partitioned: false,
      hasChildren: false,
      inherits: [],
      collation: null,
      autoIncrement: null,
      columns: columns.map((c) => fakeColumn(c, c === 'id' ? 'int' : 'varchar')),
      primaryKey,
      indexes:
        primaryKey.length > 0
          ? [
              {
                name: 'PRIMARY',
                unique: true,
                primary: true,
                columns: primaryKey,
                type: null,
                predicate: null,
                definition: null,
                lengths: {},
              },
            ]
          : [],
      foreignKeys: [],
      referencedBy: [],
    },
    rows,
  }
}

function compare(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b)))
}

/** A value as SQL would compare it: numbers as numbers (a filter's '5' equals 5), anything else as text. */
function sqlCompare(a: Cell, b: InputCell | undefined): number {
  const x = Number(a)
  const y = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y
  return String(a).localeCompare(String(b))
}

/** One browse filter, with SQL's NULL rule: only IS NULL / IS NOT NULL say anything about a NULL. */
function matchesFilter(v: Cell, f: Filter): boolean {
  if (f.op === 'is_null') return v === null
  if (f.op === 'is_not_null') return v !== null
  if (v === null) return false
  const text = String(v)
  const like = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('%', '.*')
        .replaceAll('_', '.')}$`,
      's'
    ).test(text)
  const values = f.values ?? []
  switch (f.op) {
    case 'eq':
      return sqlCompare(v, f.value) === 0
    case 'neq':
      return sqlCompare(v, f.value) !== 0
    case 'lt':
      return sqlCompare(v, f.value) < 0
    case 'lte':
      return sqlCompare(v, f.value) <= 0
    case 'gt':
      return sqlCompare(v, f.value) > 0
    case 'gte':
      return sqlCompare(v, f.value) >= 0
    case 'contains':
      return text.includes(String(f.value))
    case 'starts_with':
      return text.startsWith(String(f.value))
    case 'like':
      return like(String(f.value))
    case 'not_like':
      return !like(String(f.value))
    case 'in':
      return values.some((x) => sqlCompare(v, x) === 0)
    case 'not_in':
      return !values.some((x) => sqlCompare(v, x) === 0)
    case 'between':
      return sqlCompare(v, values[0]) >= 0 && sqlCompare(v, values[1]) <= 0
    case 'not_between':
      return !(sqlCompare(v, values[0]) >= 0 && sqlCompare(v, values[1]) <= 0)
    case 'regexp':
      return new RegExp(String(f.value)).test(text)
    case 'not_regexp':
      return !new RegExp(String(f.value)).test(text)
    case 'empty':
      return text === ''
    case 'not_empty':
      return text !== ''
  }
}

/**
 * In-memory DatabaseAdapter for API route tests. Deterministic, no I/O.
 * Records every call in `calls` so tests can assert on what the API asked for.
 */
export class FakeAdapter implements DatabaseAdapter {
  readonly dialect: Dialect
  readonly ddl
  readonly exporter
  readonly users
  readonly serverNamespace: Namespace = { database: 'information_schema' }
  readonly calls: { method: string; args: unknown[] }[] = []
  closed = false
  private readonly databases: Record<string, FakeDatabase>
  private readonly userList: UserInfo[]
  private readonly manageAccountsAllowed: boolean
  private processList: ProcessInfo[]
  private readonly onSql: FakeAdapterOptions['onSql']
  private readonly dependencies: ObjectDependency[] | null
  private readonly routines: Record<string, string>
  private readonly failWith: AdapterError | undefined

  constructor(options: FakeAdapterOptions = {}) {
    this.dialect = options.dialect ?? 'mysql'
    this.ddl = this.dialect === 'mysql' ? mysqlDdl : pgDdl
    this.exporter = this.dialect === 'mysql' ? mysqlExporter : pgExporter
    this.users = this.dialect === 'mysql' ? mysqlUsers : pgUsers
    this.userList = options.users ?? []
    this.manageAccountsAllowed = options.manageAccounts ?? true
    this.processList = options.processes ?? []
    this.databases = options.databases ?? {}
    this.onSql = options.onSql
    this.dependencies = options.dependencies ?? null
    this.routines = options.routines ?? {}
    this.failWith = options.failWith
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
    if (this.failWith) throw this.failWith
  }

  private table(ns: Namespace, table: string): FakeTable {
    const db = this.databases[ns.database]
    if (!db) throw new AdapterError('NOT_FOUND', `Unknown database: ${ns.database}`)
    const t = db.tables[table]
    if (!t) throw new AdapterError('NOT_FOUND', `Table not found: ${table}`)
    return t
  }

  async ping(): Promise<void> {
    this.record('ping')
  }

  async close(): Promise<void> {
    this.record('close')
    this.closed = true
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    this.record('listDatabases')
    return Object.keys(this.databases)
      .sort()
      .map((name) => ({
        name,
        sizeBytes: 0,
        tableCount: Object.keys(this.databases[name]?.tables ?? {}).length,
        collation: null,
      }))
  }

  async listSchemas(database: string): Promise<string[]> {
    this.record('listSchemas', database)
    return this.dialect === 'mysql' ? [] : (this.databases[database]?.schemas ?? ['public'])
  }

  async listTables(ns: Namespace): Promise<TableInfo[]> {
    this.record('listTables', ns)
    const db = this.databases[ns.database]
    if (!db) throw new AdapterError('NOT_FOUND', `Unknown database: ${ns.database}`)
    return Object.values(db.tables).map((t) => ({
      name: t.schema.name,
      kind: t.schema.kind,
      inherits: t.schema.inherits,
      rowEstimate: t.rows.length,
      engine: t.schema.engine,
      comment: t.schema.comment,
      sizeBytes: null,
    }))
  }

  async listRoutines(ns: Namespace): Promise<RoutineInfo[]> {
    this.record('listRoutines', ns)
    return Object.keys(this.routines).map((name) => ({
      name,
      kind: 'function' as const,
      language: 'sql',
      returns: 'int',
      parameters: '',
      comment: null,
      sqlMode: null,
    }))
  }

  async routineDefinition(ns: Namespace, name: string, kind: RoutineKind): Promise<string | null> {
    this.record('routineDefinition', ns, name, kind)
    return this.routines[name] ?? `CREATE ${kind.toUpperCase()} ${name}() BEGIN END`
  }

  async listTriggers(ns: Namespace, table?: string): Promise<TriggerInfo[]> {
    this.record('listTriggers', ns, table)
    return []
  }

  async listEvents(ns: Namespace): Promise<EventInfo[]> {
    this.record('listEvents', ns)
    return []
  }

  async listDependencies(ns: Namespace): Promise<ObjectDependency[] | null> {
    this.record('listDependencies', ns)
    return this.dependencies
  }

  async countRows(ns: Namespace, table: string): Promise<number> {
    this.record('countRows', ns, table)
    return this.table(ns, table).rows.length
  }

  async listPartitions(ns: Namespace, table: string): Promise<Partitioning> {
    this.record('listPartitions', ns, table)
    this.table(ns, table)
    return { method: null, expression: null, partitions: [] }
  }

  async tableStats(ns: Namespace, table: string): Promise<TableStats> {
    this.record('tableStats', ns, table)
    const t = this.table(ns, table)
    const rows = t.rows.length
    const data = rows * 100
    return {
      dataBytes: data,
      indexBytes: 0,
      freeBytes: null,
      toastBytes: null,
      totalBytes: data,
      rowEstimate: rows,
      avgRowBytes: rows > 0 ? 100 : null,
      rowFormat: null,
      createdAt: null,
      updatedAt: null,
      checkedAt: null,
      deadRows: null,
      lastVacuum: null,
      lastAnalyze: null,
    }
  }

  async describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    this.record('describeTable', ns, table)
    return structuredClone(this.table(ns, table).schema)
  }

  async searchTable(ns: Namespace, table: string, term: string, options?: SearchOptions): Promise<TableSearchResult> {
    this.record('searchTable', ns, table, term, options)
    const t = this.table(ns, table)
    const columns = t.schema.columns.map((c) => c.name)
    const needle = term.toLowerCase()
    const total = t.rows.filter((r) =>
      columns.some((c) => {
        const v = r[c]
        return (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(needle)
      })
    ).length
    return { total, count: 'exact', columns, sql: `SELECT * FROM ${table}` }
  }

  async listForeignKeys(ns: Namespace): Promise<RelationDef[]> {
    this.record('listForeignKeys', ns)
    const db = this.databases[ns.database]
    if (!db) throw new AdapterError('NOT_FOUND', `Unknown database: ${ns.database}`)
    return Object.values(db.tables)
      .flatMap((t) => t.schema.foreignKeys.map((fk) => ({ ...fk, table: t.schema.name })))
      .sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
  }

  async buildQuery(ns: Namespace, spec: QueryBuilderSpec): Promise<QueryBuilderResult> {
    this.record('buildQuery', ns, spec)
    for (const table of spec.tables) this.table(ns, table)
    return { sql: `SELECT * FROM ${spec.tables.join(', ')}` }
  }

  async browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult> {
    this.record('browseRows', ns, table, opts)
    const t = this.table(ns, table)
    let rows = [...t.rows]
    for (const f of opts.filters) {
      rows = rows.filter((r) => matchesFilter(r[f.column] ?? null, f))
    }
    for (const s of [...opts.sort].reverse()) {
      rows.sort((a, b) => compare(a[s.column] ?? null, b[s.column] ?? null) * (s.direction === 'desc' ? -1 : 1))
    }
    const page = rows.slice(opts.offset, opts.offset + opts.limit)
    const columns = t.schema.columns.map((c) => ({ name: c.name, dataType: c.dataType }))
    return {
      columns,
      rows: page.map((r) => columns.map((c) => r[c.name] ?? null)),
      truncated: false,
      total: rows.length,
      count: 'exact',
      keyKind: t.schema.primaryKey.length > 0 ? 'pk' : 'none',
      keyColumns: t.schema.primaryKey,
      foreignKeys: t.schema.foreignKeys,
      referencedBy: t.schema.referencedBy,
      // No SQL runs here; a stand-in keeps the result shaped like a real adapter's.
      statement: { sql: `SELECT * FROM ${table}`, params: [opts.limit, opts.offset], durationMs: 0 },
    }
  }

  async insertRow(ns: Namespace, table: string, values: RowValues): Promise<{ affectedRows: number }> {
    this.record('insertRow', ns, table, values)
    this.table(ns, table).rows.push(evaluate(values))
    return { affectedRows: 1 }
  }

  async insertRows(
    ns: Namespace,
    table: string,
    columns: string[],
    rows: Iterable<InputCell[]>,
    options: InsertRowsOptions = {}
  ): Promise<{ affectedRows: number }> {
    const all = [...rows]
    this.record('insertRows', ns, table, columns, all, options)
    const t = this.table(ns, table)
    for (const r of all) t.rows.push(Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])))
    return { affectedRows: all.length }
  }

  private matchKey(row: KeyValues, key: RowKey): boolean {
    if (key.kind === 'ctid') return false
    return Object.entries(key.values).every(([k, v]) => compare(row[k] ?? null, v) === 0)
  }

  async updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }> {
    this.record('updateRow', ns, table, key, values)
    const t = this.table(ns, table)
    const matches = t.rows.filter((r) => this.matchKey(r, key))
    if (matches.length !== 1) throw new AdapterError('KEY_MISMATCH', `matched ${matches.length} rows`)
    Object.assign(matches[0] as KeyValues, evaluate(values))
    return { affectedRows: 1 }
  }

  async readCell(ns: Namespace, table: string, key: RowKey, column: string): Promise<Cell> {
    this.record('readCell', ns, table, key, column)
    const t = this.table(ns, table)
    if (!t.schema.columns.some((c) => c.name === column))
      throw new AdapterError('NOT_FOUND', `Unknown column: ${column}`)
    const matches = t.rows.filter((r) => this.matchKey(r, key))
    if (matches.length !== 1) throw new AdapterError('KEY_MISMATCH', `matched ${matches.length} rows`)
    return matches[0]?.[column] ?? null
  }

  async deleteRows(ns: Namespace, table: string, keys: RowKey[]): Promise<{ affectedRows: number }> {
    this.record('deleteRows', ns, table, keys)
    const t = this.table(ns, table)
    let affected = 0
    for (const key of keys) {
      const idx = t.rows.findIndex((r) => this.matchKey(r, key))
      if (idx === -1) throw new AdapterError('KEY_MISMATCH', 'matched 0 rows')
      t.rows.splice(idx, 1)
      affected++
    }
    return { affectedRows: affected }
  }

  async serverInfo(): Promise<ServerInfo> {
    this.record('serverInfo')
    return {
      dialect: this.dialect,
      version: '0.0.0-fake',
      uptimeSec: 42,
      currentUser: 'fake@localhost',
      extra: { hostname: 'fake' },
    }
  }

  async replicationInfo(): Promise<ReplicationInfo> {
    this.record('replicationInfo')
    return { role: 'standalone', source: [], replicas: [], logs: [{ name: 'binlog.000001', size: '1024' }] }
  }

  async serverCatalog(kind: ServerCatalogKind): Promise<ServerCatalog> {
    this.record('serverCatalog', kind)
    return { columns: ['name'], rows: [[`fake ${kind}`]] }
  }

  async listVariables(): Promise<KeyValue[]> {
    this.record('listVariables')
    return [
      { name: 'max_connections', value: '151', description: null },
      { name: 'version', value: '0.0.0-fake', description: 'Server version' },
    ]
  }

  async listStatus(): Promise<KeyValue[]> {
    this.record('listStatus')
    return [{ name: 'Threads_connected', value: '1', description: null }]
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    this.record('listProcesses')
    return structuredClone(this.processList)
  }

  async killProcess(id: string): Promise<void> {
    this.record('killProcess', id)
    const before = this.processList.length
    this.processList = this.processList.filter((p) => p.id !== id)
    if (this.processList.length === before) throw new AdapterError('NOT_FOUND', `No such process: ${id}`)
  }

  async listUsers(): Promise<UserInfo[]> {
    this.record('listUsers')
    return structuredClone(this.userList)
  }

  async canManageAccount(name: string): Promise<boolean> {
    this.record('canManageAccount', name)
    return this.manageAccountsAllowed
  }

  async showGrants(user: UserRef, ns?: Namespace): Promise<string[]> {
    this.record('showGrants', user, ns)
    if (!this.userList.some((u) => u.name === user.name))
      throw new AdapterError('NOT_FOUND', `Unknown user: ${user.name}`)
    return [`GRANT USAGE ON *.* TO '${user.name}'@'${user.host ?? '%'}'`]
  }

  async cancelQuery(queryId: string): Promise<boolean> {
    this.record('cancelQuery', queryId)
    return queryId.startsWith('running-')
  }

  async showCreateTable(ns: Namespace, table: string, _schema?: TableSchema): Promise<string[]> {
    this.record('showCreateTable', ns, table)
    const t = this.table(ns, table)
    if (t.definition) return [t.definition]
    return [`-- fake CREATE TABLE ${t.schema.name} (${t.schema.columns.map((c) => c.name).join(', ')})`]
  }

  async *iterateRows(
    ns: Namespace,
    table: string,
    opts: { batchSize: number; schema?: TableSchema }
  ): AsyncIterable<RowBatch> {
    this.record('iterateRows', ns, table, opts)
    const t = this.table(ns, table)
    const columns = t.schema.columns.map((c) => ({ name: c.name, dataType: c.dataType }))
    if (t.rows.length === 0) yield { columns, rows: [] }
    for (let i = 0; i < t.rows.length; i += opts.batchSize) {
      yield { columns, rows: t.rows.slice(i, i + opts.batchSize).map((r) => columns.map((c) => r[c.name] ?? null)) }
    }
  }

  async executeSql(ns: Namespace, sql: string, opts: ExecuteOptions): Promise<StatementResult[]> {
    this.record('executeSql', ns, sql, opts)
    const results: StatementResult[] = this.onSql
      ? this.onSql(ns, sql, opts)
      : [
          {
            kind: 'rows',
            sql,
            durationMs: 1,
            result: { columns: [{ name: 'echo', dataType: 'varchar' }], rows: [[sql]], truncated: false },
          },
        ]
    for (const [i, r] of results.entries()) await opts.onResult?.(r, i)
    // A real server answers this from its own state; the fake counts the statements that ran, which is enough
    // for callers that only need to see the warning appear.
    let open = false
    for (const r of results) {
      if (/^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(r.sql)) open = true
      else if (/^\s*(?:COMMIT|ROLLBACK|END)\b/i.test(r.sql)) open = false
    }
    opts.onTransactionOpen?.(open)
    return results
  }
}
