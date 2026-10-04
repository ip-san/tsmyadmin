import type { Namespace, TableSchema } from '@tsmyadmin/shared'
import { type Conn, firstResult } from '../driver.ts'
import { pgLiteral } from '../sql/literal.ts'
import { OPTIONS_SEQUENCE_OF_COLUMN } from '../sql/pg-sequence.ts'
import { quoteIdent, quoteTable } from '../sql/quote.ts'

/**
 * The CREATE statements of a PostgreSQL table, from what the catalog says it is made of: `pgTableCatalog` reads the
 * parts `TableSchema` does not carry, `pgCreateStatements` writes them out.
 */
const id = (s: string) => quoteIdent('postgres', s)
/** Separators for string_agg results (never part of a name or a statement): between entries, and inside one. */
const SEP = String.fromCharCode(31)
const FIELD_SEP = String.fromCharCode(30)

/** Index entries are real column names (from pg_attribute, unquoted) or expressions (from pg_get_indexdef). */
const indexCol = (columns: Set<string>) => (c: string) => (columns.has(c) ? id(c) : c)

/** What TableSchema does not carry but a faithful CREATE needs; read by `pgTableCatalog` in a few extra round trips. */
export interface PgTableCatalog {
  /**
   * The table's own (not inherited) CHECK / UNIQUE / EXCLUDE / FOREIGN KEY constraints as `pg_get_constraintdef`
   * prints them (MATCH, actions, DEFERRABLE, NOT VALID included), with the index each one owns.
   */
  constraints: { name: string; definition: string; index: string | null }[]
  /** Identity sequence options per column, already rendered (`START WITH 1000 CACHE 10`). */
  identityOptions: Map<string, string>
  /** Parents of an inheritance child, rendered for `INHERITS (…)` (schema-qualified, in order). */
  inherits: string | null
  /** `PARTITION BY …` of a partitioned table. */
  partitionKey: string | null
  /**
   * Partitions (all levels, parents first): created as `PARTITION OF` right after the table, each with the
   * indexes and constraints of its own (inherited ones are created by the parent's).
   */
  partitions: {
    schema: string
    name: string
    parentSchema: string
    parent: string
    bound: string
    partitionKey: string | null
    indexes: string[]
    constraints: { name: string; definition: string }[]
    unlogged: boolean
    storage: string | null
    comment: string | null
  }[]
  /** Columns declared on this table itself (an inheritance child repeats none of the inherited ones). */
  localColumns: Set<string> | null
  unlogged: boolean
  /** Storage parameters as a rendered list (`fillfactor='70', toast.autovacuum_enabled='false'`). */
  storage: string | null
}

