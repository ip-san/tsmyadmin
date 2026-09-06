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

/**
 * The sequence behind an identity column (internal dependency) or a `serial` column (auto dependency on the
 * column, named `<table>_<column>_seq` as CREATE TABLE names it). Such sequences belong to their column: the
 * column is dumped as IDENTITY / serial and the sequence is not an object of its own. Any other sequence — made
 * with CREATE SEQUENCE, even when later OWNED BY a column — is listed with the tables and dumped as itself.
 */
const SERIAL_SEQUENCE_DEPENDENCY = `
  SELECT 1 FROM pg_depend d
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
    AND (d.deptype = 'i' OR (d.deptype = 'a' AND c.relname = t.relname || '_' || a.attname || '_seq'
         AND EXISTS (SELECT 1 FROM pg_attrdef ad JOIN pg_depend dd ON dd.classid = 'pg_attrdef'::regclass AND dd.objid = ad.oid
                                 AND dd.refclassid = 'pg_class'::regclass AND dd.refobjid = c.oid
                          WHERE ad.adrelid = t.oid AND ad.adnum = a.attnum
                            AND pg_get_expr(ad.adbin, ad.adrelid) ~ '^nextval\\(''[^'']*''::regclass\\)$')))`

export async function pgListTables(conn: Conn, ns: Namespace): Promise<TableInfo[]> {
  const r = firstResult(
    await conn.query(
      `SELECT c.relname, c.relkind,
              CASE WHEN c.reltuples < 0 THEN s.n_live_tup ELSE c.reltuples END,
              obj_description(c.oid, 'pg_class'),
              CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END,
              (SELECT string_agg(p.relname, $2 ORDER BY i.inhseqno) FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                 WHERE i.inhrelid = c.oid AND p.relnamespace = c.relnamespace),
              own.relname, own.attname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       LEFT JOIN LATERAL (SELECT o.relname, a.attname FROM pg_depend d
                            JOIN pg_class o ON o.oid = d.refobjid
                            JOIN pg_attribute a ON a.attrelid = o.oid AND a.attnum = d.refobjsubid
                          WHERE c.relkind = 'S' AND d.objid = c.oid AND d.classid = 'pg_class'::regclass
                            AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a' AND o.relnamespace = c.relnamespace
                          LIMIT 1) own ON true
       WHERE n.nspname = $1 AND NOT c.relispartition
         AND (c.relkind IN ('r', 'p', 'v', 'm', 'f')
              OR (c.relkind = 'S' AND NOT EXISTS (${SERIAL_SEQUENCE_DEPENDENCY})))
       ORDER BY c.relname`,
      [ns.schema ?? 'public', SEP]
    )
  )
  return r.rows.map((row) => {
    const kind = str(row[1])
    const est = Number(row[2])
    return {
      name: str(row[0]),
      kind: kind === 'v' ? 'view' : kind === 'm' ? 'materialized_view' : kind === 'S' ? 'sequence' : 'table',
      // A plain view has no rows of its own (reltuples is 0, not an estimate).
      rowEstimate: kind !== 'v' && Number.isFinite(est) && est >= 0 ? Math.round(est) : null,
      engine: null,
      comment: strOrNull(row[3]),
      sizeBytes: row[4] === null || row[4] === undefined ? null : Number(row[4]),
      inherits: list(row[5]),
      ...(typeof row[6] === 'string' && typeof row[7] === 'string'
        ? { ownedBy: { table: row[6], column: row[7] } }
        : {}),
    }
  })
}

export async function pgDescribeTable(conn: Conn, ns: Namespace, table: string): Promise<TableSchema> {
  const regclass = quoteTable('postgres', ns, table)
  const info = firstResult(
    await conn.query(
      `SELECT c.relkind, obj_description(c.oid, 'pg_class'), c.reltuples,
              c.relkind <> 'p' AND EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid),
              (SELECT string_agg(p.relname, $3 ORDER BY i.inhseqno) FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
                 WHERE i.inhrelid = c.oid AND p.relnamespace = c.relnamespace AND NOT c.relispartition)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [ns.schema ?? 'public', table, SEP]
    )
  )
  const infoRow = info.rows[0]
  if (!infoRow) throw new AdapterError('NOT_FOUND', `Table not found: ${ns.schema ?? 'public'}.${table}`)

  const cols = firstResult(
    await conn.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
              a.attidentity, a.attgenerated, col_description(a.attrelid, a.attnum), co.collname,
              EXISTS (SELECT 1 FROM pg_depend sd JOIN pg_class c ON c.oid = sd.objid
                      WHERE sd.refclassid = 'pg_class'::regclass AND sd.refobjid = a.attrelid AND sd.refobjsubid = a.attnum
                        AND sd.classid = 'pg_class'::regclass AND sd.deptype = 'a' AND c.relkind = 'S'
                        AND c.relname = (SELECT relname FROM pg_class WHERE oid = a.attrelid) || '_' || a.attname || '_seq'
                        AND EXISTS (SELECT 1 FROM pg_attrdef ad JOIN pg_depend dd ON dd.classid = 'pg_attrdef'::regclass AND dd.objid = ad.oid
                                 AND dd.refclassid = 'pg_class'::regclass AND dd.refobjid = c.oid
                          WHERE ad.adrelid = a.attrelid AND ad.adnum = a.attnum))
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
    // serial: the column's own conventionally named sequence, and the one its default calls. A nextval() of any
    // other sequence stays a plain default (that sequence is dumped as an object of its own, so the default
    // restores as written), and an owned sequence the default does not use is listed like any other.
    else if (str(row[3]).startsWith('nextval(') && bool(row[8])) extra = 'serial'
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
    kind: relkind === 'v' ? 'view' : relkind === 'm' ? 'materialized_view' : relkind === 'S' ? 'sequence' : 'table',
    comment: strOrNull(infoRow[1]),
    engine: null,
    rowEstimate: Number.isFinite(tuples) && tuples >= 0 ? Math.round(tuples) : null,
    partitioned: relkind === 'p',
    hasChildren: bool(infoRow[3]),
    inherits: list(infoRow[4]),
    collation: null,
    autoIncrement: null,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    referencedBy,
  }
}
