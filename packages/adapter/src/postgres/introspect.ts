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
import { quoteTable } from '../sql/quote.ts'
import { AdapterError } from '../types.ts'

/** ASCII unit separator used with string_agg so names containing commas survive. */
const SEP = String.fromCharCode(31)
const list = (v: unknown): string[] => (v === null || v === undefined || v === '' ? [] : String(v).split(SEP))
const bool = (v: unknown): boolean => v === true || v === 't'

const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

export async function pgListSchemas(conn: Conn): Promise<string[]> {
  const r = firstResult(
    await conn.query(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
       ORDER BY nspname`
    )
  )
  return r.rows.map((row) => str(row[0]))
}

export async function pgListTables(conn: Conn, ns: Namespace): Promise<TableInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT c.relname, c.relkind, c.reltuples, obj_description(c.oid, 'pg_class')
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY c.relname`,
      [ns.schema ?? 'public']
    )
  )
  return r.rows.map((row) => {
    const kind = str(row[1])
    const est = Number(row[2])
    return {
      name: str(row[0]),
      kind: kind === 'v' ? 'view' : kind === 'm' ? 'materialized_view' : 'table',
      rowEstimate: Number.isFinite(est) && est >= 0 ? Math.round(est) : null,
      engine: null,
      comment: strOrNull(row[3]),
    }
  })
}

export async function pgDescribeTable(conn: Conn, ns: Namespace, table: string): Promise<TableSchema> {
  const regclass = quoteTable('postgres', ns, table)
  const info = firstResult(
    await conn.query(
      `SELECT c.relkind, obj_description(c.oid, 'pg_class'), c.reltuples
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ns.schema ?? 'public', table]
    )
  )
  const infoRow = info.rows[0]
  if (!infoRow) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.schema ?? 'public'}.${table}`)

  const cols = firstResult(
    await conn.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
              a.attidentity, a.attgenerated, col_description(a.attrelid, a.attnum), co.collname
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0 AND co.collname <> 'default'
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [regclass]
    )
  )
  const columns: ColumnDef[] = cols.rows.map((row) => {
    const identity = str(row[4])
    const generated = str(row[5])
    let extra = ''
    if (identity === 'a') extra = 'identity always'
    else if (identity === 'd') extra = 'identity by default'
    else if (generated === 's') extra = 'generated stored'
    else if (str(row[3]).startsWith('nextval(')) extra = 'serial'
    return {
      name: str(row[0]),
      dataType: str(row[1]),
      nullable: !bool(row[2]),
      default: strOrNull(row[3]),
      extra,
      comment: strOrNull(row[6]),
      collation: strOrNull(row[7]),
    }
  })

  const idx = firstResult(
    await conn.query(
      `SELECT ic.relname, i.indisunique, i.indisprimary, am.amname,
              (SELECT string_agg(CASE WHEN k.attnum = 0 THEN pg_get_indexdef(i.indexrelid, k.ord::int, true) ELSE a.attname END, $2 ORDER BY k.ord)
               FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE k.ord <= i.indnkeyatts),
              pg_get_expr(i.indpred, i.indrelid, true),
              pg_get_indexdef(i.indexrelid, 0, true)
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
       WHERE i.indrelid = $1::regclass AND i.indisvalid
       ORDER BY i.indisprimary DESC, ic.relname`,
      [regclass, SEP]
    )
  )
  const indexes: IndexDef[] = idx.rows.map((row) => ({
    name: str(row[0]),
    unique: bool(row[1]),
    primary: bool(row[2]),
    columns: list(row[4]),
    type: strOrNull(row[3]),
    predicate: strOrNull(row[5]),
    definition: strOrNull(row[6]),
  }))
  const primaryKey = indexes.find((i) => i.primary)?.columns ?? []

  const fk = firstResult(
    await conn.query(
      `SELECT con.conname, nr.nspname, cr.relname, con.confupdtype, con.confdeltype,
              (SELECT string_agg(a.attname, $2 ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum),
              (SELECT string_agg(a.attname, $2 ORDER BY x.ord) FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum)
       FROM pg_constraint con
       JOIN pg_class cr ON cr.oid = con.confrelid
       JOIN pg_namespace nr ON nr.oid = cr.relnamespace
       WHERE con.conrelid = $1::regclass AND con.contype = 'f'
       ORDER BY con.conname`,
      [regclass, SEP]
    )
  )
  const foreignKeys: ForeignKeyDef[] = fk.rows.map((row) => ({
    name: str(row[0]),
    columns: list(row[5]),
    refNamespace: { database: ns.database, schema: str(row[1]) },
    refTable: str(row[2]),
    refColumns: list(row[6]),
    onUpdate: FK_ACTIONS[str(row[3])] ?? null,
    onDelete: FK_ACTIONS[str(row[4])] ?? null,
  }))

  const refs = firstResult(
    await conn.query(
      `SELECT con.conname, nf.nspname, cf.relname,
              (SELECT string_agg(a.attname, $2 ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum),
              (SELECT string_agg(a.attname, $2 ORDER BY x.ord) FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum)
       FROM pg_constraint con
       JOIN pg_class cf ON cf.oid = con.conrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       WHERE con.confrelid = $1::regclass AND con.contype = 'f'
       ORDER BY nf.nspname, cf.relname, con.conname`,
      [regclass, SEP]
    )
  )
  const referencedBy: ReferencingKeyDef[] = refs.rows.map((row) => ({
    name: str(row[0]),
    fromNamespace: { database: ns.database, schema: str(row[1]) },
    fromTable: str(row[2]),
    fromColumns: list(row[3]),
    columns: list(row[4]),
  }))

  const relkind = str(infoRow[0])
  // reltuples is -1 until the table has been analysed/vacuumed.
  const tuples = Number(infoRow[2])
  return {
    name: table,
    kind: relkind === 'v' ? 'view' : relkind === 'm' ? 'materialized_view' : 'table',
    comment: strOrNull(infoRow[1]),
    engine: null,
    rowEstimate: Number.isFinite(tuples) && tuples >= 0 ? Math.round(tuples) : null,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    referencedBy,
  }
}