/** `CREATE INDEX … ON ONLY t` → `ON t`: the index must reach the partitions on restore. */
const withoutOnly = (definition: string) =>
  definition.replace(/^(CREATE (?:UNIQUE )?INDEX (?:"(?:[^"]|"")*"|\S+) ON) ONLY /, '$1 ')

/** Storage parameters of pg_class row `c` (its TOAST table's included), rendered for `WITH (…)`. */
const STORAGE_SQL = `(SELECT string_agg(o.name || '=' || quote_literal(o.value), ', ') FROM (
   SELECT quote_ident(option_name) AS name, option_value AS value FROM pg_options_to_table(c.reloptions)
   UNION ALL
   SELECT 'toast.' || quote_ident(option_name), option_value
   FROM pg_class t, pg_options_to_table(t.reloptions) WHERE t.oid = c.reltoastrelid) AS o)`

/** Type bounds an ascending identity sequence takes by default: MAXVALUE is only printed when it differs. */
const IDENTITY_MAX = new Set(['32767', '2147483647', '9223372036854775807'])

export async function pgTableCatalog(conn: Conn, regclass: string): Promise<PgTableCatalog> {
  const con = firstResult(
    await conn.query(
      `SELECT con.conname, pg_get_constraintdef(con.oid, false), ic.relname
       FROM pg_constraint con LEFT JOIN pg_class ic ON ic.oid = con.conindid AND con.contype IN ('u', 'x')
       WHERE con.conrelid = $1::regclass AND con.contype IN ('c', 'u', 'x', 'f') AND con.conislocal
       ORDER BY con.contype, con.conname`,
      [regclass]
    )
  )
  const out: PgTableCatalog = {
    constraints: [],
    identityOptions: new Map(),
    inherits: null,
    partitionKey: null,
    partitions: [],
    unlogged: false,
    storage: null,
    localColumns: null,
  }
  for (const row of con.rows) {
    const index = row[2]
    out.constraints.push({
      name: String(row[0] ?? ''),
      definition: String(row[1] ?? ''),
      index: typeof index === 'string' ? index : null,
    })
  }
  const rel = firstResult(
    await conn.query(
      `SELECT c.relpersistence, ${STORAGE_SQL}, pg_get_partkeydef(c.oid),
              (SELECT string_agg(quote_ident(pn.nspname) || '.' || quote_ident(p.relname), ', ' ORDER BY i.inhseqno)
                 FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace
                 WHERE i.inhrelid = c.oid AND NOT c.relispartition)
       FROM pg_class c WHERE c.oid = $1::regclass`,
      [regclass]
    )
  )
  const relRow = rel.rows[0]
  out.unlogged = String(relRow?.[0]) === 'u'
  const storage = relRow?.[1]
  out.storage = typeof storage === 'string' && storage.length > 0 ? storage : null
  const partKey = relRow?.[2]
  out.partitionKey = typeof partKey === 'string' && partKey.length > 0 ? partKey : null
  const parents = relRow?.[3]
  out.inherits = typeof parents === 'string' && parents.length > 0 ? parents : null
  if (out.inherits) {
    // Inherited columns come with INHERITS; only the child's own declarations belong in its column list.
    const local = firstResult(
      await conn.query(
        'SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attislocal',
        [regclass]
      )
    )
    out.localColumns = new Set(local.rows.map((row) => String(row[0] ?? '')))
  }
  if (out.partitionKey) {
    // Every partition below this table, parents before their sub-partitions.
    const parts = firstResult(
      await conn.query(
        `WITH RECURSIVE tree AS (
           SELECT i.inhrelid, i.inhparent, 1 AS depth FROM pg_inherits i WHERE i.inhparent = $1::regclass
           UNION ALL
           SELECT i.inhrelid, i.inhparent, t.depth + 1 FROM pg_inherits i JOIN tree t ON i.inhparent = t.inhrelid
         )
         SELECT c.relname, p.relname, pg_get_expr(c.relpartbound, c.oid), pg_get_partkeydef(c.oid),
                cn.nspname, pn.nspname,
                c.relpersistence, ${STORAGE_SQL}, obj_description(c.oid, 'pg_class'),
                (SELECT string_agg(pg_get_indexdef(i.indexrelid), $2 ORDER BY ic.relname)
                   FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                   WHERE i.indrelid = c.oid AND i.indisvalid
                     AND NOT EXISTS (SELECT 1 FROM pg_inherits ih WHERE ih.inhrelid = i.indexrelid)
                     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = c.oid)),
                (SELECT string_agg(k.conname || $3 || pg_get_constraintdef(k.oid, false), $2 ORDER BY k.conname)
                   FROM pg_constraint k WHERE k.conrelid = c.oid AND k.conislocal AND k.contype IN ('p', 'c', 'u', 'x', 'f'))
         FROM tree JOIN pg_class c ON c.oid = tree.inhrelid JOIN pg_class p ON p.oid = tree.inhparent
         JOIN pg_namespace cn ON cn.oid = c.relnamespace JOIN pg_namespace pn ON pn.oid = p.relnamespace
         WHERE c.relispartition ORDER BY tree.depth, c.relname`,
        [regclass, SEP, FIELD_SEP]
      )
    )
    out.partitions = parts.rows.map((row) => {
      const key = row[3]
      const split = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v.split(SEP) : [])
      const text = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
      return {
        name: String(row[0] ?? ''),
        parent: String(row[1] ?? ''),
        bound: String(row[2] ?? ''),
        partitionKey: typeof key === 'string' && key.length > 0 ? key : null,
        schema: String(row[4] ?? ''),
        parentSchema: String(row[5] ?? ''),
        unlogged: String(row[6]) === 'u',
        storage: text(row[7]),
        comment: text(row[8]),
        indexes: split(row[9]),
        constraints: split(row[10]).map((c) => {
          const at = c.indexOf(FIELD_SEP)
          return { name: c.slice(0, at), definition: c.slice(at + 1) }
        }),
      }
    })
  }
  const seq = firstResult(
    await conn.query(
      `SELECT a.attname, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
       FROM pg_attribute a
       JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum
                         AND d.deptype IN ('i', 'a') AND d.classid = 'pg_class'::regclass
       JOIN pg_sequence s ON s.seqrelid = d.objid
       WHERE a.attrelid = $1::regclass AND ${OPTIONS_SEQUENCE_OF_COLUMN}`,
      [regclass]
    )
  )
  for (const row of seq.rows) {
    const [start, inc, min, max, cache] = [row[1], row[2], row[3], row[4], row[5]].map((v) => String(v ?? ''))
    const parts = [
      start !== '1' ? `START WITH ${start}` : '',
      inc !== '1' ? `INCREMENT BY ${inc}` : '',
      min !== '1' ? `MINVALUE ${min}` : '',
      max && !IDENTITY_MAX.has(max) ? `MAXVALUE ${max}` : '',
      cache !== '1' ? `CACHE ${cache}` : '',
      row[6] === true ? 'CYCLE' : '',
    ].filter((p) => p.length > 0)
    if (parts.length > 0) out.identityOptions.set(String(row[0] ?? ''), parts.join(' '))
  }
  return out
}

