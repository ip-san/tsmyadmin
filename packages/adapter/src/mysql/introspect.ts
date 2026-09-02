import type {
  ColumnDef,
  ForeignKeyDef,
  IndexDef,
  Namespace,
  ReferencingKeyDef,
  TableInfo,
  TableSchema,
} from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../base.ts'
import { str, strOrNull } from '../sql/format.ts'
import { AdapterError } from '../types.ts'

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function mysqlListTables(conn: Conn, ns: Namespace): Promise<TableInfo[]> {
  const r = firstResult(
    await conn.query(
      'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [ns.database]
    )
  )
  return r.rows.map((row) => ({
    name: str(row[0]),
    kind: str(row[1]).includes('VIEW') ? 'view' : 'table',
    rowEstimate: num(row[2]),
    engine: strOrNull(row[3]),
    comment: strOrNull(row[4]) || null,
  }))
}

export async function mysqlDescribeTable(conn: Conn, ns: Namespace, table: string): Promise<TableSchema> {
  const info = firstResult(
    await conn.query(
      'SELECT TABLE_TYPE, ENGINE, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [ns.database, table]
    )
  )
  const infoRow = info.rows[0]
  if (!infoRow) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.database}.${table}`)

  const cols = firstResult(
    await conn.query(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [ns.database, table]
    )
  )
  const columns: ColumnDef[] = cols.rows.map((row) => ({
    name: str(row[0]),
    dataType: str(row[1]),
    nullable: str(row[2]) === 'YES',
    default: strOrNull(row[3]),
    extra: str(row[4]),
    comment: strOrNull(row[5]) || null,
    collation: strOrNull(row[6]),
  }))

  const idx = firstResult(
    await conn.query(
      'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE, EXPRESSION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [ns.database, table]
    )
  )
  const indexMap = new Map<string, IndexDef>()
  for (const row of idx.rows) {
    const name = str(row[0])
    const entry = indexMap.get(name) ?? {
      name,
      unique: num(row[1]) === 0,
      primary: name === 'PRIMARY',
      predicate: null,
      columns: [],
      type: strOrNull(row[4]),
    }
    entry.columns.push(row[3] === null ? `(${str(row[5])})` : str(row[3]))
    indexMap.set(name, entry)
  }
  const indexes = [...indexMap.values()].sort((a, b) => (a.primary ? -1 : b.primary ? 1 : a.name.localeCompare(b.name)))
  const primaryKey = indexes.find((i) => i.primary)?.columns ?? []

  const fk = firstResult(
    await conn.query(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [ns.database, table]
    )
  )
  const fkMap = new Map<string, ForeignKeyDef>()
  for (const row of fk.rows) {
    const name = str(row[0])
    const entry = fkMap.get(name) ?? {
      name,
      columns: [],
      refNamespace: { database: str(row[2]) },
      refTable: str(row[3]),
      refColumns: [],
      onUpdate: strOrNull(row[5]),
      onDelete: strOrNull(row[6]),
    }
    entry.columns.push(str(row[1]))
    entry.refColumns.push(str(row[4]))
    fkMap.set(name, entry)
  }

  const refs = firstResult(
    await conn.query(
      `SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
       ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
      [ns.database, table]
    )
  )
  const refMap = new Map<string, ReferencingKeyDef>()
  for (const row of refs.rows) {
    const key = `${str(row[1])}.${str(row[2])}.${str(row[0])}`
    const entry = refMap.get(key) ?? {
      name: str(row[0]),
      fromNamespace: { database: str(row[1]) },
      fromTable: str(row[2]),
      fromColumns: [],
      columns: [],
    }
    entry.fromColumns.push(str(row[3]))
    entry.columns.push(str(row[4]))
    refMap.set(key, entry)
  }

  return {
    name: table,
    kind: str(infoRow[0]).includes('VIEW') ? 'view' : 'table',
    comment: strOrNull(infoRow[2]) || null,
    engine: strOrNull(infoRow[1]),
    rowEstimate: num(infoRow[3]),
    columns,
    primaryKey,
    indexes,
    foreignKeys: [...fkMap.values()],
    referencedBy: [...refMap.values()],
  }
}
