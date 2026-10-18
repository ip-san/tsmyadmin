import type { ColumnDef, Namespace, TableSchema } from '@tsmyadmin/shared'

/** A column of a foreign key whose type or collation is not that of the column it refers to. */
export interface KeyTypeMismatch {
  table: string
  key: string
  column: string
  type: string
  refTable: string
  refColumn: string
  refType: string
  /** Both collations, when they differ (text compared by two rules). */
  collations: { from: string; to: string } | null
}

/** A column name some tables give one type and others another. */
export interface NameTypeMismatch {
  column: string
  /** Each type, with the tables that give it, the most tables first. */
  types: { type: string; tables: string[] }[]
}

/** Columns named like a reference to another table's key: where one name with two types is a slip, not a choice. */
const REFERENCE_NAME = /_id$/i

/** Names one type goes by on either server (PostgreSQL's long names and aliases), and its short one. */
const SYNONYMS: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  integer: 'int',
  int4: 'int',
  int8: 'bigint',
  int2: 'smallint',
  numeric: 'decimal',
  'double precision': 'double',
  float8: 'double',
  float4: 'real',
  boolean: 'bool',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
}

/**
 * A type as two columns of one name are compared: in lower case, its length or precision left out (`varchar(64)` and
 * `varchar(128)`, `int(11)` and `int`, are one type), and by one name of the ones it goes by (`integer` is `int`).
 * What is left still tells an `int` from a `bigint` and a signed from an unsigned one.
 */
export function comparedType(dataType: string): string {
  const bare = dataType
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
  // The name, then MySQL's modifiers (kept: a signed and an unsigned integer hold two ranges).
  const [, name = bare, modifiers = ''] = /^(.*?)((?: (?:unsigned|zerofill))*)$/.exec(bare) ?? []
  return (SYNONYMS[name] ?? name) + modifiers
}

/**
 * The kind of a type, as a key and the column it refers to are compared: two of one kind (an `int` and a `bigint`, a
 * `varchar` and a `text`) are compared without converting either, and an index on one serves the other; two of two
 * kinds (text and a number, an integer and a decimal) are not. PostgreSQL's blank-padded `character(n)` is a kind of
 * its own (compared with text, it is converted, its trailing blanks dropped); MySQL's `char(n)` is text.
 * Not told apart: the values of two enumerations or sets (their lists are left out with the length), and the
 * aliases of an array's element type (`integer[]` and `int4[]`).
 */
export function typeKind(dataType: string): string {
  if (/^(character(?! varying)|bpchar)\b/i.test(dataType.trim())) return 'bpchar'
  const type = comparedType(dataType).replace(/ (unsigned|zerofill)\b/g, '')
  if (/^(tinyint|smallint|mediumint|int|bigint|serial|bigserial|smallserial)$/.test(type)) return 'integer'
  if (/^(varchar|char|text|tinytext|mediumtext|longtext)$/.test(type)) return 'text'
  if (/^(double|real|float)$/.test(type)) return 'float'
  return type
}

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * The foreign keys whose columns differ in the kind of type (`typeKind`) or in collation from the columns they refer
 * to, among the tables read: a join then converts one side, and may not use the index on it. A length or a width
 * alone is not a difference here. Keys into another namespace, or to a table not read, are not compared; nor a
 * collation one side does not name (PostgreSQL names none for the database's own).
 */
export function keyTypeMismatches(
  schemas: readonly TableSchema[],
  home: (ns: Namespace) => boolean
): KeyTypeMismatch[] {
  const tables = new Map(schemas.filter((s) => s.kind === 'table').map((s) => [s.name, s]))
  const column = (s: TableSchema, name: string | undefined): ColumnDef | undefined =>
    s.columns.find((c) => c.name === name)
  const out: KeyTypeMismatch[] = []
  for (const s of [...tables.values()].sort((a, b) => byName(a.name, b.name))) {
    for (const k of s.foreignKeys) {
      const ref = home(k.refNamespace) ? tables.get(k.refTable) : undefined
      if (!ref) continue
      k.columns.forEach((name, i) => {
        const from = column(s, name)
        const to = column(ref, k.refColumns[i])
        if (!from || !to) return
        const collations =
          from.collation !== null && to.collation !== null && from.collation !== to.collation
            ? { from: from.collation, to: to.collation }
            : null
        if (typeKind(from.dataType) === typeKind(to.dataType) && collations === null) return
        out.push({
          table: s.name,
          key: k.name,
          column: from.name,
          type: from.dataType,
          refTable: ref.name,
          refColumn: to.name,
          refType: to.dataType,
          collations,
        })
      })
    }
  }
  return out
}

/**
 * The column names ending in `_id` that the tables read give more than one type (`comparedType`: `user_id` an `int`
 * here and a `bigint` there, not a `varchar(64)` and a `varchar(128)`): the same thing, it seems, stored two ways,
 * with two ranges of values. Views are left out (their types follow their tables).
 */
export function nameTypeMismatches(schemas: readonly TableSchema[]): NameTypeMismatch[] {
  const named = new Map<string, Map<string, string[]>>()
  for (const s of schemas.filter((x) => x.kind === 'table').sort((a, b) => byName(a.name, b.name))) {
    for (const c of s.columns.filter((x) => REFERENCE_NAME.test(x.name))) {
      const types = named.get(c.name) ?? new Map<string, string[]>()
      const type = comparedType(c.dataType)
      types.set(type, [...(types.get(type) ?? []), s.name])
      named.set(c.name, types)
    }
  }
  return [...named]
    .filter(([, types]) => types.size > 1)
    .sort(([a], [b]) => byName(a, b))
    .map(([column, types]) => ({
      column,
      types: [...types]
        .map(([type, tables]) => ({ type, tables }))
        .sort((a, b) => b.tables.length - a.tables.length || byName(a.type, b.type)),
    }))
}