/**
 * Reconstructs CREATE TABLE + indexes + constraints + foreign keys + comments from catalog metadata (see
 * PostgresAdapter.showCreateTable). Without `catalog` (DDL previews) constraints and identity options are omitted.
 */
export function pgCreateStatements(ns: Namespace, schema: TableSchema, catalog?: PgTableCatalog): string[] {
  const t = quoteTable('postgres', ns, schema.name)
  // An inheritance child declares only its own columns; inherited ones with a default / NOT NULL of their own are
  // adjusted afterwards (repeating them would make them local, and a later DROP COLUMN on the parent would skip them).
  const local = catalog?.localColumns
  const inherited = local ? schema.columns.filter((c) => !local.has(c.name)) : []
  const defs = schema.columns
    .filter((c) => !local || local.has(c.name))
    .map((c) => {
      const identity = c.extra.startsWith('identity') || c.extra === 'serial'
      const generated = c.extra.startsWith('generated ')
      const parts = [id(c.name), c.dataType]
      // A non-default collation is part of the type (ordering and index semantics change without it).
      if (c.collation !== null) parts.push(`COLLATE ${id(c.collation)}`)
      if (identity) {
        const options = catalog?.identityOptions.get(c.name)
        parts.push(c.extra === 'identity always' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY')
        if (options) parts.push(`(${options})`)
      }
      // describeTable stores the generation expression in `default`; it is not a DEFAULT (it may reference siblings).
      if (generated && c.default !== null)
        parts.push(`GENERATED ALWAYS AS (${c.default}) ${c.extra === 'generated virtual' ? 'VIRTUAL' : 'STORED'}`)
      if (!c.nullable) parts.push('NOT NULL')
      if (c.default !== null && !identity && !generated) parts.push(`DEFAULT ${c.default}`)
      return parts.join(' ')
    })
  if (schema.primaryKey.length > 0) defs.push(`PRIMARY KEY (${schema.primaryKey.map(id).join(', ')})`)
  const inherits = catalog?.inherits ? ` INHERITS (${catalog.inherits})` : ''
  const partitionBy = catalog?.partitionKey ? ` PARTITION BY ${catalog.partitionKey}` : ''
  const storage = catalog?.storage ? ` WITH (${catalog.storage})` : ''
  const out = [
    `CREATE ${catalog?.unlogged ? 'UNLOGGED ' : ''}TABLE ${t} (\n  ${defs.join(',\n  ')}\n)${inherits}${partitionBy}${storage}`,
  ]
  for (const c of inherited) {
    // A serial parent's nextval() default is inherited as a plain default (identity is not inherited).
    if (c.default !== null && (!c.extra || c.extra === 'serial'))
      out.push(`ALTER TABLE ONLY ${t} ALTER COLUMN ${id(c.name)} SET DEFAULT ${c.default}`)
    if (!c.nullable) out.push(`ALTER TABLE ONLY ${t} ALTER COLUMN ${id(c.name)} SET NOT NULL`)
  }
  // Partitions carry no columns of their own; sub-partitions come after their parent. Each keeps its own indexes
  // and constraints (inherited ones come with the parent's).
  for (const p of catalog?.partitions ?? []) {
    const part = quoteTable('postgres', { database: ns.database, schema: p.schema }, p.name)
    const parent = quoteTable('postgres', { database: ns.database, schema: p.parentSchema }, p.parent)
    // relpartbound prints as `FOR VALUES …` or `DEFAULT`. Storage parameters live on the leaves only.
    out.push(
      `CREATE ${p.unlogged ? 'UNLOGGED ' : ''}TABLE ${part} PARTITION OF ${parent} ${p.bound}${p.partitionKey ? ` PARTITION BY ${p.partitionKey}` : ''}${p.storage ? ` WITH (${p.storage})` : ''}`
    )
    for (const i of p.indexes) out.push(withoutOnly(i))
    for (const c of p.constraints) out.push(`ALTER TABLE ${part} ADD CONSTRAINT ${id(c.name)} ${c.definition}`)
    if (p.comment !== null) out.push(`COMMENT ON TABLE ${part} IS ${pgLiteral(p.comment)}`)
  }
  const names = new Set(schema.columns.map((c) => c.name))
  // An index owned by a UNIQUE / EXCLUDE constraint is created by the constraint, not on its own.
  const owned = new Set(catalog?.constraints.map((c) => c.index).filter((i): i is string => i !== null))
  for (const i of schema.indexes) {
    if (i.primary || owned.has(i.name)) continue
    // The server's own statement keeps access method, direction, opclass and INCLUDE; reconstruct only without it.
    if (i.definition) {
      // pg_get_indexdef prints `ON ONLY` for a partitioned table's index, which would create an invalid parent
      // index without the partitions'; the partitions exist by now, so the plain form cascades.
      out.push(catalog?.partitionKey ? withoutOnly(i.definition) : i.definition)
      continue
    }
    const where = i.predicate ? ` WHERE ${i.predicate}` : ''
    out.push(
      `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${id(i.name)} ON ${t} (${i.columns.map(indexCol(names)).join(', ')})${where}`
    )
  }
  if (catalog) {
    // The server's own text keeps MATCH, action column lists, DEFERRABLE and NOT VALID.
    for (const c of catalog.constraints) out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${id(c.name)} ${c.definition}`)
  } else {
    for (const fk of schema.foreignKeys) {
      const ref = quoteTable('postgres', fk.refNamespace, fk.refTable)
      const actions = [
        fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : '',
        fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '',
      ].join('')
      out.push(
        `ALTER TABLE ${t} ADD CONSTRAINT ${id(fk.name)} FOREIGN KEY (${fk.columns.map(id).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(id).join(', ')})${actions}`
      )
    }
  }
  if (schema.comment !== null) out.push(`COMMENT ON TABLE ${t} IS ${pgLiteral(schema.comment)}`)
  for (const c of schema.columns)
    if (c.comment !== null) out.push(`COMMENT ON COLUMN ${t}.${id(c.name)} IS ${pgLiteral(c.comment)}`)
  return out
}
