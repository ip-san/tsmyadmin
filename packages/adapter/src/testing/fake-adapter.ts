import type {
  BrowseOptions,
  BrowseResult,
  Cell,
  Dialect,
  KeyValue,
  Namespace,
  ProcessInfo,
  RowKey,
  RowValues,
  ServerInfo,
  StatementResult,
  TableInfo,
  TableSchema,
  UserInfo,
  UserRef,
} from '@tsmyadmin/shared'
import { mysqlDdl } from '../mysql/ddl.ts'
import { mysqlExporter } from '../mysql/export.ts'
import { mysqlUsers } from '../mysql/users.ts'
import { pgDdl } from '../postgres/ddl.ts'
import { pgExporter } from '../postgres/export.ts'
import { pgUsers } from '../postgres/users.ts'
import { AdapterError, type DatabaseAdapter, type ExecuteOptions, type RowBatch } from '../types.ts'

export interface FakeTable {
  schema: TableSchema
  rows: RowValues[]
}

export interface FakeDatabase {
  schemas?: string[]
  tables: Record<string, FakeTable>
}

export interface FakeAdapterOptions {
  dialect?: Dialect
  databases?: Record<string, FakeDatabase>
  /** Hook invoked by executeSql; defaults to echoing a single-row result. */
  onSql?: (ns: Namespace, sql: string, opts: ExecuteOptions) => StatementResult[]
  /** When set, every method rejects with this error (simulates a dead connection). */
  failWith?: AdapterError
  users?: UserInfo[]
  processes?: ProcessInfo[]
}

export function fakeColumn(name: string, dataType = 'int', nullable = false): TableSchema['columns'][number] {
  return { name, dataType, nullable, default: null, extra: '', comment: null, collation: null }
}

export function fakeTable(
  name: string,
  columns: string[],
  rows: RowValues[],
  primaryKey: string[] = ['id']
): FakeTable {
  return {
    schema: {
      name,
      kind: 'table',
      comment: null,
      engine: null,
      rowEstimate: rows.length,
      columns: columns.map((c) => fakeColumn(c, c === 'id' ? 'int' : 'varchar')),
      primaryKey,
      indexes:
        primaryKey.length > 0
          ? [{ name: 'PRIMARY', unique: true, primary: true, columns: primaryKey, type: null }]
          : [],
      foreignKeys: [],
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
  private processList: ProcessInfo[]
  private readonly onSql: FakeAdapterOptions['onSql']
  private readonly failWith: AdapterError | undefined

  constructor(options: FakeAdapterOptions = {}) {
    this.dialect = options.dialect ?? 'mysql'
    this.ddl = this.dialect === 'mysql' ? mysqlDdl : pgDdl
    this.exporter = this.dialect === 'mysql' ? mysqlExporter : pgExporter
    this.users = this.dialect === 'mysql' ? mysqlUsers : pgUsers
    this.userList = options.users ?? []
    this.processList = options.processes ?? []
    this.databases = options.databases ?? {}
    this.onSql = options.onSql
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

  async listDatabases(): Promise<{ name: string }[]> {
    this.record('listDatabases')
    return Object.keys(this.databases)
      .sort()
      .map((name) => ({ name }))
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
      rowEstimate: t.rows.length,
      engine: t.schema.engine,
      comment: t.schema.comment,
    }))
  }

  async describeTable(ns: Namespace, table: string): Promise<TableSchema> {
    this.record('describeTable', ns, table)
    return structuredClone(this.table(ns, table).schema)
  }

  async browseRows(ns: Namespace, table: string, opts: BrowseOptions): Promise<BrowseResult> {
    this.record('browseRows', ns, table, opts)
    const t = this.table(ns, table)
    let rows = [...t.rows]
    for (const f of opts.filters) {
      rows = rows.filter((r) => {
        const v = r[f.column] ?? null
        switch (f.op) {
          case 'eq':
            return compare(v, f.value ?? null) === 0
          case 'neq':
            return compare(v, f.value ?? null) !== 0
          case 'is_null':
            return v === null
          case 'is_not_null':
            return v !== null
          case 'like':
            return typeof v === 'string' && new RegExp(`^${String(f.value).replaceAll('%', '.*')}$`).test(v)
          default:
            return true
        }
      })
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
      approximate: false,
      keyKind: t.schema.primaryKey.length > 0 ? 'pk' : 'none',
      keyColumns: t.schema.primaryKey,
    }
  }

  async insertRow(ns: Namespace, table: string, values: RowValues): Promise<{ affectedRows: number }> {
    this.record('insertRow', ns, table, values)
    this.table(ns, table).rows.push({ ...values })
    return { affectedRows: 1 }
  }

  async insertRows(ns: Namespace, table: string, columns: string[], rows: Cell[][]): Promise<{ affectedRows: number }> {
    this.record('insertRows', ns, table, columns, rows)
    const t = this.table(ns, table)
    for (const r of rows) t.rows.push(Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])))
    return { affectedRows: rows.length }
  }

  private matchKey(row: RowValues, key: RowKey): boolean {
    if (key.kind === 'ctid') return false
    return Object.entries(key.values).every(([k, v]) => compare(row[k] ?? null, v) === 0)
  }

  async updateRow(ns: Namespace, table: string, key: RowKey, values: RowValues): Promise<{ affectedRows: number }> {
    this.record('updateRow', ns, table, key, values)
    const t = this.table(ns, table)
    const matches = t.rows.filter((r) => this.matchKey(r, key))
    if (matches.length !== 1) throw new AdapterError('KEY_MISMATCH', `matched ${matches.length} rows`)
    Object.assign(matches[0] as RowValues, values)
    return { affectedRows: 1 }
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

  async showGrants(user: UserRef): Promise<string[]> {
    this.record('showGrants', user)
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
    if (this.onSql) return this.onSql(ns, sql, opts)
    return [
      {
        kind: 'rows',
        sql,
        durationMs: 1,
        result: { columns: [{ name: 'echo', dataType: 'varchar' }], rows: [[sql]], truncated: false },
      },
    ]
  }
}
